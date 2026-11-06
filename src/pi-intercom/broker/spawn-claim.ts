import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hasErrorCode } from "../../shared/unknown.ts";
import { brokerPidRecord, isLinuxProcessReplaced } from "./pid.ts";

type OwnerState = "live" | "exited" | "uncertain";

function ownerState(fd: number): OwnerState {
  try {
    const lines = readFileSync(fd, "utf8").split("\n");
    const first = lines[0] ?? "";
    const pid = Number(first);
    if (!/^[1-9]\d*$/.test(first) || !Number.isSafeInteger(pid)) {
      return "uncertain";
    }
    process.kill(pid, 0);
    return isLinuxProcessReplaced(pid, lines.slice(2).join("\n")) ? "exited" : "live";
  } catch (error) {
    return hasErrorCode(error, "ESRCH") ? "exited" : "uncertain";
  }
}

/** The open descriptor pins the original inode until its own cleanup finishes. */
function removeOwned(file: string, fd: number): boolean {
  try {
    const owned = fstatSync(fd, { bigint: true });
    const current = lstatSync(file, { bigint: true, throwIfNoEntry: false });
    if (current?.dev !== owned.dev || current.ino !== owned.ino) {
      return false;
    }
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

function reclaimExited(file: string): boolean {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    return hasErrorCode(error, "ENOENT");
  }
  try {
    return ownerState(fd) === "exited" && removeOwned(file, fd);
  } finally {
    closeSync(fd);
  }
}

function publishClaim(file: string, fd: number): () => void {
  const release = () => {
    try {
      removeOwned(file, fd);
    } finally {
      closeSync(fd);
    }
  };
  try {
    // Keep legacy PID/timestamp lines; qualified native identity can prove later PID reuse.
    const record = brokerPidRecord();
    const identity = record.slice(record.indexOf("\n") + 1);
    writeFileSync(fd, `${process.pid}\n${Date.now()}\n${identity}`);
    return release;
  } catch (error) {
    release();
    throw error;
  }
}

/** An acquired claim returns its release operation; live or uncertain claims remain untouched. */
export function acquireSpawnClaim(file: string): (() => void) | undefined {
  for (let attempt = 0; attempt < 5; attempt++) {
    let fd: number;
    try {
      fd = openSync(file, "wx", 0o600);
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) {
        throw error;
      }
      if (reclaimExited(file)) {
        continue;
      }
      return;
    }
    return publishClaim(file, fd);
  }
  return;
}
