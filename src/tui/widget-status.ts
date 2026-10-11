import { hasText } from "./text-values.ts";
import type {
  ReadonlyInput,
  AsyncJobState,
  AsyncJobStep,
  WorkflowNodeStatus,
} from "../shared/types.ts";
import * as path from "node:path";
import { activityFacts, joinActivity } from "./activity-lines.ts";
import { formatDuration } from "../shared/formatters.ts";
import { flatToLogicalStepIndex } from "../runs/background/parallel-groups.ts";
import { formatAgentRunningLabel } from "../shared/status-format.ts";
import {
  firstOutputLine,
  buildLiveStatusLine,
  runningSeed,
  type Theme,
  runningGlyph,
  formatTokenStat,
  formatToolUseStat,
  statJoin,
  formatCurrentToolLine,
} from "./display.ts";

export function widgetRenderKey(job: ReadonlyInput<AsyncJobState>): string {
  return JSON.stringify({
    asyncDir: job.asyncDir,
    status: job.status,
    activityState: job.activityState,
    lastActivityAt: job.lastActivityAt,
    currentTool: job.currentTool,
    currentToolStartedAt: job.currentToolStartedAt,
    currentPath: job.currentPath,
    turnCount: job.turnCount,
    toolCount: job.toolCount,
    mode: job.mode,
    agents: job.agents,
    currentStep: job.currentStep,
    chainStepCount: job.chainStepCount,
    parallelGroups: job.parallelGroups,
    steps: job.steps,
    nestedChildren: job.nestedChildren,
    stepsTotal: job.stepsTotal,
    runningSteps: job.runningSteps,
    completedSteps: job.completedSteps,
    activeParallelGroup: job.activeParallelGroup,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    totalTokens: job.totalTokens,
  });
}

export function formatWidgetAgents(agents: ReadonlyInput<string[]>): string {
  const distinct = [...new Set(agents)];
  if (distinct.length === 1 && agents.length > 1) {
    return `${distinct[0]} ×${agents.length}`;
  }
  if (agents.length > 3) {
    return `${agents.slice(0, 2).join(", ")} +${agents.length - 2} more`;
  }
  return agents.join(", ");
}

export function widgetJobName(job: ReadonlyInput<AsyncJobState>): string {
  const agents = job.agents ?? [];
  if (job.mode === "parallel") {
    return "parallel";
  }
  if (job.mode === "chain") {
    return "chain";
  }
  if (job.mode === "single" && agents.length === 1) {
    return agents[0] ?? "subagent";
  }
  if (agents.length > 0) {
    return formatWidgetAgents(agents);
  }
  return job.mode ?? "subagent";
}

export function widgetActivity(job: ReadonlyInput<AsyncJobState>, includeCounts = true): string {
  const facts = activityFacts(job, job.updatedAt, includeCounts);
  if (job.status === "running") {
    return joinActivity(facts, buildLiveStatusLine(job, job.updatedAt), "thinking…");
  }
  const labels: Readonly<Record<Exclude<AsyncJobState["status"], "running">, string>> = {
    queued: "queued…",
    paused: "Paused",
    failed: "Failed",
    blocked: "Needs your action",
    complete: "Done",
  };
  const error =
    job.status === "failed" ? job.steps?.find((step) => hasText(step.error))?.error : undefined;
  return [labels[job.status], hasText(error) ? firstOutputLine(error) : "", ...facts]
    .filter(Boolean)
    .join(" · ");
}

export function widgetStepRunningSeed(
  step: ReadonlyInput<NonNullable<AsyncJobState["steps"]>[number]>,
  fallbackIndex?: number,
): number | undefined {
  return runningSeed(
    fallbackIndex,
    step.index,
    step.toolCount,
    step.turnCount,
    step.tokens?.total,
    step.lastActivityAt,
    step.currentToolStartedAt,
    step.durationMs,
  );
}

