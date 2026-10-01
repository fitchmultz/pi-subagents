import * as fs from "node:fs";
import { createHash, type Hash } from "node:crypto";
import * as parserModule from "stream-json/core/parser.js";
import type { Token } from "stream-json/core/parser.js";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

type JsonObject = Record<string, any>;
export function entryMetadata(manager: { getEntries(): SessionEntry[] }): Iterable<SessionEntry> {
	const optional = manager as { iterateEntryMetadata?: () => Iterable<SessionEntry> };
	return optional.iterateEntryMetadata ? optional.iterateEntryMetadata() : manager.getEntries();
}
export type Projection = (path: readonly (string | number)[], root?: JsonObject) => boolean | number;
type KeyLimit = (parentPath: readonly (string | number)[], root?: JsonObject) => number;
export interface JournalRecord { value: JsonObject; start: number; end: number }
export type JournalPolicy = "strict" | "live" | "inspect";

// The public synchronous tokenizer is exported by 3.7.0 but omitted from its declarations.
const jsonParser = (parserModule as unknown as {
	jsonParser(options: object): (chunk: string | symbol) => { values: Token[] } | symbol;
}).jsonParser;
const endInput = Symbol.for("object-stream.none");

/** Validate everything, assembling only selected fields. Discarded strings are never packed. */
export class JsonProjection {
	private parse = jsonParser({ packValues: false });
	private stack: Array<{ path: (string | number)[]; value?: any; key: string; index: number }> = [];
	private scalar?: { path: (string | number)[]; text: string; limit: number; number: boolean };
	private key = false;
	private keyLimit = 4096;
	private keys: KeyLimit;
	value?: JsonObject;
	private select: Projection;
	private stringChunk?: (path: readonly (string | number)[], text: string, root?: JsonObject) => void;
	constructor(select: Projection, stringChunk?: (path: readonly (string | number)[], text: string, root?: JsonObject) => void,
		keys: KeyLimit = () => 4096) { this.select = select; this.stringChunk = stringChunk; this.keys = keys; }

	private selected(path: (string | number)[]): boolean | number {
		return this.stack.length && this.stack.at(-1)!.value === undefined ? false : this.select(path, this.value);
	}
	private nextPath(): (string | number)[] {
		const parent = this.stack.at(-1);
		return parent ? [...parent.path, Array.isArray(parent.value) || parent.index >= 0 ? parent.index++ : parent.key] : [];
	}
	private put(path: (string | number)[], value: any): void {
		const parent = this.stack.at(-1);
		if (!parent) this.value = value;
		else if (parent.value !== undefined) Object.defineProperty(parent.value, path.at(-1)!, { value, enumerable: true, writable: true, configurable: true });
	}
	write(chunk: string | symbol): void {
		const output = this.parse(chunk);
		if (typeof output === "symbol") return;
		for (const token of output.values) {
			switch (token.name) {
				case "startKey": {
					const parent = this.stack.at(-1)!;
					this.key = true; parent.key = "";
					this.keyLimit = parent.value === undefined ? 0 : this.keys(parent.path, this.value);
					break;
				}
				case "endKey": this.key = false; break;
				case "startObject": case "startArray": {
					const path = this.nextPath(), keep = this.selected(path);
					const value = keep ? token.name === "startArray" ? [] : {} : undefined;
					if (keep) this.put(path, value);
					this.stack.push({ path, value, key: "", index: token.name === "startArray" ? 0 : -1 });
					break;
				}
				case "endObject": case "endArray": this.stack.pop(); break;
				case "startString": case "startNumber": {
					const path = this.nextPath(), keep = this.selected(path);
					this.scalar = { path, text: "", limit: keep === true ? Infinity : Number(keep) || 0, number: token.name === "startNumber" };
					break;
				}
				case "stringChunk": case "numberChunk":
					if (this.key) {
						const parent = this.stack.at(-1)!;
						if (parent.key.length < this.keyLimit) parent.key += token.value.slice(0, this.keyLimit - parent.key.length);
					} else if (this.scalar) {
						if (token.name === "stringChunk") this.stringChunk?.(this.scalar.path, token.value, this.value);
						if (this.scalar.text.length < this.scalar.limit) this.scalar.text += token.value.slice(0, this.scalar.limit - this.scalar.text.length);
					}
					break;
				case "endString": case "endNumber": {
					const scalar = this.scalar!;
					if (scalar.limit) this.put(scalar.path, scalar.number ? Number(scalar.text) : scalar.text);
					this.scalar = undefined;
					break;
				}
				case "trueValue": case "falseValue": case "nullValue": {
					const path = this.nextPath();
					if (this.selected(path)) this.put(path, token.value);
					break;
				}
			}
		}
	}
	finish(): JsonObject | undefined { this.write(endInput); return this.value; }
}

