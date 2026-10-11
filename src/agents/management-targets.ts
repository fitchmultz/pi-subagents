import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, ChainConfig, AgentScope } from "../shared/types/config.ts";
import type { SubagentExecutionResult } from "../shared/types.ts";
import { discoverAgents, discoverAgentsAll } from "./agents.ts";
import { sanitizeName } from "./management-config.ts";

export type ManagementScope = "user" | "project";
export interface ManagementContext {
  readonly cwd: string;
  readonly modelRegistry: ExtensionContext["modelRegistry"];
  readonly isProjectTrusted: () => boolean;
}
export interface ManagementParams {
  readonly action?: string;
  readonly agent?: string;
  readonly chainName?: string;
  readonly agentScope?: string;
  readonly config?: unknown;
}
export function result(text: string, isError = false): SubagentExecutionResult {
  return {
    content: [{ type: "text", text }],
    isError,
    details: { mode: "management", results: [] },
  };
}
export function discoveryOptions(ctx: ManagementContext): { projectTrusted: boolean } {
  return { projectTrusted: ctx.isProjectTrusted() };
}
export function asDisambiguationScope(scope: unknown): ManagementScope | undefined {
  return scope === "user" || scope === "project" ? scope : undefined;
}
export function normalizeListScope(scope: unknown): AgentScope | undefined {
  if (scope === undefined) {
    return "both";
  }
  return scope === "user" || scope === "project" || scope === "both" ? scope : undefined;
}
export function mutationRequest(
  params: ManagementParams,
  action: "update" | "delete",
):
  | { readonly kind: "agent" | "chain"; readonly name: string; readonly error?: never }
  | { readonly error: string } {
  const agent = params.agent ?? "";
  const chain = params.chainName ?? "";
  if (agent.length === 0 && chain.length === 0) {
    return { error: `Specify 'agent' or 'chainName' for ${action}.` };
  }
  if (agent.length > 0 && chain.length > 0) {
    return { error: "Specify either 'agent' or 'chainName', not both." };
  }
  return agent.length > 0 ? { kind: "agent", name: agent } : { kind: "chain", name: chain };
}

export function allAgents(discovery: {
  readonly builtin: readonly AgentConfig[];
  readonly package: readonly AgentConfig[];
  readonly user: readonly AgentConfig[];
  readonly project: readonly AgentConfig[];
}): AgentConfig[] {
  return [...discovery.builtin, ...discovery.package, ...discovery.user, ...discovery.project];
}
export function availableNames(
  ctx: ManagementContext,
  kind: "agent" | "chain",
  scope: AgentScope = "both",
): string[] {
  const discovery = discoverAgentsAll(ctx.cwd, discoveryOptions(ctx), scope);
  const items = kind === "agent" ? allAgents(discovery) : discovery.chains;
  return [...new Set(items.map((item) => item.name))].sort((a, b) => a.localeCompare(b));
}
export function availableNamesText(
  ctx: ManagementContext,
  kind: "agent" | "chain",
  scope: AgentScope = "both",
): string {
  const text = availableNames(ctx, kind, scope).join(", ");
  return text.length > 0 ? text : "none";
}

export function findAgents(
  name: string,
  ctx: ManagementContext,
  scope: AgentScope = "both",
): AgentConfig[] {
  const discovery = discoverAgentsAll(ctx.cwd, discoveryOptions(ctx), scope);
  const raw = name.trim();
  const sanitized = sanitizeName(raw);
  return allAgents(discovery)
    .filter(
      (agent) =>
        (scope === "both" || agent.source === scope) &&
        (agent.name === raw || agent.name === sanitized),
    )
    .sort((a, b) => a.source.localeCompare(b.source));
}
export function findChains(
  name: string,
  ctx: ManagementContext,
  scope: AgentScope = "both",
): ChainConfig[] {
  const raw = name.trim();
  const sanitized = sanitizeName(raw);
  return discoverAgentsAll(ctx.cwd, discoveryOptions(ctx), scope)
    .chains.filter(
      (chain) =>
        (scope === "both" || chain.source === scope) &&
        (chain.name === raw || chain.name === sanitized),
    )
    .sort((a, b) => a.source.localeCompare(b.source));
}
export function findEffectiveAgents(
  name: string,
  ctx: ManagementContext,
  scope: AgentScope = "both",
): AgentConfig[] {
  const raw = name.trim();
  const sanitized = sanitizeName(raw);
  return discoverAgents(ctx.cwd, scope, discoveryOptions(ctx)).agents.filter(
    (agent) => agent.name === raw || agent.name === sanitized,
  );
}
export function nameExistsInScope(
  ctx: ManagementContext,
  scope: ManagementScope,
  name: string,
  excludePath?: string,
): boolean {
  const discovery = discoverAgentsAll(ctx.cwd, discoveryOptions(ctx), scope);
  return (
    (scope === "user" ? discovery.user : discovery.project).some(
      (agent) => agent.name === name && agent.filePath !== excludePath,
    ) ||
    discovery.chains.some(
      (chain) => chain.source === scope && chain.name === name && chain.filePath !== excludePath,
    )
  );
}

