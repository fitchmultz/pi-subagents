import * as fs from "node:fs";
import type { HistoryStore, SourceRow } from "./store.ts";
import { HistoryIndexError } from "./types.ts";

export function identity(stat: fs.BigIntStats): string {
  return `${stat.dev}:${stat.ino}`;
}
export function stamp(stat: fs.BigIntStats): string {
  return `${identity(stat)}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}
export function requireSource(store: Readonly<HistoryStore>, id: string): SourceRow {
  const source = store.source(id);
  if (!source) {
    throw new HistoryIndexError("SOURCE_CHANGED", "Source was removed before ingestion.");
  }
  return source;
}
/** Acquires the writer lock before reading any cursor or clearing shared staging. */
export function openSource(
  store: Readonly<HistoryStore>,
  id: string,
): { readonly fd: number; readonly initial: fs.BigIntStats; readonly source: SourceRow } {
  store.beginIngest();
  let fd: number | undefined;
  try {
    let source = requireSource(store, id);
    store.count("sourceChecks");
    store.count("sourceOpens");
    fd = fs.openSync(source.path, "r");
    const initial = fs.fstatSync(fd, { bigint: true });
    if (!initial.isFile() || initial.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("Journal is not a supported regular file.");
    }
    if (
      source.identity !== null &&
      (source.identity !== identity(initial) || Number(initial.size) < source.cursor)
    ) {
      store.resetSource(id);
      source = requireSource(store, id);
    }
    store.clearUnpublished(id);
    store.run("DELETE FROM pending_text");
    return { fd, initial, source };
  } catch (error) {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
    store.endIngest();
    throw error;
  }
}
