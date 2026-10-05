import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import {
  MAX_WIDGET_JOBS,
  WIDGET_KEY,
  type AsyncJobState,
  type ReadonlyInput,
} from "../shared/types.ts";
import { isTuiContext } from "../shared/ui-mode.ts";
import { truncLine, getTermWidth, themeBold, runningGlyph, type Theme } from "./display.ts";
import {
  buildSingleWidgetLines,
  collapsedJobRow,
  widgetParallelAgentDetails,
} from "./widget-details.ts";
import {
  widgetStats,
  widgetStatusGlyph,
  widgetJobName,
  widgetActivity,
  widgetJobsRunningSeed,
} from "./widget-status.ts";
import { hasText } from "./text-values.ts";
type Job = ReadonlyInput<AsyncJobState>;
type WidgetItem =
  | { readonly kind: "job"; readonly job: Job }
  | { readonly kind: "queued"; readonly count: number }
  | {
      readonly kind: "hidden";
      readonly running: number;
      readonly queued: number;
      readonly finished: number;
    };
interface JobGroups {
  readonly running: readonly Job[];
  readonly queued: readonly Job[];
  readonly finished: readonly Job[];
}
function groups(jobs: readonly Job[]): JobGroups {
  return {
    running: jobs.filter((job) => job.status === "running"),
    queued: jobs.filter((job) => job.status === "queued"),
    finished: jobs.filter((job) => job.status !== "running" && job.status !== "queued"),
  };
}
function queuedItem(jobs: readonly Job[], expanded: boolean): WidgetItem {
  const first = jobs[0];
  return jobs.length === 1 && !expanded && first
    ? { kind: "job", job: first }
    : { kind: "queued", count: jobs.length };
}
function selectItems(input: JobGroups, expanded: boolean): WidgetItem[] {
  const shownRunning = input.running.slice(0, MAX_WIDGET_JOBS),
    items: WidgetItem[] = shownRunning.map((job) => ({ kind: "job", job }));
  let slots = MAX_WIDGET_JOBS - items.length,
    queuedShown = false;
  if (input.queued.length > 0 && slots > 0) {
    items.push(queuedItem(input.queued, expanded));
    slots--;
    queuedShown = true;
  }
  const shownFinished = input.finished.slice(0, slots);
  items.push(...shownFinished.map((job): WidgetItem => ({ kind: "job", job })));
  const running = input.running.length - shownRunning.length,
    finished = input.finished.length - shownFinished.length,
    queued = queuedShown ? 0 : input.queued.length;
  if (running + finished + queued > 0) {
    items.push({ kind: "hidden", running, finished, queued });
  }
  return items;
}
function hiddenLabel(item: Extract<WidgetItem, { kind: "hidden" }>): string {
  const parts: string[] = [];
  if (item.running > 0) {
    parts.push(`${item.running} running`);
  }
  if (item.queued > 0) {
    parts.push(`${item.queued} queued`);
  }
  if (item.finished > 0) {
    parts.push(`${item.finished} finished`);
  }
  return `+${item.running + item.finished + item.queued} more (${parts.join(", ")})`;
}
function jobLines(job: Job, theme: Theme, width: number, expanded: boolean): string[] {
  if (!expanded) {
    return [collapsedJobRow(job, theme, width)];
  }
  const stats = widgetStats(job, theme);
  return [
    `${widgetStatusGlyph(job, theme)} ${themeBold(theme, widgetJobName(job))}${hasText(stats) ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`,
    `  ${theme.fg("dim", `⎿  ${widgetActivity(job)}`)}`,
    ...widgetParallelAgentDetails(job, theme, width),
  ];
}
function itemLines(item: WidgetItem, theme: Theme, width: number, expanded: boolean): string[] {
  switch (item.kind) {
    case "job":
      return jobLines(item.job, theme, width, expanded);
    case "queued":
      return [`${theme.fg("muted", "◦")} ${theme.fg("dim", `${item.count} queued`)}`];
    case "hidden":
      return [theme.fg("dim", hiddenLabel(item))];
  }
}
function treeLines(items: readonly (readonly string[])[], theme: Theme, width: number): string[] {
  const lines: string[] = [];
  for (const [index, item] of items.entries()) {
    const last = index === items.length - 1,
      branch = last ? "└─" : "├─",
      continuation = last ? "   " : "│  ";
    lines.push(truncLine(`${theme.fg("dim", branch)} ${item[0] ?? ""}`, width));
    for (const detail of item.slice(1)) {
      lines.push(truncLine(`${theme.fg("dim", continuation)} ${detail}`, width));
    }
  }
  return lines;
}
function header(input: JobGroups, theme: Theme, hint: string): string {
  const active = input.running.length > 0 || input.queued.length > 0;
  let glyph = active ? "●" : "○";
  if (input.running.length > 0) {
    glyph = runningGlyph(widgetJobsRunningSeed(input.running));
  }
  const color = active ? "accent" : "dim";
  return `${theme.fg(color, glyph)} ${theme.fg(color, "Async agents")} ${theme.fg("dim", "· background")}${hint}`;
}
export function buildWidgetLines(
  jobs: readonly Job[],
  theme: Theme,
  width = getTermWidth(),
  expanded = false,
): string[] {
  if (jobs.length === 0) {
    return [];
  }
  const first = jobs[0];
  if (jobs.length === 1 && expanded && first) {
    return buildSingleWidgetLines(first, theme, width);
  }
  const input = groups(jobs),
    items = selectItems(input, expanded).map((item) => itemLines(item, theme, width, expanded));
  const hint =
    input.running.length > 0 && !expanded
      ? ` ${theme.fg("dim", "·")} ${theme.fg("accent", "Ctrl+O")}`
      : "";
  if (items.length === 1 && !expanded) {
    return [truncLine(`${items[0]?.[0] ?? ""}${hint}`, width)];
  }
  return [truncLine(header(input, theme, hint), width), ...treeLines(items, theme, width)];
}
function fitWidgetLineBudget(
  lines: readonly string[],
  theme: Theme,
  width: number,
  expanded: boolean,
): string[] {
  const rows = process.stdout.rows > 0 ? process.stdout.rows : 30;
  const budget = expanded ? Math.max(4, Math.min(24, Math.floor(rows * 0.4))) : MAX_WIDGET_JOBS + 2;
  if (lines.length <= budget) {
    return [...lines];
  }
  const visible = Math.max(1, budget - 1),
    hidden = lines.length - visible;
  const hint = expanded
    ? `… ${hidden} live-detail lines hidden`
    : `… ${hidden} lines hidden · Ctrl+O expands`;
  return [...lines.slice(0, visible), truncLine(theme.fg("dim", hint), width)];
}
function buildWidgetComponent(
  jobs: readonly Job[],
  isExpanded: () => boolean,
): (_tui: unknown, theme: Theme) => Component {
  return (_tui, theme) => ({
    render(availableWidth) {
      const width = Math.max(1, availableWidth - 2),
        expanded = isExpanded(),
        container = new Container();
      const lines = fitWidgetLineBudget(
        buildWidgetLines(jobs, theme, width, expanded),
        theme,
        width,
        expanded,
      );
      for (const line of lines) {
        container.addChild(new Text(line, 1, 0));
      }
      return container.render(availableWidth);
    },
    invalidate() {
      /* This widget rebuilds its small live layout from current facts on each render. */
    },
  });
}
export function renderWidget(ctx: ExtensionContext, jobs: readonly Job[]): void {
  if (!isTuiContext(ctx)) {
    return;
  }
  if (jobs.length === 0) {
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    return;
  }
  ctx.ui.setWidget(
    WIDGET_KEY,
    buildWidgetComponent(jobs, () => ctx.ui.getToolsExpanded()),
  );
}
