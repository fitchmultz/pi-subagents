import * as fs from "node:fs";
import * as path from "node:path";
import type { ObservedMessage } from "../../shared/types.ts";
import { scanJournal } from "../../shared/journal-reader.ts";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { hasErrorCode, isRecord as isObject } from "../../shared/unknown.ts";
import { nonempty } from "./child-presence.ts";
import { isClaudeFamily, isClaudeContext, type ClaudeCodeModelSpec } from "./claude-model.ts";
import type { ClaudeCodeResultEvent } from "./claude-types.ts";

const SESSION_EVENT_TYPE = "claude_code_session";
export interface ClaudeCodeSessionMetadata {
  readonly sessionId: string;
  readonly model: string;
  readonly cliModel: string;
  readonly family: ClaudeCodeModelSpec["family"];
  readonly context: ClaudeCodeModelSpec["context"];
  readonly updatedAt: number;
}

function validateMetadata(value: unknown): ClaudeCodeSessionMetadata | undefined {
  if (
    !isObject(value) ||
    typeof value.sessionId !== "string" ||
    !nonempty(value.sessionId) ||
    typeof value.model !== "string" ||
    typeof value.cliModel !== "string"
  ) {
    return;
  }
  if (!isClaudeFamily(value.family) || !isClaudeContext(value.context)) {
    return;
  }
  const updatedAt = Number(value.updatedAt);
  return {
    sessionId: value.sessionId,
    model: value.model,
    cliModel: value.cliModel,
    family: value.family,
    context: value.context,
    updatedAt: Number.isNaN(updatedAt) ? 0 : updatedAt,
  };
}

export function readClaudeCodeSessionMetadata(
  sessionFile: string | undefined,
): ClaudeCodeSessionMetadata | undefined {
  if (!nonempty(sessionFile)) {
    return;
  }
  try {
    const value: unknown = JSON.parse(fs.readFileSync(`${sessionFile}.metadata.json`, "utf8"));
    return validateMetadata(value);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      throw error;
    }
  }
  if (!fs.existsSync(sessionFile)) {
    return;
  }
  let metadata: ClaudeCodeSessionMetadata | undefined;
  // Legacy metadata is recovered read-only; updates never rewrite its audit messages.
  scanJournal(
    sessionFile,
    (keys) =>
      keys.length === 0 || ["type", "claudeCode"].includes(String(keys[0])) ? 4096 : false,
    ({ value }) => {
      if (value.type === SESSION_EVENT_TYPE) {
        metadata ??= validateMetadata(value.claudeCode);
      }
    },
    { policy: "inspect" },
  );
  return metadata;
}

export function writeClaudeCodeSessionMetadata(
  sessionFile: string,
  metadata: ClaudeCodeSessionMetadata,
): void {
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  writeAtomicJson(`${sessionFile}.metadata.json`, metadata);
  fs.closeSync(fs.openSync(sessionFile, "a", 0o600));
}

export function appendClaudeCodeMessage(
  sessionFile: string | undefined,
  message: ObservedMessage,
  observation?: Omit<ClaudeCodeResultEvent, "result" | "structured_output">,
): void {
  if (!nonempty(sessionFile)) {
    return;
  }
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.appendFileSync(
    sessionFile,
    `${JSON.stringify({ type: "message_end", message, ...(observation ? { claudeCodeResult: observation } : {}) })}\n`,
    { mode: 0o600 },
  );
}

export function hasNonMetadataContent(sessionFile: string): boolean {
  if (!fs.existsSync(sessionFile)) {
    return false;
  }
  let content = false;
  scanJournal(
    sessionFile,
    (keys) => keys.length === 0 || (keys.length === 1 && keys[0] === "type"),
    ({ value }) => {
      if (value.type !== SESSION_EVENT_TYPE) {
        content = true;
      }
    },
    {
      policy: "inspect",
      malformed: () => {
        content = true;
      },
    },
  );
  return content;
}
