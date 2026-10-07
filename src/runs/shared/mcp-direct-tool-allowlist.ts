import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "../../shared/agent-dir.ts";

import type { Static } from "typebox";
import type { ReadonlyInput } from "../../shared/types.ts";
import { Check, ServersSchema, type ServerSchema, CacheSchema } from "./mcp-config-schema.ts";
import { stableStringify } from "./stable-value.ts";
import { isRecord } from "../../shared/unknown.ts";
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const BUILTIN_TOOL_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "mcp"]);
const GENERIC_GLOBAL_CONFIG_PATH = path.join(os.homedir(), ".config", "mcp", "mcp.json");
const IMPORT_PATHS = {
  cursor: [path.join(os.homedir(), ".cursor", "mcp.json")],
  "claude-code": [
    path.join(os.homedir(), ".claude", "mcp.json"),
    path.join(os.homedir(), ".claude.json"),
    path.join(os.homedir(), ".claude", "claude_desktop_config.json"),
  ],
  "claude-desktop": [
    path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    ),
  ],
  codex: [path.join(os.homedir(), ".codex", "config.json")],
  windsurf: [path.join(os.homedir(), ".windsurf", "mcp.json")],
  vscode: [".vscode/mcp.json"],
} as const;

type ToolPrefix = "server" | "none" | "short";
type ImportKind = keyof typeof IMPORT_PATHS;

type ServerEntry = ReadonlyInput<Static<typeof ServerSchema>>;
interface McpConfig {
  readonly mcpServers: Readonly<Record<string, ServerEntry>>;
  readonly imports?: readonly ImportKind[];
  readonly settings?: { readonly toolPrefix?: ToolPrefix };
}
type ServerCacheEntry = ReadonlyInput<Static<typeof CacheSchema>>["servers"][string];
interface MetadataCache {
  readonly version: number;
  readonly servers: Readonly<Partial<Record<string, ServerCacheEntry>>>;
}

export function resolveMcpDirectToolNames(
  mcpDirectTools: readonly string[] | undefined,
  cwd = process.cwd(),
): string[] {
  if (mcpDirectTools === undefined || mcpDirectTools.length === 0) {
    return [];
  }

  const names = new Set<string>();
  // Keep pre-v5 and independent Fitch configs paired with their own caches.
  for (const directory of ["", "fitch-mcp-adapter"]) {
    try {
      const config = loadMcpConfig(cwd, directory);
      const cache = loadMetadataCache(directory);
      if (!cache) {
        continue;
      }
      for (const name of resolveDirectToolNames(
        config,
        cache,
        getToolPrefix(config.settings?.toolPrefix),
        mcpDirectTools,
      )) {
        names.add(name);
      }
    } catch {
      /* An unavailable adapter does not hide the other adapter's tools. */
    }
  }
  return [...names];
}

function loadMetadataCache(directory: string): MetadataCache | null {
  const cachePath = path.join(getAgentDir(), directory, "mcp-cache.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
  } catch {
    return null;
  }

  return Check(CacheSchema, parsed) ? parsed : null;
}

function loadMcpConfig(cwd: string, directory: string): McpConfig {
  let config: McpConfig = { mcpServers: {} };
  for (const sourcePath of getConfigPaths(cwd, directory)) {
    const loaded = readConfig(sourcePath);
    if (!loaded) {
      continue;
    }
    config = mergeConfigs(config, expandImports(loaded, cwd));
  }
  return config;
}

function getConfigPaths(cwd: string, directory: string): string[] {
  const piGlobalPath = path.join(getAgentDir(), directory, "mcp.json");
  const projectPath = path.resolve(cwd, ".mcp.json");
  const projectPiPath = path.resolve(cwd, ".pi", directory, "mcp.json");
  const sources: string[] = [];
  if (GENERIC_GLOBAL_CONFIG_PATH !== piGlobalPath) {
    sources.push(GENERIC_GLOBAL_CONFIG_PATH);
  }
  sources.push(piGlobalPath);
  if (projectPath !== piGlobalPath) {
    sources.push(projectPath);
  }
  if (projectPiPath !== piGlobalPath && projectPiPath !== projectPath) {
    sources.push(projectPiPath);
  }
  return sources;
}

function readConfig(configPath: string): McpConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    return null;
  }
  return validateConfig(parsed);
}

function validatedServers(value: unknown): Readonly<Record<string, ServerEntry>> {
  return Check(ServersSchema, value) ? value : {};
}

function validateConfig(raw: unknown): McpConfig {
  if (!isRecord(raw)) {
    return { mcpServers: {} };
  }
  const settings = isRecord(raw.settings)
    ? { toolPrefix: getToolPrefix(raw.settings.toolPrefix) }
    : undefined;
  return {
    mcpServers: validatedServers(raw.mcpServers ?? raw["mcp-servers"] ?? {}),
    imports: Array.isArray(raw.imports) ? raw.imports.filter(isImportKind) : undefined,
    settings,
  };
}

