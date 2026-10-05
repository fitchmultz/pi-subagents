import * as path from "node:path";
import { inspect } from "node:util";
import type { ReadonlyDeep } from "type-fest";
import { appendJsonl } from "../../shared/artifacts.ts";
import type {
  DynamicRunnerGroup,
  RunnerSubagentStep,
  ParallelStepGroup,
  ChainOutputMap,
} from "../../shared/types.ts";
import { renderChainTask } from "../shared/chain-outputs.ts";
import {
  flattenSteps,
  isParallelGroup,
  isDynamicRunnerGroup,
  MAX_PARALLEL_CONCURRENCY,
} from "../shared/parallel-utils.ts";
import {
  completeWorkflowStep,
  runParallelTasks,
  workflowChildSucceeded,
} from "../shared/workflow-policy.ts";
import { appendWorktreeSummary } from "../shared/worktree.ts";
import type { SubagentRunConfig, StepResult } from "./runner-contract.ts";
import type { RunnerMonitor } from "./runner-monitor.ts";
import type { RunnerLifecycle } from "./runner-lifecycle.ts";
import { RunnerChildExecutor, type AsyncParallelStepResult } from "./runner-child-executor.ts";
import { RunnerParallelGroup } from "./runner-parallel.ts";
import { prepareDynamicGroup, type DynamicPlan } from "./runner-dynamic.ts";
import type { CompletionEvidence } from "./runner-completion.ts";

/** Owns chain output admission, flattened scheduling position and completed child records. */
export class RunnerWorkflow {
  private readonly config: ReadonlyDeep<SubagentRunConfig>;
  private readonly monitor: RunnerMonitor;
  private readonly lifecycle: RunnerLifecycle;
  private readonly executor: RunnerChildExecutor;
  private readonly outputs: ChainOutputMap = {};
  private readonly results: StepResult[] = [];
  private readonly worktreeSummaries: string[] = [];
  private previousOutput = "";
  private flatIndex = 0;
  private workflowComplete = false;
  private setupCleanupWarning = "";
  private readonly flatStepCount: number;

  constructor(
    config: ReadonlyDeep<SubagentRunConfig>,
    monitor: RunnerMonitor,
    lifecycle: RunnerLifecycle,
  ) {
    this.config = config;
    this.monitor = monitor;
    this.lifecycle = lifecycle;
    this.flatStepCount = flattenSteps(config.steps).length;
    this.executor = new RunnerChildExecutor(config, monitor, lifecycle, (template, item) =>
      this.renderTask(template, item),
    );
  }

  async run(overallStartTime: number): Promise<CompletionEvidence> {
    for (const [stepIndex, step] of this.config.steps.entries()) {
      if (this.lifecycle.interrupted || this.lifecycle.cancellation.signal.aborted) {
        break;
      }
      let advance: boolean;
      if (isDynamicRunnerGroup(step)) {
        // Each group depends on outputs admitted by the previous group.
        // oxlint-disable-next-line no-await-in-loop
        advance = await this.runDynamic(step, stepIndex);
      } else if (isParallelGroup(step)) {
        // Complete worktree cleanup before admitting the next workflow step.
        // oxlint-disable-next-line no-await-in-loop
        advance = await this.runParallel(step, stepIndex);
      } else {
        // Sequential chain tasks consume the preceding child's completed output.
        // oxlint-disable-next-line no-await-in-loop
        advance = await this.runSequential(step, stepIndex);
      }
      if (!advance) {
        break;
      }
    }
    return {
      results: this.results,
      outputs: this.outputs,
      worktreeSummaries: this.worktreeSummaries,
      setupCleanupWarning: this.setupCleanupWarning,
      overallStartTime,
      latestSessionFile: this.executor.latestSessionFile,
      workflowComplete: this.workflowComplete,
    };
  }

  private renderTask(template: string, item?: Readonly<{ name: string; value: unknown }>): string {
    const { config } = this;
    if (config.resultMode === "single" || config.resultMode === "parallel") {
      return template;
    }
    return renderChainTask(
      template,
      {
        originalTask: config.originalTask,
        previousOutput: this.previousOutput,
        chainDir: config.chainDir,
        outputs: this.outputs,
        item,
      },
      config.placeholder,
    );
  }

  private recordCompletion(
    completion: ReturnType<typeof completeWorkflowStep>,
    results: readonly AsyncParallelStepResult[],
  ): void {
    this.results.push(
      ...results.map((result) => ({ ...result, success: workflowChildSucceeded(result) })),
    );
    Object.assign(this.outputs, completion.outputs);
    this.monitor.statusPayload.outputs = this.outputs;
    this.previousOutput = completion.previousOutput;
    this.workflowComplete = completion.complete;
  }

  private async runSequential(step: RunnerSubagentStep, stepIndex: number): Promise<boolean> {
    let advance = false;
    await this.executor.run({
      task: step,
      flatIndex: this.flatIndex,
      taskCwd: this.config.cwd,
      sessionDir: this.config.sessionDir,
      flatStepCount: this.flatStepCount,
      sequential: true,
      trackSession: true,
      notifyCompletionGuard: true,
      beforeFinish: (result) => {
        const completion = completeWorkflowStep({
          stepIndex,
          stepCount: this.config.steps.length,
          results: [result],
          previousOutput: this.previousOutput,
          outputNames: [step.outputName],
        });
        this.recordCompletion(completion, [result]);
        advance = completion.advance;
      },
    });
    this.flatIndex++;
    return advance;
  }

