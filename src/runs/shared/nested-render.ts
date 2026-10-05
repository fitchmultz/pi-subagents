import { formatDuration, formatTokens, shortenPath } from "../../shared/formatters.ts";
import { formatActivityLabel, formatRunAction } from "../../shared/status-format.ts";
import type { ActivityState, NestedRunSummary } from "../../shared/types.ts";

export interface NestedRunCounts {
  total: number;
  running: number;
  paused: number;
  complete: number;
  failed: number;
  blocked: number;
  queued: number;
}

export function countNestedRuns(
  children: readonly NestedRunSummary[] | undefined,
): NestedRunCounts {
  const counts: NestedRunCounts = {
    total: 0,
    running: 0,
    paused: 0,
    complete: 0,
    failed: 0,
    blocked: 0,
    queued: 0,
  };
  for (const child of children ?? []) {
    counts.total++;
    counts[child.state]++;
    const nested = countNestedRuns([
      ...(child.children ?? []),
      ...(child.steps?.flatMap((step) => step.children ?? []) ?? []),
    ]);
    counts.total += nested.total;
    counts.running += nested.running;
    counts.paused += nested.paused;
    counts.complete += nested.complete;
    counts.failed += nested.failed;
    counts.blocked += nested.blocked;
    counts.queued += nested.queued;
  }
  return counts;
}

export function formatNestedAggregate(
  children: readonly NestedRunSummary[] | undefined,
): string | undefined {
  const counts = countNestedRuns(children);
  if (counts.total === 0) {
    return;
  }
  const parts = [
    counts.running > 0 ? `${counts.running} running` : "",
    counts.paused > 0 ? `${counts.paused} paused` : "",
    counts.failed > 0 ? `${counts.failed} failed` : "",
    counts.blocked > 0 ? `${counts.blocked} need human action` : "",
    counts.complete > 0 ? `${counts.complete} complete` : "",
    counts.queued > 0 ? `${counts.queued} queued` : "",
  ].filter(Boolean);
  return `+${counts.total} nested run${counts.total === 1 ? "" : "s"}${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`;
}

function nestedRunLabel(run: NestedRunSummary): string {
  if (run.agent !== undefined && run.agent !== "") {
    return run.agent;
  }
  const agents = run.agents ?? [];
  if (agents.length === 0) {
    return run.id;
  }
  if (agents.length === 1) {
    return agents[0] ?? run.id;
  }
  return `${agents.slice(0, 2).join(", ")}${agents.length > 2 ? ` +${agents.length - 2}` : ""}`;
}

interface ActivityObservation {
  readonly activityState?: ActivityState;
  readonly lastActivityAt?: number;
  readonly currentTool?: string;
  readonly currentToolStartedAt?: number;
  readonly currentPath?: string;
  readonly turnCount?: number;
  readonly toolCount?: number;
  readonly totalTokens?: NestedRunSummary["totalTokens"];
}
function toolActivity(input: ActivityObservation): string | undefined {
  if (input.currentTool === undefined || input.currentTool === "") {
    return;
  }
  if (input.currentToolStartedAt === undefined) {
    return `tool ${input.currentTool}`;
  }
  return `tool ${input.currentTool} ${formatDuration(Math.max(0, Date.now() - input.currentToolStartedAt))}`;
}
function formatNestedActivity(input: ActivityObservation): string | undefined {
  const tool = toolActivity(input);
  const path = input.currentPath;
  const facts = [
    tool,
    path !== undefined && path !== "" ? shortenPath(path) : undefined,
    input.turnCount !== undefined ? `${input.turnCount} turns` : undefined,
    input.toolCount !== undefined ? `${input.toolCount} tools` : undefined,
    input.totalTokens ? `${formatTokens(input.totalTokens.total)} tok` : undefined,
  ];
  const activity = formatActivityLabel(input.lastActivityAt, input.activityState);
  const text = [activity, ...facts].filter(Boolean).join(" | ");
  return text === "" ? undefined : text;
}

