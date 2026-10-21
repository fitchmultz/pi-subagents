import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { scanJournal } from "../shared/journal-frames.ts";
import { journalStamp } from "../shared/native-journal.ts";
import type { Projection } from "../shared/json-projection.ts";
import type { UnknownRecord } from "../shared/unknown.ts";

const detailFields = new Set([
  "owner",
  "id",
  "completed",
  "receivedResult",
  "completion",
  "subagentCompletion",
  "wait",
]);
function detailsProjection(details: readonly (string | number)[]): boolean | number {
  if (details[0] !== "details") {
    return false;
  }
  if (details.length === 1) {
    return true;
  }
  if (details.length === 2) {
    return detailFields.has(String(details[1])) ? 4096 : false;
  }
  return details.length === 3 &&
    ["completion", "subagentCompletion", "wait"].includes(String(details[1])) &&
    ["runId", "key", "ownerSessionId", "completionId", "status", "index"].includes(
      String(details[2]),
    )
    ? 4096
    : false;
}
const receiptProjection: Projection = (keys) => {
  if (keys.length === 0) {
    return true;
  }
  if (["type", "id", "customType"].includes(String(keys[0]))) {
    return keys.length === 1 ? 4096 : false;
  }
  if (keys[0] !== "message") {
    return detailsProjection(keys);
  }
  if (keys.length === 1) {
    return true;
  }
  if (["role", "toolName", "isError"].includes(String(keys[1]))) {
    return keys.length === 2 ? 4096 : false;
  }
  return detailsProjection(keys.slice(1));
};

interface ReceiptIndex {
  stamp: string;
  end: number;
  digest: string;
  entries: UnknownRecord[];
}
const indexes = new Map<string, ReceiptIndex>();

function digest(fd: number, end: number): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  for (let offset = 0; offset < end;) {
    const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, end - offset), offset);
    if (count === 0) {
      throw new Error("Native receipt journal truncated while reading.");
    }
    hash.update(buffer.subarray(0, count));
    offset += count;
  }
  return hash.digest("hex");
}
function index(file: string): ReceiptIndex {
  const fd = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    const stamp = journalStamp(stat);
    const cached = indexes.get(file);
    if (cached?.stamp === stamp) {
      return cached;
    }
    const retained =
      cached !== undefined && stat.size >= cached.end && digest(fd, cached.end) === cached.digest;
    const entries = retained ? [...cached.entries] : [];
    const end = scanJournal(
      fd,
      receiptProjection,
      ({ value }) => {
        entries.push(value);
      },
      {
        policy: "live",
        requireNewline: true,
        start: retained ? cached.end : 0,
      },
    );
    const result = { stamp, end, digest: digest(fd, end), entries };
    if (journalStamp(fs.fstatSync(fd, { bigint: true })) !== stamp) {
      throw new Error("Native receipt journal changed while reading.");
    }
    indexes.delete(file);
    indexes.set(file, result);
    if (indexes.size > 8) {
      const oldest = indexes.keys().next().value;
      if (oldest !== undefined) {
        indexes.delete(oldest);
      }
    }
    return result;
  } finally {
    fs.closeSync(fd);
  }
}

/** Physical LF publication owns delivery, including when native memory is stale. */
export function receiptId(
  file: string | undefined,
  owner: string,
  matches: (entry: UnknownRecord) => boolean,
): string | undefined {
  if (file === undefined || !fs.existsSync(file)) {
    return;
  }
  const entries = index(file).entries;
  if (entries[0]?.type !== "session" || entries[0].id !== owner) {
    return;
  }
  const found = entries.find((entry) => entry.type !== "session" && matches(entry));
  return typeof found?.id === "string" ? found.id : undefined;
}
