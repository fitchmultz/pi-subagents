import type { Usage as NativeUsage } from "@earendil-works/pi-ai";
import { isDeepStrictEqual } from "node:util";
import type {
  ObservedUsage,
  ReadonlyInput,
  Usage,
  UsageAccumulator,
  UsageContribution,
} from "../../shared/types.ts";
import { scanJournal, nativeProjection } from "../../shared/journal-reader.ts";
import { hasErrorCode, isRecord as isObject } from "../../shared/unknown.ts";
import { nonempty } from "./child-presence.ts";
import {
  observedUsage,
  optionalNumber,
  optionalString,
  requiredString,
} from "./child-message-validation.ts";

export interface NativeBaseline {
  readonly ids: Readonly<ReadonlySet<string>>;
  readonly entryCount: number;
  readonly legacy: boolean;
  readonly sessionId?: string;
}

export function snapshotNativeBaseline(
  file: string | undefined,
): NativeBaseline & { readonly ids: Set<string> } {
  const ids = new Set<string>();
  let first = true;
  let native = false;
  let entryCount = 0;
  let legacy = false;
  let sessionId: string | undefined;
  if (nonempty(file)) {
    try {
      scanJournal(
        file,
        (path) =>
          path.length === 0 ||
          (path.length === 1 && ["id", "type", "version"].includes(String(path[0]))),
        ({ value }) => {
          if (first) {
            first = false;
            native = value.type === "session";
            if (native) {
              sessionId = requiredString(value.id, "native session identity");
              if (sessionId.length === 0) {
                throw new SyntaxError("Invalid native session identity");
              }
              legacy = value.version === 1;
            }
          } else if (native) {
            entryCount++;
          }
          if (native && typeof value.id === "string") {
            ids.add(value.id);
          }
        },
        { requireNewline: true },
      );
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) {
        throw error;
      }
    }
  }
  return { ids, entryCount, legacy, sessionId };
}

export function snapshotNativeUsage(file: string | undefined): Set<string> {
  return snapshotNativeBaseline(file).ids;
}

function validateObservedCounters(value: ObservedUsage): void {
  // This exported reducer may receive external observations; static types are not wire validation.
  observedUsage(value);
  for (const [key, counter] of Object.entries(value)) {
    if (typeof counter === "number" && (!Number.isFinite(counter) || counter < 0)) {
      throw new Error(`Invalid native usage counter: ${key}`);
    }
  }
  if (value.cost) {
    for (const counter of Object.values(value.cost)) {
      if (!Number.isFinite(counter) || counter < 0) {
        throw new Error("Invalid native usage cost");
      }
    }
  }
}

/** Mutating accounting boundary: the caller owns this accumulator, observations stay readonly. */
export function addUsage(
  usage: UsageAccumulator,
  value: ObservedUsage,
  attribution?: Omit<UsageContribution, "usage">,
): void {
  validateObservedCounters(value);
  usage.input += value.input ?? 0;
  usage.output += value.output ?? 0;
  usage.cacheRead += value.cacheRead ?? 0;
  usage.cacheWrite += value.cacheWrite ?? 0;
  usage.cost += value.cost?.total ?? 0;
  if (attribution) {
    (usage.contributions ??= []).push({ ...attribution, usage: value });
  }
}

/** Complete native receipts are required for billing; partial observations remain audit-only. */
export function validateNativeUsage(
  value: ObservedUsage,
): asserts value is ReadonlyInput<NativeUsage> {
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
    const counter = value[key];
    if (counter === undefined || !Number.isFinite(counter) || counter < 0) {
      throw new Error(`Native usage ${key} is unavailable or invalid`);
    }
  }
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
    const counter = value.cost?.[key];
    if (counter === undefined || !Number.isFinite(counter) || counter < 0) {
      throw new Error(`Native usage cost.${key} is unavailable or invalid`);
    }
  }
}

export interface NativeUsageMetadata {
  readonly type: string;
  readonly id: string;
  readonly checkpoint?: boolean;
  readonly provider?: string;
  readonly model?: string;
  readonly usage?: ObservedUsage;
  readonly message?: {
    readonly role: string;
    readonly timestamp?: number;
    readonly toolCallId?: string;
    readonly provider?: string;
    readonly model?: string;
    readonly responseModel?: string;
    readonly usage?: ObservedUsage;
  };
}

