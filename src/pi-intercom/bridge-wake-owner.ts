import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { privateDatabase, privateFile } from "./bridge-storage.ts";
import { isRecord } from "../shared/unknown.ts";

export const WAKE_OWNER_FILE = /^wake-owner-[0-9a-f-]{36}\.lock$/;

/** SQLite's OS lock survives pauses and is released on exit, without PID reuse or stale leases. */
export class WakeOwner {
  readonly name = `wake-owner-${randomUUID()}.lock`;
  private readonly db: DatabaseSync;
  private readonly path: string;

  constructor(stateDir: string) {
    this.path = join(stateDir, this.name);
    this.db = privateDatabase(stateDir, this.name).db;
    try {
      this.db.exec("BEGIN EXCLUSIVE");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
    rmSync(this.path, { force: true });
  }
}

export function stoppedWakeOwner(stateDir: string, name: string): boolean {
  if (!WAKE_OWNER_FILE.test(name)) {
    throw new Error("Invalid wake owner.");
  }
  const path = join(stateDir, name);
  try {
    privateFile(path);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return true;
    }
    throw error;
  }
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
    return true;
  } catch (error) {
    if (isRecord(error) && error.errcode === 5) {
      return false;
    }
    throw error;
  } finally {
    db.close();
  }
}
