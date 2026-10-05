/** Public compatibility barrel. Domain contracts depend on each other, never on implementation modules. */
import * as os from "node:os";
import * as path from "node:path";
import type { MaxOutputConfig } from "./types/config.ts";
import type { TruncationResult } from "./types/results.ts";

export type * from "./types/inputs.ts";
export type * from "./types/config.ts";
export type * from "./types/acceptance.ts";
export type * from "./types/launch.ts";
export type * from "./types/workflow.ts";
export type * from "./types/messages.ts";
export type * from "./types/usage.ts";
export type * from "./types/progress.ts";
export type * from "./types/results.ts";
export type * from "./types/nested.ts";
export type * from "./types/owned-runs.ts";
export type * from "./types/async.ts";
export type * from "./types/questions.ts";
export type * from "./types/history.ts";
export type * from "./types/state.ts";
export type * from "./types/details.ts";
export type * from "./types/intercom.ts";

export const INTERCOM_DETACH_REQUEST_EVENT = "pi-intercom:detach-request";
export const INTERCOM_DETACH_RESPONSE_EVENT = "pi-intercom:detach-response";
export const SUBAGENT_ASYNC_STARTED_EVENT = "subagent:async-started";
export const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";
export const SUBAGENT_CONTROL_EVENT = "subagent:control-event";
export const SUBAGENT_CONTROL_INTERCOM_EVENT = "subagent:control-intercom";
export const SUBAGENT_RESULT_INTERCOM_EVENT = "subagent:result-intercom";
export const SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT = "subagent:result-intercom-delivery";
export const SUBAGENT_LIVE_INTERCOM_EVENT = "subagent:live-intercom";
export const SUBAGENT_LIVE_INTERCOM_DELIVERY_EVENT = "subagent:live-intercom-delivery";
export const SUBAGENT_INTERCOM_HEALTH_REQUEST_EVENT = "subagent:intercom-health-request";
export const SUBAGENT_INTERCOM_HEALTH_RESPONSE_EVENT = "subagent:intercom-health-response";
export const SUBAGENT_INTERCOM_IDENTITY_REQUEST_EVENT = "subagent:intercom-identity-request";
export const SUBAGENT_INTERCOM_IDENTITY_RESPONSE_EVENT = "subagent:intercom-identity-response";

// Constants
// ============================================================================

export const DEFAULT_MAX_OUTPUT: Required<MaxOutputConfig> = {
  bytes: 200 * 1024,
  lines: 5000,
};

function sanitizeTempScopeSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "unknown";
}

export function resolveTempScopeId(): string {
  if (typeof process.getuid === "function") {
    return `uid-${process.getuid()}`;
  }

  for (const key of ["USERNAME", "USER", "LOGNAME"] as const) {
    const value = process.env[key];
    if (value) {
      return `user-${sanitizeTempScopeSegment(value)}`;
    }
  }

  try {
    const username = os.userInfo().username;
    if (username) {
      return `user-${sanitizeTempScopeSegment(username)}`;
    }
  } catch {
    // Fall through to home-directory-based scoping.
  }

  const homedir = process.env.HOME;
  if (homedir) {
    return `home-${sanitizeTempScopeSegment(homedir)}`;
  }

  try {
    const fallbackHomedir = os.homedir();
    if (fallbackHomedir) {
      return `home-${sanitizeTempScopeSegment(fallbackHomedir)}`;
    }
  } catch {
    // Fall through to the last-resort shared scope.
  }

  return "shared";
}

const MAX_PARALLEL = 8;
export const MAX_CONCURRENCY = 4;

export function resolveTempRootDir(configured = process.env.PI_SUBAGENT_TEMP_ROOT): string {
  const fallback = path.join(os.tmpdir(), `pi-subagents-${resolveTempScopeId()}`);
  if (!configured?.trim()) {
    return fallback;
  }
  const resolved = path.resolve(configured);
  if (!path.basename(resolved).startsWith("pi-subagents-")) {
    throw new Error("PI_SUBAGENT_TEMP_ROOT must name a dedicated 'pi-subagents-*' directory.");
  }
  return resolved;
}

export const TEMP_ROOT_DIR = resolveTempRootDir();
export const RESULTS_DIR = path.join(TEMP_ROOT_DIR, "async-subagent-results");
export const ASYNC_DIR = path.join(TEMP_ROOT_DIR, "async-subagent-runs");
export const RUNNER_ERROR_LOG_FILE = "runner-error.log";
export const CHAIN_RUNS_DIR = path.join(TEMP_ROOT_DIR, "chain-runs");
export const TEMP_ARTIFACTS_DIR = path.join(TEMP_ROOT_DIR, "artifacts");
export const WIDGET_KEY = "subagent-async";
export const SLASH_RESULT_TYPE = "subagent-slash-result";
export const SLASH_SUBAGENT_REQUEST_EVENT = "subagent:slash:request";
export const SLASH_SUBAGENT_STARTED_EVENT = "subagent:slash:started";
export const SLASH_SUBAGENT_RESPONSE_EVENT = "subagent:slash:response";
export const SLASH_SUBAGENT_UPDATE_EVENT = "subagent:slash:update";
export const SLASH_SUBAGENT_CANCEL_EVENT = "subagent:slash:cancel";
export const POLL_INTERVAL_MS = 1000;
export const MAX_WIDGET_JOBS = 4;
export const DEFAULT_SUBAGENT_MAX_DEPTH = 1;
export const SUBAGENT_ACTIONS = [
  "list",
  "get",
  "create",
  "update",
  "delete",
  "status",
  "history",
  "search",
  "interrupt",
  "extend",
  "resume",
  "nudge",
  "questions",
  "answer",
  "review",
  "doctor",
] as const;

