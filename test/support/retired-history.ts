import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const generation = "00000000-0000-4000-8000-000000000001.sqlite";
const manifestName = `${"a".repeat(64)}.json`;

export function fixture(cleanup: DisposableStack | AsyncDisposableStack, label: string): string {
  const root = mkdtempSync(join(tmpdir(), `history-${label}-`));
  cleanup.defer(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "agent", "history-index"), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "sessions"), { mode: 0o700 });
  writeFileSync(join(root, "sessions", "sentinel.jsonl"), '{"synthetic":"keep"}\n');
  return root;
}

export function inventory(directory: string): readonly object[] {
  return readdirSync(directory)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const file = join(directory, name);
      const stat = lstatSync(file);
      return {
        name,
        inode: stat.ino,
        size: stat.size,
        mode: stat.mode,
        uid: stat.uid,
        links: stat.nlink,
        symlink: stat.isSymbolicLink(),
        sha256: stat.isFile()
          ? createHash("sha256").update(readFileSync(file)).digest("hex")
          : null,
      };
    });
}

export function crashedWriter(directory: string, committed: boolean): void {
  const writer = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { DatabaseSync } from "node:sqlite";
import { writeSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const directory = process.argv[1];
const databases = [];
for (const name of [${JSON.stringify(generation)}, ${JSON.stringify(`${generation}.ingest.sqlite`)}, "run-timing.sqlite"]) {
  const db = new DatabaseSync(join(directory, name));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0");
  db.exec("CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES ('committed')");
  db.exec("BEGIN IMMEDIATE; INSERT INTO fixture VALUES ('pending')");
  if (${committed}) db.exec("COMMIT");
  databases.push(db);
}
writeSync(1, "WAL_READY " + databases.length + "\\n");
process.kill(process.pid, "SIGKILL");`,
      directory,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(writer.error, undefined);
  assert.equal(writer.signal, "SIGKILL");
  assert.equal(writer.stdout, "WAL_READY 3\n", writer.stderr);
  for (const name of [generation, `${generation}.ingest.sqlite`, "run-timing.sqlite"]) {
    assert.ok(lstatSync(join(directory, `${name}-wal`)).size > 0);
    assert.ok(lstatSync(join(directory, `${name}-shm`)).isFile());
  }
  writeFileSync(join(directory, manifestName), JSON.stringify({ file: generation }), {
    mode: 0o600,
  });
}