interface RenderOptions {
  readonly indent: string;
  readonly maxDepth: number;
  readonly maxLines: number;
  readonly commandHints?: boolean;
  readonly childSafe?: boolean;
}
interface RenderPosition {
  readonly depth: number;
  readonly indent: string;
}
function runLine(child: NestedRunSummary, indent: string): string {
  const activity = child.state === "running" ? formatNestedActivity(child) : undefined;
  return `${indent}↳ ${nestedRunLabel(child)} [${child.id}] ${child.state}${activity === undefined ? "" : ` | ${activity}`}${(child.error ?? "") !== "" ? ` | error: ${child.error ?? ""}` : ""}`;
}
function stepLine(
  step: NonNullable<NestedRunSummary["steps"]>[number],
  position: RenderPosition,
  index: number,
): string {
  const activity = step.status === "running" ? formatNestedActivity(step) : undefined;
  return `${position.indent}  ${index + 1}. ${step.agent} ${step.status}${activity === undefined ? "" : ` | ${activity}`}${(step.error ?? "") !== "" ? ` | error: ${step.error ?? ""}` : ""}`;
}

/** Owns one rendering budget; recursion cannot silently bypass depth or line limits. */
class NestedRunRenderer {
  readonly lines: string[] = [];
  private readonly options: RenderOptions;
  constructor(options: RenderOptions) {
    this.options = options;
  }
  private atLimit(): boolean {
    return this.lines.length >= this.options.maxLines;
  }
  private aggregate(items: readonly NestedRunSummary[] | undefined, indent: string): void {
    const aggregate = formatNestedAggregate(items);
    if (aggregate !== undefined && !this.atLimit()) {
      this.lines.push(`${indent}↳ ${aggregate}`);
    }
  }
  append(items: readonly NestedRunSummary[] | undefined, position: RenderPosition): void {
    if (items === undefined || items.length === 0 || this.atLimit()) {
      return;
    }
    if (position.depth > this.options.maxDepth) {
      this.aggregate(items, position.indent);
      return;
    }
    for (const [index, child] of items.entries()) {
      if (this.atLimit()) {
        const aggregate = formatNestedAggregate(items.slice(index));
        if (aggregate !== undefined) {
          this.lines[this.lines.length - 1] = `${position.indent}↳ ${aggregate}`;
        }
        return;
      }
      this.appendRun(child, position);
    }
  }
  private appendRun(child: NestedRunSummary, position: RenderPosition): void {
    this.lines.push(runLine(child, position.indent));
    if (this.options.commandHints === true && !this.atLimit()) {
      this.lines.push(
        `${position.indent}  Status: ${formatRunAction("status", child.id, {}, this.options.childSafe)}`,
      );
    }
    if (position.depth === this.options.maxDepth) {
      this.aggregate(
        [...(child.steps?.flatMap((step) => step.children ?? []) ?? []), ...(child.children ?? [])],
        `${position.indent}  `,
      );
      return;
    }
    this.appendSteps(child, position);
    this.append(child.children, { depth: position.depth + 1, indent: `${position.indent}  ` });
  }
  private appendSteps(child: NestedRunSummary, position: RenderPosition): void {
    for (const [index, step] of (child.steps ?? []).entries()) {
      if (this.atLimit()) {
        return;
      }
      this.lines.push(stepLine(step, position, index));
      this.append(step.children, { depth: position.depth + 1, indent: `${position.indent}    ` });
    }
  }
}

export function formatNestedRunStatusLines(
  children: readonly NestedRunSummary[] | undefined,
  options: {
    readonly indent?: string;
    readonly maxDepth?: number;
    readonly maxLines?: number;
    readonly commandHints?: boolean;
    readonly childSafe?: boolean;
  } = {},
): string[] {
  const renderer = new NestedRunRenderer({
    indent: options.indent ?? "  ",
    maxDepth: options.maxDepth ?? 2,
    maxLines: options.maxLines ?? 40,
    commandHints: options.commandHints ?? false,
    childSafe: options.childSafe,
  });
  renderer.append(children, { depth: 0, indent: options.indent ?? "  " });
  return renderer.lines;
}
