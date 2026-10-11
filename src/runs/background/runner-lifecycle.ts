import * as path from "node:path";
import type { ReadonlyDeep } from "type-fest";
import { appendJsonl } from "../../shared/artifacts.ts";
import { readAsyncControlRequests } from "./async-control.ts";
import type { SubagentRunConfig } from "./runner-contract.ts";
import type { RunnerMonitor } from "./runner-monitor.ts";
import type { RunnerStatusPayload } from "./runner-status.ts";

const INTERRUPT_SIGNAL: NodeJS.Signals = "SIGUSR2";
const CANCEL_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

/** Owns process-level cancellation, child interrupts, deadline and control-inbox timers. */
export class RunnerLifecycle {
  readonly cancellation = new AbortController();
  readonly interruption = new AbortController();
  interrupted = false;
  private readonly activeChildren = new Map<number, () => void>();
  private readonly config: ReadonlyDeep<SubagentRunConfig>;
  private readonly status: RunnerStatusPayload;
  private readonly monitor: RunnerMonitor;
  private deadlineTimer: NodeJS.Timeout | undefined;
  private activityTimer: NodeJS.Timeout | undefined;
  private requestTimer: NodeJS.Timeout | undefined;
  private readonly cancel = (): void => {
    this.cancellation.abort();
  };

  constructor(
    config: ReadonlyDeep<SubagentRunConfig>,
    status: RunnerStatusPayload,
    monitor: RunnerMonitor,
  ) {
    this.config = config;
    this.status = status;
    this.monitor = monitor;
  }

  start(startedAt: number): void {
    for (const signal of CANCEL_SIGNALS) {
      process.on(signal, this.cancel);
    }
    process.on(INTERRUPT_SIGNAL, this.interrupt);
    this.status.timeoutAt =
      this.config.timeoutMs === undefined ? undefined : startedAt + this.config.timeoutMs;
    this.scheduleDeadline();
    this.monitor.writeStatusPayload();
    if (this.config.controlConfig?.enabled ?? true) {
      this.activityTimer = setInterval(() => {
        if (this.status.state === "running") {
          this.monitor.updateRunnerActivityState(Date.now());
        }
      }, 1000);
      this.activityTimer.unref();
    }
    this.requestTimer = setInterval(() => {
      this.readRequests();
    }, 100);
    this.requestTimer.unref();
  }

  register(index: number, interrupt: (() => void) | undefined): void {
    if (interrupt) {
      this.activeChildren.set(index, interrupt);
    } else {
      this.activeChildren.delete(index);
    }
  }

  private scheduleDeadline(): void {
    clearTimeout(this.deadlineTimer);
    const timeoutAt = this.status.timeoutAt;
    if (timeoutAt === undefined || this.cancellation.signal.aborted) {
      return;
    }
    const expire = (): void => {
      this.status.timedOut = true;
      this.status.error = `Timed out after ${timeoutAt - this.status.startedAt}ms.`;
      this.cancellation.abort(new DOMException(this.status.error, "TimeoutError"));
      this.monitor.writeStatusPayload();
    };
    const remaining = timeoutAt - Date.now();
    if (remaining <= 0) {
      expire();
    } else {
      this.deadlineTimer = setTimeout(expire, remaining);
      this.deadlineTimer.unref();
    }
  }

  private readonly interrupt = (): void => {
    if (this.interrupted || this.status.state !== "running") {
      return;
    }
    this.interrupted = true;
    this.interruption.abort();
    this.status.activityState = undefined;
    this.status.lastUpdate = Date.now();
    this.monitor.writeStatusPayload();
    this.append({
      type: "subagent.run.stop-requested",
      ts: this.status.lastUpdate,
      runId: this.config.id,
    });
    for (const interrupt of this.activeChildren.values()) {
      interrupt();
    }
  };

  private readRequests(): void {
    for (const request of readAsyncControlRequests(this.config.asyncDir, this.config.id)) {
      switch (request.action) {
        case "extend":
          if (
            this.status.timeoutAt === undefined ||
            this.cancellation.signal.aborted ||
            this.interrupted ||
            request.extendMs === undefined
          ) {
            break;
          }
          this.status.timeoutAt = Math.max(this.status.timeoutAt, Date.now()) + request.extendMs;
          this.scheduleDeadline();
          this.monitor.writeStatusPayload();
          this.append({
            type: "subagent.run.extended",
            requestId: request.requestId,
            runId: this.config.id,
            ts: Date.now(),
            timeoutAt: this.status.timeoutAt,
          });
          break;
        case "cancel":
          this.cancellation.abort();
          break;
        case "interrupt":
          if (request.index === undefined) {
            this.interrupt();
          } else {
            this.activeChildren.get(request.index)?.();
          }
          break;
      }
    }
  }

  private append(event: Readonly<Record<string, string | number>>): void {
    appendJsonl(path.join(this.config.asyncDir, "events.jsonl"), JSON.stringify(event));
  }

  dispose(): void {
    clearTimeout(this.deadlineTimer);
    clearInterval(this.activityTimer);
    clearInterval(this.requestTimer);
    process.off(INTERRUPT_SIGNAL, this.interrupt);
    for (const signal of CANCEL_SIGNALS) {
      process.off(signal, this.cancel);
    }
  }
}
