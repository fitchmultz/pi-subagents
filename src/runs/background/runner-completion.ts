import * as path from "node:path";
import type { ReadonlyDeep } from "type-fest";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { appendJsonl } from "../../shared/artifacts.ts";
import {
  type AsyncResultFile,
  type AsyncStatus,
  type ChainOutputMap,
  DEFAULT_MAX_OUTPUT,
  truncateOutput,
} from "../../shared/types.ts";
import { saveAsyncRunResult } from "../shared/supervisor-questions.ts";
import { flattenSteps } from "../shared/parallel-utils.ts";
import { shareRunnerSession, writeRunLog } from "./runner-reporting.ts";
import type { SubagentRunConfig, StepResult } from "./runner-contract.ts";
import type { RunnerMonitor } from "./runner-monitor.ts";
import type { RunnerLifecycle } from "./runner-lifecycle.ts";
import { markStepPaused } from "./runner-status.ts";
import {
  completionSummary,
  terminalSummary,
  truncateStepResult,
} from "./runner-completion-summary.ts";

export interface CompletionEvidence {
  readonly results: readonly StepResult[];
  readonly outputs: ChainOutputMap;
  readonly worktreeSummaries: readonly string[];
  readonly setupCleanupWarning: string;
  readonly overallStartTime: number;
  readonly latestSessionFile?: string;
  readonly workflowComplete: boolean;
}

class RunnerCompletion {
  private readonly config: ReadonlyDeep<SubagentRunConfig>;
  private readonly evidence: ReadonlyDeep<CompletionEvidence>;
  private readonly monitor: RunnerMonitor;
  private readonly lifecycle: RunnerLifecycle;
  private readonly eventsPath: string;
  private readonly outputLimits;
  private readonly resultMode;
  private readonly fullSummary: string;
  private readonly summary: string;
  private readonly truncated: boolean;

  constructor(
    config: ReadonlyDeep<SubagentRunConfig>,
    evidence: ReadonlyDeep<CompletionEvidence>,
    monitor: RunnerMonitor,
    lifecycle: RunnerLifecycle,
  ) {
    this.config = config;
    this.evidence = evidence;
    this.monitor = monitor;
    this.lifecycle = lifecycle;
    this.eventsPath = path.join(config.asyncDir, "events.jsonl");
    this.outputLimits = { ...DEFAULT_MAX_OUTPUT, ...config.maxOutput };
    this.resultMode = config.resultMode ?? monitor.statusPayload.mode;
    this.fullSummary = completionSummary({
      mode: this.resultMode,
      results: evidence.results,
      error: monitor.statusPayload.error,
      timedOut: monitor.statusPayload.timedOut,
      worktreeSummaries: evidence.worktreeSummaries,
    });
    const onlyResult = evidence.results.at(0);
    const referenceOnly =
      this.resultMode === "single" &&
      evidence.results.length === 1 &&
      onlyResult?.outputMode === "file-only" &&
      onlyResult.exitCode === 0 &&
      onlyResult.outputReference !== undefined;
    const output = referenceOnly
      ? { text: this.fullSummary, truncated: false }
      : truncateOutput(
          this.fullSummary,
          this.outputLimits,
          evidence.results.at(-1)?.artifactPaths?.outputPath,
        );
    this.summary = output.text;
    this.truncated = output.truncated;
  }

  private pausePendingSteps(endedAt: number): void {
    if (!this.lifecycle.interrupted) {
      return;
    }
    this.monitor.statusPayload.steps.forEach((step, stepIndex) => {
      if (step.status !== "pending") {
        return;
      }
      markStepPaused(step, endedAt);
      appendJsonl(
        this.eventsPath,
        JSON.stringify({
          type: "subagent.step.paused",
          ts: endedAt,
          runId: this.config.id,
          stepIndex,
          agent: step.agent,
          interrupted: true,
          durationMs: 0,
        }),
      );
    });
  }

  private finalRunState(): AsyncStatus["state"] {
    const status = this.monitor.statusPayload;
    if (
      status.steps.some((step) => step.status === "failed") ||
      (status.error !== undefined && status.error.length > 0) ||
      this.lifecycle.cancellation.signal.aborted
    ) {
      return "failed";
    }
    if (status.steps.some((step) => step.status === "blocked")) {
      return "blocked";
    }
    if (this.lifecycle.interrupted || status.steps.some((step) => step.status === "paused")) {
      return "paused";
    }
    return this.evidence.workflowComplete ? "complete" : "failed";
  }

  private updateFailure(): void {
    const status = this.monitor.statusPayload;
    if (status.state !== "failed" || (status.error !== undefined && status.error.length > 0)) {
      return;
    }
    const failedStep = status.steps.find((step) => step.status === "failed");
    if (failedStep !== undefined && failedStep.agent.length > 0) {
      status.error = `Step failed: ${failedStep.agent}`;
    } else if (this.lifecycle.cancellation.signal.aborted) {
      status.error = "Subagent cancelled.";
    }
  }