/** Byte-framed JSONL. Publication framing is independent of malformed-record tolerance. */
export class JournalFrames {
	private projection: JsonProjection;
	private decoder = new TextDecoder("utf8", { fatal: true });
	private error?: unknown;
	private nonblank = false;
	private start: number;
	offset: number;
	private select: Projection;
	private record: (record: JournalRecord) => void;
	private policy: JournalPolicy;
	private malformed?: (start: number, end: number, error: unknown) => void;
	private stringChunk?: ConstructorParameters<typeof JsonProjection>[1];
	private keys?: KeyLimit;
	private requireNewline: boolean;
	constructor(select: Projection, record: (record: JournalRecord) => void,
		policy: JournalPolicy = "strict", offset = 0,
		malformed?: (start: number, end: number, error: unknown) => void,
		stringChunk?: ConstructorParameters<typeof JsonProjection>[1], keys?: KeyLimit, requireNewline = policy === "live") {
		this.select = select; this.record = record; this.policy = policy; this.malformed = malformed;
		this.stringChunk = stringChunk; this.keys = keys;
		this.requireNewline = requireNewline;
		this.start = this.offset = offset;
		this.projection = new JsonProjection(select, stringChunk, keys);
	}
	private part(bytes: Buffer): void {
		if (!this.nonblank && bytes.some((byte) => ![9, 10, 13, 32].includes(byte))) this.nonblank = true;
		if (!this.error) try { this.projection.write(this.decoder.decode(bytes, { stream: true })); } catch (error) { this.error = error; }
	}
	private commit(end: number): void {
		let record: JournalRecord | undefined, malformed: unknown;
		const start = this.start;
		if (this.nonblank) {
			let value: JsonObject | undefined;
			if (!this.error) try {
				this.projection.write(this.decoder.decode());
				value = this.projection.finish();
				if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyntaxError("JSONL records must be objects");
			} catch (error) { this.error = error; }
			if (this.error) {
				if (this.policy !== "inspect") throw new SyntaxError(`Invalid JSONL record at byte ${this.start}: ${String(this.error)}`, { cause: this.error });
				malformed = this.error;
			} else record = { value: value!, start, end };
		}
		this.start = end;
		this.projection = new JsonProjection(this.select, this.stringChunk, this.keys);
		this.decoder = new TextDecoder("utf8", { fatal: true });
		this.error = undefined;
		this.nonblank = false;
		if (malformed) this.malformed?.(start, end, malformed);
		else if (record) this.record(record);
	}
	write(bytes: Buffer): void {
		const offset = this.offset;
		this.offset += bytes.length;
		let from = 0;
		for (let newline = bytes.indexOf(10); newline >= 0; newline = bytes.indexOf(10, from)) {
			this.part(bytes.subarray(from, newline));
			this.commit(offset + newline + 1);
			from = newline + 1;
		}
		this.part(bytes.subarray(from));
	}
	finish(): number {
		if (this.requireNewline) {
			if (this.policy === "strict" && this.nonblank) throw new SyntaxError(`Unpublished JSONL record at byte ${this.start}: newline required`);
		} else if (this.offset > this.start) this.commit(this.offset);
		return this.start;
	}
}

