import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AgentConfig } from "../../agents/agents.ts";
import { ChainClarifyComponent, type ChainClarifyResult } from "./chain-clarify.ts";
import { toModelInfo, type ModelInfo } from "../../shared/model-info.ts";
import { runSync } from "./execution.ts";
import {
	createForegroundTimeoutExtensionRegistry,
	type ForegroundTimeoutExtensionRegistry,
} from "./timeout-extension.ts";
import { resolveModelCandidate } from "../shared/model-fallback.ts";
import { aggregateParallelOutputs } from "../shared/parallel-utils.ts";
import { recordRun } from "../shared/run-history.ts";
import {
	buildChainInstructions,
	writeInitialProgressFile,
	resolveStepBehavior,
	suppressProgressForReadOnlyTask,
	taskDisallowsFileUpdates,
	type StepOverrides,
} from "../../shared/settings.ts";
import { discoverAvailableSkills, normalizeSkillInput } from "../../agents/skills.ts";
import { executeAsyncChain } from "../background/async-execution.ts";
import { resolveConfiguredChildProjectTrustPolicy } from "../shared/pi-args.ts";
import { validateForkContextModelPolicy, wrapTaskForAgentContext } from "../../shared/agent-context-policy.ts";
import { INTERCOM_BRIDGE_MARKER, resolveSubagentIntercomTarget } from "../../intercom/intercom-bridge.ts";
import {
	injectSingleOutputInstruction,
	materializeAgentDefaultOutputPath,
	resolveSingleOutputPath,
	validateFileOnlyOutputMode,
} from "../shared/single-output.ts";
import { createStructuredOutputRuntime } from "../shared/structured-output.ts";
import { formatDetachedIntercomGuidance } from "../shared/intercom-detach.ts";
import { compactForegroundDetails, getSingleResultOutput, mapConcurrent } from "../../shared/utils.ts";
import { updateForegroundNestedProjection } from "../shared/nested-events.ts";
import {
	appendWorktreeSummary,
	cleanupWorktrees,
	createWorktrees,
	formatParallelWorktreeSummary,
	type WorktreeSetup,
} from "../shared/worktree.ts";
import {
	type AgentProgress,
	type ArtifactPaths,
	type ChildProjectTrustPolicy,
	type ControlEvent,
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
	type TaskParam,
	maxParallelTasksMessage,
	usesAgentDefaultOutput,
} from "./subagent-params.ts";
import {
	createDetachedCompletionGroup,
	createForegroundControlNotifier,
	maybeBuildForegroundIntercomReceipt,
	rememberForegroundRun,
} from "./foreground-control.ts";
import {
	buildParallelModeError,
	buildParallelWorktreeTaskCwdError,
	findDuplicateParallelOutputPath,
	resolveParallelTaskCwd,
} from "./execution-input.ts";

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
