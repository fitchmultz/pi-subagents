import * as fs from "node:fs";
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
import { appendWorktreeSummary } from "../shared/worktree.ts";
import { findLatestSessionFile } from "../../shared/utils.ts";
import { acceptanceHumanAction } from "../shared/acceptance.ts";
import { saveAsyncRunResult } from "../shared/supervisor-questions.ts";
import { flattenSteps } from "../shared/parallel-utils.ts";
import { exportSessionHtml, createShareLink, writeRunLog } from "./runner-reporting.ts";
import type { SubagentRunConfig, StepResult } from "./runner-contract.ts";
import type { RunnerMonitor } from "./runner-monitor.ts";
import type { RunnerLifecycle } from "./runner-lifecycle.ts";
import { markStepPaused } from "./runner-status.ts";

export interface CompletionEvidence {
  readonly results: readonly StepResult[];
  readonly outputs: ChainOutputMap;
  readonly worktreeSummaries: readonly string[];
  readonly setupCleanupWarning: string;
  readonly overallStartTime: number;
  readonly latestSessionFile?: string;
  readonly workflowComplete: boolean;
}

export async function completeRunner(
  config: ReadonlyDeep<SubagentRunConfig>,
  evidence: CompletionEvidence,
  monitor: RunnerMonitor,
  lifecycle: RunnerLifecycle,
): Promise<void> {
  const {
    results,
    outputs,
    worktreeSummaries,
    setupCleanupWarning,
    overallStartTime,
    latestSessionFile,
    workflowComplete,
  } = evidence;
  const { id, resultPath, cwd, taskIndex, totalTasks, maxOutput, artifactsDir, asyncDir } = config;
  const shareEnabled = config.share === true;
  const flatSteps = flattenSteps(config.steps);
  const statusPayload = monitor.statusPayload;
  const writeStatusPayload = monitor.writeStatusPayload;
  const eventsPath = path.join(asyncDir, "events.jsonl");
  const logPath = path.join(asyncDir, `subagent-log-${id}.md`);
  const resultMode = config.resultMode ?? statusPayload.mode;
  const childText = (result: StepResult) =>
    result.error && !result.output.includes(result.error)
      ? `${result.error}\n${result.output}`.trim()
      : result.output;
  let summary =
    resultMode === "single" && results.length === 1
      ? childText(results[0])
      : results.map((result) => `${result.agent}:\n${childText(result)}`).join("\n\n");
  if (statusPayload.error && !summary.includes(statusPayload.error)) {
    summary = `${statusPayload.error}\n\n${summary}`.trim();
  }
  if (statusPayload.timedOut) {
    summary = [
      `${resultMode === "parallel" ? "Parallel run" : resultMode === "chain" ? "Chain" : "Run"} timed out.`,
      summary,
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  if (worktreeSummaries.length > 0) {
    summary = appendWorktreeSummary(summary, worktreeSummaries.join("\n\n"));
  }
  const fullSummary = summary;
  let truncated = false;

  const outputLimits = { ...DEFAULT_MAX_OUTPUT, ...maxOutput };
  const lastArtifactPath = results[results.length - 1]?.artifactPaths?.outputPath;
  const referenceOnly =
    resultMode === "single" &&
    results.length === 1 &&
    results[0]?.outputMode === "file-only" &&
    results[0].exitCode === 0 &&
    results[0].outputReference;
  const truncResult = referenceOnly
    ? { text: summary, truncated: false }
    : truncateOutput(summary, outputLimits, lastArtifactPath);
  if (truncResult.truncated) {
    summary = truncResult.text;
    truncated = true;
  }

  const agentName =
    flatSteps.length === 1
      ? flatSteps[0].agent
      : resultMode === "parallel"
        ? `parallel:${flatSteps.map((s) => s.agent).join("+")}`
        : `chain:${flatSteps.map((s) => s.agent).join("->")}`;
  let sessionFile: string | undefined;
  let shareUrl: string | undefined;
  let gistUrl: string | undefined;
  let shareError: string | undefined;

  if (shareEnabled) {
    sessionFile = config.sessionDir
      ? (findLatestSessionFile(config.sessionDir) ?? undefined)
      : undefined;
    if (!sessionFile && latestSessionFile) {
      sessionFile = latestSessionFile;
    }
    if (sessionFile) {
      try {
        const exportDir = config.sessionDir ?? path.dirname(sessionFile);
        fs.mkdirSync(exportDir, { recursive: true });
        const htmlPath = await exportSessionHtml(sessionFile, exportDir, config.piPackageRoot);
        const share = createShareLink(htmlPath);
        if ("error" in share) {
          shareError = share.error;
        } else {
          shareUrl = share.shareUrl;
          gistUrl = share.gistUrl;
        }
      } catch (err) {
        shareError = String(err);
      }
    } else {
      shareError = "Session file not found.";
    }
  }

  lifecycle.dispose();
  const effectiveSessionFile = sessionFile ?? latestSessionFile ?? undefined;
  const runEndedAt = Date.now();
  if (lifecycle.interrupted) {
    for (let index = 0; index < statusPayload.steps.length; index++) {
      const step = statusPayload.steps[index];
      if (step.status !== "pending") {
        continue;
      }
      markStepPaused(step, runEndedAt);
      appendJsonl(
        eventsPath,
        JSON.stringify({
          type: "subagent.step.paused",
          ts: runEndedAt,
          runId: id,
          stepIndex: index,
          agent: step.agent,
          interrupted: true,
          durationMs: 0,
        }),
      );
    }
  }
  const hasFailedSteps = statusPayload.steps.some((step) => step.status === "failed");
  const hasPausedSteps = statusPayload.steps.some((step) => step.status === "paused");
  const finalRunState: AsyncStatus["state"] =
    hasFailedSteps || statusPayload.error || lifecycle.cancellation.signal.aborted
      ? "failed"
      : statusPayload.steps.some((step) => step.status === "blocked")
        ? "blocked"
        : lifecycle.interrupted || hasPausedSteps
          ? "paused"
          : workflowComplete
            ? "complete"
            : "failed";
  statusPayload.state = finalRunState;
  statusPayload.activityState = undefined;
  statusPayload.currentTool = undefined;
  statusPayload.currentToolStartedAt = undefined;
  statusPayload.currentPath = undefined;
  statusPayload.endedAt = runEndedAt;
  statusPayload.lastUpdate = runEndedAt;
  statusPayload.sessionFile = effectiveSessionFile;
  statusPayload.shareUrl = shareUrl;
  statusPayload.gistUrl = gistUrl;
  statusPayload.shareError = shareError;
  if (statusPayload.state === "failed" && !statusPayload.error) {
    const failedStep = statusPayload.steps.find((s) => s.status === "failed");
    if (failedStep?.agent) {
      statusPayload.error = `Step failed: ${failedStep.agent}`;
    } else if (lifecycle.cancellation.signal.aborted) {
      statusPayload.error = "Subagent cancelled.";
    }
  }
  writeStatusPayload();
  appendJsonl(
    eventsPath,
    JSON.stringify({
      type: "subagent.run.completed",
      ts: runEndedAt,
      runId: id,
      status: statusPayload.state,
      durationMs: runEndedAt - overallStartTime,
    }),
  );
  writeRunLog(logPath, {
    id,
    mode: statusPayload.mode,
    cwd,
    startedAt: overallStartTime,
    endedAt: runEndedAt,
    steps: statusPayload.steps.map((step) => ({
      agent: step.agent,
      status: step.status,
      durationMs: step.durationMs,
    })),
    summary: fullSummary,
    truncated: false,
    artifactsDir,
    sessionFile: effectiveSessionFile,
    shareUrl,
    shareError,
  });

  try {
    const resultData: AsyncResultFile = {
      id,
      runtimeVersion: config.runtimeVersion,
      maxOutput: outputLimits,
      error: statusPayload.error,
      timedOut: statusPayload.timedOut,
      agent: agentName,
      mode: resultMode,
      success: finalRunState === "complete",
      state: finalRunState,
      summary:
        finalRunState === "blocked"
          ? `Needs your action — acceptance incomplete.\n${results
              .map((result) => acceptanceHumanAction(result.acceptance))
              .filter(Boolean)
              .join("\n")}`
          : finalRunState === "paused"
            ? `Paused after interrupt. Waiting for explicit next action.${setupCleanupWarning ? `\n\n${setupCleanupWarning}` : ""}`
            : summary,
      results: results.map((r) => {
        const referenceOnly = r.outputMode === "file-only" && r.exitCode === 0 && r.outputReference;
        const childOutput = referenceOnly
          ? { text: referenceOnly.message, truncated: false }
          : truncateOutput(r.output, outputLimits, r.artifactPaths?.outputPath);
        return {
          ...r,
          output: childOutput.text,
          finalOutput: referenceOnly
            ? referenceOnly.message
            : r.finalOutput === undefined
              ? undefined
              : truncateOutput(r.finalOutput, outputLimits, r.artifactPaths?.outputPath).text,
          initialOutput:
            r.initialOutput === undefined
              ? undefined
              : truncateOutput(r.initialOutput, outputLimits, r.artifactPaths?.outputPath).text,
          truncated: r.truncated || childOutput.truncated || undefined,
        };
      }),
      outputs,
      workflowGraph: statusPayload.workflowGraph,
      exitCode: statusPayload.timedOut ? 124 : finalRunState === "failed" ? 1 : 0,
      timestamp: runEndedAt,
      durationMs: runEndedAt - overallStartTime,
      truncated,
      artifactsDir,
      cwd,
      asyncDir,
      sessionId: config.sessionId ?? undefined,
      sessionFile: effectiveSessionFile,
      intercomTarget: config.controlIntercomTarget,
      shareUrl,
      gistUrl,
      shareError,
      ...(taskIndex !== undefined && { taskIndex }),
      ...(totalTasks !== undefined && { totalTasks }),
    };
    const saved = saveAsyncRunResult(id, resultData);
    resultData.completionId = saved.completionId;
    resultData.recordVersion = 3;
    if (
      config.runtimeVersion !== 2 ||
      path.resolve(resultPath) !== path.resolve(asyncDir, "result.json")
    ) {
      writeAtomicJson(resultPath, resultData);
    }
  } catch (err) {
    console.error(`Failed to write result file ${resultPath}:`, err);
  }
}
