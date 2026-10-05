import * as fs from "node:fs";
import * as path from "node:path";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, AgentScope } from "../shared/types/config.ts";
import { getAgentDir } from "../shared/utils.ts";
import { readSettingsFileStrict, isConfigObject } from "./config-values.ts";
import {
  findNearestProjectRoot,
  pathIsInside,
  isDirectory,
  type DiscoveryOptions,
} from "./discovery-paths.ts";
import { clearAgentDiagnosticsForDirs, loadAgentsFromDir } from "./agent-definition.ts";

type ConfiguredPackage = ReturnType<DefaultPackageManager["listConfiguredPackages"]>[number];
type PackageInput = Readonly<ConfiguredPackage>;
interface PackageIdentity {
  user?: PackageInput;
  project?: PackageInput;
}

let lastPackageManager:
  | { key: string; manager: DefaultPackageManager; settingsManager: SettingsManager }
  | undefined;

function packageManagerFor(
  cwd: string,
  scope: AgentScope,
  options: DiscoveryOptions,
): {
  manager: DefaultPackageManager;
  settingsManager: SettingsManager;
  projectRoot: string;
  agentDir: string;
} {
  const projectRoot = findNearestProjectRoot(cwd) ?? cwd;
  const agentDir = getAgentDir();
  const projectTrusted = options.projectTrusted !== false;
  const settings = {
    global:
      scope === "project"
        ? undefined
        : JSON.stringify(readSettingsFileStrict(path.join(agentDir, "settings.json"))),
    project:
      scope === "user" || !projectTrusted
        ? undefined
        : JSON.stringify(readSettingsFileStrict(path.join(projectRoot, ".pi", "settings.json"))),
  };
  const key = JSON.stringify([agentDir, projectRoot, scope, projectTrusted, settings]);
  if (lastPackageManager?.key !== key) {
    const settingsManager = SettingsManager.fromStorage(
      {
        withLock(settingsScope, read) {
          read(settings[settingsScope]);
        },
      },
      { projectTrusted },
    );
    const error = settingsManager.drainErrors().at(0);
    if (error !== undefined) {
      throw error.error;
    }
    lastPackageManager = {
      key,
      manager: new DefaultPackageManager({ cwd: projectRoot, agentDir, settingsManager }),
      settingsManager,
    };
  }
  return { ...lastPackageManager, projectRoot, agentDir };
}

interface PackageContext {
  readonly scope: AgentScope;
  readonly agentDir: string;
  readonly projectRoot: string;
}
function isRemotePackage(source: string): boolean {
  return source.startsWith("npm:") || /^(?:git:|https?:\/\/|ssh:\/\/)/.test(source.trim());
}
function packageKind(
  configured: PackageInput,
  userRoot: string | undefined,
  context: PackageContext,
): "npm" | "git" | "local" {
  if (configured.source.startsWith("npm:")) {
    return "npm";
  }
  if (!/^(?:git:|https?:\/\/|ssh:\/\/)/.test(configured.source.trim())) {
    return "local";
  }
  const gitBase =
    configured.scope === "user"
      ? path.join(context.agentDir, "git")
      : path.join(context.projectRoot, ".pi", "git");
  const managed =
    (configured.installedPath !== undefined && pathIsInside(gitBase, configured.installedPath)) ||
    (userRoot !== undefined && pathIsInside(path.join(context.agentDir, "git"), userRoot));
  return managed ? "git" : "local";
}
function packageIdentity(
  configured: PackageInput,
  manager: DefaultPackageManager,
  context: PackageContext,
): string | undefined {
  const userRoot =
    context.scope === "both" && configured.scope === "project" && isRemotePackage(configured.source)
      ? manager.getInstalledPath(configured.source, "user")
      : undefined;
  const kind = packageKind(configured, userRoot, context);
  // Pi's remote identities ignore refs; unparseable Git-like strings remain local paths.
  const root = kind === "local" ? configured.installedPath : (userRoot ?? configured.installedPath);
  return root === undefined || root.length === 0 ? undefined : `${kind}:${fs.realpathSync(root)}`;
}

