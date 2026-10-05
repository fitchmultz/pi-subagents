import * as path from "node:path";
import { inspect } from "node:util";
import type { ReadonlyDeep } from "type-fest";
import { appendJsonl } from "../../shared/artifacts.ts";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { writeInitialProgressFile } from "../../shared/settings.ts";
import { completeWorkflowStep, runParallelTasks } from "../shared/workflow-policy.ts";
import {
  createWorktrees,
  cleanupWorktrees,
  findWorktreeTaskCwdConflict,
  formatWorktreeTaskCwdConflict,
  formatParallelWorktreeSummary,
  WorktreeCleanupError,
  type WorktreeSetup,
} from "../shared/worktree.ts";
import { MAX_PARALLEL_CONCURRENCY } from "../shared/parallel-utils.ts";
import type { ParallelStepGroup, RunnerSubagentStep } from "../../shared/types.ts";
import type { SubagentRunConfig, StepResult } from "./runner-contract.ts";
import type { RunnerMonitor } from "./runner-monitor.ts";
import type { RunnerLifecycle } from "./runner-lifecycle.ts";
import type { RunnerChildExecutor, AsyncParallelStepResult } from "./runner-child-executor.ts";

interface GroupPosition {
  readonly flatIndex: number;
  readonly stepIndex: number;
  readonly flatStepCount: number;
  readonly previousOutput: string;
}

export interface ParallelCompletion {
  readonly results: AsyncParallelStepResult[];
  readonly completion: ReturnType<typeof completeWorkflowStep>;
  readonly summary: string;
}

type SetupOutcome =
  | { readonly ready: true; readonly worktrees?: WorktreeSetup }
  | { readonly ready: false; readonly results: StepResult[]; readonly warning?: string };

/** Owns worktree setup/preservation/cleanup for a static parallel group. */
export class RunnerParallelGroup {
  private readonly config: ReadonlyDeep<SubagentRunConfig>;
  private readonly monitor: RunnerMonitor;
  private readonly lifecycle: RunnerLifecycle;
  private readonly executor: RunnerChildExecutor;

  constructor(
    config: ReadonlyDeep<SubagentRunConfig>,
    monitor: RunnerMonitor,
    lifecycle: RunnerLifecycle,
    executor: RunnerChildExecutor,
  ) {
    this.config = config;
    this.monitor = monitor;
    this.lifecycle = lifecycle;
    this.executor = executor;
  }

  async run(
    group: ParallelStepGroup,
    position: GroupPosition,
    hooks: Readonly<{
      failed: (results: StepResult[], warning?: string) => void;
      completed: (outcome: ParallelCompletion) => void;
    }>,
  ): Promise<boolean> {
    const setup = await this.setup(group, position);
    if (!setup.ready) {
      hooks.failed(setup.results, setup.warning);
      return false;
    }
    const worktrees = setup.worktrees;
    const cwd = group.cwd ?? this.config.cwd;
    try {
      if (group.worktree === true) {
        this.ensureProgress(cwd, group);
      }
      this.startGroup(group, position);
      const results = await this.executeTasks(group, position, worktrees);
      this.monitor.refreshUsageTotals();
      this.monitor.statusPayload.lastUpdate = Date.now();
      this.monitor.writeStatusPayload();
      const completion = completeWorkflowStep({
        stepIndex: position.stepIndex,
        stepCount: this.config.steps.length,
        results,
        previousOutput: position.previousOutput,
        parallel: true,
        outputNames: group.parallel.map((task) => task.outputName),
      });
      const summary = formatParallelWorktreeSummary(
        worktrees,
        path.join(this.config.asyncDir, "worktree-diffs", `step-${position.stepIndex}`),
        group.parallel.map((task) => task.agent),
      );
      // Workflow outputs and terminal group event are published before ordered worktree cleanup.
      hooks.completed({ results, completion, summary });
      return completion.advance;
    } catch (error) {
      if (worktrees) {
        worktrees.preserveOnCleanup = true;
      }
      throw error;
    } finally {
      if (worktrees) {
        cleanupWorktrees(worktrees);
      }
    }
  }

  private async setup(group: ParallelStepGroup, position: GroupPosition): Promise<SetupOutcome> {
    if (group.worktree !== true) {
      return { ready: true };
    }
    const cwd = group.cwd ?? this.config.cwd;
    const conflict = findWorktreeTaskCwdConflict(group.parallel, cwd);
    if (conflict) {
      return {
        ready: false,
        results: this.failSetup(group, position, formatWorktreeTaskCwdConflict(conflict, cwd)),
      };
    }
    try {
      const hook = this.config.worktreeSetupHook;
      const worktrees = await createWorktrees(
        cwd,
        `${this.config.id}-s${position.stepIndex}`,
        group.parallel.length,
        {
          agents: group.parallel.map((task) => task.agent),
          signal: AbortSignal.any([
            this.lifecycle.cancellation.signal,
            this.lifecycle.interruption.signal,
          ]),
          setupHook:
            hook === undefined || hook.length === 0
              ? undefined
              : { hookPath: hook, timeoutMs: this.config.worktreeSetupHookTimeoutMs },
        },
      );
      return { ready: true, worktrees };
    } catch (error) {
      const message = error instanceof Error ? error.message : inspect(error);
      if (this.lifecycle.interrupted && !this.lifecycle.cancellation.signal.aborted) {
        return this.interruptedSetup(group, position, error, message);
      }
      return { ready: false, results: this.failSetup(group, position, message) };
    }
  }

