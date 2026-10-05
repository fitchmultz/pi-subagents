import * as fs from "node:fs";
import { RunnerChildObserver } from "./runner-child-observer.ts";
import { refreshRunnerGraph } from "./runner-graph.ts";
import {
  expandDynamicStatus,
  expandDynamicGraph,
  reindexChildTargets,
  type DynamicPlan,
} from "./runner-dynamic.ts";
import type { DynamicRunnerGroup, AcceptanceLedger, ActivityState } from "../../shared/types.ts";
import * as path from "node:path";
import type { ReadonlyDeep } from "type-fest";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { appendJsonl } from "../../shared/artifacts.ts";
import { SUBAGENT_CHILD_ENV, SUBAGENT_FANOUT_CHILD_ENV } from "../shared/pi-args.ts";
import {
  DEFAULT_CONTROL_CONFIG,
  buildControlEvent,
  deriveActivityState,
  claimControlNotification,
  formatControlIntercomMessage,
  formatControlNoticeMessage,
} from "../shared/subagent-control.ts";
import { nestedSummaryFromAsyncStatus, writeNestedEvent } from "../shared/nested-events.ts";
import { saveRunStatus, pendingSupervisorQuestion } from "../shared/supervisor-questions.ts";
import type { MutationToolResult } from "../shared/mutating-tool-guard.ts";
import type { ChildEvent } from "../shared/child-attempt.ts";
import type { SubagentRunConfig } from "./runner-contract.ts";
import type { RunnerStatusPayload } from "./runner-status.ts";

/** Owns live status publication and attention notifications; execution owns cancellation. */
export class RunnerMonitor {
  private statusWriteTimer: NodeJS.Timeout | undefined;
  private currentActivityState: ActivityState | undefined;
  private readonly emittedControlEventKeys = new Set<string>();
  private readonly childObserver: RunnerChildObserver;
  private readonly controlConfig;
  private readonly childSafeControls;
  private readonly statusPath;
  private readonly eventsPath;
  private readonly asyncDir;
  private readonly id;
  private childIntercomTargets: Array<string | undefined> | undefined;
  private readonly config: ReadonlyDeep<SubagentRunConfig>;
  readonly statusPayload: RunnerStatusPayload;
  private readonly overallStartTime: number;

  constructor(
    config: ReadonlyDeep<SubagentRunConfig>,
    statusPayload: RunnerStatusPayload,
    overallStartTime: number,
  ) {
    this.config = config;
    this.statusPayload = statusPayload;
    this.overallStartTime = overallStartTime;
    this.id = this.config.id;
    this.asyncDir = this.config.asyncDir;
    this.statusPath = path.join(this.config.asyncDir, "status.json");
    this.eventsPath = path.join(this.config.asyncDir, "events.jsonl");
    this.controlConfig = this.config.controlConfig ?? DEFAULT_CONTROL_CONFIG;
    this.childSafeControls =
      this.config.nestedSelf !== undefined ||
      (process.env[SUBAGENT_CHILD_ENV] === "1" && process.env[SUBAGENT_FANOUT_CHILD_ENV] === "1");
    this.childObserver = new RunnerChildObserver(
      statusPayload,
      { id: this.id, controlConfig: this.controlConfig },
      {
        clearAttention: (index) => {
          this.clearControlNotificationKeys(index);
        },
        notify: (event) => {
          this.appendControlEvent(event);
        },
        scheduleWrite: () => {
          this.scheduleStatusWrite();
        },
      },
    );
    this.childIntercomTargets = config.childIntercomTargets?.map((target) =>
      typeof target === "string" ? target : undefined,
    );
  }

  childTarget(index: number): string | undefined {
    return this.childIntercomTargets?.[index];
  }

  failDynamicStep(stepIndex: number, flatIndex: number, error: string): void {
    const now = Date.now();
    this.statusPayload.state = "failed";
    this.statusPayload.error = error;
    this.statusPayload.currentStep = flatIndex;
    const placeholder = this.statusPayload.steps.at(flatIndex);
    if (placeholder) {
      Object.assign(placeholder, {
        status: "failed",
        error,
        startedAt: now,
        endedAt: now,
        durationMs: 0,
        exitCode: 1,
      });
    }
    this.statusPayload.lastUpdate = now;
    this.markDynamicGraphGroup(stepIndex, "failed", error);
    this.writeStatusPayload();
  }

