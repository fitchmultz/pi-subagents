import type {
  ActivityState,
  ControlEvent,
  ControlEventType,
  ControlNotificationChannel,
  ResolvedControlConfig,
  ReadonlyAsyncStatus,
} from "../../shared/types.ts";

import { formatRunAction } from "../../shared/status-format.ts";
import { readStatus } from "../../shared/utils.ts";
import { getRunMetadataDir } from "./supervisor-questions.ts";

export function isObsoleteIdleNotice(details: {
  readonly event: ControlEvent;
  readonly asyncDir?: string;
}): boolean {
  const event = details.event;
  if (event.reason !== "idle" || event.supervisorQuestion) {
    return false;
  }
  let status;
  try {
    status = readStatus(details.asyncDir ?? getRunMetadataDir(event.runId));
  } catch {
    // Without readable terminal evidence, retain the actionable notice.
    return false;
  }
  if (!status || status.runId !== event.runId) {
    return false;
  }
  return (
    ["complete", "failed", "blocked", "paused"].includes(status.state) ||
    hasTerminalChild(status, event.index)
  );
}

function hasTerminalChild(status: ReadonlyAsyncStatus, index: number | undefined): boolean {
  if (index === undefined) {
    return false;
  }
  const child = status.steps?.[index];
  return (
    child !== undefined &&
    ["complete", "completed", "failed", "blocked", "paused", "timed-out"].includes(child.status)
  );
}

const CONTROL_EVENT_TYPES: readonly ControlEventType[] = ["needs_attention"];
const CONTROL_NOTIFICATION_CHANNELS: readonly ControlNotificationChannel[] = [
  "event",
  "async",
  "intercom",
];
const DEFAULT_NOTIFY_ON: readonly ControlEventType[] = ["needs_attention"];

export const DEFAULT_CONTROL_CONFIG: ResolvedControlConfig = {
  enabled: true,
  needsAttentionAfterMs: 10 * 60_000,
  failedToolAttemptsBeforeAttention: 3,
  notifyOn: DEFAULT_NOTIFY_ON,
  notifyChannels: CONTROL_NOTIFICATION_CHANNELS,
};

function parsePositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number") {
    return undefined;
  }
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    return undefined;
  }
  return value;
}

function parseControlList<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  if (value.length === 0) {
    return [];
  }
  const entries: readonly unknown[] = value;
  const parsed = entries.filter(
    (entry): entry is T =>
      typeof entry === "string" && allowed.some((candidate) => candidate === entry),
  );
  return parsed.length > 0 ? Array.from(new Set(parsed)) : undefined;
}

export interface ControlConfigInput {
  readonly enabled?: boolean;
  readonly needsAttentionAfterMs?: unknown;
  readonly failedToolAttemptsBeforeAttention?: unknown;
  readonly notifyOn?: unknown;
  readonly notifyChannels?: unknown;
}

function parsedControlConfig(config: ControlConfigInput | undefined) {
  const input = config ?? {};
  return {
    enabled: input.enabled,
    needsAttentionAfterMs: parsePositiveInt(input.needsAttentionAfterMs),
    failedToolAttemptsBeforeAttention: parsePositiveInt(input.failedToolAttemptsBeforeAttention),
    notifyOn: parseControlList(input.notifyOn, CONTROL_EVENT_TYPES),
    notifyChannels: parseControlList(input.notifyChannels, CONTROL_NOTIFICATION_CHANNELS),
  };
}
function controlThresholds(
  global: Partial<
    Pick<ResolvedControlConfig, "needsAttentionAfterMs" | "failedToolAttemptsBeforeAttention">
  >,
  override: Partial<
    Pick<ResolvedControlConfig, "needsAttentionAfterMs" | "failedToolAttemptsBeforeAttention">
  >,
) {
  return {
    needsAttentionAfterMs:
      override.needsAttentionAfterMs ??
      global.needsAttentionAfterMs ??
      DEFAULT_CONTROL_CONFIG.needsAttentionAfterMs,
    failedToolAttemptsBeforeAttention:
      override.failedToolAttemptsBeforeAttention ??
      global.failedToolAttemptsBeforeAttention ??
      DEFAULT_CONTROL_CONFIG.failedToolAttemptsBeforeAttention,
  };
}

