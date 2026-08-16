import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AgentConfig } from "../../agents/agents.ts";
import { ChainClarifyComponent, type ChainClarifyResult } from "./chain-clarify.ts";
import { toModelInfo, type ModelInfo } from "../../shared/model-info.ts";
import { executeChain } from "./chain-execution.ts";
import { runSync } from "./execution.ts";
import { createForegroundTimeoutExtensionRegistry, type ForegroundTimeoutExtensionRegistry } from "./timeout-extension.ts";
import { resolveModelCandidate } from "../shared/model-fallback.ts";
import { aggregateParallelOutputs } from "../shared/parallel-utils.ts";
import { loadRunsForAgent, recordRun } from "../shared/run-history.ts";
import {
	buildChainInstructions,
	writeInitialProgressFile,
	getStepAgents,
	isParallelStep,
	isDynamicParallelStep,
	resolveStepBehavior,
	suppressProgressForReadOnlyTask,
	taskDisallowsFileUpdates,
	type ChainStep,
	type ResolvedStepBehavior,
	type SequentialStep,
	type StepOverrides,
} from "../../shared/settings.ts";
import { discoverAvailableSkills, normalizeSkillInput } from "../../agents/skills.ts";
import { executeAsyncChain, executeAsyncSingle } from "../background/async-execution.ts";
import { resolveConfiguredChildProjectTrustPolicy } from "../shared/pi-args.ts";
import {
	validateForkContextModelPolicy,
	wrapChainTasksForAgentContext,
	wrapTaskForAgentContext,
} from "../../shared/agent-context-policy.ts";
import { INTERCOM_BRIDGE_MARKER, resolveSubagentIntercomTarget } from "../../intercom/intercom-bridge.ts";
import { finalizeSingleOutput, findDuplicateOutputPath, injectSingleOutputInstruction, materializeAgentDefaultOutputPath, normalizeSingleOutputOverride, resolveSingleOutputPath, validateFileOnlyOutputMode } from "../shared/single-output.ts";
import { createStructuredOutputRuntime } from "../shared/structured-output.ts";
import { formatDetachedIntercomGuidance } from "../shared/intercom-detach.ts";
import { compactForegroundDetails, getSingleResultOutput, mapConcurrent, resolveChildCwd } from "../../shared/utils.ts";
import { updateForegroundNestedProjection } from "../shared/nested-events.ts";
import { validateAcceptanceInput } from "../shared/acceptance.ts";
import {
	appendWorktreeSummary,
	cleanupWorktrees,
	createWorktrees,
	extractWorktreeSummary,
	findWorktreeTaskCwdConflict,
	formatParallelWorktreeSummary,
	formatWorktreeTaskCwdConflict,
	type WorktreeSetup,
} from "../shared/worktree.ts";
import {
	type AgentProgress,
	type ArtifactPaths,
	type ChildProjectTrustPolicy,
	type ControlEvent,
	type Details,
	type SubagentExecutionResult,
	type ExtensionConfig,
	type ForegroundControlState,
	type IntercomEventBus,
	type MaxOutputConfig,
	type ResolvedControlConfig,
	type SingleResult,
	type TimeoutExtensionCallback,
	resolveTopLevelParallelConcurrency,
	resolveTopLevelParallelMaxTasks,
	resolveChildMaxSubagentDepth,
	resolveCurrentMaxSubagentDepth,
} from "../../shared/types.ts";

import {
	type ExecutionContextData,
	type ExecutorDeps,
	type SubagentParamsLike,
	type TaskParam,
	maxParallelTasksMessage,
	resolveTopLevelOutputOverride,
	usesAgentDefaultOutput,
} from "./subagent-params.ts";
import {
	createDetachedCompletionGroup,
	createForegroundControlNotifier,
	maybeBuildForegroundIntercomReceipt,
	rememberForegroundRun,
} from "./subagent-control.ts";

function validationErrorResult(mode: Details["mode"], text: string): SubagentExecutionResult {
	return { content: [{ type: "text", text }], isError: true, details: { mode, results: [] } };
}

const MIN_REVIEWER_FOREGROUND_TIMEOUT_MS = 900_000;
const LONG_RUNNING_HISTORY_SAMPLE_SIZE = 20;
const LONG_RUNNING_HISTORY_MIN_SAMPLES = 3;
const LONG_RUNNING_HISTORY_HEADROOM = 1.25;
const LONG_RUNNING_HISTORY_MAX_TIMEOUT_MS = 1_800_000;

type TimeoutRole = "reviewer" | "planner" | "researcher";

function resolveTimeoutRole(agentName: string | undefined): TimeoutRole | undefined {
	if (typeof agentName !== "string") return undefined;
	if (/(^|[._-])reviewer($|[._-])/i.test(agentName)) return "reviewer";
	if (/(^|[._-])planner($|[._-])/i.test(agentName)) return "planner";
	if (/(^|[._-])researcher($|[._-])/i.test(agentName)) return "researcher";
	return undefined;
}

function historicalForegroundTimeoutFloor(agentName: string): number | undefined {
	const durations = loadRunsForAgent(agentName)
		.filter((entry) => entry.status === "ok" && Number.isFinite(entry.duration) && entry.duration > 0)
		.slice(0, LONG_RUNNING_HISTORY_SAMPLE_SIZE)
		.map((entry) => entry.duration)
		.sort((left, right) => left - right);
	if (durations.length < LONG_RUNNING_HISTORY_MIN_SAMPLES) return undefined;
	const p75 = durations[Math.ceil(durations.length * 0.75) - 1];
	return p75 ? Math.min(LONG_RUNNING_HISTORY_MAX_TIMEOUT_MS, Math.ceil(p75 * LONG_RUNNING_HISTORY_HEADROOM)) : undefined;
}

function roleForegroundTimeoutFloor(agentName: string): number | undefined {
	const role = resolveTimeoutRole(agentName);
	if (!role) return undefined;
	const historical = historicalForegroundTimeoutFloor(agentName);
	if (role === "reviewer") return Math.max(MIN_REVIEWER_FOREGROUND_TIMEOUT_MS, historical ?? 0);
	return historical;
}

export function resolveForegroundTimeoutMs(params: SubagentParamsLike): { timeoutMs?: number; error?: string } {
	const rawTimeout = (params as { timeoutMs?: unknown }).timeoutMs;
	const rawMaxRuntime = (params as { maxRuntimeMs?: unknown }).maxRuntimeMs;
	for (const [name, value] of [["timeoutMs", rawTimeout], ["maxRuntimeMs", rawMaxRuntime]] as const) {
		if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < 1)) {
			return { error: `${name} must be a positive integer.` };
		}
	}
	if (rawTimeout !== undefined && rawMaxRuntime !== undefined && rawTimeout !== rawMaxRuntime) {
		return { error: "timeoutMs and maxRuntimeMs are aliases; provide only one or use identical values." };
	}
	const timeoutMs = typeof rawTimeout === "number" ? rawTimeout : typeof rawMaxRuntime === "number" ? rawMaxRuntime : undefined;
	return timeoutMs === undefined ? {} : { timeoutMs };
}

function timeoutRoleAgentsInRequest(params: SubagentParamsLike): string[] {
	const names = new Set<string>();
	if ((params.chain?.length ?? 0) > 0) {
		for (const step of params.chain ?? []) {
			for (const agent of getStepAgents(step as ChainStep)) {
				if (resolveTimeoutRole(agent)) names.add(agent);
			}
		}
		return [...names];
	}
	if ((params.tasks?.length ?? 0) > 0) {
		for (const task of params.tasks ?? []) {
			if (resolveTimeoutRole(task.agent)) names.add(task.agent);
		}
		return [...names];
	}
	if (resolveTimeoutRole(params.agent)) names.add(params.agent!);
	return [...names];
}

export function normalizeRoleForegroundTimeout(params: SubagentParamsLike, timeoutMs: number | undefined): number | undefined {
	if (timeoutMs === undefined) return timeoutMs;
	let normalized = timeoutMs;
	for (const agentName of timeoutRoleAgentsInRequest(params)) {
		const floor = roleForegroundTimeoutFloor(agentName);
		if (floor !== undefined && normalized < floor) normalized = floor;
	}
	return normalized;
}

function validateAcceptanceForExecution(params: SubagentParamsLike): SubagentExecutionResult | null {
	const topLevelErrors = validateAcceptanceInput(params.acceptance);
	if (topLevelErrors.length > 0) return validationErrorResult("single", topLevelErrors.join(" "));
	for (const [index, task] of (params.tasks ?? []).entries()) {
		const errors = validateAcceptanceInput(task.acceptance, `tasks[${index}].acceptance`);
		if (errors.length > 0) return validationErrorResult("parallel", errors.join(" "));
	}
	for (const [stepIndex, step] of (params.chain ?? []).entries()) {
		if (isParallelStep(step)) {
			if (Object.hasOwn(step, "acceptance")) return validationErrorResult("chain", `chain[${stepIndex}].acceptance is not supported on static parallel groups; set acceptance on each parallel task.`);
			for (const [taskIndex, task] of step.parallel.entries()) {
				const errors = validateAcceptanceInput(task.acceptance, `chain[${stepIndex}].parallel[${taskIndex}].acceptance`);
				if (errors.length > 0) return validationErrorResult("chain", errors.join(" "));
			}
		} else if (isDynamicParallelStep(step)) {
			if (Object.hasOwn(step, "acceptance")) return validationErrorResult("chain", `chain[${stepIndex}].acceptance is not supported on dynamic fanout groups; set acceptance on chain[${stepIndex}].parallel.acceptance for each materialized child.`);
			const errors = validateAcceptanceInput(step.parallel.acceptance, `chain[${stepIndex}].parallel.acceptance`);
			if (errors.length > 0) return validationErrorResult("chain", errors.join(" "));
		} else {
			const stepErrors = validateAcceptanceInput(step.acceptance, `chain[${stepIndex}].acceptance`);
			if (stepErrors.length > 0) return validationErrorResult("chain", stepErrors.join(" "));
		}
	}
	return null;
}

