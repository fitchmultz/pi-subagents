import * as fs from "node:fs";
import * as path from "node:path";
import { setImmediate as yieldToInput } from "node:timers/promises";
import { getRunMetadataDir } from "../shared/supervisor-questions.ts";
import { buildCompletionKey, markSeenWithTtl } from "./completion-dedupe.ts";
import { createFileCoalescer } from "../../shared/file-coalescer.ts";
import { journalStamp } from "../../shared/journal-reader.ts";
import {
  SUBAGENT_ASYNC_COMPLETE_EVENT,
  type IntercomEventBus,
  type SubagentState,
  type OwnedRun,
} from "../../shared/types.ts";
import type { ReadonlyInput } from "../../shared/types/inputs.ts";
import {
  completionEvent,
  deliverResultIntercom,
  prepareResult,
  readResultEnvelope,
  type ResultEnvelope,
  type PreparedResult,
} from "./result-payload.ts";
import { errorCode, hasText } from "./async-value.ts";

const RESTART_DELAY_MS = 3000;
const POLL_INTERVAL_MS = 3000;
interface ResultWatcherDeps {
  readonly reconcileDelivery?: (
    runId: string,
    completionKey: string,
    accounting?: boolean,
  ) => boolean;
  readonly isCompletionPublished?: (runId: string, completionKey: string) => boolean;
  readonly withReceiptBatch?: (work: () => void) => void;
}
interface StopOptions {
  readonly preservePending?: boolean;
  readonly joinInFlight?: boolean;
}
interface ResultWatcherHandle {
  readonly startResultWatcher: () => void;
  readonly primeExistingResults: () => void;
  readonly stopResultWatcher: (options?: StopOptions) => void;
  readonly joinInFlight: () => Promise<void>;
}
interface ForeignResult {
  readonly stamp: string;
  readonly sessionId: string | null;
  readonly runId: string;
  readonly ownerSessionId?: string;
  readonly canonicalPath?: string;
  readonly canonicalStamp?: string;
}
function notFound(error: unknown): boolean {
  return (
    errorCode(error) === "ENOENT" ||
    errorCode(error instanceof Error ? error.cause : undefined) === "ENOENT"
  );
}
function pollingRequired(error: unknown): boolean {
  const code = errorCode(error);
  return code === "EMFILE" || code === "ENOSPC";
}

/** Owns admitted background deliveries, watcher resources, and shutdown generations. */
class ResultWatcher {
  private readonly pi: ReadonlyInput<{ events: IntercomEventBus }>;
  private readonly state: SubagentState;
  private readonly resultsDir: string;
  private readonly deps: ResultWatcherDeps;
  private periodicScanTimer: ReturnType<typeof setInterval> | null = null;
  private readonly processingCompletionKeys = new Set<string>();
  private readonly inFlight = new Set<Promise<void>>();
  private startTail = Promise.resolve();
  private generation = 0;
  private preserveBeforeGeneration = 0;
  private joiningGeneration: number | undefined;
  private readonly foreignResults = new Map<string, ForeignResult>();
  private readonly scheduled = new Set<string>();
  private drainGeneration: number | undefined;

  constructor(
    pi: ReadonlyInput<{ events: IntercomEventBus }>,
    state: SubagentState,
    resultsDir: string,
    deps: ResultWatcherDeps,
  ) {
    this.pi = pi;
    this.state = state;
    this.resultsDir = resultsDir;
    this.deps = deps;
    this.state.resultFileCoalescer = createFileCoalescer(this.scheduleResult, 50);
  }

  private isForeignUnchanged(resultPath: string): boolean {
    const cached = this.foreignResults.get(resultPath);
    if (
      !cached ||
      cached.sessionId !== this.state.currentSessionId ||
      cached.ownerSessionId !== this.state.ownedRuns?.get(cached.runId)?.ownerSessionId
    ) {
      return false;
    }
    return (
      cached.stamp === journalStamp(fs.statSync(resultPath, { bigint: true })) &&
      (cached.canonicalPath === undefined ||
        cached.canonicalStamp === journalStamp(fs.statSync(cached.canonicalPath, { bigint: true })))
    );
  }

  private resultPath(file: string): string {
    return path.isAbsolute(file) ? file : path.join(this.resultsDir, file);
  }
  private needsRecovery(run: ReadonlyInput<OwnedRun>): boolean {
    return (
      run.source === "async" &&
      (run.accounting?.state === "incomplete" || !hasText(run.delivery?.entryId))
    );
  }

