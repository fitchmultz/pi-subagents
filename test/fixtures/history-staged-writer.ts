import { HistoryStore } from "../../src/history/store.ts";
import { SourceIngest } from "../../src/history/ingest.ts";
import { HistoryIndexError } from "../../src/history/types.ts";

// Pause real processes on either side of the staging/publication boundary.
// Queries in the test assert retained native records, not the lock mechanism.
const store = new HistoryStore(process.argv[2], "parent");
let ingest: SourceIngest | undefined;
const open = () => new SourceIngest(store, store.get("SELECT * FROM sources LIMIT 1"), true);
try { ingest = open(); }
catch (error) { if (!(error instanceof HistoryIndexError && error.code === "INDEX_BUSY")) throw error; }
if (process.argv[3] !== "opened") {
	if (!ingest) throw new Error("The first writer must be available.");
	while (!store.get("SELECT rowid FROM entries WHERE published=0")) {
		if (ingest.step()) throw new Error("Fixture reached EOF without staging an entry.");
	}
}
process.send!({ ready: true });
process.on("message", () => {
	try {
		for (;;) {
			try {
				ingest ??= open();
				while (!ingest.step()) { /* Finish the source using real ingestion. */ }
				break;
			} catch (error) {
				ingest?.close(); ingest = undefined;
				if (!(error instanceof HistoryIndexError && error.code === "SOURCE_CHANGED")) throw error;
			}
		}
		process.send!({ finished: true });
	} catch (error) {
		process.send!({ error: String(error) });
	} finally {
		ingest?.close(); store.close(); process.disconnect();
	}
});
