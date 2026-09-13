import * as fs from "node:fs";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { stripAcceptanceReport } from "../runs/shared/acceptance-reports.ts";
import { readNativeSessionConfiguration } from "../runs/shared/supervisor-questions.ts";
import { providerQualifiedModelId } from "../shared/model-info.ts";
import { parseSessionEntries } from "../shared/native-session.ts";
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
			append({ ...base, kind: human ? "user" : "notice", title: human ? "User · delivered to conversation" : details?.from?.name ? `From ${details.from.name}` : entry.customType,
				text: contentText(details?.bodyText ?? entry.content), ...(human ? { messageId: details?.message?.id } : {}) });
		} else if (entry.type === "compaction") {
			append({ ...base, kind: "notice", title: "Context summary · earlier history retained above", text: readableText(entry.summary) });
		} else if (entry.type === "branch_summary") {
			append({ ...base, kind: "notice", title: "Branch summary", text: readableText(entry.summary) });
		} else if (entry.type === "message") {
			const message = entry.message;
			if (message.role === "assistant") {
				const model = providerQualifiedModelId(message.provider, message.model);
				const messageIds = message.content.flatMap((part, index) => part.type === "text" && part.text || part.type === "thinking" && part.thinking ? [`${entry.id}:${index}`] : []);
				if (messageIds.length) items.push({ ...base, id: messageIds[0]!, entryIds: messageIds,
					kind: message.content.some((part) => part.type === "text" && part.text) ? "assistant" : "thinking",
					title: "Agent", text: contentText(message.content), assistant: message, model });
				for (const [index, part] of message.content.entries()) {
					const id = `${entry.id}:${index}`;
					if (part.type === "toolCall") {
						const item: AgentHistoryItem = { ...base, id, entryIds: [id], kind: "tool", title: `${part.name} ${extractToolArgsPreview(part.arguments)}`.trim(), text: readableText(part.arguments), call: part, model };
						append(item); calls.set(part.id, item);
					} else if (messageIds.includes(id)) entryIds.push(id);
				}
				if (message.errorMessage) {
					const id = `${entry.id}:error`;
					if (messageIds.length && !message.content.some((part) => part.type === "toolCall") && ["error", "aborted"].includes(message.stopReason)) { messageIds.push(id); entryIds.push(id); }
					else append({ ...base, id, kind: "notice", title: "Agent error", text: readableText(message.errorMessage) });
				}
			} else if (message.role === "user") {
				append({ ...base, kind: "user", title: "User / assignment", text: contentText(message.content) });
			} else if (message.role === "toolResult") {
				const details = message.details as { diff?: unknown } | undefined;
				const diff = typeof details?.diff === "string" ? readableText(details.diff) : undefined;
				const call = calls.get(message.toolCallId);
				const recorded = { result: message, text: contentText(message.content), diff,
					details: readableText({ ...(call ? { call: call.call } : {}), result: message }) };
				if (call) {
					Object.assign(call, recorded);
					call.entryIds!.push(entry.id); entryIds.push(entry.id);
				} else append({ ...base, ...recorded, kind: "result", title: `${message.toolName} · call not recorded` });
			} else if (message.role === "bashExecution") {
				append({ ...base, kind: "tool", title: `Shell: ${readableText(message.command)}`, text: `${readableText(message.output)}\n${typeof message.exitCode === "number" ? `Shell exit code: ${message.exitCode}` : "Shell exit code not recorded"}${message.cancelled ? " · cancelled" : ""}`, details: readableText({ command: message.command, exitCode: message.exitCode, cancelled: message.cancelled }) });
			}
		}
	}
	for (const item of calls.values()) {
		item.title += item.result ? ` · ${item.result.isError ? "failed" : "result recorded"}` : " · result not recorded";
		if (!item.result) item.details = `${readableText(item.call)}\n\nCommand result not recorded; exit is unconfirmed. An agent pause or exit does not prove that a command or its descendants exited.`;
	}
	return { items, entryIds };
}

/** Canonical run output is already validated; never decode arbitrary tool JSON to find an answer. */
export function withFinalResult(history: AgentHistory, output: string, runId: string, timestamp: number): AgentHistory {
	const text = readableText(output).trim();
	if (!text) return history;
	const existing = history.items.findLast((item) => item.kind === "assistant" && (stripAcceptanceReport(item.text).trim() === text
		|| item.assistant?.content.some((part) => part.type === "text" && stripAcceptanceReport(readableText(part.text)).trim() === text)));
	if (existing) return { ...history, finalId: existing.id };
	const id = `result:${runId}`;
	return { ...history, finalId: id, items: [...history.items, { id, kind: "assistant", title: "Saved result", text, timestamp }], entryIds: [...history.entryIds, id] };
}

export class NativeAgentHistory {
	private cache = new Map<string, AgentHistory & { stamp: string }>();

	read(sessionFile: string | undefined, live = false): AgentHistory {
		if (!sessionFile) return { items: [], entryIds: [], ...(!live ? { unavailable: "The child has not saved a conversation yet. Its assignment and live status remain available." } : {}) };
		try {
			const stat = fs.statSync(sessionFile, { bigint: true });
			const stamp = `${stat.ino}:${stat.size}:${stat.mtimeNs}`;
			const cached = this.cache.get(sessionFile);
			if (cached?.stamp === stamp) return cached;
			const entries = parseSessionEntries(fs.readFileSync(sessionFile, "utf8"));
			if (entries[0]?.type !== "session") return { items: [], entryIds: [], unavailable: `Saved conversation is not a readable native Pi session: ${sessionFile}` };
			const history = { ...historyItems(entries.filter((entry): entry is SessionEntry => entry.type !== "session")), configuration: readNativeSessionConfiguration(undefined, entries) };
			this.cache.set(sessionFile, { stamp, ...history });
			return history;
		} catch (error) {
			// Native Pi writes a new session only after the first assistant message ends.
			if (live && !this.cache.has(sessionFile) && (error as NodeJS.ErrnoException).code === "ENOENT") return { items: [], entryIds: [] };
			return { items: [], entryIds: [], unavailable: `Saved conversation unavailable: ${sessionFile}\n${error instanceof Error ? error.message : String(error)}` };
		}
	}

	clear(): void { this.cache.clear(); }
}
