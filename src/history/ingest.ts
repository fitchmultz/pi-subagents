import * as fs from "node:fs";
import { createHash, type Hash } from "node:crypto";
import { JournalFrames, type Projection } from "../shared/journal-reader.ts";
import { HistoryIndexError } from "./types.ts";
import { exactTextDigest, HistoryStore, safeText, type SourceRow } from "./store.ts";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { stripAcceptanceReport } from "../runs/shared/acceptance-reports.ts";

export function identity(stat: fs.BigIntStats): string { return `${stat.dev}:${stat.ino}`; }
export function stamp(stat: fs.BigIntStats): string { return `${identity(stat)}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`; }
const metadata = new Set(["type", "id", "parentId", "timestamp", "version", "cwd", "provider", "model", "modelId", "thinkingLevel", "customType", "display", "summary", "content"]);
const messageFields = new Set(["role", "content", "output", "summary", "toolCallId", "toolName", "isError", "timestamp", "model", "provider", "stopReason", "errorMessage", "customType", "display", "command", "exitCode", "cancelled"]);
export const previewLimits = { depth: 64, nodes: 16_384, arrayLength: 4096, keyLength: 512 };
export const previewProjection: Projection = (keys, root) => {
	if (!keys.length) return true;
	if (keys[0] === "message") {
		if (keys.length === 1) return true;
		if (!messageFields.has(String(keys[1]))) return false;
		if (keys[1] === "content") {
			if (keys.length <= 3) return 512;
			if (keys[3] === "arguments") {
				if (keys.length === 4) return true;
				if (keys.length === 5) return Object.keys(root?.message?.content?.[Number(keys[2])]?.arguments ?? {}).length < 32 ? 512 : false;
				return keys.length === 6 && keys[5] === 0 ? 512 : false;
			}
			return keys.length === 4 && ["type", "text", "thinking", "id", "name", "mimeType"].includes(String(keys[3])) ? 512 : false;
		}
		return keys.length === 2 ? 512 : false;
	}
	if (keys[0] === "details") return keys.length === 1 || keys.length === 2 && ["bodyText", "message"].includes(String(keys[1])) || keys.length === 3 && keys[1] === "message" && keys[2] === "id" ? 512 : false;
	if (keys[0] === "content" && keys.length > 1) return keys.length <= 2 || keys.length === 3 && ["type", "text", "mimeType"].includes(String(keys[2])) ? 512 : false;
	return keys.length === 1 && metadata.has(String(keys[0])) ? 512 : false;
};
function candidate(keys: readonly (string | number)[]): boolean {
	return ["summary", "content"].includes(String(keys[0])) && keys.length === 1
		|| keys.length === 2 && keys[0] === "details" && keys[1] === "bodyText"
		|| keys[0] === "message" && keys.length === 2 && ["content", "output", "summary"].includes(String(keys[1]))
		|| keys[0] === "message" && keys[1] === "content" && keys.length === 4 && keys[3] === "text"
		|| keys[0] === "content" && keys.length === 3 && keys[2] === "text";
}
function allowed(value: any, field: string): boolean {
	const keys = JSON.parse(field) as (string | number)[];
	if (value.type === "custom_message") {
		if (value.display === false) return false;
		if (keys[0] === "details") return value.customType === "subagent-human-message";
		if (value.customType === "subagent-human-message" && typeof value.details?.bodyText === "string") return false;
		return keys[0] === "content" && (keys.length === 1 || value.content?.[Number(keys[1])]?.type === "text");
	}
	if (["compaction", "branch_summary"].includes(value.type)) return keys.length === 1 && keys[0] === "summary";
	if (value.type !== "message" || keys[0] !== "message") return false;
	const message = value.message;
	if (!message) return false;
	if (["compactionSummary", "branchSummary"].includes(message.role)) return keys[1] === "summary";
	if (message.role === "bashExecution") return keys[1] === "output";
	if (!["user", "assistant", "toolResult", "custom"].includes(message.role) || message.role === "custom" && message.display === false) return false;
	return keys[1] === "content" && (keys.length === 2 || message.content?.[Number(keys[2])]?.type === "text");
}
export function compactEntry(value: any): Record<string, any> {
	let remaining = 4096;
	const clean = (input: any, key?: string): any => {
		if (typeof input === "string") { const text = safeText(input, ["id", "parentId", "type", "role", "toolCallId", "name", "toolName", "timestamp"].includes(key ?? "") ? 512 : Math.min(512, remaining)); remaining -= Math.min(remaining, text.length); return text; }
		if (Array.isArray(input)) return input.slice(0, 32).map((item) => clean(item));
		if (input && typeof input === "object") return Object.fromEntries(Object.entries(input).map(([name, item]) => [name, clean(item, name)]));
		return input;
	};
	return clean(value);
}
/** Exact matches never use previews. Oversized selected text has no fingerprint. */
class AnswerTexts {
	private fields = new Map<number, string>();
	private length = 0;
	private unavailable = false;
	write(keys: readonly (string | number)[], text: string): void {
		if (this.unavailable || keys.length !== 4 || keys[0] !== "message" || keys[1] !== "content" || !["text", "thinking"].includes(String(keys[3]))) return;
		this.length += text.length;
		if (this.length > 16 * 1024 * 1024 || Number(keys[2]) >= 4096) { this.unavailable = true; this.fields.clear(); return; }
		const index = Number(keys[2]);
		this.fields.set(index, (this.fields.get(index) ?? "") + text);
	}
	fingerprints(value: any, id: string): Array<[string, string]> {
		if (this.unavailable || value.type !== "message" || value.message?.role !== "assistant") return [];
		const content = Array.isArray(value.message.content) ? value.message.content : [];
		const first = content.findIndex((part: any, index: number) => ["text", "thinking"].includes(part.type) && Boolean(this.fields.get(index)));
		if (first < 0 || !content.some((part: any, index: number) => part.type === "text" && Boolean(this.fields.get(index)))) return [];
		const item = `${id}:${first}`, parts = content.map((part: any, index: number) => ["text", "thinking"].includes(part.type) ? stripTerminalSequences(this.fields.get(index) ?? "") : part.type === "image" ? `[Image: ${part.mimeType ?? "image"}]` : "").filter(Boolean);
		const texts = [parts.join("\n"), ...content.flatMap((part: any, index: number) => part.type === "text" ? [stripTerminalSequences(this.fields.get(index) ?? "")] : [])];
		return [...new Set(texts.map((text) => stripAcceptanceReport(text).trim()).filter(Boolean))].map((text) => [exactTextDigest(text), item]);
	}
}
function visibleId(value: any, id: string): string | null {
	if (["custom_message", "compaction", "branch_summary"].includes(value.type)) return id;
	if (value.type !== "message") return null;
	if (["user", "toolResult", "bashExecution"].includes(value.message?.role)) return id;
	if (value.message?.role !== "assistant") return null;
	const content = Array.isArray(value.message.content) ? value.message.content : [];
	const last = content.findLastIndex((part: any) => part.type === "toolCall" || part.type === "text" && part.text || part.type === "thinking" && part.thinking);
	return value.message.errorMessage ? `${id}:error` : last < 0 ? null : `${id}:${last}`;
}
interface TextToken { text: string; start: number; end: number }
interface TextBuffer { word: string; wordStart: number; received: number; tokens: TextToken[]; length: number; terminal: TerminalText }
/** Streaming ECMA-48 removal, retaining original UTF-16 positions without buffering control payloads. */
class TerminalText {
	private state: "text" | "escape" | "intermediate" | "csi" | "string" | "stringEscape" = "text";
	write(text: string, visible: (text: string, start: number) => void): void {
		let position = 0;
		while (position < text.length) {
			if (this.state === "text") {
				const next = text.slice(position).search(/[\x1b\x90\x98\x9b\x9d-\x9f]/);
				if (next < 0) { visible(text.slice(position), position); return; }
				visible(text.slice(position, position + next), position); position += next;
				const control = text[position++];
				this.state = control === "\x1b" ? "escape" : control === "\x9b" ? "csi" : "string";
				continue;
			}
			const char = text[position++];
			if (this.state === "escape") this.state = char === "[" ? "csi" : "]PX^_".includes(char) ? "string" : char >= " " && char <= "/" ? "intermediate" : "text";
			else if (this.state === "intermediate") { if (char >= "0" && char <= "~") this.state = "text"; }
			else if (this.state === "csi") { if (char >= "@" && char <= "~") this.state = "text"; }
			else if (char === "\x07" || char === "\x9c" || this.state === "stringEscape" && char === "\\") this.state = "text";
			else this.state = char === "\x1b" ? "stringEscape" : "string";
		}
	}
}
/** Token windows overlap 12 tokens, including phrases across arbitrarily long whitespace. */
class TextChunks {
	private fields = new Map<string, TextBuffer>();
	private staged: Array<{ field: string; start: number; end: number; text: string }> = [];
	private emit(field: string, buffer: TextBuffer, final = false): void {
		if (!buffer.tokens.length) return;
		this.staged.push({ field, start: buffer.tokens[0].start, end: buffer.tokens.at(-1)!.end, text: buffer.tokens.map((token) => token.text).join(" ") });
		buffer.tokens = final ? [] : buffer.tokens.slice(-12);
		buffer.length = buffer.tokens.reduce((length, token) => length + token.text.length + 1, 0);
	}
	private token(field: string, buffer: TextBuffer, end: number): void {
		if (!buffer.word) return;
		buffer.tokens.push({ text: buffer.word, start: buffer.wordStart, end });
		buffer.length += buffer.word.length + 1; buffer.word = "";
		if (buffer.tokens.length >= 256 || buffer.length >= 8192 && buffer.tokens.length > 12) this.emit(field, buffer);
	}
	write(keys: readonly (string | number)[], text: string): void {
		if (!candidate(keys)) return;
		const field = JSON.stringify(keys);
		let buffer = this.fields.get(field);
		if (!buffer) {
			if (this.fields.size >= 4096) throw new HistoryIndexError("RECORD_COMPLEXITY", "Record exceeds the 4096 visible text-field indexing budget.");
			this.fields.set(field, buffer = { word: "", wordStart: 0, received: 0, tokens: [], length: 0, terminal: new TerminalText() });
		}
		buffer.terminal.write(text, (visible, offset) => {
			for (const part of visible.matchAll(/[\p{L}\p{N}\p{M}]+|[^\p{L}\p{N}\p{M}]+/gu)) {
				const start = buffer.received + offset + part.index!;
				if (/^[\p{L}\p{N}\p{M}]/u.test(part[0])) {
					if (!buffer.word) buffer.wordStart = start;
					buffer.word += part[0];
					if (buffer.word.length > 65_536) throw new HistoryIndexError("RECORD_COMPLEXITY", "Record contains a lexical token exceeding the 64 KiB indexing budget.");
				} else this.token(field, buffer, start);
			}
		});
		buffer.received += text.length;
	}
	flush(store: HistoryStore, finish = false): void {
		if (finish) {
			for (const [field, buffer] of this.fields) { this.token(field, buffer, buffer.received); this.emit(field, buffer, true); }
			this.fields.clear();
		}
		if (this.staged.length) {
			const insert = store.db.prepare("INSERT INTO pending_text VALUES (?,?,?,?)");
			for (const item of this.staged) insert.run(item.field, item.start, item.end, item.text);
			this.staged = [];
		}
	}
}

