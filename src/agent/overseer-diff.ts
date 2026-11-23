import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { missing } from "./storage.ts";

export interface TreeSnapshot {
  readonly isGit: boolean;
  readonly topLevel: string | undefined;
  readonly tree: string | undefined;
  readonly unreadable: boolean;
}

export interface TreeDelta {
  readonly files: readonly string[];
  readonly diff: string;
  readonly stat: string;
  readonly diffCommand: string | undefined;
  readonly lineCount: number;
  readonly unreadable: boolean;
}

const NON_GIT: TreeSnapshot = {
  isGit: false,
  topLevel: undefined,
  tree: undefined,
  unreadable: false,
};

const EMPTY_DELTA: TreeDelta = {
  files: [],
  diff: "",
  stat: "",
  diffCommand: undefined,
  lineCount: 0,
  unreadable: false,
};

function git(cwd: string, args: readonly string[], env?: NodeJS.ProcessEnv): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 67108864,
      ...(env === undefined ? {} : { env }),
    });
  } catch {
    return undefined;
  }
}

function trimmed(value: string | undefined): string | undefined {
  const s = value?.trim();
  return s !== undefined && s.length > 0 ? s : undefined;
}

function safeRealpath(target: string): string {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

function toPosix(value: string): string {
  return value.replaceAll("\\", "/");
}

function excludedPrefixes(topLevel: string, excludePaths: readonly string[]): string[] {
  const root = safeRealpath(topLevel);
  const prefixes: string[] = [];
  for (const target of excludePaths) {
    const rel = path.relative(root, safeRealpath(target));
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
      continue;
    }
    prefixes.push(toPosix(rel));
  }
  return prefixes;
}

/**
 * Writes the working tree as a git tree object via a temporary index copy so the real index
 * and working tree stay untouched.
 */
function writeWorkingTree(topLevel: string, excluded: readonly string[]): string | undefined {
  const index = trimmed(
    git(topLevel, ["rev-parse", "--path-format=absolute", "--git-path", "index"]),
  );
  if (index === undefined) {
    return undefined;
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overseer-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: path.join(tempDir, "index") };
    try {
      const written = Math.floor(fs.statSync(index).mtimeMs / 1000);
      fs.copyFileSync(index, env.GIT_INDEX_FILE);
      fs.utimesSync(env.GIT_INDEX_FILE, written, written);
    } catch (error) {
      if (!missing(error)) {
        throw error;
      }
    }
    const pathspec = [".", ...excluded.map((prefix) => `:(exclude,top,literal)${prefix}`)];
    return git(topLevel, ["add", "-A", "--", ...pathspec], env) === undefined
      ? undefined
      : trimmed(git(topLevel, ["write-tree"], env));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export function captureSnapshot(cwd: string, excludePaths: readonly string[]): TreeSnapshot {
  const topLevel = trimmed(git(cwd, ["rev-parse", "--show-toplevel"]));
  if (topLevel === undefined) {
    return NON_GIT;
  }
  const tree = writeWorkingTree(topLevel, excludedPrefixes(topLevel, excludePaths));
  return {
    isGit: true,
    topLevel,
    tree,
    unreadable: tree === undefined,
  };
}

function repoRelativeFiles(cwd: string, topLevel: string, rawNames: string): string[] {
  const base = safeRealpath(cwd);
  const top = safeRealpath(topLevel);
  return rawNames
    .split("\0")
    .filter(Boolean)
    .map((repoRel) => toPosix(path.relative(base, path.join(top, repoRel))))
    .toSorted();
}

function countDiffLines(diff: string): number {
  if (diff === "") {
    return 0;
  }
  let count = 0;
  for (const line of diff.split("\n")) {
    if (
      (line.startsWith("+") && !line.startsWith("+++ ")) ||
      (line.startsWith("-") && !line.startsWith("--- "))
    ) {
      count += 1;
    }
  }
  return count;
}

function isUnreadableDelta(from: TreeSnapshot, to: TreeSnapshot): boolean {
  return from.unreadable || to.unreadable || from.tree === undefined || to.tree === undefined;
}

function runTreeDiff(input: {
  readonly cwd: string;
  readonly top: string;
  readonly fromTree: string;
  readonly toTree: string;
  readonly excerptLimit: number;
}): TreeDelta {
  const { cwd, top, fromTree, toTree, excerptLimit } = input;
  const names = git(top, ["diff", "--name-only", "-z", fromTree, toTree]);
  const diff = git(top, ["diff", "--no-color", fromTree, toTree]);
  const stat = git(top, ["diff", "--numstat", fromTree, toTree]);
  if (names === undefined || diff === undefined || stat === undefined) {
    return { ...EMPTY_DELTA, unreadable: true };
  }
  return {
    files: repoRelativeFiles(cwd, top, names),
    diff,
    stat: stat.trimEnd(),
    diffCommand: diff.length > excerptLimit ? `git diff ${fromTree} ${toTree}` : undefined,
    lineCount: countDiffLines(diff),
    unreadable: false,
  };
}

export function diffSnapshots(
  cwd: string,
  from: TreeSnapshot,
  to: TreeSnapshot,
  excerptLimit: number,
): TreeDelta {
  if (!from.isGit || !to.isGit) {
    return EMPTY_DELTA;
  }
  if (isUnreadableDelta(from, to)) {
    return { ...EMPTY_DELTA, unreadable: true };
  }
  const fromTree = from.tree ?? "";
  const toTree = to.tree ?? "";
  if (fromTree === toTree) {
    return EMPTY_DELTA;
  }
  return runTreeDiff({
    cwd,
    top: to.topLevel ?? from.topLevel ?? cwd,
    fromTree,
    toTree,
    excerptLimit,
  });
}