export function widgetStepsRunningSeed(
  steps: ReadonlyInput<Array<NonNullable<AsyncJobState["steps"]>[number]> | undefined>,
): number | undefined {
  let seed: number | undefined;
  for (const [index, step] of (steps ?? []).entries()) {
    seed = runningSeed(seed, widgetStepRunningSeed(step, index));
  }
  return seed;
}

function widgetJobRunningSeed(job: ReadonlyInput<AsyncJobState>): number | undefined {
  return runningSeed(
    job.updatedAt,
    job.lastActivityAt,
    job.toolCount,
    job.turnCount,
    job.totalTokens?.total,
    job.currentStep,
    job.runningSteps,
    job.completedSteps,
    widgetStepsRunningSeed(job.steps),
  );
}

export function widgetJobsRunningSeed(jobs: ReadonlyInput<AsyncJobState[]>): number | undefined {
  let seed: number | undefined;
  for (const job of jobs) {
    seed = runningSeed(seed, widgetJobRunningSeed(job));
  }
  return seed;
}

export function widgetStatusGlyph(job: ReadonlyInput<AsyncJobState>, theme: Theme): string {
  if (job.status === "running") {
    return theme.fg("accent", runningGlyph(widgetJobRunningSeed(job)));
  }
  if (job.status === "queued") {
    return theme.fg("muted", "◦");
  }
  if (job.status === "complete") {
    return theme.fg("success", "✓");
  }
  if (job.status === "blocked") {
    return theme.fg("warning", "■");
  }
  if (job.status === "paused") {
    return theme.fg("warning", "■");
  }
  return theme.fg("error", "✗");
}

export function widgetStepGlyph(
  status: ReadonlyInput<AsyncJobStep["status"] | WorkflowNodeStatus>,
  theme: Theme,
  seed?: number,
): string {
  if (status === "running") {
    return theme.fg("accent", runningGlyph(seed));
  }
  if (status === "complete" || status === "completed") {
    return theme.fg("success", "✓");
  }
  if (status === "failed" || status === "timed-out") {
    return theme.fg("error", "✗");
  }
  if (status === "blocked") {
    return theme.fg("warning", "■");
  }
  if (status === "paused") {
    return theme.fg("warning", "■");
  }
  return theme.fg("muted", "◦");
}

export function widgetStepStatus(
  status: ReadonlyInput<AsyncJobStep["status"] | WorkflowNodeStatus>,
  theme: Theme,
): string {
  if (status === "running") {
    return theme.fg("accent", "running");
  }
  if (status === "complete" || status === "completed") {
    return theme.fg("success", "complete");
  }
  if (status === "failed") {
    return theme.fg("error", "failed");
  }
  if (status === "timed-out") {
    return theme.fg("error", "timed out");
  }
  if (status === "blocked") {
    return theme.fg("warning", "needs your action");
  }
  if (status === "paused") {
    return theme.fg("warning", "paused");
  }
  return theme.fg("dim", status);
}

export function widgetStepActivity(
  step: ReadonlyInput<NonNullable<AsyncJobState["steps"]>[number]>,
  snapshotNow?: number,
): string {
  if ((step.status === "failed" || step.status === "timed-out") && hasText(step.error)) {
    return firstOutputLine(step.error);
  }
  const facts = activityFacts(step, snapshotNow);
  if ((step.tokens?.total ?? 0) > 0) {
    facts.push(formatTokenStat(step.tokens?.total ?? 0));
  }
  return joinActivity(facts, buildLiveStatusLine(step, snapshotNow));
}

