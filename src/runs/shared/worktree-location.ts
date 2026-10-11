import * as fs from "node:fs";
import * as path from "node:path";
import { TEMP_ROOT_DIR } from "../../shared/types.ts";
import { runGit, runGitChecked } from "./worktree-process.ts";

interface WorktreeTaskCwdConflict {
  readonly index: number;
  readonly agent: string;
  readonly cwd: string;
}
function normalizeComparableCwd(cwd: string): string {
  const resolved = path.resolve(cwd);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  } // Missing paths are still compared as absolute paths.
}

export function findWorktreeTaskCwdConflict(
  tasks: readonly { readonly agent: string; readonly cwd?: string }[],
  sharedCwd: string,
): WorktreeTaskCwdConflict | undefined {
  const normalizedSharedCwd = normalizeComparableCwd(sharedCwd);
  for (const [index, task] of tasks.entries()) {
    if (task.cwd === undefined || task.cwd.length === 0) {
      continue;
    }
    const taskCwd = path.isAbsolute(task.cwd) ? task.cwd : path.resolve(sharedCwd, task.cwd);
    if (normalizeComparableCwd(taskCwd) === normalizedSharedCwd) {
      continue;
    }
    return { index, agent: task.agent, cwd: task.cwd };
  }
  return undefined;
}

export function formatWorktreeTaskCwdConflict(
  conflict: WorktreeTaskCwdConflict,
  sharedCwd: string,
): string {
  return `worktree isolation uses the shared cwd (${sharedCwd}); task ${conflict.index + 1} (${conflict.agent}) sets cwd to ${conflict.cwd}. Remove task-level cwd overrides or disable worktree.`;
}
export function buildWorktreeBranch(runId: string, index: number): string {
  return `pi-parallel-${runId}-${index}`;
}
export function buildWorktreePath(runId: string, index: number): string {
  return path.join(TEMP_ROOT_DIR, "worktrees", `pi-worktree-${runId}-${index}`);
}

export function resolveExpectedWorktreeAgentCwd(cwd: string, runId: string, index: number): string {
  const repoCheck = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (repoCheck.status !== 0 || repoCheck.stdout.trim() !== "true") {
    throw new Error("worktree isolation requires a git repository");
  }
  const rawPrefix = runGitChecked(cwd, ["rev-parse", "--show-prefix"]).trim();
  const normalized = rawPrefix.length > 0 ? path.normalize(rawPrefix.replace(/[\\/]+$/, "")) : "";
  const cwdRelative = normalized === "." ? "" : normalized;
  const worktreePath = buildWorktreePath(runId, index);
  return cwdRelative.length > 0 ? path.join(worktreePath, cwdRelative) : worktreePath;
}
