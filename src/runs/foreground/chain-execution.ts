/**
 * Chain execution logic for subagent tool
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../../agents/agents.ts";
import { ChainClarifyComponent, type ChainClarifyResult, type BehaviorOverride } from "./chain-clarify.ts";
import { toModelInfo, type ModelInfo } from "../../shared/model-info.ts";
import {
	resolveChainTemplates,
	createChainDir,
	removeChainDir,
	resolveStepBehavior,
	resolveParallelBehaviors,
	buildChainInstructions,
	writeInitialProgressFile,
	createParallelDirs,
	suppressProgressForReadOnlyTask,
	isDynamicParallelStep,
	isParallelStep,
	type StepOverrides,
	type ChainStep,
	type ParallelStep,
	type SequentialStep,
	type ResolvedStepBehavior,
	type ResolvedTemplates,
} from "../../shared/settings.ts";
import { discoverAvailableSkills, normalizeSkillInput } from "../../agents/skills.ts";
import { validateForkContextModelPolicy, type SubagentExecutionContext } from "../../shared/agent-context-policy.ts";
import { INTERCOM_BRIDGE_MARKER } from "../../intercom/intercom-bridge.ts";
import { runSync } from "./execution.ts";
import { createForegroundTimeoutExtensionRegistry, type ForegroundTimeoutExtensionRegistry } from "./timeout-extension.ts";
import { buildChainSummary } from "../../shared/formatters.ts";
import { compactForegroundDetails, getSingleResultOutput, resolveChildCwd } from "../../shared/utils.ts";
import { formatDetachedIntercomGuidance } from "../shared/intercom-detach.ts";
import { recordRun } from "../shared/run-history.ts";
import {
	appendWorktreeSummary,
	cleanupWorktrees,
	createWorktrees,
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
	type ForegroundControlState,
	type SubagentExecutionResult,
	type IntercomEventBus,
	type NestedRouteInfo,
	type ResolvedControlConfig,
	type SingleResult,
	type TimeoutExtensionCallback,
	MAX_CONCURRENCY,
	resolveChildMaxSubagentDepth,
} from "../../shared/types.ts";
import { resolveModelCandidate } from "../shared/model-fallback.ts";
import { findDuplicateOutputPath, resolveSingleOutputPath, validateFileOnlyOutputMode } from "../shared/single-output.ts";
import { buildWorkflowGraphSnapshot } from "../shared/workflow-graph.ts";
import { ChainOutputValidationError, renderChainTask, validateChainOutputBindings } from "../shared/chain-outputs.ts";
import { completeWorkflowStep, runParallelTasks } from "../shared/workflow-policy.ts";
import { createStructuredOutputRuntime } from "../shared/structured-output.ts";
import { DynamicFanoutError, materializeDynamicParallelStep, type DynamicMaterializedItem } from "../shared/dynamic-fanout.ts";
import type { ChainOutputMap } from "../../shared/types.ts";

interface ChainExecutionDetailsInput {
	results: SingleResult[];
	includeProgress?: boolean;
	allProgress: AgentProgress[];
	allArtifactPaths: ArtifactPaths[];
	artifactsDir?: string;
	chainAgents: string[];
	chainSteps: ChainStep[];
	totalSteps: number;
	currentStepIndex?: number;
	runId: string;
	outputs?: ChainOutputMap;
	currentFlatIndex?: number;
	dynamicChildren?: Record<number, Array<{ agent: string; label?: string; flatIndex: number; itemKey: string; outputName?: string; structured?: boolean; error?: string }>>;
	dynamicGroupStatuses?: Record<number, { status: "pending" | "running" | "completed" | "failed" | "paused" | "detached" | "timed-out"; error?: string; acceptance?: SingleResult["acceptance"] }>;
}

interface ParallelChainRunInput {
	step: ParallelStep;
	parallelTemplates: string[];
	parallelBehaviors: ResolvedStepBehavior[];
	agents: AgentConfig[];
	stepIndex: number;
	availableModels: ModelInfo[];
	chainDir: string;
	prev: string;
	originalTask: string;
	ctx: ExtensionContext;
	intercomEvents?: IntercomEventBus;
	cwd?: string;
	runId: string;
	globalTaskIndex: number;
	sessionTaskIndex: number;
	sessionDirForIndex: (idx?: number) => string | undefined;
	sessionFileForIndex?: (idx?: number) => string | undefined;
	sessionFileForAgentIndex?: (agentName: string | undefined, idx?: number) => string | undefined;
	shareEnabled: boolean;
	timeoutMs?: number;
	timeoutAt?: number;
	artifactsDir?: string;
	signal?: AbortSignal;
	onUpdate?: (r: SubagentExecutionResult) => void;
	onControlEvent?: (event: ControlEvent) => void;
	controlConfig: ResolvedControlConfig;
	childIntercomTarget?: (agent: string, index: number) => string | undefined;
	orchestratorIntercomTarget?: string;
	foregroundControl?: ForegroundControlState;
	timeoutExtensionRegistry?: ForegroundTimeoutExtensionRegistry;
	results: SingleResult[];
	allProgress: AgentProgress[];
	outputs: ChainOutputMap;
	dynamic?: { itemName: string; items: DynamicMaterializedItem[] };
	chainAgents: string[];
	chainSteps: ChainStep[];
	totalSteps: number;
	dynamicChildren?: ChainExecutionDetailsInput["dynamicChildren"];
	dynamicGroupStatuses?: ChainExecutionDetailsInput["dynamicGroupStatuses"];
	worktreeSetup?: WorktreeSetup;
	maxSubagentDepth: number;
	nestedRoute?: NestedRouteInfo;
	projectTrust?: ChildProjectTrustPolicy;
	onDetachedComplete?: (result: SingleResult, index: number) => void;
}

function buildChainExecutionDetails(input: ChainExecutionDetailsInput): Details {
	return compactForegroundDetails({
		mode: "chain",
		results: input.results,
		progress: input.includeProgress ? input.allProgress : undefined,
		artifacts: input.allArtifactPaths.length && input.artifactsDir ? { dir: input.artifactsDir, files: input.allArtifactPaths } : undefined,
		chainAgents: input.chainAgents,
		totalSteps: input.totalSteps,
		currentStepIndex: input.currentStepIndex,
		outputs: input.outputs,
	workflowGraph: buildWorkflowGraphSnapshot({
			runId: input.runId,
			mode: "chain",
			steps: input.chainSteps,
			results: input.results,
			currentStepIndex: input.currentStepIndex,
			currentFlatIndex: input.currentFlatIndex,
			dynamicChildren: input.dynamicChildren,
			dynamicGroupStatuses: input.dynamicGroupStatuses,
		}),
	});
}

function buildChainExecutionErrorResult(message: string, input: ChainExecutionDetailsInput): ChainExecutionResult {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
		details: buildChainExecutionDetails(input),
	};
}

function ensureParallelProgressFile(
	chainDir: string,
	progressCreated: boolean,
	parallelBehaviors: ResolvedStepBehavior[],
): boolean {
	if (progressCreated || !parallelBehaviors.some((behavior) => behavior.progress)) {
		return progressCreated;
	}
	writeInitialProgressFile(chainDir);
	return true;
}

async function runParallelChainTasks(input: ParallelChainRunInput): Promise<SingleResult[]> {
	const duplicateOutputError = findDuplicateOutputPath(input.step.parallel.map((task, index) => ({
		agent: task.agent,
		outputPath: resolveSingleOutputPath(input.parallelBehaviors[index]?.output, input.chainDir),
	})));
	if (duplicateOutputError) {
		return input.step.parallel.map((task) => ({ agent: task.agent, task: task.task ?? "", exitCode: 1, error: duplicateOutputError, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } }));
	}
	const groupInterrupt = new AbortController();
	const graphResults = [...input.results];
	const activeChildren = input.foregroundControl?.activeChildren ?? new Map();
	if (input.foregroundControl) input.foregroundControl.activeChildren = activeChildren;
	const interruptGroup = () => {
		groupInterrupt.abort();
		let interrupted = false;
		for (const child of activeChildren.values()) interrupted = child.interrupt?.() === true || interrupted;
		return interrupted;
	};

	return runParallelTasks({
		tasks: input.step.parallel,
		concurrency: input.step.concurrency ?? MAX_CONCURRENCY,
		failFast: input.step.failFast,
		signal: input.signal,
		interruptSignal: groupInterrupt.signal,
		stoppedTask: (task, _index, reason): SingleResult => ({
			agent: task.agent, task: task.task ?? "(skipped)", exitCode: reason === "interrupted" ? 0 : -1,
			interrupted: reason === "interrupted",
			error: `Skipped due to ${reason}`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		}),
		runTask: async (task, taskIndex, failFastSignal) => {
			const taskTemplate = input.parallelTemplates[taskIndex] ?? "{previous}";
			const behavior = suppressProgressForReadOnlyTask(input.parallelBehaviors[taskIndex]!, taskTemplate, input.originalTask);
			const { prefix, suffix } = buildChainInstructions(
				behavior,
				input.chainDir,
				false,
			);

			const cleanTask = renderChainTask(taskTemplate, {
				originalTask: input.originalTask, previousOutput: input.prev, chainDir: input.chainDir, outputs: input.outputs,
				...(input.dynamic ? { item: { name: input.dynamic.itemName, value: input.dynamic.items[taskIndex]!.item } } : {}),
			});
			const taskStr = prefix + cleanTask + suffix;

			const taskAgentConfig = input.agents.find((agent) => agent.name === task.agent);
			const effectiveModel =
				(task.model ? resolveModelCandidate(task.model, input.availableModels, input.ctx.model?.provider) : null)
				?? resolveModelCandidate(taskAgentConfig?.model, input.availableModels, input.ctx.model?.provider);
			const maxSubagentDepth = resolveChildMaxSubagentDepth(input.maxSubagentDepth, taskAgentConfig?.maxSubagentDepth);

			const taskCwd = input.worktreeSetup
				? input.worktreeSetup.worktrees[taskIndex]!.agentCwd
				: resolveChildCwd(input.cwd ?? input.ctx.cwd, task.cwd);

			const outputPath = typeof behavior.output === "string"
				? (path.isAbsolute(behavior.output) ? behavior.output : path.join(input.chainDir, behavior.output))
				: undefined;
			const interruptController = new AbortController();
			const globalIndex = input.globalTaskIndex + taskIndex;
			if (input.foregroundControl) {
				input.foregroundControl.interrupt = interruptGroup;
				input.foregroundControl.currentAgent = task.agent;
				input.foregroundControl.currentIndex = globalIndex;
				input.foregroundControl.currentActivityState = undefined;
				input.foregroundControl.updatedAt = Date.now();
				activeChildren.set(globalIndex, {
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

			const structuredRuntime = task.outputSchema
				? createStructuredOutputRuntime(task.outputSchema, path.join(input.chainDir, "structured-output"))
				: undefined;
			const timeoutAt = input.foregroundControl?.timeoutAt ?? input.timeoutAt;
			const runIntercomTarget = input.childIntercomTarget?.(task.agent, input.globalTaskIndex + taskIndex);
			let unregisterTimeoutExtension: (() => void) | undefined;
			const cleanupChild = () => {
				unregisterTimeoutExtension?.();
				activeChildren.delete(globalIndex);
				if (input.foregroundControl?.currentIndex === globalIndex) {
					const next = activeChildren.entries().next().value as [number, { agent: string }] | undefined;
					input.foregroundControl.currentIndex = next?.[0];
					input.foregroundControl.currentAgent = next?.[1].agent;
					input.foregroundControl.updatedAt = Date.now();
				}
				if (input.foregroundControl && activeChildren.size === 0) input.foregroundControl.interrupt = undefined;
			};
			const result = await runSync(input.ctx.cwd, input.agents, task.agent, taskStr, {
				cwd: taskCwd,
				signal: input.signal,
				interruptSignal: AbortSignal.any([interruptController.signal, groupInterrupt.signal, failFastSignal]),
				...(input.timeoutMs !== undefined && timeoutAt !== undefined ? { timeoutMs: input.timeoutMs, timeoutAt } : {}),
				...(input.timeoutMs !== undefined && timeoutAt !== undefined && input.timeoutExtensionRegistry ? { registerTimeoutExtension: (extend: TimeoutExtensionCallback) => { unregisterTimeoutExtension = input.timeoutExtensionRegistry?.register(String(input.globalTaskIndex + taskIndex), extend); } } : {}),
				allowIntercomDetach: taskAgentConfig?.systemPrompt?.includes(INTERCOM_BRIDGE_MARKER) === true,
				onDetachedComplete: (result) => input.onDetachedComplete?.(result, globalIndex),
				onRunSettled: cleanupChild,
				intercomEvents: input.intercomEvents,
				runId: input.runId,
				index: input.globalTaskIndex + taskIndex,
				sessionDir: input.sessionDirForIndex(input.sessionTaskIndex + taskIndex),
				sessionFile: input.sessionFileForAgentIndex?.(task.agent, input.sessionTaskIndex + taskIndex) ?? input.sessionFileForIndex?.(input.sessionTaskIndex + taskIndex),
				share: input.shareEnabled,
				artifactsDir: input.artifactsDir,
				outputPath,
				outputMode: behavior.outputMode,
				persistOutputFile: task.output !== undefined,
				maxSubagentDepth,
				maxExecutionTimeMs: taskAgentConfig?.maxExecutionTimeMs,
				maxTokens: taskAgentConfig?.maxTokens,
				controlConfig: input.controlConfig,
				onControlEvent: input.onControlEvent,
				intercomSessionName: runIntercomTarget,
				orchestratorIntercomTarget: runIntercomTarget ? input.orchestratorIntercomTarget : undefined,
				nestedRoute: input.nestedRoute,
				modelOverride: effectiveModel,
				availableModels: input.availableModels,
				preferredModelProvider: input.ctx.model?.provider,
				skills: behavior.skills === false ? [] : behavior.skills,
				structuredOutput: structuredRuntime,
				acceptance: task.acceptance,
				projectTrust: input.projectTrust,
				onUpdate: input.onUpdate
					? (progressUpdate) => {
						const stepResults = progressUpdate.details?.results || [];
						const stepProgress = progressUpdate.details?.progress || [];
						if (stepResults[0]) graphResults[globalIndex] = stepResults[0];
						if (input.foregroundControl && stepProgress.length > 0) {
							const current = stepProgress[0];
							input.foregroundControl.currentAgent = task.agent;
							input.foregroundControl.currentIndex = input.globalTaskIndex + taskIndex;
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
						input.onUpdate?.({
							...progressUpdate,
							details: {
								mode: "chain",
								results: input.results.concat(stepResults),
								progress: input.allProgress.concat(stepProgress),
								controlEvents: progressUpdate.details?.controlEvents,
								chainAgents: input.chainAgents,
								totalSteps: input.totalSteps,
								currentStepIndex: input.stepIndex,
								outputs: input.outputs,
								workflowGraph: buildWorkflowGraphSnapshot({
									runId: input.runId,
									mode: "chain",
									steps: input.chainSteps,
									results: graphResults,
									stepStatuses: graphResults.map((result) => result.progress ?? {}),
									currentStepIndex: input.stepIndex,
									currentFlatIndex: input.globalTaskIndex + taskIndex,
									dynamicChildren: input.dynamicChildren,
									dynamicGroupStatuses: input.dynamicGroupStatuses,
								}),
							},
						});
					}
					: undefined,
			});

			graphResults[globalIndex] = result;
			recordRun(task.agent, cleanTask, result.exitCode, result.progressSummary?.durationMs ?? 0);
			return result;
		},
	});
}

interface ChainExecutionParams {
	chain: ChainStep[];
	task?: string;
	agents: AgentConfig[];
	ctx: ExtensionContext;
	intercomEvents?: IntercomEventBus;
	signal?: AbortSignal;
	runId: string;
	cwd?: string;
	shareEnabled: boolean;
	sessionDirForIndex: (idx?: number) => string | undefined;
	sessionFileForIndex?: (idx?: number) => string | undefined;
	sessionFileForAgentIndex?: (agentName: string | undefined, idx?: number) => string | undefined;
	artifactsDir?: string;
	includeProgress?: boolean;
	clarify?: boolean;
	context?: SubagentExecutionContext;
	onUpdate?: (r: SubagentExecutionResult) => void;
	onControlEvent?: (event: ControlEvent) => void;
	controlConfig: ResolvedControlConfig;
	childIntercomTarget?: (agent: string, index: number) => string | undefined;
	orchestratorIntercomTarget?: string;
	foregroundControl?: ForegroundControlState;
	chainSkills?: string[];
	chainDir?: string;
	dynamicFanoutMaxItems?: number;
	maxSubagentDepth: number;
	nestedRoute?: NestedRouteInfo;
	worktreeSetupHook?: string;
	worktreeSetupHookTimeoutMs?: number;
	timeoutMs?: number;
	projectTrust?: ChildProjectTrustPolicy;
	onDetachedComplete?: (result: SingleResult, index: number) => void;
}

interface ChainExecutionResult {
	content: Array<{ type: "text"; text: string }>;
	details: Details;
	isError?: boolean;
	/** User requested async execution via TUI - caller should dispatch to executeAsyncChain */
	requestedAsync?: {
		chain: ChainStep[];
		chainSkills: string[];
	};
}

