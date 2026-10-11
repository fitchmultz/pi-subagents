import { HistoryStore } from "../../src/history/store.ts";
import { SourceIngest } from "../../src/history/ingest.ts";
import { HistoryIndexError } from "../../src/history/types.ts";
import { sourceRow } from "../../src/history/rows.ts";

// Pause real processes on either side of the staging/publication boundary.
// Queries in the test assert retained native records, not the lock mechanism.
const directory = process.argv.at(2);
const send = process.send?.bind(process);
if (directory === undefined || send === undefined) {
  throw new Error("Staged history writer requires a directory argument and IPC channel.");
}
const store = new HistoryStore(directory, "parent");
let ingest: SourceIngest | undefined;
const open = (): SourceIngest => {
  const source = store.get("SELECT * FROM sources LIMIT 1");
  if (source === undefined) {
    throw new Error("Staged history writer requires an indexed source row.");
  }
  return new SourceIngest(store, sourceRow(source), true);
};
try {
  ingest = open();
} catch (error) {
  if (!(error instanceof HistoryIndexError && error.code === "INDEX_BUSY")) {
    throw error;
  }
}
if (process.argv[3] !== "opened") {
  if (ingest === undefined) {
    throw new Error("The first writer must be available.");
  }
  while (store.get("SELECT rowid FROM entries WHERE published=0") === undefined) {
    if (ingest.step()) {
      throw new Error("Fixture reached EOF without staging an entry.");
    }
  }
}
send({ ready: true });
process.on("message", () => {
  try {
    for (;;) {
      try {
        ingest ??= open();
        while (!ingest.step()) {
          // Finish the source using real ingestion.
        }
        break;
      } catch (error) {
        ingest?.close();
        ingest = undefined;
        if (!(error instanceof HistoryIndexError && error.code === "SOURCE_CHANGED")) {
          throw error;
        }
      }
    }
    send({ finished: true });
  } catch (error) {
    send({ error: error instanceof Error ? error.toString() : "Unknown history writer failure" });
  } finally {
    ingest?.close();
    store.close();
    process.disconnect();
  }
});