const SEQUENTIAL_CHAIN_STEP_KEYS = new Set(["agent", "task", "phase", "label", "as", "outputSchema", "cwd", "output", "outputMode", "reads", "progress", "skill", "model", "acceptance"]);
const STATIC_PARALLEL_STEP_KEYS = new Set(["parallel", "concurrency", "failFast", "worktree", "cwd"]);
const DYNAMIC_PARALLEL_STEP_KEYS = new Set(["expand", "parallel", "collect", "concurrency", "failFast", "phase", "label"]);

function unsupportedChainStepFields(step: object, allowed: Set<string>): string[] {
	return Object.keys(step).filter((key) => !allowed.has(key));
}

export function validateExecutionInput(
	params: SubagentParamsLike,
	agents: AgentConfig[],
	hasChain: boolean,
	hasTasks: boolean,
	hasSingle: boolean,
	allowClarifyTaskPrompt: boolean,
): SubagentExecutionResult | null {
	const acceptanceError = validateAcceptanceForExecution(params);
	if (acceptanceError) return acceptanceError;

	if (params.tasks && params.tasks.length === 0) return validationErrorResult("parallel", "tasks must contain at least one task.");
	if (params.worktree !== undefined && !hasTasks) return validationErrorResult(getRequestedModeLabel(params), "Top-level worktree is supported only with tasks parallel mode.");
	if (hasSingle && params.task !== undefined && (typeof params.task !== "string" || params.task.trim().length === 0)) {
		return validationErrorResult("single", "task must be a non-empty string when provided.");
	}

	if (Number(hasChain) + Number(hasTasks) + Number(hasSingle) !== 1) {
		return {
			content: [
				{
					type: "text",
					text: `Provide exactly one mode. Agents: ${agents.map((a) => a.name).join(", ") || "none"}`,
				},
			],
			isError: true,
			details: { mode: "single" as const, results: [] },
		};
	}

	const timeoutResolution = resolveForegroundTimeoutMs(params);
	if (timeoutResolution.error) return validationErrorResult(getRequestedModeLabel(params), timeoutResolution.error);

	if (hasSingle && params.agent && !agents.find((agent) => agent.name === params.agent)) {
		return {
			content: [{ type: "text", text: `Unknown agent: ${params.agent}` }],
			isError: true,
			details: { mode: "single" as const, results: [] },
		};
	}

	if (hasTasks && params.tasks) {
		for (let i = 0; i < params.tasks.length; i++) {
			const task = params.tasks[i]!;
			if (typeof task.task !== "string" || task.task.trim().length === 0) return validationErrorResult("parallel", `tasks[${i}].task must be a non-empty string.`);
			if (!agents.find((agent) => agent.name === task.agent)) {
				return {
					content: [{ type: "text", text: `Unknown agent: ${task.agent} (task ${i + 1})` }],
					isError: true,
					details: { mode: "parallel" as const, results: [] },
				};
			}
		}
	}

	if (hasChain && params.chain) {
		if (params.chain.length === 0) {
			return {
				content: [{ type: "text", text: "Chain must have at least one step" }],
				isError: true,
				details: { mode: "chain" as const, results: [] },
			};
		}
		const firstStep = params.chain[0] as ChainStep;
		if (isParallelStep(firstStep)) {
			const missingTaskIndex = firstStep.parallel.findIndex((t) => !t.task);
			if (missingTaskIndex !== -1) {
				return {
					content: [{ type: "text", text: `First parallel step: task ${missingTaskIndex + 1} must have a task (no previous output to reference)` }],
					isError: true,
					details: { mode: "chain" as const, results: [] },
				};
			}
		} else if (isDynamicParallelStep(firstStep)) {
			return {
				content: [{ type: "text", text: "First step in chain cannot be dynamic fanout; expand.from requires a prior structured named output" }],
				isError: true,
				details: { mode: "chain" as const, results: [] },
			};
		} else if (!(firstStep as SequentialStep).task && !params.task && !allowClarifyTaskPrompt) {
			return {
				content: [{ type: "text", text: "First step in chain must have a task" }],
				isError: true,
				details: { mode: "chain" as const, results: [] },
			};
		}
		for (let i = 0; i < params.chain.length; i++) {
			const step = params.chain[i] as ChainStep;
			const allowedKeys = isParallelStep(step) ? STATIC_PARALLEL_STEP_KEYS : isDynamicParallelStep(step) ? DYNAMIC_PARALLEL_STEP_KEYS : SEQUENTIAL_CHAIN_STEP_KEYS;
			const unsupportedFields = unsupportedChainStepFields(step, allowedKeys);
			if (unsupportedFields.length > 0) return validationErrorResult("chain", `chain[${i}] fields are not supported for this step mode: ${unsupportedFields.join(", ")}.`);
			if (Object.hasOwn(step, "task") && (typeof (step as { task?: unknown }).task !== "string" || !(step as { task: string }).task.trim())) {
				return validationErrorResult("chain", `chain[${i}].task must be a non-empty string when provided.`);
			}
			if (isParallelStep(step)) {
				const emptyTaskIndex = step.parallel.findIndex((task) => Object.hasOwn(task, "task") && (typeof task.task !== "string" || !task.task.trim()));
				if (emptyTaskIndex >= 0) return validationErrorResult("chain", `chain[${i}].parallel[${emptyTaskIndex}].task must be a non-empty string when provided.`);
			} else if (isDynamicParallelStep(step) && Object.hasOwn(step.parallel, "task") && (typeof step.parallel.task !== "string" || !step.parallel.task.trim())) {
				return validationErrorResult("chain", `chain[${i}].parallel.task must be a non-empty string when provided.`);
			}
			const stepAgents = getStepAgents(step);
			for (const agentName of stepAgents) {
				if (!agents.find((a) => a.name === agentName)) {
					return {
						content: [{ type: "text", text: `Unknown agent: ${agentName} (step ${i + 1})` }],
						isError: true,
						details: { mode: "chain" as const, results: [] },
					};
				}
			}
			if (isParallelStep(step) && step.parallel.length === 0) {
				return {
					content: [{ type: "text", text: `Parallel step ${i + 1} must have at least one task` }],
					isError: true,
					details: { mode: "chain" as const, results: [] },
				};
			}
		}
	}

	return null;
}

function getRequestedModeLabel(params: SubagentParamsLike): Details["mode"] {
	if ((params.chain?.length ?? 0) > 0) return "chain";
	if ((params.tasks?.length ?? 0) > 0) return "parallel";
	if (params.agent) return "single";
	return "single";
}


export function buildRequestedModeError(params: SubagentParamsLike, message: string): SubagentExecutionResult {
	return withForkContext(
		{
			content: [{ type: "text", text: message }],
			isError: true,
			details: { mode: getRequestedModeLabel(params), results: [] },
		},
		params.context,
	);
}

function expandTopLevelTaskCounts(tasks: TaskParam[]): { tasks?: TaskParam[]; error?: string } {
	const expanded: TaskParam[] = [];
	for (let taskIndex = 0; taskIndex < tasks.length; taskIndex++) {
		const task = tasks[taskIndex]!;
		const rawCount = (task as TaskParam & { count?: unknown }).count;
		if (rawCount !== undefined && (typeof rawCount !== "number" || !Number.isInteger(rawCount) || rawCount < 1)) {
			return { error: `tasks[${taskIndex}].count must be an integer >= 1` };
		}
		const { count, ...concreteTask } = task;
		for (let repeat = 0; repeat < (rawCount ?? 1); repeat++) {
			expanded.push({ ...concreteTask });
		}
	}
	return { tasks: expanded };
}

function expandChainParallelCounts(chain: ChainStep[]): { chain?: ChainStep[]; error?: string } {
	const expandedChain: ChainStep[] = [];
	for (let stepIndex = 0; stepIndex < chain.length; stepIndex++) {
		const step = chain[stepIndex]!;
		if (!isParallelStep(step)) {
			expandedChain.push(step);
			continue;
		}
		const expandedParallel = [];
		for (let taskIndex = 0; taskIndex < step.parallel.length; taskIndex++) {
			const task = step.parallel[taskIndex]!;
			const rawCount = (task as typeof task & { count?: unknown }).count;
			if (rawCount !== undefined && (typeof rawCount !== "number" || !Number.isInteger(rawCount) || rawCount < 1)) {
				return { error: `chain[${stepIndex}].parallel[${taskIndex}].count must be an integer >= 1` };
			}
			const { count, ...concreteTask } = task;
			for (let repeat = 0; repeat < (rawCount ?? 1); repeat++) {
				expandedParallel.push({ ...concreteTask });
			}
		}
		expandedChain.push({ ...step, parallel: expandedParallel });
	}
	return { chain: expandedChain };
}

export function normalizeRepeatedParallelCounts(params: SubagentParamsLike): { params?: SubagentParamsLike; error?: SubagentExecutionResult } {
	if (params.tasks) {
		const expandedTasks = expandTopLevelTaskCounts(params.tasks);
		if (expandedTasks.error) {
			return { error: buildRequestedModeError(params, expandedTasks.error) };
		}
		return { params: { ...params, tasks: expandedTasks.tasks } };
	}
	if (params.chain) {
		const expandedChain = expandChainParallelCounts(params.chain);
		if (expandedChain.error) {
			return { error: buildRequestedModeError(params, expandedChain.error) };
		}
		return { params: { ...params, chain: expandedChain.chain } };
	}
	return { params };
}

export function withForkContext(
	result: SubagentExecutionResult,
	context: SubagentParamsLike["context"],
): SubagentExecutionResult {
	if (context !== "fork" || !result.details) return result;
	return {
		...result,
		details: {
			...result.details,
			context: "fork",
		},
	};
}

export function toExecutionErrorResult(
	params: SubagentParamsLike,
	error: unknown,
	context: SubagentParamsLike["context"] = params.context,
): SubagentExecutionResult {
	const message = error instanceof Error ? error.message : String(error);
	return withForkContext(
		{
			content: [{ type: "text", text: message }],
			isError: true,
			details: { mode: getRequestedModeLabel(params), results: [] },
		},
		context,
	);
}

