import * as fs from "node:fs";
import * as path from "node:path";
import { RESULTS_DIR } from "../../shared/types.ts";
import type { ReadonlyInput } from "../../shared/types/inputs.ts";
import { runSynchronously } from "../../shared/cooperative.ts";
import { asyncRunRoots, readAsyncRunRecord } from "./async-resume.ts";
import type { AsyncRunRecord } from "./async-run-record.ts";
import type { AsyncRunSummary } from "./async-run-summary.ts";
import { getRunMetadataDir, readRunJson } from "../shared/supervisor-questions.ts";
import { findNestedRouteForRootId } from "../shared/nested-events.ts";
import { reconcileAsyncRun, reconcileNestedAsyncDescendants } from "./stale-run-reconciler.ts";
import { validateStatusForSummary } from "./async-status-validation.ts";
import { asyncStatusToSummary } from "./async-status-projection.ts";
import { errorCode, errorMessage, hasText, isRecord } from "./async-value.ts";

interface AsyncRunListOptions {
  readonly states?: readonly AsyncRunSummary["state"][];
  readonly sessionId?: string;
  readonly limit?: number;
  readonly resultsDir?: string;
  readonly kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
  readonly now?: () => number;
  readonly reconcile?: boolean;
  readonly skipInvalid?: boolean;
  readonly records?: readonly AsyncRunRecord[];
}
interface AsyncRunDiscoveryOptions extends Omit<
  AsyncRunListOptions,
  "states" | "limit" | "records"
> {
  readonly ownerSessionId?: string;
  readonly receiptRunIds?: () => Iterable<string>;
}

