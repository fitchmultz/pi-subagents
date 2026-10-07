/** Subagent completion notifications. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildCompletionKey, getGlobalSeenMap, markSeenWithTtl } from "./completion-dedupe.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT } from "../../shared/types.ts";
import { hasText, isRecord } from "./async-value.ts";
import type { ReadonlyInput } from "../../shared/types/inputs.ts";

export interface SubagentNotifyDetails {
  readonly completion?: { readonly runId: string; readonly key: string };
  readonly agent: string;
  readonly status: "completed" | "failed" | "blocked" | "paused";
  readonly taskInfo?: string;
  readonly resultPreview: string;
  readonly durationMs?: number;
  readonly sessionLabel?: string;
  readonly sessionValue?: string;
}

interface SubagentResult {
  readonly id?: string | null;
  readonly runId?: string;
  readonly completionId?: string;
  readonly completionKey?: string;
  readonly agent?: string | null;
  readonly success?: boolean;
  readonly summary?: string;
  readonly exitCode?: number;
  readonly state?: string;
  readonly timestamp?: number;
  readonly durationMs?: number;
  readonly sessionFile?: string;
  readonly shareUrl?: string;
  readonly shareError?: string;
  readonly taskIndex?: number;
  readonly totalTasks?: number;
  readonly intercomResultDelivered?: boolean;
  readonly suppressNotification?: boolean;
}

function isResult(value: unknown): value is SubagentResult {
  if (!isRecord(value)) {
    return false;
  }
  const strings = [
    "runId",
    "completionId",
    "completionKey",
    "summary",
    "state",
    "sessionFile",
    "shareUrl",
    "shareError",
  ];
  const numbers = ["exitCode", "timestamp", "durationMs", "taskIndex", "totalTasks"];
  return (
    strings.every((key) => value[key] === undefined || typeof value[key] === "string") &&
    numbers.every((key) => value[key] === undefined || typeof value[key] === "number") &&
    ["id", "agent"].every(
      (key) => value[key] === undefined || value[key] === null || typeof value[key] === "string",
    ) &&
    ["success", "intercomResultDelivered", "suppressNotification"].every(
      (key) => value[key] === undefined || typeof value[key] === "boolean",
    )
  );
}

function notificationStatus(
  result: SubagentResult,
  summary: string,
): SubagentNotifyDetails["status"] {
  if (result.state === "blocked") {
    return "blocked";
  }
  if (
    result.success !== true &&
    (result.exitCode === 0 ||
      result.state === "paused" ||
      summary.startsWith("Paused after interrupt."))
  ) {
    return "paused";
  }
  return result.success === true ? "completed" : "failed";
}

function sessionLine(result: SubagentResult): string | undefined {
  if (hasText(result.shareUrl)) {
    return `Session: ${result.shareUrl}`;
  }
  if (hasText(result.shareError)) {
    return `Session share error: ${result.shareError}`;
  }
  return hasText(result.sessionFile) ? `Session file: ${result.sessionFile}` : undefined;
}

function taskLabel(result: SubagentResult): string {
  return result.taskIndex !== undefined && result.totalTasks !== undefined
    ? ` (${result.taskIndex + 1}/${result.totalTasks})`
    : "";
}

function buildNotification(result: SubagentResult): {
  readonly customType: string;
  readonly content: string;
  readonly display: boolean;
  readonly details?: SubagentNotifyDetails;
} {
  const agent = result.agent ?? "unknown";
  const summary = result.summary ?? "";
  const status = notificationStatus(result, summary);
  const taskInfo = taskLabel(result);
  const session = sessionLine(result);
  const displaySummary = summary.trim().length > 0 ? summary : "(no output)";
  const content = [
    `Background task ${status}: **${agent}**${taskInfo}`,
    "",
    displaySummary,
    hasText(session) ? "" : undefined,
    session,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
  const details: SubagentNotifyDetails | undefined =
    hasText(result.runId) && hasText(result.completionKey)
      ? {
          agent,
          status,
          taskInfo: taskInfo.trim(),
          resultPreview: displaySummary.trim(),
          ...(hasText(session)
            ? {
                sessionLabel: session.slice(0, session.indexOf(":")).toLowerCase(),
                sessionValue: session.slice(session.indexOf(":") + 1).trim(),
              }
            : {}),
          completion: { runId: result.runId, key: result.completionKey },
        }
      : undefined;
  return { customType: "subagent-notify", content, display: true, ...(details ? { details } : {}) };
}

function isUnsubscribe(value: unknown): value is () => void {
  return typeof value === "function";
}

export default function registerSubagentNotify(
  pi: ReadonlyInput<ExtensionAPI>,
  onQueued?: (completionKey: string, runId?: string) => void,
): () => void {
  const unsubscribeStoreKey = "__pi_subagents_notify_unsubscribe__";
  const globalStore = globalThis as Record<string, unknown>;
  const previousUnsubscribe = globalStore[unsubscribeStoreKey];
  if (isUnsubscribe(previousUnsubscribe)) {
    try {
      previousUnsubscribe();
    } catch {
      // Best effort cleanup for stale handlers from an older reload.
    }
  }
  const seen = getGlobalSeenMap("__pi_subagents_notify_seen__");
  const handleComplete = (data: unknown): void => {
    if (
      !isResult(data) ||
      data.intercomResultDelivered === true ||
      data.suppressNotification === true
    ) {
      return;
    }
    const key = buildCompletionKey(data, "notify");
    // Owned completion keys are governed by the shared queue/journal lifecycle, not a TTL.
    if (
      (onQueued === undefined || !hasText(data.completionKey)) &&
      markSeenWithTtl(seen, key, Date.now(), 10 * 60 * 1000)
    ) {
      return;
    }
    pi.sendMessage(buildNotification(data), { triggerTurn: true });
    if (hasText(data.completionKey)) {
      onQueued?.(data.completionKey, data.runId);
    }
  };
  const unsubscribe = pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, handleComplete);
  globalStore[unsubscribeStoreKey] = unsubscribe;
  return unsubscribe;
}
