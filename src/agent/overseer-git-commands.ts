import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { missing } from "./storage.ts";

export function git(
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

export function trimmed(value: string | undefined): string | undefined {
  const s = value?.trim();
  return s !== undefined && s.length > 0 ? s : undefined;
}

/**
 * Writes the working tree as a tree object through a copy of the index, so the real index and
 * the working tree stay untouched.
 */
export function workingTree(top: string, excluded: readonly string[]): string | undefined {
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