  private publishStatus(
    endedAt: number,
    share: ReadonlyDeep<Awaited<ReturnType<typeof shareRunnerSession>>>,
  ): void {
    const status = this.monitor.statusPayload;
    status.state = this.finalRunState();
    status.activityState = undefined;
    status.currentTool = undefined;
    status.currentToolStartedAt = undefined;
    status.currentPath = undefined;
    status.endedAt = endedAt;
    status.lastUpdate = endedAt;
    status.sessionFile = share.sessionFile;
    status.shareUrl = share.shareUrl;
    status.gistUrl = share.gistUrl;
    status.shareError = share.shareError;
    this.updateFailure();
    this.monitor.writeStatusPayload();
    appendJsonl(
      this.eventsPath,
      JSON.stringify({
        type: "subagent.run.completed",
        ts: endedAt,
        runId: this.config.id,
        status: status.state,
        durationMs: endedAt - this.evidence.overallStartTime,
      }),
    );
    writeRunLog(path.join(this.config.asyncDir, `subagent-log-${this.config.id}.md`), {
      id: this.config.id,
      mode: status.mode,
      cwd: this.config.cwd,
      startedAt: this.evidence.overallStartTime,
      endedAt,
      steps: status.steps.map((step) => ({
        agent: step.agent,
        status: step.status,
        durationMs: step.durationMs,
      })),
      summary: this.fullSummary,
      truncated: false,
      artifactsDir: this.config.artifactsDir,
      sessionFile: share.sessionFile,
      shareUrl: share.shareUrl,
      shareError: share.shareError,
    });
  }

  private agentName(): string {
    const steps = flattenSteps(this.config.steps);
    const first = steps.at(0);
    if (steps.length === 1 && first !== undefined) {
      return first.agent;
    }
    const names = steps.map((step) => step.agent);
    return this.resultMode === "parallel"
      ? `parallel:${names.join("+")}`
      : `chain:${names.join("->")}`;
  }

  private writeResult(
    endedAt: number,
    share: ReadonlyDeep<Awaited<ReturnType<typeof shareRunnerSession>>>,
  ): void {
    const status = this.monitor.statusPayload;
    const { config, evidence } = this;
    const exitCode = status.state === "failed" ? 1 : 0;
    const resultData: AsyncResultFile = {
      id: config.id,
      runtimeVersion: config.runtimeVersion,
      maxOutput: this.outputLimits,
      error: status.error,
      timedOut: status.timedOut,
      agent: this.agentName(),
      mode: this.resultMode,
      success: status.state === "complete",
      state: status.state,
      summary: terminalSummary({
        state: status.state,
        results: evidence.results,
        summary: this.summary,
        setupCleanupWarning: evidence.setupCleanupWarning,
      }),
      results: evidence.results.map((result) => truncateStepResult(result, this.outputLimits)),
      outputs: evidence.outputs,
      workflowGraph: status.workflowGraph,
      exitCode: status.timedOut === true ? 124 : exitCode,
      timestamp: endedAt,
      durationMs: endedAt - evidence.overallStartTime,
      truncated: this.truncated,
      artifactsDir: config.artifactsDir,
      cwd: config.cwd,
      asyncDir: config.asyncDir,
      sessionId: config.sessionId ?? undefined,
      sessionFile: share.sessionFile,
      intercomTarget: config.controlIntercomTarget,
      shareUrl: share.shareUrl,
      gistUrl: share.gistUrl,
      shareError: share.shareError,
      ...(config.taskIndex !== undefined && { taskIndex: config.taskIndex }),
      ...(config.totalTasks !== undefined && { totalTasks: config.totalTasks }),
    };
    const saved = saveAsyncRunResult(config.id, resultData);
    resultData.completionId = saved.completionId;
    resultData.recordVersion = 3;
    if (
      config.runtimeVersion !== 2 ||
      path.resolve(config.resultPath) !== path.resolve(config.asyncDir, "result.json")
    ) {
      writeAtomicJson(config.resultPath, resultData);
    }
  }

  async complete(): Promise<void> {
    const share = await shareRunnerSession(this.config, this.evidence.latestSessionFile);
    this.lifecycle.dispose();
    const endedAt = Date.now();
    this.pausePendingSteps(endedAt);
    this.publishStatus(endedAt, share);
    try {
      this.writeResult(endedAt, share);
    } catch (error) {
      console.error(`Failed to write result file ${this.config.resultPath}:`, error);
    }
  }
}

export async function completeRunner(
  config: ReadonlyDeep<SubagentRunConfig>,
  evidence: ReadonlyDeep<CompletionEvidence>,
  monitor: RunnerMonitor,
  lifecycle: RunnerLifecycle,
): Promise<void> {
  await new RunnerCompletion(config, evidence, monitor, lifecycle).complete();
}
