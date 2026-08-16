import * as path from "node:path";
import { type AgentConfig } from "../../agents/agents.ts";
import { loadRunsForAgent } from "../shared/run-history.ts";
import {
	getStepAgents,
	isParallelStep,
	isDynamicParallelStep,
	type ChainStep,
	type ResolvedStepBehavior,
	type SequentialStep,
} from "../../shared/settings.ts";
import { findDuplicateOutputPath, resolveSingleOutputPath } from "../shared/single-output.ts";
import { resolveChildCwd } from "../../shared/utils.ts";
import { validateAcceptanceInput } from "../shared/acceptance.ts";
import { findWorktreeTaskCwdConflict, formatWorktreeTaskCwdConflict, type WorktreeSetup } from "../shared/worktree.ts";
import { type Details, type SubagentExecutionResult } from "../../shared/types.ts";
import { type SubagentParamsLike, type TaskParam } from "./subagent-params.ts";

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

export function collectChainSessionFiles(
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

export function buildParallelModeError(message: string): SubagentExecutionResult {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
		details: { mode: "parallel" as const, results: [] },
	};
}

export function buildParallelWorktreeTaskCwdError(
	tasks: ReadonlyArray<{ agent: string; cwd?: string }>,
	sharedCwd: string,
): string | undefined {
	const conflict = findWorktreeTaskCwdConflict(tasks, sharedCwd);
	if (!conflict) return undefined;
	return formatWorktreeTaskCwdConflict(conflict, sharedCwd);
}

export function buildChainWorktreeTaskCwdError(chain: ChainStep[], sharedCwd: string): string | undefined {
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

export function resolveParallelTaskCwd(
	task: TaskParam,
	paramsCwd: string,
	worktreeSetup: WorktreeSetup | undefined,
	index: number,
): string {
	if (worktreeSetup) return worktreeSetup.worktrees[index]!.agentCwd;
	return resolveChildCwd(paramsCwd, task.cwd);
}

export function findDuplicateParallelOutputPath(input: {
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

export function findDuplicateAbsoluteParallelOutputPath(input: {
	tasks: TaskParam[];
	behaviors: ResolvedStepBehavior[];
}): string | undefined {
	return findDuplicateOutputPath(input.tasks.map((task, index) => {
		const behavior = input.behaviors[index];
		if (typeof behavior?.output !== "string" || !path.isAbsolute(behavior.output)) return { agent: task.agent };
		return { agent: task.agent, outputPath: path.resolve(behavior.output) };
	}));
}