  expandChildren(
    plan: ReadonlyDeep<DynamicPlan>,
    step: DynamicRunnerGroup,
    position: Readonly<{ stepIndex: number; flatIndex: number }>,
  ): void {
    const address = { ...position, runId: this.id };
    const count = expandDynamicStatus(this.statusPayload, plan, step, address);
    this.childIntercomTargets = reindexChildTargets(
      this.childIntercomTargets,
      this.statusPayload.steps,
      { ...address, count },
    );
    this.childObserver.expandChildren(position.flatIndex, count);
    const graph = this.statusPayload.workflowGraph;
    if (graph) {
      this.statusPayload.workflowGraph = expandDynamicGraph(graph, plan, step, address);
    }
    this.writeStatusPayload();
  }

  private emitNestedSelfEvent(type: "subagent.nested.updated" | "subagent.nested.completed"): void {
    if (!this.config.nestedRoute || !this.config.nestedSelf) {
      return;
    }
    try {
      writeNestedEvent(this.config.nestedRoute, {
        type,
        ts: Date.now(),
        parentRunId: this.config.nestedSelf.parentRunId,
        parentStepIndex: this.config.nestedSelf.parentStepIndex,
        child: nestedSummaryFromAsyncStatus(this.statusPayload, this.asyncDir, {
          id: this.id,
          parentRunId: this.config.nestedSelf.parentRunId,
          parentStepIndex: this.config.nestedSelf.parentStepIndex,
          depth: this.config.nestedSelf.depth,
          path: this.config.nestedSelf.path?.map((entry) => Object.assign({}, entry)),
          mode: this.statusPayload.mode,
          ts: Date.now(),
        }),
      });
    } catch (error) {
      console.error("Failed to emit nested async status event:", error);
    }
  }
  private refreshWorkflowGraph(): void {
    const graph = this.statusPayload.workflowGraph ?? this.config.workflowGraph;
    if (graph !== undefined) {
      this.statusPayload.workflowGraph = refreshRunnerGraph(
        graph,
        this.statusPayload.steps,
        this.statusPayload.currentStep,
      );
    }
  }

