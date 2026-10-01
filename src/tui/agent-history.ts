import * as fs from "node:fs";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { stripAcceptanceReport } from "../runs/shared/acceptance-reports.ts";
import { NativeJournal, journalStamp } from "../shared/journal-reader.ts";
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
	load?: () => AgentHistoryItem;
}

export interface AgentHistory {
	items: AgentHistoryItem[];
	/** Original entry order, independent of where paired tool results are drawn. */
	entryIds: string[];
	finalId?: string;
	findFinalResult?: (text: string) => string | undefined;
	/** Delivered human message IDs and whether a saved assistant reply follows them. */
	deliveredMessages?: Map<string, boolean>;
	configuration?: ReturnType<NativeJournal["configuration"]>;
	unavailable?: string;
}

/** Reading/delivery markers need neither history cards nor timestamp/body formatting. */
function historyMetadata(entries: SessionEntry[]): Pick<AgentHistory, "entryIds" | "deliveredMessages" | "findFinalResult"> {
	const entryIds: string[] = [], delivered = new Map<string, number>();
	let lastReply = -1, finalResults: Map<string, string> | undefined;
	for (const [index, entry] of entries.entries()) {
		if (["custom_message", "compaction", "branch_summary"].includes(entry.type)) {
			entryIds.push(entry.id);
			if (entry.type === "custom_message" && entry.customType === "subagent-human-message") {
				const id = (entry.details as { message?: { id?: string } } | undefined)?.message?.id;
				if (id && !delivered.has(id)) delivered.set(id, index);
			}
		} else if (entry.type === "message") {
			const message = entry.message;
			if (message.role === "assistant") {
				for (const [partIndex, part] of message.content.entries()) {
					if (part.type === "toolCall" || part.type === "text" && part.text || part.type === "thinking" && part.thinking) entryIds.push(`${entry.id}:${partIndex}`);
					if (part.type === "text" && part.text) lastReply = index;
				}
				if (message.errorMessage) entryIds.push(`${entry.id}:error`);
			} else if (["user", "toolResult", "bashExecution"].includes(message.role)) entryIds.push(entry.id);
		}
	}
	return { entryIds, deliveredMessages: new Map([...delivered].map(([id, index]) => [id, index < lastReply])),
		findFinalResult(text) {
			if (!finalResults) {
				finalResults = new Map();
				for (const entry of entries) {
					if (entry.type !== "message" || entry.message.role !== "assistant" || !entry.message.content.some((part) => part.type === "text" && part.text)) continue;
					const first = entry.message.content.findIndex((part) => part.type === "text" && part.text || part.type === "thinking" && part.thinking);
					const id = `${entry.id}:${first}`;
					finalResults.set(stripAcceptanceReport(contentText(entry.message.content)).trim(), id);
					for (const part of entry.message.content) if (part.type === "text") finalResults.set(stripAcceptanceReport(readableText(part.text)).trim(), id);
				}
			}
			return finalResults.get(text);
		} };
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
	const existing = history.findFinalResult ? history.findFinalResult(text) : history.items.findLast((item) => item.kind === "assistant" && (stripAcceptanceReport(item.text).trim() === text
		|| item.assistant?.content.some((part) => part.type === "text" && stripAcceptanceReport(readableText(part.text)).trim() === text)))?.id;
	const id = `result:${runId}`;
	let items: AgentHistoryItem[] | undefined;
	return { get items() { return existing ? history.items : items ??= [...history.items, { id, kind: "assistant", title: "Saved result", text, timestamp }]; },
		entryIds: existing ? history.entryIds : [...history.entryIds, id], finalId: existing ?? id,
		findFinalResult: existing ? history.findFinalResult : (value) => value === text ? id : history.findFinalResult?.(value),
		deliveredMessages: existing ? history.deliveredMessages : history.deliveredMessages && new Map([...history.deliveredMessages.keys()].map((id) => [id, true])),
		configuration: history.configuration, get unavailable() { return history.unavailable; } };
}

type NativeBoundary = { leaf?: string | null; terminalEntryId?: string; endedAt?: number };
interface NativeSnapshot {
	stamp: string;
	journal: NativeJournal;
	histories: Map<string, AgentHistory>;
	configurations: Map<string, NonNullable<AgentHistory["configuration"]>>;
}

export class NativeAgentHistory {
	private cache = new Map<string, Map<boolean, NativeSnapshot>>();
	private failures = new Map<string, { stamp: string; error: unknown }>();
	private seen = new Set<string>();

