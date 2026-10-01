import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { stripAcceptanceReport } from "../runs/shared/acceptance-reports.ts";
import type { SubagentHistoryIndex, HistoryEntry, HistoryPage, HistoryPageInput } from "../history/index.ts";
import { extractToolArgsPreview } from "../shared/utils.ts";

export interface AgentHistoryItem {
	id: string;
	/** Native IDs combined into this message or tool card, including old standalone result IDs. */
	entryIds?: string[];
	kind: "user" | "assistant" | "thinking" | "tool" | "result" | "change" | "notice";
	title: string;
	text: string;
	details?: string;
	diff?: string;
	assistant?: AssistantMessage;
	model?: string;
	call?: ToolCall;
	result?: ToolResultMessage;
	messageId?: string;
	timestamp: number;
	/** Explicit detail request; normal history uses bounded previews. */
	load?: () => Promise<AgentHistoryItem>;
}

export interface AgentHistory {
	items: AgentHistoryItem[];
	/** Original entry order, independent of where paired tool results are drawn. */
	entryIds: string[];
	finalId?: string;
	findFinalResult?: (text: string) => string | undefined;
	/** Delivered human message IDs and whether a saved assistant reply follows them. */
	deliveredMessages?: Map<string, boolean>;
	configuration?: { model?: string; thinking?: string; modelRecordedAt?: number };
	unavailable?: string;
}

export function readableText(value: unknown): string {
	return stripTerminalSequences(typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "");
}

function contentText(content: unknown): string {
	if (typeof content === "string") return readableText(content);
	if (!Array.isArray(content)) return readableText(content);
	return content.map((part) => part.type === "text" ? readableText(part.text)
		: part.type === "thinking" ? readableText(part.thinking)
		: part.type === "image" ? `[Image: ${part.mimeType ?? "image"}]` : "").filter(Boolean).join("\n");
}

function resultDisplay(result: ToolResultMessage, call?: ToolCall) {
	const details = result.details as { diff?: unknown } | undefined;
	return { text: contentText(result.content), diff: typeof details?.diff === "string" ? readableText(details.diff) : undefined,
		details: readableText({ ...(call ? { call } : {}), result }) };
}

/** Keep reading/delivery facts eager; format bodies and raw tool details only when displayed. */
function historyItem(
	facts: Omit<AgentHistoryItem, "text" | "title">,
	format: () => Pick<AgentHistoryItem, "text" | "title" | "details" | "diff">,
): AgentHistoryItem {
	let display: ReturnType<typeof format> | undefined;
	return {
		...facts,
		get title() { return (display ??= format()).title; },
		get text() { return (display ??= format()).text; },
		get details() { return (display ??= format()).details; },
		get diff() { return (display ??= format()).diff; },
	};
}

