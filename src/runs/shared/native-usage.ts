import type { Usage as NativeUsage } from "@earendil-works/pi-ai";
import { isDeepStrictEqual } from "node:util";
import type { Usage, UsageContribution } from "../../shared/types.ts";
import { scanJournal, nativeProjection } from "../../shared/journal-reader.ts";

export function snapshotNativeBaseline(file: string | undefined): {
  ids: Set<string>;
  entryCount: number;
  legacy: boolean;
  sessionId?: string;
} {
  const ids = new Set<string>();
  let first = true,
    native = false,
    entryCount = 0,
    legacy = false,
    sessionId: string | undefined;
  if (file) {
    try {
      scanJournal(
        file,
        (path) =>
          !path.length ||
          (path.length === 1 && ["id", "type", "version"].includes(String(path[0]))),
        ({ value }) => {
          if (first) {
            first = false;
            native = value?.type === "session";
            if (native) {
              if (typeof value.id !== "string" || !value.id)
                throw new SyntaxError("Invalid native session identity");
              sessionId = value.id;
              legacy = value.version === 1;
            }
          } else if (native) entryCount++;
          if (native && typeof value?.id === "string") ids.add(value.id);
        },
        { requireNewline: true },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return { ids, entryCount, legacy, sessionId };
}

export function snapshotNativeUsage(file: string | undefined): Set<string> {
  return snapshotNativeBaseline(file).ids;
}

export function addUsage(
  usage: Usage,
  value: NativeUsage,
  attribution?: Omit<UsageContribution, "usage">,
): void {
  for (const key of [
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "totalTokens",
    "reasoning",
    "cacheWrite1h",
  ] as const) {
    if (value[key] !== undefined && typeof value[key] !== "number") {
      throw new Error(`Invalid native usage counter: ${key}`);
    }
  }
  for (const [key, counter] of Object.entries(value)) {
    if (typeof counter === "number" && (!Number.isFinite(counter) || counter < 0)) {
      throw new Error(`Invalid native usage counter: ${key}`);
    }
  }
  if (value.cost) {
    for (const counter of Object.values(value.cost))
      if (!Number.isFinite(counter) || counter < 0) throw new Error("Invalid native usage cost");
  }
  usage.input += value.input ?? 0;
  usage.output += value.output ?? 0;
  usage.cacheRead += value.cacheRead ?? 0;
  usage.cacheWrite += value.cacheWrite ?? 0;
  usage.cost += value.cost?.total ?? 0;
  if (attribution) {
    (usage.contributions ??= []).push({ ...attribution, usage: value });
  }
}

export function validateNativeUsage(value: NativeUsage): void {
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] < 0) {
      throw new Error(`Native usage ${key} is unavailable or invalid`);
    }
  }
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
    if (
      !value.cost ||
      typeof value.cost[key] !== "number" ||
      !Number.isFinite(value.cost[key]) ||
      value.cost[key] < 0
    ) {
      throw new Error(`Native usage cost.${key} is unavailable or invalid`);
    }
  }
}

export interface NativeUsageMetadata {
  type: string;
  id: string;
  checkpoint?: boolean;
  provider?: string;
  model?: string;
  usage?: NativeUsage;
  message?: {
    role: string;
    timestamp?: number;
    toolCallId?: string;
    provider?: string;
    model?: string;
    responseModel?: string;
    usage?: NativeUsage;
  };
}

/** One billing reducer for published journals and settled, once-audited in-memory sessions. */
export function nativeUsageCollector(
  sessionId: string,
  baseline: ReadonlySet<string>,
  boundaries: Array<string | undefined> = [],
) {
  const totals: Usage[] = Array.from({ length: Math.max(1, boundaries.length) }, () => ({
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 0,
    contributions: [],
  }));
  let segment = 0;
  const contributions = new Map<string, UsageContribution>(),
    turns = new Set<string>();
  return {
    totals,
    append(entry: NativeUsageMetadata) {
      if (!entry || typeof entry !== "object") {
        throw new SyntaxError("Invalid native entry");
      }
      if (entry.type === "message" && (!entry.message || typeof entry.message.role !== "string")) {
        throw new SyntaxError("Invalid native message");
      }
      if (!baseline.has(entry.id) && entry.checkpoint !== true) {
        let value: NativeUsage | undefined, provider: string | undefined, model: string | undefined;
        if (entry.type === "usage") {
          value = entry.usage;
          provider = entry.provider;
          model = entry.model;
        } else if (entry.type === "compaction" || entry.type === "branch_summary") {
          value = entry.usage;
        } else if (entry.type === "message") {
          if (entry.message?.role === "assistant") {
            value = entry.message.usage;
            provider = entry.message.provider;
            model = entry.message.responseModel ?? entry.message.model;
            if (!turns.has(entry.id)) {
              totals[segment]!.turns++;
              turns.add(entry.id);
            }
          } else if (entry.message?.role === "toolResult") {
            value = entry.message.usage;
          }
        }
        if (
          !value &&
          (entry.type === "usage" ||
            (entry.type === "message" && entry.message?.role === "assistant"))
        ) {
          throw new Error(`Required native usage is unavailable: ${entry.id}`);
        }
        if (value) {
          validateNativeUsage(value);
          if (typeof entry.id !== "string" || !entry.id) {
            throw new Error("Native usage entry identity is unavailable");
          }
          const next = { id: `${sessionId}:${entry.id}`, provider, model, usage: value };
          const previous = contributions.get(next.id);
          if (previous && !isDeepStrictEqual(previous, next)) {
            throw new Error(`Conflicting native usage contribution: ${next.id}`);
          }
          if (!previous) {
            contributions.set(next.id, next);
            addUsage(totals[segment]!, value, { id: next.id, provider, model });
          }
        }
      }
      if (entry.id === boundaries[segment] && segment < totals.length - 1) {
        segment++;
      }
    },
  };
}

/** Read native journals without opening a second writer or copying their transcripts. */
export function readNativeUsage(
  file: string | undefined,
  baseline: ReadonlySet<string>,
  boundaries: Array<string | undefined> = [],
  options: {
    terminalEntryId?: string;
    onEntry?: (entry: NativeUsageMetadata) => void;
    onBoundary?: (boundary: { sessionId: string; lastEntryId?: string }) => void;
  } = {},
): Usage[] | undefined {
  if (!file) {
    return;
  }
  let sessionId: string | undefined,
    first = true,
    lastEntryId: string | undefined,
    reached = false;
  let collector: ReturnType<typeof nativeUsageCollector> | undefined;
  const boundaryReached = Symbol("terminal entry");
  try {
    scanJournal(
      file,
      (path, root) =>
        path[0] === "message" && path[1] === "content" ? false : nativeProjection(path, root),
      ({ value: entry }) => {
        if (first) {
          first = false;
          sessionId = entry?.type === "session" ? entry.id : undefined;
          if (sessionId) {
            collector = nativeUsageCollector(sessionId, baseline, boundaries);
          }
        }
        if (!collector) {
          return;
        }
        options.onEntry?.(entry as NativeUsageMetadata);
        collector.append(entry as NativeUsageMetadata);
        if (entry.type !== "session") {
          lastEntryId = entry.id;
        }
        if (entry.id === options.terminalEntryId) {
          reached = true;
          throw boundaryReached;
        }
      },
      { requireNewline: true },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    if (error !== boundaryReached) {
      throw error;
    }
  }
  if (options.terminalEntryId && !reached) {
    throw new Error("Native accounting terminal entry is missing");
  }
  if (sessionId) {
    options.onBoundary?.({ sessionId, lastEntryId });
  }
  return collector?.totals;
}
