import * as fs from "node:fs";
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

/** Physical LF publication owns delivery, including when native memory is stale. */
export function receiptId(
  file: string | undefined,
  owner: string,
  matches: (entry: UnknownRecord) => boolean,
): string | undefined {
  if (file === undefined || !fs.existsSync(file)) {
    return;
  }
  const fd = fs.openSync(file, "r");
  let first = true;
  let owned = false;
  let found: string | undefined;
  try {
    const stamp = journalStamp(fs.fstatSync(fd, { bigint: true }));
    scanJournal(
      fd,
      receiptProjection,
      ({ value }) => {
        if (first) {
          first = false;
          owned = value.type === "session" && value.id === owner;
        } else if (owned && found === undefined && typeof value.id === "string" && matches(value)) {
          found = value.id;
        }
      },
      { policy: "live", requireNewline: true },
    );
    if (journalStamp(fs.fstatSync(fd, { bigint: true })) !== stamp) {
      throw new Error("Native receipt journal changed while reading.");
    }
    return found;
  } finally {
    fs.closeSync(fd);
  }
}
