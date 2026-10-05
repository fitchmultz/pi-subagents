import {
  createChainDir,
  isParallelStep,
  isDynamicParallelStep,
  resolveChainTemplates,
} from "../../shared/settings.ts";
import { resolveChildCwd } from "../../shared/utils.ts";
import { buildWorkflowGraphSnapshot } from "../shared/workflow-graph.ts";
import {
  ChainOutputValidationError,
  validateChainOutputBindings,
} from "../shared/chain-outputs.ts";
import type {
  ChainStep,
  AsyncParallelGroupStatus,
  RunnerStep,
  SubagentRunMode,
} from "../../shared/types.ts";
import { AsyncChainPlanner } from "./async-chain-plan.ts";
import { planAsyncSingle } from "./async-single-plan.ts";
import {
  AsyncStartValidationError,
  UnavailableSubagentSkillError,
  type AsyncChainParams,
  type AsyncSingleParams,
  type AsyncExecutionResult,
} from "./async-plan.ts";
import {
  prepareAsyncOwner,
  createRunnerLaunch,
  launchAsyncRun,
  launchErrorMessage,
  formatAsyncStartError,
  type AsyncRunOverview,
} from "./async-launch.ts";
export { formatAsyncStartedMessage } from "./async-launch.ts";

function firstTask(step: ChainStep): string | undefined {
  if (isParallelStep(step)) {
    return step.parallel.at(0)?.task;
  }
  if (isDynamicParallelStep(step)) {
    return step.parallel.task;
  }
  return step.task;
}

function stepAgents(step: ChainStep): readonly string[] {
  if (isParallelStep(step)) {
    return step.parallel.map((task) => task.agent);
  }
  if (isDynamicParallelStep(step)) {
    return [step.parallel.agent];
  }
  return [step.agent];
}

function chainDescription(step: ChainStep): string {
  if (isParallelStep(step)) {
    return `[${step.parallel.map((task) => task.agent).join("+")}]`;
  }
  if (isDynamicParallelStep(step)) {
    return `expand:${step.parallel.agent}`;
  }
  return step.agent;
}

function validateChain(params: AsyncChainParams): void {
  if (params.chain.length === 0) {
    throw new AsyncStartValidationError("An async chain requires at least one step.");
  }
  validateChainOutputBindings(params.chain, { maxItems: params.dynamicFanoutMaxItems });
  for (const step of params.chain) {
    for (const name of stepAgents(step)) {
      if (!params.agents.some((agent) => agent.name === name)) {
        throw new AsyncStartValidationError(`Unknown agent: ${name}`);
      }
    }
  }
}

function childTargets(
  steps: readonly RunnerStep[],
  resolver: AsyncChainParams["childIntercomTarget"],
): Array<string | undefined> | undefined {
  if (resolver === undefined) {
    return;
  }
  let index = 0;
  return steps.flatMap((step) => {
    if (!("parallel" in step)) {
      return [resolver(step.agent, index++)];
    }
    if ("expand" in step) {
      return [resolver(step.parallel.agent, index++)];
    }
    return step.parallel.map((task) => resolver(task.agent, index++));
  });
}

function chainOverview(
  id: string,
  mode: SubagentRunMode,
  chain: readonly ChainStep[],
): AsyncRunOverview {
  const first = chain.at(0);
  const groups: AsyncParallelGroupStatus[] = [];
  const agents: string[] = [];
  for (const [stepIndex, step] of chain.entries()) {
    const names = stepAgents(step);
    if (isParallelStep(step) || isDynamicParallelStep(step)) {
      groups.push({ start: agents.length, count: names.length, stepIndex });
    }
    agents.push(...names);
  }
  const description = chain.map(chainDescription);
  return {
    headline: `Async ${mode}: ${description.join(" -> ")} [${id}]`,
    agent: first ? stepAgents(first).at(0) : undefined,
    agents,
    task: first ? firstTask(first)?.slice(0, 50) : undefined,
    chain: description,
    chainStepCount: chain.length,
    parallelGroups: groups,
  };
}

/** Validates and plans the workflow before transferring ownership to a detached runner. */
export function executeAsyncChain(id: string, params: AsyncChainParams): AsyncExecutionResult {
  const mode = params.resultMode ?? "chain";
  try {
    validateChain(params);
  } catch (error) {
    if (error instanceof ChainOutputValidationError || error instanceof AsyncStartValidationError) {
      return formatAsyncStartError(mode, error.message);
    }
    throw error;
  }
  const cwd = resolveChildCwd(params.ctx.cwd, params.cwd);
  const chainDir = mode === "chain" ? createChainDir(id, params.chainDir, cwd) : cwd;
  const originalTask = params.task ?? firstTask(params.chain[0]);
  let owner: ReturnType<typeof prepareAsyncOwner>;
  try {
    owner = prepareAsyncOwner(id);
  } catch (error) {
    return formatAsyncStartError(
      mode,
      `Failed to create async run directory: ${launchErrorMessage(error)}`,
    );
  }
  const graph = buildWorkflowGraphSnapshot({ runId: id, mode, steps: params.chain });
  let steps: RunnerStep[];
  try {
    steps = new AsyncChainPlanner(id, params, {
      runnerCwd: cwd,
      chainDir,
      asyncDir: owner.asyncDir,
      originalTask,
      resultMode: mode,
      templates: resolveChainTemplates(params.chain),
    }).build();
  } catch (error) {
    if (
      error instanceof UnavailableSubagentSkillError ||
      error instanceof AsyncStartValidationError
    ) {
      return formatAsyncStartError(mode, error.message);
    }
    throw error;
  }
  const config = createRunnerLaunch(params, owner, {
    steps,
    cwd,
    resultMode: mode,
    chainDir,
    originalTask,
    childIntercomTargets: childTargets(steps, params.childIntercomTarget),
    dynamicFanoutMaxItems: params.dynamicFanoutMaxItems,
    workflowGraph: graph,
  });
  return launchAsyncRun(params.ctx.pi, owner, config, {
    ...chainOverview(id, mode, params.chain),
    nestedRoute: params.nestedRoute,
  });
}

/** Plans one child's output/skill contract and preserves the handed-off pid on notification failure. */
export function executeAsyncSingle(id: string, params: AsyncSingleParams): AsyncExecutionResult {
  const cwd = resolveChildCwd(params.ctx.cwd, params.cwd);
  let owner: ReturnType<typeof prepareAsyncOwner>;
  try {
    owner = prepareAsyncOwner(id);
  } catch (error) {
    return formatAsyncStartError(
      "single",
      `Failed to create async run directory: ${launchErrorMessage(error)}`,
    );
  }
  let step: RunnerStep;
  try {
    step = planAsyncSingle(id, params, { cwd, asyncDir: owner.asyncDir });
  } catch (error) {
    if (
      error instanceof UnavailableSubagentSkillError ||
      error instanceof AsyncStartValidationError
    ) {
      return formatAsyncStartError("single", error.message);
    }
    throw error;
  }
  const config = createRunnerLaunch(params, owner, {
    steps: [step],
    cwd,
    resultMode: "single",
    childIntercomTargets: childTargets([step], params.childIntercomTarget),
  });
  return launchAsyncRun(params.ctx.pi, owner, config, {
    headline: `Async: ${params.agent} [${id}]`,
    agent: params.agent,
    task: (params.task ?? "").slice(0, 50),
    nestedRoute: params.nestedRoute,
  });
}
