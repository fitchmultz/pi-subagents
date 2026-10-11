import type { ReadonlyInput, Details, AgentProgress } from "../shared/types.ts";
import { getSingleResultOutput } from "../shared/utils.ts";
import { workflowGraphHasStatus } from "./workflow-labels.ts";
import { hasEmptyTextOutputWithoutOutputTarget } from "./display.ts";

export type ResultInput = ReadonlyInput<Details["results"][number]>;
export type DetailsInput = ReadonlyInput<Details>;
export type ProgressInput = ReadonlyInput<AgentProgress>;

export function workflowFacts(
  d: DetailsInput,
  isError: boolean,
): {
  running: boolean;
  failed: boolean;
  blocked: boolean;
  paused: boolean;
} {
  return {
    running:
      !isError &&
      (d.progress?.some((p) => p.status === "running") === true ||
        d.results.some((r) => r.progress?.status === "running") ||
        workflowGraphHasStatus(d, ["running"])),
    failed:
      isError ||
      workflowGraphHasStatus(d, ["failed", "timed-out"]) ||
      d.results.some((r) => r.exitCode !== 0 && r.progress?.status !== "running"),
    blocked:
      d.results.some((r) => r.acceptance?.status === "blocked" && r.exitCode === 0) ||
      workflowGraphHasStatus(d, ["blocked"]),
    paused:
      d.results.some(
        (r) => (r.interrupted === true || r.detached === true) && r.progress?.status !== "running",
      ) || workflowGraphHasStatus(d, ["paused", "detached"]),
  };
}

export function totalProgress(
  d: DetailsInput,
): { toolCount: number; tokens: number; durationMs: number } | undefined {
  if (d.progressSummary) {
    return d.progressSummary;
  }
  const progress = d.results.flatMap((r) => r.progress ?? r.progressSummary ?? []);
  if (progress.length === 0) {
    return;
  }
  return {
    toolCount: progress.reduce((sum, p) => sum + p.toolCount, 0),
    tokens: progress.reduce((sum, p) => sum + p.tokens, 0),
    durationMs:
      d.mode === "chain"
        ? progress.reduce((sum, p) => sum + p.durationMs, 0)
        : Math.max(...progress.map((p) => p.durationMs)),
  };
}

export function resultProgress(
  d: DetailsInput,
  index: number,
): ProgressInput | ResultInput["progressSummary"] {
  const r = d.results.at(index);
  if (!r) {
    return;
  }
  return (
    r.progress ??
    d.progress?.find((p) => p.index === index) ??
    d.progress?.find((p) => p.agent === r.agent && p.status === "running") ??
    r.progressSummary
  );
}

export function expandedResultStatus(
  r: ResultInput,
  running: boolean,
  emptyWarning = false,
): string {
  if (running) {
    return "running";
  }
  if (r.detached === true) {
    return "detached";
  }
  if (r.interrupted === true) {
    return "paused";
  }
  if (r.exitCode !== 0) {
    return "failed";
  }
  if (r.acceptance?.status === "blocked") {
    return "needs your action";
  }
  if (emptyWarning && hasEmptyTextOutputWithoutOutputTarget(r.task, getSingleResultOutput(r))) {
    return "warning";
  }
  return "done";
}
