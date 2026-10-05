import * as Type from "typebox";
import { Check } from "typebox/value";
import {
  HistoryIndexError,
  type HistoryVersion,
  type HistoryPageInput,
  type HistoryConfiguration,
} from "./types.ts";
import { hash, integer, hasText } from "./text.ts";
import type { HistoryStore } from "./store.ts";
import {
  type SourceRow,
  type Row,
  type IndexInput,
  number,
  nullableText,
  nullableNumber,
  text,
} from "./rows.ts";
import { parseObject } from "./values.ts";

const cursorSchema = Type.Object({
  generation: Type.String(),
  owner: Type.String(),
  version: Type.Number(),
  query: Type.String(),
  keys: Type.Array(Type.Union([Type.Number(), Type.String()]), { maxItems: 8 }),
  offset: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
});
export interface Cursor {
  readonly generation: string;
  readonly owner: string;
  readonly version: number;
  readonly query: string;
  readonly keys: readonly (string | number)[];
  readonly offset: number;
}
export interface Boundary {
  readonly clauses: readonly string[];
  readonly params: readonly IndexInput[];
  readonly terminalSequence?: number;
}
function configurationValues(
  facts: Row,
  leaf: string | null | undefined,
  strict: boolean,
): HistoryConfiguration {
  const count = number(facts, "count");
  if (count === 0 && hasText(leaf) && strict) {
    throw new HistoryIndexError(
      "BOUNDARY_UNAVAILABLE",
      "Selected configuration leaf is not available in the indexed generation.",
    );
  }
  if (count > 0 && number(facts, "rooted") === 0) {
    if (!strict) {
      return {};
    }
    throw new HistoryIndexError(
      "MALFORMED_ANCESTRY",
      "Selected native configuration has cyclic ancestry.",
    );
  }
  const model = nullableText(facts, "model");
  const thinking = nullableText(facts, "thinking");
  return {
    ...(model === null
      ? {}
      : { model, modelRecordedAt: nullableNumber(facts, "recorded_at") ?? undefined }),
    ...(thinking === null ? {} : { thinking }),
  };
}
export class QueryScope {
  readonly store: Readonly<HistoryStore>;
  readonly info: () => HistoryVersion;
  constructor(store: Readonly<HistoryStore>, info: () => HistoryVersion) {
    this.store = store;
    this.info = info;
  }
  key(parts: readonly unknown[]): string {
    return hash(JSON.stringify(parts));
  }
  cursor(query: string, keys: readonly (string | number)[], offset: number): string {
    return Buffer.from(
      JSON.stringify({
        generation: this.store.generation,
        owner: this.store.owner,
        version: this.info().version,
        query,
        keys,
        offset,
      } satisfies Cursor),
    ).toString("base64url");
  }
  parseCursor(value: string | undefined, query: string): Cursor | undefined {
    if (value === undefined) {
      return;
    }
    let cursor: Cursor;
    try {
      if (value.length > 4096) {
        throw new Error("Cursor exceeds budget.");
      }
      const parsed = parseObject(Buffer.from(value, "base64url").toString("utf8"));
      if (!Check(cursorSchema, parsed)) {
        throw new Error("Invalid cursor fields.");
      }
      cursor = parsed;
    } catch {
      throw new HistoryIndexError("INVALID_CURSOR", "Invalid history cursor.");
    }
    if (
      cursor.generation !== this.store.generation ||
      cursor.owner !== this.store.owner ||
      cursor.query !== query ||
      cursor.version !== this.info().version
    ) {
      throw new HistoryIndexError(
        "STALE_CURSOR",
        "History changed or this cursor belongs to a different query/source; restart paging.",
      );
    }
    return cursor;
  }
  child(runId: string, index: number): { readonly source?: SourceRow; readonly agent: string } {
    integer(index, 0);
    const child = this.store.get(
      "SELECT * FROM children WHERE run_id=? AND child_index=?",
      runId,
      index,
    );
    if (!child) {
      throw new HistoryIndexError(
        "OWNERSHIP",
        "Run/child is not in the current owner's admitted handles.",
      );
    }
    const sourceId = nullableText(child, "source_id");
    return {
      source: sourceId === null ? undefined : this.store.source(sourceId),
      agent: text(child, "agent"),
    };
  }
  boundary(
    source: SourceRow,
    input: Pick<HistoryPageInput, "terminalEntryId" | "endedAt">,
    alias = "",
  ): Boundary {
    const column = alias.length > 0 ? `${alias}.` : "";
    const clauses = [`${column}source_id=?`, `${column}generation=?`, `${column}published=1`];
    const params: IndexInput[] = [source.id, source.generation];
    let terminalSequence: number | undefined;
    if (input.terminalEntryId !== undefined && input.terminalEntryId.length > 0) {
      const terminal = this.store.get(
        "SELECT start FROM entries WHERE source_id=? AND generation=? AND id=? AND published=1",
        source.id,
        source.generation,
        input.terminalEntryId,
      );
      if (!terminal) {
        throw new HistoryIndexError(
          "BOUNDARY_UNAVAILABLE",
          "Saved terminal entry is not available in the current indexed generation.",
        );
      }
      terminalSequence = number(terminal, "start");
      clauses.push(`${column}start<=?`);
      params.push(terminalSequence);
    } else if (input.endedAt !== undefined) {
      clauses.push(`${column}timestamp<=?`);
      params.push(integer(input.endedAt, 0));
    }
    return { clauses, params, terminalSequence };
  }
  private configurationFacts(
    source: SourceRow,
    input: Pick<HistoryPageInput, "terminalEntryId" | "endedAt" | "leaf">,
  ): ReturnType<HistoryStore["get"]> {
    const boundary = this.boundary(source, input);
    const latest = this.store.get(
      `SELECT id FROM entries WHERE ${boundary.clauses.join(" AND ")} ORDER BY start DESC LIMIT 1`,
      ...boundary.params,
    );
    const leaf = input.leaf ?? (latest ? text(latest, "id") : undefined);
    if (leaf === undefined || leaf.length === 0) {
      return;
    }
    // Resolve each child's parent by its indexed ID, not a transcript rescan at every step.
    const ancestry = `WITH RECURSIVE eligible AS (SELECT rowid,id,parent_id,start,timestamp,configuration_model,configuration_thinking FROM entries WHERE ${boundary.clauses.join(" AND ")}), branch AS (SELECT * FROM eligible WHERE id=? UNION SELECT parent.* FROM branch child CROSS JOIN eligible parent WHERE parent.id=child.parent_id)`;
    return this.store.require(
      `${ancestry} SELECT
      (SELECT COUNT(*) FROM branch) AS count,
      EXISTS(SELECT 1 FROM branch child WHERE parent_id IS NULL OR NOT EXISTS(SELECT 1 FROM eligible parent WHERE parent.id=child.parent_id)) AS rooted,
      (SELECT configuration_model FROM branch WHERE configuration_model IS NOT NULL ORDER BY start DESC LIMIT 1) AS model,
      (SELECT timestamp FROM branch WHERE configuration_model IS NOT NULL ORDER BY start DESC LIMIT 1) AS recorded_at,
      (SELECT configuration_thinking FROM branch WHERE configuration_thinking IS NOT NULL ORDER BY start DESC LIMIT 1) AS thinking`,
      ...boundary.params,
      leaf,
    );
  }
  configuration(
    source: SourceRow,
    input: Pick<HistoryPageInput, "terminalEntryId" | "endedAt" | "leaf">,
    strict = true,
  ): HistoryConfiguration {
    if (input.leaf === null) {
      return {};
    }
    try {
      const facts = this.configurationFacts(source, input);
      if (!facts) {
        return {};
      }
      return configurationValues(facts, input.leaf, strict);
    } catch (error) {
      if (!strict && error instanceof HistoryIndexError && error.code === "BOUNDARY_UNAVAILABLE") {
        return {};
      }
      throw error;
    }
  }
  finalResultId(
    input: Pick<HistoryPageInput, "runId" | "index" | "terminalEntryId" | "endedAt">,
    digest: string,
    preferredRange?: readonly [number, number],
  ): string | undefined {
    const { source } = this.child(input.runId, input.index);
    if (!source) {
      return;
    }
    const boundary = this.boundary(source, input, "e");
    const row = this.store.get(
      `SELECT a.item_id FROM answers a JOIN entries e ON e.rowid=a.entry_rowid WHERE a.digest=? AND ${boundary.clauses.join(" AND ")} ORDER BY ${preferredRange ? "(e.start BETWEEN ? AND ?) DESC," : ""}e.start DESC LIMIT 1`,
      digest,
      ...boundary.params,
      ...(preferredRange ?? []),
    );
    return row ? text(row, "item_id") : undefined;
  }
}
