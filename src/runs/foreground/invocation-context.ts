import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveExecutionAgentScope } from "../../agents/agent-scope.ts";
import { providerQualifiedModelId, toModelInfo } from "../../shared/model-info.ts";
import { collectInvocationAgentNames } from "../../shared/settings.ts";
import {
  buildFlatAgentNameResolver,
  invocationUsesForkContext,
  resolveAgentContext,
  validateForkContextModelPolicy,
} from "../../shared/agent-context-policy.ts";
import { resolveModelCandidate } from "../shared/model-fallback.ts";
import type { AgentConfig, ModelInfo, SubagentExecutionResult } from "../../shared/types.ts";
import type { ExecutorReadDeps, SubagentParamsLike } from "./subagent-params.ts";
import { toExecutionErrorResult } from "./execution-input.ts";

export interface AgentInvocation {
  readonly agents: readonly AgentConfig[];
  readonly discovered: readonly AgentConfig[];
  readonly context: SubagentParamsLike["context"];
  readonly resolveContextForAgent: (name: string | undefined) => "fresh" | "fork";
  readonly resolveContextForIndex: (index?: number) => "fresh" | "fork";
}
/** Resolve profiles and fork policy without owning journals, session directories, or launch state. */
export function discoverInvocation(
  params: SubagentParamsLike,
  cwd: string,
  ctx: ExtensionContext,
  deps: Readonly<Pick<ExecutorReadDeps, "discoverAgents">>,
): AgentInvocation {
  const inherited = providerQualifiedModelId(ctx.model?.provider, ctx.model?.id);
  const discovered = deps
    .discoverAgents(cwd, resolveExecutionAgentScope(params.agentScope), {
      projectTrusted: ctx.isProjectTrusted(),
    })
    .agents.map((agent) => inheritModel(agent, inherited));
  const context = invocationUsesForkContext(
    params.context,
    collectInvocationAgentNames(params),
    discovered,
  )
    ? "fork"
    : undefined;
  const atIndex = buildFlatAgentNameResolver(params);
  const forAgent = (name: string | undefined) =>
    resolveAgentContext(params.context, name, discovered);
  const agents: AgentConfig[] = [];
  for (const agent of discovered) {
    agents.push({ ...agent, defaultContext: forAgent(agent.name) });
  }
  return {
    agents,
    discovered,
    context,
    resolveContextForAgent: forAgent,
    resolveContextForIndex: (index) => forAgent(atIndex(index ?? 0)),
  };
}
function inheritModel(agent: AgentConfig, model: string | undefined): AgentConfig {
  if (
    (agent.model !== undefined && agent.model.length > 0) ||
    model === undefined ||
    model.length === 0
  ) {
    return agent;
  }
  return { ...agent, model };
}
export function validateInvocationForkModel(
  params: SubagentParamsLike,
  agents: AgentInvocation,
  ctx: ExtensionContext,
): SubagentExecutionResult | undefined {
  if (agents.context !== "fork") {
    return;
  }
  let available: readonly ModelInfo[];
  try {
    available = ctx.modelRegistry.getAvailable().map(toModelInfo);
  } catch (error) {
    return toExecutionErrorResult(params, error, agents.context);
  }
  const invalid = validateForkContextModelPolicy(params, agents.discovered, (model) =>
    resolveModelCandidate(model, available, ctx.model?.provider),
  );
  return invalid !== undefined && invalid.length > 0
    ? toExecutionErrorResult(params, new Error(invalid), agents.context)
    : undefined;
}