export function scanJournal(file: string | number, select: Projection, record: (record: JournalRecord) => void,
	options: { policy?: JournalPolicy; requireNewline?: boolean; start?: number; end?: number; malformed?: (start: number, end: number, error: unknown) => void; stringChunk?: ConstructorParameters<typeof JsonProjection>[1]; keys?: KeyLimit } = {}): number {
	const fd = typeof file === "number" ? file : fs.openSync(file, "r");
	try {
		const end = Math.min(options.end ?? Infinity, fs.fstatSync(fd).size);
		const frames = new JournalFrames(select, record, options.policy, options.start ?? 0, options.malformed, options.stringChunk, options.keys, options.requireNewline);
		const buffer = Buffer.allocUnsafe(64 * 1024);
		for (let offset = options.start ?? 0; offset < end;) {
			const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, end - offset), offset);
			if (!count) throw new Error("Journal truncated while reading");
			frames.write(buffer.subarray(0, count)); offset += count;
		}
		return frames.finish();
	} finally { if (typeof file !== "number") fs.closeSync(fd); }
}

export function readJsonProjection(file: string, select: Projection): any {
	// ponytail: selected frozen schemas and acceptance values fit their consumer's
	// heap, including arbitrary property names; discarded owner messages do not.
	const fd = fs.openSync(file, "r"), decoder = new TextDecoder("utf8", { fatal: true }), projection = new JsonProjection(select, undefined, () => Infinity);
	try {
		const end = fs.fstatSync(fd).size, bytes = Buffer.allocUnsafe(64 * 1024);
		for (let offset = 0; offset < end;) {
			const count = fs.readSync(fd, bytes, 0, Math.min(bytes.length, end - offset), offset);
			if (!count) throw new Error("JSON file truncated while reading");
			projection.write(decoder.decode(bytes.subarray(0, count), { stream: true })); offset += count;
		}
		projection.write(decoder.decode());
		const value = projection.finish();
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyntaxError("Owner records must be objects");
		return value;
	} catch (error) { throw new SyntaxError(`Invalid JSON file ${file}: ${String(error)}`, { cause: error }); }
	finally { fs.closeSync(fd); }
}

/** Compact owner reads never hydrate transcript arrays or historical output strings. */
export const ownerProjection: Projection = (path) => {
	const resultField = path.length === 2 && path[0] === "result"
		|| path.length === 3 && path[0] === "results" && typeof path[1] === "number"
		|| path.length === 4 && path[0] === "children" && typeof path[1] === "number" && path[2] === "result";
	if (resultField && path.at(-1) === "messages") return false;
	const preview = resultField && ["output", "finalOutput", "initialOutput", "rawOutput"].includes(String(path.at(-1)))
		|| path.length === 1 && path[0] === "summary"
		|| path.length === 3 && path[0] === "children" && typeof path[1] === "number" && path[2] === "summary";
	return preview ? 8192 : true;
};

const entryFields = new Set(["type", "id", "parentId", "timestamp", "version", "cwd", "parentSession", "checkpoint", "provider", "model", "modelId", "thinkingLevel", "customType", "usage", "firstKeptEntryId", "fromId"]);
const messageFields = new Set(["role", "provider", "model", "responseModel", "thinkingLevel", "usage", "stopReason", "errorMessage", "timestamp", "toolCallId", "toolName", "isError", "content", "command", "output", "exitCode", "cancelled"]);
/** Metadata/previews, never unrelated custom data, image bytes or raw tool details. */
export const nativeProjection: Projection = (path, root) => {
	if (!path.length) return true;
	if (path[0] === "message") {
		if (path.length === 1) return true;
		if (!messageFields.has(String(path[1]))) return false;
		if (path[1] === "content") {
			if (path.length <= 3) return 2048;
			if (path[3] === "arguments") {
				if (path.length === 4) return true;
				if (path.length === 5) return Object.keys(root?.message?.content?.[Number(path[2])]?.arguments ?? {}).length < 32 ? 2048 : false;
				return path.length === 6 && path[5] === 0 ? 2048 : false;
			}
			return ["type", "id", "name", "text", "thinking", "mimeType", "arguments"].includes(String(path[3])) ? 2048 : false;
		}
		return path[1] === "usage" ? true : 4096;
	}
	if (path[0] === "summary" || path[0] === "content") return 2048;
	if (path[0] === "details") return path.length === 1 || ["bodyText", "message", "from"].includes(String(path[1])) ? 2048 : false;
	return entryFields.has(String(path[0])) ? 4096 : false;
};

