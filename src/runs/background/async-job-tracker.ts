import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { renderWidget, widgetRenderKey } from "../../tui/render.ts";
import {
  type AsyncJobState,
  type SubagentState,
  POLL_INTERVAL_MS,
  RESULTS_DIR,
} from "../../shared/types.ts";
import type { ReadonlyInput } from "../../shared/types/inputs.ts";
import { readStatus } from "../../shared/utils.ts";
import { startedJob } from "./async-job-admission.ts";
import { reconcileAsyncRun } from "./stale-run-reconciler.ts";
import { findNestedRouteForRootId, hasLiveNestedDescendants } from "../shared/nested-events.ts";
import { asyncStatusToSummary, createAsyncRunDiscovery, listAsyncRuns } from "./async-status.ts";
import { isTuiContext } from "../../shared/ui-mode.ts";
import { exactAsyncRunLocation } from "./async-run-location.ts";
import type { AsyncRunRecord } from "./async-run-record.ts";
import type { AsyncRunSummary } from "./async-run-summary.ts";
import type { OwnedRunRestoration } from "../shared/run-records.ts";
import { AsyncJobProjection } from "./async-job-projection.ts";
import { errorCode, hasText, isRecord } from "./async-value.ts";
import { parseAsyncStartedEvent } from "./run-schemas.ts";

interface AsyncJobTrackerOptions {
  readonly render?: (ctx: ExtensionContext, jobs: ReadonlyInput<AsyncJobState[]>) => void;
}
interface AsyncJobTrackerHandle {
  readonly ensurePoller: () => void;
  readonly handleStarted: (data: unknown) => void;
  readonly handleComplete: (data: unknown) => void;
  readonly restoreJobs: (
    sessionId: string,
    ctx: ExtensionContext,
    restoration?: ReadonlyInput<OwnedRunRestoration>,
  ) => void;
  readonly resetJobs: (ctx?: ExtensionContext) => void;
}
function terminal(status: AsyncJobState["status"]): boolean {
  return (
    status === "complete" || status === "failed" || status === "blocked" || status === "paused"
  );
}
function completionState(data: Readonly<Record<string, unknown>>): AsyncJobState["status"] {
  if (data.state === "blocked" || data.state === "paused") {
    return data.state;
  }
  return data.success === true ? "complete" : "failed";
}

/** Owns job admission, restoration discovery, polling, and cleanup timers. */
class AsyncJobTracker {
  private readonly pi: ReadonlyInput<Pick<ExtensionAPI, "events">>;
  private readonly state: SubagentState;
  private readonly asyncDirRoot: string;
  private readonly options: ReadonlyInput<AsyncJobTrackerOptions>;
  private restoreDiscovery: (() => AsyncRunRecord[]) | undefined;
  private restoreBoundary = 0;
  private restoreDiscoveryDeadline = 0;

  constructor(
    pi: ReadonlyInput<Pick<ExtensionAPI, "events">>,
    state: SubagentState,
    asyncDirRoot: string,
    options: ReadonlyInput<AsyncJobTrackerOptions>,
  ) {
    this.pi = pi;
    this.state = state;
    this.asyncDirRoot = asyncDirRoot;
    this.options = options;
  }

  private rerender(ctx: ExtensionContext, jobs = Array.from(this.state.asyncJobs.values())): void {
    (this.options.render ?? renderWidget)(ctx, jobs);
    const ui: ExtensionContext["ui"] & { requestRender?: () => void } = ctx.ui;
    ui.requestRender?.();
  }

  private rerenderCurrent(): void {
    const ctx = this.state.lastUiContext;
    if (ctx && isTuiContext(ctx)) {
      this.rerender(ctx);
    }
  }
  private summarizeJob(
    job: ReadonlyInput<AsyncJobState>,
    status: ReadonlyInput<NonNullable<AsyncRunRecord["status"]>>,
  ): AsyncRunSummary {
    return asyncStatusToSummary(
      job.asyncDir,
      status,
      [],
      job.nestedRoute ? (job.nestedChildren ?? []) : undefined,
    );
  }

