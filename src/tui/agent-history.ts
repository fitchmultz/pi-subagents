import * as fs from "node:fs";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { FileEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { stripAcceptanceReport } from "../runs/shared/acceptance-reports.ts";
import { readNativeSessionConfiguration } from "../runs/shared/supervisor-questions.ts";
import { migrateSessionEntries, parseSessionEntries } from "../shared/native-session.ts";
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
}

export interface AgentHistory {
	items: AgentHistoryItem[];
	/** Original entry order, independent of where paired tool results are drawn. */
	entryIds: string[];
	finalId?: string;
	findFinalResult?: (text: string) => string | undefined;
	configuration?: ReturnType<typeof readNativeSessionConfiguration>;
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
							title: `${part.name} ${extractToolArgsPreview(part.arguments)}`.trim() + (item.result ? ` · ${item.result.isError ? "failed" : "result recorded"}` : " · result not recorded"),
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
	const existing = history.findFinalResult ? history.findFinalResult(text) : history.items.findLast((item) => item.kind === "assistant" && (stripAcceptanceReport(item.text).trim() === text
		|| item.assistant?.content.some((part) => part.type === "text" && stripAcceptanceReport(readableText(part.text)).trim() === text)))?.id;
	if (existing) return { ...history, finalId: existing };
	const id = `result:${runId}`;
	return { ...history, findFinalResult: undefined, finalId: id, items: [...history.items, { id, kind: "assistant", title: "Saved result", text, timestamp }], entryIds: [...history.entryIds, id] };
}

interface NativeSnapshot {
	stamp: string;
	entries: FileEntry[];
	history?: AgentHistory;
	configurations: Map<number | undefined, NonNullable<AgentHistory["configuration"]>>;
}

export class NativeAgentHistory {
	private cache = new Map<string, NativeSnapshot>();
	private seen = new Set<string>();

	private snapshot(sessionFile: string): NativeSnapshot {
		const stat = fs.statSync(sessionFile, { bigint: true });
		const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
		const cached = this.cache.get(sessionFile);
		if (cached?.stamp === stamp) return cached;
		this.cache.delete(sessionFile);
		const entries = parseSessionEntries(fs.readFileSync(sessionFile, "utf8"));
		if (entries[0]?.type !== "session") throw new Error("Not a readable native Pi session.");
		// Native migration mutates entries. Normalize the whole journal before any cutoff
		// can upgrade its shared header while leaving later legacy entries unmigrated.
		migrateSessionEntries(entries);
		const snapshot = { stamp, entries, configurations: new Map<number | undefined, NonNullable<AgentHistory["configuration"]>>() };
		this.cache.set(sessionFile, snapshot);
		this.seen.add(sessionFile);
		return snapshot;
	}

	configuration(sessionFile: string | undefined, endedAt?: number): NonNullable<AgentHistory["configuration"]> {
		if (!sessionFile) return {};
		try {
			const snapshot = this.snapshot(sessionFile);
			let configuration = snapshot.configurations.get(endedAt);
			if (!configuration) {
				configuration = readNativeSessionConfiguration(undefined, snapshot.entries, endedAt);
				snapshot.configurations.set(endedAt, configuration);
			}
			return configuration;
		} catch {
			this.cache.delete(sessionFile);
			return {};
		}
	}

	read(sessionFile: string | undefined, live = false): AgentHistory {
		if (!sessionFile) return { items: [], entryIds: [], ...(!live ? { unavailable: "The child has not saved a conversation yet. Its assignment and live status remain available." } : {}) };
		try {
			const snapshot = this.snapshot(sessionFile);
			return snapshot.history ??= { ...historyItems(snapshot.entries.filter((entry): entry is SessionEntry => entry.type !== "session")), configuration: this.configuration(sessionFile) };
		} catch (error) {
			this.cache.delete(sessionFile);
			// Native Pi writes a new session only after the first assistant message ends.
			if (live && !this.seen.has(sessionFile) && (error as NodeJS.ErrnoException).code === "ENOENT") return { items: [], entryIds: [] };
			return { items: [], entryIds: [], unavailable: `Saved conversation unavailable: ${sessionFile}\n${error instanceof Error ? error.message : String(error)}` };
		}
	}

	clear(): void { this.cache.clear(); this.seen.clear(); }
}