export function resolveControlConfig(
  globalConfig?: ControlConfigInput,
  overrideConfig?: ControlConfigInput,
): ResolvedControlConfig {
  const global = parsedControlConfig(globalConfig);
  const override = parsedControlConfig(overrideConfig);
  const notifyOn = override.notifyOn ?? global.notifyOn ?? DEFAULT_CONTROL_CONFIG.notifyOn;
  const notifyChannels =
    override.notifyChannels ?? global.notifyChannels ?? DEFAULT_CONTROL_CONFIG.notifyChannels;
  return {
    enabled: override.enabled ?? global.enabled ?? DEFAULT_CONTROL_CONFIG.enabled,
    ...controlThresholds(global, override),
    notifyOn: [...notifyOn],
    notifyChannels: [...notifyChannels],
  };
}

export function deriveActivityState(input: {
  readonly config: ResolvedControlConfig;
  readonly startedAt: number;
  readonly lastActivityAt?: number;
  readonly now?: number;
}): ActivityState | undefined {
  if (!input.config.enabled) {
    return undefined;
  }
  const now = input.now ?? Date.now();
  const lastActivity = input.lastActivityAt ?? input.startedAt;
  const ageMs = Math.max(0, now - lastActivity);
  return ageMs > input.config.needsAttentionAfterMs ? "needs_attention" : undefined;
}

type ControlEventInput = Omit<ControlEvent, "type" | "ts" | "message" | "reason"> & {
  readonly type?: ControlEventType;
  readonly ts?: number;
  readonly message?: string;
  readonly reason?: ControlEvent["reason"];
  readonly lastActivityAt?: number;
};

function controlObservation(
  input: ControlEventInput,
  elapsedSeconds: number | undefined,
): string | undefined {
  if (input.currentTool !== undefined && input.currentTool !== "") {
    const duration =
      input.currentToolDurationMs === undefined
        ? ""
        : ` for ${Math.floor(input.currentToolDurationMs / 1000)}s`;
    const elapsed =
      elapsedSeconds === undefined ? "" : `; no observed output/events for ${elapsedSeconds}s`;
    return `${input.currentTool} still active${duration}${elapsed}`;
  }
  return elapsedSeconds === undefined ? undefined : `no observed activity for ${elapsedSeconds}s`;
}
function controlSignal(input: ControlEventInput): string {
  const question = input.supervisorQuestion;
  if (!question) {
    return `${input.agent} needs attention`;
  }
  return question.state === "awaiting_input"
    ? `Waiting for supervisor input (question ${question.questionId})`
    : `Supervisor answer saved for question ${question.questionId}; delivery unconfirmed`;
}
function controlMetrics(
  input: ControlEventInput,
  elapsedMs: number | undefined,
): Partial<ControlEvent> {
  return {
    ...(input.turns !== undefined ? { turns: input.turns } : {}),
    ...(input.tokens !== undefined ? { tokens: input.tokens } : {}),
    ...(input.toolCount !== undefined ? { toolCount: input.toolCount } : {}),
    ...(input.currentToolDurationMs !== undefined
      ? { currentToolDurationMs: input.currentToolDurationMs }
      : {}),
    ...(elapsedMs !== undefined ? { elapsedMs } : {}),
  };
}
function controlContext(input: ControlEventInput): Partial<ControlEvent> {
  return {
    ...((input.currentTool ?? "") !== "" ? { currentTool: input.currentTool } : {}),
    ...((input.currentPath ?? "") !== "" ? { currentPath: input.currentPath } : {}),
    ...((input.recentFailureSummary ?? "") !== ""
      ? { recentFailureSummary: input.recentFailureSummary }
      : {}),
    ...(input.supervisorQuestion ? { supervisorQuestion: input.supervisorQuestion } : {}),
  };
}

function controlElapsed(input: ControlEventInput, ts: number): number | undefined {
  return (
    input.elapsedMs ??
    (input.lastActivityAt !== undefined ? Math.max(0, ts - input.lastActivityAt) : undefined)
  );
}
export function buildControlEvent(input: ControlEventInput): ControlEvent {
  const ts = input.ts ?? Date.now();
  const elapsedMs = controlElapsed(input, ts);
  const observation = controlObservation(
    input,
    elapsedMs === undefined ? undefined : Math.floor(elapsedMs / 1000),
  );
  const message =
    input.message ??
    `${controlSignal(input)}${observation === undefined ? "" : ` (${observation})`}`;
  return {
    type: input.type ?? "needs_attention",
    ...(input.from !== undefined ? { from: input.from } : {}),
    to: input.to,
    ts,
    runId: input.runId,
    agent: input.agent,
    ...(input.index !== undefined ? { index: input.index } : {}),
    message,
    reason: input.reason ?? "idle",
    ...controlMetrics(input, elapsedMs),
    ...controlContext(input),
  };
}

