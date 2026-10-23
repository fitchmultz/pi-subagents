import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import * as path from "node:path";
import * as fs from "node:fs";
import { journalStamp, nativeAppend } from "../shared/native-journal.ts";
import { isDeepStrictEqual } from "node:util";
import { nativeProjection } from "../shared/journal-projections.ts";
import { scanJournal } from "../shared/journal-frames.ts";
import type { Projection } from "../shared/json-projection.ts";
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

export function sumUsage(values: readonly Contribution[]): Usage {
  const total: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  for (const { usage } of values) {
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
      total[key] += usage[key];
    }
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
      total.cost[key] += usage.cost[key];
    }
    for (const key of ["reasoning", "cacheWrite1h"] as const) {
      if (usage[key] !== undefined) {
        total[key] = (total[key] ?? 0) + usage[key];
      }
    }
  }
  return total;
}
function intents(details: unknown): Contribution[] | undefined {
  if (!isRecord(details) || details.agentUsage === undefined) {
    return;
  }
  const values: unknown = details.agentUsage;
  Assert(contributionsSchema, values);
  return values;
}
function publishedContributions(entry: unknown): Contribution[] {
  if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) {
    return [];
  }
  const message = entry.message;
  if (
    message.role !== "toolResult" ||
    (message.toolName !== "delegate" && message.toolName !== "agent_runs")
  ) {
    return [];
  }
  const values = intents(message.details);
  if (values === undefined || !isDeepStrictEqual(sumUsage(values), message.usage)) {
    return [];
  }
  return values;
}
const receiptProjection: Projection = (keys) => {
  if (keys.length === 0 || keys[0] === "type" || keys[0] === "version") {
    return true;
  }
  if (keys[0] !== "message") {
    return false;
  }
  if (keys.length === 1 || ["role", "toolName", "usage"].includes(String(keys[1]))) {
    return true;
  }
  return keys[1] === "details" && (keys.length === 2 || keys[2] === "agentUsage");
};
interface UsageIndex {
  readonly stamp: string;
  readonly stat: fs.BigIntStats;
  readonly end: number;
  readonly header: UnknownRecord | undefined;
  readonly values: Map<string, Contribution>;
}
const usageIndexes = new Map<string, UsageIndex>();
function readUsage(fd: number, stat: fs.BigIntStats, cached: UsageIndex | undefined): UsageIndex {
  const stamp = journalStamp(stat);
  const retained = cached && nativeAppend(cached.stat, stat, cached.header) ? cached : undefined;
  const appended = new Map<string, Contribution>();
  let header = retained?.header;
  const end = scanJournal(
    fd,
    receiptProjection,
    ({ value: entry }) => {
      header ??= entry;
      for (const value of publishedContributions(entry)) {
        appended.set(value.id, value);
      }
    },
    { policy: "live", requireNewline: true, start: retained?.end ?? 0 },
  );
  if (journalStamp(fs.fstatSync(fd, { bigint: true })) !== stamp) {
    throw new Error("Native parent usage journal changed while reading.");
  }
  const values = retained?.values ?? new Map<string, Contribution>();
  for (const [id, value] of appended) {
    values.set(id, value);
  }
  return { stamp, stat, end, header, values };
}
function physicalUsage(file: string, observed: fs.BigIntStats): ReadonlyMap<string, Contribution> {
  const cached = usageIndexes.get(file);
  if (cached?.stamp === journalStamp(observed)) {
    return cached.values;
  }
  const fd = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    const result = readUsage(fd, stat, cached);
    usageIndexes.delete(file);
    usageIndexes.set(file, result);
    if (usageIndexes.size > 8) {
      const oldest = usageIndexes.keys().next().value;
      if (oldest !== undefined) {
        usageIndexes.delete(oldest);
      }
    }
    return result.values;
  } catch (error) {
    usageIndexes.delete(file);
    throw error;
  } finally {
    fs.closeSync(fd);
  }
}
/** Persistent journals return a live cache view; callers must not reserve prepared charges in it. */
function priorUsage(ctx: ExtensionContext): ReadonlyMap<string, Contribution> {
  // Native's public isPersisted() is omitted from its readonly extension type.
  // Adapters without it retain the conservative disk-plus-memory behavior.
  const manager: ExtensionContext["sessionManager"] & { isPersisted?: () => boolean } =
    ctx.sessionManager;
  const file = manager.getSessionFile();
  const stat =
    file === undefined ? undefined : fs.statSync(file, { bigint: true, throwIfNoEntry: false });
  const physical =
    file !== undefined && stat !== undefined
      ? physicalUsage(file, stat)
      : new Map<string, Contribution>();
  if (stat !== undefined && manager.isPersisted?.() === true) {
    // Flushed persistent sessions publish synchronous appends; memory may be stale.
    return physical;
  }
  // A non-persistent manager can still have a source journal; its new entries stay in memory.
  const values = new Map(physical);
  for (const entry of manager.getEntries()) {
    for (const value of publishedContributions(entry)) {
      values.set(value.id, value);
    }
  }
  return values;
}
function uncharged(
  values: readonly Contribution[],
  prior: ReadonlyMap<string, Contribution>,
): Contribution[] {
  const pending: Contribution[] = [];
  const prepared = new Map<string, Contribution>();
  for (const value of values) {
    const earlier = prior.get(value.id) ?? prepared.get(value.id);
    if (earlier && !isDeepStrictEqual(earlier, value)) {
      throw new Error(`Conflicting native usage contribution ${value.id}`);
    }
    if (!earlier) {
      pending.push(value);
      prepared.set(value.id, value);
    }
  }
  return pending;
}
export function registerUsage(pi: ExtensionAPI): void {
  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (
      message.role !== "toolResult" ||
      (message.toolName !== "delegate" && message.toolName !== "agent_runs")
    ) {
      return;
    }
    const values = intents(message.details);
    if (values === undefined || !isRecord(message.details)) {
      return;
    }
    const pending = uncharged(values, priorUsage(ctx));
    const { usage: _usage, ...rest } = message;
    // Finalized native tool messages are serialized even for concurrent tools.
    // Preparing or discarding a result cannot reserve a charge.
    return {
      message: {
        ...rest,
        details: { ...message.details, agentUsage: pending },
        ...(pending.length > 0 ? { usage: sumUsage(pending) } : {}),
      },
    };
  });
}
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
