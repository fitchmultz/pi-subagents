import { HistoryIndexError, type HistoryPageInput, type HistoryPage } from "./types.ts";
import { integer, pageLimit } from "./text.ts";
import { entryRow, number, nullableText, type SourceRow, type EntryRow } from "./rows.ts";
import type { QueryScope, Boundary } from "./query-scope.ts";

function validate(input: HistoryPageInput): void {
  if (input.before !== undefined && input.after !== undefined) {
    throw new HistoryIndexError("INVALID", "Use before or after, not both.");
  }
  if (
    input.messageIds &&
    (!Array.isArray(input.messageIds) ||
      input.messageIds.length > 1000 ||
      input.messageIds.some((id) => typeof id !== "string" || id.length > 512))
  ) {
    throw new HistoryIndexError("INVALID", "Invalid scoped message metadata request.");
  }
  validateReadThrough(input.readThrough);
}
function validateReadThrough(value: unknown): void {
  if (value !== undefined && value !== null && (typeof value !== "string" || value.length > 1024)) {
    throw new HistoryIndexError("INVALID", "Invalid scoped read metadata request.");
  }
}
function emptyPage(scope: Readonly<QueryScope>, source: SourceRow | undefined): HistoryPage {
  return {
    ...scope.info(),
    entries: [],
    count: 0,
    hasMore: false,
    sourceId: source?.id ?? null,
    generation: source?.generation ?? null,
    sessionId: source?.session_id ?? null,
    sourceState: source?.state ?? "unlinked",
    configuration: {},
    deliveredMessages: [],
    latestEntryId: null,
  };
}
function queryKey(scope: Readonly<QueryScope>, input: HistoryPageInput, source: SourceRow): string {
  return scope.key([
    "history",
    input.runId,
    input.index,
    source.id,
    source.generation,
    input.terminalEntryId ?? null,
    input.endedAt ?? null,
    input.leaf ?? null,
  ]);
}
export class TranscriptQueries {
  private readonly scope: Readonly<QueryScope>;
  constructor(scope: Readonly<QueryScope>) {
    this.scope = scope;
  }
  private delivered(
    boundary: Boundary,
    ids: readonly string[],
  ): readonly (readonly [string, boolean])[] {
    const delivered: (readonly [string, boolean])[] = [];
    const where = boundary.clauses.join(" AND ");
    for (const id of new Set(ids)) {
      const human = this.scope.store.get(
        `SELECT start FROM entries WHERE ${where} AND human_id=? ORDER BY start DESC LIMIT 1`,
        ...boundary.params,
        id,
      );
      if (human) {
        delivered.push([
          id,
          this.scope.store.get(
            `SELECT rowid FROM entries WHERE ${where} AND start>? AND assistant_text=1 LIMIT 1`,
            ...boundary.params,
            number(human, "start"),
          ) !== undefined,
        ]);
      }
    }
    return delivered;
  }
  private readMetadata(
    boundary: Boundary,
    readThrough: string | null | undefined,
  ): { readonly latestEntryId: string | null; readonly unreadAfter?: boolean } {
    const where = boundary.clauses.join(" AND ");
    const latest = this.scope.store.get(
      `SELECT start,visible_id FROM entries WHERE ${where} AND visible_id IS NOT NULL ORDER BY start DESC LIMIT 1`,
      ...boundary.params,
    );
    const latestEntryId = latest ? nullableText(latest, "visible_id") : null;
    if (readThrough === undefined) {
      return { latestEntryId };
    }
    const marker =
      typeof readThrough === "string"
        ? this.scope.store.get(
            `SELECT start,visible_id FROM entries WHERE ${where} AND id=?`,
            ...boundary.params,
            readThrough.replace(/:(?:\d+|error)$/, ""),
          )
        : undefined;
    let unreadAfter = false;
    if (latest) {
      unreadAfter =
        !marker ||
        number(latest, "start") > number(marker, "start") ||
        (number(latest, "start") === number(marker, "start") && latestEntryId !== readThrough);
    }
    return { latestEntryId, unreadAfter };
  }
  private pageRows(
    boundary: Boundary,
    before: number | undefined,
    input: HistoryPageInput,
  ): readonly ReturnType<typeof entryRow>[] {
    const clauses = [...boundary.clauses];
    const params = [...boundary.params];
    if (before !== undefined) {
      clauses.push("start<?");
      params.push(integer(before, 0));
    }
    if (input.after !== undefined) {
      clauses.push("start>?");
      params.push(integer(input.after, 0));
    }
    return this.scope.store
      .all(
        `SELECT * FROM entries WHERE ${clauses.join(" AND ")} ORDER BY start ${input.after !== undefined ? "ASC" : "DESC"} LIMIT ?`,
        ...params,
        pageLimit(input.limit) + 1,
      )
      .map(entryRow);
  }
  private pageMetadata(
    input: HistoryPageInput,
    boundary: Boundary,
    rows: readonly ReturnType<typeof entryRow>[],
  ): Pick<
    HistoryPage,
    "count" | "hasMore" | "previousBefore" | "previousCursor" | "nextAfter" | "finalResultId"
  > & { readonly previous: boolean } {
    const first = rows.at(0);
    const last = rows.at(-1);
    const where = boundary.clauses.join(" AND ");
    const count = number(
      this.scope.store.require(
        `SELECT COUNT(*) AS count FROM entries WHERE ${where}`,
        ...boundary.params,
      ),
      "count",
    );
    const child = this.scope.store.get(
      "SELECT output_digest FROM children WHERE run_id=? AND child_index=?",
      input.runId,
      input.index,
    );
    const outputDigest = child ? nullableText(child, "output_digest") : null;
    const finalResultId =
      outputDigest !== null && outputDigest.length > 0
        ? this.scope.finalResultId(
            input,
            outputDigest,
            first && last ? [first.start, last.start] : undefined,
          )
        : undefined;
    const previous =
      first !== undefined &&
      this.scope.store.get(
        `SELECT start FROM entries WHERE ${where} AND start<? LIMIT 1`,
        ...boundary.params,
        first.start,
      ) !== undefined;
    return {
      count,
      hasMore: previous,
      previous,
      finalResultId,
      ...(last ? { nextAfter: last.start } : {}),
    };
  }
  private navigation(
    query: string,
    rows: readonly EntryRow[],
    metadata: ReturnType<TranscriptQueries["pageMetadata"]>,
    forwardMore: boolean | undefined,
  ): Pick<
    HistoryPage,
    "hasMore" | "finalResultId" | "previousBefore" | "previousCursor" | "nextAfter"
  > {
    const first = rows.at(0);
    return {
      hasMore: forwardMore ?? metadata.previous,
      ...(metadata.finalResultId === undefined ? {} : { finalResultId: metadata.finalResultId }),
      ...(metadata.previous && first
        ? {
            previousBefore: first.start,
            previousCursor: this.scope.cursor(query, [first.start], 0),
          }
        : {}),
      ...(metadata.nextAfter === undefined ? {} : { nextAfter: metadata.nextAfter }),
    };
  }
  page(input: HistoryPageInput): HistoryPage {
    validate(input);
    const { source } = this.scope.child(input.runId, input.index);
    const empty = emptyPage(this.scope, source);
    if (!source) {
      return {
        ...empty,
        unavailable: "This legacy or unstarted child has no linked native conversation.",
      };
    }
    const query = queryKey(this.scope, input, source);
    const cursor = this.scope.parseCursor(input.cursor, query);
    if (cursor && (input.before !== undefined || input.after !== undefined)) {
      throw new HistoryIndexError("INVALID", "Use cursor or sequence, not both.");
    }
    const boundary = this.scope.boundary(source, input);
    const before = cursor ? integer(cursor.keys[0], 0) : input.before;
    const fetched = this.pageRows(boundary, before, input);
    const limit = pageLimit(input.limit);
    const rows = fetched.slice(0, limit);
    if (input.after === undefined) {
      rows.reverse();
    }
    const metadata = this.pageMetadata(input, boundary, rows);
    return {
      ...empty,
      configuration: this.scope.configuration(source, input),
      deliveredMessages: this.delivered(boundary, input.messageIds ?? []),
      ...this.readMetadata(boundary, input.readThrough),
      terminalSequence: boundary.terminalSequence,
      count: metadata.count,
      ...this.navigation(
        query,
        rows,
        metadata,
        input.after === undefined ? undefined : fetched.length > limit,
      ),
      entries: rows.map((row) => this.scope.store.entry(row)),
      ...unavailable(source.error, source.state),
    };
  }
}
function unavailable(error: string | null, state: string): { readonly unavailable?: string } {
  if (error !== null && error.length > 0) {
    return { unavailable: error };
  }
  return state === "missing" ? { unavailable: "Linked conversation is missing." } : {};
}