/** Read the native entries, not a compacted model context: earlier messages remain inspectable. */
export function historyItems(entries: SessionEntry[]): AgentHistory {
	const items: AgentHistoryItem[] = [], entryIds: string[] = [];
	const calls = new Map<string, AgentHistoryItem>();
	const append = (item: AgentHistoryItem) => { items.push(item); entryIds.push(item.id); };
	for (const entry of entries) {
		const base = { id: entry.id, timestamp: Date.parse(entry.timestamp) };
		if (entry.type === "custom_message") {
			const details = entry.details as { bodyText?: string; message?: { id?: string }; from?: { name?: string } } | undefined;
			const human = entry.customType === "subagent-human-message";
			append(historyItem({ ...base, kind: human ? "user" : "notice", ...(human ? { messageId: details?.message?.id } : {}) },
				() => ({ title: human ? "User · delivered to conversation" : details?.from?.name ? `From ${details.from.name}` : entry.customType, text: contentText(details?.bodyText ?? entry.content) })));
		} else if (entry.type === "compaction") {
			append(historyItem({ ...base, kind: "notice" }, () => ({ title: "Context summary · earlier history retained above", text: readableText(entry.summary) })));
		} else if (entry.type === "branch_summary") {
			append(historyItem({ ...base, kind: "notice" }, () => ({ title: "Branch summary", text: readableText(entry.summary) })));
		} else if (entry.type === "message") {
			const message = entry.message;
			if (message.role === "assistant") {
				const model = message.model ? (message.provider ? `${message.provider}/${message.model}` : message.model) : undefined;
				const messageIds = message.content.flatMap((part, index) => part.type === "text" && part.text || part.type === "thinking" && part.thinking ? [`${entry.id}:${index}`] : []);
				if (messageIds.length) items.push(historyItem({ ...base, id: messageIds[0]!, entryIds: messageIds,
					kind: message.content.some((part) => part.type === "text" && part.text) ? "assistant" : "thinking",
					assistant: message, model }, () => ({ title: "Agent", text: contentText(message.content) })));
				for (const [index, part] of message.content.entries()) {
					const id = `${entry.id}:${index}`;
					if (part.type === "toolCall") {
						const item = historyItem({ ...base, id, entryIds: [id], kind: "tool", call: part, model }, () => ({
							title: `${part.name} ${extractToolArgsPreview(part.arguments ?? {})}`.trim() + (item.result ? ` · ${item.result.isError ? "failed" : "result recorded"}` : " · result not recorded"),
							...(item.result ? resultDisplay(item.result, part) : {
								text: readableText(part.arguments),
								details: `${readableText(part)}\n\nCommand result not recorded; exit is unconfirmed. An agent pause or exit does not prove that a command or its descendants exited.`,
							}),
						}));
						append(item); calls.set(part.id, item);
					} else if (messageIds.includes(id)) entryIds.push(id);
				}
				if (message.errorMessage) {
					const id = `${entry.id}:error`;
					if (messageIds.length && !message.content.some((part) => part.type === "toolCall") && ["error", "aborted"].includes(message.stopReason)) { messageIds.push(id); entryIds.push(id); }
					else append(historyItem({ ...base, id, kind: "notice", model }, () => ({ title: "Agent error", text: readableText(message.errorMessage) })));
				}
			} else if (message.role === "user") {
				append(historyItem({ ...base, kind: "user" }, () => ({ title: "User / assignment", text: contentText(message.content) })));
			} else if (message.role === "toolResult") {
				const call = calls.get(message.toolCallId);
				if (call) {
					call.result = message;
					call.entryIds!.push(entry.id); entryIds.push(entry.id);
				} else append(historyItem({ ...base, result: message, kind: "result" }, () => ({
					title: `${message.toolName} · call not recorded`, ...resultDisplay(message),
				})));
			} else if (message.role === "bashExecution") {
				append(historyItem({ ...base, kind: "tool" }, () => ({ title: `Shell: ${readableText(message.command)}`, text: `${readableText(message.output)}\n${typeof message.exitCode === "number" ? `Shell exit code: ${message.exitCode}` : "Shell exit code not recorded"}${message.cancelled ? " · cancelled" : ""}`, details: readableText({ command: message.command, exitCode: message.exitCode, cancelled: message.cancelled }) })));
			}
		}
	}
	let finalResults: Map<string, string> | undefined;
	return { items, entryIds, findFinalResult(text) {
		// Continuations can share a large journal. Index exact, sanitized matches once,
		// retaining the latest assistant ID just as findLast does.
		if (!finalResults) {
			finalResults = new Map();
			for (const item of items) if (item.kind === "assistant") {
				finalResults.set(stripAcceptanceReport(item.text).trim(), item.id);
				for (const part of item.assistant?.content ?? []) if (part.type === "text") finalResults.set(stripAcceptanceReport(readableText(part.text)).trim(), item.id);
			}
		}
		return finalResults.get(text);
	} };
}

/** Canonical run output is already validated; never decode arbitrary tool JSON to find an answer. */
export function withFinalResult(history: AgentHistory, output: string, runId: string, timestamp: number): AgentHistory {
	const text = readableText(output).trim();
	if (!text) return history;
	const existing = history.finalId ?? (history.findFinalResult ? history.findFinalResult(text) : history.items.findLast((item) => item.kind === "assistant" && (stripAcceptanceReport(item.text).trim() === text
		|| item.assistant?.content.some((part) => part.type === "text" && stripAcceptanceReport(readableText(part.text)).trim() === text)))?.id);
	const id = `result:${runId}`;
	let items: AgentHistoryItem[] | undefined;
	return { get items() { return items ??= existing ? history.items.map((item) => item.id === existing ? { ...item, assistant: undefined, text } : item) : [...history.items, { id, kind: "assistant", title: "Saved result", text, timestamp }]; },
		entryIds: existing ? history.entryIds : [...history.entryIds, id], finalId: existing ?? id,
		findFinalResult: existing ? history.findFinalResult : (value) => value === text ? id : history.findFinalResult?.(value),
		deliveredMessages: existing ? history.deliveredMessages : history.deliveredMessages && new Map([...history.deliveredMessages.keys()].map((id) => [id, true])),
		configuration: history.configuration, get unavailable() { return history.unavailable; } };
}