export interface NativeRecord extends JournalRecord { value: JsonObject & { id: string; type: string } }
export class NativeJournal {
	readonly records: NativeRecord[] = [];
	readonly byId = new Map<string, NativeRecord>();
	readonly stamp: string;
	readonly identity: string;
	readonly end: number;
	private readonly publishedEnd: number;
	private readonly prefixHash?: Hash;
	private readonly policy: JournalPolicy;
	private readonly requireNewline: boolean;
	readonly file: string;
	constructor(file: string, policy: JournalPolicy = "inspect", requireNewline = policy === "live", previous?: NativeJournal, verifyPrefix = false) {
		this.file = file; this.policy = policy; this.requireNewline = requireNewline;
		const fd = fs.openSync(file, "r");
		try {
			const stat = fs.fstatSync(fd, { bigint: true });
			this.stamp = journalStamp(stat); this.identity = `${stat.dev}:${stat.ino}`; this.end = Number(stat.size);
			const candidate = verifyPrefix && requireNewline && previous?.prefixHash && previous.requireNewline && previous.policy === policy && previous.file === file && previous.identity === this.identity && previous.end < this.end;
			const prefix = candidate ? this.hashRange(fd, previous.publishedEnd) : undefined;
			const append = candidate && prefix!.copy().digest("hex") === previous.prefixHash.copy().digest("hex");
			if (append) {
				this.records = previous.records.slice();
				this.byId = new Map(previous.byId);
			}
			let parent: string | null = this.records.findLast((record) => record.value.type !== "session")?.value.id ?? null;
			this.publishedEnd = scanJournal(fd, nativeProjection, (record) => {
				const entry = record.value;
				if (entry.type !== "session") {
					// Read-only legacy v1 presentation uses stable offset IDs, without rewriting the source.
					entry.id ??= `legacy-${record.start}`;
					if (this.records[0]?.value.version === 1) entry.parentId = parent;
					parent = entry.id;
				}
				this.records.push(record as NativeRecord); this.byId.set(entry.id, record as NativeRecord);
			}, { policy, requireNewline, start: append ? previous.publishedEnd : 0, end: this.end });
			if (verifyPrefix) this.prefixHash = this.hashRange(fd, this.publishedEnd, append ? previous.publishedEnd : 0, append ? prefix : undefined);
			if (journalStamp(fs.fstatSync(fd, { bigint: true })) !== this.stamp) throw new Error("Journal changed while indexing; refresh history.");
		} finally { fs.closeSync(fd); }
		if (this.records[0]?.value.type !== "session") throw new Error("Not a readable native Pi session.");
	}
	// ponytail: mutable journals require linear byte verification. Only appended
	// records are tokenized; a native immutable-prefix contract could remove hashing.
	private hashRange(fd: number, end: number, start = 0, hash = createHash("sha256")): Hash {
		const bytes = Buffer.allocUnsafe(64 * 1024);
		for (let offset = start; offset < end;) {
			const count = fs.readSync(fd, bytes, 0, Math.min(bytes.length, end - offset), offset);
			if (!count) throw new Error("Journal truncated while verifying history.");
			hash.update(bytes.subarray(0, count)); offset += count;
		}
		return hash;
	}
	hasPrefix(previous: NativeJournal): boolean {
		if (!previous.prefixHash || this.identity !== previous.identity || this.end < previous.end) return false;
		const fd = fs.openSync(this.file, "r");
		try {
			return journalStamp(fs.fstatSync(fd, { bigint: true })) === this.stamp
				&& this.hashRange(fd, previous.publishedEnd).digest("hex") === previous.prefixHash.copy().digest("hex");
		} finally { fs.closeSync(fd); }
	}
	branch(leaf?: string | null, endedAt?: number): NativeRecord[] {
		if (leaf === null) return [];
		const eligible = endedAt === undefined ? this.records : this.records.filter((record) => record.value.type === "session" || Date.parse(record.value.timestamp) <= endedAt);
		let current = leaf ? this.byId.get(leaf) : eligible.findLast((record) => record.value.type !== "session");
		const path: NativeRecord[] = [], seen = new Set<string>(), allowed = new Set(eligible.map((record) => record.value.id));
		while (current && current.value.type !== "session" && allowed.has(current.value.id)) {
			if (seen.has(current.value.id)) throw new Error("Cyclic journal ancestry");
			seen.add(current.value.id); path.push(current);
			current = this.byId.get(current.value.parentId);
		}
		return path.reverse();
	}
	body(record: NativeRecord): any {
		const fd = fs.openSync(this.file, "r");
		try {
			if (journalStamp(fs.fstatSync(fd, { bigint: true })) !== this.stamp) throw new Error("Journal changed; refresh before reading history.");
			// ponytail: explicitly requested individual bodies must fit the consumer's heap;
			// metadata and previews stay bounded. Use pages for large output.
			const bytes = Buffer.alloc(record.end - record.start);
			if (fs.readSync(fd, bytes, 0, bytes.length, record.start) !== bytes.length) throw new Error("Journal truncated");
			const body = JSON.parse(bytes.toString("utf8"));
			if (body.type !== "session") { body.id ??= record.value.id; body.parentId ??= record.value.parentId; }
			return body;
		} finally { fs.closeSync(fd); }
	}
	configuration(endedAt?: number, leaf?: string | null): { model?: string; thinking?: string; modelRecordedAt?: number } {
		const result: ReturnType<NativeJournal["configuration"]> = {};
		let model: NativeRecord["value"] | undefined;
		for (const { value } of this.branch(leaf, endedAt)) {
			if (value.type === "thinking_level_change") result.thinking = value.thinkingLevel;
			if (value.type === "model_change" || value.type === "message" && value.message?.role === "assistant") model = value;
		}
		if (model) {
			result.model = model.type === "model_change" ? `${model.provider}/${model.modelId}` : `${model.message.provider}/${model.message.model}`;
			result.modelRecordedAt = Date.parse(model.timestamp);
		}
		return result;
	}
}

