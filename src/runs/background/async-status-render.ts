import * as path from "node:path";
import {
  formatDuration,
  formatModelThinking,
  formatTokens,
  shortenPath,
} from "../../shared/formatters.ts";
import {
  formatRunAction,
  formatActivityLabel,
  formatParallelOutcome,
} from "../../shared/status-format.ts";
import type { ActivityState } from "../../shared/types.ts";
import type { ReadonlyInput } from "../../shared/types/inputs.ts";
import { formatNestedRunStatusLines } from "../shared/nested-render.ts";
import { flatToLogicalStepIndex, normalizeParallelGroups } from "./parallel-groups.ts";
import type { AsyncRunStepSummary, AsyncRunSummary } from "./async-run-summary.ts";
import { hasText } from "./async-value.ts";

interface ActivityFacts {
  readonly activityState?: ActivityState;
  readonly lastActivityAt?: number;
  readonly currentTool?: string;
  readonly currentToolStartedAt?: number;
  readonly currentPath?: string;
  readonly turnCount?: number;
  readonly toolCount?: number;
}

export function formatActivityFacts(input: ActivityFacts): string | undefined {
  const facts: string[] = [];
  if (hasText(input.currentTool)) {
    const duration =
      input.currentToolStartedAt === undefined
        ? ""
        : ` ${formatDuration(Math.max(0, Date.now() - input.currentToolStartedAt))}`;
    facts.push(`tool ${input.currentTool}${duration}`);
  }
  if (hasText(input.currentPath)) {
    facts.push(shortenPath(input.currentPath));
  }
  if (input.turnCount !== undefined) {
    facts.push(`${input.turnCount} turns`);
  }
  if (input.toolCount !== undefined) {
    facts.push(`${input.toolCount} tools`);
  }
  const activity = formatActivityLabel(input.lastActivityAt, input.activityState);
  return hasText(activity) || facts.length > 0
    ? [activity, ...facts].filter((fact) => hasText(fact)).join(" | ")
    : undefined;
}

function formatStepLine(step: ReadonlyInput<AsyncRunStepSummary>): string {
  const display = hasText(step.label) ? `${step.label} (${step.agent})` : step.agent;
  const phase = hasText(step.phase) ? `[${step.phase}] ` : "";
  const parts: string[] = [`${step.index + 1}. ${phase}${display}`, step.status];
  const activity = formatActivityFacts(step);
  if (hasText(activity)) {
    parts.push(activity);
  }
  const modelThinking = formatModelThinking(step.model, step.thinking);
  if (modelThinking.length > 0) {
    parts.push(modelThinking);
  }
  if (step.durationMs !== undefined) {
    parts.push(formatDuration(step.durationMs));
  }
  if (step.tokens) {
    parts.push(`${formatTokens(step.tokens.total)} tok`);
  }
  return parts.join(" | ");
}

export function formatAsyncRunOutputPath(
  run: Readonly<Pick<AsyncRunSummary, "asyncDir" | "outputFile">>,
): string | undefined {
  if (!hasText(run.outputFile)) {
    return undefined;
  }
  return path.isAbsolute(run.outputFile) ? run.outputFile : path.join(run.asyncDir, run.outputFile);
}

type ProgressRun = ReadonlyInput<
  Pick<AsyncRunSummary, "mode" | "state" | "currentStep" | "chainStepCount" | "parallelGroups">
> & { readonly steps: readonly Pick<AsyncRunStepSummary, "status">[] };

function logicalProgress(
  run: ProgressRun,
  stepCount: number,
  groups: readonly ReadonlyInput<NonNullable<AsyncRunSummary["parallelGroups"]>[number]>[],
): string {
  const current = run.currentStep;
  const count = run.chainStepCount ?? stepCount;
  if (run.mode === "chain" && current !== undefined && groups.length > 0) {
    return `step ${flatToLogicalStepIndex(current, count, groups) + 1}/${count}`;
  }
  return current !== undefined ? `step ${current + 1}/${stepCount}` : `steps ${stepCount}`;
}

export function formatAsyncRunProgressLabel(run: ProgressRun): string {
  const stepCount = run.steps.length > 0 ? run.steps.length : 1;
  const chainStepCount = run.chainStepCount ?? stepCount;
  const groups = normalizeParallelGroups(run.parallelGroups, run.steps.length, chainStepCount);
  const current = run.currentStep;
  const activeGroup =
    current === undefined
      ? undefined
      : groups.find((group) => current >= group.start && current < group.start + group.count);
  if (activeGroup) {
    const steps = run.steps.slice(activeGroup.start, activeGroup.start + activeGroup.count);
    const groupLabel = formatParallelOutcome(steps, activeGroup.count, {
      showRunning: run.state === "running",
    });
    return run.mode === "parallel"
      ? groupLabel
      : `step ${activeGroup.stepIndex + 1}/${chainStepCount} · parallel group: ${groupLabel}`;
  }
  if (run.mode === "parallel") {
    return formatParallelOutcome(run.steps, stepCount, { showRunning: run.state === "running" });
  }
  return logicalProgress(run, stepCount, groups);
}

function formatRunHeader(run: ReadonlyInput<AsyncRunSummary>): string {
  const cwd = hasText(run.cwd) ? shortenPath(run.cwd) : shortenPath(run.asyncDir);
  const activity = formatActivityFacts(run);
  return `${run.id} | ${run.state}${hasText(activity) ? ` | ${activity}` : ""} | ${run.mode} | ${formatAsyncRunProgressLabel(run)} | ${cwd}`;
}

function formatRunLines(run: ReadonlyInput<AsyncRunSummary>): string[] {
  const lines = [`- ${formatRunHeader(run)}`, `  Status: ${formatRunAction("status", run.id)}`];
  for (const step of run.steps) {
    lines.push(`  ${formatStepLine(step)}`);
    lines.push(...formatNestedRunStatusLines(step.children, { indent: "    ", maxLines: 12 }));
  }
  const attached = new Set(
    run.steps.flatMap((step) => step.children?.map((child) => child.id) ?? []),
  );
  const unattached = run.nestedChildren?.filter((child) => !attached.has(child.id)) ?? [];
  lines.push(...formatNestedRunStatusLines(unattached, { indent: "  ", maxLines: 12 }));
  for (const warning of run.nestedWarnings ?? []) {
    lines.push(`  Warning: ${warning}`);
  }
  const outputPath = formatAsyncRunOutputPath(run);
  if (hasText(outputPath)) {
    lines.push(`  output: ${shortenPath(outputPath)}`);
  }
  if (hasText(run.sessionFile)) {
    lines.push(`  session: ${shortenPath(run.sessionFile)}`);
  }
  lines.push("");
  return lines;
}

export function formatAsyncRunList(
  runs: ReadonlyInput<AsyncRunSummary[]>,
  heading = "Active async runs",
): string {
  if (runs.length === 0) {
    return `No ${heading.toLowerCase()}.`;
  }
  return [`${heading}: ${runs.length}`, "", ...runs.flatMap(formatRunLines)].join("\n").trimEnd();
}