export { shouldNotifyControlEvent, controlNotificationKey } from "./control-event-policy.ts";
export { claimControlNotification } from "./control-notification-owner.ts";

function failureNotice(event: ControlEvent, childIntercomTarget: string | undefined): string {
  return [
    `Subagent failed: ${event.agent}`,
    `Run: ${event.runId}${event.index !== undefined ? ` step ${event.index + 1}` : ""}`,
    `Signal: ${event.message}`,
    "Next: read the output artifact or session from the subagent result, then retry with a more explicit implementation prompt or handle the fix directly.",
    childIntercomTarget !== undefined && childIntercomTarget !== ""
      ? `Run intercom target (may be inactive): ${childIntercomTarget}`
      : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function questionNotice(event: ControlEvent, childSafe: boolean): string[] {
  const question = event.supervisorQuestion;
  if (!question) {
    return [];
  }
  return [
    `Question ID: ${question.questionId}`,
    question.state === "answer_pending"
      ? "The saved answer has not been confirmed delivered. Inspect the child and retry the same answer; do not assume it resumed."
      : "Answer the saved question so the child can continue.",
    `Questions: ${formatRunAction("questions", event.runId, {}, childSafe)}`,
    `Answer: ${formatRunAction("answer", event.runId, { questionId: question.questionId, message: question.answer ?? "..." }, childSafe)}`,
  ];
}

function liveNotice(
  event: ControlEvent,
  childIntercomTarget: string | undefined,
  childSafe: boolean,
): string[] {
  const nudgeCommand = formatRunAction(
    "nudge",
    event.runId,
    {
      ...(event.index !== undefined ? { index: event.index } : {}),
      message:
        "What are you blocked on? Reply with the smallest next step, or state the exact decision you need.",
    },
    childSafe,
  );
  const ask =
    childIntercomTarget !== undefined && childIntercomTarget !== ""
      ? `Ask (blocking wait only; parent must remain alive): intercom({ action: "ask", to: "${childIntercomTarget}", delivery: "steer", message: "What are you blocked on? Reply with the smallest next step, or state the exact decision you need." })`
      : "Ask (blocking wait only): no child message route registered";
  return [
    event.reason === "idle" && (event.currentTool ?? "") !== ""
      ? "Hint: Inspect command progress. A long-running tool may still be running or hung; elapsed time alone does not prove either."
      : "Hint: Inspect status first unless the run is clearly blocked.",
    `Nudge (preferred live coordination): ${nudgeCommand}`,
    ask,
  ];
}

export function formatControlNoticeMessage(
  event: ControlEvent,
  childIntercomTarget?: string,
  childSafe = false,
): string {
  if (event.reason === "completion_guard") {
    return failureNotice(event, childIntercomTarget);
  }
  return [
    `Subagent needs attention: ${event.agent}`,
    `Run: ${event.runId}${event.index !== undefined ? ` step ${event.index + 1}` : ""}`,
    `Signal: ${event.message}`,
    (event.recentFailureSummary ?? "") !== ""
      ? `Recent failures: ${event.recentFailureSummary ?? ""}`
      : undefined,
    ...(event.supervisorQuestion
      ? questionNotice(event, childSafe)
      : liveNotice(event, childIntercomTarget, childSafe)),
    `Status: ${formatRunAction("status", event.runId, {}, childSafe)}`,
    `${childSafe ? "Interrupt" : "Stop"}: ${formatRunAction("interrupt", event.runId, {}, childSafe)}`,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

export function formatControlIntercomMessage(
  event: ControlEvent,
  childIntercomTarget?: string,
  childSafe = false,
): string {
  const statusLabel =
    event.reason === "completion_guard" ? "subagent failed" : "subagent needs attention";
  return [
    statusLabel,
    "",
    event.reason === "completion_guard"
      ? `${event.agent} failed in run ${event.runId}.`
      : `${event.agent} needs attention in run ${event.runId}.`,
    "",
    formatControlNoticeMessage(event, childIntercomTarget, childSafe),
  ].join("\n");
}