  private interruptedSetup(
    group: ParallelStepGroup,
    position: GroupPosition,
    error: unknown,
    message: string,
  ): SetupOutcome {
    const warning = error instanceof WorktreeCleanupError ? message : undefined;
    const results = group.parallel.map((task, index) => {
      const stopped = this.executor.stop(task, position.flatIndex + index, "interrupted");
      return {
        ...stopped,
        output: warning === undefined ? stopped.output : `${stopped.output}\n\n${warning}`,
        success: false,
      };
    });
    return { ready: false, results, warning };
  }

  private failSetup(
    group: ParallelStepGroup,
    position: GroupPosition,
    error: string,
  ): StepResult[] {
    const failedAt = Date.now();
    const status = this.monitor.statusPayload;
    const results = group.parallel.map((task, taskIndex) => {
      const step = status.steps[position.flatIndex + taskIndex];
      Object.assign(step, {
        status: "failed",
        startedAt: failedAt,
        endedAt: failedAt,
        durationMs: 0,
        exitCode: 1,
      });
      return {
        agent: task.agent,
        output: error,
        success: false,
        exitCode: 1,
        sessionFile: task.sessionFile,
      };
    });
    status.currentStep = position.flatIndex;
    status.lastUpdate = failedAt;
    status.outputFile = path.join(this.config.asyncDir, `output-${position.flatIndex}.log`);
    writeAtomicJson(path.join(this.config.asyncDir, "status.json"), status);
    this.append({
      type: "subagent.parallel.completed",
      ts: failedAt,
      runId: this.config.id,
      stepIndex: position.stepIndex,
      success: false,
    });
    return results;
  }

  private startGroup(group: ParallelStepGroup, position: GroupPosition): void {
    const startedAt = Date.now();
    const status = this.monitor.statusPayload;
    for (const [index] of group.parallel.entries()) {
      Object.assign(status.steps[position.flatIndex + index], {
        status: "pending",
        startedAt: undefined,
        endedAt: undefined,
        durationMs: undefined,
        lastActivityAt: undefined,
        activityState: undefined,
        error: undefined,
      });
    }
    status.currentStep = position.flatIndex;
    status.activityState = undefined;
    status.lastActivityAt = startedAt;
    status.lastUpdate = startedAt;
    status.outputFile = path.join(this.config.asyncDir, `output-${position.flatIndex}.log`);
    writeAtomicJson(path.join(this.config.asyncDir, "status.json"), status);
    this.append({
      type: "subagent.parallel.started",
      ts: startedAt,
      runId: this.config.id,
      stepIndex: position.stepIndex,
      agents: group.parallel.map((task) => task.agent),
      count: group.parallel.length,
    });
  }

  private executeTasks(
    group: ParallelStepGroup,
    position: GroupPosition,
    worktrees: WorktreeSetup | undefined,
  ): Promise<AsyncParallelStepResult[]> {
    return runParallelTasks<RunnerSubagentStep, AsyncParallelStepResult>({
      tasks: group.parallel,
      concurrency: group.concurrency ?? MAX_PARALLEL_CONCURRENCY,
      failFast: group.failFast,
      signal: this.lifecycle.cancellation.signal,
      interruptSignal: this.lifecycle.interruption.signal,
      stoppedTask: (task, index, reason) =>
        this.executor.stop(task, position.flatIndex + index, reason),
      runTask: (task, index, interruptSignal) =>
        this.executor.run({
          task: worktrees ? { ...task, cwd: undefined } : task,
          taskCwd: worktrees ? worktrees.worktrees[index].agentCwd : (group.cwd ?? this.config.cwd),
          worktreePath: worktrees?.worktrees[index]?.path,
          flatIndex: position.flatIndex + index,
          interruptSignal,
          sessionDir:
            this.config.sessionDir === undefined || this.config.sessionDir.length === 0
              ? undefined
              : path.join(this.config.sessionDir, `parallel-${index}`),
          flatStepCount: position.flatStepCount,
          resetTiming: true,
          trackSession: true,
          notifyCompletionGuard: true,
        }),
    });
  }

  private ensureProgress(cwd: string, group: ParallelStepGroup): void {
    const progressPath = path.join(cwd, "progress.md");
    if (group.parallel.some((task) => task.task.includes(`Update progress at: ${progressPath}`))) {
      writeInitialProgressFile(cwd);
    }
  }

  private append(event: ReadonlyDeep<Record<string, unknown>>): void {
    appendJsonl(path.join(this.config.asyncDir, "events.jsonl"), JSON.stringify(event));
  }
}
