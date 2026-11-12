import { closeSync, constants, lstatSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hasErrorCode, isRecord } from "../shared/unknown.ts";

const localOperations = new Map<string, Promise<null>>();

/** Await this process's prior operation without blocking its native spawn-error delivery. */
export async function serializeLocalOwnership(
  directory: string,
  operation: () => Promise<void>,
): Promise<void> {
  const previous = localOperations.get(directory);
  const { promise, resolve } = Promise.withResolvers<null>();
  localOperations.set(directory, promise);
  try {
    await previous;
    await operation();
  } finally {
    resolve(null);
    if (localOperations.get(directory) === promise) {
      localOperations.delete(directory);
    }
  }
}

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
