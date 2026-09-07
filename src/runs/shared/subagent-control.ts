import {
	type ActivityState,
	type ControlConfig,
	type ControlEvent,
	type ControlEventType,
	type ControlNotificationChannel,
	type ResolvedControlConfig,
} from "../../shared/types.ts";

import { formatRunAction } from "../../shared/status-format.ts";

const CONTROL_EVENT_TYPES: ControlEventType[] = ["needs_attention"];
const CONTROL_NOTIFICATION_CHANNELS: ControlNotificationChannel[] = ["event", "async", "intercom"];
const DEFAULT_NOTIFY_ON: ControlEventType[] = ["needs_attention"];

export const DEFAULT_CONTROL_CONFIG: ResolvedControlConfig = {
	enabled: true,
	needsAttentionAfterMs: 10 * 60_000,
	failedToolAttemptsBeforeAttention: 3,
	notifyOn: DEFAULT_NOTIFY_ON,
	notifyChannels: CONTROL_NOTIFICATION_CHANNELS,
};

function parsePositiveInt(value: unknown): number | undefined {
	if (typeof value !== "number") return undefined;
	if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) return undefined;
	return value;
}

function parseControlList<T extends string>(value: unknown, allowed: readonly T[]): T[] | undefined {
	if (!Array.isArray(value)) return undefined;
	if (value.length === 0) return [];
	const allowedSet = new Set(allowed);
	const parsed = value.filter((entry): entry is T => typeof entry === "string" && allowedSet.has(entry as T));
	return parsed.length > 0 ? Array.from(new Set(parsed)) : undefined;
}

export function resolveControlConfig(
	globalConfig?: ControlConfig,
	override?: ControlConfig,
): ResolvedControlConfig {
	const enabled = override?.enabled ?? globalConfig?.enabled ?? DEFAULT_CONTROL_CONFIG.enabled;
	const needsAttentionAfterMs = parsePositiveInt(override?.needsAttentionAfterMs)
		?? parsePositiveInt(globalConfig?.needsAttentionAfterMs)
		?? DEFAULT_CONTROL_CONFIG.needsAttentionAfterMs;
	const failedToolAttemptsBeforeAttention = parsePositiveInt(override?.failedToolAttemptsBeforeAttention)
		?? parsePositiveInt(globalConfig?.failedToolAttemptsBeforeAttention)
		?? DEFAULT_CONTROL_CONFIG.failedToolAttemptsBeforeAttention;
	const notifyOn = parseControlList(override?.notifyOn, CONTROL_EVENT_TYPES)
		?? parseControlList(globalConfig?.notifyOn, CONTROL_EVENT_TYPES)
		?? DEFAULT_CONTROL_CONFIG.notifyOn;
	const notifyChannels = parseControlList(override?.notifyChannels, CONTROL_NOTIFICATION_CHANNELS)
		?? parseControlList(globalConfig?.notifyChannels, CONTROL_NOTIFICATION_CHANNELS)
		?? DEFAULT_CONTROL_CONFIG.notifyChannels;
	return {
		enabled,
		needsAttentionAfterMs,
		failedToolAttemptsBeforeAttention,
		notifyOn: [...notifyOn],
		notifyChannels: [...notifyChannels],
	};
}

export function deriveActivityState(input: {
	config: ResolvedControlConfig;
	startedAt: number;
	lastActivityAt?: number;
	now?: number;
}): ActivityState | undefined {
	if (!input.config.enabled) return undefined;
	const now = input.now ?? Date.now();
	const lastActivity = input.lastActivityAt ?? input.startedAt;
	const ageMs = Math.max(0, now - lastActivity);
	return ageMs > input.config.needsAttentionAfterMs ? "needs_attention" : undefined;
}

export function buildControlEvent(input: {
	type?: ControlEventType;
	from?: ActivityState;
	to: ActivityState;
	runId: string;
	agent: string;
	index?: number;
	ts?: number;
	lastActivityAt?: number;
	message?: string;
	reason?: ControlEvent["reason"];
	turns?: number;
	tokens?: number;
	toolCount?: number;
	currentTool?: string;
	currentToolDurationMs?: number;
	currentPath?: string;
	elapsedMs?: number;
	recentFailureSummary?: string;
	supervisorQuestion?: ControlEvent["supervisorQuestion"];
}): ControlEvent {
	const ts = input.ts ?? Date.now();
	const type = input.type ?? "needs_attention";
	const elapsedMs = input.elapsedMs ?? (input.lastActivityAt !== undefined ? Math.max(0, ts - input.lastActivityAt) : undefined);
	const elapsedSeconds = elapsedMs !== undefined ? Math.floor(elapsedMs / 1000) : undefined;
	const question = input.supervisorQuestion;
	const observation = input.currentTool
		? `${input.currentTool} still active${input.currentToolDurationMs !== undefined ? ` for ${Math.floor(input.currentToolDurationMs / 1000)}s` : ""}${elapsedSeconds !== undefined ? `; no observed output/events for ${elapsedSeconds}s` : ""}`
		: elapsedSeconds !== undefined ? `no observed activity for ${elapsedSeconds}s` : undefined;
	const signal = question
		? question.state === "awaiting_input" ? `Waiting for supervisor input (question ${question.questionId})` : `Supervisor answer saved for question ${question.questionId}; delivery unconfirmed`
		: `${input.agent} needs attention`;
	const message = input.message ?? `${signal}${observation ? ` (${observation})` : ""}`;
	return {
		type,
		...(input.from ? { from: input.from } : {}),
		to: input.to,
		ts,
		runId: input.runId,
		agent: input.agent,
		...(input.index !== undefined ? { index: input.index } : {}),
		message,
		reason: input.reason ?? "idle",
		...(input.turns !== undefined ? { turns: input.turns } : {}),
		...(input.tokens !== undefined ? { tokens: input.tokens } : {}),
		...(input.toolCount !== undefined ? { toolCount: input.toolCount } : {}),
		...(input.currentTool ? { currentTool: input.currentTool } : {}),
		...(input.currentToolDurationMs !== undefined ? { currentToolDurationMs: input.currentToolDurationMs } : {}),
		...(input.currentPath ? { currentPath: input.currentPath } : {}),
		...(elapsedMs !== undefined ? { elapsedMs } : {}),
		...(input.recentFailureSummary ? { recentFailureSummary: input.recentFailureSummary } : {}),
		...(question ? { supervisorQuestion: question } : {}),
	};
}

