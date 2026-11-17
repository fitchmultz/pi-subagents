import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  excludedRepoPrefixes,
  isExcludedRepoPath,
  safeRealpath,
  shortBranchName,
} from "./overseer-scope.ts";
import { missing } from "./storage.ts";

export interface SnapshotOptions {
  readonly baseBranch?: string | undefined;
  readonly excludePaths?: readonly string[] | undefined;
}

/** One state of a run's worktree. */
export interface RepoSnapshot {
  readonly isGit: boolean;
  readonly topLevel: string | undefined;
  readonly head: string | undefined;
  /**
   * The working tree as a git tree object: tracked and untracked files, without ignored and
   * harness paths. Two snapshots with the same tree hold the same files, whatever was committed.
   */
  readonly tree: string | undefined;
  /** Entries in this worktree's HEAD reflog. Git keeps that log for each worktree. */
  readonly headMoves: number;
  readonly baseBranch: string | undefined;
  readonly localBaseHead: string | undefined;
  /** Tip of the base branch's remote-tracking ref, unless this repository pushed it there. */
  readonly upstreamBaseHead: string | undefined;
  readonly resolvedBaseHead: string | undefined;
  readonly baseBranchUnborn: boolean;
}

/** A worktree state the overseer accepted, and what the child did not write. */
export interface ReviewPoint {
  readonly snapshot: RepoSnapshot;
  /**
   * Objects every ref named when the run launched, and the HEAD of each accepted state.
   * Content that equals one of them is not the child's new work.
   */
  readonly known: readonly string[];
  /** The working tree when the run launched. */
  readonly launchTree: string | undefined;
}

/** What the child itself changed between a review point and a later snapshot. */
export interface OwnChanges {
  /** Changed paths relative to the run's cwd, sorted. */
  readonly files: readonly string[];
  /**
   * Git could not compute the changes. `files` then holds one placeholder instead of paths, so
   * that whoever reads only `files` does not take the run for one without changes.
   */
  readonly unreadable: boolean;
  /**
   * Among `files`: work that the working tree no longer holds. It was committed in this worktree
   * on history that HEAD no longer contains, or it was accepted without a commit and a checkout
   * of another line dropped it.
   */
  readonly leftBehind: readonly string[];
  /** The working-tree part: `git diff base tree`, limited to `paths` when some files are not the child's. */
  readonly diff:
    | {
        readonly top: string;
        readonly base: string;
        readonly tree: string;
        readonly paths: readonly string[] | undefined;
      }
    | undefined;
}

const NO_BASE = {
  localBaseHead: undefined,
  upstreamBaseHead: undefined,
  resolvedBaseHead: undefined,
  baseBranchUnborn: false,
};
const NON_GIT_SNAPSHOT: RepoSnapshot = {
  isGit: false,
  topLevel: undefined,
  head: undefined,
  tree: undefined,
  headMoves: 0,
  baseBranch: undefined,
  ...NO_BASE,
};

function git(
  cwd: string,
  args: readonly string[],
  options: { readonly env?: NodeJS.ProcessEnv; readonly input?: string } = {},
): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
      maxBuffer: 67108864,
      ...options,
    });
  } catch {
    return undefined;
  }
}

function trimmed(value: string | undefined): string | undefined {
  const s = value?.trim();
  return s !== undefined && s.length > 0 ? s : undefined;
}

const optional = (value: string | undefined): string[] => (value === undefined ? [] : [value]);

const lines = (value: string | undefined, separator: string): string[] =>
  (value ?? "").split(separator).filter(Boolean);

const refCommit = (top: string, ref: string): string | undefined =>
  trimmed(git(top, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]));

const refLog = (top: string, ref: string): string =>
  git(top, ["log", "-g", "-1", "--format=%gs", ref]) ?? "";

const isAncestor = (top: string, ancestor: string, descendant: string): boolean =>
  git(top, ["merge-base", "--is-ancestor", ancestor, descendant]) !== undefined;

const emptyTree = (top: string): string | undefined =>
  trimmed(git(top, ["hash-object", "-t", "tree", "/dev/null"]));

/** Reflog actions that write a new commit on top of HEAD. */
const COMMITTING = /^(?:commit|cherry-pick|revert)\b/u;

/** This worktree's HEAD reflog, newest first: the commit HEAD moved to and what moved it. */
const headLog = (top: string): { commit: string; action: string }[] =>
  lines(git(top, ["log", "-g", "--format=%H %gs", "HEAD"]), "\n").map((line) => {
    const space = line.indexOf(" ");
    return { commit: line.slice(0, space), action: line.slice(space + 1) };
  });

