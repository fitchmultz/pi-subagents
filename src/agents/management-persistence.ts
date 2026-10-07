import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentConfig, ChainConfig } from "../shared/types/config.ts";
import type { SubagentExecutionResult } from "../shared/types.ts";
import { discoverAgentsAll } from "./agents.ts";
import {
  defaultSystemPromptMode,
  defaultInheritProjectContext,
  defaultInheritSkills,
} from "./agent-defaults.ts";
import { serializeAgent } from "./agent-serializer.ts";
import { serializeChain, serializeJsonChain } from "./chain-serializer.ts";
import { buildRuntimeName, frontmatterNameForConfig, parsePackageName } from "./identity.ts";
import {
  configObject,
  hasKey,
  sanitizeName,
  parseAgentPatch,
  parseStepList,
  validateChainConfigKeys,
  type ConfigParse,
} from "./management-config.ts";
import type { ConfigObject } from "./config-values.ts";
import {
  result,
  discoveryOptions,
  nameExistsInScope,
  findAgents,
  findChains,
  asDisambiguationScope,
  resolveTarget,
  renamePath,
  mutationRequest,
  type ManagementParams,
  type ManagementContext,
  type ManagementScope,
} from "./management-targets.ts";
import { agentWarnings, chainWarnings, referencingChains } from "./management-warnings.ts";

type Identity = Pick<AgentConfig, "name" | "localName" | "packageName" | "description">;
function createIdentity(cfg: ConfigObject): ConfigParse<Identity> {
  if (typeof cfg.name !== "string" || cfg.name.trim().length === 0) {
    return { error: "config.name is required and must be a non-empty string." };
  }
  if (typeof cfg.description !== "string" || cfg.description.trim().length === 0) {
    return { error: "config.description is required and must be a non-empty string." };
  }
  const localName = sanitizeName(cfg.name);
  if (localName.length === 0) {
    return {
      error: "config.name is invalid after sanitization. Use letters, numbers, spaces, or hyphens.",
    };
  }
  const parsed = parsePackageName(cfg.package, "config.package");
  if (parsed.error !== undefined) {
    return { error: parsed.error };
  }
  return {
    value: {
      name: buildRuntimeName(localName, parsed.packageName),
      localName,
      packageName: parsed.packageName,
      description: cfg.description.trim(),
    },
  };
}
function optionalIdentityError(cfg: ConfigObject): string | undefined {
  if (hasKey(cfg, "name") && (typeof cfg.name !== "string" || cfg.name.trim().length === 0)) {
    return "config.name must be a non-empty string when provided.";
  }
  if (
    hasKey(cfg, "description") &&
    (typeof cfg.description !== "string" || cfg.description.trim().length === 0)
  ) {
    return "config.description must be a non-empty string when provided.";
  }
  return undefined;
}

