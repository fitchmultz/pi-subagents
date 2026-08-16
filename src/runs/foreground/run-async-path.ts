import { randomUUID } from "node:crypto";
import { toModelInfo, type ModelInfo } from "../../shared/model-info.ts";
import { resolveModelCandidate } from "../shared/model-fallback.ts";
import { resolveStepBehavior, type ChainStep } from "../../shared/settings.ts";
import { normalizeSkillInput } from "../../agents/skills.ts";
import { executeAsyncChain, executeAsyncSingle } from "../background/async-execution.ts";
import { resolveConfiguredChildProjectTrustPolicy } from "../shared/pi-args.ts";
import { wrapChainTasksForAgentContext, wrapTaskForAgentContext } from "../../shared/agent-context-policy.ts";
import { resolveSubagentIntercomTarget } from "../../intercom/intercom-bridge.ts";
import {
	type SubagentExecutionResult,
	resolveTopLevelParallelConcurrency,
	resolveTopLevelParallelMaxTasks,
	resolveChildMaxSubagentDepth,
	resolveCurrentMaxSubagentDepth,
} from "../../shared/types.ts";
import {
	type ExecutionContextData,
	type ExecutorDeps,
	maxParallelTasksMessage,
	resolveTopLevelOutputOverride,
	usesAgentDefaultOutput,
} from "./subagent-params.ts";
import {
	buildChainWorktreeTaskCwdError,
	buildParallelModeError,
	buildParallelWorktreeTaskCwdError,
	collectChainSessionFiles,
	findDuplicateAbsoluteParallelOutputPath,
	findDuplicateParallelOutputPath,
} from "./execution-input.ts";

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
