import * as path from "node:path";
import { resolveRootSessionId } from "../../shared/session-identity.ts";
import { toModelInfo } from "../../shared/model-info.ts";
import { resolveStepBehavior } from "../../shared/settings.ts";
import { normalizeSkillInput } from "../../agents/skills.ts";
import { executeAsyncChain, executeAsyncSingle } from "../background/async-execution.ts";
import { resolveConfiguredChildProjectTrustPolicy } from "../shared/pi-args.ts";
import {
  wrapChainTasksForAgentContext,
  wrapTaskForAgentContext,
} from "../../shared/agent-context-policy.ts";
import { resolveSubagentIntercomTarget } from "../../intercom/intercom-bridge.ts";
import {
  type SubagentExecutionResult,
  type AgentConfig,
  type ChainStep,
  type SequentialStep,
  resolveTopLevelParallelConcurrency,
  resolveTopLevelParallelMaxTasks,
  resolveChildMaxSubagentDepth,
  resolveCurrentMaxSubagentDepth,
} from "../../shared/types.ts";
import {
  type ExecutionContextData,
  type ExecutorReadDeps,
  type TaskParam,
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

type AsyncPathDeps = Pick<ExecutorReadDeps, "pi" | "config"> & {
  readonly state: Pick<ExecutorReadDeps["state"], "currentSessionId">;
};

type CommonLaunchOptions = Pick<
  Parameters<typeof executeAsyncChain>[1],
  | "ctx"
  | "availableModels"
  | "cwd"
  | "maxOutput"
  | "timeoutMs"
  | "artifactsDir"
  | "shareEnabled"
  | "sessionRoot"
  | "maxSubagentDepth"
  | "worktreeSetupHook"
  | "worktreeSetupHookTimeoutMs"
  | "controlConfig"
  | "controlIntercomTarget"
  | "childIntercomTarget"
  | "nestedRoute"
  | "projectTrust"
>;

/** Validate mode constraints before constructing or handing off an async launch. */
function validateChainMode(data: ExecutionContextData): SubagentExecutionResult | undefined {
  const { params, effectiveCwd } = data;
  if (params.chain !== undefined && params.chain.length > 0) {
    const error = buildChainWorktreeTaskCwdError(params.chain, effectiveCwd);
    if (error !== undefined && error.length > 0) {
      return {
        content: [{ type: "text", text: error }],
        isError: true,
        details: { mode: "chain", results: [] },
      };
    }
  }
  return undefined;
}

function validateParallelMode(
  data: ExecutionContextData,
  deps: AsyncPathDeps,
): SubagentExecutionResult | undefined {
  const { params, effectiveCwd } = data;
  if (params.tasks !== undefined && params.tasks.length > 0) {
    const maxTasks = resolveTopLevelParallelMaxTasks(deps.config.parallel?.maxTasks);
    if (params.tasks.length > maxTasks) {
      return buildParallelModeError(maxParallelTasksMessage(maxTasks));
    }
    const error =
      params.worktree === true
        ? buildParallelWorktreeTaskCwdError(params.tasks, effectiveCwd)
        : undefined;
    if (error !== undefined && error.length > 0) {
      return buildParallelModeError(error);
    }
  }
  return undefined;
}

function commonLaunchOptions(data: ExecutionContextData, deps: AsyncPathDeps): CommonLaunchOptions {
  const sessionId = deps.state.currentSessionId;
  if (sessionId === null) {
    throw new Error("Cannot launch an async run without an owning session.");
  }
  return {
    ctx: {
      pi: deps.pi,
      cwd: data.ctx.cwd,
      currentSessionId: sessionId,
      rootSessionId: resolveRootSessionId(data.ctx.sessionManager),
      currentModelProvider: data.ctx.model?.provider,
      projectTrusted: data.ctx.isProjectTrusted(),
    },
    availableModels: data.ctx.modelRegistry.getAvailable().map(toModelInfo),
    cwd: data.effectiveCwd,
    maxOutput: data.params.maxOutput,
    timeoutMs: data.foregroundTimeoutMs,
    artifactsDir: data.artifactsEnabled ? data.artifactsDir : undefined,
    shareEnabled: data.shareEnabled,
    sessionRoot: data.sessionRoot,
    maxSubagentDepth: resolveCurrentMaxSubagentDepth(deps.config.maxSubagentDepth),
    worktreeSetupHook: deps.config.worktreeSetupHook,
    worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
    controlConfig: data.controlConfig,
    controlIntercomTarget: data.intercomBridge.orchestratorTarget,
    childIntercomTarget: (agent, index) => resolveSubagentIntercomTarget(data.runId, agent, index),
    nestedRoute: data.nestedRoute,
    projectTrust: resolveConfiguredChildProjectTrustPolicy(deps.config.projectTrust),
  };
}

export function runAsyncPath(
  data: ExecutionContextData,
  deps: AsyncPathDeps,
): SubagentExecutionResult | null {
  const invalid = validateChainMode(data) ?? validateParallelMode(data, deps);
  if (invalid) {
    return invalid;
  }
  const common = commonLaunchOptions(data, deps);
  const { params } = data;
  if (params.tasks !== undefined && params.tasks.length > 0) {
    return launchParallel(data, deps, common, params.tasks);
  }
  if (params.chain !== undefined && params.chain.length > 0) {
    return launchChain(data, deps, common, params.chain);
  }
  if (params.agent !== undefined && params.agent.length > 0) {
    return launchSingle(data, common, params.agent);
  }
  return null;
}

/** Preserve optional-property presence and agent-default output provenance for runner planning. */
function taskOutputOptions(
  task: TaskParam,
  output: ReturnType<typeof resolveTopLevelOutputOverride>,
): Pick<
  SequentialStep,
  | "output"
  | "outputMode"
  | "outputFromAgentDefault"
  | "outputSchema"
  | "reads"
  | "progress"
  | "acceptance"
> {
  return {
    ...(output !== undefined ? { output } : {}),
    ...(task.outputMode !== undefined ? { outputMode: task.outputMode } : {}),
    ...(usesAgentDefaultOutput(task.output) && output !== undefined
      ? { outputFromAgentDefault: true }
      : {}),
    ...(task.outputSchema !== undefined ? { outputSchema: task.outputSchema } : {}),
    ...(task.reads !== undefined && task.reads !== true ? { reads: task.reads } : {}),
    ...(task.progress !== undefined ? { progress: task.progress } : {}),
    ...(task.acceptance !== undefined ? { acceptance: task.acceptance } : {}),
  };
}

function parallelTask(
  data: ExecutionContextData,
  task: TaskParam,
  profile: AgentConfig,
  index: number,
): SequentialStep & { readonly task: string } {
  const output = resolveTopLevelOutputOverride({
    requestedOutput: task.output,
    agentDefaultOutput: profile.output,
    artifactsDir: data.artifactsDir,
    runId: data.runId,
    agent: task.agent,
    index,
  });
  const skill = normalizeSkillInput(task.skill);
  return {
    agent: task.agent,
    task: wrapTaskForAgentContext(task.task, data.params.context, task.agent, data.agents),
    cwd: task.cwd,
    ...(task.model !== undefined && task.model.length > 0 ? { model: task.model } : {}),
    ...(skill !== undefined ? { skill } : {}),
    ...taskOutputOptions(task, output),
  };
}

function launchParallel(
  data: ExecutionContextData,
  deps: AsyncPathDeps,
  common: CommonLaunchOptions,
  tasks: readonly TaskParam[],
): SubagentExecutionResult {
  const planned = tasks.map((task, index) => {
    const profile = data.agents.find((agent) => agent.name === task.agent);
    if (!profile) {
      throw new Error(`Unknown agent: ${task.agent}`);
    }
    const step = parallelTask(data, task, profile, index);
    return {
      step,
      behavior: resolveStepBehavior(profile, {
        ...(step.output !== undefined ? { output: step.output } : {}),
        ...(step.outputMode !== undefined ? { outputMode: step.outputMode } : {}),
      }),
    };
  });
  const parallelTasks = planned.map(({ step }) => step);
  const behaviors = planned.map(({ behavior }) => behavior);
  const duplicate =
    data.params.worktree === true
      ? findDuplicateAbsoluteParallelOutputPath({ tasks: parallelTasks, behaviors })
      : findDuplicateParallelOutputPath({
          tasks: parallelTasks,
          behaviors,
          paramsCwd: data.effectiveCwd,
          ctxCwd: data.ctx.cwd,
        });
  if (duplicate !== undefined && duplicate.length > 0) {
    return buildParallelModeError(duplicate);
  }
  return executeAsyncChain(data.runId, {
    ...common,
    agents: data.agents,
    chain: [
      {
        parallel: parallelTasks,
        concurrency: resolveTopLevelParallelConcurrency(
          data.params.concurrency,
          deps.config.parallel?.concurrency,
        ),
        worktree: data.params.worktree,
      },
    ],
    resultMode: "parallel",
    chainSkills: [],
    sessionFilesByFlatIndex: tasks.map((_, index) => data.sessionFileForIndex(index)),
  });
}

function launchChain(
  data: ExecutionContextData,
  deps: AsyncPathDeps,
  common: CommonLaunchOptions,
  steps: readonly ChainStep[],
): SubagentExecutionResult {
  const chain = wrapChainTasksForAgentContext(steps, data.params.context, data.agents);
  return executeAsyncChain(data.runId, {
    ...common,
    agents: data.agents,
    chain,
    task: data.params.task,
    chainDir: data.params.chainDir,
    chainSkills: normalizeSkillInput(data.params.skill) ?? [],
    sessionFilesByFlatIndex: collectChainSessionFiles(
      chain,
      data.sessionFileForIndex,
      data.sessionFileForAgentIndex,
      deps.config.chain?.dynamicFanout?.maxItems,
    ),
    dynamicFanoutMaxItems: deps.config.chain?.dynamicFanout?.maxItems,
  });
}

function launchSingle(
  data: ExecutionContextData,
  common: CommonLaunchOptions,
  agent: string,
): SubagentExecutionResult {
  const profile = data.agents.find((candidate) => candidate.name === agent);
  if (!profile) {
    return {
      content: [{ type: "text", text: `Unknown agent: ${agent}` }],
      isError: true,
      details: { mode: "single", results: [] },
    };
  }
  const { params } = data;
  return executeAsyncSingle(data.runId, {
    ...common,
    agent,
    agentConfig: profile,
    task: wrapTaskForAgentContext(params.task ?? "", params.context, agent, data.agents),
    sessionFile: data.sessionFileForIndex(0),
    skills: normalizeSkillInput(params.skill),
    output: resolveTopLevelOutputOverride({
      requestedOutput: params.output,
      agentDefaultOutput: profile.output,
      artifactsDir: data.artifactsDir,
      runId: data.runId,
      agent,
      index: 0,
    }),
    outputFromAgentDefault:
      usesAgentDefaultOutput(params.output) &&
      typeof profile.output === "string" &&
      !path.isAbsolute(profile.output),
    outputMode: params.outputMode ?? "inline",
    outputSchema: params.outputSchema,
    modelOverride: params.model,
    maxSubagentDepth: resolveChildMaxSubagentDepth(
      common.maxSubagentDepth,
      profile.maxSubagentDepth,
    ),
    acceptance: params.acceptance,
    progress: params.progress,
  });
}
