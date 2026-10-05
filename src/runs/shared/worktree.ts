import * as fs from "node:fs";
import * as path from "node:path";
import { errorMessage as getErrorMessage, hasErrorCode } from "../../shared/unknown.ts";
import { markWorktreesForPreservation } from "./worktree-preservation.ts";
import { buildWorktreeBranch, buildWorktreePath } from "./worktree-location.ts";
export {
  findWorktreeTaskCwdConflict,
  formatWorktreeTaskCwdConflict,
  resolveExpectedWorktreeAgentCwd,
} from "./worktree-location.ts";
import { ensureTempRoot } from "../../shared/temp-root.ts";
import { runGitChecked, runSetupCommand, runSetupGit } from "./worktree-process.ts";
import {
  DEFAULT_WORKTREE_SETUP_HOOK_TIMEOUT_MS,
  resolveWorktreeSetupHook,
  runWorktreeSetupHook,
  type WorktreeSetupHookConfig,
  type ResolvedWorktreeSetupHook,
} from "./worktree-hook.ts";

export class WorktreeCleanupError extends Error {}

export type { WorktreeSetup } from "./worktree-contract.ts";
import type { WorktreeSetup, WorktreeInfo, WorktreeDiff } from "./worktree-contract.ts";

interface CreateWorktreesOptions {
  readonly agents?: readonly string[];
  readonly setupHook?: WorktreeSetupHookConfig;
  readonly signal?: AbortSignal;
}

interface RepoState {
  readonly toplevel: string;
  readonly cwdRelative: string;
  readonly baseCommit: string;
}

async function resolveRepoState(cwd: string, signal?: AbortSignal): Promise<RepoState> {
  const repoCheck = await runSetupCommand({
    command: "git",
    args: ["-C", cwd, "rev-parse", "--is-inside-work-tree"],
    cwd,
    signal,
  });
  if (repoCheck.status !== 0 || repoCheck.stdout.trim() !== "true") {
    throw new Error("worktree isolation requires a git repository");
  }
  const cwdRelative = (await runSetupGit(cwd, ["rev-parse", "--show-prefix"], signal))
    .trim()
    .replace(/[\\/]+$/, "");
  const toplevel = (await runSetupGit(cwd, ["rev-parse", "--show-toplevel"], signal)).trim();

  const status = await runSetupGit(toplevel, ["status", "--porcelain"], signal);
  if (status.trim().length > 0) {
    throw new Error(
      "worktree isolation requires a clean git working tree. Commit or stash changes first, or rerun without worktree isolation if shared-checkout edits are intentional.",
    );
  }

  const baseCommit = (await runSetupGit(toplevel, ["rev-parse", "HEAD"], signal)).trim();
  return { toplevel, cwdRelative, baseCommit };
}

function safePatchAgentName(agent: string): string {
  return agent.replace(/[^\w.-]/g, "_");
}

