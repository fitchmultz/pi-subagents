import * as fs from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { scanJournal } from "../shared/journal-frames.ts";
import { journalStamp, nativeAppend } from "../shared/native-journal.ts";
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
  if (["type", "id", "customType", "version"].includes(String(keys[0]))) {
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
  stat: fs.BigIntStats;
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
function prefix(stat: fs.BigIntStats, cached: ReceiptIndex | undefined): Prefix {
  return cached && nativeAppend(cached.stat, stat, cached.entries[0])
    ? cached
    : { end: 0, entries: [], completions: new Map() };
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
    const retained = prefix(stat, cached);
    const appended: UnknownRecord[] = [];
    const end = scanJournal(
      fd,
      receiptProjection,
      ({ value }) => {
        appended.push(value);
      },
      {
        policy: "live",
        requireNewline: true,
        start: retained.end,
      },
    );
    if (journalStamp(fs.fstatSync(fd, { bigint: true })) !== stamp) {
      throw new Error("Native receipt journal changed while reading.");
    }
    for (const entry of appended) {
      addEntry(retained, entry);
    }
    const result = { ...retained, stamp, end, stat };
    indexes.delete(file);
    indexes.set(file, result);
    if (indexes.size > 8) {
      const oldest = indexes.keys().next().value;
      if (oldest !== undefined) {
        indexes.delete(oldest);
      }
    }
    return result;
  } catch (error) {
    indexes.delete(file);
    throw error;
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
/** Without a session file (`--no-session`), Pi's append-only memory is the whole native transcript. */
function remembered(
  manager: ExtensionContext["sessionManager"],
  owner: string,
): Prefix | undefined {
  const header = manager.getHeader();
  if (header?.id !== owner) {
    return;
  }
  const journal: Prefix = { end: 0, entries: [], completions: new Map() };
  // Index the same record frames the physical journal scan accepts.
  for (const entry of [header, ...manager.getEntries()]) {
    if (isRecord(entry)) {
      addEntry(journal, entry);
    }
  }
  return journal;
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
/** Completion IDs by run from the native transcript: the session file when Pi persists one,
 * otherwise Pi's in-memory entries. A matching entry without an ID is unpublished.
 */
export function completionReceipts(
  manager: ExtensionContext["sessionManager"],
  owner: string,
): ReadonlyMap<string, string | undefined> {
  const file = manager.getSessionFile();
  const journal = file === undefined ? remembered(manager, owner) : owned(file, owner);
  return journal?.completions ?? new Map<string, string>();
}