function directory(root: string, entry: string): boolean {
  const entryPath = path.join(root, entry);
  try {
    return fs.statSync(entryPath).isDirectory();
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return false;
    }
    throw new Error(`Failed to inspect async run path '${entryPath}': ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

class AsyncRunDiscovery {
  private readonly owners = new Map<string, string>();
  private readonly discovered = new Set<string>();
  private readonly sessionIds: ReadonlySet<string>;
  private readonly ownerSessionId: string | undefined;

  private readonly root: string;
  private readonly options: ReadonlyInput<AsyncRunDiscoveryOptions>;
  constructor(root: string, options: ReadonlyInput<AsyncRunDiscoveryOptions>) {
    this.root = root;
    this.options = options;
    this.sessionIds = new Set([options.sessionId, options.ownerSessionId].filter(hasText));
    // A legacy file-path-only query cannot classify native UUID owners as foreign.
    this.ownerSessionId =
      options.ownerSessionId ??
      (hasText(options.sessionId) && !path.isAbsolute(options.sessionId)
        ? options.sessionId
        : undefined);
  }

  private *scanRoot(root: string): Generator<void, string[]> {
    const entries: string[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      yield;
      try {
        if (entry.isDirectory() || (entry.isSymbolicLink() && directory(root, entry.name))) {
          entries.push(entry.name);
        }
      } catch (error) {
        if (this.options.skipInvalid !== true) {
          throw error;
        }
        this.invalidEntry(path.join(root, entry.name), error);
      }
    }
    return entries;
  }

  private *candidates(receipts: readonly string[]): Generator<void, Set<string>> {
    const entries = new Set(receipts);
    for (const root of asyncRunRoots(this.root)) {
      try {
        const scanned = yield* this.scanRoot(root);
        for (const entry of scanned) {
          entries.add(entry);
        }
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          continue;
        }
        throw new Error(`Failed to list async runs in '${this.root}': ${errorMessage(error)}`, {
          cause: error,
        });
      }
    }
    return entries;
  }

  private invalidEntry(entry: string, error: unknown): void {
    console.error(`Skipping invalid async run '${entry}':`, error);
  }

  private owner(entry: string): string | undefined {
    let owner = this.owners.get(entry);
    if (!hasText(owner) && hasText(this.ownerSessionId)) {
      try {
        const saved: unknown = readRunJson(
          path.join(getRunMetadataDir(entry), "question-owner.json"),
        );
        if (
          isRecord(saved) &&
          typeof saved.sessionId === "string" &&
          saved.sessionId.trim().length > 0
        ) {
          owner = saved.sessionId;
          this.owners.set(entry, owner);
        }
      } catch {
        // Missing/unusable identity metadata retains the legacy status fallback.
      }
    }
    return owner;
  }

  private foreignOwner(owner: string | undefined, receipt: boolean): boolean {
    return hasText(owner) && owner !== this.ownerSessionId && !receipt;
  }
  private authorizedRecord(
    record: ReadonlyInput<AsyncRunRecord>,
    owner: string | undefined,
    receipt: boolean,
  ): boolean {
    const matching = owner !== undefined && owner === this.ownerSessionId;
    return (
      this.sessionIds.size === 0 ||
      receipt ||
      matching ||
      this.sessionIds.has(record.status?.sessionId ?? "")
    );
  }

  private readEntry(entry: string, receipt: boolean): AsyncRunRecord | undefined {
    if (this.discovered.has(entry)) {
      return undefined;
    }
    const owner = this.owner(entry);
    if (this.foreignOwner(owner, receipt)) {
      return undefined;
    }
    const record = readAsyncRunRecord(entry, this.root, this.options.resultsDir ?? RESULTS_DIR);
    const { asyncDir } = record.location;
    if (!hasText(asyncDir)) {
      return undefined;
    }
    if (!this.authorizedRecord(record, owner, receipt)) {
      return undefined;
    }
    if (this.options.reconcile !== false) {
      record.status = reconcileAsyncRun(asyncDir, this.options, record).status;
    }
    if (record.status) {
      validateStatusForSummary(record.status, path.join(asyncDir, "status.json"));
      this.discovered.add(entry);
    }
    return record;
  }

  *steps(): Generator<void, AsyncRunRecord[]> {
    const receipts = new Set(this.options.receiptRunIds?.());
    const entries = yield* this.candidates([...receipts]);
    const records: AsyncRunRecord[] = [];
    for (const entry of entries) {
      yield;
      try {
        const record = this.readEntry(entry, receipts.has(entry));
        if (record) {
          records.push(record);
        }
      } catch (error) {
        if (this.options.skipInvalid !== true) {
          throw error;
        }
        this.invalidEntry(entry, error);
      }
    }
    return records;
  }
}

/** Retry new/unpublished runs without retaining payloads or negative ownership facts. */
export function createAsyncRunDiscovery(
  asyncDirRoot: string,
  options: ReadonlyInput<AsyncRunDiscoveryOptions> = {},
): (() => AsyncRunRecord[]) & { readonly steps: () => Generator<void, AsyncRunRecord[]> } {
  const discovery = new AsyncRunDiscovery(asyncDirRoot, options);
  return Object.assign(() => runSynchronously(discovery.steps()), {
    steps: () => discovery.steps(),
  });
}

const STATE_RANK = { running: 0, queued: 1, failed: 2, blocked: 2, paused: 2, complete: 3 };

function summary(
  record: ReadonlyInput<AsyncRunRecord>,
  options: ReadonlyInput<AsyncRunListOptions>,
): AsyncRunSummary | undefined {
  const { asyncDir } = record.location;
  const { status } = record;
  if (!hasText(asyncDir) || !status) {
    return undefined;
  }
  const warnings: string[] = [];
  let children;
  try {
    const route = findNestedRouteForRootId(
      status.runId.length > 0 ? status.runId : path.basename(asyncDir),
    );
    if (route) {
      children = reconcileNestedAsyncDescendants(route, options);
    }
  } catch (error) {
    warnings.push(`Nested status unavailable: ${errorMessage(error)}`);
  }
  return asyncStatusToSummary(asyncDir, status, warnings, children);
}

function allowState(
  run: ReadonlyInput<AsyncRunSummary>,
  states: readonly AsyncRunSummary["state"][] | undefined,
): boolean {
  return states === undefined || states.includes(run.state);
}

export function listAsyncRuns(
  asyncDirRoot: string,
  options: ReadonlyInput<AsyncRunListOptions> = {},
): AsyncRunSummary[] {
  const runs: AsyncRunSummary[] = [];
  for (const record of options.records ?? createAsyncRunDiscovery(asyncDirRoot, options)()) {
    try {
      const run = summary(record, options);
      if (run && allowState(run, options.states)) {
        runs.push(run);
      }
    } catch (error) {
      if (options.skipInvalid !== true) {
        throw error;
      }
      console.error(
        `Skipping invalid async run '${record.location.resolvedId ?? "unknown"}':`,
        error,
      );
    }
  }
  runs.sort((a, b) => {
    const rank = STATE_RANK[a.state] - STATE_RANK[b.state];
    return rank !== 0
      ? rank
      : (b.lastUpdate ?? b.endedAt ?? b.startedAt) - (a.lastUpdate ?? a.endedAt ?? a.startedAt);
  });
  return options.limit === undefined ? runs : runs.slice(0, options.limit);
}
