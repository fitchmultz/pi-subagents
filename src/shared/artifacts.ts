import * as fs from "node:fs";
import * as path from "node:path";
import { TEMP_ARTIFACTS_DIR, type ArtifactPaths } from "./types.ts";
import { getAgentDir } from "./agent-dir.ts";
import { ensureSafeTempPath } from "./temp-root.ts";
import { hasErrorCode } from "./unknown.ts";
const CLEANUP_MARKER_FILE = ".last-cleanup";
export const ARTIFACT_CLEANUP_DAYS = 7;

export function getArtifactsDir(sessionFile: string | null): string {
  if (sessionFile !== null && sessionFile !== "") {
    const sessionDir = path.dirname(sessionFile);
    return path.join(sessionDir, "subagent-artifacts");
  }
  return TEMP_ARTIFACTS_DIR;
}

export function getArtifactPaths(
  artifactsDir: string,
  runId: string,
  agent: string,
  index?: number,
): ArtifactPaths {
  ensureSafeTempPath(artifactsDir);
  const suffix = index !== undefined ? `_${index}` : "";
  const safeAgent = agent.replace(/[^\w.-]/g, "_").slice(0, 128);
  const base = `${runId}_${safeAgent}${suffix}`;
  return {
    inputPath: path.join(artifactsDir, `${base}_input.md`),
    outputPath: path.join(artifactsDir, `${base}_output.md`),
    metadataPath: path.join(artifactsDir, `${base}_meta.json`),
  };
}

export function appendJsonl(filePath: string, line: string): void {
  fs.appendFileSync(filePath, `${line}\n`);
}

async function claimCleanup(dir: string, now: number): Promise<boolean> {
  try {
    await fs.promises.access(dir);
  } catch {
    return false;
  }

  const markerPath = path.join(dir, CLEANUP_MARKER_FILE);

  try {
    const stat = await fs.promises.lstat(markerPath);
    if (!stat.isSymbolicLink() && now - stat.mtimeMs < 24 * 60 * 60 * 1000) {
      return false;
    }
    await fs.promises.unlink(markerPath);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      return false;
    }
  }

  return true;
}
export async function cleanupOldArtifacts(dir: string, maxAgeDays: number): Promise<void> {
  ensureSafeTempPath(dir);
  const now = Date.now();
  if (!(await claimCleanup(dir, now))) {
    return;
  }
  const markerPath = path.join(dir, CLEANUP_MARKER_FILE);
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const cutoff = now - maxAgeMs;

  for (const file of await fs.promises.readdir(dir)) {
    if (file === CLEANUP_MARKER_FILE) {
      continue;
    }
    const filePath = path.join(dir, file);
    try {
      // Process one filesystem entry at a time to keep cleanup's I/O bounded.
      // oxlint-disable-next-line no-await-in-loop
      const stat = await fs.promises.lstat(filePath);
      if (stat.mtimeMs < cutoff) {
        // Finish deleting this entry before inspecting the next artifact.
        // oxlint-disable-next-line no-await-in-loop
        await fs.promises.unlink(filePath);
      }
    } catch {
      // Artifact cleanup is best-effort housekeeping. Skip files that disappear
      // or become unreadable while scanning so one bad entry does not block the rest.
    }
  }

  try {
    await fs.promises.writeFile(markerPath, String(now), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) {
      throw error;
    }
  }
}

export async function cleanupAllArtifactDirs(maxAgeDays: number): Promise<void> {
  await cleanupOldArtifacts(TEMP_ARTIFACTS_DIR, maxAgeDays);

  const sessionsBase = path.join(getAgentDir(), "sessions");

  let dirs: string[];
  try {
    dirs = await fs.promises.readdir(sessionsBase);
  } catch {
    // Session artifact cleanup is best-effort. If the sessions root cannot be read,
    // skip cleanup instead of failing extension startup.
    return;
  }

  for (const dir of dirs) {
    const artifactsDir = path.join(sessionsBase, dir, "subagent-artifacts");
    try {
      // Finish each session directory before starting another retention scan.
      // oxlint-disable-next-line no-await-in-loop
      await cleanupOldArtifacts(artifactsDir, maxAgeDays);
    } catch {
      // Session cleanup is best-effort. Keep going so one unreadable session dir
      // does not block cleanup for the rest.
    }
  }
}
