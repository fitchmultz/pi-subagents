import * as fs from "node:fs";
import { createHash } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import { JsonProjection } from "../shared/journal-reader.ts";
import { compactEntry, identity, previewLimits, previewProjection } from "./ingest.ts";
import { HistoryIndexError } from "./types.ts";
import { hash, HistoryStore, integer, pageLimit, type EntryRow, type SourceRow } from "./store.ts";
import type { HistoryConfiguration, HistoryEntryInput, HistoryPage, HistoryPageInput, HistoryRunOptions, HistoryRunPage, HistoryRunRow, HistorySearchInput, HistorySearchPage, HistoryVersion } from "./types.ts";

interface Cursor { generation: string; owner: string; version: number; query: string; keys: (string | number)[]; offset: number }
export class HistoryQueries {
	private store: HistoryStore;
	private info: () => HistoryVersion;
	constructor(store: HistoryStore, info: () => HistoryVersion) { this.store = store; this.info = info; }
	private cursor(query: string, keys: (string | number)[], offset: number): string {
		return Buffer.from(JSON.stringify({ generation: this.store.generation, owner: this.store.owner, version: this.info().version, query, keys, offset } satisfies Cursor)).toString("base64url");
	}
	private parseCursor(value: string | undefined, query: string): Cursor | undefined {
		if (value === undefined) return;
		let cursor: Cursor;
		try {
			if (value.length > 4096) throw new Error();
			cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
			if (!Array.isArray(cursor.keys) || cursor.keys.length > 8 || cursor.keys.some((key) => typeof key !== "number" && typeof key !== "string") || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw new Error();
		} catch { throw new HistoryIndexError("INVALID_CURSOR", "Invalid history cursor."); }
		if (cursor.generation !== this.store.generation || cursor.owner !== this.store.owner || cursor.query !== query || cursor.version !== this.info().version) throw new HistoryIndexError("STALE_CURSOR", "History changed or this cursor belongs to a different query/source; restart paging.");
		return cursor;
	}
	private child(runId: string, index: number): { source?: SourceRow; agent: string } {
		integer(index, 0);
		const child = this.store.get("SELECT * FROM children WHERE run_id=? AND child_index=?", runId, index);
		if (!child) throw new HistoryIndexError("OWNERSHIP", "Run/child is not in the current owner's admitted handles.");
		return { source: child.source_id ? this.store.source(child.source_id) : undefined, agent: child.agent };
	}
	listRuns(options: HistoryRunOptions): HistoryRunPage {
		const limit = pageLimit(options.limit, 20), offset = integer(options.offset, 0), sort = options.sort ?? "attention";
		if (!["attention", "newest", "oldest"].includes(sort)) throw new HistoryIndexError("INVALID", "Unsupported run sort.");
		if (options.state && !["live", "completed", "paused", "blocked", "failed", "unknown"].includes(options.state)) throw new HistoryIndexError("INVALID", "Unsupported run state.");
		if ((options.text?.length ?? 0) > 256 || (options.agent?.length ?? 0) > 256 || options.latestTasksOnly !== undefined && typeof options.latestTasksOnly !== "boolean") throw new HistoryIndexError("INVALID", "Invalid run filter.");
		const query = hash(JSON.stringify(["runs", sort, options.agent ?? null, options.state ?? null, options.text?.toLowerCase() ?? null, options.latestTasksOnly ?? false]));
		const cursor = this.parseCursor(options.cursor, query);
		if (cursor && options.offset !== undefined) throw new HistoryIndexError("INVALID", "Use cursor or offset, not both.");
		const clauses: string[] = [], params: SQLInputValue[] = [], childClauses: string[] = [], childParams: SQLInputValue[] = [];
		if (options.agent) { childClauses.push("c.agent=?"); childParams.push(options.agent); }
		if (options.text) { childClauses.push("instr(c.filter_text,?)>0"); childParams.push(options.text.toLowerCase()); }
		if (options.latestTasksOnly) childClauses.push("NOT EXISTS(SELECT 1 FROM runs successor WHERE successor.predecessor_id=c.run_id AND successor.predecessor_index=c.child_index)");
		const childWhere = childClauses.length ? ` AND ${childClauses.join(" AND ")}` : "";
		if (childWhere) { clauses.push(`EXISTS(SELECT 1 FROM children c WHERE c.run_id=r.id${childWhere})`); params.push(...childParams); }
		if (options.state) { clauses.push("r.state=?"); params.push(options.state); }
		const total = Number(this.store.get(`SELECT COUNT(*) AS total FROM runs r ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}`, ...params).total);
		const columns = sort === "attention" ? ["attention", "negative_updated", "id"] : [sort === "newest" ? "negative_updated" : "updated", "id"];
		if (cursor) {
			if (cursor.keys.length !== columns.length) throw new HistoryIndexError("INVALID_CURSOR", "Invalid run seek tuple.");
			clauses.push(`(${columns.map((column) => `r.${column}`).join(",")}) > (${columns.map(() => "?").join(",")})`); params.push(...cursor.keys);
		}
		const rows = this.store.all(`SELECT * FROM runs r ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY ${columns.map((column) => `r.${column}`).join(",")} LIMIT ? OFFSET ?`, ...params, limit + 1, cursor ? 0 : offset);
		const more = rows.length > limit, page = rows.slice(0, limit), position = cursor?.offset ?? offset;
		const views = page.map((row) => {
			const view = JSON.parse(row.view) as HistoryRunRow;
			if (childWhere) view.matchedChildIndexes = this.store.all(`SELECT child_index FROM children c WHERE c.run_id=?${childWhere} ORDER BY child_index`, view.runId, ...childParams).map((child) => child.child_index);
			for (const child of view.children) {
				const { source } = this.child(view.runId, child.index);
				if (source) child.nativeConfiguration = this.configuration(source, child.state === "live" ? {} : { terminalEntryId: child.result?.terminalEntryId, endedAt: child.result?.terminalEntryId ? undefined : view.updatedAt, leaf: child.result?.terminalLeafId }, false);
			}
			return view;
		});
		return { rows: views, total, offset: position, ...this.info(), ...(more ? { nextOffset: position + page.length, nextCursor: this.cursor(query, columns.map((column) => page.at(-1)![column]), position + page.length) } : {}) };
	}
	private boundary(source: SourceRow, input: Pick<HistoryPageInput, "terminalEntryId" | "endedAt">, alias = ""): { clauses: string[]; params: SQLInputValue[]; terminalSequence?: number } {
		const column = alias ? `${alias}.` : "", clauses = [`${column}source_id=?`, `${column}generation=?`, `${column}published=1`], params: SQLInputValue[] = [source.id, source.generation];
		let terminalSequence: number | undefined;
		if (input.terminalEntryId) {
			const terminal = this.store.get("SELECT start FROM entries WHERE source_id=? AND generation=? AND id=? AND published=1", source.id, source.generation, input.terminalEntryId);
			if (!terminal) throw new HistoryIndexError("BOUNDARY_UNAVAILABLE", "Saved terminal entry is not available in the current indexed generation.");
			terminalSequence = terminal.start; clauses.push(`${column}start<=?`); params.push(terminal.start);
		} else if (input.endedAt !== undefined) { clauses.push(`${column}timestamp<=?`); params.push(integer(input.endedAt, 0)); }
		return { clauses, params, terminalSequence };
	}
	private configuration(source: SourceRow, input: Pick<HistoryPageInput, "terminalEntryId" | "endedAt" | "leaf">, strict = true): HistoryConfiguration {
		if (input.leaf === null) return {};
		let boundary: ReturnType<HistoryQueries["boundary"]>;
		try { boundary = this.boundary(source, input); } catch (error) { if (!strict && error instanceof HistoryIndexError && error.code === "BOUNDARY_UNAVAILABLE") return {}; throw error; }
		const leaf = input.leaf ?? this.store.get(`SELECT id FROM entries WHERE ${boundary.clauses.join(" AND ")} ORDER BY start DESC LIMIT 1`, ...boundary.params)?.id;
		if (!leaf) return {};
		const ancestry = `WITH RECURSIVE eligible AS (SELECT rowid,id,parent_id,start,timestamp,configuration_model,configuration_thinking FROM entries WHERE ${boundary.clauses.join(" AND ")}), branch AS (SELECT * FROM eligible WHERE id=? UNION SELECT parent.* FROM eligible parent JOIN branch child ON parent.id=child.parent_id)`;
		const facts = this.store.get(`${ancestry} SELECT
			(SELECT COUNT(*) FROM branch) AS count,
			EXISTS(SELECT 1 FROM branch child WHERE parent_id IS NULL OR NOT EXISTS(SELECT 1 FROM eligible parent WHERE parent.id=child.parent_id)) AS rooted,
			(SELECT configuration_model FROM branch WHERE configuration_model IS NOT NULL ORDER BY start DESC LIMIT 1) AS model,
			(SELECT timestamp FROM branch WHERE configuration_model IS NOT NULL ORDER BY start DESC LIMIT 1) AS recorded_at,
			(SELECT configuration_thinking FROM branch WHERE configuration_thinking IS NOT NULL ORDER BY start DESC LIMIT 1) AS thinking`, ...boundary.params, leaf);
		if (!facts.count && input.leaf && strict) throw new HistoryIndexError("BOUNDARY_UNAVAILABLE", "Selected configuration leaf is not available in the indexed generation.");
		if (facts.count && !facts.rooted) { if (!strict) return {}; throw new HistoryIndexError("MALFORMED_ANCESTRY", "Selected native configuration has cyclic ancestry."); }
		return { ...(facts.model ? { model: facts.model, modelRecordedAt: facts.recorded_at ?? undefined } : {}), ...(facts.thinking ? { thinking: facts.thinking } : {}) };
	}
	historyPage(input: HistoryPageInput): HistoryPage {
		const { source } = this.child(input.runId, input.index);
		const info = this.info(), limit = pageLimit(input.limit);
		if (input.before !== undefined && input.after !== undefined) throw new HistoryIndexError("INVALID", "Use before or after, not both.");
		if (input.messageIds && (!Array.isArray(input.messageIds) || input.messageIds.length > 1000 || input.messageIds.some((id) => typeof id !== "string" || id.length > 512)) || input.readThrough !== undefined && input.readThrough !== null && (typeof input.readThrough !== "string" || input.readThrough.length > 1024)) throw new HistoryIndexError("INVALID", "Invalid scoped message/read metadata request.");
		const empty: HistoryPage = { ...info, entries: [], count: 0, hasMore: false, sourceId: source?.id ?? null, generation: source?.generation ?? null, sessionId: source?.session_id ?? null, sourceState: source?.state ?? "unlinked", configuration: {}, deliveredMessages: [], latestEntryId: null };
		if (!source) return { ...empty, unavailable: "This legacy or unstarted child has no linked native conversation." };
		const query = hash(JSON.stringify(["history", input.runId, input.index, source.id, source.generation, input.terminalEntryId ?? null, input.endedAt ?? null, input.leaf ?? null]));
		const cursor = this.parseCursor(input.cursor, query);
		if (cursor && (input.before !== undefined || input.after !== undefined)) throw new HistoryIndexError("INVALID", "Use cursor or sequence, not both.");
		const { clauses, params, terminalSequence } = this.boundary(source, input);
		const metadataWhere = clauses.join(" AND "), metadataParams = params.slice();
		const latest = this.store.get(`SELECT start,visible_id FROM entries WHERE ${metadataWhere} AND visible_id IS NOT NULL ORDER BY start DESC LIMIT 1`, ...metadataParams);
		const marker = typeof input.readThrough === "string" ? this.store.get(`SELECT start,visible_id FROM entries WHERE ${metadataWhere} AND id=?`, ...metadataParams, input.readThrough.replace(/:(?:\d+|error)$/, "")) : undefined;
		const deliveredMessages: Array<[string, boolean]> = [];
		for (const id of new Set(input.messageIds ?? [])) {
			const human = this.store.get(`SELECT start FROM entries WHERE ${metadataWhere} AND human_id=? ORDER BY start DESC LIMIT 1`, ...metadataParams, id);
			if (human) deliveredMessages.push([id, Boolean(this.store.get(`SELECT rowid FROM entries WHERE ${metadataWhere} AND start>? AND assistant_text=1 LIMIT 1`, ...metadataParams, human.start))]);
		}
		const outputDigest = this.store.get("SELECT output_digest FROM children WHERE run_id=? AND child_index=?", input.runId, input.index)?.output_digest;
		const finalResultId = outputDigest ? this.finalResultId(input, outputDigest) : undefined;
		const configuration = this.configuration(source, input);
		const count = Number(this.store.get(`SELECT COUNT(*) AS count FROM entries WHERE ${metadataWhere}`, ...metadataParams).count);
		const before = cursor ? integer(cursor.keys[0], 0) : input.before;
		if (before !== undefined) { clauses.push("start<?"); params.push(integer(before, 0)); }
		if (input.after !== undefined) { clauses.push("start>?"); params.push(integer(input.after, 0)); }
		const forward = input.after !== undefined;
		const fetched = this.store.all(`SELECT * FROM entries WHERE ${clauses.join(" AND ")} ORDER BY start ${forward ? "ASC" : "DESC"} LIMIT ?`, ...params, limit + 1) as EntryRow[];
		const more = fetched.length > limit, rows = fetched.slice(0, limit);
		if (!forward) rows.reverse();
		const first = rows[0], last = rows.at(-1);
		const previous = first && this.store.get(`SELECT start FROM entries WHERE ${metadataWhere} AND start<? LIMIT 1`, ...metadataParams, first.start);
		return { ...empty, configuration, deliveredMessages, latestEntryId: latest?.visible_id ?? null, terminalSequence,
			...(input.readThrough !== undefined ? { unreadAfter: Boolean(latest && (!marker || latest.start > marker.start || latest.start === marker.start && latest.visible_id !== input.readThrough)) } : {}),
			...(finalResultId ? { finalResultId } : {}), entries: rows.map((row) => this.store.entry(row)), count, hasMore: forward ? more : Boolean(previous),
			...(previous && first ? { previousBefore: first.start, previousCursor: this.cursor(query, [first.start], 0) } : {}),
			...(last ? { nextAfter: last.start } : {}), ...(source.error ? { unavailable: source.error } : source.state === "missing" ? { unavailable: "Linked conversation is missing." } : {}) };
	}
	search(input: HistorySearchInput): HistorySearchPage {
		const expression = searchGrammar(input.query), limit = pageLimit(input.limit, 20), sort = input.sort ?? "relevance";
		if (!["relevance", "newest"].includes(sort)) throw new HistoryIndexError("INVALID", "Unsupported search sort.");
		if (input.index !== undefined && !input.runId) throw new HistoryIndexError("INVALID", "A child search requires runId.");
		if (input.runId && !this.store.get("SELECT id FROM runs WHERE id=?", input.runId)) throw new HistoryIndexError("OWNERSHIP", "Run is not admitted by the current owner.");
		if (input.index !== undefined) this.child(input.runId!, input.index);
		if (input.runId) for (const child of this.store.all(`SELECT source_id,terminal_entry_id,ended_at FROM children WHERE run_id=?${input.index !== undefined ? " AND child_index=?" : ""}`, input.runId, ...(input.index !== undefined ? [input.index] : []))) {
			const source = child.source_id && this.store.source(child.source_id);
			if (source) this.boundary(source, { terminalEntryId: child.terminal_entry_id ?? undefined, endedAt: child.ended_at ?? undefined });
		}
		const query = hash(JSON.stringify(["search", expression, sort, input.runId ?? null, input.index ?? null, input.agent ?? null]));
		const cursor = this.parseCursor(input.cursor, query);
		const clauses = ["corpus MATCH ?", "e.published=1", "e.generation=s.generation", "(c.terminal_entry_id IS NULL OR e.start<=terminal.start)", "(c.ended_at IS NULL OR e.timestamp<=c.ended_at)"], params: SQLInputValue[] = [expression];
		if (input.runId) { clauses.push("c.run_id=?"); params.push(input.runId); }
		if (input.index !== undefined) { clauses.push("c.child_index=?"); params.push(input.index); }
		if (input.agent) { if (input.agent.length > 256) throw new HistoryIndexError("INVALID", "Agent filter is too long."); clauses.push("c.agent=?"); params.push(input.agent); }
		// Ordering/filters apply globally before limit. Common terms may still require an FTS
		// scan/sort; the parent enforces a hard deadline by killing this separate process.
		const score = sort === "relevance" ? "bm25(corpus)" : "-COALESCE(e.timestamp,0)";
		if (cursor) {
			if (cursor.keys.length !== 4) throw new HistoryIndexError("INVALID_CURSOR", "Invalid search seek tuple.");
			clauses.push(`(${score},d.id,c.run_id,c.child_index)>(?,?,?,?)`); params.push(...cursor.keys);
		}
		const rows = this.store.all(`SELECT d.*,${score} AS score,e.*,d.id AS document_id,s.path,s.session_id,c.run_id,c.child_index,c.agent,d.preview AS document_preview FROM corpus JOIN documents d ON d.id=corpus.rowid JOIN entries e ON e.rowid=d.entry_rowid JOIN sources s ON s.id=e.source_id JOIN children c ON c.source_id=s.id LEFT JOIN entries terminal ON terminal.source_id=s.id AND terminal.generation=s.generation AND terminal.id=c.terminal_entry_id AND terminal.published=1 WHERE ${clauses.join(" AND ")} ORDER BY score,d.id,c.run_id,c.child_index LIMIT ?`, ...params, limit + 1);
		const more = rows.length > limit, page = rows.slice(0, limit);
		return { ...this.info(), matches: page.map((row) => ({ id: row.document_id, runId: row.run_id, index: row.child_index, agent: row.agent, entryId: row.id, nativeId: row.native_id, sessionId: row.session_id, sessionFile: row.path, timestamp: row.timestamp,
			ref: { sourceId: row.source_id, generation: row.generation, start: row.start, end: row.end, digest: row.digest }, preview: row.document_preview, field: row.field, textStart: row.text_start, textEnd: row.text_end, score: row.score })),
			...(more ? { nextCursor: this.cursor(query, [page.at(-1)!.score, page.at(-1)!.document_id, page.at(-1)!.run_id, page.at(-1)!.child_index], (cursor?.offset ?? 0) + page.length) } : {}) };
	}
	finalResultId(input: Pick<HistoryPageInput, "runId" | "index" | "terminalEntryId" | "endedAt">, digest: string): string | undefined {
		const { source } = this.child(input.runId, input.index);
		if (!source) return;
		const boundary = this.boundary(source, input, "e");
		return this.store.get(`SELECT a.item_id FROM answers a JOIN entries e ON e.rowid=a.entry_rowid WHERE a.digest=? AND ${boundary.clauses.join(" AND ")} ORDER BY e.start DESC LIMIT 1`, digest, ...boundary.params)?.item_id;
	}
	selected(input: HistoryEntryInput, full: boolean): any {
		const { source } = this.child(input.runId, input.index);
		if (!source) return null;
		const boundary = this.boundary(source, input), where = boundary.clauses.join(" AND ");
		let row: EntryRow | undefined;
		if (input.ref) {
			if (input.ref.sourceId !== source.id || input.ref.generation !== source.generation) throw new HistoryIndexError("SOURCE_CHANGED", "Selected source generation changed; refresh history.");
			row = this.store.get(`SELECT * FROM entries WHERE ${where} AND start=? AND end=? AND digest=?`, ...boundary.params, input.ref.start, input.ref.end, input.ref.digest);
			if (!row) throw new HistoryIndexError("SOURCE_CHANGED", "Selected byte reference is no longer indexed.");
		} else if (input.entryId) row = this.store.get(`SELECT * FROM entries WHERE ${where} AND id=?`, ...boundary.params, input.entryId);
		else if (input.toolCallId && ["call", "result"].includes(input.kind ?? "call")) row = this.store.get(`SELECT e.* FROM tools t JOIN entries e ON e.rowid=t.entry_rowid WHERE ${this.boundary(source, input, "e").clauses.join(" AND ")} AND t.call_id=? AND t.kind=? ORDER BY e.start DESC LIMIT 1`, ...boundary.params, input.toolCallId, input.kind ?? "call");
		else throw new HistoryIndexError("INVALID", "Select an entry ID, byte reference, or tool call/result ID.");
		if (!row) return null;
		const body = validateRecord(source, row, full);
		return full ? body : { ...this.store.entry(row), entry: { ...compactEntry(body), id: row.id } };
	}
}
function searchGrammar(query: string): string {
	if (typeof query !== "string" || !query.trim() || query.length > 1024) throw new HistoryIndexError("INVALID_QUERY", "Search requires 1–12 tokens or one quoted phrase.");
	const text = query.trim(), phrase = text.startsWith('"') && text.endsWith('"');
	const words = (phrase ? text.slice(1, -1) : text).trim().split(/\s+/u);
	if (!words.length || words.length > 12 || words.some((word) => !/^[\p{L}\p{N}\p{M}]{1,64}$/u.test(word) || !phrase && ["AND", "OR", "NOT", "NEAR"].includes(word))) throw new HistoryIndexError("INVALID_QUERY", "Only lexical tokens or one quoted phrase are supported; operators, punctuation, and prefixes are not allowed.");
	return phrase ? `"${words.join(" ")}"` : words.map((word) => `"${word}"`).join(" AND ");
}
function validateRecord(source: SourceRow, row: EntryRow, full: boolean): Record<string, any> {
	let fd: number | undefined;
	try {
		fd = fs.openSync(source.path, "r");
		const stat = fs.fstatSync(fd, { bigint: true });
		if (identity(stat) !== source.identity || Number(stat.size) < row.end) throw new HistoryIndexError("SOURCE_CHANGED", "Selected conversation was replaced or truncated.");
		const headerHash = createHash("sha256"), headerBytes = Buffer.allocUnsafe(64 * 1024);
		let headerPosition = 0, headerComplete = false;
		while (!headerComplete && headerPosition < 1024 * 1024) {
			const count = fs.readSync(fd, headerBytes, 0, headerBytes.length, headerPosition);
			if (!count) break;
			const newline = headerBytes.subarray(0, count).indexOf(10);
			const length = newline < 0 ? count : newline + 1;
			headerHash.update(headerBytes.subarray(0, length)); headerPosition += length; headerComplete = newline >= 0;
		}
		if (!headerComplete || headerHash.digest("hex") !== source.header_digest) throw new HistoryIndexError("SOURCE_CHANGED", "Selected native header changed or exceeds its validation budget.");
		if (full && row.end - row.start > 16 * 1024 * 1024) throw new HistoryIndexError("RECORD_TOO_LARGE", "Selected full record exceeds the 16 MiB detail budget; use its validated preview.");
		const digest = createHash("sha256"), parser = new JsonProjection(previewProjection, undefined, undefined, previewLimits), bytes = Buffer.allocUnsafe(64 * 1024), body: Buffer[] = [];
		const decoder = new TextDecoder("utf8", { fatal: true });
		for (let position = row.start; position < row.end;) {
			const count = fs.readSync(fd, bytes, 0, Math.min(bytes.length, row.end - position), position);
			if (!count) throw new HistoryIndexError("SOURCE_CHANGED", "Selected record was truncated during validation.");
			const chunk = bytes.subarray(0, count); digest.update(chunk);
			if (full) body.push(Buffer.from(chunk)); else parser.write(decoder.decode(chunk, { stream: true }));
			position += count;
		}
		const current = fs.statSync(source.path, { bigint: true }), after = fs.fstatSync(fd, { bigint: true });
		if (identity(current) !== identity(stat) || current.size < BigInt(row.end) || after.ctimeNs !== stat.ctimeNs && after.size <= stat.size || digest.digest("hex") !== row.digest) throw new HistoryIndexError("SOURCE_CHANGED", "Selected record changed; refresh history before reading details.");
		if (full) return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(body)));
		parser.write(decoder.decode()); return parser.finish()!;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new HistoryIndexError("SOURCE_CHANGED", "Selected conversation is missing.");
		if (error instanceof RangeError) throw new HistoryIndexError("RECORD_COMPLEXITY", "Selected preview exceeds bounded history structure budgets.");
		throw error;
	} finally { if (fd !== undefined) fs.closeSync(fd); }
}
