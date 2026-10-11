import { errorMessage, isRecord, isUnknownArray } from "../../shared/unknown.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runSetupCommand } from "./worktree-process.ts";

export const DEFAULT_WORKTREE_SETUP_HOOK_TIMEOUT_MS = 30_000;
export interface WorktreeSetupHookConfig {
  readonly hookPath: string;
  readonly timeoutMs?: number;
}
export interface ResolvedWorktreeSetupHook {
  readonly hookPath: string;
  readonly timeoutMs: number;
}
export interface WorktreeSetupHookInput {
  readonly version: 1;
  readonly repoRoot: string;
  readonly worktreePath: string;
  readonly agentCwd: string;
  readonly branch: string;
  readonly index: number;
  readonly runId: string;
  readonly baseCommit: string;
  readonly agent?: string;
}

function parseHookTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) {
    return DEFAULT_WORKTREE_SETUP_HOOK_TIMEOUT_MS;
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("worktree setup hook timeout must be an integer greater than 0");
  }
  return timeoutMs;
}

export function resolveWorktreeSetupHook(
  repoRoot: string,
  config: WorktreeSetupHookConfig | undefined,
): ResolvedWorktreeSetupHook | undefined {
  if (!config) {
    return undefined;
  }
  const hookPath = config.hookPath.trim();
  if (hookPath.length === 0) {
    throw new Error("worktree setup hook path cannot be empty");
  }
  const expandedHookPath = hookPath.startsWith("~/")
    ? path.join(os.homedir(), hookPath.slice(2))
    : hookPath;
  let resolvedPath: string;
  if (path.isAbsolute(expandedHookPath)) {
    resolvedPath = expandedHookPath;
  } else if (expandedHookPath.includes("/") || expandedHookPath.includes("\\")) {
    resolvedPath = path.resolve(repoRoot, expandedHookPath);
  } else {
    throw new Error("worktree setup hook must be an absolute path or a repo-relative path");
  }
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`worktree setup hook not found: ${resolvedPath}`);
  }
  if (fs.statSync(resolvedPath).isDirectory()) {
    throw new Error(`worktree setup hook must be a file, got directory: ${resolvedPath}`);
  }
  return { hookPath: resolvedPath, timeoutMs: parseHookTimeout(config.timeoutMs) };
}

function normalizeSyntheticPath(worktreePath: string, rawPath: string): string {
  const trimmed = rawPath.trim();
  if (trimmed.length === 0) {
    throw new Error("synthetic path cannot be empty");
  }
  if (path.isAbsolute(trimmed)) {
    throw new Error(`synthetic path must be relative: ${rawPath}`);
  }
  const relative = path.relative(worktreePath, path.resolve(worktreePath, trimmed));
  if (relative.length === 0 || relative === ".") {
    throw new Error(`synthetic path cannot target the worktree root: ${rawPath}`);
  }
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`synthetic path escapes the worktree root: ${rawPath}`);
  }
  return path.normalize(relative);
}

function requirePathStrings(paths: unknown): readonly string[] {
  if (!isUnknownArray(paths)) {
    throw new Error(
      "worktree setup hook output field 'syntheticPaths' must be an array of relative paths",
    );
  }
  const result: string[] = [];
  for (const candidate of paths) {
    if (typeof candidate !== "string") {
      throw new Error(
        "worktree setup hook output field 'syntheticPaths' must contain only strings",
      );
    }
    result.push(candidate);
  }
  return result;
}

function parseSyntheticPaths(rawStdout: string): readonly string[] {
  const trimmed = rawStdout.trim();
  if (trimmed.length === 0) {
    throw new Error("worktree setup hook returned empty stdout; expected JSON object");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    const message = errorMessage(error);
    throw new Error(`worktree setup hook returned invalid JSON: ${message}`, { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new Error("worktree setup hook stdout must be a JSON object");
  }
  if (!("syntheticPaths" in parsed) || parsed.syntheticPaths === undefined) {
    return [];
  }
  return requirePathStrings(parsed.syntheticPaths);
}

/** Validates hook-declared scratch paths against Git before granting cleanup authority. */
async function validateSyntheticPaths(
  input: WorktreeSetupHookInput,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<string[]> {
  const uniquePaths = new Set<string>();
  for (const candidate of paths) {
    const normalizedPath = normalizeSyntheticPath(input.worktreePath, candidate);
    // Keep Git queries ordered and stop before granting authority to another path on cancellation.
    // oxlint-disable-next-line no-await-in-loop
    const result = await runSetupCommand({
      command: "git",
      args: ["-C", input.worktreePath, "ls-files", "--", normalizedPath],
      cwd: input.worktreePath,
      signal,
    });
    if (result.status === 0 && result.stdout.trim().length > 0) {
      throw new Error(
        `worktree setup hook cannot mark tracked paths as synthetic: ${normalizedPath}`,
      );
    }
    uniquePaths.add(normalizedPath);
  }
  return [...uniquePaths];
}

export async function runWorktreeSetupHook(
  hook: ResolvedWorktreeSetupHook,
  input: WorktreeSetupHookInput,
  signal?: AbortSignal,
): Promise<string[]> {
  let result;
  try {
    result = await runSetupCommand({
      command: hook.hookPath,
      args: [],
      cwd: input.worktreePath,
      signal,
      input: JSON.stringify(input),
      timeoutMs: hook.timeoutMs,
    });
  } catch (error) {
    signal?.throwIfAborted();
    const message = errorMessage(error);
    throw new Error(`worktree setup hook failed: ${message}`, { cause: error });
  }
  if (result.status !== 0) {
    const details =
      [result.stderr.trim(), result.stdout.trim()].find((text) => text.length > 0) ?? "no output";
    throw new Error(
      `worktree setup hook failed with exit code ${String(result.status)}: ${details}`,
    );
  }
  return validateSyntheticPaths(input, parseSyntheticPaths(result.stdout), signal);
}