/**
 * Execute a chain of subagent steps
 */
export async function executeChain(params: ChainExecutionParams): Promise<ChainExecutionResult> {
	const {
		chain: chainSteps,
		agents,
		ctx,
		signal,
		runId,
		cwd,
		shareEnabled,
		sessionDirForIndex,
		sessionFileForIndex,
		sessionFileForAgentIndex,
		artifactsDir,
		includeProgress,
		clarify,
		context,
		onUpdate,
		onControlEvent,
		controlConfig,
		childIntercomTarget,
		orchestratorIntercomTarget,
		foregroundControl,
		intercomEvents,
		chainSkills: chainSkillsParam,
		chainDir: chainDirBase,
		onDetachedComplete,
	} = params;
	const chainSkills = chainSkillsParam ?? [];

	const results: SingleResult[] = [];
	const outputs: ChainOutputMap = {};
	const dynamicChildren: ChainExecutionDetailsInput["dynamicChildren"] = {};
	const dynamicGroupStatuses: ChainExecutionDetailsInput["dynamicGroupStatuses"] = {};
	const allProgress: AgentProgress[] = [];
	const allArtifactPaths: ArtifactPaths[] = [];
	const worktreeSummaries: string[] = [];
	const appendCapturedWorktreeSummaries = (text: string): string =>
		worktreeSummaries.length > 0 ? `${text}\n\n${worktreeSummaries.join("\n\n")}` : text;

	const chainAgents: string[] = chainSteps.map((step) =>
		isParallelStep(step)
			? `[${step.parallel.map((t) => t.agent).join("+")}]`
			: isDynamicParallelStep(step)
				? `expand:${step.parallel.agent}`
			: (step as SequentialStep).agent,
	);
	const totalSteps = chainSteps.length;

	const makeDetailsInput = (overrides: Pick<Partial<ChainExecutionDetailsInput>, "currentStepIndex" | "currentFlatIndex"> = {}): ChainExecutionDetailsInput => ({
		results,
		...(includeProgress !== undefined ? { includeProgress } : {}),
		allProgress,
		allArtifactPaths,
		artifactsDir,
		chainAgents,
		chainSteps,
		totalSteps,
		runId,
		outputs,
		dynamicChildren,
		dynamicGroupStatuses,
		...overrides,
	});

	const firstStep = chainSteps[0]!;
	const originalTask = params.task
		?? (isParallelStep(firstStep)
			? firstStep.parallel[0]!.task!
			: isDynamicParallelStep(firstStep)
				? firstStep.parallel.task!
				: (firstStep as SequentialStep).task!);
	try {
		validateChainOutputBindings(chainSteps, { maxItems: params.dynamicFanoutMaxItems });
	} catch (error) {
		if (error instanceof ChainOutputValidationError) {
			return {
				content: [{ type: "text", text: error.message }],
				isError: true,
				details: buildChainExecutionDetails(makeDetailsInput()),
			};
		}
		throw error;
	}

	const chainDir = createChainDir(runId, chainDirBase, cwd ?? ctx.cwd);
	const hasParallelSteps = chainSteps.some((step) => isParallelStep(step) || isDynamicParallelStep(step));
	let templates: ResolvedTemplates = resolveChainTemplates(chainSteps);
	const shouldClarify = clarify === true && ctx.hasUI && !hasParallelSteps;
	let tuiBehaviorOverrides: (BehaviorOverride | undefined)[] | undefined;
	const availableModels: ModelInfo[] = ctx.modelRegistry.getAvailable().map(toModelInfo);
	const availableSkills = discoverAvailableSkills(cwd ?? ctx.cwd, { projectTrusted: ctx.isProjectTrusted() });

	if (shouldClarify) {
		const seqSteps = chainSteps as SequentialStep[];
		const agentConfigs: AgentConfig[] = [];
		for (const step of seqSteps) {
			const config = agents.find((a) => a.name === step.agent);
			if (!config) {
				removeChainDir(chainDir);
				return {
					content: [{ type: "text", text: `Unknown agent: ${step.agent}` }],
					isError: true,
					details: buildChainExecutionDetails(makeDetailsInput({ currentStepIndex: seqSteps.indexOf(step) })),
				};
			}
			agentConfigs.push(config);
		}

		const stepOverrides: StepOverrides[] = seqSteps.map((step) => ({
			output: step.output,
			outputMode: step.outputMode,
			reads: step.reads,
			progress: step.progress,
			skills: normalizeSkillInput(step.skill),
			model: step.model,
		}));

		const resolvedBehaviors = agentConfigs.map((config, i) =>
			resolveStepBehavior(config, stepOverrides[i]!, chainSkills),
		);
		const flatTemplates = templates as string[];

		const result = await ctx.ui.custom<ChainClarifyResult>(
			(tui, theme, _kb, done) =>
				new ChainClarifyComponent(
					tui,
					theme,
					agentConfigs,
					flatTemplates,
					originalTask,
					chainDir,
					resolvedBehaviors,
					availableModels,
					ctx.model?.provider,
					availableSkills,
					done,
				),
			{
				overlay: true,
				overlayOptions: { anchor: "center", width: 84, maxHeight: "80%" },
			},
		);

		if (!result || !result.confirmed) {
			removeChainDir(chainDir);
			return {
				content: [{ type: "text", text: "Chain cancelled" }],
				details: buildChainExecutionDetails(makeDetailsInput()),
			};
		}

		const updatedChain: ChainStep[] = chainSteps.map((step, i) => {
			if (isParallelStep(step)) return step;
			const override = result.behaviorOverrides[i];
			return {
				...step,
				task: result.templates[i]!,
				...(override?.model ? { model: override.model } : {}),
				...(override?.output !== undefined ? { output: override.output } : {}),
				...("outputMode" in step && step.outputMode !== undefined ? { outputMode: step.outputMode } : {}),
				...(override?.reads !== undefined ? { reads: override.reads } : {}),
				...(override?.progress !== undefined ? { progress: override.progress } : {}),
				...(override?.skills !== undefined ? { skill: override.skills } : {}),
			};
		});
		const forkModelPolicyError = validateForkContextModelPolicy(
			{ chain: updatedChain, context },
			agents,
			(model) => resolveModelCandidate(model, availableModels, ctx.model?.provider),
		);
		if (forkModelPolicyError) {
			removeChainDir(chainDir);
			return {
				content: [{ type: "text", text: forkModelPolicyError }],
				isError: true,
				details: buildChainExecutionDetails(makeDetailsInput()),
			};
		}

		if (result.runInBackground) {
			removeChainDir(chainDir);
			return {
				content: [{ type: "text", text: "Launching in background..." }],
				details: buildChainExecutionDetails(makeDetailsInput()),
				requestedAsync: { chain: updatedChain, chainSkills },
			};
		}

		templates = result.templates;
		tuiBehaviorOverrides = result.behaviorOverrides;
	}

	const timeoutAt = foregroundControl?.timeoutAt ?? (params.timeoutMs !== undefined ? Date.now() + params.timeoutMs : undefined);
	if (foregroundControl && timeoutAt !== undefined) foregroundControl.timeoutAt = timeoutAt;
	const timeoutExtensionRegistry = params.timeoutMs !== undefined && timeoutAt !== undefined
		? createForegroundTimeoutExtensionRegistry(foregroundControl)
		: undefined;
	let prev = "";
	let globalTaskIndex = 0;
	let nextSessionIndex = 0;
	let progressCreated = false;
	let workflowComplete = false;

	for (let stepIndex = 0; stepIndex < chainSteps.length; stepIndex++) {
		const step = chainSteps[stepIndex]!;
		const stepTemplates = templates[stepIndex]!;
		// Fork sessions reserve maxItems slots; executed child indices do not.
		const sessionTaskIndex = nextSessionIndex;
		nextSessionIndex += isParallelStep(step) ? step.parallel.length
			: isDynamicParallelStep(step) ? step.expand.maxItems ?? params.dynamicFanoutMaxItems ?? 0 : 1;

		if (isParallelStep(step)) {
			const parallelTemplates = stepTemplates as string[];
			const parallelCwd = resolveChildCwd(cwd ?? ctx.cwd, step.cwd);
			let worktreeSetup: WorktreeSetup | undefined;
			let worktreeCleanupDeferred = false;
			let expectedDetachedCompletions: number | undefined;
			let worktreeCleanupScheduled = false;
			const detachedCompletionResults = new Map<number, SingleResult>();
			const finalizeDetachedWorktrees = () => {
				if (!worktreeSetup || worktreeCleanupScheduled || expectedDetachedCompletions === undefined || expectedDetachedCompletions === 0 || detachedCompletionResults.size < expectedDetachedCompletions) return;
				worktreeCleanupScheduled = true;
				const worktreeSummary = formatParallelWorktreeSummary(
					worktreeSetup,
					path.join(chainDir, "worktree-diffs", `step-${stepIndex}`),
					step.parallel.map((task) => task.agent),
				);
				const completions = [...detachedCompletionResults.entries()].sort(([left], [right]) => left - right);
				const first = completions[0]?.[1];
				if (worktreeSummary && first) {
					if (first.truncation?.truncated) first.truncation.text = appendWorktreeSummary(first.truncation.text, worktreeSummary);
					else first.finalOutput = appendWorktreeSummary(getSingleResultOutput(first), worktreeSummary);
				}
				for (const [index, result] of completions) onDetachedComplete?.(result, index);
				queueMicrotask(() => cleanupWorktrees(worktreeSetup!));
			};
			const handleParallelDetachedCompletion = (result: SingleResult, index: number) => {
				if (!worktreeSetup) {
					onDetachedComplete?.(result, index);
					return;
				}
				detachedCompletionResults.set(index, result);
				finalizeDetachedWorktrees();
			};
			if (step.worktree) {
				const worktreeTaskCwdConflict = findWorktreeTaskCwdConflict(step.parallel, parallelCwd);
				if (worktreeTaskCwdConflict) {
					return buildChainExecutionErrorResult(
						`parallel chain step ${stepIndex + 1}: ${formatWorktreeTaskCwdConflict(worktreeTaskCwdConflict, parallelCwd)}`,
						makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: globalTaskIndex }),
					);
				}
				try {
					worktreeSetup = createWorktrees(parallelCwd, `${runId}-s${stepIndex}`, step.parallel.length, {
						agents: step.parallel.map((task) => task.agent),
						setupHook: params.worktreeSetupHook
							? { hookPath: params.worktreeSetupHook, timeoutMs: params.worktreeSetupHookTimeoutMs }
							: undefined,
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return buildChainExecutionErrorResult(message, makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: globalTaskIndex }));
				}
			}

			try {
				const agentNames = step.parallel.map((task) => task.agent);
				const parallelBehaviors = resolveParallelBehaviors(step.parallel, agents, stepIndex, chainSkills)
					.map((behavior, taskIndex) => suppressProgressForReadOnlyTask(behavior, parallelTemplates[taskIndex] ?? step.parallel[taskIndex]?.task, originalTask));
				for (let taskIndex = 0; taskIndex < step.parallel.length; taskIndex++) {
					const behavior = parallelBehaviors[taskIndex]!;
					const outputPath = typeof behavior.output === "string"
						? (path.isAbsolute(behavior.output) ? behavior.output : path.join(chainDir, behavior.output))
						: undefined;
					const validationError = validateFileOnlyOutputMode(behavior.outputMode, outputPath, `Parallel chain step ${stepIndex + 1} task ${taskIndex + 1} (${step.parallel[taskIndex]!.agent})`);
					if (validationError) return buildChainExecutionErrorResult(validationError, makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: globalTaskIndex + taskIndex }));
				}
				progressCreated = ensureParallelProgressFile(chainDir, progressCreated, parallelBehaviors);
				createParallelDirs(chainDir, stepIndex, step.parallel.length, agentNames);

				const parallelResults = await runParallelChainTasks({
					step,
					parallelTemplates,
					parallelBehaviors,
					agents,
					stepIndex,
					availableModels,
					chainDir,
					prev,
					originalTask,
					ctx,
					intercomEvents,
					cwd: parallelCwd,
					runId,
					globalTaskIndex,
					sessionTaskIndex,
					sessionDirForIndex,
					sessionFileForIndex,
					sessionFileForAgentIndex,
					shareEnabled,
					artifactsDir,
					...(params.timeoutMs !== undefined && timeoutAt !== undefined ? { timeoutMs: params.timeoutMs, timeoutAt } : {}),
					signal,
					onUpdate,
					results,
					allProgress,
					outputs,
					chainAgents,
					chainSteps,
					totalSteps,
					dynamicChildren,
					dynamicGroupStatuses,
					controlConfig,
					onControlEvent,
					childIntercomTarget,
					orchestratorIntercomTarget,
					foregroundControl,
					timeoutExtensionRegistry,
					nestedRoute: params.nestedRoute,
					worktreeSetup,
					maxSubagentDepth: params.maxSubagentDepth,
					projectTrust: params.projectTrust,
					onDetachedComplete: handleParallelDetachedCompletion,
				});
				expectedDetachedCompletions = parallelResults.filter((result) => result.detached).length;
				worktreeCleanupDeferred = Boolean(worktreeSetup && expectedDetachedCompletions > 0);
				finalizeDetachedWorktrees();
				globalTaskIndex += step.parallel.length;

				for (const result of parallelResults) {
					results.push(result);
					if (result.progress) allProgress.push(result.progress);
					if (result.artifactPaths) allArtifactPaths.push(result.artifactPaths);
				}
				const worktreeSummary = worktreeCleanupDeferred ? "" : formatParallelWorktreeSummary(
					worktreeSetup,
					path.join(chainDir, "worktree-diffs", `step-${stepIndex}`),
					agentNames,
				);
				const completion = completeWorkflowStep({
					stepIndex, stepCount: totalSteps, previousOutput: prev, parallel: true,
					outputNames: step.parallel.map((task) => task.as),
					results: parallelResults.map((result, index) => {
						const outputTargetPath = resolveSingleOutputPath(parallelBehaviors[index]?.output, chainDir);
						return { ...result, output: getSingleResultOutput(result), outputTargetPath,
							outputTargetExists: outputTargetPath ? fs.existsSync(outputTargetPath) : undefined };
					}),
				});
				Object.assign(outputs, completion.outputs);
				const timedOutIndexInStep = completion.timedOutIndex;
				const timedOut = timedOutIndexInStep >= 0 ? parallelResults[timedOutIndexInStep] : undefined;
				if (timedOut) {
					return {
						content: [{ type: "text", text: appendWorktreeSummary(`Chain timed out at step ${stepIndex + 1} (${timedOut.agent}): ${timedOut.error ?? "timeout expired"}`, worktreeSummary) }],
						isError: true,
						details: buildChainExecutionDetails(makeDetailsInput({
							currentStepIndex: stepIndex,
							currentFlatIndex: globalTaskIndex - step.parallel.length + timedOutIndexInStep,
						})),
					};
				}
				const interruptedIndexInStep = completion.interruptedIndex;
				const interrupted = interruptedIndexInStep >= 0 ? parallelResults[interruptedIndexInStep] : undefined;
				if (interrupted) {
					return {
						content: [{ type: "text", text: appendWorktreeSummary(`Chain paused after interrupt at step ${stepIndex + 1} (${interrupted.agent}). Waiting for explicit next action.`, worktreeSummary) }],
						details: buildChainExecutionDetails(makeDetailsInput({
							currentStepIndex: stepIndex,
							currentFlatIndex: globalTaskIndex - step.parallel.length + interruptedIndexInStep,
						})),
					};
				}
				const detachedIndexInStep = completion.detachedIndex;
				const detached = detachedIndexInStep >= 0 ? parallelResults[detachedIndexInStep] : undefined;
				if (detached) {
					const detachedFlatIndex = globalTaskIndex - step.parallel.length + detachedIndexInStep;
					const failedSummary = completion.failedIndices
						.map((index) => `- Task ${index + 1} (${parallelResults[index]!.agent}): ${parallelResults[index]!.error || "failed"}`)
						.join("\n");
					return {
						content: [{
							type: "text",
							text: appendWorktreeSummary(`${formatDetachedIntercomGuidance({
								headline: `Chain detached for intercom coordination at step ${stepIndex + 1} (${detached.agent}).`,
								runId,
								result: detached,
								childIndex: detachedFlatIndex,
							})}${failedSummary ? `\n\nFailed siblings:\n${failedSummary}` : ""}`, worktreeSummary),
						}],
						details: buildChainExecutionDetails(makeDetailsInput({
							currentStepIndex: stepIndex,
							currentFlatIndex: detachedFlatIndex,
						})),
					};
				}

				const failures = completion.failedIndices.map((originalIndex) => ({ ...parallelResults[originalIndex]!, originalIndex }));
				if (!completion.advance) {
					const failureSummary = failures
						.map((failure) => `- Task ${failure.originalIndex + 1} (${failure.agent}): ${failure.error || "failed"}`)
						.join("\n");
					const errorMsg = `Parallel step ${stepIndex + 1} failed:\n${failureSummary}`;
					const summary = buildChainSummary(chainSteps, results, chainDir, "failed", {
						index: stepIndex,
						error: errorMsg,
					});
					return {
						content: [{ type: "text", text: appendWorktreeSummary(summary, worktreeSummary) }],
						isError: true,
						details: buildChainExecutionDetails(makeDetailsInput({
							currentStepIndex: stepIndex,
							currentFlatIndex: globalTaskIndex - step.parallel.length + failures[0]!.originalIndex,
						})),
					};
				}

				if (worktreeSummary) worktreeSummaries.push(worktreeSummary);

				prev = appendWorktreeSummary(completion.previousOutput, worktreeSummary);
				workflowComplete = completion.complete;
			} finally {
				if (worktreeSetup && !worktreeCleanupDeferred) cleanupWorktrees(worktreeSetup);
			}
		} else if (isDynamicParallelStep(step)) {
			let materialized: ReturnType<typeof materializeDynamicParallelStep>;
			try {
				materialized = materializeDynamicParallelStep(step, outputs, stepIndex, { maxItems: params.dynamicFanoutMaxItems });
			} catch (error) {
				const message = error instanceof DynamicFanoutError ? error.message : error instanceof Error ? error.message : String(error);
				dynamicGroupStatuses[stepIndex] = { status: "failed", error: message };
				return buildChainExecutionErrorResult(message, makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: globalTaskIndex }));
			}

			dynamicChildren[stepIndex] = materialized.items.map((item, itemIndex) => ({
				agent: step.parallel.agent,
				label: materialized.parallel[itemIndex]?.label,
				flatIndex: globalTaskIndex + itemIndex,
				itemKey: item.key,
				structured: Boolean(step.parallel.outputSchema),
			}));

			if (materialized.parallel.length === 0) {
				const completion = completeWorkflowStep({ stepIndex, stepCount: totalSteps, results: [], previousOutput: prev, dynamic: { step, items: materialized.items } });
				dynamicGroupStatuses[stepIndex] = { status: completion.status, error: completion.error };
				if (!completion.advance) return buildChainExecutionErrorResult(completion.error!, makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: globalTaskIndex }));
				Object.assign(outputs, completion.outputs);
				prev = completion.previousOutput;
				workflowComplete = completion.complete;
				continue;
			}

			const dynamicParallelStep: ParallelStep = {
				parallel: materialized.parallel,
				concurrency: step.concurrency,
				failFast: step.failFast,
			};
			const parallelTemplates = materialized.parallel.map(() => step.parallel.task ?? "{previous}");
			const parallelBehaviors = resolveParallelBehaviors(dynamicParallelStep.parallel, agents, stepIndex, chainSkills)
				.map((behavior, taskIndex) => suppressProgressForReadOnlyTask(behavior, parallelTemplates[taskIndex] ?? dynamicParallelStep.parallel[taskIndex]?.task, originalTask));

			for (let taskIndex = 0; taskIndex < dynamicParallelStep.parallel.length; taskIndex++) {
				const behavior = parallelBehaviors[taskIndex]!;
				const outputPath = typeof behavior.output === "string"
					? (path.isAbsolute(behavior.output) ? behavior.output : path.join(chainDir, behavior.output))
					: undefined;
				const validationError = validateFileOnlyOutputMode(behavior.outputMode, outputPath, `Dynamic chain step ${stepIndex + 1} item ${taskIndex + 1} (${dynamicParallelStep.parallel[taskIndex]!.agent})`);
				if (validationError) {
					dynamicGroupStatuses[stepIndex] = { status: "failed", error: validationError };
					return buildChainExecutionErrorResult(validationError, makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: globalTaskIndex + taskIndex }));
				}
			}

			progressCreated = ensureParallelProgressFile(chainDir, progressCreated, parallelBehaviors);
			createParallelDirs(chainDir, stepIndex, dynamicParallelStep.parallel.length, dynamicParallelStep.parallel.map((task) => task.agent));
			const parallelResults = await runParallelChainTasks({
				step: dynamicParallelStep,
				dynamic: { itemName: step.expand.item ?? "item", items: materialized.items },
				parallelTemplates,
				parallelBehaviors,
				agents,
				stepIndex,
				availableModels,
				chainDir,
				prev,
				originalTask,
				ctx,
				intercomEvents,
				cwd,
				runId,
				globalTaskIndex,
				sessionTaskIndex,
				sessionDirForIndex,
				sessionFileForIndex,
				sessionFileForAgentIndex,
				shareEnabled,
				artifactsDir,
				...(params.timeoutMs !== undefined && timeoutAt !== undefined ? { timeoutMs: params.timeoutMs, timeoutAt } : {}),
				signal,
				onUpdate,
				results,
				allProgress,
				outputs,
				chainAgents,
				chainSteps,
				totalSteps,
				dynamicChildren,
				dynamicGroupStatuses,
				controlConfig,
				onControlEvent,
				childIntercomTarget,
				orchestratorIntercomTarget,
				foregroundControl,
				timeoutExtensionRegistry,
				nestedRoute: params.nestedRoute,
				maxSubagentDepth: params.maxSubagentDepth,
				projectTrust: params.projectTrust,
				onDetachedComplete,
			});
			globalTaskIndex += dynamicParallelStep.parallel.length;

			for (const result of parallelResults) {
				results.push(result);
				if (result.progress) allProgress.push(result.progress);
				if (result.artifactPaths) allArtifactPaths.push(result.artifactPaths);
			}
			const completion = completeWorkflowStep({
				stepIndex, stepCount: totalSteps, previousOutput: prev, dynamic: { step, items: materialized.items },
				results: parallelResults.map((result) => ({ ...result, output: getSingleResultOutput(result) })),
			});
			Object.assign(outputs, completion.outputs);
			dynamicGroupStatuses[stepIndex] = { status: completion.status, error: completion.error };
			const timedOutIndexInStep = completion.timedOutIndex;
			const timedOut = timedOutIndexInStep >= 0 ? parallelResults[timedOutIndexInStep] : undefined;
			if (timedOut) {
				dynamicGroupStatuses[stepIndex] = { status: "timed-out", error: timedOut.error };
				return {
					content: [{ type: "text", text: `Chain timed out at step ${stepIndex + 1} (${timedOut.agent}): ${timedOut.error ?? "timeout expired"}` }],
					isError: true,
					details: buildChainExecutionDetails(makeDetailsInput({
						currentStepIndex: stepIndex,
						currentFlatIndex: globalTaskIndex - dynamicParallelStep.parallel.length + timedOutIndexInStep,
					})),
				};
			}
			const interruptedIndexInStep = completion.interruptedIndex;
			const interrupted = interruptedIndexInStep >= 0 ? parallelResults[interruptedIndexInStep] : undefined;
			if (interrupted) {
				return {
					content: [{ type: "text", text: `Chain paused after interrupt at step ${stepIndex + 1} (${interrupted.agent}). Waiting for explicit next action.` }],
					details: buildChainExecutionDetails(makeDetailsInput({
						currentStepIndex: stepIndex,
						currentFlatIndex: globalTaskIndex - dynamicParallelStep.parallel.length + interruptedIndexInStep,
					})),
				};
			}
			const detachedIndexInStep = completion.detachedIndex;
			const detached = detachedIndexInStep >= 0 ? parallelResults[detachedIndexInStep] : undefined;
			if (detached) {
				const detachedFlatIndex = globalTaskIndex - dynamicParallelStep.parallel.length + detachedIndexInStep;
				const failedSummary = completion.failedIndices
					.map((index) => `- Item ${index + 1} (${parallelResults[index]!.agent}, key ${materialized.items[index]?.key ?? index}): ${parallelResults[index]!.error || "failed"}`)
					.join("\n");
				return {
					content: [{
						type: "text",
						text: `${formatDetachedIntercomGuidance({
							headline: `Chain detached for intercom coordination at step ${stepIndex + 1} (${detached.agent}).`,
							runId,
							result: detached,
							childIndex: detachedFlatIndex,
						})}${failedSummary ? `\n\nFailed items:\n${failedSummary}` : ""}`,
					}],
					details: buildChainExecutionDetails(makeDetailsInput({
						currentStepIndex: stepIndex,
						currentFlatIndex: detachedFlatIndex,
					})),
				};
			}
			const failures = completion.failedIndices.map((originalIndex) => ({ ...parallelResults[originalIndex]!, originalIndex }));
			if (failures.length > 0) {
				const failureSummary = failures
					.map((failure) => `- Item ${failure.originalIndex + 1} (${failure.agent}, key ${materialized.items[failure.originalIndex]?.key ?? failure.originalIndex}): ${failure.error || "failed"}`)
					.join("\n");
				const errorMsg = `Dynamic step ${stepIndex + 1} failed:\n${failureSummary}`;
				dynamicGroupStatuses[stepIndex] = { status: "failed", error: errorMsg };
				const summary = buildChainSummary(chainSteps, results, chainDir, "failed", {
					index: stepIndex,
					error: errorMsg,
				});
				return {
					content: [{ type: "text", text: appendCapturedWorktreeSummaries(summary) }],
					isError: true,
					details: buildChainExecutionDetails(makeDetailsInput({
						currentStepIndex: stepIndex,
						currentFlatIndex: globalTaskIndex - dynamicParallelStep.parallel.length + failures[0]!.originalIndex,
					})),
				};
			}
			if (!completion.advance) {
				return buildChainExecutionErrorResult(completion.error!, makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: globalTaskIndex - dynamicParallelStep.parallel.length }));
			}
			prev = completion.previousOutput;
			workflowComplete = completion.complete;
		} else {
			const seqStep = step as SequentialStep;
			const stepTemplate = stepTemplates as string;

			const agentConfig = agents.find((a) => a.name === seqStep.agent);
			if (!agentConfig) {
				removeChainDir(chainDir);
				return {
					content: [{ type: "text", text: `Unknown agent: ${seqStep.agent}` }],
					isError: true,
					details: buildChainExecutionDetails(makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: globalTaskIndex })),
				};
			}

			const tuiOverride = tuiBehaviorOverrides?.[stepIndex];
			const stepOverride: StepOverrides = {
				output: tuiOverride?.output !== undefined ? tuiOverride.output : seqStep.output,
				outputMode: seqStep.outputMode,
				reads: tuiOverride?.reads !== undefined ? tuiOverride.reads : seqStep.reads,
				progress: tuiOverride?.progress !== undefined ? tuiOverride.progress : seqStep.progress,
				skills:
					tuiOverride?.skills !== undefined
						? tuiOverride.skills
						: normalizeSkillInput(seqStep.skill),
			};
			const behavior = suppressProgressForReadOnlyTask(resolveStepBehavior(agentConfig, stepOverride, chainSkills), stepTemplate, originalTask);

			const isFirstProgress = behavior.progress && !progressCreated;
			if (isFirstProgress) {
				progressCreated = true;
			}

			const { prefix, suffix } = buildChainInstructions(
				behavior,
				chainDir,
				isFirstProgress,
			);

			const cleanTask = renderChainTask(stepTemplate, { originalTask, previousOutput: prev, chainDir, outputs });
			const stepTask = prefix + cleanTask + suffix;

			const effectiveModel =
				tuiOverride?.model
				?? (seqStep.model ? resolveModelCandidate(seqStep.model, availableModels, ctx.model?.provider) : null)
				?? resolveModelCandidate(agentConfig.model, availableModels, ctx.model?.provider);

			const outputPath = typeof behavior.output === "string"
				? (path.isAbsolute(behavior.output) ? behavior.output : path.join(chainDir, behavior.output))
				: undefined;
			const validationError = validateFileOnlyOutputMode(behavior.outputMode, outputPath, `Chain step ${stepIndex + 1} (${seqStep.agent})`);
			if (validationError) {
				return buildChainExecutionErrorResult(validationError, makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: globalTaskIndex }));
			}
			const maxSubagentDepth = resolveChildMaxSubagentDepth(params.maxSubagentDepth, agentConfig.maxSubagentDepth);
			const childIndex = globalTaskIndex;
			const interruptController = new AbortController();
			if (foregroundControl) {
				foregroundControl.currentAgent = seqStep.agent;
				foregroundControl.currentIndex = childIndex;
				foregroundControl.currentActivityState = undefined;
				foregroundControl.updatedAt = Date.now();
				foregroundControl.interrupt = () => {
					if (interruptController.signal.aborted) return false;
					interruptController.abort();
					foregroundControl.currentActivityState = undefined;
					foregroundControl.updatedAt = Date.now();
					return true;
				};
			}

			const structuredRuntime = seqStep.outputSchema
				? createStructuredOutputRuntime(seqStep.outputSchema, path.join(chainDir, "structured-output"))
				: undefined;
			const stepTimeoutAt = foregroundControl?.timeoutAt ?? timeoutAt;
			let unregisterTimeoutExtension: (() => void) | undefined;
			const runIntercomTarget = childIntercomTarget?.(seqStep.agent, childIndex);
			const r = await runSync(ctx.cwd, agents, seqStep.agent, stepTask, {
				cwd: resolveChildCwd(cwd ?? ctx.cwd, seqStep.cwd),
				signal,
				interruptSignal: interruptController.signal,
				...(params.timeoutMs !== undefined && stepTimeoutAt !== undefined ? { timeoutMs: params.timeoutMs, timeoutAt: stepTimeoutAt } : {}),
				...(params.timeoutMs !== undefined && stepTimeoutAt !== undefined && timeoutExtensionRegistry ? { registerTimeoutExtension: (extend: TimeoutExtensionCallback) => { unregisterTimeoutExtension = timeoutExtensionRegistry.register(String(childIndex), extend); } } : {}),
				allowIntercomDetach: agentConfig.systemPrompt?.includes(INTERCOM_BRIDGE_MARKER) === true,
				onDetachedComplete: (result) => onDetachedComplete?.(result, childIndex),
				onRunSettled: () => {
					unregisterTimeoutExtension?.();
					if (foregroundControl?.currentIndex === childIndex) {
						foregroundControl.interrupt = undefined;
						foregroundControl.updatedAt = Date.now();
					}
				},
				intercomEvents,
				runId,
				index: childIndex,
				sessionDir: sessionDirForIndex(sessionTaskIndex),
				sessionFile: sessionFileForAgentIndex?.(seqStep.agent, sessionTaskIndex) ?? sessionFileForIndex?.(sessionTaskIndex),
				share: shareEnabled,
				artifactsDir,
				outputPath,
				outputMode: behavior.outputMode,
				persistOutputFile: seqStep.output !== undefined,
				maxSubagentDepth,
				maxExecutionTimeMs: agentConfig.maxExecutionTimeMs,
				maxTokens: agentConfig.maxTokens,
				controlConfig,
				onControlEvent,
				intercomSessionName: runIntercomTarget,
				orchestratorIntercomTarget: runIntercomTarget ? orchestratorIntercomTarget : undefined,
				nestedRoute: params.nestedRoute,
				modelOverride: effectiveModel,
				availableModels,
				preferredModelProvider: ctx.model?.provider,
				skills: behavior.skills === false ? [] : behavior.skills,
				structuredOutput: structuredRuntime,
				acceptance: seqStep.acceptance,
				projectTrust: params.projectTrust,
				onUpdate: onUpdate
					? (p) => {
						const stepResults = p.details?.results || [];
						const stepProgress = p.details?.progress || [];
						if (foregroundControl && stepProgress.length > 0) {
							const current = stepProgress[0];
							foregroundControl.currentAgent = seqStep.agent;
							foregroundControl.currentIndex = childIndex;
							foregroundControl.currentActivityState = current?.activityState;
							foregroundControl.lastActivityAt = current?.lastActivityAt;
							foregroundControl.currentTool = current?.currentTool;
							foregroundControl.currentToolStartedAt = current?.currentToolStartedAt;
							foregroundControl.currentPath = current?.currentPath;
							foregroundControl.turnCount = current?.turnCount;
							foregroundControl.tokens = current?.tokens;
							foregroundControl.toolCount = current?.toolCount;
							foregroundControl.updatedAt = Date.now();
						}
						onUpdate({
							...p,
							details: {
								mode: "chain",
								results: results.concat(stepResults),
								progress: allProgress.concat(stepProgress),
								controlEvents: p.details?.controlEvents,
								chainAgents,
								totalSteps,
								currentStepIndex: stepIndex,
								outputs,
								workflowGraph: buildWorkflowGraphSnapshot({
									runId,
									mode: "chain",
									steps: chainSteps,
									results: results.concat(stepResults),
									currentStepIndex: stepIndex,
									currentFlatIndex: childIndex,
									dynamicChildren,
									dynamicGroupStatuses,
								}),
							},
						});
					}
					: undefined,
			});
			recordRun(seqStep.agent, cleanTask, r.exitCode, r.progressSummary?.durationMs ?? 0);

			globalTaskIndex++;
			results.push(r);
			if (r.progress) allProgress.push(r.progress);
			if (r.artifactPaths) allArtifactPaths.push(r.artifactPaths);

			const completion = completeWorkflowStep({
				stepIndex, stepCount: totalSteps, previousOutput: prev,
				results: [{ ...r, output: getSingleResultOutput(r) }], outputNames: [seqStep.as],
			});
			Object.assign(outputs, completion.outputs);
			if (completion.timedOutIndex >= 0) {
				return {
					content: [{ type: "text", text: appendCapturedWorktreeSummaries(`Chain timed out at step ${stepIndex + 1} (${r.agent}): ${r.error ?? "timeout expired"}`) }],
					isError: true,
					details: buildChainExecutionDetails(makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: globalTaskIndex - 1 })),
				};
			}
			if (completion.interruptedIndex >= 0) {
				return {
					content: [{ type: "text", text: appendCapturedWorktreeSummaries(`Chain paused after interrupt at step ${stepIndex + 1} (${r.agent}). Waiting for explicit next action.`) }],
					details: buildChainExecutionDetails(makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: globalTaskIndex - 1 })),
				};
			}
			if (completion.detachedIndex >= 0) {
				const detachedFlatIndex = globalTaskIndex - 1;
				return {
					content: [{
						type: "text",
						text: appendCapturedWorktreeSummaries(formatDetachedIntercomGuidance({
							headline: `Chain detached for intercom coordination at step ${stepIndex + 1} (${r.agent}).`,
							runId,
							result: r,
							childIndex: detachedFlatIndex,
						})),
					}],
					details: buildChainExecutionDetails(makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: detachedFlatIndex })),
				};
			}

			if (!completion.advance) {
				const summary = buildChainSummary(chainSteps, results, chainDir, "failed", {
					index: stepIndex,
					error: r.error || "Chain failed",
				});
				return {
					content: [{ type: "text", text: appendCapturedWorktreeSummaries(summary) }],
					details: buildChainExecutionDetails(makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: globalTaskIndex - 1 })),
					isError: true,
				};
			}

			if (behavior.output) {
				try {
					const expectedPath = path.isAbsolute(behavior.output)
						? behavior.output
						: path.join(chainDir, behavior.output);
					if (!fs.existsSync(expectedPath)) {
						const dirFiles = fs.readdirSync(chainDir);
						const mdFiles = dirFiles.filter((file) => file.endsWith(".md") && file !== "progress.md");
						const warning = mdFiles.length > 0
							? `Agent wrote to different file(s): ${mdFiles.join(", ")} instead of ${behavior.output}`
							: `Agent did not create expected output file: ${behavior.output}`;
						r.error = r.error ? `${r.error}\n${warning}` : warning;
					}
				} catch {
					// Ignore validation errors; this diagnostic should not mask successful chain output.
				}
			}

			prev = completion.previousOutput;
			workflowComplete = completion.complete;
		}
	}

	const summary = appendCapturedWorktreeSummaries(buildChainSummary(chainSteps, results, chainDir, workflowComplete ? "completed" : "failed"));

	return {
		content: [{ type: "text", text: summary }],
		details: buildChainExecutionDetails(makeDetailsInput()),
		...(!workflowComplete ? { isError: true } : {}),
	};
}