function mergeConfigs(base: McpConfig, next: McpConfig): McpConfig {
  const imports = [...(base.imports ?? []), ...(next.imports ?? [])];
  return {
    mcpServers: { ...base.mcpServers, ...next.mcpServers },
    imports: imports.length > 0 ? [...new Set(imports)] : undefined,
    settings: next.settings ? { ...base.settings, ...next.settings } : base.settings,
  };
}

function expandImports(config: McpConfig, cwd: string): McpConfig {
  if (config.imports === undefined || config.imports.length === 0) {
    return config;
  }

  const importedServers = new Map<string, ServerEntry>();
  for (const importKind of config.imports) {
    const importPath = resolveImportPath(importKind, cwd);
    if (importPath === null) {
      continue;
    }
    let imported: unknown;
    try {
      imported = JSON.parse(fs.readFileSync(importPath, "utf-8"));
    } catch {
      continue;
    }
    for (const [name, definition] of Object.entries(extractServers(imported, importKind))) {
      if (!importedServers.has(name)) {
        importedServers.set(name, definition);
      }
    }
  }

  return {
    imports: config.imports,
    settings: config.settings,
    mcpServers: { ...Object.fromEntries(importedServers), ...config.mcpServers },
  };
}

function resolveImportPath(importKind: ImportKind, cwd: string): string | null {
  for (const candidate of IMPORT_PATHS[importKind]) {
    const fullPath = candidate.startsWith(".") ? path.resolve(cwd, candidate) : candidate;
    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
  }
  return null;
}

function extractServers(config: unknown, kind: ImportKind): Readonly<Record<string, ServerEntry>> {
  if (!isRecord(config)) {
    return {};
  }
  const servers =
    kind === "cursor" || kind === "windsurf" || kind === "vscode"
      ? (config.mcpServers ?? config["mcp-servers"])
      : config.mcpServers;
  return validatedServers(servers);
}

// Selection consumers need membership only; the parsing operation owns the sets.
type ToolSelection = true | { readonly has: (name: string) => boolean };

function cachedNames(cache: ServerCacheEntry, exposeResources: boolean): string[] {
  const tools = (cache.tools ?? []).flatMap((tool) =>
    tool.name !== undefined && tool.name !== "" ? [tool.name] : [],
  );
  if (!exposeResources) {
    return tools;
  }
  const resources = (cache.resources ?? []).flatMap((resource) => {
    if (
      resource.name === undefined ||
      resource.name === "" ||
      resource.uri === undefined ||
      resource.uri === ""
    ) {
      return [];
    }
    return [`read_${resourceNameToToolName(resource.name)}`];
  });
  return [...tools, ...resources];
}

function serverDirectNames(input: {
  readonly serverName: string;
  readonly definition: ServerEntry;
  readonly cache: ServerCacheEntry;
  readonly prefix: ToolPrefix;
  readonly selection: ToolSelection;
}): string[] {
  const names: string[] = [];
  for (const name of cachedNames(input.cache, input.definition.exposeResources !== false)) {
    if (input.selection !== true && !input.selection.has(name)) {
      continue;
    }
    if (isToolExcluded(name, input.serverName, input.prefix, input.definition.excludeTools)) {
      continue;
    }
    const prefixed = formatToolName(name, input.serverName, input.prefix);
    if (!BUILTIN_TOOL_NAMES.has(prefixed)) {
      names.push(prefixed);
    }
  }
  return names;
}

function resolveDirectToolNames(
  config: McpConfig,
  cache: MetadataCache,
  defaultPrefix: ToolPrefix,
  envOverride: readonly string[],
): string[] {
  const names: string[] = [];
  const { servers, tools } = parseSelections(envOverride);
  for (const [serverName, definition] of Object.entries(config.mcpServers)) {
    const serverCache = cache.servers[serverName];
    if (definition.disabled === true || !isServerCacheValid(serverCache, definition)) {
      continue;
    }
    const selection = servers.has(serverName) ? true : tools.get(serverName);
    if (selection === undefined) {
      continue;
    }
    names.push(
      ...serverDirectNames({
        serverName,
        definition,
        cache: serverCache,
        prefix: definition.toolPrefix ?? defaultPrefix,
        selection,
      }),
    );
  }
  return [...new Set(names)];
}

function parseSelection(item: string): { server: string; tool?: string } | undefined {
  const normalized = item.replace(/\/+$/, "");
  if (!normalized.includes("/")) {
    return normalized === "" ? undefined : { server: normalized };
  }
  const [server = "", tool = ""] = normalized.split("/", 2);
  if (server === "") {
    return;
  }
  return tool === "" ? { server } : { server, tool };
}

