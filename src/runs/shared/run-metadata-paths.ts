import * as path from "node:path";
import { getAgentDir } from "../../shared/agent-dir.ts";
import { TEMP_ROOT_DIR } from "../../shared/types.ts";

export const LEGACY_QUESTIONS_DIR = path.join(TEMP_ROOT_DIR, "supervisor-questions");
export const QUESTIONS_DIR = path.join(getAgentDir(), "sessions", "subagent-runs");

export function safeId(value: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw new Error("Invalid run or question ID.");
  }
  return value;
}

export function getRunMetadataDir(runId: string, root = QUESTIONS_DIR): string {
  return path.join(root, safeId(runId));
}
