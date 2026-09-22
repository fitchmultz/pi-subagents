import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveExecutionAgentScope } from "../../agents/agent-scope.ts";
import { handleManagementAction } from "../../agents/agent-management.ts";
import { buildDoctorReport } from "../../extension/doctor.ts";
import { providerQualifiedModelId, toModelInfo, type ModelInfo } from "../../shared/model-info.ts";
import { resolveModelCandidate } from "../shared/model-fallback.ts";
import { getArtifactsDir } from "../../shared/artifacts.ts";
import {
	isParallelStep,
	isDynamicParallelStep,
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
import { resolveExecutionCwd } from "../../shared/execution-cwd.ts";
import { resolveIntercomBridge, resolveIntercomSessionTarget, resolveOrchestratorIntercomTarget } from "../../intercom/intercom-bridge.ts";
import { resolveControlConfig } from "../shared/subagent-control.ts";
import { createNestedRoute, resolveInheritedNestedRouteFromEnv } from "../shared/nested-events.ts";
import { resolveSubagentRunId, type ResolvedSubagentRunId } from "../background/run-id-resolver.ts";
import { inspectSubagentStatus } from "../background/run-status.ts";
import { applyForceTopLevelAsyncOverride } from "../background/top-level-async.ts";
import { queryLiveIntercomHealth, queryLiveIntercomStatus } from "../../intercom/live-intercom.ts";
import { saveQuestionOwner } from "../shared/supervisor-questions.ts";
import { buildWorkflowGraphSnapshot, workflowAgentNodes } from "../shared/workflow-graph.ts";
import { ownedRunList, ownedRunStatusResult, ownedRunView, rememberOwnedRun, resolveOwnedRun, workflowChildren } from "../shared/run-records.ts";
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
	extendAsyncTimeoutResult,
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
import { clarifyInvocation } from "./clarify-invocation.ts";
import { waitForOwnedRun } from "./wait-run.ts";
import { bindNativeInvocation, isNativeAsyncCall, nativeInvocationTarget, nativeInvocations } from "../shared/native-async.ts";

export type { SubagentParamsLike } from "./subagent-params.ts";
export { normalizeSubagentParamsLike, resolveAsyncExecutionMode } from "./subagent-params.ts";
export { writeAsyncInterruptRequest } from "./foreground-control.ts";

type ExecuteSubagent = (id: string, params: SubagentParamsLike, signal: AbortSignal | undefined,
	onUpdate: ((r: SubagentExecutionResult) => void) | undefined, ctx: ExtensionContext, executionCwd?: string) => Promise<SubagentExecutionResult>;

export function createSubagentExecutor(deps: ExecutorDeps): {
	execute: ExecuteSubagent;
	resume: (...args: Parameters<ExecuteSubagent>) => Promise<SubagentExecutionResult | undefined>;
} {
	const execute = async (
		_id: string,
		params: SubagentParamsLike,
		signal: AbortSignal | undefined,
		onUpdate: ((r: SubagentExecutionResult) => void) | undefined,
		ctx: ExtensionContext,
		executionCwd?: string,
	): Promise<SubagentExecutionResult> => {
		deps.ensureSessionState?.(ctx);
		const needsExecutionCwd = !params.action || params.cwd !== undefined || ["list", "get", "create", "update", "delete", "doctor"].includes(params.action);
		const invocationCwd = needsExecutionCwd ? executionCwd ?? resolveExecutionCwd(deps.pi, ctx) : ctx.cwd;
		if (needsExecutionCwd) deps.state.baseCwd = invocationCwd;
		deps.state.foregroundRuns ??= new Map();
		const requestCwd = resolveRequestedCwd(invocationCwd, params.cwd);
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
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						return { content: [{ type: "text", text: message }], isError: true, details: { mode: "management", results: [] } };
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
					const foreground = [...(deps.state.foregroundRuns?.values() ?? [])]
						.sort((a, b) => b.updatedAt - a.updatedAt)
						.map((run) => rememberedForegroundStatusResult(run));
					if (foreground.length) {
						inspected = {
							...inspected,
							content: [...foreground.flatMap((result) => result.content), ...inspected.content],
							details: {
								...inspected.details,
								managementControls: [...foreground.flatMap((result) => result.details.managementControl ? [result.details.managementControl] : []), ...(inspected.details.managementControls ?? [])],
							},
						};
					}
				}
				return inspected;
			}
			if (params.action === "nudge") {
				return nudgeSubagentRun({ params: paramsWithResolvedCwd, deps, ctx });
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
				return extendAsyncTimeoutResult(deps.state, resolved?.id ?? targetRunId, paramsWithResolvedCwd.extendMs ?? paramsWithResolvedCwd.timeoutMs ?? paramsWithResolvedCwd.maxRuntimeMs ?? 0);
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
				if (resolved?.kind === "nested") return interruptNestedRun(resolved, paramsWithResolvedCwd.index);
				const asyncInterruptResult = interruptAsyncRun(deps.state, resolved?.kind === "async" ? resolved.id : targetRunId, paramsWithResolvedCwd.index);
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
		const effectiveCwd = effectiveParams.cwd ?? invocationCwd;
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
		bindNativeInvocation(deps.pi, ctx, params.nativeToolCallId, { runId, kind: "launch", ...(params.includeProgress ? { includeProgress: true } : {}) });
		const agentNameAtIndex = buildFlatAgentNameResolver(effectiveParams);
		const resolveContextForAgent = (agentName: string | undefined) =>
			resolveAgentContext(effectiveParams.context, agentName, discoveredAgents);
		const resolveContextForIndex = (index?: number) =>
			resolveContextForAgent(agentNameAtIndex(index ?? 0));
		const agents = discoveredAgents.map((agent) => ({ ...agent, defaultContext: resolveContextForAgent(agent.name) }));
		const inheritedNestedRoute = resolveInheritedNestedRouteFromEnv();
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

		try {
			const clarified = await clarifyInvocation({ params: effectiveParams, agents, ctx, cwd: effectiveCwd, runId });
			if (!clarified) return { content: [{ type: "text", text: "Cancelled" }], details: { mode: hasChain ? "chain" : hasTasks ? "parallel" : "single", results: [] } };
			effectiveParams = clarified;
		} catch (error) {
			return toExecutionErrorResult(effectiveParams, error, invocationContext);
		}
		if (signal?.aborted) return toExecutionErrorResult(effectiveParams, new Error("Subagent cancelled before launch."), invocationContext);

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

		const workflowGraph = effectiveParams.chain ? buildWorkflowGraphSnapshot({ runId, steps: effectiveParams.chain }) : undefined;
		const assignmentNodes = workflowGraph && workflowAgentNodes(workflowGraph);
		const onUpdateWithContext = (r: SubagentExecutionResult) => {
			const owned = deps.state.ownedRuns?.get(runId);
			if (owned && r.details.workflowGraph) rememberOwnedRun(deps.state, { ...owned, children: workflowChildren(owned.children, r.details.workflowGraph) });

			onUpdate?.(withForkContext(r, invocationContext));
		};
		const assignments = effectiveParams.tasks ?? effectiveParams.chain?.flatMap((step) =>
			isParallelStep(step) ? step.parallel : isDynamicParallelStep(step) ? [step.parallel] : [step])
			?? [{ agent: effectiveParams.agent!, task: effectiveParams.task, label: effectiveParams.label }];

		saveQuestionOwner(runId, ctx.sessionManager.getSessionId());
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

		try {
			const result = runAsyncPath(execData, deps);
			if (!result) throw new Error("Invalid subagent execution mode.");
			if (result.isError) return withForkContext(result, invocationContext);
			rememberOwnedRun(deps.state, {
				runId, ownerSessionId: ctx.sessionManager.getSessionId(), rootRunId: runId,
				source: "async", mode: hasChain ? "chain" : hasTasks ? "parallel" : "single",
				cwd: effectiveCwd, task: effectiveParams.task ?? effectiveParams.tasks?.map((task) => task.task).join("\n") ?? "Delegated workflow",
				asyncDir: result.details.asyncDir, pid: result.details.asyncPid ?? deps.state.asyncJobs.get(runId)?.pid,
				startedAt: Date.now(), children: assignments.map(({ agent, task, label }, index) => ({ agent, index, task, label, ...(assignmentNodes?.[index] ? { workflowNodeId: assignmentNodes[index]!.id } : {}) })),
			});
			if ((!effectiveAsync || params.nativeToolCallId) && result.details.asyncId) {
				return withForkContext(await waitForOwnedRun({ id: runId, deps, ctx, signal, onUpdate: onUpdateWithContext,
					cancelNewRun: !effectiveAsync, executionResult: true, includeProgress: effectiveParams.includeProgress, nativeAsync: Boolean(params.nativeToolCallId) }), invocationContext);
			}
			return withForkContext(result, invocationContext);
		} catch (error) {
			const result = toExecutionErrorResult(effectiveParams, error, invocationContext);
			const owned = deps.state.ownedRuns?.get(runId);
			if (owned) rememberOwnedRun(deps.state, { ...owned, error: result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") });
			return result;
		}
	};

	return { execute: async (...args) => {
		const [id, params, signal, onUpdate, ctx, executionCwd] = args;
		const nativeAsync = isNativeAsyncCall(ctx, id) && (!params.action || params.action === "resume" || params.action === "answer");
		const request = { ...params, nativeToolCallId: nativeAsync ? id : undefined };
		const waiting = (params.async === false || nativeAsync) && (params.action === "resume" || params.action === "answer");
		const before = waiting ? new Set(deps.state.ownedRuns?.keys()) : undefined;
		let result = await execute(id, request, signal, onUpdate, ctx, executionCwd);
		// Launch/answer receipts and claims are saved before waiting; execution failure must not undo a successful launch.
		if (waiting && !result.isError) {
			const question = result.details.questions?.find((question) => question.delivery || question.state === "answer_pending");
			const id = result.details.asyncId ?? result.details.managementControl?.runId ?? question?.delivery?.runId ?? question?.runId ?? params.id ?? params.runId;
			const index = result.details.asyncId || question?.delivery?.kind === "revive" ? 0
				: result.details.managementControl?.nextActions.find((action) => action.index !== undefined)?.index ?? question?.index ?? params.index;
			if (id) return waitForOwnedRun({ id, index, deps, ctx, signal, onUpdate, cancelNewRun: params.async === false && !before?.has(id) && deps.state.ownedRuns?.has(id), nativeAsync, executionResult: true, includeProgress: params.includeProgress });
		}
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
	}, resume: async (id, _params, signal, onUpdate, ctx) => {
		deps.ensureSessionState?.(ctx);
		const invocation = nativeInvocations(ctx).find((call) => call.toolCallId === id);
		const target = invocation && nativeInvocationTarget(ctx, invocation);
		if (!target) return undefined;
		if (!resolveOwnedRun(deps.state, target.runId) && resolveSubagentRunId(target.runId, { state: deps.state, nested: nestedResolutionScopeForExecutor(deps) })?.kind !== "nested") return undefined;
		return waitForOwnedRun({ id: target.runId, index: target.index, deps, ctx, signal, onUpdate, nativeAsync: true, executionResult: true, includeProgress: invocation?.includeProgress });
	} };
}