  private cancelCleanup(id: string): void {
    const timer = this.state.cleanupTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.state.cleanupTimers.delete(id);
    }
  }

  private scheduleCleanup(id: string): void {
    this.cancelCleanup(id);
    const timer = setTimeout(() => {
      this.state.cleanupTimers.delete(id);
      this.state.asyncJobs.delete(id);
      if (this.state.lastUiContext) {
        this.rerender(this.state.lastUiContext);
      }
    }, 10000);
    this.state.cleanupTimers.set(id, timer);
  }

  private refreshNested(id: string): boolean {
    const job = this.state.asyncJobs.get(id);
    if (!job) {
      return false;
    }
    try {
      new AsyncJobProjection(job, this.pi.events).refreshNested();
      return true;
    } catch (error) {
      console.error(`Failed to refresh nested async descendants for '${job.asyncDir}':`, error);
      return false;
    }
  }

  private refreshJob(
    id: string,
    restored: Readonly<ReadonlyMap<string | null, ReadonlyInput<AsyncRunRecord>>>,
  ): boolean {
    const job = this.state.asyncJobs.get(id);
    if (!job) {
      return false;
    }
    const before = widgetRenderKey(job);
    const projection = new AsyncJobProjection(job, this.pi.events);
    try {
      projection.emitNewControlEvents();
      const nestedReady = this.refreshNested(id);
      const reconciliation =
        restored.get(job.asyncDir) ??
        reconcileAsyncRun(job.asyncDir, {
          resultsDir: RESULTS_DIR,
          startedRun: {
            runId: job.asyncId,
            pid: job.pid,
            sessionId: job.sessionId,
            mode: job.mode,
            agents: job.agents,
            chainStepCount: job.chainStepCount,
            parallelGroups: job.parallelGroups,
            startedAt: job.startedAt,
            sessionFile: job.sessionFile,
          },
        });
      const status = reconciliation.status ?? readStatus(job.asyncDir);
      if (status) {
        const previous = job.status;
        projection.applySummary(this.summarizeJob(job, status));
        this.reconcileCleanup(id, previous, nestedReady);
      } else {
        projection.markRunning();
      }
    } catch (error) {
      if (job.status !== "failed") {
        console.error(`Failed to read async status for '${job.asyncDir}':`, error);
        projection.markFailed();
      }
      if (!hasLiveNestedDescendants(job.nestedChildren) && !this.state.cleanupTimers.has(id)) {
        this.scheduleCleanup(id);
      }
    }
    return widgetRenderKey(job) !== before;
  }

  private reconcileCleanup(
    id: string,
    previous: AsyncJobState["status"],
    nestedReady: boolean,
  ): void {
    const job = this.state.asyncJobs.get(id);
    if (!job) {
      return;
    }
    if (!terminal(job.status)) {
      this.cancelCleanup(id);
      return;
    }
    if (
      nestedReady &&
      !hasLiveNestedDescendants(job.nestedChildren) &&
      (previous !== job.status || !this.state.cleanupTimers.has(id))
    ) {
      this.scheduleCleanup(id);
    }
  }

  private discoverDuringPoll(): { readonly changed: boolean; readonly records: AsyncRunRecord[] } {
    let records: AsyncRunRecord[] = [];
    let changed = false;
    if (this.restoreDiscovery) {
      try {
        records = this.restoreDiscovery();
        changed = this.discoverRestoredJobs(records, true);
      } catch (error) {
        console.error("Failed to discover active async jobs:", error);
      }
      if (Date.now() >= this.restoreDiscoveryDeadline) {
        this.restoreDiscovery = undefined;
        this.restoreDiscoveryDeadline = 0;
      }
    }
    return { records, changed };
  }

  private poll(): void {
    const discovery = this.discoverDuringPoll();
    if (this.state.asyncJobs.size === 0) {
      if (this.restoreDiscovery) {
        return;
      }
      if (this.state.lastUiContext && isTuiContext(this.state.lastUiContext)) {
        this.rerender(this.state.lastUiContext, []);
      }
      if (this.state.poller) {
        clearInterval(this.state.poller);
        this.state.poller = null;
      }
      return;
    }
    const restored = new Map(discovery.records.map((record) => [record.location.asyncDir, record]));
    let changed = discovery.changed;
    for (const id of this.state.asyncJobs.keys()) {
      changed = this.refreshJob(id, restored) || changed;
    }
    if (changed) {
      this.rerenderCurrent();
    }
  }

  ensurePoller = (): void => {
    if (this.state.poller) {
      return;
    }
    this.state.poller = setInterval(() => {
      this.poll();
    }, POLL_INTERVAL_MS);
    this.state.poller.unref();
  };

  handleStarted = (data: unknown): void => {
    const info = parseAsyncStartedEvent(data);
    if (!hasText(info.id)) {
      return;
    }
    const now = Date.now();
    const asyncDir =
      info.asyncDir ??
      exactAsyncRunLocation(info.id, this.asyncDirRoot, RESULTS_DIR).asyncDir ??
      path.join(this.asyncDirRoot, info.id);
    this.state.asyncJobs.set(info.id, startedJob(info.id, info, asyncDir, now));
    this.ensurePoller();
    this.rerenderCurrent();
  };

  handleComplete = (data: unknown): void => {
    if (!isRecord(data) || typeof data.id !== "string" || data.id.length === 0) {
      return;
    }
    const job = this.state.asyncJobs.get(data.id);
    let nestedReady = true;
    if (job) {
      new AsyncJobProjection(job, this.pi.events).complete(
        completionState(data),
        typeof data.asyncDir === "string" ? data.asyncDir : undefined,
      );
      nestedReady = this.refreshNested(data.id);
    }
    this.rerenderCurrent();
    if (nestedReady && !hasLiveNestedDescendants(job?.nestedChildren)) {
      this.scheduleCleanup(data.id);
    }
  };

  private controlCursor(
    run: ReadonlyInput<AsyncRunSummary>,
    sinceBoundary: boolean,
  ): { readonly controlEventCursor: number; readonly controlEventSince?: number } {
    let cursor = 0;
    let since: number | undefined = sinceBoundary ? this.restoreBoundary : undefined;
    // Late publications use the original restoration cut, not an EOF observed after discovery.
    if (!sinceBoundary) {
      try {
        cursor = fs.statSync(path.join(run.asyncDir, "events.jsonl")).size;
      } catch (error) {
        if (errorCode(error) !== "ENOENT") {
          since = this.restoreBoundary;
          console.error(`Failed to inspect async control events for '${run.asyncDir}':`, error);
        }
      }
    }
    return { controlEventCursor: cursor, controlEventSince: since };
  }

  private restoredJob(run: ReadonlyInput<AsyncRunSummary>, sinceBoundary: boolean): AsyncJobState {
    const groups = run.parallelGroups ?? [];
    const current = run.currentStep;
    const active =
      current === undefined
        ? undefined
        : groups.find((group) => current >= group.start && current < group.start + group.count);
    const steps = active ? run.steps.slice(active.start, active.start + active.count) : run.steps;
    let nestedRoute;
    try {
      nestedRoute = findNestedRouteForRootId(run.id);
    } catch (error) {
      console.error(`Failed to restore nested async descendants for '${run.asyncDir}':`, error);
    }
    return {
      asyncId: run.id,
      asyncDir: run.asyncDir,
      status: run.state,
      pid: run.pid,
      sessionId: run.sessionId,
      activityState: run.activityState,
      lastActivityAt: run.lastActivityAt,
      currentTool: run.currentTool,
      currentToolStartedAt: run.currentToolStartedAt,
      currentPath: run.currentPath,
      turnCount: run.turnCount,
      toolCount: run.toolCount,
      mode: run.mode,
      agents: steps.map((step) => step.agent),
      currentStep: run.currentStep,
      chainStepCount: run.chainStepCount,
      parallelGroups: groups,
      steps: steps.map((step) => ({ ...step })),
      stepsTotal: steps.length,
      runningSteps: steps.filter((step) => step.status === "running").length,
      completedSteps: steps.filter(
        (step) => step.status === "complete" || step.status === "completed",
      ).length,
      activeParallelGroup: active !== undefined,
      startedAt: run.startedAt,
      updatedAt: run.lastUpdate ?? run.startedAt,
      totalTokens: run.totalTokens,
      sessionFile: run.sessionFile,
      ...this.controlCursor(run, sinceBoundary),
      nestedRoute,
      nestedChildren: run.nestedChildren,
    };
  }

  private discoverRestoredJobs(
    records: ReadonlyInput<AsyncRunRecord[]>,
    sinceBoundary: boolean,
  ): boolean {
    let changed = false;
    for (const run of listAsyncRuns(this.asyncDirRoot, {
      states: ["queued", "running"],
      records,
      resultsDir: RESULTS_DIR,
      skipInvalid: true,
    })) {
      if (this.state.asyncJobs.has(run.id)) {
        continue;
      }
      this.state.asyncJobs.set(run.id, this.restoredJob(run, sinceBoundary));
      changed = true;
    }
    return changed;
  }

  restoreJobs = (
    sessionId: string,
    ctx: ExtensionContext,
    restoration?: ReadonlyInput<OwnedRunRestoration>,
  ): void => {
    this.restoreBoundary = restoration?.startedAt ?? Date.now();
    this.restoreDiscovery =
      restoration?.discover ??
      createAsyncRunDiscovery(this.asyncDirRoot, {
        sessionId: ctx.sessionManager.getSessionFile() ?? sessionId,
        ownerSessionId: ctx.sessionManager.getSessionId(),
        resultsDir: RESULTS_DIR,
        skipInvalid: true,
      });
    this.restoreDiscoveryDeadline = this.restoreBoundary + 2_000;
    try {
      this.discoverRestoredJobs(
        restoration?.records ?? this.restoreDiscovery(),
        restoration !== undefined,
      );
    } catch (error) {
      console.error("Failed to discover active async jobs:", error);
    }
    if (isTuiContext(ctx)) {
      this.state.lastUiContext = ctx;
      this.rerender(ctx);
    }
    this.ensurePoller();
  };

  resetJobs = (ctx?: ExtensionContext): void => {
    this.restoreDiscovery = undefined;
    this.restoreBoundary = 0;
    this.restoreDiscoveryDeadline = 0;
    for (const timer of this.state.cleanupTimers.values()) {
      clearTimeout(timer);
    }
    this.state.cleanupTimers.clear();
    this.state.asyncJobs.clear();
    this.state.foregroundRuns?.clear();
    this.state.resultFileCoalescer.clear();
    if (ctx && isTuiContext(ctx)) {
      this.state.lastUiContext = ctx;
      this.rerender(ctx, []);
    }
  };
}

export function createAsyncJobTracker(
  pi: ReadonlyInput<Pick<ExtensionAPI, "events">>,
  state: SubagentState,
  asyncDirRoot: string,
  options: ReadonlyInput<AsyncJobTrackerOptions> = {},
): AsyncJobTrackerHandle {
  const tracker = new AsyncJobTracker(pi, state, asyncDirRoot, options);
  return {
    ensurePoller: tracker.ensurePoller,
    handleStarted: tracker.handleStarted,
    handleComplete: tracker.handleComplete,
    restoreJobs: tracker.restoreJobs,
    resetJobs: tracker.resetJobs,
  };
}