export function nativeUsageMetadata(value: unknown): NativeUsageMetadata {
  if (!isObject(value)) {
    throw new SyntaxError("Invalid native entry");
  }
  const message = isObject(value.message) ? value.message : undefined;
  if (value.type === "message" && !message) {
    throw new SyntaxError("Invalid native message");
  }
  if (value.checkpoint !== undefined && typeof value.checkpoint !== "boolean") {
    throw new SyntaxError("Invalid native checkpoint");
  }
  return {
    ...value,
    type: requiredString(value.type, "native entry type"),
    id: requiredString(value.id, "native entry identity"),
    checkpoint: value.checkpoint,
    provider: optionalString(value.provider, "provider"),
    model: optionalString(value.model, "model"),
    usage: observedUsage(value.usage),
    message: message
      ? {
          role: requiredString(message.role, "native message role"),
          timestamp: optionalNumber(message.timestamp, "timestamp"),
          toolCallId: optionalString(message.toolCallId, "toolCallId"),
          provider: optionalString(message.provider, "provider"),
          model: optionalString(message.model, "model"),
          responseModel: optionalString(message.responseModel, "responseModel"),
          usage: observedUsage(message.usage),
        }
      : undefined,
  };
}

interface EntryUsage {
  readonly value?: ObservedUsage;
  readonly provider?: string;
  readonly model?: string;
}
function messageUsage(message: NativeUsageMetadata["message"]): EntryUsage {
  if (message?.role === "assistant") {
    return {
      value: message.usage,
      provider: message.provider,
      model: message.responseModel ?? message.model,
    };
  }
  return { value: message?.role === "toolResult" ? message.usage : undefined };
}
function entryUsage(entry: NativeUsageMetadata): EntryUsage {
  if (entry.type === "usage") {
    return { value: entry.usage, provider: entry.provider, model: entry.model };
  }
  if (entry.type === "compaction" || entry.type === "branch_summary") {
    return { value: entry.usage };
  }
  return entry.type === "message" ? messageUsage(entry.message) : {};
}
function requiredReceipt(entry: NativeUsageMetadata): EntryUsage {
  const receipt = entryUsage(entry);
  const required =
    entry.type === "usage" || (entry.type === "message" && entry.message?.role === "assistant");
  if (!receipt.value && required) {
    throw new Error(`Required native usage is unavailable: ${entry.id}`);
  }
  return receipt;
}
export interface NativeUsageCollector {
  readonly totals: readonly Usage[];
  readonly append: (entry: NativeUsageMetadata) => void;
}

class UsageCollector implements NativeUsageCollector {
  private readonly sessionId: string;
  private readonly baseline: Readonly<ReadonlySet<string>>;
  private readonly boundaries: readonly (string | undefined)[];
  private readonly segments: UsageAccumulator[];
  private readonly contributions = new Map<string, UsageContribution>();
  private readonly turns = new Set<string>();
  private segment = 0;
  constructor(
    sessionId: string,
    baseline: Readonly<ReadonlySet<string>>,
    boundaries: readonly (string | undefined)[],
  ) {
    this.sessionId = sessionId;
    this.baseline = baseline;
    this.boundaries = boundaries;
    this.segments = Array.from({ length: Math.max(1, boundaries.length) }, () => ({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 0,
      contributions: [],
    }));
  }
  get totals(): readonly Usage[] {
    return this.segments;
  }
  private total(): UsageAccumulator {
    const total = this.segments.at(this.segment);
    if (!total) {
      throw new Error("Missing native usage segment");
    }
    return total;
  }
  private countTurn(entry: NativeUsageMetadata): void {
    if (
      entry.type === "message" &&
      entry.message?.role === "assistant" &&
      !this.turns.has(entry.id)
    ) {
      this.total().turns++;
      this.turns.add(entry.id);
    }
  }
  private account(entry: NativeUsageMetadata): void {
    const { value, provider, model } = requiredReceipt(entry);
    this.countTurn(entry);
    if (!value) {
      return;
    }
    validateNativeUsage(value);
    if (entry.id.length === 0) {
      throw new Error("Native usage entry identity is unavailable");
    }
    const next = { id: `${this.sessionId}:${entry.id}`, provider, model, usage: value };
    const previous = this.contributions.get(next.id);
    if (previous && !isDeepStrictEqual(previous, next)) {
      throw new Error(`Conflicting native usage contribution: ${next.id}`);
    }
    if (!previous) {
      this.contributions.set(next.id, next);
      addUsage(this.total(), value, { id: next.id, provider, model });
    }
  }
  append(entry: NativeUsageMetadata): void {
    if (!this.baseline.has(entry.id) && entry.checkpoint !== true) {
      this.account(entry);
    }
    if (entry.id === this.boundaries.at(this.segment) && this.segment < this.segments.length - 1) {
      this.segment++;
    }
  }
}

