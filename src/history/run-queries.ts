import {
  HistoryIndexError,
  type HistoryRunOptions,
  type HistoryRunPage,
  type HistoryRunRow,
} from "./types.ts";
import { integer, pageLimit, hasText } from "./text.ts";
import { number, text, type Row, type IndexInput } from "./rows.ts";
import { parseRunRow } from "./wire-models.ts";
import type { QueryScope, Cursor } from "./query-scope.ts";

interface RunFilter {
  readonly clauses: readonly string[];
  readonly params: readonly IndexInput[];
  readonly childWhere: string;
  readonly childParams: readonly IndexInput[];
}
function validate(options: HistoryRunOptions): void {
  if (
    options.state !== undefined &&
    !["live", "completed", "paused", "blocked", "failed", "unknown"].includes(options.state)
  ) {
    throw new HistoryIndexError("INVALID", "Unsupported run state.");
  }
  validateFilters(options);
}
function validateFilters(options: HistoryRunOptions): void {
  if (
    (options.text?.length ?? 0) > 256 ||
    (options.agent?.length ?? 0) > 256 ||
    (options.latestTasksOnly !== undefined && typeof options.latestTasksOnly !== "boolean")
  ) {
    throw new HistoryIndexError("INVALID", "Invalid run filter.");
  }
}
function queryKey(scope: Readonly<QueryScope>, options: HistoryRunOptions, sort: string): string {
  return scope.key([
    "runs",
    sort,
    options.agent ?? null,
    options.state ?? null,
    options.text?.toLowerCase() ?? null,
    options.latestTasksOnly ?? false,
  ]);
}
function filters(options: HistoryRunOptions): RunFilter {
  const clauses: string[] = [];
  const params: IndexInput[] = [];
  const childClauses: string[] = [];
  const childParams: IndexInput[] = [];
  if (hasText(options.agent)) {
    childClauses.push("c.agent=?");
    childParams.push(options.agent);
  }
  if (hasText(options.text)) {
    childClauses.push("instr(c.filter_text,?)>0");
    childParams.push(options.text.toLowerCase());
  }
  if (options.latestTasksOnly === true) {
    childClauses.push(
      "NOT EXISTS(SELECT 1 FROM runs successor WHERE successor.predecessor_id=c.run_id AND successor.predecessor_index=c.child_index)",
    );
  }
  const childWhere = childClauses.length > 0 ? ` AND ${childClauses.join(" AND ")}` : "";
  if (childWhere.length > 0) {
    clauses.push(`EXISTS(SELECT 1 FROM children c WHERE c.run_id=r.id${childWhere})`);
    params.push(...childParams);
  }
  if (hasText(options.state)) {
    clauses.push("r.state=?");
    params.push(options.state);
  }
  return { clauses, params, childWhere, childParams };
}
function columns(sort: HistoryRunOptions["sort"]): readonly string[] {
  if (sort === "attention") {
    return ["attention", "negative_updated", "id"];
  }
  return [sort === "newest" ? "negative_updated" : "updated", "id"];
}
function runSort(value: HistoryRunOptions["sort"]): NonNullable<HistoryRunOptions["sort"]> {
  const sort = value ?? "attention";
  if (!["attention", "newest", "oldest"].includes(sort)) {
    throw new HistoryIndexError("INVALID", "Unsupported run sort.");
  }
  return sort;
}
function seek(filter: RunFilter, cursor: Cursor | undefined, order: readonly string[]): RunFilter {
  if (!cursor) {
    return filter;
  }
  if (cursor.keys.length !== order.length) {
    throw new HistoryIndexError("INVALID_CURSOR", "Invalid run seek tuple.");
  }
  return {
    ...filter,
    clauses: [
      ...filter.clauses,
      `(${order.map((column) => `r.${column}`).join(",")}) > (${order.map(() => "?").join(",")})`,
    ],
    params: [...filter.params, ...cursor.keys],
  };
}
export class RunQueries {
  private readonly scope: Readonly<QueryScope>;
  constructor(scope: Readonly<QueryScope>) {
    this.scope = scope;
  }
  private view(row: Row, filter: RunFilter): HistoryRunRow {
    const value: unknown = JSON.parse(text(row, "view"));
    const view = parseRunRow(value);
    const matchedChildIndexes =
      filter.childWhere.length > 0
        ? this.scope.store
            .all(
              `SELECT child_index FROM children c WHERE c.run_id=?${filter.childWhere} ORDER BY child_index`,
              view.runId,
              ...filter.childParams,
            )
            .map((child) => number(child, "child_index"))
        : view.matchedChildIndexes;
    return {
      ...view,
      matchedChildIndexes,
      children: view.children.map((child) => {
        const { source } = this.scope.child(view.runId, child.index);
        if (!source) {
          return child;
        }
        const boundary =
          child.state === "live"
            ? {}
            : {
                terminalEntryId: child.result?.terminalEntryId,
                endedAt:
                  (child.result?.terminalEntryId?.length ?? 0) > 0 ? undefined : view.updatedAt,
                leaf: child.result?.terminalLeafId,
              };
        return Object.assign({}, child, {
          nativeConfiguration: this.scope.configuration(source, boundary, false),
        });
      }),
    };
  }
  private nextPage(
    query: string,
    order: readonly string[],
    page: readonly Row[],
    position: number,
  ): Pick<HistoryRunPage, "nextOffset" | "nextCursor"> {
    const last = page.at(-1);
    return last
      ? {
          nextOffset: position + page.length,
          nextCursor: this.scope.cursor(
            query,
            order.map((column) => (column === "id" ? text(last, column) : number(last, column))),
            position + page.length,
          ),
        }
      : {};
  }
  list(options: HistoryRunOptions): HistoryRunPage {
    validate(options);
    const limit = pageLimit(options.limit, 20);
    const offset = integer(options.offset, 0);
    const sort = runSort(options.sort);
    const query = queryKey(this.scope, options, sort);
    const cursor = this.scope.parseCursor(options.cursor, query);
    if (cursor && options.offset !== undefined) {
      throw new HistoryIndexError("INVALID", "Use cursor or offset, not both.");
    }
    const filter = filters(options);
    const total = number(
      this.scope.store.require(
        `SELECT COUNT(*) AS total FROM runs r ${filter.clauses.length > 0 ? `WHERE ${filter.clauses.join(" AND ")}` : ""}`,
        ...filter.params,
      ),
      "total",
    );
    const order = columns(sort);
    const selected = seek(filter, cursor, order);
    const rows = this.scope.store.all(
      `SELECT * FROM runs r ${selected.clauses.length > 0 ? `WHERE ${selected.clauses.join(" AND ")}` : ""} ORDER BY ${order.map((column) => `r.${column}`).join(",")} LIMIT ? OFFSET ?`,
      ...selected.params,
      limit + 1,
      cursor ? 0 : offset,
    );
    const page = rows.slice(0, limit);
    const position = cursor?.offset ?? offset;
    return {
      rows: page.map((row) => this.view(row, filter)),
      total,
      offset: position,
      ...this.scope.info(),
      ...this.nextPage(query, order, rows.length > limit ? page : [], position),
    };
  }
}
