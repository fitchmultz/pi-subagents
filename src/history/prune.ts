import type { HistoryStore } from "./store.ts";
import type { OwnedRun } from "./types.ts";
import { text } from "./rows.ts";

function pruneRuns(
  store: Readonly<HistoryStore>,
  runs: Readonly<ReadonlyMap<string, OwnedRun>>,
): boolean {
  let removed = false;
  for (const row of store.all("SELECT id FROM runs")) {
    const id = text(row, "id");
    if (!runs.has(id)) {
      store.run("DELETE FROM runs WHERE id=?", id);
      removed = true;
    }
  }
  return removed;
}

/** Remove unreferenced projections only after their live ingestion/watch owner releases them. */
export function pruneHistory(
  store: Readonly<HistoryStore>,
  runs: Readonly<ReadonlyMap<string, OwnedRun>>,
  previousSources: readonly string[] | undefined,
  release: (id: string, path: string) => void,
): boolean {
  if (previousSources?.length === 0) {
    return false;
  }
  return store.transaction(() => {
    let removed = previousSources === undefined && pruneRuns(store, runs);
    for (const source of store.all(
      `SELECT id,path FROM sources WHERE id NOT IN (SELECT source_id FROM children WHERE source_id IS NOT NULL)${previousSources ? ` AND id IN (${previousSources.map(() => "?").join(",")})` : ""}`,
      ...(previousSources ?? []),
    )) {
      const id = text(source, "id");
      release(id, text(source, "path"));
      store.deleteDocuments(id);
      store.run("DELETE FROM entries WHERE source_id=?", id);
      store.run("DELETE FROM sources WHERE id=?", id);
      removed = true;
    }
    if (removed) {
      store.bump();
    }
    return removed;
  });
}