function parseSelections(selections: readonly string[]): {
  servers: Set<string>;
  tools: Map<string, Set<string>>;
} {
  const servers = new Set<string>();
  const tools = new Map<string, Set<string>>();
  for (const item of selections) {
    const selected = parseSelection(item);
    if (!selected) {
      continue;
    }
    if (selected.tool === undefined) {
      servers.add(selected.server);
      continue;
    }
    const names = tools.get(selected.server) ?? new Set<string>();
    names.add(selected.tool);
    tools.set(selected.server, names);
  }
  return { servers, tools };
}

function isServerCacheValid(
  entry: ServerCacheEntry | undefined,
  definition: ServerEntry,
): entry is ServerCacheEntry {
  if (!entry || entry.configHash !== computeMcpServerHash(definition)) {
    return false;
  }
  if (entry.cachedAt === undefined || entry.cachedAt === 0) {
    return false;
  }
  return Date.now() - entry.cachedAt <= CACHE_MAX_AGE_MS;
}

function computeMcpServerHash(definition: ServerEntry): string {
  const identity: Record<string, unknown> = {
    command: definition.command,
    args: definition.args,
    socket: resolveConfigPath(definition.socket),
    env: interpolateEnvRecord(definition.env),
    cwd: resolveConfigPath(definition.cwd),
    url:
      definition.url !== undefined && definition.url !== ""
        ? interpolateEnvVars(definition.url)
        : definition.url,
    headers: interpolateEnvRecord(definition.headers),
    auth: definition.auth,
    bearerToken: resolveBearerToken(definition),
    bearerTokenEnv: definition.bearerTokenEnv,
    exposeResources: definition.exposeResources,
    includeTools: definition.includeTools,
    excludeTools: definition.excludeTools,
  };
  return createHash("sha256").update(stableStringify(identity)).digest("hex");
}

function getToolPrefix(value: unknown): ToolPrefix {
  return value === "none" || value === "short" || value === "server" ? value : "server";
}

function isImportKind(value: unknown): value is ImportKind {
  return typeof value === "string" && Object.hasOwn(IMPORT_PATHS, value);
}

function getServerPrefix(serverName: string, mode: ToolPrefix): string {
  if (mode === "none") {
    return "";
  }
  if (mode === "short") {
    const short = serverName.replace(/-?mcp$/i, "").replace(/-/g, "_");
    return short === "" ? "mcp" : short;
  }
  return serverName.replace(/-/g, "_");
}

function formatToolName(toolName: string, serverName: string, prefix: ToolPrefix): string {
  const serverPrefix = getServerPrefix(serverName, prefix);
  return serverPrefix !== "" ? `${serverPrefix}_${toolName}` : toolName;
}

function isToolExcluded(
  toolName: string,
  serverName: string,
  prefix: ToolPrefix,
  excludeTools: unknown,
): boolean {
  if (!Array.isArray(excludeTools) || excludeTools.length === 0) {
    return false;
  }
  const candidates = new Set([
    normalizeToolName(toolName),
    normalizeToolName(formatToolName(toolName, serverName, prefix)),
    normalizeToolName(formatToolName(toolName, serverName, "server")),
    normalizeToolName(formatToolName(toolName, serverName, "short")),
  ]);
  return excludeTools.some(
    (excluded) => typeof excluded === "string" && candidates.has(normalizeToolName(excluded)),
  );
}

function normalizeToolName(value: string): string {
  return value.replace(/-/g, "_");
}

function resourceNameToToolName(name: string): string {
  let result = name
    .replace(/[^a-zA-Z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+/, "")
    .replace(/_+$/, "")
    .toLowerCase();
  if (result === "" || /^\d/.test(result)) {
    result = `resource${result !== "" ? `_${result}` : ""}`;
  }
  return result;
}

function interpolateEnvRecord(
  values: Readonly<Record<string, string>> | undefined,
): Record<string, string> | undefined {
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    return undefined;
  }
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "string") {
      resolved[key] = interpolateEnvVars(value);
    }
  }
  return resolved;
}

function interpolateEnvVars(value: string): string {
  return value
    .replace(/\$\{(\w+)\}/g, (_, name: string) => process.env[name] ?? "")
    .replace(/\$env:(\w+)/g, (_, name: string) => process.env[name] ?? "");
}

function resolveConfigPath(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const resolved = interpolateEnvVars(value);
  if (resolved === "~") {
    return os.homedir();
  }
  if (resolved.startsWith("~/") || resolved.startsWith("~\\")) {
    return path.join(os.homedir(), resolved.slice(2));
  }
  return resolved;
}

function resolveBearerToken(
  definition: Pick<ServerEntry, "bearerToken" | "bearerTokenEnv">,
): string | undefined {
  if (typeof definition.bearerToken === "string") {
    return interpolateEnvVars(definition.bearerToken);
  }
  return typeof definition.bearerTokenEnv === "string"
    ? process.env[definition.bearerTokenEnv]
    : undefined;
}
