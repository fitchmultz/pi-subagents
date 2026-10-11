import { hasText } from "./text-values.ts";
import { activityFacts, joinActivity } from "./activity-lines.ts";
import type { ReadonlyInput, NestedRunSummary, NestedStepSummary } from "../shared/types.ts";
import { formatNestedAggregate } from "../runs/shared/nested-render.ts";
import { formatWidgetAgents } from "./widget-status.ts";
import {
  type Theme,
  runningGlyph,
  runningSeed,
  buildLiveStatusLine,
  truncLine,
} from "./display.ts";

function nestedRunName(run: ReadonlyInput<NestedRunSummary>): string {
  if (hasText(run.agent)) {
    return run.agent;
  }
  if ((run.agents?.length ?? 0) > 0) {
    return formatWidgetAgents(run.agents ?? []);
  }
  return run.id;
}

function nestedStatusGlyph(
  state: ReadonlyInput<NestedRunSummary["state"] | NestedStepSummary["status"]>,
  theme: Theme,
  seed?: number,
): string {
  if (state === "running") {
    return theme.fg("accent", runningGlyph(seed));
  }
  if (state === "complete" || state === "completed") {
    return theme.fg("success", "✓");
  }
  if (state === "failed") {
    return theme.fg("error", "✗");
  }
  if (state === "blocked") {
    return theme.fg("warning", "■");
  }
  if (state === "paused") {
    return theme.fg("warning", "■");
  }
  return theme.fg("muted", "◦");
}

function nestedRunSeed(run: ReadonlyInput<NestedRunSummary>): number | undefined {
  return runningSeed(
    run.lastUpdate,
    run.lastActivityAt,
    run.currentStep,
    run.toolCount,
    run.turnCount,
    run.totalTokens?.total,
    run.currentToolStartedAt,
  );
}

function nestedActivity(
  input: ReadonlyInput<
    Pick<
      NestedRunSummary | NestedStepSummary,
      | "activityState"
      | "lastActivityAt"
      | "currentTool"
      | "currentToolStartedAt"
      | "currentPath"
      | "turnCount"
      | "toolCount"
    >
  >,
  state: NestedRunSummary["state"] | NestedStepSummary["status"],
  snapshotNow?: number,
): string {
  const facts = activityFacts(input, snapshotNow);
  const fallback: Readonly<
    Record<NestedRunSummary["state"] | NestedStepSummary["status"], string>
  > = {
    running: "thinking…",
    queued: "queued…",
    pending: "queued…",
    blocked: "Needs your action",
    paused: "Paused",
    failed: "Failed",
    complete: "Done",
    completed: "Done",
    "timed-out": "Failed",
  };
  return joinActivity(facts, buildLiveStatusLine(input, snapshotNow), fallback[state]);
}

class NestedLines {
  private readonly lines: string[] = [];
  private readonly theme: Theme;
  private readonly width: number;
  private readonly now: number | undefined;
  private readonly budget: number;
  constructor(
    theme: Theme,
    width: number,
    options: { readonly snapshotNow?: number; readonly lineBudget?: number },
  ) {
    this.theme = theme;
    this.width = width;
    this.now = options.snapshotNow;
    this.budget = options.lineBudget ?? 12;
  }
  render(children: ReadonlyInput<NestedRunSummary[]> | undefined): string[] {
    this.append(children, 0, "");
    return this.lines.map((line) => truncLine(line, this.width));
  }
  private aggregate(
    items: ReadonlyInput<NestedRunSummary[]>,
    prefix: string,
    replace = false,
  ): void {
    const aggregate = formatNestedAggregate(items);
    if (!hasText(aggregate)) {
      return;
    }
    const line = this.theme.fg("dim", `${prefix}↳ ${aggregate}`);
    if (replace) {
      this.lines[this.lines.length - 1] = line;
    } else if (this.lines.length < this.budget) {
      this.lines.push(line);
    }
  }
  private append(
    items: ReadonlyInput<NestedRunSummary[]> | undefined,
    depth: number,
    prefix: string,
  ): void {
    if (!items || items.length === 0 || this.lines.length >= this.budget) {
      return;
    }
    if (depth > 2) {
      this.aggregate(items, prefix);
      return;
    }
    for (const [index, child] of items.entries()) {
      if (this.lines.length >= this.budget) {
        this.aggregate(items.slice(index), prefix, true);
        return;
      }
      this.child(child, depth, prefix);
    }
  }
  private child(child: ReadonlyInput<NestedRunSummary>, depth: number, prefix: string): void {
    const now = this.now ?? child.lastUpdate;
    const activity = nestedActivity(child, child.state, now),
      error = hasText(child.error) ? ` · ${child.error}` : "";
    this.lines.push(
      this.theme.fg(
        "dim",
        `${prefix}↳ ${nestedStatusGlyph(child.state, this.theme, nestedRunSeed(child))} ${nestedRunName(child)} · ${child.state} · ${activity}${error}`,
      ),
    );
    if (depth === 2) {
      this.aggregate(
        [...(child.steps?.flatMap((step) => step.children ?? []) ?? []), ...(child.children ?? [])],
        `${prefix}  `,
      );
      return;
    }
    for (const step of child.steps ?? []) {
      if (this.lines.length >= this.budget) {
        return;
      }
      this.lines.push(
        this.theme.fg(
          "dim",
          `${prefix}  ↳ ${nestedStatusGlyph(step.status, this.theme)} ${step.agent} · ${step.status} · ${nestedActivity(step, step.status, now)}`,
        ),
      );
      this.append(step.children, depth + 1, `${prefix}    `);
    }
    this.append(child.children, depth + 1, `${prefix}  `);
  }
}

/** Expanded-only, bounded tree layout. The local renderer owns its line budget. */
export function formatNestedWidgetLines(
  children: ReadonlyInput<NestedRunSummary[] | undefined>,
  theme: Theme,
  width: number,
  options: { readonly snapshotNow?: number; readonly lineBudget?: number } = {},
): string[] {
  if (!children || children.length === 0 || (options.lineBudget ?? 12) <= 0) {
    return [];
  }
  return new NestedLines(theme, width, options).render(children);
}