function escapesRoot(relative: string): boolean {
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function readSyntheticStat(resolved: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(resolved);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

function removeSyntheticPath(worktree: WorktreeInfo, syntheticPath: string): void {
  const resolved = path.resolve(worktree.path, syntheticPath);
  const relative = path.relative(worktree.path, resolved);
  if (relative.length === 0 || relative === "." || escapesRoot(relative)) {
    return;
  }
  const stat = readSyntheticStat(resolved);
  if (!stat) {
    return;
  }
  const realRoot = fs.realpathSync(worktree.path);
  const realParent = fs.realpathSync(path.dirname(resolved));
  const parentRelative = path.relative(realRoot, realParent);
  if (escapesRoot(parentRelative)) {
    throw new Error(`synthetic path resolves outside the worktree: ${syntheticPath}`);
  }

  if (stat.isSymbolicLink()) {
    fs.unlinkSync(resolved);
    return;
  }
  if (stat.isDirectory()) {
    fs.rmSync(resolved, { recursive: true, force: true });
    return;
  }
  fs.rmSync(resolved, { force: true });
}

function removeSyntheticPathsBeforeDiff(worktree: WorktreeInfo): void {
  if (worktree.syntheticPaths.length === 0) {
    return;
  }
  const seen = new Set<string>();
  for (const syntheticPath of worktree.syntheticPaths) {
    if (seen.has(syntheticPath)) {
      continue;
    }
    seen.add(syntheticPath);
    removeSyntheticPath(worktree, syntheticPath);
  }
}

function emptyDiff(
  input: Pick<
    WorktreeDiff,
    "index" | "agent" | "branch" | "patchPath" | "worktreePath" | "captureError"
  >,
): WorktreeDiff {
  return {
    ...input,
    diffStat: "",
    filesChanged: 0,
    insertions: 0,
    deletions: 0,
  };
}

function parseNumstat(numstat: string): {
  filesChanged: number;
  insertions: number;
  deletions: number;
} {
  const lines = numstat
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;

  for (const line of lines) {
    const columns = line.split("\t");
    if (columns.length < 2) {
      continue;
    }
    const [rawInsertions, rawDeletions] = columns;
    filesChanged++;
    if (/^\d+$/.test(rawInsertions)) {
      insertions += parseInt(rawInsertions, 10);
    }
    if (/^\d+$/.test(rawDeletions)) {
      deletions += parseInt(rawDeletions, 10);
    }
  }

  return { filesChanged, insertions, deletions };
}

function captureWorktreeDiff(
  setup: Readonly<WorktreeSetup>,
  worktree: WorktreeInfo,
  agent: string,
  patchPath: string,
): WorktreeDiff {
  removeSyntheticPathsBeforeDiff(worktree);
  runGitChecked(worktree.path, ["add", "-A"]);
  const diffStat = runGitChecked(worktree.path, [
    "diff",
    "--cached",
    "--stat",
    setup.baseCommit,
  ]).trim();
  const patch = runGitChecked(worktree.path, [
    "diff",
    "--cached",
    "--binary",
    "--no-textconv",
    "--no-ext-diff",
    setup.baseCommit,
  ]);
  const numstat = runGitChecked(worktree.path, ["diff", "--cached", "--numstat", setup.baseCommit]);
  fs.writeFileSync(patchPath, patch, "utf-8");

  if (patch.trim().length === 0) {
    return emptyDiff({
      index: worktree.index,
      agent,
      branch: worktree.branch,
      patchPath,
      worktreePath: worktree.path,
    });
  }

  const parsed = parseNumstat(numstat);
  return {
    index: worktree.index,
    agent,
    branch: worktree.branch,
    diffStat,
    filesChanged: parsed.filesChanged,
    insertions: parsed.insertions,
    deletions: parsed.deletions,
    patchPath,
    worktreePath: worktree.path,
  };
}

function writeEmptyPatch(patchPath: string): void {
  try {
    fs.writeFileSync(patchPath, "", "utf-8");
  } catch {
    // Diff artifact writing is best-effort in error paths.
  }
}

function cleanupSingleWorktree(repoCwd: string, worktree: WorktreeInfo): void {
  try {
    runGitChecked(repoCwd, ["worktree", "remove", "--force", worktree.path]);
  } catch (error) {
    console.error(`Failed to remove worktree '${worktree.path}': ${getErrorMessage(error)}`);
  }
  try {
    runGitChecked(repoCwd, ["branch", "-D", worktree.branch]);
  } catch (error) {
    console.error(
      `Failed to delete worktree branch '${worktree.branch}': ${getErrorMessage(error)}`,
    );
  }
}

function hasWorktreeChanges(diff: WorktreeDiff): boolean {
  return (
    Boolean(diff.captureError) ||
    diff.filesChanged > 0 ||
    diff.insertions > 0 ||
    diff.deletions > 0 ||
    diff.diffStat.trim().length > 0
  );
}

interface WorktreeReservation {
  readonly path?: string;
  readonly branch?: string;
}
interface WorktreePlan {
  readonly repo: Readonly<RepoState>;
  readonly runId: string;
  readonly hook?: ResolvedWorktreeSetupHook;
  readonly signal?: AbortSignal;
  readonly agents?: readonly string[];
}

async function reserveWorktree(
  plan: WorktreePlan,
  index: number,
): Promise<{ worktree: WorktreeInfo; reservation: WorktreeReservation }> {
  const { repo, signal } = plan;
  const branch = buildWorktreeBranch(plan.runId, index);
  const worktreePath = buildWorktreePath(plan.runId, index);
  ensureTempRoot();
  const pathExisted = fs.existsSync(worktreePath);
  const branchExisted =
    (await runSetupGit(repo.toplevel, ["branch", "--list", branch], signal)).trim().length > 0;
  // Reserve only resources this attempt can create, before Git can partially initialize them.
  const agentCwd =
    repo.cwdRelative.length > 0 ? path.join(worktreePath, repo.cwdRelative) : worktreePath;
  return {
    worktree: { path: worktreePath, agentCwd, branch, index, syntheticPaths: [] },
    reservation: {
      path: pathExisted ? undefined : worktreePath,
      branch: branchExisted ? undefined : branch,
    },
  };
}

async function initializeWorktree(
  plan: WorktreePlan,
  worktree: WorktreeInfo,
): Promise<WorktreeInfo> {
  const { repo, signal } = plan;
  const { path: worktreePath, agentCwd, branch, index } = worktree;
  await runSetupGit(repo.toplevel, ["worktree", "add", worktreePath, "-b", branch, "HEAD"], signal);
  const syntheticPaths = plan.hook
    ? await runWorktreeSetupHook(
        plan.hook,
        {
          version: 1,
          repoRoot: repo.toplevel,
          worktreePath,
          agentCwd,
          branch,
          index,
          runId: plan.runId,
          baseCommit: repo.baseCommit,
          agent: plan.agents?.[index],
        },
        signal,
      )
    : [];
  return { path: worktreePath, agentCwd, branch, index, syntheticPaths };
}

async function rollbackWorktree(
  repoCwd: string,
  entry: WorktreeReservation,
  signal: AbortSignal,
): Promise<string[]> {
  const failures: string[] = [];
  if (entry.path !== undefined && fs.existsSync(entry.path)) {
    try {
      // An interrupted checkout can leave Git's initializing lock on this newly owned path.
      await runSetupGit(repoCwd, ["worktree", "remove", "--force", "--force", entry.path], signal);
    } catch (error) {
      failures.push(`Could not remove worktree '${entry.path}': ${getErrorMessage(error)}`);
    }
  }
  if (entry.branch !== undefined) {
    try {
      const exists = (
        await runSetupGit(repoCwd, ["branch", "--list", entry.branch], signal)
      ).trim();
      if (exists.length > 0) {
        await runSetupGit(repoCwd, ["branch", "-D", entry.branch], signal);
      }
    } catch (error) {
      failures.push(
        `Could not delete worktree branch '${entry.branch}': ${getErrorMessage(error)}`,
      );
    }
  }
  return failures;
}

export async function createWorktrees(
  cwd: string,
  runId: string,
  count: number,
  options?: CreateWorktreesOptions,
): Promise<WorktreeSetup> {
  const signal = options?.signal;
  const repo = await resolveRepoState(cwd, signal);
  const hook = resolveWorktreeSetupHook(repo.toplevel, options?.setupHook);
  const plan: WorktreePlan = { repo, runId, hook, signal, agents: options?.agents };
  const worktrees: WorktreeInfo[] = [];
  const reservations: WorktreeReservation[] = [];
  try {
    for (let index = 0; index < count; index++) {
      // Git modifies a shared repository; finish setup before reserving the next worktree.
      // oxlint-disable-next-line no-await-in-loop
      const { worktree, reservation } = await reserveWorktree(plan, index);
      reservations.push(reservation);
      // Register rollback authority before Git can partially initialize this worktree.
      // oxlint-disable-next-line no-await-in-loop
      worktrees.push(await initializeWorktree(plan, worktree));
    }
  } catch (error) {
    // Rollback remains owned after cancellation and has its own bounded lifetime.
    const cleanupSignal = AbortSignal.timeout(
      hook?.timeoutMs ?? DEFAULT_WORKTREE_SETUP_HOOK_TIMEOUT_MS,
    );
    const failures: string[] = [];
    for (const entry of reservations.reverse()) {
      // Reverse-order resource release must finish before removing the preceding reservation.
      // oxlint-disable-next-line no-await-in-loop
      failures.push(...(await rollbackWorktree(repo.toplevel, entry, cleanupSignal)));
    }
    if (failures.length > 0) {
      throw new WorktreeCleanupError(
        `${getErrorMessage(error)}\n\nWorktree rollback incomplete:\n${failures.join("\n")}`,
        { cause: error },
      );
    }
    throw error;
  }
  return { cwd: repo.toplevel, worktrees, baseCommit: repo.baseCommit };
}

export function diffWorktrees(
  setup: Readonly<WorktreeSetup>,
  agents: readonly string[],
  diffsDir: string,
): WorktreeDiff[] {
  try {
    fs.mkdirSync(diffsDir, { recursive: true });
  } catch (error) {
    const message = `failed to create worktree diff artifact directory '${diffsDir}': ${getErrorMessage(error)}`;
    markWorktreesForPreservation(setup, message);
    return setup.worktrees.map((worktree, index) => {
      const agent = agents[index] ?? `task-${index + 1}`;
      const patchPath = path.join(diffsDir, `task-${index}-${safePatchAgentName(agent)}.patch`);
      return emptyDiff({
        index,
        agent,
        branch: worktree.branch,
        patchPath,
        worktreePath: worktree.path,
        captureError: message,
      });
    });
  }

  const diffs: WorktreeDiff[] = [];
  for (let index = 0; index < setup.worktrees.length; index++) {
    const worktree = setup.worktrees[index];
    const agent = agents[index] ?? `task-${index + 1}`;
    const patchPath = path.join(diffsDir, `task-${index}-${safePatchAgentName(agent)}.patch`);
    try {
      diffs.push(captureWorktreeDiff(setup, worktree, agent, patchPath));
    } catch (error) {
      const message = `failed to capture worktree diff for task ${index + 1} (${agent}) at '${worktree.path}': ${getErrorMessage(error)}`;
      markWorktreesForPreservation(setup, message);
      writeEmptyPatch(patchPath);
      diffs.push(
        emptyDiff({
          index,
          agent,
          branch: worktree.branch,
          patchPath,
          worktreePath: worktree.path,
          captureError: message,
        }),
      );
    }
  }

  return diffs;
}

export function cleanupWorktrees(setup: Readonly<WorktreeSetup>): void {
  if (setup.preserveOnCleanup === true) {
    return;
  }
  for (let index = setup.worktrees.length - 1; index >= 0; index--) {
    cleanupSingleWorktree(setup.cwd, setup.worktrees[index]);
  }
  try {
    runGitChecked(setup.cwd, ["worktree", "prune"]);
  } catch (error) {
    console.error(`Failed to prune worktrees in '${setup.cwd}': ${getErrorMessage(error)}`);
  }
}

function worktreeRecoveryLines(diff: WorktreeDiff): string[] {
  if (diff.captureError === undefined || diff.captureError.length === 0) {
    return [];
  }
  const lines = [`Diff capture failed: ${diff.captureError}`];
  if (diff.worktreePath !== undefined && diff.worktreePath.length > 0) {
    lines.push(`Preserved worktree: ${diff.worktreePath}`);
  }
  lines.push(`Preserved branch: ${diff.branch}`);
  return lines;
}

export function formatWorktreeDiffSummary(diffs: readonly WorktreeDiff[]): string {
  const changed = diffs.filter(hasWorktreeChanges);
  if (changed.length === 0) {
    return "";
  }

  const lines: string[] = ["=== Worktree Changes ===", ""];
  for (const diff of changed) {
    lines.push(
      `--- Task ${diff.index + 1} (${diff.agent}): ${diff.filesChanged} files changed, +${diff.insertions} -${diff.deletions} ---`,
    );
    lines.push(...worktreeRecoveryLines(diff));
    if (diff.diffStat.trim().length > 0) {
      lines.push(diff.diffStat);
    }
    lines.push("");
  }

  const patchesDir = path.dirname(changed[0]?.patchPath ?? "");
  if (changed.some((diff) => (diff.captureError ?? "").length === 0)) {
    lines.push(`Full patches: ${patchesDir}`);
  } else {
    lines.push("Patch artifacts unavailable; preserved worktrees contain the recoverable changes.");
  }
  return lines.join("\n").trimEnd();
}

export function formatParallelWorktreeSummary(
  worktreeSetup: Readonly<WorktreeSetup> | undefined,
  diffsDir: string,
  agents: readonly string[],
): string {
  if (!worktreeSetup) {
    return "";
  }
  return formatWorktreeDiffSummary(diffWorktrees(worktreeSetup, agents, diffsDir));
}

export function appendWorktreeSummary(output: string, worktreeSummary: string): string {
  return worktreeSummary.length > 0 ? `${output}\n\n${worktreeSummary}` : output;
}
