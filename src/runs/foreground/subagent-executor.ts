import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveExecutionAgentScope } from "../../agents/agent-scope.ts";
import { handleManagementAction } from "../../agents/agent-management.ts";
import { buildDoctorReport } from "../../extension/doctor.ts";
import { clearPendingForegroundControlNotices } from "../../extension/control-notices.ts";
import { toModelInfo, type ModelInfo } from "../../shared/model-info.ts";
import { resolveModelCandidate } from "../shared/model-fallback.ts";
import { getArtifactsDir } from "../../shared/artifacts.ts";
import {
	isParallelStep,
	type SequentialStep,
} from "../../shared/settings.ts";
import {
	buildFlatAgentNameResolver,
	collectInvocationAgentNames,
	createPerAgentForkContextResolver,
	invocationUsesForkContext,
	resolveAgentContext,
	validateForkContextModelPolicy,
} from "../../shared/agent-context-policy.ts";
import { resolveCurrentSessionId } from "../../shared/session-identity.ts";
import { applyIntercomBridgeToAgent, resolveIntercomBridge, resolveIntercomSessionTarget, resolveOrchestratorIntercomTarget, resolveSubagentIntercomTarget } from "../../intercom/intercom-bridge.ts";
import { resolveControlConfig } from "../shared/subagent-control.ts";
import { createNestedRoute, resolveInheritedNestedRouteFromEnv, resolveNestedParentAddressFromEnv, writeNestedEvent } from "../shared/nested-events.ts";
import { resolveSubagentRunId, type ResolvedSubagentRunId } from "../background/run-id-resolver.ts";
import { inspectSubagentStatus } from "../background/run-status.ts";
import { buildManagementControl } from "../../shared/status-format.ts";
import { applyForceTopLevelAsyncOverride } from "../background/top-level-async.ts";
import { queryLiveIntercomHealth } from "../../intercom/live-intercom.ts";
import {
	type AgentScope,
} from "../../agents/agents.ts";
import {
	type SubagentExecutionResult,
	SUBAGENT_ACTIONS,
	checkSubagentDepth,
} from "../../shared/types.ts";
import {
	type ExecutionContextData,
	type ExecutorDeps,
	type SubagentParamsLike,
	resolveAsyncExecutionMode,
} from "./subagent-params.ts";
import {
	MUTATING_MANAGEMENT_ACTIONS,
	extendForegroundTimeoutResult,
	foregroundIntercomTarget,
	foregroundStatusResult,
	getForegroundControl,
	interruptAsyncRun,
	interruptNestedRun,
	nestedResolutionScopeForExecutor,
	nudgeSubagentRun,
	rememberedForegroundStatusResult,
	resolveRememberedForegroundRun,
	resolveRequestedCwd,
	resumeAsyncRun,
} from "./foreground-control.ts";
import {
	buildRequestedModeError,
	normalizeRepeatedParallelCounts,
	normalizeRoleForegroundTimeout,
	resolveForegroundTimeoutMs,
	toExecutionErrorResult,
	validateExecutionInput,
	withForkContext,
} from "./execution-input.ts";
import { runAsyncPath } from "./run-async-path.ts";
import { runChainPath } from "./run-chain-path.ts";
import { runParallelPath } from "./run-parallel-path.ts";
import { runSinglePath } from "./run-single-path.ts";

export type { SubagentParamsLike } from "./subagent-params.ts";
export { normalizeSubagentParamsLike, resolveAsyncExecutionMode } from "./subagent-params.ts";
export { writeAsyncInterruptRequest } from "./foreground-control.ts";

