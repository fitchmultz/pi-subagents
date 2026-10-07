import type { AsyncJobState, ReadonlyInput } from "../shared/types.ts";
import { shortenPath } from "../shared/formatters.ts";
import { aggregateStepStatus, formatParallelOutcome } from "../shared/status-format.ts";
import {
  getTermWidth,
  themeBold,
  modelThinkingBadge,
  buildLiveStatusLine,
  truncLine,
  type Theme,
} from "./display.ts";
import { buildAsyncChainStepSpans } from "./workflow-labels.ts";
import {
  widgetStepGlyph,
  widgetStepsRunningSeed,
  widgetStepActivity,
  widgetStepRunningSeed,
  widgetStepStatus,
  widgetStepStats,
  widgetStepActivityLine,
  widgetOutputPath,
  widgetActivity,
  widgetStats,
  widgetJobName,
  widgetStatusGlyph,
} from "./widget-status.ts";
import { formatNestedWidgetLines } from "./nested-widget.ts";
import { hasText } from "./text-values.ts";
type Job = ReadonlyInput<AsyncJobState>;
type Step = ReadonlyInput<NonNullable<AsyncJobState["steps"]>[number]>;
interface StepLayout {
  readonly title: "Agent" | "Step";
  readonly index: number;
  readonly total: number;
  readonly width: number;
}

function widgetChainDetails(job: Job, theme: Theme, width: number): string[] {
  const steps = job.steps ?? [],
    total = job.chainStepCount ?? steps.length,
    lines: string[] = [];
  for (const span of buildAsyncChainStepSpans(total, steps.length, job.parallelGroups)) {
    const group = steps.slice(span.start, span.start + span.count);
    if (span.isParallel) {
      const status = aggregateStepStatus(group);
      lines.push(
        `  ${widgetStepGlyph(status, theme, widgetStepsRunningSeed(group))} Step ${span.stepIndex + 1}/${total}: ${themeBold(theme, "parallel group")} ${theme.fg("dim", "·")} ${theme.fg("dim", formatParallelOutcome(group, span.count))}`,
      );
      continue;
    }
    const step = group.at(0);
    if (!step) {
      lines.push(`  ${theme.fg("dim", `◦ Step ${span.stepIndex + 1}/${total}: pending`)}`);
      continue;
    }
    lines.push(
      ...foregroundStyleWidgetStepLines(job, theme, step, {
        title: "Step",
        index: span.stepIndex + 1,
        total,
        width,
      }),
    );
  }
  return lines;
}
function parallelStepLines(job: Job, theme: Theme, step: Step, layout: StepLayout): string[] {
  const marker = layout.index === (job.steps?.length ?? 0) ? "└" : "├";
  const activity = widgetStepActivity(step, job.updatedAt),
    model = modelThinkingBadge(theme, step.model, step.thinking);
  const lines = [
    `  ${theme.fg("dim", `${marker} ${widgetStepGlyph(step.status, theme, widgetStepRunningSeed(step, layout.index - 1))} ${layout.title} ${layout.index}/${layout.total}: ${step.agent} · ${widgetStepStatus(step.status, theme)}${model}${hasText(activity) ? ` · ${activity}` : ""}`)}`,
  ];
  for (const nested of formatNestedWidgetLines(step.children, theme, layout.width, {
    snapshotNow: job.updatedAt,
    lineBudget: 8,
  })) {
    lines.push(`    ${nested}`);
  }
  return lines;
}
export function widgetParallelAgentDetails(
  job: Job,
  theme: Theme,
  width = getTermWidth(),
): string[] {
  const steps = job.steps ?? [];
  if (steps.length === 0 || (job.mode !== "parallel" && job.mode !== "chain")) {
    return [];
  }
  if (hasLogicalChainGroups(job)) {
    return widgetChainDetails(job, theme, width);
  }
  const total = job.stepsTotal ?? steps.length,
    title = job.mode === "parallel" || job.activeParallelGroup === true ? "Agent" : "Step";
  return steps.flatMap((step, index) =>
    parallelStepLines(job, theme, step, { title, index: index + 1, total, width }),
  );
}
function hasLogicalChainGroups(
  job: Pick<Job, "mode" | "activeParallelGroup" | "parallelGroups">,
): boolean {
  return (
    job.mode === "chain" &&
    job.activeParallelGroup !== true &&
    (job.parallelGroups?.length ?? 0) > 0
  );
}

