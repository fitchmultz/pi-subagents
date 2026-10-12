/** Agent and saved-chain discovery entry points. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig, AgentScope, ChainConfig } from "../shared/types/config.ts";
export type {
  AgentConfig,
  AgentScope,
  AgentSource,
  AgentDefaultContext,
  ChainConfig,
  ChainStepConfig,
} from "../shared/types/config.ts";
import { getAgentDir } from "../shared/agent-dir.ts";
import {
  getUserAgentSettingsPath,
  getProjectAgentSettingsPath,
  resolveNearestProjectAgentDirs,
  resolveNearestProjectChainDirs,
  listFilesRecursive,
  type ChainDiscoveryDiagnostic,
  type AgentDiscoveryDiagnostic,
  type DiscoveryOptions as AgentDiscoveryOptions,
} from "./discovery-paths.ts";
export type {
  ChainDiscoveryDiagnostic,
  AgentDiscoveryDiagnostic,
  DiscoveryOptions as AgentDiscoveryOptions,
} from "./discovery-paths.ts";
import {
  loadAgentsFromDir,
  clearAgentDiagnosticsForDirs,
  agentDiagnosticsForDir,
} from "./agent-definition.ts";
import {
  EMPTY_SUBAGENT_SETTINGS,
  readSubagentSettings,
  applyBuiltinOverrides,
} from "./builtin-overrides.ts";
import { loadConfiguredPackageAgents } from "./package-agents.ts";
import { parseChain, parseJsonChain } from "./chain-serializer.ts";
import { mergeAgents } from "./agent-selection.ts";
import { errorMessage } from "./config-values.ts";
export { buildRuntimeName, frontmatterNameForConfig, parsePackageName } from "./identity.ts";

export {
  defaultSystemPromptMode,
  defaultInheritProjectContext,
  defaultInheritSkills,
} from "./agent-defaults.ts";

const BUILTIN_AGENTS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "agents",
);
interface ProfilePaths {
  readonly userDirs: readonly string[];
  readonly projectDirs: readonly string[];
  readonly projectDir: string | null;
  readonly userSettingsPath: string;
  readonly projectSettingsPath: string | null;
}
function profilePaths(cwd: string, options: AgentDiscoveryOptions): ProfilePaths {
  const project = resolveNearestProjectAgentDirs(cwd, options);
  return {
    userDirs: [path.join(getAgentDir(), "agents"), path.join(os.homedir(), ".agents")],
    projectDirs: project.readDirs,
    projectDir: project.preferredDir,
    userSettingsPath: getUserAgentSettingsPath(),
    projectSettingsPath: getProjectAgentSettingsPath(cwd, options),
  };
}
function discoverLocalProfiles(
  paths: ProfilePaths,
  scope: AgentScope,
): { builtin: AgentConfig[]; user: AgentConfig[]; project: AgentConfig[] } {
  const userSettings =
    scope === "project" ? EMPTY_SUBAGENT_SETTINGS : readSubagentSettings(paths.userSettingsPath);
  const projectSettings =
    scope === "user" ? EMPTY_SUBAGENT_SETTINGS : readSubagentSettings(paths.projectSettingsPath);
  const userDirs = scope === "project" ? [] : paths.userDirs;
  const projectDirs = scope === "user" ? [] : paths.projectDirs;
  clearAgentDiagnosticsForDirs([...userDirs, ...projectDirs]);
  const builtin = applyBuiltinOverrides(
    loadAgentsFromDir(BUILTIN_AGENTS_DIR, "builtin"),
    userSettings,
    projectSettings,
    paths.projectSettingsPath,
  );
  return {
    builtin,
    user: userDirs.flatMap((dir) => loadAgentsFromDir(dir, "user")),
    project: projectDirs.flatMap((dir) => loadAgentsFromDir(dir, "project")),
  };
}
function loadChainsFromDir(
  dir: string,
  source: "user" | "project",
): { chains: ChainConfig[]; diagnostics: ChainDiscoveryDiagnostic[] } {
  const chains: ChainConfig[] = [];
  const diagnostics: ChainDiscoveryDiagnostic[] = [];
  for (const filePath of listFilesRecursive(
    dir,
    (name) => name.endsWith(".chain.md") || name.endsWith(".chain.json"),
  )) {
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    try {
      chains.push(
        filePath.endsWith(".chain.json")
          ? parseJsonChain(content, source, filePath)
          : parseChain(content, source, filePath),
      );
    } catch (error) {
      diagnostics.push({ source, filePath, error: errorMessage(error) });
    }
  }
  return { chains, diagnostics };
}
export function discoverChains(
  cwd: string,
  options: AgentDiscoveryOptions = {},
  scope: AgentScope = "both",
): {
  chains: ChainConfig[];
  chainDiagnostics: ChainDiscoveryDiagnostic[];
  userChainDir: string;
  projectChainDir: string | null;
} {
  const userChainDir = path.join(getAgentDir(), "chains");
  const project = resolveNearestProjectChainDirs(cwd, options);
  const projectChains = (scope === "user" ? [] : project.readDirs).map((dir) =>
    loadChainsFromDir(dir, "project"),
  );
  const userChains =
    scope === "project" ? { chains: [], diagnostics: [] } : loadChainsFromDir(userChainDir, "user");
  return {
    userChainDir,
    projectChainDir: project.preferredDir,
    chains: [...userChains.chains, ...projectChains.flatMap((entry) => entry.chains)],
    chainDiagnostics: [
      ...userChains.diagnostics,
      ...projectChains.flatMap((entry) => entry.diagnostics),
    ],
  };
}
function localDiagnostics(paths: ProfilePaths, scope: AgentScope): AgentDiscoveryDiagnostic[] {
  return [
    ...(scope === "project" ? [] : paths.userDirs).flatMap((dir) =>
      agentDiagnosticsForDir(dir, "user"),
    ),
    ...(scope === "user" ? [] : paths.projectDirs).flatMap((dir) =>
      agentDiagnosticsForDir(dir, "project"),
    ),
  ];
}
export function discoverAgents(
  cwd: string,
  scope: AgentScope,
  options: AgentDiscoveryOptions = {},
): { agents: AgentConfig[]; projectAgentsDir: string | null } {
  const paths = profilePaths(cwd, options);
  const profiles = discoverLocalProfiles(paths, scope);
  const packages = loadConfiguredPackageAgents(cwd, scope, options);
  const agents = mergeAgents(profiles.user, profiles.project, [
    ...profiles.builtin,
    ...packages.agents,
  ]).filter((agent) => agent.disabled !== true);
  return { agents, projectAgentsDir: paths.projectDir };
}
export function discoverAgentsAll(
  cwd: string,
  options: AgentDiscoveryOptions = {},
  scope: AgentScope = "both",
): {
  builtin: AgentConfig[];
  package: AgentConfig[];
  user: AgentConfig[];
  project: AgentConfig[];
  chains: ChainConfig[];
  chainDiagnostics: ChainDiscoveryDiagnostic[];
  agentDiagnostics: AgentDiscoveryDiagnostic[];
  userDir: string;
  projectDir: string | null;
  userChainDir: string;
  projectChainDir: string | null;
  userSettingsPath: string;
  projectSettingsPath: string | null;
} {
  const paths = profilePaths(cwd, options);
  const profiles = discoverLocalProfiles(paths, scope);
  const chains = discoverChains(cwd, options, scope);
  const packages = loadConfiguredPackageAgents(cwd, scope, options);
  return {
    ...profiles,
    package: packages.agents,
    ...chains,
    agentDiagnostics: [
      ...localDiagnostics(paths, scope),
      ...packages.dirs.flatMap((dir) => agentDiagnosticsForDir(dir, "package")),
    ],
    userDir: paths.userDirs.at(0) ?? path.join(getAgentDir(), "agents"),
    projectDir: paths.projectDir,
    userSettingsPath: paths.userSettingsPath,
    projectSettingsPath: paths.projectSettingsPath,
  };
}
