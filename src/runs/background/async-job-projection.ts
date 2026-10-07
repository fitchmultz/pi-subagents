import * as fs from "node:fs";
import * as path from "node:path";
import { scanJournal } from "../../shared/journal-reader.ts";
import { formatControlNoticeMessage, isObsoleteIdleNotice } from "../shared/subagent-control.ts";
import {
  RESULTS_DIR,
  SUBAGENT_CONTROL_EVENT,
  SUBAGENT_CONTROL_INTERCOM_EVENT,
  type AsyncJobState,
  type ControlEvent,
  type IntercomEventBus,
} from "../../shared/types.ts";
import type { ReadonlyInput } from "../../shared/types/inputs.ts";
import { attachRootChildrenToSteps } from "../shared/nested-events.ts";
import { reconcileNestedAsyncDescendants } from "./stale-run-reconciler.ts";
import type { AsyncRunSummary } from "./async-run-summary.ts";
import { errorCode, isRecord } from "./async-value.ts";
import { parseControlEvent } from "./run-schemas.ts";

function controlRecord(value: unknown):
  | {
      readonly event: ControlEvent;
      readonly channels: readonly unknown[];
      readonly childIntercomTarget?: string;
      readonly noticeText?: string;
      readonly intercom?: Readonly<Record<string, unknown>>;
    }
  | undefined {
  if (
    !isRecord(value) ||
    value.type !== "subagent.control" ||
    !isRecord(value.event) ||
    value.event.type !== "needs_attention" ||
    !Array.isArray(value.channels)
  ) {
    return undefined;
  }
  const event = parseControlEvent(value.event);
  return {
    event,
    channels: value.channels,
    childIntercomTarget:
      typeof value.childIntercomTarget === "string" ? value.childIntercomTarget : undefined,
    noticeText: typeof value.noticeText === "string" ? value.noticeText : undefined,
    intercom: isRecord(value.intercom) ? value.intercom : undefined,
  };
}

/** Owns the mutable widget projection and journal cursor of one async job. */
export class AsyncJobProjection {
  private readonly job: AsyncJobState;
  private readonly events: ReadonlyInput<IntercomEventBus>;
  constructor(job: AsyncJobState, events: ReadonlyInput<IntercomEventBus>) {
    this.job = job;
    this.events = events;
  }

  private emitControl(value: unknown): void {
    const record = controlRecord(value);
    if (
      !record ||
      (this.job.controlEventSince !== undefined && record.event.ts < this.job.controlEventSince)
    ) {
      return;
    }
    const payload = {
      event: record.event,
      source: "async" as const,
      asyncDir: this.job.asyncDir,
      childIntercomTarget: record.childIntercomTarget,
      noticeText:
        record.noticeText ?? formatControlNoticeMessage(record.event, record.childIntercomTarget),
    };
    if (isObsoleteIdleNotice(payload)) {
      return;
    }
    if (record.channels.includes("event")) {
      this.events.emit(SUBAGENT_CONTROL_EVENT, payload);
    }
    this.emitIntercom(record, payload);
  }

  private emitIntercom(
    record: NonNullable<ReturnType<typeof controlRecord>>,
    payload: {
      readonly event: ControlEvent;
      readonly source: "async";
      readonly asyncDir: string;
      readonly childIntercomTarget?: string;
      readonly noticeText: string;
    },
  ): void {
    const intercom = record.intercom;
    if (
      record.channels.includes("intercom") &&
      typeof intercom?.to === "string" &&
      intercom.to.length > 0 &&
      typeof intercom.message === "string" &&
      intercom.message.length > 0
    ) {
      this.events.emit(SUBAGENT_CONTROL_INTERCOM_EVENT, {
        ...payload,
        to: intercom.to,
        message: intercom.message,
      });
    }
  }

