import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { historyDirectory, openHistoryDatabase } from "./database.ts";
import { createHistorySchema } from "./schema.ts";
import { hash } from "./text.ts";
import { HistoryIndexError } from "./types.ts";
import { parseObject, errorCode, errorMessage } from "./values.ts";

function manifestFile(manifest: string): string | undefined {
  try {
    const saved = parseObject(fs.readFileSync(manifest, "utf8"));
    if (typeof saved.file === "string" && /^[a-f0-9-]+\.sqlite$/.test(saved.file)) {
      return saved.file;
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT" && !(error instanceof SyntaxError)) {
      throw error;
    }
  }
  return undefined;
}
function isCorruption(error: unknown): boolean {
  return (
    (error instanceof HistoryIndexError && error.code === "CORRUPT") ||
    /malformed|not a database|no such table|corrupt/i.test(errorMessage(error))
  );
}
function existingGeneration(file: string): DatabaseSync | undefined {
  let db: DatabaseSync | undefined;
  try {
    if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink()) {
      throw new HistoryIndexError("CORRUPT", "Invalid index generation.");
    }
    db = openHistoryDatabase(file);
    if (db.prepare("PRAGMA user_version").get()?.user_version !== 5) {
      throw new HistoryIndexError("CORRUPT", "Invalid index schema.");
    }
    db.prepare("SELECT value FROM meta WHERE key='generation'").get();
    return db;
  } catch (error) {
    db?.close();
    if (!isCorruption(error)) {
      throw error;
    }
    return undefined;
  }
}
/** Manifest replacement selects a fresh projection without unlinking another connection's WAL. */
export function openGeneration(
  agentDir: string,
  owner: string,
): { readonly db: DatabaseSync; readonly file: string } {
  const directory = historyDirectory(agentDir);
  const manifest = path.join(directory, `${hash(owner)}.json`);
  let name = manifestFile(manifest);
  let db = name === undefined ? undefined : existingGeneration(path.join(directory, name));
  if (!db) {
    name = `${randomUUID()}.sqlite`;
    db = openHistoryDatabase(path.join(directory, name));
    createHistorySchema(db);
    const temporary = `${manifest}.${process.pid}.${randomUUID()}`;
    fs.writeFileSync(temporary, JSON.stringify({ file: name }), { mode: 0o600 });
    fs.renameSync(temporary, manifest);
  }
  if (name === undefined) {
    db.close();
    throw new HistoryIndexError("CORRUPT", "Missing index generation name.");
  }
  const file = path.join(directory, name);
  fs.chmodSync(file, 0o600);
  for (const suffix of ["-wal", "-shm"]) {
    if (fs.existsSync(file + suffix)) {
      fs.chmodSync(file + suffix, 0o600);
    }
  }
  return { db, file };
}
