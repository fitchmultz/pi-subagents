import { closeSync, constants, lstatSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hasErrorCode, isRecord } from "../shared/unknown.ts";

/** A stable OS lock serializes ownership changes; its inode is never removed. */
export class OwnershipLock {
  private readonly db: DatabaseSync;

  constructor(directory: string) {
    const file = join(directory, "ownership.lock");
    try {
      // Only creation opens a raw descriptor: closing another descriptor for an
      // already locked inode could release this process's POSIX advisory locks.
      closeSync(openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600));
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) {
        throw error;
      }
    }
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) {
      throw new Error(`Unsafe agent ownership lock: ${file}`);
    }
    this.db = new DatabaseSync(file);
    try {
      this.db.exec("BEGIN EXCLUSIVE");
    } catch (error) {
      this.db.close();
      if (!isRecord(error) || error.errcode !== 5) {
        throw error;
      }
      throw new Error(
        "Agent ownership is changing in another operation; retry after it finishes.",
        {
          cause: error,
        },
      );
    }
  }

  close(): void {
    this.db.close();
  }
}
