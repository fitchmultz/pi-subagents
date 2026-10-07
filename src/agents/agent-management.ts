import { discoverAgents, discoverAgentsAll } from "./agents.ts";
import { formatAgentGroups, formatAgentDetail, formatChainDetail } from "./management-format.ts";
import { handleCreate, handleUpdate, handleDelete } from "./management-persistence.ts";
import {
  result,
  normalizeListScope,
  discoveryOptions,
  findEffectiveAgents,
  findChains,
  availableNamesText,
  type ManagementContext,
  type ManagementParams,
} from "./management-targets.ts";
import type { AgentScope } from "../shared/types/config.ts";
import type { SubagentExecutionResult } from "../shared/types.ts";
export { handleCreate, handleUpdate } from "./management-persistence.ts";

export function handleList(
  params: ManagementParams,
  ctx: ManagementContext,
): SubagentExecutionResult {
  const scope = normalizeListScope(params.agentScope);
  if (scope === undefined) {
    return result("agentScope must be 'user', 'project', or 'both'.", true);
  }
  const discovery = discoverAgentsAll(ctx.cwd, discoveryOptions(ctx), scope);
  const agents = discoverAgents(ctx.cwd, scope, discoveryOptions(ctx)).agents.sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const chains = discovery.chains
    .filter((chain) => scope === "both" || chain.source === scope)
    .sort((a, b) => a.name.localeCompare(b.name));
  const diagnostics = [...discovery.agentDiagnostics, ...discovery.chainDiagnostics];
  return result(
    [
      ...formatAgentGroups(agents),
      "",
      "Chains:",
      ...(chains.length > 0
        ? chains.map((chain) => `- ${chain.name} (${chain.source}): ${chain.description}`)
        : ["- (none)"]),
      ...(diagnostics.length > 0
        ? [
            "",
            "Discovery diagnostics:",
            ...diagnostics.map((entry) => `- ${entry.filePath}: ${entry.error}`),
          ]
        : []),
    ].join("\n"),
  );
}
function getBlocks(
  kind: "agent" | "chain",
  name: string,
  ctx: ManagementContext,
  scope: AgentScope,
): { found: boolean; blocks: string[] } {
  const matches =
    kind === "agent" ? findEffectiveAgents(name, ctx, scope) : findChains(name, ctx, scope);
  if (matches.length === 0) {
    return {
      found: false,
      blocks: [
        `${kind === "agent" ? "Agent" : "Chain"} '${name}' not found. Available: ${availableNamesText(ctx, kind, scope)}.`,
      ],
    };
  }
  return {
    found: true,
    blocks: matches.map((match) =>
      "steps" in match ? formatChainDetail(match) : formatAgentDetail(match),
    ),
  };
}
function handleGet(params: ManagementParams, ctx: ManagementContext): SubagentExecutionResult {
  const agent = params.agent ?? "";
  const chain = params.chainName ?? "";
  if (agent.length === 0 && chain.length === 0) {
    return result("Specify 'agent' or 'chainName' for get.", true);
  }
  const scope = normalizeListScope(params.agentScope);
  if (scope === undefined) {
    return result("agentScope must be 'user', 'project', or 'both'.", true);
  }
  const blocks = [
    ...(agent.length > 0 ? [getBlocks("agent", agent, ctx, scope)] : []),
    ...(chain.length > 0 ? [getBlocks("chain", chain, ctx, scope)] : []),
  ];
  return result(
    blocks.flatMap((block) => block.blocks).join("\n\n"),
    !blocks.some((block) => block.found),
  );
}
export function handleManagementAction(
  action: string,
  params: ManagementParams,
  ctx: ManagementContext,
): SubagentExecutionResult {
  if (params.agentScope !== undefined && normalizeListScope(params.agentScope) === undefined) {
    return result("agentScope must be 'user', 'project', or 'both'.", true);
  }
  switch (action) {
    case "list":
      return handleList(params, ctx);
    case "get":
      return handleGet(params, ctx);
    case "create":
      return handleCreate(params, ctx);
    case "update":
      return handleUpdate(params, ctx);
    case "delete":
      return handleDelete(params, ctx);
    default:
      return result(`Unknown action: ${action}`, true);
  }
}