/** One reducer for published journals and settled, once-audited in-memory sessions. */
export function nativeUsageCollector(
  sessionId: string,
  baseline: Readonly<ReadonlySet<string>>,
  boundaries: readonly (string | undefined)[] = [],
): NativeUsageCollector {
  return new UsageCollector(sessionId, baseline, boundaries);
}

interface NativeUsageReadOptions {
  readonly terminalEntryId?: string;
  readonly onEntry?: (entry: NativeUsageMetadata) => void;
  readonly onBoundary?: (boundary: {
    readonly sessionId: string;
    readonly lastEntryId?: string;
  }) => void;
}
class UsageReader {
  private readonly baseline: Readonly<ReadonlySet<string>>;
  private readonly boundaries: readonly (string | undefined)[];
  private readonly options: NativeUsageReadOptions;
  private first = true;
  private sessionId?: string;
  private lastEntryId?: string;
  private reached = false;
  private collector?: NativeUsageCollector;
  constructor(
    baseline: Readonly<ReadonlySet<string>>,
    boundaries: readonly (string | undefined)[],
    options: NativeUsageReadOptions,
  ) {
    this.baseline = baseline;
    this.boundaries = boundaries;
    this.options = options;
  }
  observe(value: Readonly<Record<string, unknown>>): boolean {
    if (this.first) {
      this.first = false;
      this.sessionId =
        value.type === "session" ? requiredString(value.id, "native session identity") : undefined;
      if (nonempty(this.sessionId)) {
        this.collector = nativeUsageCollector(this.sessionId, this.baseline, this.boundaries);
      }
    }
    if (!this.collector) {
      return false;
    }
    const entry = nativeUsageMetadata(value);
    this.options.onEntry?.(entry);
    this.collector.append(entry);
    if (entry.type !== "session") {
      this.lastEntryId = entry.id;
    }
    if (entry.id === this.options.terminalEntryId) {
      this.reached = true;
      return true;
    }
    return false;
  }
  finish(): Usage[] | undefined {
    if (nonempty(this.options.terminalEntryId) && !this.reached) {
      throw new Error("Native accounting terminal entry is missing");
    }
    if (nonempty(this.sessionId)) {
      this.options.onBoundary?.({ sessionId: this.sessionId, lastEntryId: this.lastEntryId });
    }
    return this.collector?.totals.slice();
  }
}

/** Read journals without opening a second writer or copying their transcripts. */
export function readNativeUsage(
  file: string | undefined,
  baseline: Readonly<ReadonlySet<string>>,
  boundaries: readonly (string | undefined)[] = [],
  options: NativeUsageReadOptions = {},
): Usage[] | undefined {
  if (!nonempty(file)) {
    return;
  }
  const reader = new UsageReader(baseline, boundaries, options);
  const boundaryReached = new Error("terminal entry reached");
  try {
    scanJournal(
      file,
      (keys, root) =>
        keys[0] === "message" && keys[1] === "content" ? false : nativeProjection(keys, root),
      ({ value }) => {
        if (reader.observe(value)) {
          throw boundaryReached;
        }
      },
      { requireNewline: true },
    );
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return;
    }
    if (error !== boundaryReached) {
      throw error;
    }
  }
  return reader.finish();
}
