import * as fs from "node:fs";
import * as path from "node:path";
import {
  HistoryIndexError,
  type HistoryOwner,
  type OwnedRun,
  type ReadonlyForegroundResumeRun,
  type Response,
  type HistoryIndexStatus,
  type HistoryResult,
  type HistoryEntryInput,
} from "./types.ts";
import { HistoryStore } from "./store.ts";
import { HistoryQueries } from "./queries.ts";
import { SourceIngest } from "./ingest.ts";
import { stamp } from "./source-file.ts";
import { SourceWatches } from "./source-watches.ts";
import { projectRun, compactView, unknownRun } from "./run-projection.ts";
import { number, text, nullableText } from "./rows.ts";
import { hasErrorCode } from "../shared/unknown.ts";
import { hasText } from "./text.ts";
import { selectCanonicalResult } from "./canonical-selection.ts";

interface Barrier {
  readonly id: number;
  readonly runId?: string;
}
/** Owns admitted snapshots, ordered background work, watch hints and refresh completion. */
export class HistoryWorker {
  private store?: HistoryStore;
  private queries?: HistoryQueries;
  private owner?: HistoryOwner;
  private readonly runs = new Map<string, OwnedRun>();
  private readonly foreground = new Map<string, ReadonlyForegroundResumeRun>();
  private readonly dirtyRuns = new Set<string>();
  private readonly dirtySources = new Map<string, boolean>();
  private readonly runErrors = new Set<string>();
  private readonly barriers: Barrier[] = [];
  private readonly controls: number[] = [];
  private readonly watches: SourceWatches;
  private job?: SourceIngest;
  private activeSource?: string;
  private scheduled = false;
  private closed = false;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private readonly censusTimer: ReturnType<typeof setInterval>;
  private readonly agentDir: string;
  private readonly send: (response: Response) => void;
  constructor(agentDir: string, send: (response: Response) => void) {
    this.agentDir = agentDir;
    this.send = send;
    this.watches = new SourceWatches(agentDir, {
      run: (id) => {
        this.dirtyRuns.add(id);
      },
      source: (id) => {
        this.sourceHint(id);
      },
      schedule: () => {
        this.schedule();
      },
    });
    this.censusTimer = setInterval(() => {
      this.census();
    }, 30_000);
    this.censusTimer.unref();
  }
  private changed(): void {
    this.send({ changed: true });
  }
  errorReply(id: number, error: unknown): void {
    this.send({
      id,
      error: {
        code: error instanceof HistoryIndexError ? error.code : "UNAVAILABLE",
        message:
          error instanceof HistoryIndexError
            ? error.message
            : "History index operation failed; authoritative files were not substituted for query results.",
      },
    });
  }
  requireQueries(): HistoryQueries {
    if (!this.queries) {
      throw new HistoryIndexError("NO_OWNER", "Set genuine restored ownership first.");
    }
    return this.queries;
  }
  private requireStore(): HistoryStore {
    if (!this.store) {
      throw new HistoryIndexError("NO_OWNER", "Set genuine restored ownership first.");
    }
    return this.store;
  }
  private projection(run: OwnedRun): ReturnType<typeof projectRun> {
    if (!this.owner) {
      throw new HistoryIndexError("NO_OWNER", "Set genuine restored ownership first.");
    }
    return projectRun(run, this.owner.ownerSessionId, this.runs, this.foreground);
  }
  private sourceHint(id: string): void {
    if (!this.dirtySources.has(id) && this.job?.id !== id && this.sourceUnchanged(id)) {
      return;
    }
    this.dirtySources.set(id, this.dirtySources.get(id) ?? false);
  }
  private sourceUnchanged(id: string): boolean {
    try {
      const source = this.store?.source(id);
      return (
        source !== undefined &&
        source.stamp !== null &&
        ["current", "partial", "degraded"].includes(source.state) &&
        source.stamp === stamp(fs.statSync(source.path, { bigint: true }))
      );
    } catch {
      // Missing/unreadable sources still need reconciliation.
      return false;
    }
  }
  private installWatches(runId?: string): void {
    const store = this.requireStore();
    const sources = store
      .all(
        `SELECT id,path FROM sources WHERE id IN (SELECT source_id FROM children${runId !== undefined ? " WHERE run_id=?" : ""})`,
        ...(runId === undefined ? [] : [runId]),
      )
      .map((row) => ({ id: text(row, "id"), path: text(row, "path") }));
    this.watches.install(runId === undefined ? [...this.runs.keys()] : [runId], sources);
  }
  private prune(previousSources?: readonly string[]): void {
    if (previousSources?.length === 0) {
      return;
    }
    const store = this.requireStore();
    store.transaction(() => {
      let removed = false;
      if (previousSources === undefined) {
        for (const row of store.all("SELECT id FROM runs")) {
          const id = text(row, "id");
          if (!this.runs.has(id)) {
            store.run("DELETE FROM runs WHERE id=?", id);
            removed = true;
          }
        }
      }
      for (const source of store.all(
        `SELECT id,path FROM sources WHERE id NOT IN (SELECT source_id FROM children WHERE source_id IS NOT NULL)${previousSources ? ` AND id IN (${previousSources.map(() => "?").join(",")})` : ""}`,
        ...(previousSources ?? []),
      )) {
        const id = text(source, "id");
        if (this.job?.id === id) {
          this.job.close();
          this.job = undefined;
        }
        this.dirtySources.delete(id);
        this.watches.forget({ id, path: text(source, "path") });
        store.deleteDocuments(id);
        store.run("DELETE FROM entries WHERE source_id=?", id);
        store.run("DELETE FROM sources WHERE id=?", id);
        removed = true;
      }
      if (removed) {
        store.bump();
      }
    });
  }
  private admit(run: OwnedRun): void {
    if (!this.owner || run.ownerSessionId !== this.owner.ownerSessionId) {
      throw new HistoryIndexError("OWNERSHIP", "Run is not owned by this session.");
    }
    if (
      !/^[a-zA-Z0-9_-]+$/.test(run.runId) ||
      run.children.some((child) => !Number.isSafeInteger(child.index) || child.index < 0) ||
      new Set(run.children.map((child) => child.index)).size !== run.children.length ||
      !Number.isSafeInteger(run.startedAt) ||
      run.startedAt < 0
    ) {
      throw new HistoryIndexError("INVALID", "Invalid run/child identity or timestamp.");
    }
    this.runs.set(run.runId, run);
    this.dirtyRuns.add(run.runId);
    const store = this.requireStore();
    if (!store.get("SELECT id FROM runs WHERE id=?", run.runId)) {
      const view = unknownRun(run);
      store.putView(compactView(view), view);
    }
  }
  private pending(runId?: string): boolean {
    if (runId === undefined || runId.length === 0) {
      return this.dirtyRuns.size > 0 || this.dirtySources.size > 0 || this.job !== undefined;
    }
    if (this.dirtyRuns.has(runId)) {
      return true;
    }
    return this.requireStore()
      .all("SELECT source_id FROM children WHERE run_id=?", runId)
      .some((row) => {
        const id = nullableText(row, "source_id");
        return id !== null && (this.dirtySources.has(id) || this.job?.id === id);
      });
  }
  private replyControls(id: number): void {
    this.send({
      id,
      value:
        this.requireStore().get("SELECT id FROM runs WHERE attention<4 OR state='live' LIMIT 1") !==
        undefined,
    });
  }
  private finishBarriers(): void {
    if (this.dirtyRuns.size === 0) {
      for (const id of this.controls.splice(0)) {
        this.replyControls(id);
      }
    }
    for (let index = this.barriers.length - 1; index >= 0; index--) {
      const barrier = this.barriers.at(index);
      if (!barrier || this.pending(barrier.runId)) {
        continue;
      }
      this.barriers.splice(index, 1);
      const store = this.requireStore();
      const failures =
        barrier.runId === undefined
          ? store.require(
              "SELECT COUNT(*) AS count FROM sources WHERE state IN ('error','missing','degraded')",
            )
          : store.require(
              "SELECT COUNT(*) AS count FROM sources s JOIN children c ON c.source_id=s.id WHERE c.run_id=? AND s.state IN ('error','missing','degraded')",
              barrier.runId,
            );
      const runFailure =
        barrier.runId === undefined ? this.runErrors.size > 0 : this.runErrors.has(barrier.runId);
      if (number(failures, "count") > 0 || runFailure) {
        this.errorReply(
          barrier.id,
          new HistoryIndexError(
            "DEGRADED",
            "Refresh completed with missing, malformed, or unavailable owned sources; inspect page freshness.",
          ),
        );
      } else {
        this.send({ id: barrier.id });
      }
    }
  }
  private schedule(): void {
    if (this.scheduled || this.closed || this.retryTimer) {
      return;
    }
    this.scheduled = true;
    setImmediate(() => {
      this.pump();
    });
  }
  private projectNext(): void {
    const id = this.dirtyRuns.values().next().value;
    if (id === undefined) {
      return;
    }
    this.dirtyRuns.delete(id);
    const run = this.runs.get(id);
    if (!run) {
      return;
    }
    const store = this.requireStore();
    this.installWatches(id);
    const previous = store
      .all("SELECT source_id FROM children WHERE run_id=? AND source_id IS NOT NULL", id)
      .map((row) => text(row, "source_id"));
    try {
      store.count("runProjections");
      const view = this.projection(run);
      store.putView(compactView(view), view);
      this.runErrors.delete(id);
    } catch {
      const view = unknownRun(
        run,
        "Canonical owner summary is unavailable. Completion remains unconfirmed.",
      );
      store.putView(compactView(view), view);
      this.runErrors.add(id);
    }
    this.prune(previous);
    for (const child of store.all(
      "SELECT source_id FROM children WHERE run_id=? AND source_id IS NOT NULL",
      id,
    )) {
      const sourceId = text(child, "source_id");
      if (sourceId !== this.job?.id) {
        this.dirtySources.set(sourceId, this.dirtySources.get(sourceId) ?? false);
      }
    }
    this.installWatches(id);
    this.changed();
  }
  private ingestNext(): void {
    if (this.job) {
      if (this.job.step()) {
        const source = this.requireStore().source(this.job.id);
        if (source) {
          this.watches.sourceDirectory(path.dirname(source.path));
        }
        this.job = undefined;
        this.changed();
      }
      return;
    }
    const next = this.dirtySources.entries().next().value;
    if (next) {
      const [id, force] = next;
      this.dirtySources.delete(id);
      const source = this.requireStore().source(id);
      if (source) {
        this.activeSource = id;
        this.job = new SourceIngest(this.requireStore(), source, force);
      }
    }
  }
  private ingestFailure(error: unknown): void {
    const id = this.job?.id ?? this.activeSource;
    this.job?.close();
    this.job = undefined;
    const store = this.requireStore();
    if (id !== undefined && store.source(id)) {
      this.recoverSource(id, error);
    }
    if (!(error instanceof HistoryIndexError && error.code === "INDEX_BUSY")) {
      this.changed();
    }
  }
  private recoverSource(id: string, error: unknown): void {
    if (error instanceof HistoryIndexError && error.code === "INDEX_BUSY") {
      this.dirtySources.set(id, true);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        this.schedule();
      }, 50);
    } else if (error instanceof HistoryIndexError && error.code === "SOURCE_CHANGED") {
      this.dirtySources.set(id, true);
    } else if (hasErrorCode(error, "ENOENT")) {
      this.requireStore().resetSource(id, "missing", "Linked native conversation is missing.");
    } else {
      this.requireStore().run(
        "UPDATE sources SET state='error',error=?,checked_at=? WHERE id=?",
        "Linked native conversation could not be indexed.",
        Date.now(),
        id,
      );
    }
  }
  private pump(): void {
    this.scheduled = false;
    if (this.closed || !this.store) {
      return;
    }
    try {
      if (this.dirtyRuns.size > 0) {
        this.projectNext();
      } else {
        this.ingestNext();
      }
    } catch (error) {
      this.ingestFailure(error);
    }
    this.activeSource = undefined;
    this.finishBarriers();
    if (this.pending()) {
      this.schedule();
    }
  }
  private census(): void {
    if (!this.owner || !this.store) {
      return;
    }
    for (const id of this.runs.keys()) {
      this.dirtyRuns.add(id);
    }
    for (const source of this.store.all(
      "SELECT id FROM sources WHERE id IN (SELECT source_id FROM children)",
    )) {
      this.dirtySources.set(text(source, "id"), false);
    }
    this.installWatches();
    this.schedule();
  }
  private pendingCount(): number {
    return this.dirtyRuns.size + this.dirtySources.size + (this.job ? 1 : 0);
  }
  setOwner(owner: HistoryOwner): void {
    this.clear();
    this.owner = owner;
    fs.mkdirSync(this.agentDir, { recursive: true, mode: 0o700 });
    const store = new HistoryStore(this.agentDir, owner.ownerSessionId);
    this.store = store;
    for (const run of owner.runs) {
      this.admit(run);
    }
    for (const fg of owner.foregroundRuns ?? []) {
      if (!this.runs.has(fg.runId)) {
        throw new HistoryIndexError(
          "OWNERSHIP",
          "Foreground snapshot is not an admitted owned run.",
        );
      }
      this.foreground.set(fg.runId, fg);
    }
    this.prune();
    this.queries = new HistoryQueries(store, () =>
      store.info(this.pendingCount(), this.runErrors.size),
    );
    for (const source of this.store.all(
      "SELECT id FROM sources WHERE id IN (SELECT source_id FROM children)",
    )) {
      this.dirtySources.set(text(source, "id"), true);
    }
    this.installWatches();
    this.schedule();
  }
  updateRun(run: OwnedRun, foreground?: ReadonlyForegroundResumeRun): void {
    this.admit(run);
    if (foreground) {
      this.foreground.set(run.runId, foreground);
    }
    this.schedule();
  }
  refresh(id: number, runId?: string): void {
    const store = this.requireStore();
    if (hasText(runId) && !this.runs.has(runId)) {
      throw new HistoryIndexError("OWNERSHIP", "Run is not admitted by this owner.");
    }
    for (const current of hasText(runId) ? [runId] : this.runs.keys()) {
      this.dirtyRuns.add(current);
    }
    for (const child of store.all(
      `SELECT DISTINCT source_id FROM children WHERE source_id IS NOT NULL${hasText(runId) ? " AND run_id=?" : ""}`,
      ...(hasText(runId) ? [runId] : []),
    )) {
      this.dirtySources.set(text(child, "source_id"), true);
    }
    this.barriers.push({ id, runId });
    this.schedule();
  }
  needsControls(id: number): void {
    this.requireQueries();
    if (this.dirtyRuns.size > 0) {
      this.controls.push(id);
      this.schedule();
    } else {
      this.replyControls(id);
    }
  }
  status(): HistoryIndexStatus {
    return this.requireStore().status(this.pendingCount());
  }
  countQuery(): void {
    this.requireStore().count("queries");
  }
  result(input: Pick<HistoryEntryInput, "runId" | "index">): HistoryResult | null {
    const run = this.runs.get(input.runId);
    if (!run) {
      throw new HistoryIndexError("OWNERSHIP", "Run is not admitted by this owner.");
    }
    if (!Number.isSafeInteger(input.index) || input.index < 0) {
      throw new HistoryIndexError("INVALID", "Invalid child index.");
    }
    return selectCanonicalResult(this.projection(run), input.index, this.requireQueries());
  }
  private clear(): void {
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.job?.close();
    this.job = undefined;
    this.watches.close();
    this.dirtyRuns.clear();
    this.dirtySources.clear();
    this.runs.clear();
    this.foreground.clear();
    this.runErrors.clear();
    for (const id of this.controls.splice(0)) {
      this.errorReply(
        id,
        new HistoryIndexError("OWNER_CHANGED", "History owner changed during control discovery."),
      );
    }
    for (const barrier of this.barriers.splice(0)) {
      this.errorReply(
        barrier.id,
        new HistoryIndexError("OWNER_CHANGED", "History owner changed during refresh."),
      );
    }
    this.store?.close();
    this.store = undefined;
    this.queries = undefined;
  }
  close(): void {
    this.closed = true;
    clearInterval(this.censusTimer);
    this.clear();
  }
}