  emitNewControlEvents(): void {
    const eventsPath = path.join(this.job.asyncDir, "events.jsonl");
    try {
      const stat = fs.statSync(eventsPath);
      const identity = `${stat.dev}:${stat.ino}`;
      if (
        this.job.controlEventIdentity !== identity ||
        stat.size < (this.job.controlEventCursor ?? 0)
      ) {
        this.job.controlEventCursor = 0;
      }
      this.job.controlEventIdentity = identity;
      if (stat.size === (this.job.controlEventCursor ?? 0)) {
        return;
      }
      this.job.controlEventCursor = scanJournal(
        eventsPath,
        (parts) =>
          parts.length === 0 ||
          ["type", "event", "channels", "childIntercomTarget", "noticeText", "intercom"].includes(
            typeof parts[0] === "string" ? parts[0] : "",
          ),
        ({ value, end }) => {
          this.emitControl(value);
          this.job.controlEventCursor = end;
        },
        { policy: "live", start: this.job.controlEventCursor ?? 0 },
      );
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        console.error(`Failed to read async control events for '${this.job.asyncDir}':`, error);
      }
    }
  }

  refreshNested(): void {
    if (!this.job.nestedRoute) {
      return;
    }
    this.job.nestedChildren = reconcileNestedAsyncDescendants(this.job.nestedRoute, {
      resultsDir: RESULTS_DIR,
    });
    attachRootChildrenToSteps(this.job.asyncId, this.job.steps, this.job.nestedChildren);
  }

  private activity(summary: ReadonlyInput<AsyncRunSummary>): void {
    this.job.sessionId = summary.sessionId ?? this.job.sessionId;
    this.job.activityState = summary.activityState;
    this.job.lastActivityAt = summary.lastActivityAt ?? this.job.lastActivityAt;
    this.job.currentTool = summary.currentTool;
    this.job.currentToolStartedAt = summary.currentToolStartedAt;
    this.job.currentPath = summary.currentPath;
    this.job.turnCount = summary.turnCount ?? this.job.turnCount;
    this.job.toolCount = summary.toolCount ?? this.job.toolCount;
    this.job.totalTokens = summary.totalTokens ?? this.job.totalTokens;
    this.job.sessionFile = summary.sessionFile ?? this.job.sessionFile;
  }

  private progress(summary: ReadonlyInput<AsyncRunSummary>): void {
    if (summary.steps.length === 0) {
      return;
    }
    const groups = summary.parallelGroups ?? [];
    this.job.parallelGroups = groups.length > 0 ? groups : this.job.parallelGroups;
    const current = summary.currentStep;
    const active =
      current === undefined
        ? undefined
        : groups.find((group) => current >= group.start && current < group.start + group.count);
    const steps = active
      ? summary.steps.slice(active.start, active.start + active.count)
      : summary.steps;
    this.job.activeParallelGroup = active !== undefined;
    this.job.agents = steps.map((step) => step.agent);
    this.job.steps = steps.map((step) => ({ ...step }));
    attachRootChildrenToSteps(this.job.asyncId, this.job.steps, this.job.nestedChildren);
    this.job.stepsTotal = steps.length;
    this.job.runningSteps = steps.filter((step) => step.status === "running").length;
    this.job.completedSteps =
      summary.state === "complete"
        ? steps.length
        : steps.filter((step) => step.status === "complete" || step.status === "completed").length;
  }

  markRunning(): void {
    if (this.job.status === "queued") {
      this.job.status = "running";
      this.job.updatedAt = Date.now();
    }
  }

  markFailed(): void {
    this.job.status = "failed";
    this.job.updatedAt = Date.now();
  }

  complete(status: AsyncJobState["status"], asyncDir?: string): void {
    this.job.status = status;
    this.job.updatedAt = Date.now();
    if (asyncDir !== undefined && asyncDir.length > 0) {
      this.job.asyncDir = asyncDir;
    }
  }

  applySummary(summary: ReadonlyInput<AsyncRunSummary>): void {
    this.job.status = summary.state;
    this.activity(summary);
    this.job.mode = summary.mode;
    this.job.currentStep = summary.currentStep ?? this.job.currentStep;
    this.job.chainStepCount = summary.chainStepCount ?? this.job.chainStepCount;
    this.job.startedAt = summary.startedAt;
    if (summary.lastUpdate !== undefined) {
      this.job.updatedAt = summary.lastUpdate;
    }
    this.progress(summary);
  }
}