/**
 * Writes the working tree as a tree object through a copy of the index, so the real index and
 * the working tree stay untouched.
 */
function workingTree(top: string, excluded: readonly string[]): string | undefined {
  const index = trimmed(git(top, ["rev-parse", "--path-format=absolute", "--git-path", "index"]));
  if (index === undefined) {
    return undefined;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overseer-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: path.join(directory, "index") };
    try {
      // Git trusts the cached size and time of a file only when the index is older than the
      // file, and it compares whole seconds. A fresh copy would be newer than every file and
      // hide a same-size edit made in the second the index was written, so the copy keeps the
      // time of the real index, rounded down.
      const written = Math.floor(fs.statSync(index).mtimeMs / 1000);
      fs.copyFileSync(index, env.GIT_INDEX_FILE);
      fs.utimesSync(env.GIT_INDEX_FILE, written, written);
    } catch (error) {
      // A repository without a first commit has no index yet.
      if (!missing(error)) {
        throw error;
      }
    }
    const pathspec = [".", ...excluded.map((prefix) => `:(exclude,top,literal)${prefix}`)];
    return git(top, ["add", "-A", "--", ...pathspec], { env }) === undefined
      ? undefined
      : trimmed(git(top, ["write-tree"], { env }));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function baseState(
  top: string,
  baseBranch: string | undefined,
  head: string | undefined,
): Omit<RepoSnapshot, "isGit" | "topLevel" | "head" | "tree" | "headMoves" | "baseBranch"> {
  if (baseBranch === undefined) {
    return NO_BASE;
  }
  const short = shortBranchName(baseBranch) ?? baseBranch;
  const remoteRef = `refs/remotes/origin/${short}`;
  const localBaseHead = refCommit(top, `refs/heads/${short}`);
  const remote = refCommit(top, remoteRef);
  const resolvedBaseHead = localBaseHead ?? refCommit(top, baseBranch) ?? remote;
  return {
    localBaseHead,
    // A tip pushed from this repository is local work, not what upstream changed.
    upstreamBaseHead: refLog(top, remoteRef).startsWith("update by push") ? undefined : remote,
    resolvedBaseHead,
    baseBranchUnborn:
      resolvedBaseHead === undefined &&
      head === undefined &&
      trimmed(git(top, ["rev-list", "-n", "1", "--all"])) === undefined,
  };
}

export function captureRepoSnapshot(cwd: string, options: SnapshotOptions = {}): RepoSnapshot {
  const top = trimmed(git(cwd, ["rev-parse", "--show-toplevel"]));
  const tree =
    top === undefined
      ? undefined
      : workingTree(top, excludedRepoPrefixes(top, options.excludePaths));
  if (top === undefined || tree === undefined) {
    return NON_GIT_SNAPSHOT;
  }
  const head = trimmed(git(top, ["rev-parse", "--verify", "--quiet", "HEAD"]));
  return {
    isGit: true,
    topLevel: top,
    head,
    tree,
    headMoves: headLog(top).length,
    baseBranch: shortBranchName(options.baseBranch),
    ...baseState(top, options.baseBranch, head),
  };
}

/** The state a run starts from: nothing in it is the child's work. */
export function launchPoint(cwd: string, options: SnapshotOptions = {}): ReviewPoint {
  const snapshot = captureRepoSnapshot(cwd, options);
  const refs =
    snapshot.topLevel === undefined
      ? []
      : lines(git(snapshot.topLevel, ["for-each-ref", "--format=%(objectname)"]), "\n");
  return acceptedPoint({ snapshot, known: refs, launchTree: snapshot.tree }, snapshot);
}

/** The review point after the overseer, or a clean check, accepted `snapshot`. */
export function acceptedPoint(prior: ReviewPoint, snapshot: RepoSnapshot): ReviewPoint {
  const known = new Set([...prior.known, ...optional(snapshot.head)]);
  return { snapshot, known: [...known], launchTree: prior.launchTree };
}

const exclusions = (commits: readonly string[]): string[] => commits.map((commit) => `^${commit}`);

/**
 * The known commits that the history of `head` sits on. A file whose content equals its content
 * in one of them was not written by the child.
 */
function knownBoundaries(top: string, head: string, known: readonly string[]): string[] {
  const walked = git(top, ["rev-list", "--boundary", head, "--stdin"], {
    input: exclusions(known).join("\n"),
  });
  if (walked === undefined) {
    return [];
  }
  const commits = lines(walked, "\n");
  return commits.length === 0
    ? [head]
    : commits.filter((commit) => commit.startsWith("-")).map((commit) => commit.slice(1));
}

const changedPaths = (top: string, from: string, to: string): string[] =>
  lines(git(top, ["diff", "-z", "--no-renames", "--name-only", from, to]), "\0");

/**
 * Files of the commits made in this worktree between the two snapshots that are neither known
 * nor part of the current history: work the child committed and then moved away from. Reads
 * this worktree's HEAD reflog and no branch, so a sibling worktree's commits cannot appear.
 */
function leftBehindPaths(
  top: string,
  from: RepoSnapshot,
  to: RepoSnapshot,
  known: readonly string[],
): string[] {
  const log = headLog(top);
  const made = log
    .slice(Math.max(0, log.length - to.headMoves), Math.max(0, log.length - from.headMoves))
    .filter((move) => COMMITTING.test(move.action))
    .map((move) => move.commit);
  if (made.length === 0) {
    return [];
  }
  const outside = new Set(
    lines(
      git(top, ["rev-list", "--stdin"], {
        input: [...made, ...exclusions([...known, ...optional(to.head)])].join("\n"),
      }),
      "\n",
    ),
  );
  const left = made.filter((commit) => outside.has(commit));
  const names = ["--no-commit-id", "--name-only", "--no-renames", "-z"];
  return left.length === 0
    ? []
    : lines(
        git(top, ["diff-tree", "--stdin", "-r", "--root", ...names], {
          input: `${left.join("\n")}\n`,
        }),
        "\0",
      );
}

/**
 * The paths among `changed` that a known commit under the current history does not explain.
 * A file whose content equals such a commit's came from it: upstream after a merge or
 * fast-forward, the commit that was checked out, or the commit an edit was reverted to.
 */
function unexplained(
  top: string,
  from: ReviewPoint,
  to: { readonly tree: string; readonly grew: boolean },
  options: {
    readonly changed: readonly string[];
    readonly boundaries: readonly string[];
    readonly accepted: ReadonlySet<string>;
  },
): string[] {
  const reviewedHead = from.snapshot.head;
  // While the history only grew, a commit the reviewed history already contained explains a
  // file only if the child had not changed that file before: taking accepted work back out
  // is new work.
  const accepted = to.grew ? options.accepted : new Set<string>();
  let paths = [...options.changed];
  for (const boundary of options.boundaries) {
    if (paths.length === 0) {
      break;
    }
    const differing = new Set(changedPaths(top, boundary, to.tree));
    const alreadyReviewed =
      accepted.size > 0 &&
      reviewedHead !== undefined &&
      (boundary === reviewedHead || isAncestor(top, boundary, reviewedHead));
    paths = paths.filter((file) => differing.has(file) || (alreadyReviewed && accepted.has(file)));
  }
  return paths;
}

/** Whether the history at `to` only added to the history at `from`. */
function historyGrew(top: string, from: RepoSnapshot, to: RepoSnapshot): boolean {
  return (
    from.head === undefined ||
    to.head === undefined ||
    from.head === to.head ||
    isAncestor(top, from.head, to.head)
  );
}

/** Maps a repository path to its path relative to the run's cwd. */
function relativeTo(cwd: string, top: string): (file: string) => string {
  const realCwd = safeRealpath(cwd);
  const realTop = safeRealpath(top);
  return (file) => {
    const out = path.relative(realCwd, path.resolve(realTop, file));
    return (out === "" ? file : out).split(path.sep).join("/");
  };
}

/** Maps repository paths to sorted, distinct paths relative to the run's cwd. */
const fromCwd = (cwd: string, top: string, files: readonly string[]): string[] =>
  [...new Set(files.map(relativeTo(cwd, top)))].sort();

/** The files the child had changed when `from` was accepted. Nothing at launch is its work. */
function acceptedPaths(top: string, from: ReviewPoint): Set<string> {
  const { tree } = from.snapshot;
  const none = from.launchTree === undefined || tree === undefined || from.launchTree === tree;
  return new Set(none ? [] : changedPaths(top, from.launchTree, tree));
}

/**
 * Files whose accepted content was the child's, was in no commit, and is gone after a checkout
 * of another line. No known commit explains that loss, although the file now equals the commit
 * checked out. Uncommitted content that was there at launch is not the child's to lose.
 */
function droppedEdits(
  top: string,
  from: RepoSnapshot,
  line: { readonly grew: boolean; readonly reviewed: string },
  now: {
    readonly changed: readonly string[];
    readonly paths: readonly string[];
    readonly accepted: ReadonlySet<string>;
  },
): string[] {
  if (line.grew || from.head === undefined || now.accepted.size === 0) {
    return [];
  }
  const uncommitted = new Set(changedPaths(top, from.head, line.reviewed));
  return now.changed.filter(
    (file) => now.accepted.has(file) && uncommitted.has(file) && !now.paths.includes(file),
  );
}

/** The child's part of the difference between the reviewed tree and the tree `to` holds now. */
function treeChanges(
  top: string,
  from: ReviewPoint,
  to: RepoSnapshot & { readonly tree: string },
  options: { readonly known: readonly string[]; readonly own: (paths: string[]) => string[] },
): {
  readonly paths: string[];
  /** Accepted edits that were in no commit and that a checkout of another line dropped. */
  readonly dropped: string[];
  readonly diff: OwnChanges["diff"];
} {
  const { tree } = to;
  const reviewed = from.snapshot.tree ?? emptyTree(top) ?? tree;
  const differing = reviewed === tree ? [] : changedPaths(top, reviewed, tree);
  const boundaries = to.head === undefined ? [] : knownBoundaries(top, to.head, options.known);
  const grew = historyGrew(top, from.snapshot, to);
  const changed = options.own(differing);
  const accepted = acceptedPaths(top, from);
  const paths = unexplained(top, from, { tree, grew }, { changed, boundaries, accepted });
  const dropped = droppedEdits(
    top,
    from.snapshot,
    { grew, reviewed },
    { changed, paths, accepted },
  );
  if (paths.length === 0) {
    return { paths, dropped, diff: undefined };
  }
  // When HEAD left the reviewed line (checkout, reset), the reviewed tree is another branch's
  // content: the known commit under the current history is the base that shows only the edits.
  const base = grew ? reviewed : (boundaries[0] ?? reviewed);
  const everyPath = base === reviewed && paths.length === differing.length;
  return { paths, dropped, diff: { top, base, tree, paths: everyPath ? undefined : paths } };
}

const UNREADABLE: OwnChanges = {
  files: ["(git-status-unavailable)"],
  unreadable: true,
  leftBehind: [],
  diff: undefined,
};

/** The child's own changes since `from`, without what only upstream or an existing commit changed. */
export function ownChanges(
  cwd: string,
  from: ReviewPoint,
  to: RepoSnapshot,
  excludePaths?: readonly string[],
): OwnChanges {
  const top = to.topLevel;
  const { tree } = to;
  if (top === undefined || tree === undefined) {
    return from.snapshot.isGit ? UNREADABLE : { ...UNREADABLE, files: [], unreadable: false };
  }
  // An accepted tree is an object that no ref holds, and a repository can be replaced. A tree
  // that can no longer be read must not look like a run without changes.
  const accepted = [...optional(from.snapshot.tree), ...optional(from.launchTree)];
  if (accepted.some((object) => git(top, ["cat-file", "-e", object]) === undefined)) {
    return UNREADABLE;
  }
  const excluded = excludedRepoPrefixes(top, excludePaths);
  const own = (paths: string[]): string[] =>
    paths.filter((file) => !isExcludedRepoPath(file, excluded));
  const known = [...from.known, ...optional(to.upstreamBaseHead)];
  const { paths, dropped, diff } = treeChanges(top, from, { ...to, tree }, { known, own });
  const left = [...own(leftBehindPaths(top, from.snapshot, to, known)), ...dropped];
  return {
    files: fromCwd(cwd, top, [...paths, ...left]),
    unreadable: false,
    leftBehind: fromCwd(cwd, top, left),
    diff,
  };
}

function diffOf(changes: OwnChanges, format: readonly string[]): string {
  const { diff } = changes;
  if (diff === undefined) {
    return "";
  }
  const pathspec = (diff.paths ?? []).map((file) => `:(top,literal)${file}`);
  const args = ["-c", "core.quotePath=false", "diff", ...format, diff.base, diff.tree];
  return git(diff.top, [...args, "--", ...pathspec]) ?? "";
}

/** The diff of the working-tree part of `changes`. */
export const changesDiff = (changes: OwnChanges): string => diffOf(changes, ["--unified=2"]);

/** Added and removed lines per file of that diff, as `git diff --numstat` prints them. */
export function changesStat(cwd: string, changes: OwnChanges): string {
  const top = changes.diff?.top;
  if (top === undefined) {
    return "";
  }
  // A notice names these files beside `files`, so they are spelled the same way: from the cwd.
  const fromRunCwd = relativeTo(cwd, top);
  return lines(diffOf(changes, ["--numstat", "--no-renames", "-z"]), "\0")
    .map((row) => {
      const [added = "", removed = "", ...file] = row.split("\t");
      return { counts: `${added}\t${removed}`, file: fromRunCwd(file.join("\t")) };
    })
    .sort((a, b) => (a.file < b.file ? -1 : 1))
    .map((row) => `${row.counts}\t${row.file}`)
    .join("\n");
}

/** The shell command that prints the whole diff of `changes`. */
export function changesDiffCommand(changes: OwnChanges): string | undefined {
  const { diff } = changes;
  if (diff === undefined) {
    return undefined;
  }
  const quote = (word: string): string => `'${word.replaceAll("'", "'\\''")}'`;
  const command = `git -C ${quote(diff.top)}`;
  const trees = `diff ${diff.base} ${diff.tree}`;
  if (diff.paths === undefined) {
    return `${command} ${trees}`;
  }
  // Literal, as in the excerpt: a path can hold pathspec syntax such as `[` or a leading `:`.
  return `${command} --literal-pathspecs ${trees} -- ${diff.paths.map(quote).join(" ")}`;
}

const isFetchOrPull = (s: string): boolean => s.startsWith("fetch") || s.startsWith("pull");

const isReflogSync = (rlog: string, llog: string): boolean =>
  !llog.startsWith("commit") &&
  !rlog.startsWith("update by push") &&
  (isFetchOrPull(rlog) || isFetchOrPull(llog));

function isUpstreamSync(
  top: string,
  name: string,
  sha: string | undefined,
  launch: RepoSnapshot,
): boolean {
  if (sha === undefined || name !== launch.baseBranch) {
    return false;
  }
  if (sha === launch.resolvedBaseHead) {
    return true;
  }
  const remoteRef = `refs/remotes/origin/${name}`;
  const remote = refCommit(top, remoteRef);
  if (remote === undefined || !isAncestor(top, sha, remote)) {
    return false;
  }
  return isReflogSync(refLog(top, remoteRef), refLog(top, `refs/heads/${name}`));
}

/**
 * Git lets only the worktree that has a branch checked out commit to it or move it, so a branch
 * checked out in another worktree was moved there, not by this run.
 */
function checkedOutElsewhere(top: string, branch: string): boolean {
  const here = safeRealpath(top);
  return (git(top, ["worktree", "list", "--porcelain"]) ?? "").split("\n\n").some((entry) => {
    const fields = entry.split("\n");
    const worktree = fields.find((field) => field.startsWith("worktree "))?.slice(9);
    return (
      worktree !== undefined &&
      safeRealpath(worktree) !== here &&
      fields.includes(`branch refs/heads/${branch}`)
    );
  });
}

function headAncestryIssue(
  top: string,
  baseBranch: string,
  launch: RepoSnapshot,
  current: RepoSnapshot,
): string | undefined {
  if (current.head === undefined || current.head === launch.head) {
    return undefined;
  }
  if (launch.baseBranchUnborn && current.resolvedBaseHead === undefined) {
    return undefined;
  }
  const anchor =
    launch.head !== undefined && launch.resolvedBaseHead !== undefined
      ? trimmed(git(top, ["merge-base", launch.resolvedBaseHead, launch.head]))
      : current.resolvedBaseHead;
  return anchor !== undefined && isAncestor(top, anchor, current.head)
    ? undefined
    : `Current HEAD is not descended from expected baseBranch '${baseBranch}'.`;
}

/** What breaks the contract's base-branch rules since launch, if anything. */
export function branchIssue(
  baseBranch: string | undefined,
  launch: RepoSnapshot,
  current: RepoSnapshot,
): string | undefined {
  if (baseBranch === undefined || current.topLevel === undefined) {
    return undefined;
  }
  const top = current.topLevel;
  const shortBase = shortBranchName(baseBranch) ?? baseBranch;
  const localBaseMutated =
    current.localBaseHead !== launch.localBaseHead &&
    !isUpstreamSync(top, shortBase, current.localBaseHead, launch) &&
    !checkedOutElsewhere(top, shortBase);
  if (localBaseMutated) {
    return `Child committed directly onto base branch '${baseBranch}' instead of a task branch.`;
  }
  if (current.resolvedBaseHead === undefined && !launch.baseBranchUnborn) {
    return `Expected baseBranch '${baseBranch}' could not be resolved in Git.`;
  }
  return headAncestryIssue(top, baseBranch, launch, current);
}
