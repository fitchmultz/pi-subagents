import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { historyDirectory, historyTransaction, openHistoryDatabase } from "./database.ts";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { HistoryIndexError } from "./types.ts";
import { readSavedOutput } from "./canonical-result.ts";
import type { HistoryEntry, HistoryFreshness, HistoryRunRow, HistoryVersion } from "./types.ts";

export const hash = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");
export const exactTextDigest = (text: string): string => hash(stripTerminalSequences(text).trim());
export const safeText = (value: unknown, limit = 1024): string => typeof value === "string" ? value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "").slice(0, limit) : "";
export function integer(value: unknown, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
	const result = value === undefined ? fallback : value;
	if (!Number.isSafeInteger(result) || Number(result) < 0 || Number(result) > maximum) throw new HistoryIndexError("INVALID", "Expected a bounded non-negative integer.");
	return Number(result);
}
export function pageLimit(value: unknown, fallback = 100): number {
	const limit = integer(value, fallback, 100);
	if (!limit) throw new HistoryIndexError("INVALID", "Page limit must be from 1 to 100.");
	return limit;
}
export interface SourceRow {
	id: string; path: string; generation: number; identity: string | null; stamp: string | null;
	session_id: string | null; header_digest: string | null; cursor: number; prefix_digest: string | null;
	state: string; error: string | null; malformed: number; complexity: number; checked_at: number | null; format_version: number | null;
}
export interface EntryRow {
	rowid: number; source_id: string; generation: number; id: string; native_id: string | null;
	parent_id: string | null; start: number; end: number; digest: string; timestamp: number | null;
	type: string; preview: string; published: number; role: string | null; assistant_text: number; visible_id: string | null; human_id: string | null;
	configuration_model: string | null; configuration_thinking: string | null;
}
export class HistoryStore {
	readonly db: DatabaseSync;
	readonly generation: string;
	readonly file: string;
	readonly owner: string;
	readonly operations = { sourceChecks: 0, sourceOpens: 0, sourceBytesRead: 0, runProjections: 0, queries: 0 };
	private outputDigests = new Map<string, { stamp: string; digest: string }>();
	constructor(agentDir: string, owner: string) {
		this.owner = owner;
		const directory = historyDirectory(agentDir);
		const manifest = path.join(directory, `${hash(owner)}.json`);
		let name: string | undefined;
		try {
			const saved = JSON.parse(fs.readFileSync(manifest, "utf8"));
			if (typeof saved.file === "string" && /^[a-f0-9-]+\.sqlite$/.test(saved.file)) name = saved.file;
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
		let db: DatabaseSync | undefined;
		if (name) {
			try {
				const file = path.join(directory, name);
				if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink()) throw new HistoryIndexError("CORRUPT", "Invalid index generation.");
				db = openHistoryDatabase(file);
				if (db.prepare("PRAGMA user_version").get()?.user_version !== 4) throw new HistoryIndexError("CORRUPT", "Invalid index schema.");
				db.prepare("SELECT value FROM meta WHERE key='generation'").get();
			} catch (error) {
				db?.close(); db = undefined;
				if (!isCorruption(error)) throw error;
				name = undefined;
			}
		}
		if (!name) {
			name = `${randomUUID()}.sqlite`;
			db = openHistoryDatabase(path.join(directory, name));
			this.schema(db);
			const temporary = `${manifest}.${process.pid}.${randomUUID()}`;
			fs.writeFileSync(temporary, JSON.stringify({ file: name }), { mode: 0o600 });
			fs.renameSync(temporary, manifest);
			// Never rename/unlink an open SQLite generation or separate its WAL. Old corrupt
			// generations remain private for diagnosis; the manifest selects the new projection.
		}
		this.db = db!; this.file = path.join(directory, name!);
		fs.chmodSync(this.file, 0o600);
		for (const suffix of ["-wal", "-shm"]) if (fs.existsSync(this.file + suffix)) fs.chmodSync(this.file + suffix, 0o600);
		this.generation = String(this.get("SELECT value FROM meta WHERE key='generation'")!.value);
		this.db.exec("CREATE TEMP TABLE pending_text(field TEXT, position INTEGER, end_position INTEGER, text TEXT)");
	}
	private schema(db: DatabaseSync): void {
		db.exec(`
			CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
			INSERT INTO meta VALUES ('generation','${randomUUID()}'),('version','0'),('indexedAt','0');
			CREATE TABLE runs(id TEXT PRIMARY KEY,attention INTEGER NOT NULL,updated INTEGER NOT NULL,negative_updated INTEGER NOT NULL,state TEXT NOT NULL,filter_text TEXT NOT NULL,view TEXT NOT NULL,predecessor_id TEXT,predecessor_index INTEGER);
			CREATE INDEX runs_predecessor ON runs(predecessor_id,predecessor_index);
			CREATE INDEX runs_attention ON runs(attention,negative_updated,id);
			CREATE INDEX runs_newest ON runs(negative_updated,id);
			CREATE INDEX runs_oldest ON runs(updated,id);
			CREATE INDEX runs_state ON runs(state,attention,negative_updated,id);
			CREATE TABLE sources(id TEXT PRIMARY KEY,path TEXT NOT NULL UNIQUE,generation INTEGER NOT NULL DEFAULT 1,identity TEXT,stamp TEXT,session_id TEXT,header_digest TEXT,cursor INTEGER NOT NULL DEFAULT 0,prefix_digest TEXT,state TEXT NOT NULL DEFAULT 'pending',error TEXT,malformed INTEGER NOT NULL DEFAULT 0,complexity INTEGER NOT NULL DEFAULT 0,checked_at INTEGER,format_version INTEGER);
			CREATE TABLE children(run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,child_index INTEGER NOT NULL,agent TEXT NOT NULL,source_id TEXT REFERENCES sources(id),filter_text TEXT NOT NULL,output_digest TEXT,terminal_entry_id TEXT,ended_at INTEGER,PRIMARY KEY(run_id,child_index));
			CREATE INDEX children_source ON children(source_id);
			CREATE INDEX children_agent ON children(agent,run_id);
			CREATE TABLE entries(rowid INTEGER PRIMARY KEY,source_id TEXT NOT NULL REFERENCES sources(id),generation INTEGER NOT NULL,id TEXT NOT NULL,native_id TEXT,parent_id TEXT,start INTEGER NOT NULL,end INTEGER NOT NULL,digest TEXT NOT NULL,timestamp INTEGER,type TEXT NOT NULL,preview TEXT NOT NULL,published INTEGER NOT NULL DEFAULT 0,role TEXT,assistant_text INTEGER NOT NULL DEFAULT 0,visible_id TEXT,human_id TEXT,configuration_model TEXT,configuration_thinking TEXT,UNIQUE(source_id,generation,id),UNIQUE(source_id,generation,start));
			CREATE INDEX entries_page ON entries(source_id,generation,published,start);
			CREATE INDEX entries_time ON entries(source_id,generation,published,timestamp,start);
			CREATE INDEX entries_human ON entries(source_id,generation,human_id,start);
			CREATE TABLE answers(entry_rowid INTEGER NOT NULL REFERENCES entries(rowid) ON DELETE CASCADE,digest TEXT NOT NULL,item_id TEXT NOT NULL,PRIMARY KEY(entry_rowid,digest));
			CREATE INDEX answers_digest ON answers(digest,entry_rowid);
			CREATE TABLE tools(entry_rowid INTEGER NOT NULL REFERENCES entries(rowid) ON DELETE CASCADE,source_id TEXT NOT NULL,generation INTEGER NOT NULL,call_id TEXT NOT NULL,kind TEXT NOT NULL);
			CREATE INDEX tools_lookup ON tools(source_id,generation,call_id,kind);
			CREATE TABLE documents(id INTEGER PRIMARY KEY,entry_rowid INTEGER NOT NULL REFERENCES entries(rowid) ON DELETE CASCADE,field TEXT NOT NULL,text_start INTEGER NOT NULL,text_end INTEGER NOT NULL,preview TEXT NOT NULL);
			CREATE INDEX documents_entry ON documents(entry_rowid);
			CREATE VIRTUAL TABLE corpus USING fts5(text,content='',contentless_delete=1,tokenize='unicode61');
			PRAGMA user_version=4;
		`);
	}
	get(sql: string, ...params: SQLInputValue[]): any { return this.db.prepare(sql).get(...params); }
	all(sql: string, ...params: SQLInputValue[]): any[] { return this.db.prepare(sql).all(...params); }
	run(sql: string, ...params: SQLInputValue[]): ReturnType<ReturnType<DatabaseSync["prepare"]>["run"]> { return this.db.prepare(sql).run(...params); }
	deleteDocuments(sourceId: string, unpublishedOnly = false): void {
		const where = `entry_rowid IN (SELECT rowid FROM entries WHERE source_id=?${unpublishedOnly ? " AND published=0" : ""})`;
		this.run(`DELETE FROM corpus WHERE rowid IN (SELECT id FROM documents WHERE ${where})`, sourceId);
		this.run(`DELETE FROM documents WHERE ${where}`, sourceId);
	}
	transaction<T>(work: () => T): T { return historyTransaction(this.db, work); }
	bump(): void { this.run("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='version'"); this.run("UPDATE meta SET value=? WHERE key='indexedAt'", String(Date.now())); }
	source(id: string): SourceRow | undefined { return this.get("SELECT * FROM sources WHERE id=?", id); }
	resetSource(id: string, state = "pending", error: string | null = null): void {
		this.transaction(() => {
			this.deleteDocuments(id);
			this.run("DELETE FROM entries WHERE source_id=?", id);
			this.run("UPDATE sources SET generation=generation+1,identity=NULL,stamp=NULL,session_id=NULL,header_digest=NULL,format_version=NULL,cursor=0,prefix_digest=NULL,state=?,error=?,malformed=0,complexity=0,checked_at=? WHERE id=?", state, error, Date.now(), id);
			this.bump();
		});
	}
	clearUnpublished(id: string): void {
		this.transaction(() => {
			this.deleteDocuments(id, true);
			this.run("DELETE FROM entries WHERE source_id=? AND published=0", id);
		});
	}
	private outputDigest(result: HistoryRunRow["children"][number]["result"]): string | null {
		if (!result) return null;
		if (!result.fullOutputPath) return typeof result.finalOutput === "string" && result.finalOutput.length !== 8192 && !result.truncation?.truncated ? exactTextDigest(result.finalOutput) : null;
		try {
			const stat = fs.statSync(result.fullOutputPath, { bigint: true });
			if (!stat.isFile() || stat.size > 16n * 1024n * 1024n) return null;
			const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
			const cached = this.outputDigests.get(result.fullOutputPath);
			if (cached?.stamp === stamp) return cached.digest;
			const text = readSavedOutput(result.fullOutputPath);
			const digest = exactTextDigest(text);
			this.outputDigests.set(result.fullOutputPath, { stamp, digest });
			return digest;
		} catch { return null; }
	}
	putView(view: HistoryRunRow, full: HistoryRunRow = view): void {
		const attention = view.attention.includes("awaiting_input") ? 0 : view.attention.some((reason) => reason !== "unreviewed") ? 1 : view.state === "live" ? 2 : view.attention.length ? 3 : 4;
		const json = JSON.stringify(view), filters = new Map(full.children.map((child) => [child.index, safeText(`${child.agent} ${child.label ?? ""} ${child.task ?? full.task}`, Infinity).toLowerCase()]));
		const filterText = safeText(`${full.task} ${[...filters.values()].join(" ")}`, Infinity).toLowerCase();
		const digests = new Map(full.children.map((child) => [child.index, this.outputDigest(child.result)]));
		const saved = this.get("SELECT view,filter_text FROM runs WHERE id=?", view.runId);
		if (saved?.view === json && saved.filter_text === filterText && this.all("SELECT child_index,output_digest FROM children WHERE run_id=?", view.runId).every((child) => child.output_digest === digests.get(child.child_index))) return;
		this.transaction(() => {
			this.run("INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET attention=excluded.attention,updated=excluded.updated,negative_updated=excluded.negative_updated,state=excluded.state,filter_text=excluded.filter_text,view=excluded.view,predecessor_id=excluded.predecessor_id,predecessor_index=excluded.predecessor_index", view.runId, attention, view.updatedAt, -view.updatedAt, view.state, filterText, json, view.predecessorRunId ?? null, view.predecessorIndex ?? 0);
			this.run("DELETE FROM children WHERE run_id=?", view.runId);
			for (const child of view.children) {
				let source: string | null = null;
				if (child.sessionFile) {
					const file = path.resolve(child.sessionFile); source = hash(file);
					this.run("INSERT INTO sources(id,path) VALUES (?,?) ON CONFLICT(id) DO NOTHING", source, file);
				}
				const terminal = child.state !== "live" && child.state !== "unknown";
				this.run("INSERT INTO children VALUES (?,?,?,?,?,?,?,?)", view.runId, child.index, child.agent, source, filters.get(child.index) ?? "", digests.get(child.index) ?? null,
					terminal ? child.result?.terminalEntryId ?? null : null, terminal && !child.result?.terminalEntryId ? view.updatedAt : null);
			}
			this.bump();
		});
	}
	info(pending: number): HistoryVersion {
		const sources = this.get("SELECT COUNT(*) AS total,SUM(state IN ('pending','indexing')) AS pending,SUM(state IN ('degraded','missing','error')) AS errors FROM sources WHERE id IN (SELECT source_id FROM children)");
		const indexedAt = Number(this.get("SELECT value FROM meta WHERE key='indexedAt'").value) || null;
		const errors = Number(sources.errors ?? 0);
		const remaining = pending + Number(sources.pending ?? 0);
		const freshness: HistoryFreshness = { authoritative: false, state: remaining ? "catching-up" : errors ? "degraded" : "current", pending: remaining, errors, indexedAt };
		return { version: Number(this.get("SELECT value FROM meta WHERE key='version'").value), indexedAt, freshness };
	}
	entry(row: EntryRow): HistoryEntry {
		return { id: row.id, nativeId: row.native_id, parentId: row.parent_id, sequence: row.start, timestamp: row.timestamp, type: row.type,
			ref: { sourceId: row.source_id, generation: row.generation, start: row.start, end: row.end, digest: row.digest }, entry: JSON.parse(row.preview) };
	}
	close(): void { this.db.close(); }
}
function isCorruption(error: unknown): boolean {
	return error instanceof HistoryIndexError && error.code === "CORRUPT" || /malformed|not a database|no such table|corrupt/i.test(String((error as Error).message));
}