function collectChainSessionFiles(
	chain: ChainStep[],
	sessionFileForIndex: (idx?: number) => string | undefined,
	sessionFileForAgentIndex: (agentName: string | undefined, idx?: number) => string | undefined,
	dynamicFanoutMaxItems?: number,
): (string | undefined)[] {
	const sessionFiles: (string | undefined)[] = [];
	let flatIndex = 0;
	for (const step of chain) {
		if (isParallelStep(step)) {
			for (let i = 0; i < step.parallel.length; i++) {
				const agentName = step.parallel[i]?.agent;
				sessionFiles.push(sessionFileForAgentIndex(agentName, flatIndex) ?? sessionFileForIndex(flatIndex));
				flatIndex++;
			}
			continue;
		}
		if (isDynamicParallelStep(step)) {
			const maxItems = step.expand.maxItems ?? dynamicFanoutMaxItems ?? 0;
			for (let i = 0; i < maxItems; i++) {
				sessionFiles.push(sessionFileForAgentIndex(step.parallel.agent, flatIndex) ?? sessionFileForIndex(flatIndex));
				flatIndex++;
			}
			continue;
		}
		const agentName = getStepAgents(step)[0];
		sessionFiles.push(sessionFileForAgentIndex(agentName, flatIndex) ?? sessionFileForIndex(flatIndex));
		flatIndex++;
	}
	return sessionFiles;
}

export function runAsyncPath(data: ExecutionContextData, deps: ExecutorDeps): SubagentExecutionResult | null {
	const {
		params,
		effectiveCwd,
		agents,
		ctx,
		shareEnabled,
		sessionRoot,
		sessionFileForIndex,
		sessionFileForAgentIndex,
		artifactsEnabled,
		artifactsDir,
		effectiveAsync,
		controlConfig,
		intercomBridge,
		nestedRoute,
	} = data;
	const hasChain = (params.chain?.length ?? 0) > 0;
	const hasTasks = (params.tasks?.length ?? 0) > 0;
	const hasSingle = !hasChain && !hasTasks && Boolean(params.agent);
	if (!effectiveAsync) return null;

	if (hasChain && params.chain) {
		const chainWorktreeTaskCwdError = buildChainWorktreeTaskCwdError(params.chain as ChainStep[], effectiveCwd);
		if (chainWorktreeTaskCwdError) {
			return {
				content: [{ type: "text", text: chainWorktreeTaskCwdError }],
				isError: true,
				details: { mode: "chain" as const, results: [] },
			};
		}
	}

	if (hasTasks && params.tasks) {
		const maxParallelTasks = resolveTopLevelParallelMaxTasks(deps.config.parallel?.maxTasks);
		if (params.tasks.length > maxParallelTasks) {
			return buildParallelModeError(maxParallelTasksMessage(maxParallelTasks));
		}
		if (params.worktree) {
			const worktreeTaskCwdError = buildParallelWorktreeTaskCwdError(params.tasks, effectiveCwd);
			if (worktreeTaskCwdError) return buildParallelModeError(worktreeTaskCwdError);
		}
	}
	const id = randomUUID();
	const asyncCtx = {
		pi: deps.pi,
		cwd: ctx.cwd,
		currentSessionId: deps.state.currentSessionId!,
		currentModelProvider: ctx.model?.provider,
		projectTrusted: ctx.isProjectTrusted(),
	};
	const availableModels: ModelInfo[] = ctx.modelRegistry.getAvailable().map(toModelInfo);
	const currentMaxSubagentDepth = resolveCurrentMaxSubagentDepth(deps.config.maxSubagentDepth);
	const currentProvider = ctx.model?.provider;
	const controlIntercomTarget = intercomBridge.orchestratorTarget;
	const childIntercomTarget = (agent: string, index: number) => resolveSubagentIntercomTarget(id, agent, index);
	const projectTrust = resolveConfiguredChildProjectTrustPolicy(deps.config.projectTrust);

	if (hasTasks && params.tasks) {
		const agentConfigs = params.tasks.map((task) => agents.find((agent) => agent.name === task.agent));
		const modelOverrides = params.tasks.map((task, index) =>
			resolveModelCandidate(task.model ?? agentConfigs[index]?.model, availableModels, currentProvider),
		);
		const skillOverrides = params.tasks.map((task) => normalizeSkillInput(task.skill));
		const parallelTasks = params.tasks.map((task, index) => {
			const outputFromAgentDefault = usesAgentDefaultOutput(task.output);
			const output = resolveTopLevelOutputOverride({
				requestedOutput: task.output,
				agentDefaultOutput: agentConfigs[index]?.output,
				artifactsDir,
				runId: id,
				agent: task.agent,
				index,
			});
			return {
				agent: task.agent,
				task: wrapTaskForAgentContext(task.task, params.context, task.agent, agents),
				cwd: task.cwd,
				...(modelOverrides[index] ? { model: modelOverrides[index] } : {}),
				...(skillOverrides[index] !== undefined ? { skill: skillOverrides[index] } : {}),
				...(output !== undefined ? { output } : {}),
				...(task.outputMode !== undefined ? { outputMode: task.outputMode } : {}),
				...(outputFromAgentDefault && output !== undefined ? { outputFromAgentDefault: true } : {}),
				...(outputFromAgentDefault && typeof agentConfigs[index]?.output === "string" ? { defaultOutputSource: agentConfigs[index]!.output } : {}),
				...(task.outputSchema !== undefined ? { outputSchema: task.outputSchema } : {}),
				...(task.reads !== undefined && task.reads !== true ? { reads: task.reads } : {}),
				...(task.progress !== undefined ? { progress: task.progress } : {}),
				...(task.acceptance !== undefined ? { acceptance: task.acceptance } : {}),
			};
		});
		const asyncParallelBehaviors = parallelTasks.map((task, index) => resolveStepBehavior(agentConfigs[index]!, {
			...(task.output !== undefined ? { output: task.output } : {}),
			...(task.outputMode !== undefined ? { outputMode: task.outputMode } : {}),
		}));
		const duplicateOutputError = params.worktree
			? findDuplicateAbsoluteParallelOutputPath({ tasks: parallelTasks, behaviors: asyncParallelBehaviors })
			: findDuplicateParallelOutputPath({
				tasks: parallelTasks,
				behaviors: asyncParallelBehaviors,
				paramsCwd: effectiveCwd,
				ctxCwd: ctx.cwd,
			});
		if (duplicateOutputError) return buildParallelModeError(duplicateOutputError);
		return executeAsyncChain(id, {
			chain: [{
				parallel: parallelTasks,
				concurrency: resolveTopLevelParallelConcurrency(params.concurrency, deps.config.parallel?.concurrency),
				worktree: params.worktree,
			}],
			resultMode: "parallel",
			agents,
			ctx: asyncCtx,
			availableModels,
			cwd: effectiveCwd,
			maxOutput: params.maxOutput,
			artifactsDir: artifactsEnabled ? artifactsDir : undefined,
			shareEnabled,
			sessionRoot,
			chainSkills: [],
			sessionFilesByFlatIndex: params.tasks.map((_, index) => sessionFileForIndex(index)),
			maxSubagentDepth: currentMaxSubagentDepth,
			worktreeSetupHook: deps.config.worktreeSetupHook,
			worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
			controlConfig,
			controlIntercomTarget,
			childIntercomTarget,
			nestedRoute,
			projectTrust,
		});
	}

	if (hasChain && params.chain) {
		const normalized = normalizeSkillInput(params.skill);
		const chainSkills = normalized === false ? [] : (normalized ?? []);
		const chain = wrapChainTasksForAgentContext(params.chain as ChainStep[], params.context, agents);
		return executeAsyncChain(id, {
			chain,
			task: params.task,
			agents,
			ctx: asyncCtx,
			availableModels,
			cwd: effectiveCwd,
			chainDir: params.chainDir,
			maxOutput: params.maxOutput,
			artifactsDir: artifactsEnabled ? artifactsDir : undefined,
			shareEnabled,
			sessionRoot,
			chainSkills,
			sessionFilesByFlatIndex: collectChainSessionFiles(chain, sessionFileForIndex, sessionFileForAgentIndex, deps.config.chain?.dynamicFanout?.maxItems),
			dynamicFanoutMaxItems: deps.config.chain?.dynamicFanout?.maxItems,
			maxSubagentDepth: currentMaxSubagentDepth,
			worktreeSetupHook: deps.config.worktreeSetupHook,
			worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
			controlConfig,
			controlIntercomTarget,
			childIntercomTarget,
			nestedRoute,
			projectTrust,
		});
	}

	if (hasSingle) {
		const a = agents.find((x) => x.name === params.agent);
		if (!a) {
			return {
				content: [{ type: "text", text: `Unknown agent: ${params.agent}` }],
				isError: true,
				details: { mode: "single" as const, results: [] },
			};
		}
		const effectiveOutput = resolveTopLevelOutputOverride({
			requestedOutput: params.output,
			agentDefaultOutput: a.output,
			artifactsDir,
			runId: id,
			agent: params.agent!,
			index: 0,
		});
		const effectiveOutputMode = params.outputMode ?? "inline";
		const normalizedSkills = normalizeSkillInput(params.skill);
		const skills = normalizedSkills === false ? [] : normalizedSkills;
		const maxSubagentDepth = resolveChildMaxSubagentDepth(currentMaxSubagentDepth, a.maxSubagentDepth);
		const modelOverride = resolveModelCandidate((params.model as string | undefined) ?? a.model, availableModels, currentProvider);
		return executeAsyncSingle(id, {
			agent: params.agent!,
			task: wrapTaskForAgentContext(params.task ?? "", params.context, params.agent, agents),
			agentConfig: a,
			ctx: asyncCtx,
			availableModels,
			cwd: effectiveCwd,
			maxOutput: params.maxOutput,
			artifactsDir: artifactsEnabled ? artifactsDir : undefined,
			shareEnabled,
			sessionRoot,
			sessionFile: sessionFileForIndex(0),
			skills,
			output: effectiveOutput,
			outputMode: effectiveOutputMode,
			outputSchema: params.outputSchema,
			modelOverride,
			maxSubagentDepth,
			worktreeSetupHook: deps.config.worktreeSetupHook,
			worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
			controlConfig,
			controlIntercomTarget,
			childIntercomTarget,
			nestedRoute,
			acceptance: params.acceptance,
			progress: params.progress,
			projectTrust,
		});
	}

	return null;
}