function effectivePackage(
  identity: Readonly<PackageIdentity>,
  settingsManager: SettingsManager,
): PackageInput | undefined {
  const { user, project } = identity;
  const declaration = settingsManager
    .getProjectSettings()
    .packages?.findLast((pkg) => (typeof pkg === "string" ? pkg : pkg.source) === project?.source);
  const delta = typeof declaration === "object" && declaration.autoload === false;
  return delta && user !== undefined ? user : (project ?? user);
}
function selectedPackages(
  manager: DefaultPackageManager,
  settingsManager: SettingsManager,
  context: PackageContext,
): PackageInput[] {
  const configuredPackages = manager.listConfiguredPackages();
  const identities = new Map<string, PackageIdentity>();
  for (const configured of configuredPackages) {
    const identity = packageIdentity(configured, manager, context);
    if (identity === undefined) {
      continue;
    }
    const entries = identities.get(identity) ?? {};
    if (configured.scope === "project") {
      entries.project = configured;
    } else {
      entries.user ??= configured;
    }
    identities.set(identity, entries);
  }
  const selected = new Set<PackageInput>();
  for (const identity of identities.values()) {
    const entry = effectivePackage(identity, settingsManager);
    if (entry !== undefined) {
      selected.add(entry);
    }
  }
  return configuredPackages.filter((entry) => selected.has(entry));
}

function manifestAgentDirs(root: string): string[] {
  const subagents = readSettingsFileStrict(path.join(root, "package.json")).subagents;
  if (subagents === undefined) {
    return [];
  }
  if (!isConfigObject(subagents) || !Array.isArray(subagents.agents)) {
    throw new Error(`Package '${root}' subagents.agents must be an array of relative directories.`);
  }
  const realRoot = fs.realpathSync(root);
  return subagents.agents.map((entry: unknown) => {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      path.isAbsolute(entry) ||
      entry.split(/[\\/]/).includes("..")
    ) {
      throw new Error(
        `Package '${root}' subagents.agents must contain relative directories inside the package.`,
      );
    }
    const dir = path.resolve(root, entry);
    const realDir = isDirectory(dir) ? fs.realpathSync(dir) : undefined;
    if (realDir === undefined || !pathIsInside(realRoot, realDir)) {
      throw new Error(
        `Package '${root}' subagents.agents directory is missing or outside the package: ${entry}`,
      );
    }
    return dir;
  });
}

function eligiblePackageRoot(
  configured: PackageInput,
  scope: AgentScope,
  options: DiscoveryOptions,
): string | undefined {
  if (
    (scope !== "both" && configured.scope !== scope) ||
    (configured.scope === "project" && options.projectTrusted === false)
  ) {
    return undefined;
  }
  const root = configured.installedPath;
  return root !== undefined && root.length > 0 && fs.existsSync(path.join(root, "package.json"))
    ? root
    : undefined;
}
export function loadConfiguredPackageAgents(
  cwd: string,
  scope: AgentScope,
  options: DiscoveryOptions,
): { dirs: string[]; agents: AgentConfig[] } {
  const { manager, settingsManager, agentDir, projectRoot } = packageManagerFor(
    cwd,
    scope,
    options,
  );
  const selected = selectedPackages(manager, settingsManager, { scope, agentDir, projectRoot });
  const dirs: string[] = [];
  const seenDirs = new Set<string>();
  for (const configured of selected) {
    const root = eligiblePackageRoot(configured, scope, options);
    if (root === undefined) {
      continue;
    }
    for (const dir of manifestAgentDirs(root)) {
      const realDir = fs.realpathSync(dir);
      if (!seenDirs.has(realDir)) {
        dirs.push(dir);
      }
      seenDirs.add(realDir);
    }
  }
  clearAgentDiagnosticsForDirs(dirs);
  return { dirs, agents: dirs.flatMap((dir) => loadAgentsFromDir(dir, "package")) };
}
