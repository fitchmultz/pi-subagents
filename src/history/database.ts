import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HistoryIndexError } from "./types.ts";

export function historyDirectory(agentDir: string, create = true): string {
	const directory = path.join(fs.realpathSync(agentDir), "history-index");
	if (create) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	if (fs.lstatSync(directory).isSymbolicLink()) throw new HistoryIndexError("UNSAFE_PATH", "History directory must not be a symbolic link.");
	if (create) fs.chmodSync(directory, 0o700);
	const filesystem = fs.statfsSync(directory).type;
	if ([0x6969, 0x517b, 0xff534d42].includes(filesystem)) throw new HistoryIndexError("UNSAFE_PATH", "SQLite history requires a local filesystem.");
	return directory;
}

export function openHistoryDatabase(file: string, readOnly = false): DatabaseSync {
	if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new HistoryIndexError("UNSAFE_PATH", "History database must not be a symbolic link.");
	for (let attempt = 0; ; attempt++) {
		const db = new DatabaseSync(file, { timeout: 100, defensive: true, allowExtension: false, readOnly });
		try {
			const version = String(db.prepare("SELECT sqlite_version() AS version").get()!.version);
			if (version !== "3.53.4") throw new HistoryIndexError("UNSUPPORTED_SQLITE", `History requires qualified SQLite 3.53.4; found ${version}.`);
			db.exec("PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF");
			if (!readOnly) {
				if (db.prepare("PRAGMA journal_mode").get()?.journal_mode !== "wal") db.exec("PRAGMA journal_mode=WAL");
				db.exec("PRAGMA synchronous=FULL");
				for (const suffix of ["", "-wal", "-shm"]) if (fs.existsSync(file + suffix)) fs.chmodSync(file + suffix, 0o600);
			}
			return db;
		} catch (error) {
			db.close();
			if (readOnly || attempt >= 2 || !/locked|busy/i.test(String((error as Error).message))) throw error;
			// Concurrent first-open WAL conversion can return BUSY without honoring the native timeout.
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
		}
	}
}

export function historyTransaction<T>(db: DatabaseSync, work: () => T): T {
	for (let attempt = 0; ; attempt++) {
		try {
			db.exec("BEGIN IMMEDIATE");
			const result = work(); db.exec("COMMIT"); return result;
		} catch (error) {
			if (db.isTransaction) db.exec("ROLLBACK");
			if (attempt >= 2 || !/locked|busy/i.test(String((error as Error).message))) throw error;
		}
	}
}