function updateIdentity(
  target: AgentConfig | ChainConfig,
  cfg: ConfigObject,
): ConfigParse<Identity> {
  const error = optionalIdentityError(cfg);
  if (error !== undefined) {
    return { error };
  }
  const localName =
    typeof cfg.name === "string"
      ? sanitizeName(cfg.name)
      : (target.localName ?? frontmatterNameForConfig(target));
  if (localName.length === 0) {
    return { error: "config.name is invalid after sanitization." };
  }
  const parsed = hasKey(cfg, "package")
    ? parsePackageName(cfg.package, "config.package")
    : { packageName: target.packageName };
  if (parsed.error !== undefined) {
    return { error: parsed.error };
  }
  return {
    value: {
      name: buildRuntimeName(localName, parsed.packageName),
      localName,
      packageName: parsed.packageName,
      description:
        typeof cfg.description === "string" ? cfg.description.trim() : target.description,
    },
  };
}
function targetDirectory(
  discovery: Pick<
    ReturnType<typeof discoverAgentsAll>,
    "userDir" | "projectDir" | "userChainDir" | "projectChainDir"
  >,
  ctx: ManagementContext,
  scope: ManagementScope,
  chain: boolean,
): string {
  if (chain) {
    return scope === "user"
      ? discovery.userChainDir
      : (discovery.projectChainDir ?? path.join(ctx.cwd, ".pi", "chains"));
  }
  return scope === "user"
    ? discovery.userDir
    : (discovery.projectDir ?? path.join(ctx.cwd, ".pi", "agents"));
}
function createChain(
  base: Identity & { readonly source: ManagementScope; readonly filePath: string },
  cfg: ConfigObject,
  ctx: ManagementContext,
): SubagentExecutionResult {
  const keyError = validateChainConfigKeys(cfg);
  if (keyError !== undefined) {
    return result(keyError, true);
  }
  const parsed = parseStepList(cfg.steps);
  if (parsed.error !== undefined) {
    return result(parsed.error, true);
  }
  const chain: ChainConfig = { ...base, steps: parsed.value };
  fs.writeFileSync(chain.filePath, serializeChain(chain), "utf-8");
  return result(
    [
      `Created chain '${chain.name}' at ${chain.filePath}.`,
      ...chainWarnings(ctx, chain.steps),
    ].join("\n"),
  );
}
function createAgent(
  base: Identity & { readonly source: ManagementScope; readonly filePath: string },
  cfg: ConfigObject,
  ctx: ManagementContext,
  shadowsBuiltin: boolean,
): SubagentExecutionResult {
  const parsed = parseAgentPatch(cfg);
  if (parsed.error !== undefined) {
    return result(parsed.error, true);
  }
  const agent: AgentConfig = {
    ...base,
    systemPrompt: "",
    systemPromptMode: defaultSystemPromptMode(base.name),
    inheritProjectContext: defaultInheritProjectContext(base.name),
    inheritSkills: defaultInheritSkills(),
    maxSubagentDepth: 0,
    ...parsed.value,
  };
  const warnings = [
    ...(shadowsBuiltin ? [`Note: this shadows the builtin agent '${base.name}'.`] : []),
    ...agentWarnings(ctx, agent, cfg),
  ];
  fs.writeFileSync(agent.filePath, serializeAgent(agent), "utf-8");
  return result([`Created agent '${agent.name}' at ${agent.filePath}.`, ...warnings].join("\n"));
}
export function handleCreate(
  params: ManagementParams,
  ctx: ManagementContext,
): SubagentExecutionResult {
  const parsed = configObject(params.config);
  if (parsed.error !== undefined) {
    return result(parsed.error, true);
  }
  const cfg = parsed.value;
  if (cfg === undefined) {
    return result("config required for create.", true);
  }
  const identity = createIdentity(cfg);
  if (identity.error !== undefined) {
    return result(identity.error, true);
  }
  const destination = prepareDestination(identity.value, cfg, ctx);
  if (destination.error !== undefined) {
    return result(destination.error, true);
  }
  const { base, isChain, shadowsBuiltin } = destination.value;
  return isChain ? createChain(base, cfg, ctx) : createAgent(base, cfg, ctx, shadowsBuiltin);
}