	private snapshot(sessionFile: string, live = false): NativeSnapshot {
		const stat = fs.statSync(sessionFile, { bigint: true });
		const stamp = journalStamp(stat);
		const failureKey = `${live}:${sessionFile}`, failure = this.failures.get(failureKey);
		if (failure?.stamp === stamp) throw failure.error;
		const modes = this.cache.get(sessionFile) ?? new Map<boolean, NativeSnapshot>();
		const previous = modes.get(live);
		if (previous?.stamp === stamp) return previous;
		let journal: NativeJournal;
		try { journal = new NativeJournal(sessionFile, "inspect", live, live ? previous?.journal : undefined, true); }
		catch (error) {
			// Stable data failures need no rescan; transient filesystem failures must retry.
			if (!(typeof error === "object" && error !== null && "syscall" in error)
				&& journalStamp(fs.statSync(sessionFile, { bigint: true })) === stamp) this.failures.set(failureKey, { stamp, error });
			throw error;
		}
		this.failures.delete(failureKey);
		const snapshot = { stamp: journal.stamp, journal, histories: new Map<string, AgentHistory>(), configurations: new Map<string, NonNullable<AgentHistory["configuration"]>>() };
		modes.set(live, snapshot);
		this.cache.set(sessionFile, modes);
		this.seen.add(sessionFile);
		return snapshot;
	}

	configuration(sessionFile: string | undefined, endedAt?: number, leaf?: string | null, live = false): NonNullable<AgentHistory["configuration"]> {
		if (!sessionFile) return {};
		const key = `${endedAt ?? "all"}:${leaf === undefined ? "latest" : leaf ?? "empty"}`;
		let configurations: NativeSnapshot["configurations"] | undefined;
		try {
			const snapshot = this.snapshot(sessionFile, live);
			configurations = snapshot.configurations;
			let configuration = snapshot.configurations.get(key);
			if (!configuration) {
				configuration = snapshot.journal.configuration(endedAt, leaf);
				snapshot.configurations.set(key, configuration);
			}
			return configuration;
		} catch {
			const unavailable = {};
			configurations?.set(key, unavailable);
			return unavailable;
		}
	}

	read(sessionFile: string | undefined, live = false, boundary: NativeBoundary = {}): AgentHistory {
		if (!sessionFile) return { items: [], entryIds: [], ...(!live ? { unavailable: "The child has not saved a conversation yet. Its assignment and live status remain available." } : {}) };
		const key = JSON.stringify([boundary.leaf, boundary.terminalEntryId, boundary.endedAt, boundary.leaf === undefined]);
		let histories: NativeSnapshot["histories"] | undefined;
		try {
			const snapshot = this.snapshot(sessionFile, live);
			histories = snapshot.histories;
			const cached = snapshot.histories.get(key);
			if (cached) return cached;
			const build = () => {
				let records = snapshot.journal.records.filter((record) => record.value.type !== "session");
				if (boundary.terminalEntryId) {
					const index = records.findIndex((record) => record.value.id === boundary.terminalEntryId);
					if (index < 0) throw new Error("Saved terminal entry is unavailable");
					records = records.slice(0, index + 1);
				} else if (boundary.endedAt !== undefined) records = records.filter((record) => Date.parse(record.value.timestamp) <= boundary.endedAt!);
				const entries = records.map((record) => record.value as SessionEntry);
				let items: AgentHistoryItem[] | undefined;
				let unavailable: string | undefined;
				const load = (item: AgentHistoryItem) => {
					const ids = new Set((item.entryIds ?? [item.id]).map((id) => id.split(":")[0]));
					const journal = this.snapshot(sessionFile, live).journal;
					if (journal.identity !== snapshot.journal.identity || journal.records[0]?.value.id !== snapshot.journal.records[0]?.value.id
						|| journal.stamp !== snapshot.journal.stamp && (journal.end <= snapshot.journal.end || !journal.hasPrefix(snapshot.journal))) throw new Error("Saved conversation was replaced or truncated; refresh history before reading details.");
					const entries = records.filter((record) => ids.has(record.value.id)).map((original) => {
						const record = journal.byId.get(original.value.id);
						if (!record || record.start !== original.start) throw new Error("Selected native entry changed or is unavailable; refresh history.");
						return journal.body(record) as SessionEntry;
					});
					const full = historyItems(entries).items.find((full) => full.id === item.id);
					if (!full) throw new Error("Selected native entry is unavailable; refresh history.");
					return full;
				};
				const readItems = () => {
					if (!items) try {
						items = historyItems(entries).items;
						for (const item of items) item.load = () => load(item);
					} catch (error) {
						unavailable = `Saved conversation unavailable: ${sessionFile}\n${error instanceof Error ? error.message : String(error)}`;
						items = [];
					}
					return items;
				};
				return { ...historyMetadata(entries), get items() { return readItems(); }, get unavailable() { return unavailable; },
					configuration: this.configuration(sessionFile, boundary.endedAt, boundary.leaf, live) };
			};
			const history = build();
			snapshot.histories.set(key, history);
			return history;
		} catch (error) {
			// Native Pi writes a new session only after the first assistant message ends.
			if (live && !this.seen.has(sessionFile) && (error as NodeJS.ErrnoException).code === "ENOENT") return { items: [], entryIds: [] };
			const unavailable = { items: [], entryIds: [], unavailable: `Saved conversation unavailable: ${sessionFile}\n${error instanceof Error ? error.message : String(error)}` };
			histories?.set(key, unavailable);
			return unavailable;
		}
	}

	clear(): void { this.cache.clear(); this.failures.clear(); this.seen.clear(); }
}
