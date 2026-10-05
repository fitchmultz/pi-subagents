import {
  HistoryIndexError,
  type HistorySearchInput,
  type HistorySearchPage,
  type HistorySearchMatch,
} from "./types.ts";
import { integer, pageLimit, hasText } from "./text.ts";
import { number, nullableNumber, nullableText, text, type Row, type IndexInput } from "./rows.ts";
import type { QueryScope, Cursor } from "./query-scope.ts";

function searchGrammar(query: string): readonly string[] {
  if (typeof query !== "string" || query.trim().length === 0 || query.length > 1024) {
    throw new HistoryIndexError(
      "INVALID_QUERY",
      "Search requires 1–12 tokens or one quoted phrase.",
    );
  }
  const value = query.trim();
  const phrase = value.startsWith('"') && value.endsWith('"');
  const words = (phrase ? value.slice(1, -1) : value).trim().split(/\s+/u);
  if (
    words.length === 0 ||
    words.length > 12 ||
    words.some(
      (word) =>
        !/^[\p{L}\p{N}\p{M}]{1,64}$/u.test(word) ||
        (!phrase && ["AND", "OR", "NOT", "NEAR"].includes(word)),
    )
  ) {
    throw new HistoryIndexError(
      "INVALID_QUERY",
      "Only lexical tokens or one quoted phrase are supported; operators, punctuation, and prefixes are not allowed.",
    );
  }
  return phrase ? [`"${words.join(" ")}"`] : [...new Set(words.map((word) => `"${word}"`))];
}
function match(row: Row): HistorySearchMatch {
  return {
    id: number(row, "document_id"),
    runId: text(row, "run_id"),
    index: number(row, "child_index"),
    agent: text(row, "agent"),
    entryId: text(row, "id"),
    nativeId: nullableText(row, "native_id"),
    sessionId: nullableText(row, "session_id"),
    sessionFile: text(row, "path"),
    timestamp: nullableNumber(row, "timestamp"),
    ref: {
      sourceId: text(row, "source_id"),
      generation: number(row, "generation"),
      start: number(row, "start"),
      end: number(row, "end"),
      digest: text(row, "digest"),
    },
    preview: text(row, "document_preview"),
    field: text(row, "field"),
    textStart: number(row, "text_start"),
    textEnd: number(row, "text_end"),
    score: number(row, "score"),
  };
}
interface SearchPlan {
  readonly clauses: readonly string[];
  readonly params: readonly IndexInput[];
}
function plan(
  input: HistorySearchInput,
  expression: readonly string[],
  cursor: Cursor | undefined,
  score: string,
): SearchPlan {
  const clauses = [
    "e.published=1",
    "e.generation=s.generation",
    "(c.terminal_entry_id IS NULL OR e.start<=terminal.start)",
    "(c.ended_at IS NULL OR e.timestamp<=c.ended_at)",
  ];
  const params: IndexInput[] = [...expression];
  if (hasText(input.runId)) {
    clauses.push("c.run_id=?");
    params.push(input.runId);
  }
  if (input.index !== undefined) {
    clauses.push("c.child_index=?");
    params.push(input.index);
  }
  if (hasText(input.agent)) {
    if (input.agent.length > 256) {
      throw new HistoryIndexError("INVALID", "Agent filter is too long.");
    }
    clauses.push("c.agent=?");
    params.push(input.agent);
  }
  if (cursor) {
    if (cursor.keys.length !== 4) {
      throw new HistoryIndexError("INVALID_CURSOR", "Invalid search seek tuple.");
    }
    clauses.push(`(${score},d.id,c.run_id,c.child_index)>(?,?,?,?)`);
    params.push(...cursor.keys);
  }
  return { clauses, params };
}
function queryKey(
  scope: Readonly<QueryScope>,
  input: HistorySearchInput,
  expression: readonly string[],
  sort: string,
): string {
  return scope.key([
    "search",
    expression,
    sort,
    input.runId ?? null,
    input.index ?? null,
    input.agent ?? null,
  ]);
}
export class SearchQueries {
  private readonly scope: Readonly<QueryScope>;
  constructor(scope: Readonly<QueryScope>) {
    this.scope = scope;
  }
  private validateScope(input: HistorySearchInput): void {
    if (input.index !== undefined && !hasText(input.runId)) {
      throw new HistoryIndexError("INVALID", "A child search requires runId.");
    }
    if (!hasText(input.runId)) {
      return;
    }
    if (!this.scope.store.get("SELECT id FROM runs WHERE id=?", input.runId)) {
      throw new HistoryIndexError("OWNERSHIP", "Run is not admitted by the current owner.");
    }
    if (input.index !== undefined) {
      this.scope.child(input.runId, integer(input.index, 0));
    }
    this.checkAttemptBoundaries(input);
  }
  private checkAttemptBoundaries(input: Pick<HistorySearchInput, "runId" | "index">): void {
    for (const child of this.scope.store.all(
      `SELECT source_id,terminal_entry_id,ended_at FROM children WHERE run_id=?${input.index !== undefined ? " AND child_index=?" : ""}`,
      input.runId ?? "",
      ...(input.index !== undefined ? [input.index] : []),
    )) {
      const sourceId = nullableText(child, "source_id");
      const source = sourceId === null ? undefined : this.scope.store.source(sourceId);
      if (source) {
        this.scope.boundary(source, {
          terminalEntryId: nullableText(child, "terminal_entry_id") ?? undefined,
          endedAt: nullableNumber(child, "ended_at") ?? undefined,
        });
      }
    }
  }
  private rows(
    expression: readonly string[],
    filter: SearchPlan,
    score: string,
    limit: number,
  ): readonly Row[] {
    // Match every token across a record's visible windows; a quoted phrase cannot span fields.
    // Ranking/filters precede LIMIT. The parent owns the hard deadline for a costly FTS scan.
    return this.scope.store.all(
      `WITH hits AS MATERIALIZED (
      ${expression.map((_term, index) => `SELECT d.id,d.entry_rowid,bm25(corpus) AS score,${index} AS term FROM corpus JOIN documents d ON d.id=corpus.rowid WHERE corpus MATCH ?`).join(" UNION ALL ")}
    ), terms AS (SELECT entry_rowid,term,MIN(score) AS score FROM hits GROUP BY entry_rowid,term),
    matched AS (SELECT entry_rowid,SUM(score) AS score FROM terms GROUP BY entry_rowid HAVING COUNT(*)=${expression.length}),
    excerpts AS (SELECT id,entry_rowid,ROW_NUMBER() OVER (PARTITION BY entry_rowid ORDER BY score,id) AS choice FROM hits)
    SELECT d.*,${score} AS score,e.*,d.id AS document_id,s.path,s.session_id,c.run_id,c.child_index,c.agent,d.preview AS document_preview FROM matched JOIN excerpts ON excerpts.entry_rowid=matched.entry_rowid AND excerpts.choice=1 JOIN documents d ON d.id=excerpts.id JOIN entries e ON e.rowid=matched.entry_rowid JOIN sources s ON s.id=e.source_id JOIN children c ON c.source_id=s.id LEFT JOIN entries terminal ON terminal.source_id=s.id AND terminal.generation=s.generation AND terminal.id=c.terminal_entry_id AND terminal.published=1 WHERE ${filter.clauses.join(" AND ")} ORDER BY score,d.id,c.run_id,c.child_index LIMIT ?`,
      ...filter.params,
      limit + 1,
    );
  }
  search(input: HistorySearchInput): HistorySearchPage {
    const expression = searchGrammar(input.query);
    const limit = pageLimit(input.limit, 20);
    const sort = input.sort ?? "relevance";
    if (!["relevance", "newest"].includes(sort)) {
      throw new HistoryIndexError("INVALID", "Unsupported search sort.");
    }
    this.validateScope(input);
    const query = queryKey(this.scope, input, expression, sort);
    const cursor = this.scope.parseCursor(input.cursor, query);
    const score = sort === "relevance" ? "matched.score" : "-COALESCE(e.timestamp,0)";
    const filter = plan(input, expression, cursor, score);
    const rows = this.rows(expression, filter, score, limit);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      ...this.scope.info(),
      matches: page.map(match),
      ...(rows.length > limit && last
        ? {
            nextCursor: this.scope.cursor(
              query,
              [
                number(last, "score"),
                number(last, "document_id"),
                text(last, "run_id"),
                number(last, "child_index"),
              ],
              (cursor?.offset ?? 0) + page.length,
            ),
          }
        : {}),
    };
  }
}
