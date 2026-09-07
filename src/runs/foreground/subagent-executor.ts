import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveExecutionAgentScope } from "../../agents/agent-scope.ts";
import { handleManagementAction } from "../../agents/agent-management.ts";
import { buildDoctorReport } from "../../extension/doctor.ts";
import { clearPendingForegroundControlNotices } from "../../extension/control-notices.ts";
import { providerQualifiedModelId, toModelInfo, type ModelInfo } from "../../shared/model-info.ts";
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
import { queryLiveIntercomHealth, queryLiveIntercomStatus } from "../../intercom/live-intercom.ts";
import { saveQuestionOwner } from "../shared/supervisor-questions.ts";
import { workflowChildSucceeded } from "../shared/workflow-policy.ts";
import { ownedRunList, ownedRunStatusResult, ownedRunView, rememberOwnedRun, resolveOwnedRun, saveForegroundRun } from "../shared/run-records.ts";
import { cancelSupervisorInput, controlSupervisorQuestion, projectSupervisorQuestions } from "./question-control.ts";
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
		deps.ensureSessionState?.(ctx);
		deps.state.baseCwd = ctx.cwd;
		deps.state.foregroundRuns ??= new Map();
		deps.state.foregroundControls ??= new Map();
		deps.state.lastForegroundControlId ??= null;
		const requestCwd = resolveRequestedCwd(ctx.cwd, params.cwd);
		const paramsWithResolvedCwd = params.cwd === undefined ? params : { ...params, cwd: requestCwd };
		if (params.action) {
			if (params.action === "review") {
				try {
					if (!(params.id ?? params.runId) || (params.decision !== "accepted" && params.decision !== "needs_changes")) throw new Error("action='review' requires id and decision ('accepted' or 'needs_changes').");
					const run = resolveOwnedRun(deps.state, (params.id ?? params.runId)!);
					if (!run) throw new Error("Run not found in this parent session.");
					if (ownedRunView(run, deps.state).state === "live") throw new Error("The run is still live. Use nudge for guidance, or stop it before reviewing its result.");
					const reviewed = { ...run, review: { decision: params.decision, ...(params.message ? { message: params.message } : {}), reviewedAt: Date.now() } };
					rememberOwnedRun(deps.state, reviewed);
					const result = ownedRunStatusResult(reviewed, deps.state, undefined, { childSafe: Boolean(nestedResolutionScopeForExecutor(deps)) });
					return { ...result, content: [{ type: "text", text: `Saved parent review for ${run.runId}: ${params.decision}.\nThe review note is parent-only and was not sent to the child. Put actionable instructions in ${deps.allowMutatingManagementActions === false ? "subagent resume/nudge" : "agent_runs continue/nudge"}. No work started.` }] };
				} catch (error) {
					return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true, details: { mode: "management", results: [] } };
				}
			}
			if (params.action === "questions" || params.action === "answer") {
				return controlSupervisorQuestion({ params: paramsWithResolvedCwd, requestCwd, ctx, deps });
			}
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
				const { connection } = await queryLiveIntercomStatus(deps.pi.events);
				return {
					content: [{
						type: "text",
						text: buildDoctorReport({
							cwd: requestCwd,
							nativeSessionCwd: ctx.cwd,
							config: deps.config,
							state: deps.state,
							requestedSessionDir: paramsWithResolvedCwd.sessionDir,
							currentSessionFile,
							currentSessionId,
							orchestratorTarget,
							connection,
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
				if (!targetRunId && !params.dir && deps.state.ownedRuns && deps.allowMutatingManagementActions !== false) {
					try { return ownedRunList(deps.state, params); } catch (error) {
						return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true, details: { mode: "management", results: [] } };
					}
				}
				let includeRunHeader = true;
				if (targetRunId) {
					try {
						includeRunHeader = Boolean(params.dir) || !resolveOwnedRun(deps.state, targetRunId);
						const nestedScope = nestedResolutionScopeForExecutor(deps);
						const resolved = resolveSubagentRunId(targetRunId, { state: deps.state, nested: nestedScope });
						if (resolved?.kind === "foreground") {
							const foreground = getForegroundControl(deps.state, resolved.id);
							if (foreground) {
								const target = foregroundIntercomTarget(foreground);
								const health = target ? (await queryLiveIntercomHealth(deps.pi.events, [target])).get(target) : undefined;
								return foregroundStatusResult(foreground, health, includeRunHeader, Boolean(nestedScope));
							}
						}
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						return { content: [{ type: "text", text: message }], isError: true, details: { mode: "management", results: [] } };
					}
				} else if (deps.allowMutatingManagementActions === false) {
					const foreground = getForegroundControl(deps.state, undefined);
					if (foreground) {
						const target = foregroundIntercomTarget(foreground);
						const health = target ? (await queryLiveIntercomHealth(deps.pi.events, [target])).get(target) : undefined;
						return foregroundStatusResult(foreground, health, true, true);
					}
				}
				let inspected = inspectSubagentStatus({ ...paramsWithResolvedCwd, action: "status" }, { state: deps.state, nested: nestedResolutionScopeForExecutor(deps), includeRunHeader });
				const targets = inspected.details.intercomTargets ?? [];
				if (!inspected.isError && targets.length) {
					const intercomHealth = await queryLiveIntercomHealth(deps.pi.events, targets);
					if (intercomHealth.size) inspected = inspectSubagentStatus({ ...paramsWithResolvedCwd, action: "status" }, { state: deps.state, nested: nestedResolutionScopeForExecutor(deps), intercomHealth, includeRunHeader });
				}
				if (targetRunId && inspected.isError && inspected.content[0]?.type === "text" && inspected.content[0].text.startsWith("Async run not found.")) {
					try {
						const remembered = resolveRememberedForegroundRun(targetRunId, deps.state);
						if (remembered) return rememberedForegroundStatusResult(remembered, Boolean(nestedResolutionScopeForExecutor(deps)));
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						return { content: [{ type: "text", text: message }], isError: true, details: { mode: "management", results: [] } };
					}
				}
				if (!targetRunId && !params.dir && deps.allowMutatingManagementActions !== false) {
					const current = getForegroundControl(deps.state, undefined);
					const target = current ? foregroundIntercomTarget(current) : undefined;
					const health = target ? (await queryLiveIntercomHealth(deps.pi.events, [target])).get(target) : undefined;
					const foreground = [
						...[...deps.state.foregroundControls.values()].map((control) => foregroundStatusResult(control, control === current ? health : undefined)),
						...[...(deps.state.foregroundRuns?.values() ?? [])]
							.filter((run) => !deps.state.foregroundControls.has(run.runId))
							.sort((a, b) => b.updatedAt - a.updatedAt)
							.map((run) => rememberedForegroundStatusResult(run)),
					];
					if (foreground.length) {
						inspected = {
							...inspected,
							content: [...foreground.flatMap((result) => result.content), ...inspected.content],
							details: {
								...inspected.details,
								managementControl: foreground.find((result) => result.details.managementControl?.runId === current?.runId)?.details.managementControl,
								managementControls: [...foreground.flatMap((result) => result.details.managementControl ? [result.details.managementControl] : []), ...(inspected.details.managementControls ?? [])],
							},
						};
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
		const inheritedModel = providerQualifiedModelId(ctx.model?.provider, ctx.model?.id);
		const discoveredAgents = deps.discoverAgents(effectiveCwd, scope, { projectTrusted: ctx.isProjectTrusted() }).agents
			.map((agent) => agent.model || !inheritedModel ? agent : { ...agent, model: inheritedModel });
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
		const runId = randomUUID();
		const agentNameAtIndex = buildFlatAgentNameResolver(effectiveParams);
		const resolveContextForAgent = (agentName: string | undefined) =>
			resolveAgentContext(effectiveParams.context, agentName, discoveredAgents);
		const resolveContextForIndex = (index?: number) =>
			resolveContextForAgent(agentNameAtIndex(index ?? 0));
		const agents = discoveredAgents.map((agent) => applyIntercomBridgeToAgent({ ...agent, defaultContext: resolveContextForAgent(agent.name) }, intercomBridge));
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

		saveQuestionOwner(runId, ctx.sessionManager.getSessionId());
		rememberOwnedRun(deps.state, {
			runId, ownerSessionId: ctx.sessionManager.getSessionId(), rootRunId: runId,
			source: effectiveAsync ? "async" : "foreground", mode: hasChain ? "chain" : hasTasks ? "parallel" : "single",
			cwd: effectiveCwd, task: effectiveParams.task ?? effectiveParams.tasks?.map((task) => task.task).join("\n") ?? "Delegated workflow",
			startedAt: Date.now(), children: invocationAgentNames.map((agent, index) => ({ agent, index })),
		});
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
		let detachedSettled = false;
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
			const pausedReason = deps.state.foregroundRuns?.get(runId)?.pausedReason;
			const state = type === "subagent.nested.started"
				? "running"
				: result?.isError || details?.results.some((child) => child.exitCode !== 0)
					? "failed"
					: pausedReason || details?.results.some((child) => child.interrupted)
						? "paused"
						: "complete";
			const errorText = result?.isError
				? result.content.find((item) => item.type === "text")?.text
				: pausedReason;
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

		execData.onDetachedResultsSettled = (mode, results, totalSteps) => {
			detachedSettled = true;
			deferForegroundCleanup = false;
			const failure = results.find((result) => result.exitCode !== 0);
			writeNestedForegroundEvent("subagent.nested.completed", {
				content: [{ type: "text", text: failure?.error ?? deps.state.foregroundRuns?.get(runId)?.pausedReason ?? "Detached run completed." }],
				isError: Boolean(failure),
				details: { mode, results, ...(totalSteps !== undefined ? { totalSteps } : {}) },
			});
			cleanupForegroundControl();
		};

		const completeNestedForeground = (result: SubagentExecutionResult): void => {
			result.details.runId ??= runId;
			if (result.isError && result.details.results.every(workflowChildSucceeded)) {
				const owned = deps.state.ownedRuns?.get(runId);
				if (owned) rememberOwnedRun(deps.state, { ...owned, error: result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") });
			}
			if (result.details.asyncId) {
				const owned = deps.state.ownedRuns?.get(runId);
				if (owned) rememberOwnedRun(deps.state, { ...owned, source: "async", asyncDir: result.details.asyncDir, pid: deps.state.asyncJobs.get(runId)?.pid });
			} else if (!deps.state.foregroundRuns?.has(runId)) {
				saveForegroundRun({ runId, mode: foregroundMode, cwd: effectiveCwd, results: result.details.results, error: deps.state.ownedRuns?.get(runId)?.error });
			}
			if (result.details.intercomDelivery?.delivered) {
				const owned = deps.state.ownedRuns?.get(runId);
				if (owned) rememberOwnedRun(deps.state, { ...owned, delivery: { notifiedAt: Date.now(), intercomDelivered: true } });
			}
			if (result.details?.results.some((child) => child.detached)) {
				deferForegroundCleanup = !detachedSettled;
				return;
			}
			writeNestedForegroundEvent("subagent.nested.completed", result);
		};

		let nestedForegroundStarted = false;
		try {
			const asyncResult = runAsyncPath(execData, deps);
			if (asyncResult) {
				completeNestedForeground(asyncResult);
				return withForkContext(asyncResult, invocationContext);
			}
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
			completeNestedForeground(errorResult);
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

	return { execute: async (...args) => {
		let result = await execute(...args);
		if (args[1].action === "interrupt") return cancelSupervisorInput(result, args[1], args[4].sessionManager.getSessionId(), deps.pi.events);
		if (args[1].action !== "status" || result.details.runList) return result;
		const requested = args[1].id ?? args[1].runId;
		if (requested && !args[1].dir) {
			try {
				const owned = resolveOwnedRun(deps.state, requested);
				if (owned) result = ownedRunStatusResult(owned, deps.state, result, { full: args[1].full, childSafe: Boolean(nestedResolutionScopeForExecutor(deps)) });
			} catch (error) {
				return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true, details: { mode: "management", results: [] } };
			}
		}
		return projectSupervisorQuestions(result, args[1], args[4].sessionManager.getSessionId(), Boolean(nestedResolutionScopeForExecutor(deps)));
	} };
}