export async function runChainPath(data: ExecutionContextData, deps: ExecutorDeps): Promise<SubagentExecutionResult> {
	const {
		params,
		effectiveCwd,
		agents,
		ctx,
		signal,
		runId,
		shareEnabled,
		sessionDirForIndex,
		sessionFileForIndex,
		sessionFileForAgentIndex,
		artifactsEnabled,
		artifactsDir,
		onUpdate,
		sessionRoot,
		controlConfig,
	} = data;
	const onControlEvent = createForegroundControlNotifier(data, deps);
	const childIntercomTarget = (id: string, agent: string, index: number) => resolveSubagentIntercomTarget(id, agent, index);
	const foregroundControl = deps.state.foregroundControls.get(runId);
	const normalized = normalizeSkillInput(params.skill);
	const chainSkills = normalized === false ? [] : (normalized ?? []);
	const chain = wrapChainTasksForAgentContext(params.chain as ChainStep[], params.context, agents);
	const currentMaxSubagentDepth = resolveCurrentMaxSubagentDepth(deps.config.maxSubagentDepth);
	const detachedCompletions = createDetachedCompletionGroup({
		pi: deps.pi,
		state: deps.state,
		intercomBridge: data.intercomBridge,
		runId,
		mode: "chain",
		chainSteps: chain.length,
		onResultsSettled: (results) => data.onDetachedResultsSettled?.("chain", results, chain.length),
	});
	const chainResult = await executeChain({
		chain,
		task: params.task,
		agents,
		ctx,
		intercomEvents: deps.pi.events,
		signal,
		runId,
		cwd: effectiveCwd,
		shareEnabled,
		sessionDirForIndex,
		sessionFileForIndex,
		sessionFileForAgentIndex,
		artifactsDir: artifactsEnabled ? artifactsDir : undefined,
		includeProgress: params.includeProgress,
		clarify: params.clarify,
		context: params.context,
		onUpdate,
		onControlEvent,
		controlConfig,
		...(data.foregroundTimeoutMs !== undefined ? { timeoutMs: data.foregroundTimeoutMs } : {}),
		childIntercomTarget: (agent, index) => childIntercomTarget(runId, agent, index),
		orchestratorIntercomTarget: data.intercomBridge.orchestratorTarget,
		foregroundControl,
		nestedRoute: foregroundControl?.nestedRoute,
		chainSkills,
		chainDir: params.chainDir,
		dynamicFanoutMaxItems: deps.config.chain?.dynamicFanout?.maxItems,
		maxSubagentDepth: currentMaxSubagentDepth,
		worktreeSetupHook: deps.config.worktreeSetupHook,
		worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
		projectTrust: resolveConfiguredChildProjectTrustPolicy(deps.config.projectTrust),
		onDetachedComplete: detachedCompletions.onComplete,
	});

	if (chainResult.requestedAsync) {
		const id = randomUUID();
		const asyncCtx = {
			pi: deps.pi,
			cwd: ctx.cwd,
			currentSessionId: deps.state.currentSessionId!,
			currentModelProvider: ctx.model?.provider,
			projectTrusted: ctx.isProjectTrusted(),
		};
		const asyncChain = wrapChainTasksForAgentContext(chainResult.requestedAsync.chain, params.context, agents);
		return executeAsyncChain(id, {
			chain: asyncChain,
			task: params.task,
			agents,
			ctx: asyncCtx,
			availableModels: ctx.modelRegistry.getAvailable().map(toModelInfo),
			cwd: effectiveCwd,
			chainDir: params.chainDir,
			maxOutput: params.maxOutput,
			artifactsDir: artifactsEnabled ? artifactsDir : undefined,
			shareEnabled,
			sessionRoot,
			chainSkills: chainResult.requestedAsync.chainSkills,
			sessionFilesByFlatIndex: collectChainSessionFiles(asyncChain, sessionFileForIndex, sessionFileForAgentIndex, deps.config.chain?.dynamicFanout?.maxItems),
			dynamicFanoutMaxItems: deps.config.chain?.dynamicFanout?.maxItems,
			maxSubagentDepth: currentMaxSubagentDepth,
			worktreeSetupHook: deps.config.worktreeSetupHook,
			worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
			controlConfig,
			controlIntercomTarget: data.intercomBridge.orchestratorTarget,
			childIntercomTarget: (agent, index) => resolveSubagentIntercomTarget(id, agent, index),
			nestedRoute: data.nestedRoute,
			projectTrust: resolveConfiguredChildProjectTrustPolicy(deps.config.projectTrust),
		});
	}

	const chainDetails = chainResult.details ? compactForegroundDetails({ ...chainResult.details, runId }) : undefined;
	if (foregroundControl) updateForegroundNestedProjection(foregroundControl);
	if (chainDetails) {
		rememberForegroundRun(deps.state, { runId, mode: "chain", cwd: effectiveCwd, results: chainDetails.results });
		detachedCompletions.setResults(chainDetails.results, foregroundControl?.nestedChildren);
	}
	const intercomReceipt = chainDetails && !chainDetails.results.some((result) => result.interrupted || result.detached || result.timedOut)
		? await maybeBuildForegroundIntercomReceipt({
			pi: deps.pi,
			intercomBridge: data.intercomBridge,
			runId,
			mode: "chain",
			details: chainDetails,
			...(foregroundControl?.nestedChildren?.length ? { nestedChildren: foregroundControl.nestedChildren } : {}),
		})
		: null;
	if (intercomReceipt) {
		const chainText = chainResult.content.map((part) => part.type === "text" ? part.text : "").join("\n");
		const worktreeSummary = extractWorktreeSummary(chainText);
		return {
			...chainResult,
			content: [{ type: "text", text: appendWorktreeSummary(intercomReceipt.text, worktreeSummary) }],
			details: intercomReceipt.details,
			...(intercomReceipt.status !== "completed" ? { isError: true } : {}),
		};
	}

	return chainDetails ? { ...chainResult, details: chainDetails } : chainResult;
}

interface ForegroundParallelRunInput {
	tasks: TaskParam[];
	taskTexts: string[];
	agents: AgentConfig[];
	ctx: ExtensionContext;
	intercomEvents: IntercomEventBus;
	signal: AbortSignal | undefined;
	runId: string;
	sessionDirForIndex: (idx?: number) => string | undefined;
	sessionFileForIndex: (idx?: number) => string | undefined;
	shareEnabled: boolean;
	artifactsDir: string;
	debugArtifactsDir?: string;
	maxOutput?: MaxOutputConfig;
	timeoutMs?: number;
	timeoutAt?: number;
	paramsCwd: string;
	maxSubagentDepths: number[];
	availableModels: ModelInfo[];
	modelOverrides: (string | undefined)[];
	behaviors: Array<ReturnType<typeof resolveStepBehavior>>;
	outputUsesAgentDefault: boolean[];
	firstProgressIndex: number;
	controlConfig: ResolvedControlConfig;
	onControlEvent?: (event: ControlEvent) => void;
	childIntercomTarget?: (agent: string, index: number) => string | undefined;
	orchestratorIntercomTarget?: string;
	foregroundControl?: ForegroundControlState;
	timeoutExtensionRegistry?: ForegroundTimeoutExtensionRegistry;
	concurrencyLimit: number;
	liveResults: (SingleResult | undefined)[];
	liveProgress: (AgentProgress | undefined)[];
	onUpdate?: (r: SubagentExecutionResult) => void;
	worktreeSetup?: WorktreeSetup;
	projectTrust?: ChildProjectTrustPolicy;
	onDetachedComplete?: (result: SingleResult, index: number) => void;
}

function buildParallelModeError(message: string): SubagentExecutionResult {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
		details: { mode: "parallel" as const, results: [] },
	};
}

