import {
  HistoryIndexError,
  type HistoryVersion,
  type HistoryRunOptions,
  type HistoryRunPage,
  type HistoryPageInput,
  type HistoryPage,
  type HistorySearchInput,
  type HistorySearchPage,
  type HistoryEntryInput,
  type HistoryEntry,
  type HistoryByteRef,
} from "./types.ts";
import type { HistoryStore } from "./store.ts";
import { entryRow, type EntryRow, type SourceRow } from "./rows.ts";
import { QueryScope, type Boundary } from "./query-scope.ts";
import { RunQueries } from "./run-queries.ts";
import { TranscriptQueries } from "./transcript-queries.ts";
import { SearchQueries } from "./search-queries.ts";
import { validateRecord } from "./selected-record.ts";
import { compactEntry } from "./preview.ts";
import { hasText } from "./text.ts";

/** One query facade with separate run, transcript, search and selected-detail responsibilities. */
export class HistoryQueries {
  private readonly scope: Readonly<QueryScope>;
  private readonly runs: RunQueries;
  private readonly transcript: TranscriptQueries;
  private readonly searchQueries: SearchQueries;
  constructor(store: Readonly<HistoryStore>, info: () => HistoryVersion) {
    this.scope = new QueryScope(store, info);
    this.runs = new RunQueries(this.scope);
    this.transcript = new TranscriptQueries(this.scope);
    this.searchQueries = new SearchQueries(this.scope);
  }
  listRuns(options: HistoryRunOptions): HistoryRunPage {
    return this.runs.list(options);
  }
  historyPage(input: HistoryPageInput): HistoryPage {
    return this.transcript.page(input);
  }
  search(input: HistorySearchInput): HistorySearchPage {
    return this.searchQueries.search(input);
  }
  finalResultId(
    input: Pick<HistoryPageInput, "runId" | "index" | "terminalEntryId" | "endedAt">,
    digest: string,
    preferredRange?: readonly [number, number],
  ): string | undefined {
    return this.scope.finalResultId(input, digest, preferredRange);
  }
  private selectedRow(input: HistoryEntryInput): EntryRow | undefined {
    const { source } = this.scope.child(input.runId, input.index);
    if (!source) {
      return;
    }
    const boundary = this.scope.boundary(source, input);
    const where = boundary.clauses.join(" AND ");
    let row;
    if (input.ref) {
      return this.referenceRow(input.ref, source, boundary);
    } else if (hasText(input.entryId)) {
      row = this.scope.store.get(
        `SELECT * FROM entries WHERE ${where} AND id=?`,
        ...boundary.params,
        input.entryId,
      );
    } else if (hasText(input.toolCallId) && ["call", "result"].includes(input.kind ?? "call")) {
      const toolBoundary = this.scope.boundary(source, input, "e");
      row = this.scope.store.get(
        `SELECT e.* FROM tools t JOIN entries e ON e.rowid=t.entry_rowid WHERE ${toolBoundary.clauses.join(" AND ")} AND t.call_id=? AND t.kind=? ORDER BY e.start DESC LIMIT 1`,
        ...toolBoundary.params,
        input.toolCallId,
        input.kind ?? "call",
      );
    } else {
      throw new HistoryIndexError(
        "INVALID",
        "Select an entry ID, byte reference, or tool call/result ID.",
      );
    }
    return row ? entryRow(row) : undefined;
  }
  private referenceRow(ref: HistoryByteRef, source: SourceRow, boundary: Boundary): EntryRow {
    if (ref.sourceId !== source.id || ref.generation !== source.generation) {
      throw new HistoryIndexError(
        "SOURCE_CHANGED",
        "Selected source generation changed; refresh history.",
      );
    }
    const row = this.scope.store.get(
      `SELECT * FROM entries WHERE ${boundary.clauses.join(" AND ")} AND start=? AND end=? AND digest=?`,
      ...boundary.params,
      ref.start,
      ref.end,
      ref.digest,
    );
    if (!row) {
      throw new HistoryIndexError(
        "SOURCE_CHANGED",
        "Selected byte reference is no longer indexed.",
      );
    }
    return entryRow(row);
  }
  selected(input: HistoryEntryInput, full: true): Readonly<Record<string, unknown>> | null;
  selected(input: HistoryEntryInput, full: false): HistoryEntry | null;
  selected(
    input: HistoryEntryInput,
    full: boolean,
  ): Readonly<Record<string, unknown>> | HistoryEntry | null {
    const { source } = this.scope.child(input.runId, input.index);
    const row = this.selectedRow(input);
    if (!source || !row) {
      return null;
    }
    const body = validateRecord(source, row, full);
    return full
      ? body
      : { ...this.scope.store.entry(row), entry: { ...compactEntry(body), id: row.id } };
  }
}
