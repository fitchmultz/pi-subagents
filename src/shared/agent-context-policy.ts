import type { AgentConfig } from "./types/config.ts";
import type { ReadonlyInput } from "./types/inputs.ts";
import {
  type ChainStep,
  type SequentialStep,
  getStepAgents,
  isDynamicParallelStep,
  isParallelStep,
} from "./settings.ts";
import { createForkContextResolver, resolveSubagentContext } from "./fork-context.ts";
import { wrapForkTask } from "./types.ts";

export type SubagentExecutionContext = "fresh" | "fork";

interface ForkableSessionManager {
  readonly getSessionFile: () => string | undefined;
  readonly getLeafId: () => string | null;
  readonly getSessionDir: () => string;
}

export interface SubagentParamsLikeForContext {
  agent?: string;
  model?: string;
  tasks?: Array<{ agent: string; model?: string }>;
  chain?: ChainStep[];
  context?: SubagentExecutionContext;
}

interface InvocationAgentTarget {
  agent: string;
  model?: string;
}

export function resolveAgentContext(
  explicitContext: unknown,
  agentName: string | undefined,
  agents: readonly AgentConfig[],
): SubagentExecutionContext {
  if (explicitContext !== undefined) {
    return resolveSubagentContext(explicitContext);
  }
  if (agentName === undefined || agentName === "") {
    return "fresh";
  }
  const agent = agents.find((entry) => entry.name === agentName);
  return agent?.defaultContext === "fork" ? "fork" : "fresh";
}

function chainAgentTargets(step: ReadonlyInput<ChainStep>): InvocationAgentTarget[] {
  if (isParallelStep(step)) {
    return step.parallel.map((task) => ({ agent: task.agent, model: task.model }));
  }
  const task = isDynamicParallelStep(step) ? step.parallel : step;
  return [{ agent: task.agent, model: task.model }];
}

function collectInvocationAgentTargets(
  params: ReadonlyInput<SubagentParamsLikeForContext>,
): InvocationAgentTarget[] {
  if (params.tasks !== undefined && params.tasks.length > 0) {
    return params.tasks.map((task) => ({ agent: task.agent, model: task.model }));
  }
  if (params.chain !== undefined && params.chain.length > 0) {
    return params.chain.flatMap(chainAgentTargets);
  }
  return params.agent !== undefined && params.agent !== ""
    ? [{ agent: params.agent, model: params.model }]
    : [];
}

export function validateForkContextModelPolicy(
  params: ReadonlyInput<SubagentParamsLikeForContext>,
  agents: readonly AgentConfig[],
  resolveModel?: (model: string) => string | undefined,
): string | undefined {
  for (const target of collectInvocationAgentTargets(params)) {
    const agent = agents.find((entry) => entry.name === target.agent);
    if (!agent || resolveAgentContext(params.context, target.agent, agents) !== "fork") {
      continue;
    }
    const anthropicModel = (
      target.model !== undefined && target.model !== ""
        ? [target.model]
        : [agent.model, ...(agent.fallbackModels ?? [])]
    )
      .filter((model): model is string => Boolean(model?.trim()))
      .map((model) => resolveModel?.(model) ?? model)
      .find((model) => model.trim().toLowerCase().startsWith("anthropic/"));
    if (anthropicModel !== undefined && anthropicModel !== "") {
      return `Fork context cannot be used with anthropic/* models. Agent '${target.agent}' has effective model candidate '${anthropicModel}'. Use context: "fresh" or a non-Anthropic model; this restriction cannot be overridden.`;
    }
  }
  return undefined;
}

export function invocationUsesForkContext(
  explicitContext: unknown,
  agentNames: readonly string[],
  agents: readonly AgentConfig[],
): boolean {
  if (explicitContext !== undefined) {
    return resolveSubagentContext(explicitContext) === "fork";
  }
  return agentNames.some((name) => resolveAgentContext(undefined, name, agents) === "fork");
}

export function buildFlatAgentNameResolver(
  params: ReadonlyInput<SubagentParamsLikeForContext>,
): (index: number) => string | undefined {
  if ((params.tasks?.length ?? 0) > 0 || (params.chain?.length ?? 0) > 0) {
    const names = collectInvocationAgentTargets(params).map((target) => target.agent);
    return (index) => names[index];
  }
  return () => (params.agent === "" ? undefined : params.agent);
}

export function wrapTaskForAgentContext(
  task: string,
  explicitContext: unknown,
  agentName: string | undefined,
  agents: readonly AgentConfig[],
): string {
  return resolveAgentContext(explicitContext, agentName, agents) === "fork"
    ? wrapForkTask(task)
    : task;
}

export function wrapChainTasksForAgentContext(
  chain: readonly ReadonlyInput<ChainStep>[],
  explicitContext: unknown,
  agents: readonly AgentConfig[],
): ReadonlyInput<ChainStep>[] {
  return chain.map((step, stepIndex) => {
    if (isParallelStep(step)) {
      return {
        ...step,
        parallel: step.parallel.map((task) => ({
          ...task,
          task: wrapTaskForAgentContext(
            task.task ?? "{previous}",
            explicitContext,
            task.agent,
            agents,
          ),
        })),
      };
    }
    if (isDynamicParallelStep(step)) {
      return {
        ...step,
        parallel: {
          ...step.parallel,
          task: wrapTaskForAgentContext(
            step.parallel.task ?? "{previous}",
            explicitContext,
            step.parallel.agent,
            agents,
          ),
        },
      };
    }
    const sequential: ReadonlyInput<SequentialStep> = step;
    const agentName = getStepAgents(step)[0];
    return {
      ...sequential,
      task: wrapTaskForAgentContext(
        sequential.task ?? (stepIndex === 0 ? "{task}" : "{previous}"),
        explicitContext,
        agentName,
        agents,
      ),
    };
  });
}

export function createPerAgentForkContextResolver(
  sessionManager: ForkableSessionManager,
  resolveContextForIndex: (index?: number) => SubagentExecutionContext,
  options: {
    readonly resolveContextForAgentIndex?: (
      agentName: string | undefined,
      index?: number,
    ) => SubagentExecutionContext;
  } = {},
): {
  readonly sessionFileForIndex: (index?: number) => string | undefined;
  readonly sessionFileForAgentIndex: (
    agentName: string | undefined,
    index?: number,
  ) => string | undefined;
} {
  let forkResolver: ReturnType<typeof createForkContextResolver> | undefined;
  const sessionFileForContext = (
    context: SubagentExecutionContext,
    index = 0,
  ): string | undefined => {
    if (context !== "fork") {
      return undefined;
    }
    if (!forkResolver) {
      forkResolver = createForkContextResolver(sessionManager, "fork");
    }
    return forkResolver.sessionFileForIndex(index);
  };
  return {
    sessionFileForIndex(index = 0): string | undefined {
      return sessionFileForContext(resolveContextForIndex(index), index);
    },
    sessionFileForAgentIndex(agentName, index = 0): string | undefined {
      const context =
        options.resolveContextForAgentIndex?.(agentName, index) ?? resolveContextForIndex(index);
      return sessionFileForContext(context, index);
    },
  };
}