function createParallelWorktreeSetup(
	enabled: boolean | undefined,
	cwd: string,
	runId: string,
	tasks: TaskParam[],
	setupHook: ExtensionConfig["worktreeSetupHook"],
	setupHookTimeoutMs: ExtensionConfig["worktreeSetupHookTimeoutMs"],
): { setup?: WorktreeSetup; errorResult?: SubagentExecutionResult } {
	if (!enabled) return {};
	try {
		return {
			setup: createWorktrees(cwd, runId, tasks.length, {
				agents: tasks.map((task) => task.agent),
				setupHook: setupHook
					? { hookPath: setupHook, timeoutMs: setupHookTimeoutMs }
					: undefined,
			}),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { errorResult: buildParallelModeError(message) };
	}
}

function buildParallelWorktreeTaskCwdError(
	tasks: ReadonlyArray<{ agent: string; cwd?: string }>,
	sharedCwd: string,
): string | undefined {
	const conflict = findWorktreeTaskCwdConflict(tasks, sharedCwd);
	if (!conflict) return undefined;
	return formatWorktreeTaskCwdConflict(conflict, sharedCwd);
}

function buildChainWorktreeTaskCwdError(chain: ChainStep[], sharedCwd: string): string | undefined {
	for (let stepIndex = 0; stepIndex < chain.length; stepIndex++) {
		const step = chain[stepIndex]!;
		if (!isParallelStep(step) || !step.worktree) continue;
		const stepCwd = resolveChildCwd(sharedCwd, step.cwd);
		const conflict = findWorktreeTaskCwdConflict(step.parallel, stepCwd);
		if (!conflict) continue;
		const detail = formatWorktreeTaskCwdConflict(conflict, stepCwd);
		return `parallel chain step ${stepIndex + 1}: ${detail}`;
	}
	return undefined;
}

function resolveParallelTaskCwd(
	task: TaskParam,
	paramsCwd: string,
	worktreeSetup: WorktreeSetup | undefined,
	index: number,
): string {
	if (worktreeSetup) return worktreeSetup.worktrees[index]!.agentCwd;
	return resolveChildCwd(paramsCwd, task.cwd);
}

function buildParallelWorktreeSuffix(
	worktreeSetup: WorktreeSetup | undefined,
	artifactsDir: string,
	tasks: TaskParam[],
): string {
	return formatParallelWorktreeSummary(
		worktreeSetup,
		path.join(artifactsDir, "worktree-diffs"),
		tasks.map((task) => task.agent),
	);
}

function findDuplicateParallelOutputPath(input: {
	tasks: TaskParam[];
	behaviors: ResolvedStepBehavior[];
	paramsCwd: string;
	ctxCwd: string;
	worktreeSetup?: WorktreeSetup;
}): string | undefined {
	return findDuplicateOutputPath(input.tasks.map((task, index) => {
		const behavior = input.behaviors[index];
		if (!behavior?.output) return { agent: task.agent };
		const taskCwd = resolveParallelTaskCwd(task, input.paramsCwd, input.worktreeSetup, index);
		return {
			agent: task.agent,
			outputPath: resolveSingleOutputPath(behavior.output, input.ctxCwd, taskCwd),
		};
	}));
}

function findDuplicateAbsoluteParallelOutputPath(input: {
	tasks: TaskParam[];
	behaviors: ResolvedStepBehavior[];
}): string | undefined {
	return findDuplicateOutputPath(input.tasks.map((task, index) => {
		const behavior = input.behaviors[index];
		if (typeof behavior?.output !== "string" || !path.isAbsolute(behavior.output)) return { agent: task.agent };
		return { agent: task.agent, outputPath: path.resolve(behavior.output) };
	}));
}

async function runForegroundParallelTasks(input: ForegroundParallelRunInput): Promise<SingleResult[]> {
	const activeChildren = input.foregroundControl?.activeChildren ?? new Map();
	if (input.foregroundControl) {
		input.foregroundControl.activeChildren = activeChildren;
		input.foregroundControl.interrupt = () => {
			let interrupted = false;
			for (const child of activeChildren.values()) interrupted = child.interrupt?.() === true || interrupted;
			return interrupted;
		};
	}
	return mapConcurrent(input.tasks, input.concurrencyLimit, async (task, index) => {
		const behavior = input.behaviors[index];
		const effectiveSkills = behavior?.skills;
		const taskCwd = resolveParallelTaskCwd(task, input.paramsCwd, input.worktreeSetup, index);
		const readInstructions = behavior
			? buildChainInstructions({ ...behavior, output: false, progress: false }, taskCwd, false)
			: { prefix: "", suffix: "" };
		const progressInstructions = behavior
			? buildChainInstructions({ ...behavior, output: false, reads: false }, input.paramsCwd, index === input.firstProgressIndex)
			: { prefix: "", suffix: "" };
		const outputPath = resolveSingleOutputPath(behavior?.output, input.ctx.cwd, taskCwd);
		const taskText = injectSingleOutputInstruction(
			`${readInstructions.prefix}${input.taskTexts[index]!}${progressInstructions.suffix}`,
			outputPath,
		);
		const interruptController = new AbortController();
		if (input.foregroundControl) {
			input.foregroundControl.currentAgent = task.agent;
			input.foregroundControl.currentIndex = index;
			input.foregroundControl.currentActivityState = undefined;
			input.foregroundControl.updatedAt = Date.now();
			activeChildren.set(index, {
				agent: task.agent,
				interrupt: () => {
					if (interruptController.signal.aborted) return false;
					interruptController.abort();
					input.foregroundControl!.currentActivityState = undefined;
					input.foregroundControl!.updatedAt = Date.now();
					return true;
				},
			});
		}
		const agentConfig = input.agents.find((agent) => agent.name === task.agent);
		const structuredRuntime = task.outputSchema
			? createStructuredOutputRuntime(task.outputSchema, path.join(input.artifactsDir, "structured-output"))
			: undefined;
		const timeoutAt = input.foregroundControl?.timeoutAt ?? input.timeoutAt;
		const runIntercomTarget = input.childIntercomTarget?.(task.agent, index);
		let unregisterTimeoutExtension: (() => void) | undefined;
		return runSync(input.ctx.cwd, input.agents, task.agent, taskText, {
			cwd: taskCwd,
			signal: input.signal,
			interruptSignal: interruptController.signal,
			...(input.timeoutMs !== undefined && timeoutAt !== undefined ? { timeoutMs: input.timeoutMs, timeoutAt } : {}),
			...(input.timeoutMs !== undefined && timeoutAt !== undefined && input.timeoutExtensionRegistry ? { registerTimeoutExtension: (extend: TimeoutExtensionCallback) => { unregisterTimeoutExtension = input.timeoutExtensionRegistry?.register(String(index), extend); } } : {}),
			allowIntercomDetach: agentConfig?.systemPrompt?.includes(INTERCOM_BRIDGE_MARKER) === true,
			onDetachedComplete: (result) => input.onDetachedComplete?.(result, index),
			intercomEvents: input.intercomEvents,
			runId: input.runId,
			index,
			sessionDir: input.sessionDirForIndex(index),
			sessionFile: input.sessionFileForIndex(index),
			share: input.shareEnabled,
			artifactsDir: input.debugArtifactsDir,
			maxOutput: input.maxOutput,
			outputPath,
			outputMode: behavior?.outputMode,
			persistOutputFile: !input.outputUsesAgentDefault[index],
			structuredOutput: structuredRuntime,
			maxSubagentDepth: input.maxSubagentDepths[index],
			maxExecutionTimeMs: agentConfig?.maxExecutionTimeMs,
			maxTokens: agentConfig?.maxTokens,
			controlConfig: input.controlConfig,
			onControlEvent: input.onControlEvent,
			intercomSessionName: runIntercomTarget,
			orchestratorIntercomTarget: runIntercomTarget ? input.orchestratorIntercomTarget : undefined,
			nestedRoute: input.foregroundControl?.nestedRoute,
			modelOverride: input.modelOverrides[index],
			availableModels: input.availableModels,
			preferredModelProvider: input.ctx.model?.provider,
			skills: effectiveSkills === false ? [] : effectiveSkills,
			acceptance: task.acceptance,
			projectTrust: input.projectTrust,
			projectTrusted: input.ctx.isProjectTrusted(),
				onUpdate: input.onUpdate
					? (progressUpdate) => {
						const stepResults = progressUpdate.details?.results || [];
						const stepProgress = progressUpdate.details?.progress || [];
						if (input.foregroundControl && stepProgress.length > 0) {
							const current = stepProgress[0];
							input.foregroundControl.currentAgent = task.agent;
							input.foregroundControl.currentIndex = index;
							input.foregroundControl.currentActivityState = current?.activityState;
							input.foregroundControl.lastActivityAt = current?.lastActivityAt;
							input.foregroundControl.currentTool = current?.currentTool;
							input.foregroundControl.currentToolStartedAt = current?.currentToolStartedAt;
							input.foregroundControl.currentPath = current?.currentPath;
							input.foregroundControl.turnCount = current?.turnCount;
							input.foregroundControl.tokens = current?.tokens;
							input.foregroundControl.toolCount = current?.toolCount;
							input.foregroundControl.updatedAt = Date.now();
						}
						if (stepResults.length > 0) input.liveResults[index] = stepResults[0];
						if (stepProgress.length > 0) input.liveProgress[index] = stepProgress[0];
						const mergedResults = input.liveResults.filter((result): result is SingleResult => result !== undefined);
						const mergedProgress = input.liveProgress.filter((progress): progress is AgentProgress => progress !== undefined);
						input.onUpdate?.({
							content: progressUpdate.content,
							details: {
								mode: "parallel",
								results: mergedResults,
								progress: mergedProgress,
								controlEvents: progressUpdate.details?.controlEvents,
								totalSteps: input.tasks.length,
							},
						});
					}
				: undefined,
		}).finally(() => {
			unregisterTimeoutExtension?.();
			activeChildren.delete(index);
			if (input.foregroundControl?.currentIndex === index) {
				const next = activeChildren.entries().next().value as [number, { agent: string }] | undefined;
				input.foregroundControl.currentIndex = next?.[0];
				input.foregroundControl.currentAgent = next?.[1].agent;
				input.foregroundControl.updatedAt = Date.now();
			}
			if (input.foregroundControl && activeChildren.size === 0) input.foregroundControl.interrupt = undefined;
		});
	});
}

export async function runParallelPath(data: ExecutionContextData, deps: ExecutorDeps): Promise<SubagentExecutionResult> {
	const {
		params,
		effectiveCwd,
		agents,
		ctx,
		signal,
		runId,
		sessionDirForIndex,
		sessionFileForIndex,
		shareEnabled,
		artifactsEnabled,
		artifactsDir,
		backgroundRequestedWhileClarifying,
		onUpdate,
		sessionRoot,
		controlConfig,
	} = data;
	const onControlEvent = createForegroundControlNotifier(data, deps);
	const childIntercomTarget = (id: string, agent: string, index: number) => resolveSubagentIntercomTarget(id, agent, index);
	const allProgress: AgentProgress[] = [];
	const allArtifactPaths: ArtifactPaths[] = [];
	const tasks = params.tasks!;
	const maxParallelTasks = resolveTopLevelParallelMaxTasks(deps.config.parallel?.maxTasks);
	const parallelConcurrency = resolveTopLevelParallelConcurrency(params.concurrency, deps.config.parallel?.concurrency);

	if (tasks.length > maxParallelTasks)
		return {
			content: [{ type: "text", text: maxParallelTasksMessage(maxParallelTasks) }],
			isError: true,
			details: { mode: "parallel" as const, results: [] },
		};

	const agentConfigs: AgentConfig[] = [];
	for (const t of tasks) {
		const config = agents.find((a) => a.name === t.agent);
		if (!config) {
			return {
				content: [{ type: "text", text: `Unknown agent: ${t.agent}` }],
				isError: true,
				details: { mode: "parallel" as const, results: [] },
			};
		}
		agentConfigs.push(config);
	}

	const currentMaxSubagentDepth = resolveCurrentMaxSubagentDepth(deps.config.maxSubagentDepth);
	const maxSubagentDepths = agentConfigs.map((config) =>
		resolveChildMaxSubagentDepth(currentMaxSubagentDepth, config.maxSubagentDepth),
	);

	if (params.worktree) {
		const worktreeTaskCwdError = buildParallelWorktreeTaskCwdError(tasks, effectiveCwd);
		if (worktreeTaskCwdError) return buildParallelModeError(worktreeTaskCwdError);
	}

	const currentProvider = ctx.model?.provider;
	const availableModels: ModelInfo[] = ctx.modelRegistry.getAvailable().map(toModelInfo);
	let taskTexts = tasks.map((t) => t.task);
	const skillOverrides: (string[] | false | undefined)[] = tasks.map((t) =>
		normalizeSkillInput(t.skill),
	);
	const outputUsesAgentDefault = tasks.map((task) => usesAgentDefaultOutput(task.output));
	const behaviorOverrides: StepOverrides[] = tasks.map((task, index) => ({
		...(task.output !== undefined ? { output: task.output === true ? agentConfigs[index]?.output ?? false : task.output } : {}),
		...(task.outputMode !== undefined ? { outputMode: task.outputMode } : {}),
		...(task.reads !== undefined && task.reads !== true ? { reads: task.reads } : {}),
		...(task.progress !== undefined ? { progress: task.progress } : {}),
		...(skillOverrides[index] !== undefined ? { skills: skillOverrides[index] } : {}),
		...(task.model ? { model: task.model } : {}),
	}));
	const modelOverrides: (string | undefined)[] = tasks.map((_, i) =>
		resolveModelCandidate(behaviorOverrides[i]?.model ?? agentConfigs[i]?.model, availableModels, currentProvider),
	);

	if (params.clarify === true && ctx.hasUI) {
		const behaviors = agentConfigs.map((c, i) =>
			resolveStepBehavior(c, behaviorOverrides[i]!),
		);
		const availableSkills = discoverAvailableSkills(effectiveCwd, { projectTrusted: ctx.isProjectTrusted() });

		const result = await ctx.ui.custom<ChainClarifyResult>(
			(tui, theme, _kb, done) =>
				new ChainClarifyComponent(
					tui, theme,
					agentConfigs,
					taskTexts,
					"",
					undefined,
					behaviors,
					availableModels,
					currentProvider,
					availableSkills,
					done,
					"parallel",
				),
			{ overlay: true, overlayOptions: { anchor: "center", width: 84, maxHeight: "80%" } },
		);

		if (!result || !result.confirmed) {
			return { content: [{ type: "text", text: "Cancelled" }], details: { mode: "parallel", results: [] } };
		}

		taskTexts = result.templates;
		for (let i = 0; i < result.behaviorOverrides.length; i++) {
			const override = result.behaviorOverrides[i];
			if (override?.model) {
				modelOverrides[i] = override.model;
				behaviorOverrides[i]!.model = override.model;
			}
			if (override?.output !== undefined) {
				behaviorOverrides[i]!.output = override.output;
				outputUsesAgentDefault[i] = false;
			}
			if (override?.reads !== undefined) behaviorOverrides[i]!.reads = override.reads;
			if (override?.progress !== undefined) behaviorOverrides[i]!.progress = override.progress;
			if (override?.skills !== undefined) {
				skillOverrides[i] = override.skills;
				behaviorOverrides[i]!.skills = override.skills;
			}
		}
		const forkModelPolicyError = validateForkContextModelPolicy({
			tasks: tasks.map((task, index) => ({ agent: task.agent, model: modelOverrides[index] })),
			context: params.context,
		}, agents, (model) => resolveModelCandidate(model, availableModels, currentProvider));
		if (forkModelPolicyError) return buildParallelModeError(forkModelPolicyError);

		if (result.runInBackground) {
			const id = randomUUID();
			const asyncCtx = {
				pi: deps.pi,
				cwd: ctx.cwd,
				currentSessionId: deps.state.currentSessionId!,
				currentModelProvider: ctx.model?.provider,
				projectTrusted: ctx.isProjectTrusted(),
			};
			const parallelTasks = tasks.map((t, i) => {
				const taskText = wrapTaskForAgentContext(taskTexts[i]!, params.context, t.agent, agents);
				const progress = taskDisallowsFileUpdates(taskText) ? false : behaviorOverrides[i]?.progress;
				const output = outputUsesAgentDefault[i]
					? materializeAgentDefaultOutputPath({
						output: resolveStepBehavior(agentConfigs[i]!, behaviorOverrides[i]!).output,
						artifactsDir,
						runId: id,
						agent: t.agent,
						index: i,
					})
					: behaviorOverrides[i]?.output;
				return {
					agent: t.agent,
					task: taskText,
					cwd: t.cwd,
					...(modelOverrides[i] ? { model: modelOverrides[i] } : {}),
					...(skillOverrides[i] !== undefined ? { skill: skillOverrides[i] } : {}),
					...(output !== undefined ? { output } : {}),
					...(behaviorOverrides[i]?.outputMode !== undefined ? { outputMode: behaviorOverrides[i]!.outputMode } : {}),
					...(outputUsesAgentDefault[i] && output !== undefined ? { outputFromAgentDefault: true } : {}),
					...(outputUsesAgentDefault[i] && typeof agentConfigs[i]?.output === "string" ? { defaultOutputSource: agentConfigs[i]!.output } : {}),
					...(t.outputSchema !== undefined ? { outputSchema: t.outputSchema } : {}),
					...(behaviorOverrides[i]?.reads !== undefined ? { reads: behaviorOverrides[i]!.reads } : {}),
					...(progress !== undefined ? { progress } : {}),
					...(t.acceptance !== undefined ? { acceptance: t.acceptance } : {}),
				};
			});
			return executeAsyncChain(id, {
				chain: [{ parallel: parallelTasks, concurrency: parallelConcurrency, worktree: params.worktree }],
				resultMode: "parallel",
				agents,
				ctx: asyncCtx,
				availableModels,
				cwd: effectiveCwd,
				maxOutput: params.maxOutput,
				artifactsDir: artifactsEnabled ? artifactsDir : undefined,
				shareEnabled,
				sessionRoot,
				chainSkills: [],
				sessionFilesByFlatIndex: tasks.map((_, index) => sessionFileForIndex(index)),
				maxSubagentDepth: currentMaxSubagentDepth,
				worktreeSetupHook: deps.config.worktreeSetupHook,
				worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
				controlConfig,
				controlIntercomTarget: data.intercomBridge.orchestratorTarget,
				childIntercomTarget: (agent, index) => resolveSubagentIntercomTarget(id, agent, index),
				projectTrust: resolveConfiguredChildProjectTrustPolicy(deps.config.projectTrust),
			});
		}
	}

	const behaviors = agentConfigs.map((config, index) => {
		const behavior = suppressProgressForReadOnlyTask(resolveStepBehavior(config, behaviorOverrides[index]!), taskTexts[index]);
		if (!outputUsesAgentDefault[index]) return behavior;
		return {
			...behavior,
			output: materializeAgentDefaultOutputPath({
				output: behavior.output,
				artifactsDir,
				runId,
				agent: tasks[index]!.agent,
				index,
			}) ?? false,
		};
	});
	const firstProgressIndex = behaviors.findIndex((behavior) => behavior.progress);
	const liveResults: (SingleResult | undefined)[] = new Array(tasks.length).fill(undefined);
	const liveProgress: (AgentProgress | undefined)[] = new Array(tasks.length).fill(undefined);
	const foregroundControl = deps.state.foregroundControls.get(runId);
	const { setup: worktreeSetup, errorResult } = createParallelWorktreeSetup(
		params.worktree,
		effectiveCwd,
		runId,
		tasks,
		deps.config.worktreeSetupHook,
		deps.config.worktreeSetupHookTimeoutMs,
	);
	if (errorResult) return errorResult;

	let worktreeCleanupDeferred = false;
	try {
		const duplicateOutputError = findDuplicateParallelOutputPath({
			tasks,
			behaviors,
			paramsCwd: effectiveCwd,
			ctxCwd: ctx.cwd,
			worktreeSetup,
		});
		if (duplicateOutputError) return buildParallelModeError(duplicateOutputError);
		for (let index = 0; index < tasks.length; index++) {
			const taskCwd = resolveParallelTaskCwd(tasks[index]!, effectiveCwd, worktreeSetup, index);
			const outputPath = resolveSingleOutputPath(behaviors[index]?.output, ctx.cwd, taskCwd);
			const validationError = validateFileOnlyOutputMode(behaviors[index]?.outputMode, outputPath, `Parallel task ${index + 1} (${tasks[index]!.agent})`);
			if (validationError) return buildParallelModeError(validationError);
		}

		const parallelProgressPrecreated = firstProgressIndex !== -1;
		if (parallelProgressPrecreated) writeInitialProgressFile(effectiveCwd);

		for (let i = 0; i < taskTexts.length; i++) {
			taskTexts[i] = wrapTaskForAgentContext(taskTexts[i]!, params.context, tasks[i]!.agent, agents);
		}

		const timeoutAt = foregroundControl?.timeoutAt ?? (data.foregroundTimeoutMs !== undefined ? Date.now() + data.foregroundTimeoutMs : undefined);
		if (foregroundControl && timeoutAt !== undefined) foregroundControl.timeoutAt = timeoutAt;
		const timeoutExtensionRegistry = data.foregroundTimeoutMs !== undefined && timeoutAt !== undefined
			? createForegroundTimeoutExtensionRegistry(foregroundControl)
			: undefined;
		const detachedCompletions = createDetachedCompletionGroup({
			pi: deps.pi,
			state: deps.state,
			intercomBridge: data.intercomBridge,
			runId,
			mode: "parallel",
			onResultsSettled: (results) => data.onDetachedResultsSettled?.("parallel", results),
			...(worktreeSetup ? {
				finalizeResults: (settledResults: SingleResult[]) => {
					const suffix = buildParallelWorktreeSuffix(worktreeSetup, artifactsDir, tasks);
					const target = settledResults[0];
					if (!suffix || !target) return;
					if (target.truncation?.truncated) target.truncation.text = appendWorktreeSummary(target.truncation.text, suffix);
					else target.finalOutput = appendWorktreeSummary(getSingleResultOutput(target), suffix);
				},
				onSettled: () => cleanupWorktrees(worktreeSetup),
			} : {}),
		});
		const results = await runForegroundParallelTasks({
			tasks,
			taskTexts,
			agents,
			ctx,
			intercomEvents: deps.pi.events,
			signal,
			runId,
			sessionDirForIndex,
			sessionFileForIndex,
			shareEnabled,
			artifactsDir,
			debugArtifactsDir: artifactsEnabled ? artifactsDir : undefined,
			maxOutput: params.maxOutput,
			...(data.foregroundTimeoutMs !== undefined && timeoutAt !== undefined ? { timeoutMs: data.foregroundTimeoutMs, timeoutAt } : {}),
			paramsCwd: effectiveCwd,
			availableModels,
			modelOverrides,
			behaviors,
			outputUsesAgentDefault,
			firstProgressIndex: parallelProgressPrecreated ? -1 : firstProgressIndex,
			controlConfig,
			onControlEvent,
			childIntercomTarget: (agent, index) => childIntercomTarget(runId, agent, index),
			orchestratorIntercomTarget: data.intercomBridge.orchestratorTarget,
			foregroundControl,
			timeoutExtensionRegistry,
			concurrencyLimit: parallelConcurrency,
			maxSubagentDepths,
			liveResults,
			liveProgress,
			onUpdate,
			worktreeSetup,
			projectTrust: resolveConfiguredChildProjectTrustPolicy(deps.config.projectTrust),
			onDetachedComplete: detachedCompletions.onComplete,
		});
		for (let i = 0; i < results.length; i++) {
			const run = results[i]!;
			recordRun(run.agent, taskTexts[i]!, run.exitCode, run.progressSummary?.durationMs ?? 0);
		}

		for (const result of results) {
			if (result.progress) allProgress.push(result.progress);
			if (result.artifactPaths) allArtifactPaths.push(result.artifactPaths);
		}

		const timedOut = results.find((result) => result.timedOut);
		const interrupted = results.find((result) => result.interrupted);
		const details = compactForegroundDetails({
			mode: "parallel",
			runId,
			results,
			progress: params.includeProgress ? allProgress : undefined,
			artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
		});
		rememberForegroundRun(deps.state, { runId, mode: "parallel", cwd: effectiveCwd, results: details.results });
		detachedCompletions.setResults(details.results, foregroundControl?.nestedChildren);
		worktreeCleanupDeferred = Boolean(worktreeSetup && detachedCompletions.hasDetached());
		const worktreeSuffix = worktreeCleanupDeferred ? "" : buildParallelWorktreeSuffix(worktreeSetup, artifactsDir, tasks);
		if (timedOut) {
			return {
				content: [{ type: "text", text: appendWorktreeSummary(`Parallel run timed out (${timedOut.agent}): ${timedOut.error ?? "timeout expired"}`, worktreeSuffix) }],
				details,
				isError: true,
			};
		}
		if (interrupted) {
			return {
				content: [{ type: "text", text: appendWorktreeSummary(`Parallel run paused after interrupt (${interrupted.agent}). Waiting for explicit next action.`, worktreeSuffix) }],
				details,
			};
		}
		const detachedIndex = results.findIndex((result) => result.detached);
		const detached = detachedIndex >= 0 ? results[detachedIndex] : undefined;
		if (detached) {
			const failedSiblings = results.flatMap((result, taskIndex) => !result.detached && result.exitCode !== 0 ? [{
				agent: result.agent,
				taskIndex,
				output: result.truncation?.text || getSingleResultOutput(result),
				exitCode: result.exitCode,
				error: result.error,
			}] : []);
			const failedSummary = failedSiblings.length
				? `\n\nFailed siblings:\n${aggregateParallelOutputs(failedSiblings, (i, agent) => `=== Task ${i + 1}: ${agent} ===`)}`
				: "";
			return {
				content: [{
					type: "text",
					text: appendWorktreeSummary(`${formatDetachedIntercomGuidance({
						headline: `Parallel run detached for intercom coordination (${detached.agent}).`,
						runId,
						result: detached,
						childIndex: detachedIndex,
					})}${failedSummary}`, worktreeSuffix),
				}],
				details,
			};
		}

		if (foregroundControl) updateForegroundNestedProjection(foregroundControl);
		const intercomReceipt = await maybeBuildForegroundIntercomReceipt({
			pi: deps.pi,
			intercomBridge: data.intercomBridge,
			runId,
			mode: "parallel",
			details,
			...(foregroundControl?.nestedChildren?.length ? { nestedChildren: foregroundControl.nestedChildren } : {}),
		});
		if (intercomReceipt) {
			return {
				content: [{ type: "text", text: appendWorktreeSummary(intercomReceipt.text, worktreeSuffix) }],
				details: intercomReceipt.details,
				...(intercomReceipt.status !== "completed" ? { isError: true } : {}),
			};
		}

		const ok = results.filter((result) => result.exitCode === 0).length;
		const downgradeNote = backgroundRequestedWhileClarifying ? " (background requested, but clarify kept this run foreground)" : "";
		const aggregatedOutput = aggregateParallelOutputs(
			results.map((result) => ({
				agent: result.agent,
				output: result.truncation?.text || getSingleResultOutput(result),
				exitCode: result.exitCode,
				error: result.error,
			})),
			(i, agent) => `=== Task ${i + 1}: ${agent} ===`,
		);

		const summary = `${ok}/${results.length} succeeded${downgradeNote}`;
		const fullContent = worktreeSuffix
			? `${summary}\n\n${aggregatedOutput}\n\n${worktreeSuffix}`
			: `${summary}\n\n${aggregatedOutput}`;

		return {
			content: [{ type: "text", text: fullContent }],
			details,
			...(ok !== results.length ? { isError: true } : {}),
		};
	} finally {
		if (worktreeSetup && !worktreeCleanupDeferred) cleanupWorktrees(worktreeSetup);
	}
}

export async function runSinglePath(data: ExecutionContextData, deps: ExecutorDeps): Promise<SubagentExecutionResult> {
	const {
		params,
		effectiveCwd,
		agents,
		ctx,
		signal,
		runId,
		sessionDirForIndex,
		sessionFileForIndex,
		shareEnabled,
		artifactsEnabled,
		artifactsDir,
		onUpdate,
		sessionRoot,
		controlConfig,
	} = data;
	const onControlEvent = createForegroundControlNotifier(data, deps);
	const childIntercomTarget = resolveSubagentIntercomTarget(runId, params.agent!, 0);
	const allProgress: AgentProgress[] = [];
	const allArtifactPaths: ArtifactPaths[] = [];
	const agentConfig = agents.find((a) => a.name === params.agent);
	if (!agentConfig) {
		return {
			content: [{ type: "text", text: `Unknown agent: ${params.agent}` }],
			isError: true,
			details: { mode: "single", results: [] },
		};
	}

	const currentProvider = ctx.model?.provider;
	const availableModels: ModelInfo[] = ctx.modelRegistry.getAvailable().map(toModelInfo);
	let task = params.task ?? "";
	let modelOverride: string | undefined = resolveModelCandidate(
		(params.model as string | undefined) ?? agentConfig.model,
		availableModels,
		currentProvider,
	);
	let skillOverride: string[] | false | undefined = normalizeSkillInput(params.skill);
	const rawOutput = params.output !== undefined ? params.output : agentConfig.output;
	let outputUsesAgentDefault = usesAgentDefaultOutput(params.output);
	let effectiveOutput = normalizeSingleOutputOverride(rawOutput, agentConfig.output);
	const effectiveOutputMode = params.outputMode ?? "inline";
	const currentMaxSubagentDepth = resolveCurrentMaxSubagentDepth(deps.config.maxSubagentDepth);
	const maxSubagentDepth = resolveChildMaxSubagentDepth(currentMaxSubagentDepth, agentConfig.maxSubagentDepth);

	if (params.clarify === true && ctx.hasUI) {
		const behavior = resolveStepBehavior(agentConfig, { output: effectiveOutput, skills: skillOverride });
		const availableSkills = discoverAvailableSkills(effectiveCwd, { projectTrusted: ctx.isProjectTrusted() });

		const result = await ctx.ui.custom<ChainClarifyResult>(
			(tui, theme, _kb, done) =>
				new ChainClarifyComponent(
					tui, theme,
					[agentConfig],
					[task],
					task,
					undefined,
					[behavior],
					availableModels,
					currentProvider,
					availableSkills,
					done,
					"single",
				),
			{ overlay: true, overlayOptions: { anchor: "center", width: 84, maxHeight: "80%" } },
		);

		if (!result || !result.confirmed) {
			return { content: [{ type: "text", text: "Cancelled" }], details: { mode: "single", results: [] } };
		}

		task = result.templates[0]!;
		const override = result.behaviorOverrides[0];
		if (override?.model) modelOverride = override.model;
		if (override?.output !== undefined) {
			effectiveOutput = normalizeSingleOutputOverride(override.output, agentConfig.output);
			outputUsesAgentDefault = false;
		}
		if (override?.skills !== undefined) skillOverride = override.skills;
		const forkModelPolicyError = validateForkContextModelPolicy({
			agent: params.agent,
			model: modelOverride,
			context: params.context,
		}, agents, (model) => resolveModelCandidate(model, availableModels, currentProvider));
		if (forkModelPolicyError) return buildRequestedModeError(params, forkModelPolicyError);

		if (result.runInBackground) {
			const id = randomUUID();
			const output = outputUsesAgentDefault
				? materializeAgentDefaultOutputPath({ output: effectiveOutput, artifactsDir, runId: id, agent: params.agent!, index: 0 })
				: effectiveOutput;
			const asyncCtx = {
				pi: deps.pi,
				cwd: ctx.cwd,
				currentSessionId: deps.state.currentSessionId!,
				currentModelProvider: ctx.model?.provider,
				projectTrusted: ctx.isProjectTrusted(),
			};
			return executeAsyncSingle(id, {
				agent: params.agent!,
				task: wrapTaskForAgentContext(task, params.context, params.agent, agents),
				agentConfig,
				ctx: asyncCtx,
				availableModels,
				cwd: effectiveCwd,
				maxOutput: params.maxOutput,
				artifactsDir: artifactsEnabled ? artifactsDir : undefined,
				shareEnabled,
				sessionRoot,
				sessionFile: sessionFileForIndex(0),
				skills: skillOverride === false ? [] : skillOverride,
				output,
				outputMode: effectiveOutputMode,
				outputSchema: params.outputSchema,
				modelOverride,
				maxSubagentDepth,
				worktreeSetupHook: deps.config.worktreeSetupHook,
				worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
				controlConfig,
				controlIntercomTarget: data.intercomBridge.orchestratorTarget,
				childIntercomTarget: (agent, index) => resolveSubagentIntercomTarget(id, agent, index),
				progress: params.progress,
				projectTrust: resolveConfiguredChildProjectTrustPolicy(deps.config.projectTrust),
			});
		}
	}

	if (params.progress) {
		writeInitialProgressFile(effectiveCwd);
		task += buildChainInstructions({ output: false, outputMode: "inline", reads: false, progress: true, skills: false }, effectiveCwd, true).suffix;
	}
	task = wrapTaskForAgentContext(task, params.context, params.agent, agents);
	const cleanTask = task;
	const runOutput = outputUsesAgentDefault
		? materializeAgentDefaultOutputPath({ output: effectiveOutput, artifactsDir, runId, agent: params.agent!, index: 0 })
		: effectiveOutput;
	const outputPath = resolveSingleOutputPath(runOutput, ctx.cwd, effectiveCwd);
	const validationError = validateFileOnlyOutputMode(effectiveOutputMode, outputPath, `Single run (${params.agent})`);
	if (validationError) {
		return { content: [{ type: "text", text: validationError }], isError: true, details: { mode: "single", results: [] } };
	}
	task = injectSingleOutputInstruction(task, outputPath);

	let effectiveSkills: string[] | undefined;
	if (skillOverride === false) {
		effectiveSkills = [];
	} else {
		effectiveSkills = skillOverride;
	}
	const interruptController = new AbortController();
	const foregroundControl = deps.state.foregroundControls.get(runId);
	if (foregroundControl) {
		foregroundControl.currentAgent = params.agent;
		foregroundControl.currentIndex = 0;
		foregroundControl.currentActivityState = undefined;
		foregroundControl.updatedAt = Date.now();
		foregroundControl.activeChildren ??= new Map();
		const interrupt = () => {
			if (interruptController.signal.aborted) return false;
			interruptController.abort();
			foregroundControl.currentActivityState = undefined;
			foregroundControl.updatedAt = Date.now();
			return true;
		};
		foregroundControl.activeChildren.set(0, { agent: params.agent!, interrupt });
		foregroundControl.interrupt = interrupt;
	}

	const forwardSingleUpdate = onUpdate
		? (update: SubagentExecutionResult) => {
			if (foregroundControl) {
				const firstProgress = update.details?.progress?.[0];
				foregroundControl.currentAgent = params.agent;
				foregroundControl.currentIndex = firstProgress?.index ?? 0;
				foregroundControl.currentActivityState = firstProgress?.activityState;
				foregroundControl.lastActivityAt = firstProgress?.lastActivityAt;
				foregroundControl.currentTool = firstProgress?.currentTool;
				foregroundControl.currentToolStartedAt = firstProgress?.currentToolStartedAt;
				foregroundControl.currentPath = firstProgress?.currentPath;
				foregroundControl.turnCount = firstProgress?.turnCount;
				foregroundControl.tokens = firstProgress?.tokens;
				foregroundControl.toolCount = firstProgress?.toolCount;
				foregroundControl.updatedAt = Date.now();
			}
			onUpdate(update);
		}
		: undefined;

	const timeoutAt = foregroundControl?.timeoutAt ?? (data.foregroundTimeoutMs !== undefined ? Date.now() + data.foregroundTimeoutMs : undefined);
	const detachedCompletions = createDetachedCompletionGroup({
		pi: deps.pi,
		state: deps.state,
		intercomBridge: data.intercomBridge,
		runId,
		mode: "single",
		onResultsSettled: (results) => data.onDetachedResultsSettled?.("single", results),
	});
	const r = await runSync(ctx.cwd, agents, params.agent!, task, {
		cwd: effectiveCwd,
		signal,
		interruptSignal: interruptController.signal,
		...(data.foregroundTimeoutMs !== undefined && timeoutAt !== undefined ? { timeoutMs: data.foregroundTimeoutMs, timeoutAt } : {}),
		...(data.foregroundTimeoutMs !== undefined && timeoutAt !== undefined && foregroundControl ? { registerTimeoutExtension: (extend: TimeoutExtensionCallback) => { foregroundControl.extendTimeout = extend; } } : {}),
		allowIntercomDetach: agentConfig.systemPrompt?.includes(INTERCOM_BRIDGE_MARKER) === true,
		onDetachedComplete: (result) => detachedCompletions.onComplete(result, 0),
		intercomEvents: deps.pi.events,
		runId,
		sessionDir: sessionDirForIndex(0),
		sessionFile: sessionFileForIndex(0),
		share: shareEnabled,
		artifactsDir: artifactsEnabled ? artifactsDir : undefined,
		maxOutput: params.maxOutput,
		outputPath,
		outputMode: effectiveOutputMode,
		persistOutputFile: !outputUsesAgentDefault,
		structuredOutput: params.outputSchema
			? createStructuredOutputRuntime(params.outputSchema, path.join(artifactsDir, "structured-output"))
			: undefined,
		maxSubagentDepth,
		maxExecutionTimeMs: agentConfig.maxExecutionTimeMs,
		maxTokens: agentConfig.maxTokens,
		onUpdate: forwardSingleUpdate,
		controlConfig,
		onControlEvent,
		intercomSessionName: childIntercomTarget,
		orchestratorIntercomTarget: data.intercomBridge.orchestratorTarget,
		nestedRoute: foregroundControl?.nestedRoute,
		index: 0,
		modelOverride,
		availableModels,
		preferredModelProvider: currentProvider,
		skills: effectiveSkills,
		acceptance: params.acceptance,
		projectTrust: resolveConfiguredChildProjectTrustPolicy(deps.config.projectTrust),
		projectTrusted: ctx.isProjectTrusted(),
	});
	if (foregroundControl?.currentIndex === 0) {
		foregroundControl.interrupt = undefined;
		foregroundControl.activeChildren?.delete(0);
		foregroundControl.extendTimeout = undefined;
		foregroundControl.currentActivityState = r.progress?.activityState;
		foregroundControl.lastActivityAt = r.progress?.lastActivityAt;
		foregroundControl.currentTool = r.progress?.currentTool;
		foregroundControl.currentToolStartedAt = r.progress?.currentToolStartedAt;
		foregroundControl.currentPath = r.progress?.currentPath;
		foregroundControl.turnCount = r.progress?.turnCount;
		foregroundControl.tokens = r.progress?.tokens;
		foregroundControl.toolCount = r.progress?.toolCount;
		foregroundControl.updatedAt = Date.now();
	}
	recordRun(params.agent!, cleanTask, r.exitCode, r.progressSummary?.durationMs ?? 0);

	if (r.progress) allProgress.push(r.progress);
	if (r.artifactPaths) allArtifactPaths.push(r.artifactPaths);

	const fullOutput = getSingleResultOutput(r);
	const finalizedOutput = finalizeSingleOutput({
		fullOutput,
		truncatedOutput: r.truncation?.text,
		outputPath,
		outputMode: r.outputMode,
		exitCode: r.exitCode,
		savedPath: r.savedOutputPath,
		outputReference: r.outputReference,
		saveError: r.outputSaveError,
	});
	const details = compactForegroundDetails({
		mode: "single",
		runId,
		results: [r],
		progress: params.includeProgress ? allProgress : undefined,
		artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
		truncation: r.truncation,
	});
	rememberForegroundRun(deps.state, { runId, mode: "single", cwd: effectiveCwd, results: details.results });
	detachedCompletions.setResults(details.results, foregroundControl?.nestedChildren);

	if (!r.detached && !r.interrupted && !r.timedOut) {
		if (foregroundControl) updateForegroundNestedProjection(foregroundControl);
		const intercomReceipt = await maybeBuildForegroundIntercomReceipt({
			pi: deps.pi,
			intercomBridge: data.intercomBridge,
			runId,
			mode: "single",
			details,
			...(foregroundControl?.nestedChildren?.length ? { nestedChildren: foregroundControl.nestedChildren } : {}),
		});
		if (intercomReceipt) {
			return {
				content: [{ type: "text", text: intercomReceipt.text }],
				details: intercomReceipt.details,
				...(r.exitCode !== 0 ? { isError: true } : {}),
			};
		}
	}

	if (r.detached) {
		return {
			content: [{
				type: "text",
				text: formatDetachedIntercomGuidance({
					headline: `Detached for intercom coordination: ${params.agent}.`,
					runId,
					result: r,
					childIndex: 0,
				}),
			}],
			details,
		};
	}

	if (r.timedOut) {
		const timeoutText = r.finalOutput && r.finalOutput !== r.error
			? `Run timed out (${params.agent}).\n${r.finalOutput}`
			: `Run timed out (${params.agent}): ${r.error ?? "timeout expired"}`;
		const resumeText = r.sessionFile ? `\n\nResume without losing session context: subagent({ action: "resume", id: "${runId}", message: "Continue from the timeout and finish the task." })` : "";
		return {
			content: [{ type: "text", text: `${timeoutText}${resumeText}` }],
			details,
			isError: true,
		};
	}

	if (r.interrupted) {
		return {
			content: [{ type: "text", text: `Run paused after interrupt (${params.agent}). Waiting for explicit next action.` }],
			details,
		};
	}

	if (r.exitCode !== 0) {
		const resumeText = r.sessionFile ? `\n\nIf this was transient, resume without losing session context: subagent({ action: "resume", id: "${runId}", message: "Continue from the failure and finish the task." })` : "";
		return {
			content: [{ type: "text", text: `${r.error || "Failed"}${resumeText}` }],
			details,
			isError: true,
		};
	}
	return {
		content: [{ type: "text", text: finalizedOutput.displayOutput || "(no output)" }],
		details,
	};
}