function recentToolLines(step: Step, theme: Theme, width: number): string[] {
  const max = Math.max(40, width - 30);
  return (step.recentTools ?? []).slice(-3).map((tool) => {
    const args = tool.args.length <= max ? tool.args : `${tool.args.slice(0, max)}...`;
    return `      ${theme.fg("dim", `${tool.tool}${hasText(args) ? `: ${args}` : ""}`)}`;
  });
}
function runningStepLines(
  job: Job,
  theme: Theme,
  step: Step,
  layout: { readonly width: number; readonly activity: string },
): string[] {
  const lines: string[] = [],
    output = widgetOutputPath(job, step),
    live = buildLiveStatusLine(step, job.updatedAt);
  if (hasText(output)) {
    lines.push(`    ${theme.fg("dim", `output: ${shortenPath(output)}`)}`);
  }
  if (hasText(live) && live !== layout.activity) {
    lines.push(`    ${theme.fg("accent", live)}`);
  }
  lines.push(...recentToolLines(step, theme, layout.width));
  for (const line of (step.recentOutput ?? []).slice(-5)) {
    lines.push(`      ${theme.fg("dim", line)}`);
  }
  return lines;
}
function foregroundStyleWidgetStepLines(
  job: Job,
  theme: Theme,
  step: Step,
  layout: StepLayout,
): string[] {
  const status = widgetStepStatus(step.status, theme),
    stats = widgetStepStats(theme, step),
    model = modelThinkingBadge(theme, step.model, step.thinking);
  const lines = [
    `  ${widgetStepGlyph(step.status, theme, widgetStepRunningSeed(step, layout.index - 1))} ${layout.title} ${layout.index}/${layout.total}: ${themeBold(theme, step.agent)} ${theme.fg("dim", "·")} ${status}${model}${hasText(stats) ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`,
  ];
  const activity = widgetStepActivityLine(step, layout.width, true, job.updatedAt);
  if (hasText(activity)) {
    lines.push(`    ${theme.fg("dim", `⎿  ${activity}`)}`);
  }
  for (const nested of formatNestedWidgetLines(step.children, theme, layout.width, {
    snapshotNow: job.updatedAt,
  })) {
    lines.push(`    ${nested}`);
  }
  if (step.status === "running") {
    lines.push(...runningStepLines(job, theme, step, { width: layout.width, activity }));
  }
  return lines;
}
function unattachedChildren(job: Job, theme: Theme, width: number): string[] {
  const attached = new Set(
    (job.steps ?? []).flatMap((step) => step.children?.map((child) => child.id) ?? []),
  );
  return formatNestedWidgetLines(
    job.nestedChildren?.filter((child) => !attached.has(child.id)),
    theme,
    width,
    { snapshotNow: job.updatedAt },
  ).map((line) => `  ${line}`);
}
function foregroundStyleWidgetDetails(job: Job, theme: Theme, width: number): string[] {
  const steps = job.steps ?? [];
  if (steps.length === 0) {
    return [
      `  ${theme.fg("dim", `⎿  ${widgetActivity(job)}`)}`,
      ...formatNestedWidgetLines(job.nestedChildren, theme, width, {
        snapshotNow: job.updatedAt,
      }).map((line) => `  ${line}`),
    ];
  }
  if (hasLogicalChainGroups(job)) {
    return widgetChainDetails(job, theme, width);
  }
  const total = job.stepsTotal ?? steps.length,
    title = job.mode === "parallel" || job.activeParallelGroup === true ? "Agent" : "Step";
  return [
    ...steps.flatMap((step, index) =>
      foregroundStyleWidgetStepLines(job, theme, step, { title, index: index + 1, total, width }),
    ),
    ...unattachedChildren(job, theme, width),
  ];
}
export function buildSingleWidgetLines(job: Job, theme: Theme, width: number): string[] {
  const stats = widgetStats(job, theme),
    mode = widgetJobName(job);
  const count =
    job.mode === "chain"
      ? job.chainStepCount
      : (job.stepsTotal ?? job.agents?.length ?? job.steps?.length);
  const title = `async subagent ${mode}${(count ?? 0) > 1 ? ` (${count ?? 0})` : ""}`;
  return [
    `${theme.fg("toolTitle", themeBold(theme, title))} ${theme.fg("dim", "· background")}`,
    `${widgetStatusGlyph(job, theme)} ${themeBold(theme, mode)}${hasText(stats) ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`,
    ...foregroundStyleWidgetDetails(job, theme, width),
  ].map((line) => truncLine(line, width));
}
export function collapsedJobRow(job: Job, theme: Theme, width: number): string {
  const stats = widgetStats(job, theme),
    running = job.steps?.filter((step) => step.status === "running") ?? [];
  const solo = running.length === 1 ? running[0] : undefined;
  let activity = widgetActivity(job, false);
  if (job.status === "running" && solo) {
    activity = widgetStepActivityLine(solo, width, false, job.updatedAt);
  }
  return `${widgetStatusGlyph(job, theme)} ${themeBold(theme, widgetJobName(job))}${hasText(stats) ? ` ${theme.fg("dim", "·")} ${stats}` : ""}${hasText(activity) ? ` ${theme.fg("dim", "·")} ${theme.fg("dim", activity)}` : ""}`;
}
