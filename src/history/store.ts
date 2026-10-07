import * as path from "node:path";
import { openGeneration } from "./database-generation.ts";
import { OutputDigests } from "./output-digests.ts";
import type { DatabaseSync } from "node:sqlite";
import { historyTransaction, openHistoryDatabase } from "./database.ts";
import { hash, safeText, hasText } from "./text.ts";
export { hash, exactTextDigest, safeText, integer, pageLimit } from "./text.ts";
import {
  HistoryIndexError,
  type HistoryEntry,
  type HistoryFreshness,
  type HistoryRunRow,
  type HistoryVersion,
  type HistoryIndexStatus,
} from "./types.ts";
import {
  sourceRow,
  indexRow,
  type Row,
  type IndexInput,
  type SourceRow,
  type EntryRow,
  number,
  text,
} from "./rows.ts";
import { parseObject, errorMessage } from "./values.ts";

export type { SourceRow, EntryRow } from "./rows.ts";
export class HistoryStore {
  readonly db: DatabaseSync;
  readonly generation: string;
  readonly file: string;
  readonly owner: string;
  private readonly counters = {
    sourceChecks: 0,
    sourceOpens: 0,
    sourceBytesRead: 0,
    runProjections: 0,
    queries: 0,
  };
  get operations(): Readonly<typeof this.counters> {
    return { ...this.counters };
  }
  count(operation: keyof typeof this.counters, amount = 1): void {
    this.counters[operation] += amount;
  }
  private ingestLock?: DatabaseSync;
  private readonly outputDigests = new OutputDigests();
  constructor(agentDir: string, owner: string) {
    this.owner = owner;
    const { db, file } = openGeneration(agentDir, owner);
    this.db = db;
    this.file = file;
    try {
      this.generation = text(
        this.require("SELECT value FROM meta WHERE key='generation'"),
        "value",
      );
      this.db.exec(
        "CREATE TEMP TABLE pending_text(field TEXT, position INTEGER, end_position INTEGER, text TEXT)",
      );
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  require(sql: string, ...params: readonly IndexInput[]): Row {
    const row = this.get(sql, ...params);
    if (!row) {
      throw new HistoryIndexError("CORRUPT", "Missing required index row.");
    }
    return row;
  }
  get(sql: string, ...params: readonly IndexInput[]): Row | undefined {
    const row = this.db.prepare(sql).get(...params);
    return row === undefined ? undefined : indexRow(row);
  }
  all(sql: string, ...params: readonly IndexInput[]): readonly Row[] {
    return this.db
      .prepare(sql)
      .all(...params)
      .map(indexRow);
  }
  run(
    sql: string,
    ...params: readonly IndexInput[]
  ): ReturnType<ReturnType<DatabaseSync["prepare"]>["run"]> {
    return this.db.prepare(sql).run(...params);
  }
  deleteDocuments(sourceId: string, unpublishedOnly = false): void {
    const where = `entry_rowid IN (SELECT rowid FROM entries WHERE source_id=?${unpublishedOnly ? " AND published=0" : ""})`;
    this.run(
      `DELETE FROM corpus WHERE rowid IN (SELECT id FROM documents WHERE ${where})`,
      sourceId,
    );
    this.run(`DELETE FROM documents WHERE ${where}`, sourceId);
  }
  transaction<T>(work: () => T): T {
    return historyTransaction(this.db, work);
  }
  bump(): void {
    this.run("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='version'");
    this.run("UPDATE meta SET value=? WHERE key='indexedAt'", String(Date.now()));
  }
  source(id: string): SourceRow | undefined {
    const row = this.get("SELECT * FROM sources WHERE id=?", id);
    return row ? sourceRow(row) : undefined;
  }
  resetSource(id: string, state = "pending", error: string | null = null): void {
    this.transaction(() => {
      this.deleteDocuments(id);
      this.run("DELETE FROM entries WHERE source_id=?", id);
      this.run(
        "UPDATE sources SET generation=generation+1,identity=NULL,stamp=NULL,session_id=NULL,header_digest=NULL,format_version=NULL,cursor=0,prefix_digest=NULL,state=?,error=?,malformed=0,complexity=0,checked_at=? WHERE id=?",
        state,
        error,
        Date.now(),
        id,
      );
      this.bump();
    });
  }
  clearUnpublished(id: string): void {
    this.transaction(() => {
      this.deleteDocuments(id, true);
      this.run("DELETE FROM entries WHERE source_id=? AND published=0", id);
    });
  }
  putView(view: HistoryRunRow, full: HistoryRunRow = view): void {
    const attention = attentionRank(view);
    const json = JSON.stringify(view),
      filters = new Map(
        full.children.map((child) => [
          child.index,
          safeText(
            `${child.agent} ${child.label ?? ""} ${child.task ?? full.task}`,
            Infinity,
          ).toLowerCase(),
        ]),
      );
    const filterText = safeText(
      `${full.task} ${[...filters.values()].join(" ")}`,
      Infinity,
    ).toLowerCase();
    const digests = new Map(
      full.children.map((child) => [child.index, this.outputDigests.read(child.result)]),
    );
    const saved = this.get("SELECT view,filter_text FROM runs WHERE id=?", view.runId);
    if (
      saved?.view === json &&
      saved.filter_text === filterText &&
      this.all("SELECT child_index,output_digest FROM children WHERE run_id=?", view.runId).every(
        (child) => child.output_digest === digests.get(number(child, "child_index")),
      )
    ) {
      return;
    }
    this.transaction(() => {
      this.run(
        "INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET attention=excluded.attention,updated=excluded.updated,negative_updated=excluded.negative_updated,state=excluded.state,filter_text=excluded.filter_text,view=excluded.view,predecessor_id=excluded.predecessor_id,predecessor_index=excluded.predecessor_index",
        view.runId,
        attention,
        view.updatedAt,
        -view.updatedAt,
        view.state,
        filterText,
        json,
        view.predecessorRunId ?? null,
        view.predecessorIndex ?? 0,
      );
      this.putChildren(view, filters, digests);
      this.bump();
    });
  }
  private putChildren(
    view: HistoryRunRow,
    filters: Readonly<ReadonlyMap<number, string>>,
    digests: Readonly<ReadonlyMap<number, string | null>>,
  ): void {
    this.run("DELETE FROM children WHERE run_id=?", view.runId);
    for (const child of view.children) {
      let source: string | null = null;
      if (hasText(child.sessionFile)) {
        const file = path.resolve(child.sessionFile);
        source = hash(file);
        this.run(
          "INSERT INTO sources(id,path) VALUES (?,?) ON CONFLICT(id) DO NOTHING",
          source,
          file,
        );
      }
      const terminal = child.state !== "live" && child.state !== "unknown";
      const boundary = terminalBoundary(child, view.updatedAt, terminal);
      this.run(
        "INSERT INTO children VALUES (?,?,?,?,?,?,?,?)",
        view.runId,
        child.index,
        child.agent,
        source,
        filters.get(child.index) ?? "",
        digests.get(child.index) ?? null,
        boundary.entry,
        boundary.endedAt,
      );
    }
  }
  info(pending: number, projectionErrors = 0): HistoryVersion {
    const sources = this.require(
      "SELECT COUNT(*) AS total,SUM(state IN ('pending','indexing')) AS pending,SUM(state IN ('degraded','missing','error')) AS errors FROM sources WHERE id IN (SELECT source_id FROM children)",
    );
    const indexedAtValue = Number(
      text(this.require("SELECT value FROM meta WHERE key='indexedAt'"), "value"),
    );
    const indexedAt = indexedAtValue === 0 ? null : indexedAtValue;
    const errors = Number(sources.errors ?? 0) + projectionErrors;
    const remaining = pending + Number(sources.pending ?? 0);
    const freshness: HistoryFreshness = {
      authoritative: false,
      state: freshnessState(remaining, errors),
      pending: remaining,
      errors,
      indexedAt,
    };
    return {
      version: Number(text(this.require("SELECT value FROM meta WHERE key='version'"), "value")),
      indexedAt,
      freshness,
    };
  }
  status(pending: number): HistoryIndexStatus {
    return {
      ...this.info(pending),
      databaseFile: this.file,
      physicalSources: number(this.require("SELECT COUNT(*) AS count FROM sources"), "count"),
      publishedEntries: number(
        this.require("SELECT COUNT(*) AS count FROM entries WHERE published=1"),
        "count",
      ),
      operations: this.operations,
    };
  }
  entry(row: EntryRow): HistoryEntry {
    return {
      id: row.id,
      nativeId: row.native_id,
      parentId: row.parent_id,
      sequence: row.start,
      timestamp: row.timestamp,
      type: row.type,
      ref: {
        sourceId: row.source_id,
        generation: row.generation,
        start: row.start,
        end: row.end,
        digest: row.digest,
      },
      entry: parseObject(row.preview),
    };
  }
  /** A separate SQLite transaction serializes incremental staging without blocking browse queries.
   * SQLite releases it on process death; no PID lease, expiry, or stale-file deletion is needed. */
  beginIngest(): void {
    if (!this.ingestLock) {
      this.ingestLock = openHistoryDatabase(`${this.file}.ingest.sqlite`);
      this.ingestLock.exec("PRAGMA busy_timeout=0");
    }
    try {
      this.ingestLock.exec("BEGIN IMMEDIATE");
    } catch (error) {
      if (/locked|busy/i.test(errorMessage(error))) {
        throw new HistoryIndexError("INDEX_BUSY", "Another worker is indexing this generation.");
      }
      throw error;
    }
  }
  endIngest(): void {
    if (this.ingestLock?.isTransaction === true) {
      this.ingestLock.exec("ROLLBACK");
    }
  }
  close(): void {
    this.ingestLock?.close();
    this.db.close();
  }
}
function terminalBoundary(
  child: HistoryRunRow["children"][number],
  updatedAt: number,
  terminal: boolean,
): { readonly entry: string | null; readonly endedAt: number | null } {
  if (!terminal) {
    return { entry: null, endedAt: null };
  }
  return {
    entry: child.result?.terminalEntryId ?? null,
    endedAt: hasText(child.result?.terminalEntryId) ? null : updatedAt,
  };
}
function attentionRank(view: HistoryRunRow): number {
  if (view.attention.includes("awaiting_input")) {
    return 0;
  }
  if (view.attention.some((reason) => reason !== "unreviewed")) {
    return 1;
  }
  if (view.state === "live") {
    return 2;
  }
  return view.attention.length > 0 ? 3 : 4;
}
function freshnessState(pending: number, errors: number): HistoryFreshness["state"] {
  if (pending > 0) {
    return "catching-up";
  }
  return errors > 0 ? "degraded" : "current";
}