  private async runDynamic(step: DynamicRunnerGroup, stepIndex: number): Promise<boolean> {
    let plan: DynamicPlan;
    try {
      plan = prepareDynamicGroup(step, this.outputs, {
        stepIndex,
        chainDir: this.config.chainDir ?? this.config.cwd,
        maxItems: this.config.dynamicFanoutMaxItems,
      });
    } catch (error) {
      this.monitor.failDynamicStep(
        stepIndex,
        this.flatIndex,
        error instanceof Error ? error.message : inspect(error),
      );
      return false;
    }
    this.monitor.expandChildren(plan, step, { stepIndex, flatIndex: this.flatIndex });
    const results = await this.executeDynamic(step, stepIndex, plan);
    this.flatIndex += plan.tasks.length;
    const completion = completeWorkflowStep({
      stepIndex,
      stepCount: this.config.steps.length,
      results,
      previousOutput: this.previousOutput,
      dynamic: { step, items: plan.materialized.items },
    });
    this.recordCompletion(completion, results);
    if (completion.error !== undefined && completion.error.length > 0) {
      this.monitor.statusPayload.error = completion.error;
    }
    const error = completion.error ?? results[completion.failedIndices[0]]?.error;
    this.monitor.markDynamicGraphGroup(stepIndex, dynamicGraphStatus(completion.status), error);
    this.appendGroupCompletion("dynamic", stepIndex, completion);
    this.monitor.statusPayload.lastUpdate = Date.now();
    this.monitor.writeStatusPayload();
    return completion.advance;
  }

  private executeDynamic(
    step: DynamicRunnerGroup,
    stepIndex: number,
    plan: DynamicPlan,
  ): Promise<AsyncParallelStepResult[]> {
    const start = this.flatIndex;
    const sessionDir = this.config.sessionDir;
    return runParallelTasks<RunnerSubagentStep, AsyncParallelStepResult>({
      tasks: plan.tasks,
      concurrency: step.concurrency ?? MAX_PARALLEL_CONCURRENCY,
      failFast: step.failFast,
      signal: this.lifecycle.cancellation.signal,
      interruptSignal: this.lifecycle.interruption.signal,
      stoppedTask: (task, index, reason) => this.executor.stop(task, start + index, reason),
      runTask: (task, index, interruptSignal) =>
        this.executor.run({
          task,
          flatIndex: start + index,
          interruptSignal,
          item: { name: step.expand.item ?? "item", value: plan.materialized.items[index].item },
          taskCwd: this.config.cwd,
          sessionDir:
            sessionDir === undefined || sessionDir.length === 0
              ? undefined
              : path.join(sessionDir, `dynamic-${stepIndex}-${index}`),
          flatStepCount: Math.max(this.monitor.statusPayload.steps.length, 1),
        }),
    });
  }

  private async runParallel(group: ParallelStepGroup, stepIndex: number): Promise<boolean> {
    const operation = new RunnerParallelGroup(
      this.config,
      this.monitor,
      this.lifecycle,
      this.executor,
    );
    return await operation.run(
      group,
      {
        flatIndex: this.flatIndex,
        stepIndex,
        flatStepCount: this.flatStepCount,
        previousOutput: this.previousOutput,
      },
      {
        failed: (results, warning) => {
          this.results.push(...results);
          this.setupCleanupWarning = warning ?? this.setupCleanupWarning;
          this.flatIndex += group.parallel.length;
        },
        completed: ({ results, completion, summary }) => {
          this.flatIndex += group.parallel.length;
          this.recordCompletion(completion, results);
          this.previousOutput = completion.advance
            ? appendWorktreeSummary(completion.previousOutput, summary)
            : completion.previousOutput;
          if (summary.length > 0) {
            this.worktreeSummaries.push(summary);
          }
          this.appendGroupCompletion("parallel", stepIndex, completion);
          this.monitor.writeStatusPayload();
        },
      },
    );
  }

  private appendGroupCompletion(
    kind: "parallel" | "dynamic",
    stepIndex: number,
    completion: ReadonlyDeep<ReturnType<typeof completeWorkflowStep>>,
  ): void {
    appendJsonl(
      path.join(this.config.asyncDir, "events.jsonl"),
      JSON.stringify({
        type: `subagent.${kind}.completed`,
        ts: Date.now(),
        runId: this.config.id,
        stepIndex,
        success: completion.advance,
        state: completion.status === "completed" ? "complete" : completion.status,
      }),
    );
  }
}

function dynamicGraphStatus(
  status: ReturnType<typeof completeWorkflowStep>["status"],
): "completed" | "blocked" | "paused" | "failed" {
  if (status === "completed" || status === "blocked" || status === "paused") {
    return status;
  }
  return "failed";
}