export function createSubagentExecutor(deps: ExecutorDeps): {
	execute: (
		id: string,
		params: SubagentParamsLike,
		signal: AbortSignal | undefined,
		onUpdate: ((r: SubagentExecutionResult) => void) | undefined,
		ctx: ExtensionContext,
	) => Promise<SubagentExecutionResult>;
} {
	const execute = async (
		_id: string,
		params: SubagentParamsLike,
		signal: AbortSignal | undefined,
		onUpdate: ((r: SubagentExecutionResult) => void) | undefined,
		ctx: ExtensionContext,
	): Promise<SubagentExecutionResult> => {
		deps.state.baseCwd = ctx.cwd;
		deps.state.foregroundRuns ??= new Map();
		deps.state.foregroundControls ??= new Map();
		deps.state.lastForegroundControlId ??= null;
		const requestCwd = resolveRequestedCwd(ctx.cwd, params.cwd);
		const paramsWithResolvedCwd = params.cwd === undefined ? params : { ...params, cwd: requestCwd };
		if (params.action) {
			if (params.action === "doctor") {
				let currentSessionFile: string | null = null;
				let currentSessionId = deps.state.currentSessionId;
				let sessionError: string | undefined;
				try {
					currentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
					currentSessionId = ctx.sessionManager.getSessionId();
				} catch (error) {
					sessionError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
				}
				let orchestratorTarget: string | undefined;
				try {
					const fallbackTarget = resolveIntercomSessionTarget(deps.pi.getSessionName(), ctx.sessionManager.getSessionId());
					orchestratorTarget = resolveOrchestratorIntercomTarget(deps.pi.events, fallbackTarget);
				} catch {}
				return {
					content: [{
						type: "text",
						text: buildDoctorReport({
							cwd: requestCwd,
							config: deps.config,
							state: deps.state,
							requestedSessionDir: paramsWithResolvedCwd.sessionDir,
							currentSessionFile,
							currentSessionId,
							orchestratorTarget,
							sessionError,
							projectTrusted: ctx.isProjectTrusted(),
							expandTilde: deps.expandTilde,
						}),
					}],
					details: { mode: "management", results: [] },
				};
			}
			if (params.action === "status") {
				const targetRunId = paramsWithResolvedCwd.id ?? paramsWithResolvedCwd.runId;
				if (targetRunId) {
					try {
						const nestedScope = nestedResolutionScopeForExecutor(deps);
						const resolved = resolveSubagentRunId(targetRunId, { state: deps.state, nested: nestedScope });
						if (resolved?.kind === "foreground") {
							const foreground = getForegroundControl(deps.state, resolved.id);
							if (foreground) {
								const target = foregroundIntercomTarget(foreground);
								const health = target ? (await queryLiveIntercomHealth(deps.pi.events, [target])).get(target) : undefined;
								return foregroundStatusResult(foreground, health);
							}
						}
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						return { content: [{ type: "text", text: message }], isError: true, details: { mode: "management", results: [] } };
					}
				} else {
					const foreground = getForegroundControl(deps.state, undefined);
					if (foreground) {
						const target = foregroundIntercomTarget(foreground);
						const health = target ? (await queryLiveIntercomHealth(deps.pi.events, [target])).get(target) : undefined;
						return foregroundStatusResult(foreground, health);
					}
				}
				let inspected = inspectSubagentStatus({ ...paramsWithResolvedCwd, action: "status" }, { state: deps.state, nested: nestedResolutionScopeForExecutor(deps) });
				const targets = inspected.details.intercomTargets ?? [];
				if (!inspected.isError && targets.length) {
					const intercomHealth = await queryLiveIntercomHealth(deps.pi.events, targets);
					if (intercomHealth.size) inspected = inspectSubagentStatus({ ...paramsWithResolvedCwd, action: "status" }, { state: deps.state, nested: nestedResolutionScopeForExecutor(deps), intercomHealth });
				}
				if (targetRunId && inspected.isError && inspected.content[0]?.type === "text" && inspected.content[0].text.startsWith("Async run not found.")) {
					try {
						const remembered = resolveRememberedForegroundRun(targetRunId, deps.state);
						if (remembered) return rememberedForegroundStatusResult(remembered);
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						return { content: [{ type: "text", text: message }], isError: true, details: { mode: "management", results: [] } };
					}
				}
				return inspected;
			}
			if (params.action === "nudge") {
				return nudgeSubagentRun({ params: paramsWithResolvedCwd, deps });
			}
			if (params.action === "resume") {
				return resumeAsyncRun({ params: paramsWithResolvedCwd, requestCwd, ctx, deps });
			}
			if (params.action === "extend") {
				const targetRunId = paramsWithResolvedCwd.runId ?? paramsWithResolvedCwd.id;
				let resolved: ResolvedSubagentRunId | undefined;
				if (targetRunId) {
					try {
						resolved = resolveSubagentRunId(targetRunId, { state: deps.state, nested: nestedResolutionScopeForExecutor(deps) });
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						return { content: [{ type: "text", text: message }], isError: true, details: { mode: "management", results: [] } };
					}
				}
				const foreground = getForegroundControl(deps.state, resolved?.kind === "foreground" ? resolved.id : targetRunId);
				if (!foreground) {
					return {
						content: [{ type: "text", text: "No extendable foreground run found in this session." }],
						isError: true,
						details: { mode: "management", results: [] },
					};
				}
				return extendForegroundTimeoutResult(foreground, paramsWithResolvedCwd.extendMs ?? paramsWithResolvedCwd.timeoutMs ?? paramsWithResolvedCwd.maxRuntimeMs ?? 0);
			}
			if (params.action === "interrupt") {
				const targetRunId = paramsWithResolvedCwd.runId ?? paramsWithResolvedCwd.id;
				let resolved: ResolvedSubagentRunId | undefined;
				if (targetRunId) {
					try {
						resolved = resolveSubagentRunId(targetRunId, { state: deps.state, nested: nestedResolutionScopeForExecutor(deps) });
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						return { content: [{ type: "text", text: message }], isError: true, details: { mode: "management", results: [] } };
					}
				}
				if (resolved?.kind === "nested") return interruptNestedRun(resolved);
				const foreground = getForegroundControl(deps.state, resolved?.kind === "foreground" ? resolved.id : targetRunId);
				if (foreground?.interrupt) {
					const interrupted = foreground.interrupt();
					if (interrupted) {
						foreground.updatedAt = Date.now();
						foreground.currentActivityState = undefined;
						return {
							content: [{ type: "text", text: `Interrupt requested for foreground run ${foreground.runId}.` }],
							details: { mode: "management", results: [], managementControl: buildManagementControl({ state: "live", runId: foreground.runId, index: foreground.currentIndex, intercomTarget: foregroundIntercomTarget(foreground), canNudge: true, canResume: true, canInterrupt: true, canExtend: Boolean(foreground.timeoutAt && foreground.extendTimeout) }) },
						};
					}
					return {
						content: [{ type: "text", text: `Foreground run ${foreground.runId} has no active child step to interrupt.` }],
						isError: true,
						details: { mode: "management", results: [] },
					};
				}
				const asyncInterruptResult = interruptAsyncRun(deps.state, resolved?.kind === "async" ? resolved.id : targetRunId);
				if (asyncInterruptResult) return asyncInterruptResult;
				return {
					content: [{ type: "text", text: "No interrupt-capable run found in this session." }],
					isError: true,
					details: { mode: "management", results: [] },
				};
			}
			if (!(SUBAGENT_ACTIONS as readonly string[]).includes(params.action)) {
				return {
					content: [{ type: "text", text: `Unknown action: ${params.action}. Valid: ${SUBAGENT_ACTIONS.join(", ")}` }],
					isError: true,
					details: { mode: "management" as const, results: [] },
				};
			}
			if (deps.allowMutatingManagementActions === false && MUTATING_MANAGEMENT_ACTIONS.has(params.action)) {
				return {
					content: [{ type: "text", text: `Action '${params.action}' is not available from child-safe subagent fanout mode.` }],
					isError: true,
					details: { mode: "management" as const, results: [] },
				};
			}
			return handleManagementAction(params.action, paramsWithResolvedCwd, { ...ctx, cwd: requestCwd });
		}

		const { blocked, depth, maxDepth } = checkSubagentDepth(deps.config.maxSubagentDepth);
		if (blocked) {
			return {
				content: [
					{
						type: "text",
						text:
							`Nested subagent call blocked (depth=${depth}, max=${maxDepth}). ` +
							"You are running at the maximum subagent nesting depth. " +
							"Complete your current task directly without delegating to further subagents.",
					},
				],
				isError: true,
				details: { mode: "single" as const, results: [] },
			};
		}

		const normalized = normalizeRepeatedParallelCounts(paramsWithResolvedCwd);
		if (normalized.error) return normalized.error;
		const normalizedParams = normalized.params!;

		let effectiveParams = applyForceTopLevelAsyncOverride(
			normalizedParams,
			depth,
			deps.config.forceTopLevelAsync === true,
		);

		const scope: AgentScope = resolveExecutionAgentScope(effectiveParams.agentScope);
		const effectiveCwd = effectiveParams.cwd ?? ctx.cwd;
		const parentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
		deps.state.currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
		const discoveredAgents = deps.discoverAgents(effectiveCwd, scope, { projectTrusted: ctx.isProjectTrusted() }).agents;
		const invocationAgentNames = collectInvocationAgentNames(effectiveParams);
		const invocationContext: SubagentParamsLike["context"] = invocationUsesForkContext(
			effectiveParams.context,
			invocationAgentNames,
			discoveredAgents,
		)
			? "fork"
			: undefined;
		const fallbackTarget = resolveIntercomSessionTarget(deps.pi.getSessionName(), ctx.sessionManager.getSessionId());
		const orchestratorTarget = resolveOrchestratorIntercomTarget(deps.pi.events, fallbackTarget);
		const intercomBridge = resolveIntercomBridge(orchestratorTarget);
		const runId = randomUUID().slice(0, 8);
		const agentNameAtIndex = buildFlatAgentNameResolver(effectiveParams);
		const resolveContextForAgent = (agentName: string | undefined) =>
			resolveAgentContext(effectiveParams.context, agentName, discoveredAgents);
		const resolveContextForIndex = (index?: number) =>
			resolveContextForAgent(agentNameAtIndex(index ?? 0));
		const agents = discoveredAgents.map((agent) => applyIntercomBridgeToAgent(agent, intercomBridge));
		const inheritedNestedRoute = resolveInheritedNestedRouteFromEnv();
		const nestedParentAddress = inheritedNestedRoute ? resolveNestedParentAddressFromEnv() : undefined;
		const nestedRoute = inheritedNestedRoute ?? createNestedRoute(runId);
		const shareEnabled = effectiveParams.share === true;
		const hasChain = (effectiveParams.chain?.length ?? 0) > 0;
		const hasTasks = (effectiveParams.tasks?.length ?? 0) > 0;
		const hasSingle = !hasChain && !hasTasks && Boolean(effectiveParams.agent);
		const allowClarifyTaskPrompt = hasChain
			&& effectiveParams.clarify === true
			&& ctx.hasUI
			&& !(effectiveParams.chain?.some(isParallelStep) ?? false);

		const validationError = validateExecutionInput(
			effectiveParams,
			agents,
			hasChain,
			hasTasks,
			hasSingle,
			allowClarifyTaskPrompt,
		);
		if (validationError) return validationError;
		if (invocationContext === "fork") {
			let availableModels: ModelInfo[];
			try {
				availableModels = ctx.modelRegistry.getAvailable().map(toModelInfo);
			} catch (error) {
				return toExecutionErrorResult(effectiveParams, error, invocationContext);
			}
			const forkModelPolicyError = validateForkContextModelPolicy(
				effectiveParams,
				discoveredAgents,
				(model) => resolveModelCandidate(model, availableModels, ctx.model?.provider),
			);
			if (forkModelPolicyError) {
				return toExecutionErrorResult(effectiveParams, new Error(forkModelPolicyError), invocationContext);
			}
		}

		let sessionFileForIndex: (idx?: number) => string | undefined = () => undefined;
		let forkSessionFileForAgentIndex: (agentName: string | undefined, idx?: number) => string | undefined = () => undefined;
		try {
			const forkContextResolver = createPerAgentForkContextResolver(ctx.sessionManager, resolveContextForIndex, {
				resolveContextForAgentIndex: (agentName) => resolveContextForAgent(agentName),
			});
			sessionFileForIndex = forkContextResolver.sessionFileForIndex;
			forkSessionFileForAgentIndex = forkContextResolver.sessionFileForAgentIndex;
		} catch (error) {
			return toExecutionErrorResult(effectiveParams, error, invocationContext);
		}
		const asyncMode = resolveAsyncExecutionMode(effectiveParams, deps.asyncByDefault);
		const backgroundRequestedWhileClarifying = (hasChain || hasTasks) && asyncMode.backgroundRequestedWhileClarifying;
		const effectiveAsync = asyncMode.effectiveAsync;
		const foregroundTimeout = resolveForegroundTimeoutMs(effectiveParams);
		if (foregroundTimeout.error) return buildRequestedModeError(effectiveParams, foregroundTimeout.error);
		if (effectiveAsync && foregroundTimeout.timeoutMs !== undefined) {
			return buildRequestedModeError(effectiveParams, "timeoutMs/maxRuntimeMs only applies to foreground subagent runs. Set async:false or use action:'interrupt' for background runs.");
		}
		if (!effectiveAsync) foregroundTimeout.timeoutMs = normalizeRoleForegroundTimeout(effectiveParams, foregroundTimeout.timeoutMs);
		const controlConfig = resolveControlConfig(deps.config.control, effectiveParams.control);

		const artifactsEnabled = effectiveParams.artifacts !== false;
		const artifactsDir = effectiveAsync ? deps.tempArtifactsDir : getArtifactsDir(parentSessionFile);

		let sessionRoot: string;
		if (effectiveParams.sessionDir) {
			sessionRoot = path.resolve(deps.expandTilde(effectiveParams.sessionDir));
		} else {
			const baseSessionRoot = deps.config.defaultSessionDir
				? path.resolve(deps.expandTilde(deps.config.defaultSessionDir))
				: deps.getSubagentSessionRoot(parentSessionFile);
			sessionRoot = path.join(baseSessionRoot, runId);
		}
		try {
			fs.mkdirSync(sessionRoot, { recursive: true });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return toExecutionErrorResult(
				effectiveParams,
				new Error(`Failed to create session directory '${sessionRoot}': ${message}`),
				invocationContext,
			);
		}
		const sessionDirForIndex = (idx?: number) =>
			path.join(sessionRoot, `run-${idx ?? 0}`);
		const childSessionFileForIndex = (idx?: number) =>
			sessionFileForIndex(idx) ?? path.join(sessionDirForIndex(idx), "session.jsonl");
		const childSessionFileForAgentIndex = (agentName: string | undefined, idx?: number) =>
			forkSessionFileForAgentIndex(agentName, idx) ?? path.join(sessionDirForIndex(idx), "session.jsonl");

		const onUpdateWithContext = onUpdate
			? (r: SubagentExecutionResult) => onUpdate(withForkContext(r, invocationContext))
			: undefined;

		const execData: ExecutionContextData = {
			params: effectiveParams,
			effectiveCwd,
			ctx,
			signal,
			onUpdate: onUpdateWithContext,
			agents,
			runId,
			shareEnabled,
			sessionRoot,
			sessionDirForIndex,
			sessionFileForIndex: childSessionFileForIndex,
			sessionFileForAgentIndex: childSessionFileForAgentIndex,
			artifactsEnabled,
			artifactsDir,
			backgroundRequestedWhileClarifying,
			effectiveAsync,
			...(foregroundTimeout.timeoutMs !== undefined ? { foregroundTimeoutMs: foregroundTimeout.timeoutMs } : {}),
			controlConfig,
			intercomBridge,
			nestedRoute,
		};

		const foregroundMode: "single" | "parallel" | "chain" = hasChain ? "chain" : hasTasks ? "parallel" : "single";
		const foregroundTimeoutAt = !effectiveAsync && foregroundTimeout.timeoutMs !== undefined ? Date.now() + foregroundTimeout.timeoutMs : undefined;
		const foregroundControl = effectiveAsync
			? undefined
			: {
				runId,
				mode: foregroundMode,
				startedAt: Date.now(),
				updatedAt: Date.now(),
				currentAgent: undefined,
				currentIndex: undefined,
				currentActivityState: undefined,
				...(foregroundTimeoutAt !== undefined ? { timeoutAt: foregroundTimeoutAt } : {}),
				nestedRoute,
				interrupt: undefined,
				activeChildren: new Map(),
			};
		if (foregroundControl) {
			deps.state.foregroundControls.set(runId, foregroundControl);
			deps.state.lastForegroundControlId = runId;
		}
		let deferForegroundCleanup = false;
		let detachedNestedSettled = false;
		const cleanupForegroundControl = () => {
			if (!foregroundControl) return;
			clearPendingForegroundControlNotices(deps.state, runId);
			deps.state.foregroundControls.delete(runId);
			if (deps.state.lastForegroundControlId === runId) deps.state.lastForegroundControlId = null;
		};

		const writeNestedForegroundEvent = (type: "subagent.nested.started" | "subagent.nested.completed", result?: SubagentExecutionResult): void => {
			if (!inheritedNestedRoute || !nestedParentAddress) return;
			const now = Date.now();
			const details = result?.details;
			const state = type === "subagent.nested.started"
				? "running"
				: result?.isError || details?.results.some((child) => child.exitCode !== 0)
					? "failed"
					: details?.results.some((child) => child.interrupted)
						? "paused"
						: "complete";
			const errorText = result?.isError
				? result.content.find((item) => item.type === "text")?.text
				: undefined;
			const agentsForSummary = hasTasks && effectiveParams.tasks
				? effectiveParams.tasks.map((task) => task.agent)
				: hasChain && effectiveParams.chain
					? effectiveParams.chain.flatMap((step) => isParallelStep(step) ? step.parallel.map((task) => task.agent) : [(step as SequentialStep).agent])
					: effectiveParams.agent ? [effectiveParams.agent] : [];
			const leafIntercomTarget = agentsForSummary[0]
				? resolveSubagentIntercomTarget(runId, agentsForSummary[0], 0)
				: undefined;
			try {
				writeNestedEvent(inheritedNestedRoute, {
					type,
					ts: now,
					parentRunId: nestedParentAddress.parentRunId,
					parentStepIndex: nestedParentAddress.parentStepIndex,
					child: {
						id: runId,
						parentRunId: nestedParentAddress.parentRunId,
						parentStepIndex: nestedParentAddress.parentStepIndex,
						depth: nestedParentAddress.depth,
						path: nestedParentAddress.path,
						ownerIntercomTarget: process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME,
						leafIntercomTarget,
						intercomTarget: leafIntercomTarget,
						ownerState: state === "running" ? "live" : "gone",
						mode: foregroundMode,
						state,
						agent: agentsForSummary[0],
						agents: agentsForSummary,
						startedAt: foregroundControl?.startedAt ?? now,
						...(state !== "running" ? { endedAt: now } : {}),
						lastUpdate: now,
						...(errorText ? { error: errorText } : {}),
						...(details?.results.length ? { steps: details.results.map((child) => ({
							agent: child.agent,
							status: child.interrupted ? "paused" : child.exitCode === 0 ? "complete" : "failed",
							...(child.sessionFile ? { sessionFile: child.sessionFile } : {}),
							...(child.error ? { error: child.error } : {}),
						})) } : {}),
					},
				});
			} catch (error) {
				console.error("Failed to emit nested foreground status event:", error);
			}
		};

		if (inheritedNestedRoute && nestedParentAddress) {
			execData.onDetachedResultsSettled = (mode, results, totalSteps) => {
				detachedNestedSettled = true;
				deferForegroundCleanup = false;
				const failure = results.find((result) => result.exitCode !== 0);
				writeNestedForegroundEvent("subagent.nested.completed", {
					content: [{ type: "text", text: failure?.error ?? "Detached nested run completed." }],
					isError: Boolean(failure),
					details: {
						mode,
						results,
						...(totalSteps !== undefined ? { totalSteps } : {}),
					},
				});
				cleanupForegroundControl();
			};
		}

		const completeNestedForeground = (result: SubagentExecutionResult): void => {
			if (inheritedNestedRoute && nestedParentAddress && result.details?.results.some((child) => child.detached)) {
				deferForegroundCleanup = !detachedNestedSettled;
				return;
			}
			writeNestedForegroundEvent("subagent.nested.completed", result);
		};

		let nestedForegroundStarted = false;
		try {
			const asyncResult = runAsyncPath(execData, deps);
			if (asyncResult) return withForkContext(asyncResult, invocationContext);
			if (foregroundControl) {
				writeNestedForegroundEvent("subagent.nested.started");
				nestedForegroundStarted = true;
			}
			if (hasChain && effectiveParams.chain) {
				const result = await runChainPath(execData, deps);
				completeNestedForeground(result);
				return withForkContext(result, invocationContext);
			}
			if (hasTasks && effectiveParams.tasks) {
				const result = await runParallelPath(execData, deps);
				completeNestedForeground(result);
				return withForkContext(result, invocationContext);
			}
			if (hasSingle) {
				const result = await runSinglePath(execData, deps);
				completeNestedForeground(result);
				return withForkContext(result, invocationContext);
			}
		} catch (error) {
			const errorResult = toExecutionErrorResult(effectiveParams, error, invocationContext);
			if (nestedForegroundStarted) writeNestedForegroundEvent("subagent.nested.completed", errorResult);
			return errorResult;
		} finally {
			if (!deferForegroundCleanup) cleanupForegroundControl();
		}

		return withForkContext({
			content: [{ type: "text", text: "Invalid params" }],
			isError: true,
			details: { mode: "single" as const, results: [] },
		}, invocationContext);
	};

	return { execute };
}
