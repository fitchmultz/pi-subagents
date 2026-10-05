import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HistoryIndexError } from "./types.ts";
import { errorMessage } from "./values.ts";
import { hasErrorCode } from "../shared/unknown.ts";

export function historyDirectory(agentDir: string, create = true): string {
  const directory = path.join(fs.realpathSync(agentDir), "history-index");
  if (create) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  if (fs.lstatSync(directory).isSymbolicLink()) {
    throw new HistoryIndexError("UNSAFE_PATH", "History directory must not be a symbolic link.");
  }
  if (create) {
    fs.chmodSync(directory, 0o700);
  }
  if ([0x6969, 0x517b, 0xff534d42].includes(fs.statfsSync(directory).type)) {
    throw new HistoryIndexError("UNSAFE_PATH", "SQLite history requires a local filesystem.");
  }
  return directory;
}
function sidecarPermissions(file: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.chmodSync(file + suffix, 0o600);
    } catch (error) {
      // SQLite may remove sidecars as its last attached connection closes.
      if (suffix === "" || !hasErrorCode(error, "ENOENT")) {
        throw error;
      }
    }
  }
}
function initialize(db: DatabaseSync, file: string, readOnly: boolean): void {
  const version = db.prepare("SELECT sqlite_version() AS version").get()?.version;
  if (typeof version !== "string") {
    throw new HistoryIndexError("CORRUPT", "SQLite did not report its version.");
  }
  if (version !== "3.53.4") {
    throw new HistoryIndexError(
      "UNSUPPORTED_SQLITE",
      `History requires qualified SQLite 3.53.4; found ${version}.`,
    );
  }
  db.exec("PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF");
  if (!readOnly) {
    if (db.prepare("PRAGMA journal_mode").get()?.journal_mode !== "wal") {
      // WAL conversion upgrades without waiting for a writer. Admit that writer natively first.
      db.exec("BEGIN IMMEDIATE; COMMIT; PRAGMA journal_mode=WAL");
    }
    db.exec("PRAGMA synchronous=FULL");
    sidecarPermissions(file);
  }
}
export function openHistoryDatabase(file: string, readOnly = false): DatabaseSync {
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) {
    throw new HistoryIndexError("UNSAFE_PATH", "History database must not be a symbolic link.");
  }
  for (let attempt = 0; ; attempt++) {
    const db = new DatabaseSync(file, {
      timeout: 100,
      defensive: true,
      allowExtension: false,
      readOnly,
    });
    try {
      initialize(db, file, readOnly);
      return db;
    } catch (error) {
      db.close();
      if (readOnly || attempt >= 2 || !/locked|busy/i.test(errorMessage(error))) {
        throw error;
      }
      // Concurrent first-open WAL conversion may return BUSY without the native timeout.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}
export function historyTransaction<T>(db: DatabaseSync, work: () => T): T {
  for (let attempt = 0; ; attempt++) {
    try {
      db.exec("BEGIN IMMEDIATE");
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      if (db.isTransaction) {
        db.exec("ROLLBACK");
      }
      if (attempt >= 2 || !/locked|busy/i.test(errorMessage(error))) {
        throw error;
      }
    }
  }
}
