import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { ChainClarifyComponent, type ChainClarifyResult } from "./chain-clarify.ts";
import { toModelInfo, type ModelInfo } from "../../shared/model-info.ts";
import { runSync } from "./execution.ts";
import { resolveModelCandidate } from "../shared/model-fallback.ts";
import { recordRun } from "../shared/run-history.ts";
import { buildChainInstructions, writeInitialProgressFile, resolveStepBehavior } from "../../shared/settings.ts";
import { discoverAvailableSkills, normalizeSkillInput } from "../../agents/skills.ts";
import { executeAsyncSingle } from "../background/async-execution.ts";
import { resolveConfiguredChildProjectTrustPolicy } from "../shared/pi-args.ts";
import { validateForkContextModelPolicy, wrapTaskForAgentContext } from "../../shared/agent-context-policy.ts";
import { INTERCOM_BRIDGE_MARKER, resolveSubagentIntercomTarget } from "../../intercom/intercom-bridge.ts";
import {
	finalizeSingleOutput,
	injectSingleOutputInstruction,
	materializeAgentDefaultOutputPath,
	normalizeSingleOutputOverride,
	resolveSingleOutputPath,
	validateFileOnlyOutputMode,
} from "../shared/single-output.ts";
import { createStructuredOutputRuntime } from "../shared/structured-output.ts";
import { formatDetachedIntercomGuidance } from "../shared/intercom-detach.ts";
import { compactForegroundDetails, getSingleResultOutput } from "../../shared/utils.ts";
import { updateForegroundNestedProjection } from "../shared/nested-events.ts";
import {
	type AgentProgress,
	type ArtifactPaths,
	type SubagentExecutionResult,
	type TimeoutExtensionCallback,
	resolveChildMaxSubagentDepth,
	resolveCurrentMaxSubagentDepth,
} from "../../shared/types.ts";
import { type ExecutionContextData, type ExecutorDeps, usesAgentDefaultOutput } from "./subagent-params.ts";
import {
	createDetachedCompletionGroup,
	createForegroundControlNotifier,
	maybeBuildForegroundIntercomReceipt,
	rememberForegroundRun,
} from "./foreground-control.ts";
import { buildRequestedModeError } from "./execution-input.ts";

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