type Target = AgentConfig | ChainConfig;
type WritableScope<T> = T & { readonly source: ManagementScope };
function isMutableTarget(target: Target): target is WritableScope<Target> {
  return target.source === "user" || target.source === "project";
}
function unresolvedTarget(
  kind: "agent" | "chain",
  name: string,
  matches: readonly Target[],
  ctx: ManagementContext,
): SubagentExecutionResult {
  const first = matches.at(0);
  const label = kind === "agent" ? "Agent" : "Chain";
  if (first !== undefined) {
    return result(
      `${label} '${name}' is ${first.source} and cannot be modified. Create a same-named ${kind} in user or project scope to override it.`,
      true,
    );
  }
  return result(`${label} '${name}' not found. Available: ${availableNamesText(ctx, kind)}.`, true);
}
function ambiguousTarget(
  kind: "agent" | "chain",
  name: string,
  matches: readonly Target[],
): SubagentExecutionResult {
  const label = kind === "agent" ? "Agent" : "Chain";
  const paths = matches.map((match) => `${match.source}: ${match.filePath}`).join("\n");
  const first = matches.at(0);
  if (first !== undefined && new Set(matches.map((match) => match.source)).size === 1) {
    return result(
      `${label} '${name}' has multiple definitions in ${first.source} scope and cannot be modified safely. Remove or rename one definition first.\n${paths}`,
      true,
    );
  }
  return result(
    `${label} '${name}' exists in both scopes. Specify agentScope: 'user' or 'project'.\n${paths}`,
    true,
  );
}
type TargetRequest = {
  readonly kind: "agent" | "chain";
  readonly name: string;
  readonly scopeHint?: string;
};
export function resolveTarget(
  request: TargetRequest,
  matches: readonly AgentConfig[],
  ctx: ManagementContext,
): WritableScope<AgentConfig> | SubagentExecutionResult;
export function resolveTarget(
  request: TargetRequest,
  matches: readonly ChainConfig[],
  ctx: ManagementContext,
): WritableScope<ChainConfig> | SubagentExecutionResult;
export function resolveTarget(
  request: TargetRequest,
  matches: readonly Target[],
  ctx: ManagementContext,
): WritableScope<Target> | SubagentExecutionResult;
export function resolveTarget(
  request: { readonly kind: "agent" | "chain"; readonly name: string; readonly scopeHint?: string },
  matches: readonly Target[],
  ctx: ManagementContext,
): WritableScope<Target> | SubagentExecutionResult {
  const { kind, name, scopeHint } = request;
  const mutable = matches.filter(isMutableTarget);
  const first = mutable.at(0);
  if (first === undefined) {
    return unresolvedTarget(kind, name, matches, ctx);
  }
  if (mutable.length === 1) {
    return first;
  }
  const scope = asDisambiguationScope(scopeHint);
  if (scope === undefined) {
    return ambiguousTarget(kind, name, mutable);
  }
  const scoped = mutable.filter((match) => match.source === scope);
  const scopedFirst = scoped.at(0);
  const label = kind === "agent" ? "Agent" : "Chain";
  if (scopedFirst === undefined) {
    return result(`${label} '${name}' not found in scope '${scope}'.`, true);
  }
  if (scoped.length > 1) {
    return result(
      `${label} '${name}' has multiple definitions in scope '${scope}' and cannot be modified safely. Remove or rename one definition first:\n${scoped.map((entry) => entry.filePath).join("\n")}`,
      true,
    );
  }
  return scopedFirst;
}
export function renamePath(
  request: {
    readonly kind: "agent" | "chain";
    readonly currentPath: string;
    readonly newName: string;
    readonly scope: ManagementScope;
  },
  ctx: ManagementContext,
): { filePath: string; error?: never } | { error: string; filePath?: never } {
  const { kind, currentPath, newName, scope } = request;
  if (nameExistsInScope(ctx, scope, newName, currentPath)) {
    return { error: `Name '${newName}' already exists in ${scope} scope.` };
  }
  let ext = ".md";
  if (kind === "chain") {
    ext = currentPath.endsWith(".chain.json") ? ".chain.json" : ".chain.md";
  }
  const filePath = path.join(path.dirname(currentPath), `${newName}${ext}`);
  if (fs.existsSync(filePath) && filePath !== currentPath) {
    return {
      error: `File already exists at ${filePath} but is not a valid ${kind} definition. Remove or rename it first.`,
    };
  }
  fs.renameSync(currentPath, filePath);
  return { filePath };
}
