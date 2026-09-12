import * as fs from "node:fs";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { parseSessionEntries } from "../shared/native-session.ts";
import { extractToolArgsPreview } from "../shared/utils.ts";

export interface AgentHistoryItem {
	id: string;
	kind: "user" | "assistant" | "thinking" | "tool" | "result" | "change" | "notice";
	title: string;
	text: string;
	details?: string;
	diff?: string;
	messageId?: string;
	timestamp: number;
}

export function readableText(value: unknown): string {
	return stripTerminalSequences(typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "");
}

function contentText(content: unknown): string {
	if (typeof content === "string") return readableText(content);
	if (!Array.isArray(content)) return readableText(content);
	return content.map((part) => part.type === "text" ? readableText(part.text)
		: part.type === "image" ? `[Image: ${part.mimeType ?? "image"}]` : "").filter(Boolean).join("\n");
}

/** Read the native entries, not a compacted model context: earlier messages remain inspectable. */
export function historyItems(entries: SessionEntry[]): AgentHistoryItem[] {
	const items: AgentHistoryItem[] = [];
	const calls = new Map<string, { name: string; arguments: unknown }>();
	const pending = new Map<string, AgentHistoryItem>();
	for (const entry of entries) {
		const base = { id: entry.id, timestamp: Date.parse(entry.timestamp) };
		if (entry.type === "custom_message") {
			const details = entry.details as { bodyText?: string; message?: { id?: string }; from?: { name?: string } } | undefined;
			const human = entry.customType === "subagent-human-message";
			items.push({ ...base, kind: human ? "user" : "notice", title: human ? "User · delivered to conversation" : details?.from?.name ? `From ${details.from.name}` : entry.customType,
				text: contentText(details?.bodyText ?? entry.content), ...(human ? { messageId: details?.message?.id } : {}) });
		} else if (entry.type === "compaction") {
			items.push({ ...base, kind: "notice", title: "Context summary · earlier history retained above", text: readableText(entry.summary) });
		} else if (entry.type === "branch_summary") {
			items.push({ ...base, kind: "notice", title: "Branch summary", text: readableText(entry.summary) });
		} else if (entry.type === "message") {
			const message = entry.message;
			if (message.role === "assistant") {
				for (const [index, part] of message.content.entries()) {
					const id = `${entry.id}:${index}`;
					if (part.type === "toolCall") {
						calls.set(part.id, { name: part.name, arguments: part.arguments });
						const item: AgentHistoryItem = { ...base, id, kind: "tool", title: `${part.name} ${extractToolArgsPreview(part.arguments)}`.trim(), text: readableText(part.arguments) };
						items.push(item); pending.set(part.id, item);
					} else if (part.type === "text" && part.text) {
						items.push({ ...base, id, kind: "assistant", title: "Agent", text: readableText(part.text) });
					} else if (part.type === "thinking" && part.thinking) {
						items.push({ ...base, id, kind: "thinking", title: "Thinking", text: readableText(part.thinking) });
					}
				}
				if (message.errorMessage) items.push({ ...base, id: `${entry.id}:error`, kind: "notice", title: "Agent error", text: readableText(message.errorMessage) });
			} else if (message.role === "user") {
				items.push({ ...base, kind: "user", title: "User / assignment", text: contentText(message.content) });
			} else if (message.role === "toolResult") {
				const details = message.details as { diff?: unknown } | undefined;
				const diff = typeof details?.diff === "string" ? readableText(details.diff) : undefined;
				const call = calls.get(message.toolCallId);
				pending.delete(message.toolCallId);
				items.push({ ...base, kind: diff ? "change" : "result", title: `${message.toolName} ${message.isError ? "failed" : "returned"} · result recorded`,
					text: contentText(message.content), diff,
					details: readableText({ ...(call ? { arguments: call.arguments } : {}), result: message.content, ...(message.details ? { details: message.details } : {}) }) });
			} else if (message.role === "bashExecution") {
				items.push({ ...base, kind: "tool", title: `Shell: ${readableText(message.command)}`, text: `${readableText(message.output)}\n${typeof message.exitCode === "number" ? `Shell exit code: ${message.exitCode}` : "Shell exit code not recorded"}${message.cancelled ? " · cancelled" : ""}`, details: readableText({ command: message.command, exitCode: message.exitCode, cancelled: message.cancelled }) });
			}
		}
	}
	for (const item of pending.values()) {
		item.title += " · result not recorded";
		item.details = `${item.text}\n\nCommand result not recorded; exit is unconfirmed. An agent pause or exit does not prove that a command or its descendants exited.`;
	}
	return items;
}

export class NativeAgentHistory {
	private cache = new Map<string, { stamp: string; items: AgentHistoryItem[] }>();

	read(sessionFile: string | undefined, live = false): { items: AgentHistoryItem[]; unavailable?: string } {
		if (!sessionFile) return { items: [], ...(!live ? { unavailable: "The child has not saved a conversation yet. Its assignment and live status remain available." } : {}) };
		try {
			const stat = fs.statSync(sessionFile, { bigint: true });
			const stamp = `${stat.ino}:${stat.size}:${stat.mtimeNs}`;
			const cached = this.cache.get(sessionFile);
			if (cached?.stamp === stamp) return cached;
			const entries = parseSessionEntries(fs.readFileSync(sessionFile, "utf8"));
			if (entries[0]?.type !== "session") return { items: [], unavailable: `Saved conversation is not a readable native Pi session: ${sessionFile}` };
			const items = historyItems(entries.filter((entry): entry is SessionEntry => entry.type !== "session"));
			this.cache.set(sessionFile, { stamp, items });
			return { items };
		} catch (error) {
			// Native Pi writes a new session only after the first assistant message ends.
			if (live && !this.cache.has(sessionFile) && (error as NodeJS.ErrnoException).code === "ENOENT") return { items: [] };
			return { items: [], unavailable: `Saved conversation unavailable: ${sessionFile}\n${error instanceof Error ? error.message : String(error)}` };
		}
	}

	clear(): void { this.cache.clear(); }
}