type CreationBase = Identity & { readonly source: ManagementScope; readonly filePath: string };
function destinationPath(
  request: {
    readonly directory: string;
    readonly name: string;
    readonly scope: ManagementScope;
    readonly chain: boolean;
  },
  ctx: ManagementContext,
): ConfigParse<string> {
  const { directory, name, scope, chain } = request;
  fs.mkdirSync(directory, { recursive: true });
  if (nameExistsInScope(ctx, scope, name)) {
    return { error: `Name '${name}' already exists in ${scope} scope. Use update instead.` };
  }
  const filePath = path.join(directory, chain ? `${name}.chain.md` : `${name}.md`);
  if (fs.existsSync(filePath)) {
    return {
      error: `File already exists at ${filePath} but is not a valid ${chain ? "chain" : "agent"} definition. Remove or rename it first.`,
    };
  }
  return { value: filePath };
}
function prepareDestination(
  identity: Identity,
  cfg: ConfigObject,
  ctx: ManagementContext,
): ConfigParse<{
  readonly base: CreationBase;
  readonly isChain: boolean;
  readonly shadowsBuiltin: boolean;
}> {
  const scope = cfg.scope ?? "user";
  if (scope !== "user" && scope !== "project") {
    return { error: "config.scope must be 'user' or 'project'." };
  }
  const isChain = hasKey(cfg, "steps");
  const options = discoveryOptions(ctx);
  if (scope === "project" && !options.projectTrusted) {
    return {
      error:
        "Project scope is not available because this project is untrusted. Run from a trusted project or use scope: 'user'.",
    };
  }
  const discovery = discoverAgentsAll(ctx.cwd, options);
  const directory = targetDirectory(discovery, ctx, scope, isChain);
  const destination = destinationPath(
    { directory, name: identity.name, scope, chain: isChain },
    ctx,
  );
  if (destination.error !== undefined) {
    return { error: destination.error };
  }
  return {
    value: {
      base: { ...identity, source: scope, filePath: destination.value },
      isChain,
      shadowsBuiltin: discovery.builtin.some((agent) => agent.name === identity.name),
    },
  };
}
function updateHeadline(
  kind: "agent" | "chain",
  oldName: string,
  updated: AgentConfig | ChainConfig,
): string {
  return updated.name === oldName
    ? `Updated ${kind} '${updated.name}' at ${updated.filePath}.`
    : `Updated ${kind} '${oldName}' to '${updated.name}' at ${updated.filePath}.`;
}
function updateAgent(
  name: string,
  cfg: ConfigObject,
  params: ManagementParams,
  ctx: ManagementContext,
): SubagentExecutionResult {
  const target = resolveTarget(
    { kind: "agent", name, scopeHint: params.agentScope },
    findAgents(name, ctx, asDisambiguationScope(params.agentScope) ?? "both"),
    ctx,
  );
  if ("content" in target) {
    return target;
  }
  const identity = updateIdentity(target, cfg);
  if (identity.error !== undefined) {
    return result(identity.error, true);
  }
  const patch = parseAgentPatch(cfg);
  if (patch.error !== undefined) {
    return result(patch.error, true);
  }
  let updated: AgentConfig = { ...target, ...patch.value, ...identity.value };
  const warnings = agentWarnings(ctx, updated, cfg);
  if (updated.name !== target.name) {
    const renamed = renamePath(
      { kind: "agent", currentPath: target.filePath, newName: updated.name, scope: target.source },
      ctx,
    );
    if (renamed.error !== undefined) {
      return result(renamed.error, true);
    }
    updated = { ...updated, filePath: renamed.filePath };
  }
  fs.writeFileSync(updated.filePath, serializeAgent(updated), "utf-8");
  if (updated.name !== target.name) {
    const refs = referencingChains(ctx, target.name);
    if (refs.length > 0) {
      warnings.push(`Warning: chains still reference '${target.name}': ${refs.join(", ")}.`);
    }
  }
  return result([updateHeadline("agent", target.name, updated), ...warnings].join("\n"));
}
function updateChain(
  name: string,
  cfg: ConfigObject,
  params: ManagementParams,
  ctx: ManagementContext,
): SubagentExecutionResult {
  const target = resolveTarget(
    { kind: "chain", name, scopeHint: params.agentScope },
    findChains(name, ctx, asDisambiguationScope(params.agentScope) ?? "both"),
    ctx,
  );
  if ("content" in target) {
    return target;
  }
  const keyError = validateChainConfigKeys(cfg);
  if (keyError !== undefined) {
    return result(keyError, true);
  }
  const identity = updateIdentity(target, cfg);
  if (identity.error !== undefined) {
    return result(identity.error, true);
  }
  const parsed = hasKey(cfg, "steps") ? parseStepList(cfg.steps) : { value: [...target.steps] };
  if (parsed.error !== undefined) {
    return result(parsed.error, true);
  }
  let updated: ChainConfig = { ...target, ...identity.value, steps: parsed.value };
  const warnings = hasKey(cfg, "steps") ? chainWarnings(ctx, updated.steps) : [];
  if (updated.name !== target.name) {
    const renamed = renamePath(
      { kind: "chain", currentPath: target.filePath, newName: updated.name, scope: target.source },
      ctx,
    );
    if (renamed.error !== undefined) {
      return result(renamed.error, true);
    }
    updated = { ...updated, filePath: renamed.filePath };
  }
  writeSavedChain(updated);
  return result([updateHeadline("chain", target.name, updated), ...warnings].join("\n"));
}
function writeSavedChain(chain: ChainConfig): void {
  const content = chain.filePath.endsWith(".chain.json")
    ? serializeJsonChain(chain)
    : serializeChain(chain);
  fs.writeFileSync(chain.filePath, content, "utf-8");
}

export function handleUpdate(
  params: ManagementParams,
  ctx: ManagementContext,
): SubagentExecutionResult {
  const request = mutationRequest(params, "update");
  if (request.error !== undefined) {
    return result(request.error, true);
  }
  const parsed = configObject(params.config);
  if (parsed.error !== undefined) {
    return result(parsed.error, true);
  }
  if (parsed.value === undefined) {
    return result("config required for update.", true);
  }
  return request.kind === "agent"
    ? updateAgent(request.name, parsed.value, params, ctx)
    : updateChain(request.name, parsed.value, params, ctx);
}

export function handleDelete(
  params: ManagementParams,
  ctx: ManagementContext,
): SubagentExecutionResult {
  const request = mutationRequest(params, "delete");
  if (request.error !== undefined) {
    return result(request.error, true);
  }
  const { kind, name } = request;
  const scope = asDisambiguationScope(params.agentScope) ?? "both";
  const matches: readonly (AgentConfig | ChainConfig)[] =
    kind === "agent" ? findAgents(name, ctx, scope) : findChains(name, ctx, scope);
  const target = resolveTarget({ kind, name, scopeHint: params.agentScope }, matches, ctx);
  if ("content" in target) {
    return target;
  }
  fs.unlinkSync(target.filePath);
  const refs = kind === "agent" ? referencingChains(ctx, target.name) : [];
  return result(
    [
      `Deleted ${kind} '${target.name}' at ${target.filePath}.`,
      ...(refs.length > 0
        ? [`Warning: chains reference deleted agent '${target.name}': ${refs.join(", ")}.`]
        : []),
    ].join("\n"),
  );
}
