import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "../shared/agent-dir.ts";

export interface ChainDiscoveryDiagnostic {
  readonly source: "user" | "project";
  readonly filePath: string;
  readonly error: string;
}
export interface AgentDiscoveryDiagnostic extends Omit<ChainDiscoveryDiagnostic, "source"> {
  readonly source: "user" | "project" | "package";
}
export interface DiscoveryOptions {
  readonly projectTrusted?: boolean;
}

export function isDirectory(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function hasProjectResources(dir: string): boolean {
  const piDir = path.join(dir, ".pi");
  return (
    fs.existsSync(path.join(piDir, "settings.json")) ||
    isDirectory(path.join(piDir, "agents")) ||
    isDirectory(path.join(piDir, "chains"))
  );
}

export function findNearestProjectRoot(cwd: string): string | null {
  let currentDir = cwd;
  const homeDir = path.resolve(os.homedir());
  const startedAtHome = path.resolve(cwd) === homeDir;
  while (true) {
    const resolvedCurrent = path.resolve(currentDir);
    // Home configuration is project input only when discovery starts at home.
    if (resolvedCurrent === homeDir && !startedAtHome) {
      return null;
    }
    if (
      hasProjectResources(currentDir) ||
      (resolvedCurrent !== homeDir && isDirectory(path.join(currentDir, ".agents")))
    ) {
      return currentDir;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

export function getUserAgentSettingsPath(): string {
  return path.join(getAgentDir(), "settings.json");
}

export function getProjectAgentSettingsPath(
  cwd: string,
  options: DiscoveryOptions = {},
): string | null {
  if (options.projectTrusted === false) {
    return null;
  }
  const root = findNearestProjectRoot(cwd);
  return root === null ? null : path.join(root, ".pi", "settings.json");
}

export function resolveNearestProjectAgentDirs(
  cwd: string,
  options: DiscoveryOptions = {},
): {
  readDirs: string[];
  preferredDir: string | null;
} {
  const root = options.projectTrusted === false ? null : findNearestProjectRoot(cwd);
  if (root === null) {
    return { readDirs: [], preferredDir: null };
  }
  const legacyDir = path.join(root, ".agents");
  const preferredDir = path.join(root, ".pi", "agents");
  return { readDirs: [legacyDir, preferredDir].filter(isDirectory), preferredDir };
}

export function resolveNearestProjectChainDirs(
  cwd: string,
  options: DiscoveryOptions = {},
): {
  readDirs: string[];
  preferredDir: string | null;
} {
  const root = options.projectTrusted === false ? null : findNearestProjectRoot(cwd);
  if (root === null) {
    return { readDirs: [], preferredDir: null };
  }
  const preferredDir = path.join(root, ".pi", "chains");
  return { readDirs: isDirectory(preferredDir) ? [preferredDir] : [], preferredDir };
}

export function pathIsInside(dir: string, filePath: string): boolean {
  const relative = path.relative(dir, filePath);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export function listFilesRecursive(
  dir: string,
  predicate: (fileName: string) => boolean,
): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name.startsWith(".") ? [] : listFilesRecursive(filePath, predicate);
    }
    return (entry.isFile() || entry.isSymbolicLink()) && predicate(entry.name) ? [filePath] : [];
  });
}
