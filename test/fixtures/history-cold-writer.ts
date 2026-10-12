import fs from "node:fs";
import { HistoryStore, hash } from "../../src/history/store.ts";
import { SourceIngest } from "../../src/history/ingest.ts";

const directory = process.argv.at(2);
const file = process.argv.at(3);
const phase = process.argv.at(4);
if (
  directory === undefined ||
  file === undefined ||
  !["before-commit", "committed"].includes(phase ?? "")
) {
  throw new Error("Cold history writer requires directory, source and crash phase.");
}
const store = new HistoryStore(directory, "parent");
const id = hash(file);
store.run("INSERT INTO sources(id,path) VALUES (?,?)", id, file);
const source = store.source(id);
if (!source) {
  throw new Error("Cold source was not admitted.");
}
function hold(): never {
  fs.writeSync(4, "E");
  for (;;) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
}
if (phase === "before-commit") {
  const exec = store.db.exec.bind(store.db);
  store.db.exec = (sql: string) => {
    if (
      sql === "COMMIT" &&
      store.get("SELECT id FROM entries WHERE id='cold-final' AND published=1")
    ) {
      hold();
    }
    exec(sql);
  };
}
const ingest = new SourceIngest(store, source, true);
while (store.get("SELECT id FROM entries WHERE id='cold-final' AND published=1") === undefined) {
  if (ingest.step()) {
    throw new Error("Cold source ended before final publication.");
  }
  if (store.db.isTransaction) {
    throw new Error("Ingestion yielded while holding its browse database transaction.");
  }
}
hold();