export function shouldNotifyControlEvent(config: ResolvedControlConfig, event: ControlEvent): boolean {
	return config.enabled && config.notifyOn.includes(event.type);
}

export function controlNotificationKey(event: ControlEvent, childIntercomTarget?: string): string {
	const childKey = childIntercomTarget ?? (event.index !== undefined ? `${event.runId}:${event.index}` : event.runId);
	return `${childKey}:${event.type}:${event.reason ?? "idle"}`;
}

export function claimControlNotification(config: ResolvedControlConfig, event: ControlEvent, seenKeys: Set<string>, childIntercomTarget?: string): boolean {
	if (!shouldNotifyControlEvent(config, event)) return false;
	const key = controlNotificationKey(event, childIntercomTarget);
	if (seenKeys.has(key)) return false;
	seenKeys.add(key);
	return true;
}

export function formatControlNoticeMessage(event: ControlEvent, childIntercomTarget?: string, childSafe = false): string {
	const runTarget = event.runId;
	if (event.reason === "completion_guard") {
		return [
			`Subagent failed: ${event.agent}`,
			`Run: ${runTarget}${event.index !== undefined ? ` step ${event.index + 1}` : ""}`,
			`Signal: ${event.message}`,
			"Next: read the output artifact or session from the subagent result, then retry with a more explicit implementation prompt or handle the fix directly.",
			childIntercomTarget ? `Run intercom target (may be inactive): ${childIntercomTarget}` : undefined,
		].filter((line): line is string => Boolean(line)).join("\n");
	}

	const nudgeCommand = formatRunAction("nudge", runTarget, { ...(event.index !== undefined ? { index: event.index } : {}), message: "What are you blocked on? Reply with the smallest next step, or state the exact decision you need." }, childSafe);
	const question = event.supervisorQuestion;
	const askCommand = childIntercomTarget
		? `intercom({ action: "ask", to: "${childIntercomTarget}", delivery: "steer", message: "What are you blocked on? Reply with the smallest next step, or state the exact decision you need." })`
		: undefined;
	return [
		`Subagent needs attention: ${event.agent}`,
		`Run: ${runTarget}${event.index !== undefined ? ` step ${event.index + 1}` : ""}`,
		`Signal: ${event.message}`,
		event.recentFailureSummary ? `Recent failures: ${event.recentFailureSummary}` : undefined,
		...(question ? [
			`Question ID: ${question.questionId}`,
			question.state === "answer_pending" ? "The saved answer has not been confirmed delivered. Inspect the child and retry the same answer; do not assume it resumed." : "Answer the saved question so the child can continue.",
			`Questions: ${formatRunAction("questions", runTarget, {}, childSafe)}`,
			`Answer: ${formatRunAction("answer", runTarget, { questionId: question.questionId, message: question.answer ?? "..." }, childSafe)}`,
		] : [
			event.reason === "idle" && event.currentTool ? "Hint: Inspect command progress. A long-running tool may still be running or hung; elapsed time alone does not prove either." : "Hint: Inspect status first unless the run is clearly blocked.",
			`Nudge (preferred live coordination): ${nudgeCommand}`,
			childIntercomTarget
				? `Ask (blocking wait only; parent must remain alive): ${askCommand}`
				: "Ask (blocking wait only): no child message route registered",
		]),
		`Status: ${formatRunAction("status", runTarget, {}, childSafe)}`,
		`${childSafe ? "Interrupt" : "Stop"}: ${formatRunAction("interrupt", runTarget, {}, childSafe)}`,
	].filter((line): line is string => Boolean(line)).join("\n");
}

export function formatControlIntercomMessage(event: ControlEvent, childIntercomTarget?: string, childSafe = false): string {
	const statusLabel = event.reason === "completion_guard"
		? "subagent failed"
		: "subagent needs attention";
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
