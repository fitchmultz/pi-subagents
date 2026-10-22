import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { scanJournal } from "../shared/journal-frames.ts";
import { journalStamp } from "../shared/native-journal.ts";
import type { Projection } from "../shared/json-projection.ts";
import { isRecord, type UnknownRecord } from "../shared/unknown.ts";

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
  /** First completion receipt per owned run ID, built in the same LF pass. */
  completions: Map<string, string | undefined>;
}
const indexes = new Map<string, ReceiptIndex>();
type Prefix = Pick<ReceiptIndex, "end" | "entries" | "completions">;

function toolCompletion(message: unknown): unknown {
  return isRecord(message) &&
    message.role === "toolResult" &&
    (message.toolName === "delegate" || message.toolName === "agent_runs") &&
    isRecord(message.details) &&
    message.details.receivedResult === true
    ? message.details
    : undefined;
}
function completionDetails(entry: UnknownRecord): unknown {
  if (entry.type === "custom_message" && entry.customType === "agent-completion") {
    return entry.details;
  }
  return entry.type === "message" ? toolCompletion(entry.message) : undefined;
}
function addEntry(journal: Prefix, entry: UnknownRecord) {
  const header = journal.entries.at(0);
  const owner = header?.type === "session" ? header.id : undefined;
  const details = typeof owner === "string" ? completionDetails(entry) : undefined;
  if (
    isRecord(details) &&
    details.owner === owner &&
    details.completed === true &&
    typeof details.id === "string" &&
    !journal.completions.has(details.id)
  ) {
    journal.completions.set(details.id, typeof entry.id === "string" ? entry.id : undefined);
  }
  journal.entries.push(entry);
}
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
function prefix(fd: number, stat: fs.BigIntStats, cached: ReceiptIndex | undefined): Prefix {
  if (cached !== undefined && stat.size >= cached.end && digest(fd, cached.end) === cached.digest) {
    return {
      end: cached.end,
      entries: [...cached.entries],
      completions: new Map(cached.completions),
    };
  }
  return { end: 0, entries: [], completions: new Map() };
}
function index(file: string, observed: fs.BigIntStats): ReceiptIndex {
  const cached = indexes.get(file);
  if (cached?.stamp === journalStamp(observed)) {
    return cached;
  }
  const fd = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    const stamp = journalStamp(stat);
    if (cached?.stamp === stamp) {
      return cached;
    }
    const retained = prefix(fd, stat, cached);
    const end = scanJournal(
      fd,
      receiptProjection,
      ({ value }) => {
        addEntry(retained, value);
      },
      {
        policy: "live",
        requireNewline: true,
        start: retained.end,
      },
    );
    const result = { ...retained, stamp, end, digest: digest(fd, end) };
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
function owned(file: string | undefined, owner: string): ReceiptIndex | undefined {
  const stat =
    file === undefined ? undefined : fs.statSync(file, { bigint: true, throwIfNoEntry: false });
  if (file === undefined || stat === undefined) {
    return;
  }
  const journal = index(file, stat);
  const header = journal.entries.at(0);
  return header?.type === "session" && header.id === owner ? journal : undefined;
}
export function receiptId(
  file: string | undefined,
  owner: string,
  matches: (entry: UnknownRecord) => boolean,
): string | undefined {
  const found = owned(file, owner)?.entries.find(
    (entry) => entry.type !== "session" && matches(entry),
  );
  return typeof found?.id === "string" ? found.id : undefined;
}
/** Completion receipt IDs by run ID; a matching entry without an ID is unpublished. */
export function completionReceipts(
  file: string | undefined,
  owner: string,
): ReadonlyMap<string, string | undefined> {
  return owned(file, owner)?.completions ?? new Map<string, string>();
}
