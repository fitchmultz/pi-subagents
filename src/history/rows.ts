import { isRecord } from "../shared/unknown.ts";
import { HistoryIndexError } from "./types.ts";

export type IndexInput = string | number | bigint | null;
export type Row = Readonly<Record<string, string | number | null>>;
export function indexRow(input: unknown): Row {
  if (!isRecord(input)) {
    throw new HistoryIndexError("CORRUPT", "Invalid index row.");
  }
  const row: Record<string, string | number | null> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== null && typeof value !== "string" && typeof value !== "number") {
      throw new HistoryIndexError("CORRUPT", `Unsupported index column ${key}.`);
    }
    row[key] = value;
  }
  return row;
}
export function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new HistoryIndexError("CORRUPT", `Invalid index text column ${key}.`);
  }
  return value;
}
export function number(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HistoryIndexError("CORRUPT", `Invalid index numeric column ${key}.`);
  }
  return value;
}
export function nullableText(row: Row, key: string): string | null {
  return row[key] === null ? null : text(row, key);
}
export function nullableNumber(row: Row, key: string): number | null {
  return row[key] === null ? null : number(row, key);
}
export interface SourceRow {
  readonly id: string;
  readonly path: string;
  readonly generation: number;
  readonly identity: string | null;
  readonly stamp: string | null;
  readonly session_id: string | null;
  readonly header_digest: string | null;
  readonly cursor: number;
  readonly prefix_digest: string | null;
  readonly state: string;
  readonly error: string | null;
  readonly malformed: number;
  readonly complexity: number;
  readonly checked_at: number | null;
  readonly format_version: number | null;
}
export interface EntryRow {
  readonly rowid: number;
  readonly source_id: string;
  readonly generation: number;
  readonly id: string;
  readonly native_id: string | null;
  readonly parent_id: string | null;
  readonly start: number;
  readonly end: number;
  readonly digest: string;
  readonly timestamp: number | null;
  readonly type: string;
  readonly preview: string;
  readonly published: number;
  readonly role: string | null;
  readonly assistant_text: number;
  readonly visible_id: string | null;
  readonly human_id: string | null;
  readonly configuration_model: string | null;
  readonly configuration_thinking: string | null;
}
export function sourceRow(row: Row): SourceRow {
  return {
    id: text(row, "id"),
    path: text(row, "path"),
    generation: number(row, "generation"),
    identity: nullableText(row, "identity"),
    stamp: nullableText(row, "stamp"),
    session_id: nullableText(row, "session_id"),
    header_digest: nullableText(row, "header_digest"),
    cursor: number(row, "cursor"),
    prefix_digest: nullableText(row, "prefix_digest"),
    state: text(row, "state"),
    error: nullableText(row, "error"),
    malformed: number(row, "malformed"),
    complexity: number(row, "complexity"),
    checked_at: nullableNumber(row, "checked_at"),
    format_version: nullableNumber(row, "format_version"),
  };
}
export function entryRow(row: Row): EntryRow {
  return {
    rowid: number(row, "rowid"),
    source_id: text(row, "source_id"),
    generation: number(row, "generation"),
    id: text(row, "id"),
    native_id: nullableText(row, "native_id"),
    parent_id: nullableText(row, "parent_id"),
    start: number(row, "start"),
    end: number(row, "end"),
    digest: text(row, "digest"),
    timestamp: nullableNumber(row, "timestamp"),
    type: text(row, "type"),
    preview: text(row, "preview"),
    published: number(row, "published"),
    role: nullableText(row, "role"),
    assistant_text: number(row, "assistant_text"),
    visible_id: nullableText(row, "visible_id"),
    human_id: nullableText(row, "human_id"),
    configuration_model: nullableText(row, "configuration_model"),
    configuration_thinking: nullableText(row, "configuration_thinking"),
  };
}
