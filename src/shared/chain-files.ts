import * as fs from "node:fs";
import * as path from "node:path";
import { CHAIN_RUNS_DIR } from "./types.ts";
import { ensureSafeTempPath, ensureTempRoot } from "./temp-root.ts";
const CHAIN_DIR_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const INITIAL_PROGRESS_CONTENT =
  "# Progress\n\n## Status\nIn Progress\n\n## Tasks\n\n## Files Changed\n\n## Notes\n";

export function createChainDir(runId: string, baseDir?: string, cwd = process.cwd()): string {
  const customBase = baseDir !== undefined && baseDir.length > 0;
  if (!customBase) {
    ensureTempRoot();
  }
  const chainDir = path.join(customBase ? path.resolve(cwd, baseDir) : CHAIN_RUNS_DIR, runId);
  if (!customBase) {
    ensureSafeTempPath(chainDir);
  }
  fs.mkdirSync(chainDir, { recursive: true });
  return chainDir;
}
export function removeChainDir(chainDir: string): void {
  try {
    fs.rmSync(chainDir, { recursive: true });
  } catch {
    // Cleanup is best effort; another run may already have removed the directory.
  }
}
async function cleanupOldDirectory(dir: string, now: number): Promise<void> {
  try {
    const dirPath = path.join(CHAIN_RUNS_DIR, dir);
    const stat = await fs.promises.lstat(dirPath);
    if (stat.isDirectory() && now - stat.mtimeMs > CHAIN_DIR_MAX_AGE_MS) {
      await fs.promises.rm(dirPath, { recursive: true });
    }
  } catch {
    // One unreadable directory must not prevent cleanup of the remaining runs.
  }
}
export async function cleanupOldChainDirs(): Promise<void> {
  ensureSafeTempPath(CHAIN_RUNS_DIR);
  const now = Date.now();
  let dirs: string[];
  try {
    dirs = await fs.promises.readdir(CHAIN_RUNS_DIR);
  } catch {
    // An unreadable scoped temp root must not fail extension startup.
    return;
  }
  for (const dir of dirs) {
    // Preserve the existing one-directory resource bound throughout startup pruning.
    // oxlint-disable-next-line no-await-in-loop
    await cleanupOldDirectory(dir, now);
  }
}
export function writeInitialProgressFile(progressDir: string): void {
  fs.mkdirSync(progressDir, { recursive: true });
  try {
    fs.writeFileSync(path.join(progressDir, "progress.md"), INITIAL_PROGRESS_CONTENT, {
      encoding: "utf-8",
      flag: "wx",
    });
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "EEXIST"
    ) {
      throw error;
    }
  }
}
