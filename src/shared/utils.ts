/**
 * General utility functions for the subagent extension
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { errorMessage, hasErrorCode, isRecord } from "./unknown.ts";
import type { ReadonlyAsyncStatus } from "./types.ts";
import { parseAsyncStatus } from "../runs/background/run-schemas.ts";

// ============================================================================
// File System Utilities
// ============================================================================

export { getAgentDir } from "./agent-dir.ts";

const statusCache = new Map<string, { version: string; status: ReadonlyAsyncStatus }>();

function rememberStatus(statusPath: string, version: string, status: ReadonlyAsyncStatus): void {
  statusCache.set(statusPath, { version, status });
  if (statusCache.size > 50) {
    const firstKey = statusCache.keys().next().value;
    if (firstKey !== undefined) {
      statusCache.delete(firstKey);
    }
  }
}

export function resolveChildCwd(baseCwd: string, childCwd: string | undefined): string {
  if (childCwd === undefined || childCwd === "") {
    return baseCwd;
  }
  return path.isAbsolute(childCwd) ? childCwd : path.resolve(baseCwd, childCwd);
}

function isNotFoundError(error: unknown): boolean {
  return hasErrorCode(error, "ENOENT");
}

function parseStatusForDisplay(value: unknown): ReadonlyAsyncStatus {
  try {
    return parseAsyncStatus(value);
  } catch (error) {
    if (!isRecord(value)) {
      throw error;
    }
    // Legacy display metadata may be corrupt; every other persisted field must validate.
    const { parallelGroups, ...remaining } = value;
    if (parallelGroups === undefined) {
      throw error;
    }
    try {
      return parseAsyncStatus(remaining);
    } catch {
      throw error;
    }
  }
}

/**
 * Read async job status from disk, invalidating on replacement and in-place updates.
 */
export function readStatus(asyncDir: string): ReadonlyAsyncStatus | null {
  const statusPath = path.join(asyncDir, "status.json");

  let stat: fs.BigIntStats;
  try {
    stat = fs.statSync(statusPath, { bigint: true });
  } catch (error) {
    if (isNotFoundError(error)) {
      statusCache.delete(statusPath);
      return null;
    }
    throw new Error(`Failed to inspect async status file '${statusPath}': ${errorMessage(error)}`, {
      cause: error,
    });
  }

  const cached = statusCache.get(statusPath);
  const version = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  if (cached && cached.version === version) {
    return cached.status;
  }

  let content: string;
  try {
    content = fs.readFileSync(statusPath, "utf-8");
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw new Error(`Failed to read async status file '${statusPath}': ${errorMessage(error)}`, {
      cause: error,
    });
  }

  let status: ReadonlyAsyncStatus;
  try {
    const parsed: unknown = JSON.parse(content);
    status = parseStatusForDisplay(parsed);
  } catch (error) {
    throw new Error(`Failed to parse async status file '${statusPath}': ${errorMessage(error)}`, {
      cause: error,
    });
  }

  rememberStatus(statusPath, version, status);
  return status;
}

/**
 * Find the latest session file in a directory
 */
export function findLatestSessionFile(sessionDir: string): string | null {
  try {
    let latest: { path: string; mtime: number } | undefined;
    for (const file of fs.readdirSync(sessionDir)) {
      if (!file.endsWith(".jsonl")) {
        continue;
      }
      const filePath = path.join(sessionDir, file);
      const mtime = fs.statSync(filePath).mtimeMs;
      if (!latest || mtime > latest.mtime) {
        latest = { path: filePath, mtime };
      }
    }
    return latest?.path ?? null;
  } catch {
    return null;
  }
}

export {
  getFinalOutput,
  getSingleResultOutput,
  formatResourceLimitExceeded,
  getDisplayItems,
  compactForegroundResult,
  detectSubagentError,
} from "./message-output.ts";
export { extractToolArgsPreview, extractTextFromContent } from "./content-preview.ts";

// ============================================================================
// Concurrency Utilities
// ============================================================================

export { mapConcurrent } from "./concurrency.ts";