  private candidateFiles(): string[] {
    const files = fs.existsSync(this.resultsDir)
      ? fs.readdirSync(this.resultsDir).filter((name) => name.endsWith(".json"))
      : [];
    const notified = new Map(files.map((file, index) => [file, index]));
    for (const run of this.state.ownedRuns?.values() ?? []) {
      if (!this.needsRecovery(run)) {
        continue;
      }
      const file = path.join(getRunMetadataDir(run.runId), "result.json");
      if (!fs.existsSync(file)) {
        continue;
      }
      // Disposable hints cannot veto canonical recovery, including corrupt hints.
      const notification = notified.get(`${run.runId}.json`);
      if (notification === undefined) {
        files.push(file);
      } else {
        files[notification] = file;
      }
    }
    return files;
  }

  private pendingResultFiles(): string[] {
    const files = this.candidateFiles();
    const present = new Set(files.map((file) => this.resultPath(file)));
    for (const file of this.foreignResults.keys()) {
      if (!present.has(file)) {
        this.foreignResults.delete(file);
      }
    }
    return files.filter((file) => {
      const resultPath = this.resultPath(file);
      try {
        return !this.isForeignUnchanged(resultPath);
      } catch (error) {
        if (notFound(error)) {
          this.foreignResults.delete(resultPath);
          return false;
        }
        return true;
      }
    });
  }

  private foreign(envelope: ReadonlyInput<ResultEnvelope>): boolean {
    const run = this.state.ownedRuns?.get(envelope.runId);
    const sessionId = envelope.data.sessionId;
    const foreign = hasText(sessionId)
      ? sessionId !== this.state.currentSessionId &&
        run?.ownerSessionId !== this.state.currentSessionId
      : run === undefined;
    if (foreign) {
      this.foreignResults.set(envelope.resultPath, {
        stamp: envelope.stamp,
        sessionId: this.state.currentSessionId,
        runId: envelope.runId,
        ownerSessionId: run?.ownerSessionId,
        canonicalPath: envelope.canonicalPath,
        canonicalStamp: envelope.canonicalStamp,
      });
    } else {
      this.foreignResults.delete(envelope.resultPath);
    }
    return foreign;
  }

  private consumeNotification(envelope: ReadonlyInput<ResultEnvelope>, key: string): void {
    // Native queue admission is not publication. Retain the only legacy saved result until publication.
    if (
      !envelope.durableFile &&
      envelope.canonicalPath === undefined &&
      this.deps.isCompletionPublished !== undefined &&
      !this.deps.isCompletionPublished(envelope.runId, key)
    ) {
      return;
    }
    const hint = envelope.durableFile
      ? path.join(this.resultsDir, `${envelope.runId}.json`)
      : envelope.resultPath;
    if (fs.existsSync(hint)) {
      fs.unlinkSync(hint);
    }
  }