  writeStatusPayload = (): void => {
    if (this.statusWriteTimer) {
      clearTimeout(this.statusWriteTimer);
      this.statusWriteTimer = undefined;
    }
    this.refreshWorkflowGraph();
    writeAtomicJson(this.statusPath, this.statusPayload);
    if (this.config.runtimeVersion !== 2) {
      saveRunStatus(this.id, this.statusPayload);
    }
    this.emitNestedSelfEvent(
      this.statusPayload.state === "running" || this.statusPayload.state === "queued"
        ? "subagent.nested.updated"
        : "subagent.nested.completed",
    );
  };
  private scheduleStatusWrite(): void {
    if (this.statusWriteTimer) {
      return;
    }
    this.statusWriteTimer = setTimeout(this.writeStatusPayload, 200);
    this.statusWriteTimer.unref();
  }
  markDynamicGraphGroup(
    stepIndex: number,
    status: "completed" | "failed" | "blocked" | "running" | "paused",
    error?: string,
    acceptance?: AcceptanceLedger,
  ): void {
    const graph = this.statusPayload.workflowGraph;
    if (graph === undefined) {
      return;
    }
    this.statusPayload.workflowGraph = {
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.id === `step-${stepIndex}`
          ? Object.assign({}, node, {
              status,
              error,
              acceptanceStatus: acceptance?.status ?? node.acceptanceStatus,
            })
          : node,
      ),
    };
  }

  refreshUsageTotals(): void {
    this.statusPayload.totalTokens = this.statusPayload.steps.reduce(
      (total, step) => ({
        input: total.input + (step.tokens?.input ?? 0),
        output: total.output + (step.tokens?.output ?? 0),
        total: total.total + (step.tokens?.total ?? 0),
      }),
      { input: 0, output: 0, total: 0 },
    );
  }
  private stepOutputActivityAt(index: number): number {
    const step = this.statusPayload.steps.at(index);
    let lastActivityAt = step?.lastActivityAt ?? step?.startedAt ?? this.overallStartTime;
    const outputPath = path.join(this.asyncDir, `output-${index}.log`);
    try {
      lastActivityAt = Math.max(lastActivityAt, fs.statSync(outputPath).mtimeMs);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        console.error(`Failed to inspect async output file '${outputPath}':`, error);
      }
    }
    return lastActivityAt;
  }
  appendControlEvent(event: ReadonlyDeep<ReturnType<typeof buildControlEvent>>): void {
    if (!this.controlConfig.enabled) {
      return;
    }
    const childIntercomTarget =
      this.childIntercomTargets?.[event.index ?? this.statusPayload.currentStep];
    const channels = this.controlConfig.notifyChannels;
    if (
      channels.length === 0 ||
      !claimControlNotification(
        this.controlConfig,
        event,
        this.emittedControlEventKeys,
        childIntercomTarget,
      )
    ) {
      return;
    }
    appendJsonl(
      this.eventsPath,
      JSON.stringify({
        type: "subagent.control",
        event,
        channels,
        childIntercomTarget,
        noticeText: formatControlNoticeMessage(event, childIntercomTarget, this.childSafeControls),
        ...(this.config.controlIntercomTarget !== undefined &&
        this.config.controlIntercomTarget.length > 0 &&
        channels.includes("intercom")
          ? {
              intercom: {
                to: this.config.controlIntercomTarget,
                message: formatControlIntercomMessage(
                  event,
                  childIntercomTarget,
                  this.childSafeControls,
                ),
              },
            }
          : {}),
      }),
    );
  }
  updateStepModel(
    flatIndex: number,
    model: string | undefined,
    thinking: string | undefined,
    now = Date.now(),
  ): void {
    const step = this.statusPayload.steps.at(flatIndex);
    if (!step) {
      return;
    }
    step.model = model;
    step.thinking = thinking;
    step.modelStartedAt = now;
    this.statusPayload.lastUpdate = now;
    this.writeStatusPayload();
  }
  private clearControlNotificationKeys(flatIndex: number): void {
    const childKey = this.childIntercomTargets?.[flatIndex] ?? `${this.config.id}:${flatIndex}`;
    for (const key of this.emittedControlEventKeys) {
      if (key.startsWith(`${childKey}:`)) {
        this.emittedControlEventKeys.delete(key);
      }
    }
  }
  updateStepFromChildEvent(
    flatIndex: number,
    event: ReadonlyDeep<ChildEvent>,
    toolSnapshot?: ReadonlyDeep<MutationToolResult>,
  ): void {
    this.childObserver.updateStepFromChildEvent(flatIndex, event, toolSnapshot);
  }

  private updateIdleAttention(index: number, lastActivityAt: number, now: number): boolean {
    const step = this.statusPayload.steps[index];
    const idleState = deriveActivityState({
      config: this.controlConfig,
      startedAt: step.startedAt ?? this.overallStartTime,
      lastActivityAt,
      now,
    });
    const previous = step.activityState;
    if (idleState !== "needs_attention") {
      if (previous !== "needs_attention") {
        return false;
      }
      step.activityState = undefined;
      this.clearControlNotificationKeys(index);
      return true;
    }
    step.activityState = "needs_attention";
    if (previous === "needs_attention") {
      return false;
    }
    this.appendControlEvent(
      buildControlEvent({
        from: previous,
        to: "needs_attention",
        runId: this.id,
        agent: step.agent,
        index,
        ts: now,
        lastActivityAt,
        currentTool: step.currentTool,
        currentToolDurationMs:
          step.currentToolStartedAt === undefined
            ? undefined
            : Math.max(0, now - step.currentToolStartedAt),
        supervisorQuestion: pendingSupervisorQuestion({
          runId: this.id,
          agent: step.agent,
          index,
          sessionFile: step.sessionFile,
        }),
      }),
    );
    return true;
  }

  private syncRunAttention(): boolean {
    const nextRunState = this.statusPayload.steps.some(
      (step) => step.activityState === "needs_attention",
    )
      ? "needs_attention"
      : undefined;
    if (nextRunState === this.currentActivityState) {
      return false;
    }
    this.currentActivityState = nextRunState;
    this.statusPayload.activityState = nextRunState;
    return true;
  }

  updateRunnerActivityState(now: number): boolean {
    if (!this.controlConfig.enabled) {
      return false;
    }
    let changed = false;
    let runLastActivityAt = this.statusPayload.lastActivityAt ?? this.overallStartTime;
    for (let index = 0; index < this.statusPayload.steps.length; index++) {
      const step = this.statusPayload.steps[index];
      if (step.status !== "running") {
        continue;
      }
      const lastActivityAt = this.stepOutputActivityAt(index);
      runLastActivityAt = Math.max(runLastActivityAt, lastActivityAt);
      if (step.lastActivityAt !== lastActivityAt) {
        step.lastActivityAt = lastActivityAt;
        changed = true;
      }
      changed = this.updateIdleAttention(index, lastActivityAt, now) || changed;
    }
    if (this.statusPayload.lastActivityAt !== runLastActivityAt) {
      this.statusPayload.lastActivityAt = runLastActivityAt;
      changed = true;
    }
    changed = this.syncRunAttention() || changed;
    this.statusPayload.lastUpdate = now;
    if (changed) {
      this.writeStatusPayload();
    }
    return changed;
  }
}