export function journalStamp(stat: fs.BigIntStats): string { return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`; }

/** Read a UTF-8 page or tail without reading its preceding output. */
export function readOutputPage(file: string, options: { offset?: number; length?: number } = {}): { text: string; offset: number; nextOffset?: number; size: number } {
	const fd = fs.openSync(file, "r");
	try {
		const size = fs.fstatSync(fd).size, length = options.length ?? 64 * 1024;
		if (!Number.isSafeInteger(length) || length < 1 || length > 1024 * 1024 || options.offset !== undefined && (!Number.isSafeInteger(options.offset) || options.offset < 0)) throw new Error("Invalid output page");
		const offset = Math.min(size, options.offset ?? Math.max(0, size - length));
		const bytes = Buffer.alloc(Math.min(length, size - offset));
		const count = fs.readSync(fd, bytes, 0, bytes.length, offset);
		let start = 0, end = count;
		while (start < end && (bytes[start]! & 0xc0) === 0x80) start++;
		if (offset + end < size) {
			let last = end - 1;
			while (last >= start && (bytes[last]! & 0xc0) === 0x80) last--;
			const lead = bytes[last]!, width = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
			if (last + width > end) end = last;
		}
		return { text: bytes.subarray(start, end).toString("utf8"), offset: offset + start, size, ...(offset + end < size ? { nextOffset: offset + end } : {}) };
	} finally { fs.closeSync(fd); }
}
