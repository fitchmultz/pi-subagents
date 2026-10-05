import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SkillSource, SkillSearchPath } from "./skill-types.ts";
import { isConfigObject, errorMessage } from "./config-values.ts";

const CONFIG_DIR = ".pi";
let cachedGlobalNpmRoot: string | null = null;

export function getGlobalNpmRoot(): string | null {
  if (cachedGlobalNpmRoot !== null) {
    return cachedGlobalNpmRoot;
  }
  try {
    cachedGlobalNpmRoot = execSync("npm root -g", {
      encoding: "utf-8",
      timeout: 5000,
      stdio: "pipe",
    }).trim();
    return cachedGlobalNpmRoot;
  } catch {
    // The empty cache value records the failed optional lookup.
    cachedGlobalNpmRoot = "";
    return null;
  }
}

function readJson(filePath: string, label: string, bestEffort = false): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (error) {
    if (bestEffort || (isConfigObject(error) && error.code === "ENOENT")) {
      return null;
    }
    throw new Error(`Failed to read ${label} '${filePath}': ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

function extractSkillPaths(
  packageRoot: string,
  source: SkillSource,
  bestEffort = false,
): SkillSearchPath[] {
  const pkg = readJson(path.join(packageRoot, "package.json"), "package manifest", bestEffort);
  if (!isConfigObject(pkg) || !isConfigObject(pkg.pi) || !Array.isArray(pkg.pi.skills)) {
    return [];
  }
  return pkg.pi.skills
    .filter((entry: unknown): entry is string => typeof entry === "string")
    .map((entry) => ({ path: path.resolve(packageRoot, entry), source }));
}

function packageDirectories(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(
      (entry) => !entry.name.startsWith(".") && (entry.isDirectory() || entry.isSymbolicLink()),
    )
    .map((entry) => path.join(dir, entry.name));
}

function installedPackagePaths(
  cwd: string,
  agentDir: string,
  projectTrusted: boolean,
): SkillSearchPath[] {
  const dirs: SkillSearchPath[] = [
    { path: path.join(agentDir, "npm", "node_modules"), source: "user-package" },
  ];
  if (projectTrusted) {
    dirs.unshift({
      path: path.join(cwd, CONFIG_DIR, "npm", "node_modules"),
      source: "project-package",
    });
  }
  const globalRoot = getGlobalNpmRoot();
  if (globalRoot !== null && globalRoot.length > 0) {
    dirs.push({ path: globalRoot, source: "user-package" });
  }
  const results: SkillSearchPath[] = [];
  for (const dir of dirs) {
    for (const packageDir of packageDirectories(dir.path)) {
      const roots = path.basename(packageDir).startsWith("@")
        ? packageDirectories(packageDir)
        : [packageDir];
      for (const root of roots) {
        results.push(...extractSkillPaths(root, dir.source, true));
      }
    }
  }
  return results;
}

function isSafePackagePath(value: string): boolean {
  return (
    value.length > 0 &&
    !path.isAbsolute(value) &&
    value.split(/[\\/]/).every((part) => part.length > 0 && part !== "." && part !== "..")
  );
}

function npmPackageName(source: string): string | undefined {
  const spec = source.slice(4).trim();
  if (spec.length === 0) {
    return undefined;
  }
  const packageName = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/)?.[1] ?? spec;
  return isSafePackagePath(packageName) ? packageName : undefined;
}

function stripGitRef(repoPath: string): string {
  const refIndex = [repoPath.indexOf("@"), repoPath.indexOf("#")]
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)
    .at(0);
  return refIndex === undefined ? repoPath : repoPath.slice(0, refIndex);
}

function gitLocation(spec: string): { host: string; repoPath: string } | undefined {
  const scpLike: RegExpMatchArray | null = spec.match(/^git@([^:]+):(.+)$/);
  if (scpLike) {
    return { host: scpLike.at(1) ?? "", repoPath: scpLike.at(2) ?? "" };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(spec)) {
    try {
      const url = new URL(spec);
      return { host: url.hostname, repoPath: url.pathname.replace(/^\/+/, "") };
    } catch {
      return undefined;
    }
  }
  const slashIndex = spec.indexOf("/");
  return slashIndex < 0
    ? undefined
    : { host: spec.slice(0, slashIndex), repoPath: spec.slice(slashIndex + 1) };
}

function gitPackagePath(source: string): { host: string; repoPath: string } | undefined {
  const spec = source.slice(4).trim();
  if (spec.length === 0) {
    return undefined;
  }
  const parsed = gitLocation(spec);
  if (parsed === undefined) {
    return undefined;
  }
  const repoPath = stripGitRef(parsed.repoPath)
    .replace(/\.git$/, "")
    .replace(/^\/+/, "");
  if (
    !isSafePackagePath(parsed.host) ||
    !isSafePackagePath(repoPath) ||
    repoPath.split(/[\\/]/).length < 2
  ) {
    return undefined;
  }
  return { host: parsed.host, repoPath };
}

function settingsPackageRoot(source: string, baseDir: string): string | undefined {
  const trimmed = source.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (trimmed.startsWith("git:")) {
    const parsed = gitPackagePath(trimmed);
    return parsed === undefined
      ? undefined
      : path.join(baseDir, "git", parsed.host, parsed.repoPath);
  }
  if (trimmed.startsWith("npm:")) {
    const name = npmPackageName(trimmed);
    return name === undefined ? undefined : path.join(baseDir, "npm", "node_modules", name);
  }
  return localPackageRoot(trimmed, baseDir);
}

function localPackageRoot(trimmed: string, baseDir: string): string | undefined {
  const normalized = trimmed.startsWith("file:") ? trimmed.slice(5) : trimmed;
  if (normalized === "~") {
    return os.homedir();
  }
  if (normalized.startsWith("~/")) {
    return path.join(os.homedir(), normalized.slice(2));
  }
  if (path.isAbsolute(normalized)) {
    return normalized;
  }
  return normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("./") ||
    normalized.startsWith("../")
    ? path.resolve(baseDir, normalized)
    : undefined;
}

function settingsPaths(
  cwd: string,
  agentDir: string,
  projectTrusted: boolean,
  packages: boolean,
): SkillSearchPath[] {
  const files = [
    { base: path.join(cwd, CONFIG_DIR), source: packages ? "project-package" : "project-settings" },
    { base: agentDir, source: packages ? "user-package" : "user-settings" },
  ] satisfies { base: string; source: SkillSource }[];
  const results: SkillSearchPath[] = [];
  for (const { base, source } of files) {
    if (!projectTrusted && source.startsWith("project-")) {
      continue;
    }
    const settings = readJson(path.join(base, "settings.json"), "skills settings file");
    if (!isConfigObject(settings)) {
      continue;
    }
    const entries = packages ? settings.packages : settings.skills;
    if (!Array.isArray(entries)) {
      continue;
    }
    results.push(
      ...entries.flatMap((entry: unknown) => settingEntryPaths(entry, base, source, packages)),
    );
  }
  return results;
}

function settingEntryPaths(
  entry: unknown,
  base: string,
  source: SkillSource,
  packages: boolean,
): SkillSearchPath[] {
  if (packages) {
    let packageSource: unknown = entry;
    if (isConfigObject(entry)) {
      packageSource = entry.source;
    }
    if (typeof packageSource !== "string" || packageSource.length === 0) {
      return [];
    }
    const root = settingsPackageRoot(packageSource, base);
    return root === undefined ? [] : extractSkillPaths(root, source);
  }
  if (typeof entry !== "string") {
    return [];
  }
  const resolved = entry.startsWith("~/")
    ? path.join(os.homedir(), entry.slice(2))
    : path.resolve(base, entry);
  return [{ path: resolved, source }];
}

export function buildSkillPaths(
  cwd: string,
  agentDir: string,
  projectTrusted: boolean,
): SkillSearchPath[] {
  const projectPaths: SkillSearchPath[] = projectTrusted
    ? [
        { path: path.join(cwd, CONFIG_DIR, "skills"), source: "project" },
        { path: path.join(cwd, ".agents", "skills"), source: "project" },
      ]
    : [];
  const paths: SkillSearchPath[] = [
    ...projectPaths,
    ...installedPackagePaths(cwd, agentDir, projectTrusted),
    ...settingsPaths(cwd, agentDir, projectTrusted, true),
    ...(projectTrusted ? extractSkillPaths(cwd, "project-package") : []),
    ...settingsPaths(cwd, agentDir, projectTrusted, false),
    { path: path.join(agentDir, "skills"), source: "user" },
    { path: path.join(os.homedir(), ".agents", "skills"), source: "user" },
  ];
  const deduped = new Map<string, SkillSearchPath>();
  for (const entry of paths) {
    const resolvedPath = path.resolve(entry.path);
    if (!deduped.has(resolvedPath)) {
      deduped.set(resolvedPath, { path: resolvedPath, source: entry.source });
    }
  }
  return [...deduped.values()];
}