  private alreadyHandled(envelope: ReadonlyInput<ResultEnvelope>, key: string): boolean {
    const handled =
      this.deps.reconcileDelivery === undefined
        ? this.state.isRunResultConsumed?.(envelope.runId) === true
        : this.deps.reconcileDelivery(envelope.runId, key);
    if (handled) {
      this.consumeNotification(envelope, key);
      return true;
    }
    if (this.state.waitingRuns?.has(envelope.runId) === true) {
      this.pi.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
        ...envelope.data,
        runId: envelope.runId,
        suppressNotification: true,
        intercomResultDelivered: false,
      });
      return true;
    }
    return false;
  }

  private claimCompletion(envelope: ReadonlyInput<ResultEnvelope>, key: string): boolean {
    if (this.processingCompletionKeys.has(key)) {
      return false;
    }
    // Owned queue/receipt reconciliation remains authoritative after TTL expiry.
    if (markSeenWithTtl(this.state.completionSeen, key, Date.now(), 10 * 60 * 1000)) {
      this.consumeNotification(envelope, key);
      return false;
    }
    this.processingCompletionKeys.add(key);
    return true;
  }

  private async deliverClaimed(
    envelope: ReadonlyInput<ResultEnvelope>,
    prepared: ReadonlyInput<PreparedResult>,
    key: string,
    ownership: { readonly generation: number; readonly sessionId: string | null },
  ): Promise<boolean> {
    const delivered = await deliverResultIntercom(this.pi.events, envelope, prepared);
    // Stop/session callbacks may change generation and owner during suspension.
    if (
      (ownership.generation !== this.generation &&
        ownership.generation !== this.joiningGeneration) ||
      ownership.sessionId !== this.state.currentSessionId
    ) {
      this.state.completionSeen.delete(key);
      return false;
    }
    // Shutdown closes native turn ingress; accepted acknowledgements are still recorded.
    if (!delivered && ownership.generation < this.preserveBeforeGeneration) {
      return false;
    }
    this.pi.events.emit(
      SUBAGENT_ASYNC_COMPLETE_EVENT,
      completionEvent(envelope, prepared, key, delivered),
    );
    return true;
  }

  private releaseCompletion(key: string | undefined, emitted: boolean): void {
    if (!hasText(key)) {
      return;
    }
    this.processingCompletionKeys.delete(key);
    if (!emitted) {
      this.state.completionSeen.delete(key);
    }
  }

  private readonly handleResult = async (file: string): Promise<void> => {
    const startedGeneration = this.generation;
    const ownerSessionId = this.state.currentSessionId;
    let claimed: string | undefined;
    let emitted = false;
    const resultPath = this.resultPath(file);
    if (!fs.existsSync(resultPath)) {
      return;
    }
    try {
      if (this.isForeignUnchanged(resultPath)) {
        return;
      }
      const envelope = readResultEnvelope(file, this.resultsDir);
      if (this.foreign(envelope)) {
        return;
      }
      const key = buildCompletionKey({ ...envelope.data, id: envelope.runId }, "result");
      if (this.alreadyHandled(envelope, key)) {
        return;
      }
      const prepared = prepareResult(envelope);
      if (prepared === undefined) {
        return;
      }
      if (!this.claimCompletion(envelope, key)) {
        return;
      }
      claimed = key;
      emitted = await this.deliverClaimed(envelope, prepared, key, {
        generation: startedGeneration,
        sessionId: ownerSessionId,
      });
      if (emitted) {
        this.consumeNotification(envelope, key);
      }
    } catch (error) {
      if (!notFound(error)) {
        console.error(`Failed to process subagent result file '${resultPath}':`, error);
      }
    } finally {
      this.releaseCompletion(claimed, emitted);
    }
  };

  private startBatch(files: readonly string[], generation: number): void {
    for (const file of files) {
      if (generation !== this.generation) {
        return;
      }
      const tail = this.handleResult(file)
        .catch((error: unknown) => {
          console.error(`Subagent delivery failed for '${file}':`, error);
        })
        .finally(() => {
          this.inFlight.delete(tail);
        });
      this.inFlight.add(tail);
    }
  }

  private async drain(generation: number): Promise<void> {
    try {
      while (this.scheduled.size > 0) {
        // Batches yield to native input; later starts depend on this generation guard.
        // oxlint-disable-next-line no-await-in-loop
        await yieldToInput();
        if (generation !== this.generation) {
          return;
        }
        const files = [...this.scheduled].slice(0, 4);
        for (const file of files) {
          this.scheduled.delete(file);
        }
        const start = (): void => {
          this.startBatch(files, generation);
        };
        if (this.deps.withReceiptBatch) {
          this.deps.withReceiptBatch(start);
        } else {
          start();
        }
      }
    } finally {
      if (this.drainGeneration === generation) {
        this.drainGeneration = undefined;
      }
    }
  }

  private readonly scheduleResult = (file: string): void => {
    this.scheduled.add(file);
    if (this.drainGeneration === this.generation) {
      return;
    }
    this.drainGeneration = this.generation;
    const generation = this.generation;
    this.startTail = this.startTail
      .then(() => this.drain(generation))
      .catch((error: unknown) => {
        console.error("Failed to drain admitted subagent results:", error);
      });
  };

  primeExistingResults = (): void => {
    try {
      this.pendingResultFiles().forEach(this.scheduleResult);
    } catch (error) {
      if (!notFound(error)) {
        console.error(`Failed to scan subagent result directory '${this.resultsDir}':`, error);
      }
    }
  };

  private ensurePeriodicScan(): void {
    if (this.periodicScanTimer) {
      return;
    }
    this.periodicScanTimer = setInterval(this.primeExistingResults, POLL_INTERVAL_MS);
    this.periodicScanTimer.unref();
  }
  private clearPeriodicScan(): void {
    if (this.periodicScanTimer) {
      clearInterval(this.periodicScanTimer);
      this.periodicScanTimer = null;
    }
  }
  private startPollingFallback(reason: unknown): void {
    this.state.watcher?.close();
    this.state.watcher = null;
    this.clearPeriodicScan();
    if (this.state.watcherRestartTimer) {
      return;
    }
    console.error(
      `Subagent result watcher for '${this.resultsDir}' fell back to polling because native fs.watch is unavailable (${errorCode(reason) ?? "unknown error"}).`,
    );
    this.primeExistingResults();
    this.state.watcherRestartTimer = setInterval(this.primeExistingResults, POLL_INTERVAL_MS);
    this.state.watcherRestartTimer.unref();
  }
  private scheduleRestart(): void {
    if (this.state.watcherRestartTimer) {
      return;
    }
    this.state.watcherRestartTimer = setTimeout(() => {
      this.state.watcherRestartTimer = null;
      try {
        fs.mkdirSync(this.resultsDir, { recursive: true });
        this.startResultWatcher();
      } catch (error) {
        if (pollingRequired(error)) {
          this.startPollingFallback(error);
          return;
        }
        console.error(`Failed to restart subagent result watcher for '${this.resultsDir}':`, error);
        this.scheduleRestart();
      }
    }, RESTART_DELAY_MS);
    this.state.watcherRestartTimer.unref();
  }

  startResultWatcher = (): void => {
    if (this.state.watcher) {
      this.ensurePeriodicScan();
      return;
    }
    if (this.state.watcherRestartTimer) {
      clearTimeout(this.state.watcherRestartTimer);
      clearInterval(this.state.watcherRestartTimer);
      this.state.watcherRestartTimer = null;
    }
    try {
      this.state.watcher = fs.watch(this.resultsDir, (event, file) => {
        if (event !== "rename" || !hasText(file)) {
          return;
        }
        if (file.endsWith(".json") && fs.existsSync(path.join(this.resultsDir, file))) {
          this.state.resultFileCoalescer.schedule(file);
        }
      });
      this.state.watcher.on("error", (error) => {
        if (pollingRequired(error)) {
          this.startPollingFallback(error);
          return;
        }
        console.error(`Subagent result watcher failed for '${this.resultsDir}':`, error);
        this.state.watcher?.close();
        this.state.watcher = null;
        this.scheduleRestart();
      });
      this.state.watcher.unref();
      this.ensurePeriodicScan();
    } catch (error) {
      if (pollingRequired(error)) {
        this.startPollingFallback(error);
        return;
      }
      console.error(`Failed to start subagent result watcher for '${this.resultsDir}':`, error);
      this.state.watcher = null;
      this.scheduleRestart();
    }
  };

  stopResultWatcher = (options: StopOptions = {}): void => {
    this.joiningGeneration = options.joinInFlight === true ? this.generation : undefined;
    this.generation++;
    if (options.preservePending === true) {
      this.preserveBeforeGeneration = this.generation;
    }
    this.state.watcher?.close();
    this.state.watcher = null;
    this.clearPeriodicScan();
    if (this.state.watcherRestartTimer) {
      clearTimeout(this.state.watcherRestartTimer);
      clearInterval(this.state.watcherRestartTimer);
    }
    this.state.watcherRestartTimer = null;
    this.state.resultFileCoalescer.clear();
    this.scheduled.clear();
    this.foreignResults.clear();
  };
  joinInFlight = async (): Promise<void> => {
    await this.startTail;
    await Promise.all(this.inFlight);
    this.joiningGeneration = undefined;
  };
}

export function createResultWatcher(
  pi: ReadonlyInput<{ events: IntercomEventBus }>,
  state: SubagentState,
  resultsDir: string,
  deps: ResultWatcherDeps = {},
): ResultWatcherHandle {
  const watcher = new ResultWatcher(pi, state, resultsDir, deps);
  return {
    startResultWatcher: watcher.startResultWatcher,
    primeExistingResults: watcher.primeExistingResults,
    stopResultWatcher: watcher.stopResultWatcher,
    joinInFlight: watcher.joinInFlight,
  };
}