export const DEFAULT_FORK_PREAMBLE =
  "You are a delegated subagent running from a fork of the parent session. " +
  "Treat the inherited conversation as reference-only context, not a live thread to continue. " +
  "Do not continue or answer prior messages as if they are waiting for a reply. " +
  "Your sole job is to execute the task below and return a focused result for that task using your tools.";

function normalizeTopLevelParallelValue(value: unknown): number | undefined {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(parsed) || parsed < 1) {
    return undefined;
  }
  return parsed;
}

export function resolveTopLevelParallelMaxTasks(value: unknown): number {
  return normalizeTopLevelParallelValue(value) ?? MAX_PARALLEL;
}

export function resolveTopLevelParallelConcurrency(
  override: unknown,
  configValue: unknown,
): number {
  return (
    normalizeTopLevelParallelValue(override) ??
    normalizeTopLevelParallelValue(configValue) ??
    MAX_CONCURRENCY
  );
}

export function getAsyncConfigPath(suffix: string): string {
  return path.join(TEMP_ROOT_DIR, `async-cfg-${suffix}.json`);
}

export function wrapForkTask(task: string, preamble?: string | false): string {
  if (preamble === false) {
    return task;
  }
  const effectivePreamble = preamble ?? DEFAULT_FORK_PREAMBLE;
  const wrappedPrefix = `${effectivePreamble}\n\nTask:\n`;
  if (task.startsWith(wrappedPrefix)) {
    return task;
  }
  return `${wrappedPrefix}${task}`;
}

// ============================================================================
// Recursion Depth Guard
// ============================================================================

export function normalizeMaxSubagentDepth(value: unknown): number | undefined {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(parsed) || parsed < 0) {
    return undefined;
  }
  return parsed;
}

export function resolveCurrentMaxSubagentDepth(configMaxDepth?: number): number {
  return (
    normalizeMaxSubagentDepth(process.env.PI_SUBAGENT_MAX_DEPTH) ??
    normalizeMaxSubagentDepth(configMaxDepth) ??
    DEFAULT_SUBAGENT_MAX_DEPTH
  );
}

export function resolveChildMaxSubagentDepth(
  parentMaxDepth: number,
  agentMaxDepth?: number,
): number {
  const normalizedParent = normalizeMaxSubagentDepth(parentMaxDepth) ?? DEFAULT_SUBAGENT_MAX_DEPTH;
  const normalizedAgent = normalizeMaxSubagentDepth(agentMaxDepth);
  return normalizedAgent === undefined
    ? normalizedParent
    : Math.min(normalizedParent, normalizedAgent);
}

function parseSubagentDepth(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return 0;
  }
  const depth = Number(value);
  return Number.isInteger(depth) && depth >= 0 ? depth : undefined;
}

export function checkSubagentDepth(configMaxDepth?: number): {
  blocked: boolean;
  depth: number;
  maxDepth: number;
} {
  const maxDepth = resolveCurrentMaxSubagentDepth(configMaxDepth);
  const depth = parseSubagentDepth(process.env.PI_SUBAGENT_DEPTH);
  if (depth === undefined) {
    return { blocked: true, depth: maxDepth, maxDepth };
  }
  return { blocked: depth >= maxDepth, depth, maxDepth };
}

export function getSubagentDepthEnv(maxDepth?: number): Record<string, string> {
  const childMaxDepth = normalizeMaxSubagentDepth(maxDepth) ?? resolveCurrentMaxSubagentDepth();
  const parentDepth = parseSubagentDepth(process.env.PI_SUBAGENT_DEPTH);
  const nextDepth = parentDepth === undefined ? childMaxDepth : parentDepth + 1;
  return {
    PI_SUBAGENT_DEPTH: String(nextDepth),
    PI_SUBAGENT_MAX_DEPTH: String(childMaxDepth),
  };
}

// ============================================================================
// Utility Functions
// ============================================================================

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function truncateOutput(
  output: string,
  config: Required<MaxOutputConfig>,
  artifactPath?: string,
): TruncationResult {
  const lines = output.split("\n");
  const bytes = Buffer.byteLength(output, "utf-8");

  if (bytes <= config.bytes && lines.length <= config.lines) {
    return { text: output, truncated: false };
  }

  let truncatedLines = lines;
  if (lines.length > config.lines) {
    truncatedLines = lines.slice(0, config.lines);
  }

  let result = truncatedLines.join("\n");
  if (Buffer.byteLength(result, "utf-8") > config.bytes) {
    let low = 0;
    let high = result.length;
    while (low < high) {
      const mid = Math.floor((low + high + 1) / 2);
      if (Buffer.byteLength(result.slice(0, mid), "utf-8") <= config.bytes) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    result = result.slice(0, low);
  }

  const keptLines = result.split("\n").length;
  const marker = `[TRUNCATED: showing first ${keptLines} of ${lines.length} lines, ${formatBytes(Buffer.byteLength(result))} of ${formatBytes(bytes)}${artifactPath ? ` - full output at ${artifactPath}` : ""}]\n`;

  return {
    text: marker + result,
    truncated: true,
    originalBytes: bytes,
    originalLines: lines.length,
    artifactPath,
  };
}
