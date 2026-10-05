import * as path from "node:path";
import type { ReadonlyDeep } from "type-fest";
import { appendJsonl } from "../../shared/artifacts.ts";
import { buildControlEvent } from "../shared/subagent-control.ts";
import { flattenSteps } from "../shared/parallel-utils.ts";
import type { RunnerSubagentStep } from "../../shared/types.ts";
import type { ParallelStopReason } from "../shared/workflow-policy.ts";
import type {
  SubagentRunConfig,
  RunSingleStepResult,
  SingleStepContext,
} from "./runner-contract.ts";
import type { RunnerMonitor } from "./runner-monitor.ts";
import type { RunnerLifecycle } from "./runner-lifecycle.ts";
import {
  markStepPaused,
  startRunnerStep,
  finishRunnerStep,
  runnerResultEvent,
  tokenUsageFromAttempts,
} from "./runner-status.ts";
import { runSingleStep } from "./runner-step.ts";

export type AsyncParallelStepResult = RunSingleStepResult & { skipped?: boolean };

export interface ChildRunInput {
  readonly task: RunnerSubagentStep;
  readonly worktreePath?: string;
  readonly flatIndex: number;
  readonly interruptSignal?: AbortSignal;
  readonly sequential?: boolean;
  readonly item?: { readonly name: string; readonly value: unknown };
  readonly taskCwd: string;
  readonly sessionDir?: string;
  readonly flatStepCount: number;
  readonly resetTiming?: boolean;
  readonly trackSession?: boolean;
  readonly notifyCompletionGuard?: boolean;
  readonly beforeFinish?: (result: RunSingleStepResult) => void;
}

/** Executes one scheduled child; shared workflow policy still owns scheduling and admission. */
export class RunnerChildExecutor {
  latestSessionFile: string | undefined;
  private readonly config: ReadonlyDeep<SubagentRunConfig>;
  private readonly monitor: RunnerMonitor;
  private readonly lifecycle: RunnerLifecycle;
  private readonly renderTask: (
    template: string,
    item?: Readonly<{ name: string; value: unknown }>,
  ) => string;
  private readonly sessionEnabled: boolean;

  constructor(
    config: ReadonlyDeep<SubagentRunConfig>,
    monitor: RunnerMonitor,
    lifecycle: RunnerLifecycle,
    renderTask: (template: string, item?: Readonly<{ name: string; value: unknown }>) => string,
  ) {
    this.config = config;
    this.monitor = monitor;
    this.lifecycle = lifecycle;
    this.renderTask = renderTask;
    this.sessionEnabled =
      (config.sessionDir !== undefined && config.sessionDir.length > 0) ||
      config.share === true ||
      flattenSteps(config.steps).some(
        (step) => step.sessionFile !== undefined && step.sessionFile.length > 0,
      );
  }

  async run(input: ReadonlyDeep<ChildRunInput>): Promise<AsyncParallelStepResult> {
    const { task, flatIndex } = input;
    const startedAt = startRunnerStep(this.monitor.statusPayload, task, {
      asyncDir: this.config.asyncDir,
      index: flatIndex,
      sequential: input.sequential,
      resetTiming: input.resetTiming,
    });
    this.monitor.writeStatusPayload();
    this.append({
      type: "subagent.step.started",
      ts: startedAt,
      runId: this.config.id,
      stepIndex: flatIndex,
      agent: task.agent,
    });
    const result = await runSingleStep(
      { ...task, task: this.renderTask(task.task, input.item) },
      this.stepContext(input),
    );
    this.lifecycle.register(flatIndex, undefined);
    if (
      input.trackSession === true &&
      task.sessionFile !== undefined &&
      task.sessionFile.length > 0
    ) {
      this.latestSessionFile = task.sessionFile;
    }
    // Sequential workflow outputs must be admitted before terminal step status is published.
    input.beforeFinish?.(result);
    this.finish(input, result, startedAt);
    return input.sequential === true ? result : { ...result, skipped: false };
  }