/** One physical source, incremental byte framing and short row/cursor publication transactions. */
export class SourceIngest {
	private fd: number;
	private initial: fs.BigIntStats;
	private source: SourceRow;
	private prefix: Hash = createHash("sha256");
	private recordDigest: Hash = createHash("sha256");
	private verifyAt = 0;
	private position: number;
	private frames: JournalFrames;
	private text = new TextChunks();
	private answerTexts = new AnswerTexts();
	private buffer = Buffer.alloc(0);
	private record?: { value: any; start: number; end: number; digest: string };
	private stagedEntry?: number;
	private textCursor = 0;
	private malformed = false;
	private complexity = false;
	private phase: "verify" | "read" | "text" | "done";
	private closed = false;
	private headerSeen: boolean;
	private store: HistoryStore;
	readonly id: string;
	constructor(store: HistoryStore, source: SourceRow, force = false) {
		this.store = store; this.source = source; this.id = source.id;
		store.beginIngest();
		let opened: number | undefined;
		try {
			this.source = source = store.source(source.id)!;
			if (!source) throw new HistoryIndexError("SOURCE_CHANGED", "Source was removed before ingestion.");
			store.operations.sourceChecks++; store.operations.sourceOpens++;
			this.fd = opened = fs.openSync(source.path, "r"); this.initial = fs.fstatSync(this.fd, { bigint: true });
			if (!this.initial.isFile() || this.initial.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Journal is not a supported regular file.");
			if (source.identity && (source.identity !== identity(this.initial) || Number(this.initial.size) < source.cursor)) { store.resetSource(source.id); this.source = source = store.source(source.id)!; }
			this.position = source.cursor;
			this.headerSeen = source.cursor > 0;
			store.clearUnpublished(source.id);
			store.run("DELETE FROM pending_text");
			this.phase = !force && source.stamp === stamp(this.initial) ? "done" : source.cursor ? "verify" : "read";
			if (this.phase !== "done") store.run("UPDATE sources SET state='indexing',error=NULL WHERE id=?", source.id);
			this.frames = new JournalFrames(previewProjection, (record) => {
				this.record = { ...record, digest: this.recordDigest.copy().digest("hex") };
			}, "inspect", source.cursor, (_start, _end, error) => { this.malformed = true; this.complexity = error instanceof RangeError || error instanceof HistoryIndexError && error.code === "RECORD_COMPLEXITY"; }, (keys, chunk) => { this.text.write(keys, chunk); this.answerTexts.write(keys, chunk); }, undefined, true, previewLimits);
		} catch (error) {
			if (opened !== undefined) fs.closeSync(opened);
			store.endIngest();
			throw error;
		}
	}
	private published(end: number, work?: () => void): void {
		this.store.transaction(() => {
			const current = this.store.source(this.id)!;
			if (!current || current.generation !== this.source.generation || current.cursor !== this.source.cursor) throw new HistoryIndexError("SOURCE_CHANGED", "Another writer advanced this source; reconcile before replaying.");
			work?.();
			this.store.run("UPDATE sources SET cursor=?,prefix_digest=?,identity=? WHERE id=?", end, this.prefix.copy().digest("hex"), identity(this.initial), this.id);
			this.store.bump();
		});
		this.source.cursor = end;
		this.recordDigest = createHash("sha256"); this.text = new TextChunks(); this.answerTexts = new AnswerTexts();
		this.store.run("DELETE FROM pending_text"); this.record = undefined; this.malformed = this.complexity = false;
	}
	private finishRecord(end: number): void {
		this.text.flush(this.store, true);
		if (this.malformed) {
			if (!this.headerSeen) throw new Error("Malformed native session header.");
			this.published(end, () => this.store.run("UPDATE sources SET malformed=malformed+1,complexity=complexity+? WHERE id=?", this.complexity ? 1 : 0, this.id)); return;
		}
		const record = this.record;
		if (!record) { this.published(end); return; }
		const value = record.value;
		if (!this.headerSeen) {
			if (value.type !== "session") throw new Error("Linked source does not have a native session header.");
			this.published(end, () => this.store.run("UPDATE sources SET session_id=?,header_digest=?,format_version=? WHERE id=?", typeof value.id === "string" ? value.id : null, record.digest, typeof value.version === "number" ? value.version : null, this.id));
			this.source.format_version = typeof value.version === "number" ? value.version : null;
			this.headerSeen = true; return;
		}
		if (value.type === "session") throw new Error("Unexpected session header inside a native source.");
		const nativeId = typeof value.id === "string" ? value.id : null;
		const id = nativeId ?? `legacy-${record.start}`;
		if (this.store.get("SELECT rowid FROM entries WHERE source_id=? AND generation=? AND id=?", this.id, this.source.generation, id)) {
			this.published(end, () => this.store.run("UPDATE sources SET malformed=malformed+1 WHERE id=?", this.id)); return;
		}
		const timestamp = typeof value.timestamp === "number" ? value.timestamp : Date.parse(value.timestamp);
		const parent = this.source.format_version === 1 ? this.store.get("SELECT id FROM entries WHERE source_id=? AND generation=? AND published=1 ORDER BY start DESC LIMIT 1", this.id, this.source.generation)?.id ?? null : typeof value.parentId === "string" ? value.parentId : null;
		const preview = compactEntry(value); preview.id = id; preview.parentId = parent;
		const model = value.type === "model_change" && typeof value.modelId === "string" ? `${value.provider}/${value.modelId}` : value.type === "message" && value.message?.role === "assistant" && typeof value.message.model === "string" ? `${value.message.provider}/${value.message.model}` : null;
		this.stagedEntry = Number(this.store.run("INSERT INTO entries(source_id,generation,id,native_id,parent_id,start,end,digest,timestamp,type,preview,role,assistant_text,visible_id,human_id,configuration_model,configuration_thinking) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", this.id, this.source.generation, id, nativeId, parent, record.start, end, record.digest, Number.isFinite(timestamp) ? timestamp : null, typeof value.type === "string" ? value.type : "unknown", JSON.stringify(preview), typeof value.message?.role === "string" ? value.message.role : null,
			value.message?.role === "assistant" && Array.isArray(value.message.content) && value.message.content.some((part: any) => part.type === "text" && part.text) ? 1 : 0,
			visibleId(value, id), value.type === "custom_message" && value.customType === "subagent-human-message" && typeof value.details?.message?.id === "string" ? value.details.message.id : null, model, value.type === "thinking_level_change" && typeof value.thinkingLevel === "string" ? value.thinkingLevel : null).lastInsertRowid);
		this.textCursor = 0; this.phase = "text";
	}
	private indexText(): void {
		const chunks = this.store.all("SELECT rowid,* FROM pending_text WHERE rowid>? ORDER BY rowid LIMIT 32", this.textCursor);
		if (chunks.length) {
			this.store.transaction(() => {
				for (const chunk of chunks) {
					if (!allowed(this.record!.value, chunk.field)) continue;
					const text = safeText(chunk.text, 1_048_576);
					const id = this.store.run("INSERT INTO documents(entry_rowid,field,text_start,text_end,preview) VALUES (?,?,?,?,?)", this.stagedEntry!, chunk.field, chunk.position, chunk.end_position, safeText(text, 512)).lastInsertRowid;
					this.store.run("INSERT INTO corpus(rowid,text) VALUES (?,?)", id, text);
				}
			});
			this.textCursor = chunks.at(-1).rowid; return;
		}
		const value = this.record!.value, rowid = this.stagedEntry!;
		const answers = this.answerTexts.fingerprints(value, typeof value.id === "string" ? value.id : `legacy-${this.record!.start}`);
		this.published(this.record!.end, () => {
			if (this.store.run("UPDATE entries SET published=1 WHERE rowid=? AND source_id=? AND generation=? AND published=0", rowid, this.id, this.source.generation).changes !== 1) throw new HistoryIndexError("SOURCE_CHANGED", "Staged entry disappeared before publication; reconcile before advancing the source.");
			for (const [digest, item] of answers) this.store.run("INSERT OR IGNORE INTO answers VALUES (?,?,?)", rowid, digest, item);
			for (const part of Array.isArray(value.message?.content) ? value.message.content : []) if (part.type === "toolCall" && typeof part.id === "string") this.store.run("INSERT INTO tools VALUES (?,?,?,?,?)", rowid, this.id, this.source.generation, part.id, "call");
			if (value.message?.role === "toolResult" && typeof value.message.toolCallId === "string") this.store.run("INSERT INTO tools VALUES (?,?,?,?,?)", rowid, this.id, this.source.generation, value.message.toolCallId, "result");
		});
		this.stagedEntry = undefined; this.phase = "read";
	}
	/** Each pump reads <=64 KiB or indexes <=32 chunks, then returns to the IPC event loop. */
	step(): boolean {
		if (this.phase === "done") { this.close(); return true; }
		if (this.phase === "text") { this.indexText(); return false; }
		if (this.phase === "verify") {
			const bytes = Buffer.allocUnsafe(Math.min(64 * 1024, this.source.cursor - this.verifyAt));
			const count = fs.readSync(this.fd, bytes, 0, bytes.length, this.verifyAt);
			if (count !== bytes.length) throw new Error("Journal truncated during prefix verification.");
			this.store.operations.sourceBytesRead += count;
			this.prefix.update(bytes); this.verifyAt += count;
			if (this.verifyAt === this.source.cursor) {
				if (this.prefix.copy().digest("hex") !== this.source.prefix_digest) {
					this.store.resetSource(this.id); throw new HistoryIndexError("SOURCE_CHANGED", "Journal prefix changed; a new physical generation was scheduled.");
				}
				this.phase = "read";
			}
			return false;
		}
		if (!this.buffer.length) {
			const remaining = Number(this.initial.size) - this.position;
			if (remaining <= 0) return this.finish();
			const bytes = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
			const count = fs.readSync(this.fd, bytes, 0, bytes.length, this.position);
			if (count !== bytes.length) throw new Error("Journal truncated during ingestion.");
			this.store.operations.sourceBytesRead += count;
			this.position += count; this.buffer = bytes;
		}
		const newline = this.buffer.indexOf(10);
		const bytes = newline < 0 ? this.buffer : this.buffer.subarray(0, newline + 1);
		this.recordDigest.update(bytes); this.prefix.update(bytes); this.frames.write(bytes); this.text.flush(this.store);
		this.buffer = this.buffer.subarray(bytes.length);
		if (newline >= 0) this.finishRecord(this.frames.offset);
		return false;
	}
	private finish(): boolean {
		this.frames.finish();
		const now = fs.statSync(this.source.path, { bigint: true });
		if (identity(now) !== identity(this.initial) || now.size < this.initial.size || now.size === this.initial.size && stamp(now) !== stamp(this.initial)) {
			this.store.resetSource(this.id); throw new HistoryIndexError("SOURCE_CHANGED", "Journal changed during ingestion; retrying its new generation.");
		}
		const { malformed, complexity } = this.store.source(this.id)!;
		this.store.run("UPDATE sources SET identity=?,stamp=?,checked_at=?,state=?,error=? WHERE id=?", identity(this.initial), stamp(this.initial), Date.now(), malformed ? "degraded" : this.source.cursor < Number(this.initial.size) ? "partial" : "current", malformed ? `${malformed} malformed, duplicate or over-budget LF-published records were skipped.${complexity ? ` ${complexity} exceeded bounded history structure/text budgets.` : ""}` : null, this.id);
		this.phase = "done"; this.close(); return true;
	}
	close(): void { if (!this.closed) { fs.closeSync(this.fd); this.store.endIngest(); this.closed = true; } }
}
