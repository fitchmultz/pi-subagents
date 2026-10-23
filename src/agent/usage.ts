import * as path from "node:path";
import * as fs from "node:fs";
import { journalStamp } from "../shared/native-journal.ts";
import { nativeProjection } from "../shared/journal-projections.ts";
import { scanJournal } from "../shared/journal-frames.ts";
import { isRecord } from "../shared/unknown.ts";
import { Assert } from "./typebox.ts";
import {
  contributionsSchema,
  resultSchema,
  type Contribution,
  type Launch,
  type Result,
} from "./contracts.ts";
import { read, runDirectory, write } from "./storage.ts";

function billing(entry: Record<string, unknown>) {
  if (entry.checkpoint === true) {
    return;
  }
  const message = isRecord(entry.message) ? entry.message : entry;
  if (
    !["message", "usage", "compaction", "branch_summary"].some((type) => type === entry.type) ||
    (entry.type === "message" && !["assistant", "toolResult"].some((role) => role === message.role))
  ) {
    return;
  }
  const required = entry.type === "usage" || message.role === "assistant";
  if (required && message.usage === undefined) {
    throw new Error("Required native usage is unavailable.");
  }
  return message.usage === undefined ? undefined : message;
}
function attribution(message: Record<string, unknown>, launch: Launch) {
  if (message.role === "toolResult") {
    return { provider: launch.provider, model: launch.model };
  }
  const model =
    message.role === "assistant" && typeof message.responseModel === "string"
      ? message.responseModel
      : message.model;
  return {
    provider: typeof message.provider === "string" ? message.provider : launch.provider,
    model: typeof model === "string" ? model : launch.model,
  };
}
export function childUsage(
  launch: Launch,
  baseline: ReadonlySet<string>,
  terminal?: string,
): Contribution[] {
  const values: unknown[] = [];
  const observed = { header: false, ended: false };
  const reachedTerminal = new Error("Native terminal boundary reached.");
  const fd = fs.openSync(launch.sessionFile, "r");
  try {
    const stamp = journalStamp(fs.fstatSync(fd, { bigint: true }));
    try {
      scanJournal(
        fd,
        nativeProjection,
        ({ value }) => {
          if (!observed.header) {
            if (value.type !== "session" || value.id !== launch.sessionId) {
              throw new Error("Foreign native usage journal identity.");
            }
            observed.header = true;
            return;
          }
          if (typeof value.id !== "string" || typeof value.type !== "string") {
            throw new Error("Missing native usage entry identity.");
          }
          const message = baseline.has(value.id) ? undefined : billing(value);
          if (message) {
            values.push({
              id: `${launch.sessionId}:${value.id}`,
              ...attribution(message, launch),
              usage: message.usage,
            });
          }
          if (value.id === terminal) {
            observed.ended = true;
            throw reachedTerminal;
          }
        },
        { policy: "live", requireNewline: true },
      );
    } catch (error) {
      if (error !== reachedTerminal) {
        throw error;
      }
    }
    if (journalStamp(fs.fstatSync(fd, { bigint: true })) !== stamp) {
      throw new Error("Native usage journal changed while reading.");
    }
  } finally {
    fs.closeSync(fd);
  }
  if (!observed.header || (terminal !== undefined && !observed.ended)) {
    throw new Error("Native terminal or session identity is not LF-published.");
  }
  Assert(contributionsSchema, values);
  return values;
}
export function readCanonicalResult(base: string, launch: Launch): Result | undefined {
  const file = path.join(runDirectory(base, launch.id), "result.json");
  const result = read(file, resultSchema);
  if (result && (result.id !== launch.id || result.owner !== launch.owner)) {
    throw new Error("Foreign canonical result identity.");
  }
  return result;
}
export function readResult(base: string, launch: Launch): Result | undefined {
  const result = readCanonicalResult(base, launch);
  if (!result) {
    return;
  }
  const pending = result.accountingPending;
  if (pending === undefined) {
    return result;
  }
  let contributions;
  try {
    contributions = childUsage(launch, new Set(pending.baseline), pending.terminalCandidate);
  } catch {
    // Execution and output remain canonical while native billing publication is incomplete.
    return result;
  }
  const { accountingPending: _pending, accountingError: _error, ...execution } = result;
  const repaired = { ...execution, terminalEntryId: pending.terminalCandidate, contributions };
  write(path.join(runDirectory(base, launch.id), "result.json"), repaired);
  return repaired;
}
