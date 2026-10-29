import * as path from "node:path";
import * as fs from "node:fs";
import { journalStamp, nativeAppend } from "../shared/native-journal.ts";
import { nativeProjection } from "../shared/journal-projections.ts";
import { scanJournal } from "../shared/journal-frames.ts";
import { isRecord, type UnknownRecord } from "../shared/unknown.ts";
import { Assert } from "./typebox.ts";
import {
  contributionsSchema,
  resultSchema,
  type Contribution,
  type Launch,
  type Result,
} from "./contracts.ts";
import { read, runDirectory, write } from "./storage.ts";

/** Billing evidence of one native entry. Missing required usage is an error only outside a baseline. */
function billing(entry: UnknownRecord): UnknownRecord | "missing" | undefined {
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
  if (message.usage === undefined) {
    return entry.type === "usage" || message.role === "assistant" ? "missing" : undefined;
  }
  const { role, provider, model, responseModel, usage } = message;
  return { role, provider, model, responseModel, usage };
}
function attribution(message: UnknownRecord, launch: Launch) {
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
interface Entry {
  readonly id: string;
  readonly billing: UnknownRecord | "missing" | undefined;
}
/** Accounting metadata of the validated LF-published journal records before `end`. */
interface Prefix {
  stat: fs.BigIntStats;
  end: number;
  header?: UnknownRecord;
  readonly entries: Entry[];
}
function identify(header: UnknownRecord, launch: Launch): void {
  if (header.type !== "session" || header.id !== launch.sessionId) {
    throw new Error("Foreign native usage journal identity.");
  }
}
/** An unchanged or native v3 appended journal keeps its prefix; any other change rebuilds it. */
function reusable(cached: Prefix | undefined, stat: fs.BigIntStats): Prefix {
  return cached !== undefined &&
    (journalStamp(cached.stat) === journalStamp(stat) ||
      nativeAppend(cached.stat, stat, cached.header))
    ? cached
    : { stat, end: 0, entries: [] };
}
/**
 * Child usage of one physical native journal. A retained index parses only records after its last
 * accepted LF boundary. Baselines, required usage and attribution apply to each read.
 */
export class UsageIndex {
  private prefix?: Prefix;
  read(launch: Launch, baseline: ReadonlySet<string>, terminal?: string): Contribution[] {
    const values: unknown[] = [];
    const reachedTerminal = new Error("Native terminal boundary reached.");
    const charge = (entry: Entry): void => {
      const billed = baseline.has(entry.id) ? undefined : entry.billing;
      if (billed === "missing") {
        throw new Error("Required native usage is unavailable.");
      }
      if (billed !== undefined) {
        values.push({
          id: `${launch.sessionId}:${entry.id}`,
          ...attribution(billed, launch),
          usage: billed.usage,
        });
      }
      if (entry.id === terminal) {
        throw reachedTerminal;
      }
    };
    const cached = this.prefix;
    // Only a completed read is retained.
    this.prefix = undefined;
    const fd = fs.openSync(launch.sessionFile, "r");
    try {
      const stat = fs.fstatSync(fd, { bigint: true });
      const prefix = reusable(cached, stat);
      let ended = false;
      try {
        if (prefix.header !== undefined) {
          identify(prefix.header, launch);
        }
        for (const entry of prefix.entries) {
          charge(entry);
        }
        scanJournal(
          fd,
          nativeProjection,
          ({ value, end }) => {
            if (prefix.header === undefined) {
              identify(value, launch);
              prefix.header = value;
              prefix.end = end;
              return;
            }
            if (typeof value.id !== "string" || typeof value.type !== "string") {
              throw new Error("Missing native usage entry identity.");
            }
            const entry = { id: value.id, billing: billing(value) };
            prefix.entries.push(entry);
            prefix.end = end;
            charge(entry);
          },
          { policy: "live", requireNewline: true, start: prefix.end },
        );
      } catch (error) {
        if (error !== reachedTerminal) {
          throw error;
        }
        ended = true;
      }
      if (journalStamp(fs.fstatSync(fd, { bigint: true })) !== journalStamp(stat)) {
        throw new Error("Native usage journal changed while reading.");
      }
      if (prefix.header === undefined || (terminal !== undefined && !ended)) {
        throw new Error("Native terminal or session identity is not LF-published.");
      }
      Assert(contributionsSchema, values);
      prefix.stat = stat;
      this.prefix = prefix;
      return values;
    } finally {
      fs.closeSync(fd);
    }
  }
}
/** A fresh read for callers without an owner lifetime. */
export function childUsage(
  launch: Launch,
  baseline: ReadonlySet<string>,
  terminal?: string,
): Contribution[] {
  return new UsageIndex().read(launch, baseline, terminal);
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