/** A page retains only bounded previews; full selected records are validated by the process. */
export async function indexedHistory(index: SubagentHistoryIndex, input: HistoryPageInput): Promise<{ history: AgentHistory; page: HistoryPage }> {
	const page = await index.historyPage(input);
	const entries = new Map(page.entries.map((entry) => [entry.id, entry]));
	const boundary = { terminalEntryId: input.terminalEntryId, endedAt: input.endedAt };
	if (input.terminalEntryId && page.terminalSequence === undefined) throw new Error("Saved terminal entry is unavailable; retry history.");
	const inBoundary = (entry: HistoryEntry) => (page.terminalSequence === undefined || entry.sequence <= page.terminalSequence) && (input.endedAt === undefined || (entry.timestamp ?? Infinity) <= input.endedAt);
	const tools = new Map<string, { call?: HistoryEntry; result?: HistoryEntry }>();
	for (const entry of page.entries) {
		const message = entry.entry.message;
		if (message?.role === "assistant") for (const part of message.content ?? []) {
			if (part.type === "toolCall") tools.set(part.id, { ...tools.get(part.id), call: entry });
		}
		else if (message?.role === "toolResult") tools.set(message.toolCallId, { ...tools.get(message.toolCallId), result: entry });
	}
	// Resolve only tools on this page, not the rest of the conversation. Adjacent-page
	// pairing preserves physical reading order and never becomes completion evidence.
	for (const entry of page.entries) {
		const message = entry.entry.message;
		const pairs: Array<{ toolCallId: string; kind: "call" | "result" }> = message?.role === "assistant" ? (message.content ?? []).filter((part: ToolCall) => part.type === "toolCall").map((part: ToolCall) => ({ toolCallId: part.id, kind: "result" as const }))
			: message?.role === "toolResult" ? [{ toolCallId: message.toolCallId, kind: "call" as const }] : [];
		for (const pair of pairs) {
			const paired = tools.get(pair.toolCallId)?.[pair.kind] ?? await index.entry({ runId: input.runId, index: input.index, ...pair, ...boundary, signal: input.signal });
			if (paired && inBoundary(paired)) entries.set(paired.id, paired);
		}
	}
	const history = historyItems([...entries.values()].sort((a, b) => a.sequence - b.sequence).map((entry) => entry.entry as SessionEntry));
	const visible = new Set(page.entries.map((entry) => entry.id));
	history.items = history.items.filter((item) => (item.entryIds ?? [item.id]).some((id) => visible.has(id.split(":")[0])));
	// Only page-local IDs advance the read marker; paired records can live elsewhere.
	history.entryIds = history.entryIds.filter((id) => visible.has(id.split(":")[0]));
	history.unavailable = page.unavailable;
	history.configuration = page.configuration;
	history.deliveredMessages = new Map(page.deliveredMessages);
	history.finalId = page.finalResultId;
	for (const item of history.items) item.load = async () => {
		const ids = new Set((item.entryIds ?? [item.id]).map((id) => id.split(":")[0]));
		const full: SessionEntry[] = [];
		for (const id of ids) {
			const entry = entries.get(id);
			if (!entry) throw new Error("Selected native entry is unavailable; retry history.");
			const record = await index.record({ runId: input.runId, index: input.index, ref: entry.ref, ...boundary, signal: input.signal });
			if (!record) throw new Error("Selected native entry is unavailable; retry history.");
			full.push({ ...record, id } as SessionEntry);
		}
		const detail = historyItems(full).items.find((candidate) => candidate.id === item.id);
		if (!detail) throw new Error("Selected native entry is unavailable; retry history.");
		return detail;
	};
	return { history, page };
}
