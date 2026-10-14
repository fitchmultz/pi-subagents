import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isRecord } from "../shared/unknown.ts";
import { label } from "./bridge-protocol.ts";

export function stateDirectory(value: unknown): string | undefined {
  if (value === undefined) {
    return;
  }
  const path = label(value, "stateDir", 4096);
  const stat = lstatSync(path);
  if (
    !isAbsolute(path) ||
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700
  ) {
    throw new Error("stateDir must be an absolute owned directory with mode 0700, not a symlink.");
  }
  return realpathSync(path);
}

export function privateFile(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.nlink !== 1
    ) {
      throw new Error("Storage files must be owned regular files with mode 0600 and one link.");
    }
  } finally {
    closeSync(fd);
  }
}

/** Native SQLite FULL commits own durability; never replace an unreadable existing database. */
export function privateDatabase(
  stateDir: string,
  name: string,
): { readonly db: DatabaseSync; readonly created: boolean } {
  stateDirectory(stateDir);
  const path = join(stateDir, name);
  let created = false;
  try {
    const fd = openSync(
      path,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    closeSync(fd);
    created = true;
  } catch (error) {
    if (!isRecord(error) || error.code !== "EEXIST") {
      throw error;
    }
  }
  privateFile(path);
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    try {
      lstatSync(`${path}${suffix}`);
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    privateFile(`${path}${suffix}`);
  }
  const db = new DatabaseSync(path, { enableDoubleQuotedStringLiterals: false });
  try {
    db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;
      PRAGMA cache_size=-1024; PRAGMA busy_timeout=1000;`);
    return { db, created };
  } catch (error) {
    db.close();
    throw error;
  }
}