  private stepContext(input: ReadonlyDeep<ChildRunInput>): SingleStepContext {
    const { config, monitor, lifecycle } = this;
    const index = input.flatIndex;
    const childTarget = monitor.childTarget(index);
    return {
      nativeFinalization: config.runtimeVersion === 2,
      worktreePath: input.worktreePath,
      cwd: input.taskCwd,
      sessionEnabled: this.sessionEnabled,
      sessionDir: input.sessionDir,
      artifactsDir: config.artifactsDir,
      id: config.id,
      flatIndex: index,
      flatStepCount: input.flatStepCount,
      outputFile: path.join(config.asyncDir, `output-${index}.log`),
      childIntercomTarget: childTarget,
      orchestratorIntercomTarget:
        childTarget === undefined || childTarget.length === 0
          ? undefined
          : config.controlIntercomTarget,
      nestedRoute: config.nestedRoute,
      projectTrust: config.projectTrust,
      rootSessionId: config.rootSessionId,
      signal: lifecycle.cancellation.signal,
      interruptSignal: input.interruptSignal,
      registerInterrupt: (interrupt) => {
        lifecycle.register(index, interrupt);
      },
      onAttemptStart: (attempt) => {
        monitor.updateStepModel(index, attempt.model, attempt.thinking);
      },
      onChildEvent: (event, mutation) => {
        monitor.updateStepFromChildEvent(index, event, mutation);
      },
    };
  }

  private finish(
    input: ReadonlyDeep<ChildRunInput>,
    result: RunSingleStepResult,
    startedAt: number,
  ): void {
    const endedAt = finishRunnerStep(this.monitor.statusPayload, result, {
      index: input.flatIndex,
      startedAt,
      sequential: input.sequential,
    });
    this.monitor.writeStatusPayload();
    this.append({
      type: runnerResultEvent(result),
      ts: endedAt,
      runId: this.config.id,
      stepIndex: input.flatIndex,
      agent: input.task.agent,
      exitCode: result.exitCode,
      durationMs: endedAt - startedAt,
      interrupted: result.interrupted,
      agentProcessExit: result.agentProcessExit,
      ...(input.sequential === true
        ? { tokens: tokenUsageFromAttempts(result.modelAttempts) }
        : {}),
      resourceLimitExceeded: result.resourceLimitExceeded,
    });
    if (input.notifyCompletionGuard === true && result.completionGuardTriggered === true) {
      this.monitor.appendControlEvent(
        buildControlEvent({
          from: this.monitor.statusPayload.steps[input.flatIndex].activityState,
          to: "needs_attention",
          runId: this.config.id,
          agent: input.task.agent,
          index: input.flatIndex,
          ts: endedAt,
          message: `${input.task.agent} completed without making edits for an implementation task`,
          reason: "completion_guard",
        }),
      );
    }
  }

  stop(
    task: RunnerSubagentStep,
    index: number,
    reason: ParallelStopReason,
  ): AsyncParallelStepResult {
    const now = Date.now();
    const step = this.monitor.statusPayload.steps[index];
    const paused = reason === "interrupted";
    const error = `Skipped due to ${reason}`;
    const exitCode = paused ? 0 : -1;
    if (paused) {
      markStepPaused(step, now);
    } else {
      Object.assign(step, {
        status: "failed",
        error,
        startedAt: now,
        endedAt: now,
        durationMs: 0,
        exitCode,
      });
    }
    this.monitor.statusPayload.lastUpdate = now;
    this.monitor.writeStatusPayload();
    this.append({
      type: paused ? "subagent.step.paused" : "subagent.step.failed",
      ts: now,
      runId: this.config.id,
      stepIndex: index,
      agent: task.agent,
      exitCode,
      interrupted: paused,
      durationMs: 0,
    });
    return {
      agent: task.agent,
      output: error,
      error,
      exitCode,
      interrupted: paused,
      skipped: true,
    };
  }

  private append(event: ReadonlyDeep<Record<string, unknown>>): void {
    appendJsonl(path.join(this.config.asyncDir, "events.jsonl"), JSON.stringify(event));
  }
}