function activeGroupStep(job: ReadonlyInput<AsyncJobState>): number {
  const groups = job.parallelGroups ?? [],
    current = job.currentStep;
  const group =
    current === undefined
      ? groups.find((candidate) => candidate.start === 0)
      : groups.find(
          (candidate) => current >= candidate.start && current < candidate.start + candidate.count,
        );
  return group?.stepIndex ?? current ?? 0;
}
function parallelJobStat(job: ReadonlyInput<AsyncJobState>, total: number): string {
  const running = job.runningSteps ?? Number(job.status === "running");
  const succeeded = job.completedSteps ?? (job.status === "complete" ? total : 0);
  const parts = [`${succeeded}/${total} succeeded`];
  if (job.status === "running" && running > 0) {
    parts.unshift(formatAgentRunningLabel(running));
  }
  if (job.mode === "parallel") {
    return total > 0 ? parts.join(" · ") : parts.slice(0, -1).join(" · ");
  }
  return `step ${activeGroupStep(job) + 1}/${job.chainStepCount ?? total} · parallel group: ${parts.join(" · ")}`;
}
function jobStepStat(job: ReadonlyInput<AsyncJobState>): string {
  const total = job.stepsTotal ?? job.agents?.length ?? 1;
  if (job.activeParallelGroup === true) {
    return parallelJobStat(job, total);
  }
  if (job.currentStep === undefined) {
    return total > 1 ? `steps ${total}` : "";
  }
  return currentStepStat(job, job.currentStep, total);
}
function currentStepStat(
  job: Pick<ReadonlyInput<AsyncJobState>, "parallelGroups" | "mode" | "chainStepCount">,
  current: number,
  total: number,
): string {
  const parallelGroups = job.parallelGroups ?? [];
  if (job.mode !== "chain" || parallelGroups.length === 0) {
    return `step ${current + 1}/${total}`;
  }
  const chainTotal = job.chainStepCount ?? total;
  return `step ${flatToLogicalStepIndex(current, chainTotal, parallelGroups) + 1}/${chainTotal}`;
}
export function widgetStats(job: ReadonlyInput<AsyncJobState>, theme: Theme): string {
  const parts = [jobStepStat(job)];
  if (job.toolCount !== undefined) {
    parts.push(formatToolUseStat(job.toolCount));
  }
  if ((job.totalTokens?.total ?? 0) > 0) {
    parts.push(formatTokenStat(job.totalTokens?.total ?? 0));
  }
  if (job.status !== "queued" && job.startedAt !== undefined && job.updatedAt !== undefined) {
    parts.push(formatDuration(Math.max(0, job.updatedAt - job.startedAt)));
  }
  return statJoin(theme, parts);
}

export function widgetStepStats(
  theme: Theme,
  step: ReadonlyInput<NonNullable<AsyncJobState["steps"]>[number]>,
): string {
  return statJoin(theme, [
    step.turnCount !== undefined ? `${step.turnCount} turns` : "",
    step.toolCount !== undefined ? formatToolUseStat(step.toolCount) : "",
    (step.tokens?.total ?? 0) !== 0 ? formatTokenStat(step.tokens?.total ?? 0) : "",
    step.durationMs !== undefined ? formatDuration(step.durationMs) : "",
  ]);
}

export function widgetStepActivityLine(
  step: ReadonlyInput<NonNullable<AsyncJobState["steps"]>[number]>,
  width: number,
  expanded: boolean,
  snapshotNow?: number,
): string {
  if ((step.status === "failed" || step.status === "timed-out") && hasText(step.error)) {
    return firstOutputLine(step.error);
  }
  const toolLine = formatCurrentToolLine(step, width, expanded, snapshotNow);
  if (hasText(toolLine)) {
    return toolLine;
  }
  const activity = buildLiveStatusLine(step, snapshotNow);
  if (hasText(activity)) {
    return activity;
  }
  if (step.status === "running") {
    return "thinking…";
  }
  return "";
}

export function widgetOutputPath(
  job: ReadonlyInput<AsyncJobState>,
  step: ReadonlyInput<NonNullable<AsyncJobState["steps"]>[number]>,
): string | undefined {
  if (typeof step.index !== "number") {
    return undefined;
  }
  return path.join(job.asyncDir, `output-${step.index}.log`);
}
