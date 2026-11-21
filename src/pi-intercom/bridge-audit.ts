import { closeSync, constants, fstatSync, openSync, renameSync, writeSync } from "node:fs";
import { hasErrorCode } from "../shared/unknown.ts";

/** Keeps each generation within what scripts/intercom-bridge-wake-preflight.mjs reads. */
export const AUDIT_GENERATION_BYTES = 32 * 1024 * 1024;

interface Generation {
  readonly fd: number;
  size: number;
}

function openGeneration(path: string): Generation {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.nlink !== 1
    ) {
      throw new Error("The audit file must be an owned regular file with mode 0600 and one link.");
    }
    return { fd, size: stat.size };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** Appends audit lines to one private file and keeps the previous generation at `PATH.1`. */
export class AuditFile {
  private readonly path: string;
  private current: Generation;

  constructor(path: string) {
    this.path = path;
    this.current = openGeneration(path);
  }

  /** Returns false when the line could not be written. */
  write(line: string): boolean {
    const bytes = Buffer.byteLength(line);
    if (this.current.size > 0 && this.current.size + bytes > AUDIT_GENERATION_BYTES) {
      this.rotate();
    }
    try {
      writeSync(this.current.fd, line);
    } catch {
      return false;
    }
    this.current.size += bytes;
    return true;
  }

  private rotate(): void {
    try {
      renameSync(this.path, `${this.path}.1`);
    } catch (error) {
      // A file someone already moved away needs only a fresh generation.
      if (!hasErrorCode(error, "ENOENT")) {
        return;
      }
    }
    try {
      const next = openGeneration(this.path);
      closeSync(this.current.fd);
      this.current = next;
    } catch {
      // Keep appending to the current descriptor; the next line retries the rotation.
    }
  }
}
