import { hasText, nonemptyText } from "./text-values.ts";
import { type Theme, rawKeyHint } from "@earendil-works/pi-coding-agent";
import {
  MouseRegion,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import type { ReadonlyInput, AsyncJobState, HistoryRunPage } from "../shared/types.ts";
import { getSingleResultOutput } from "../shared/utils.ts";
import { readableText } from "./agent-history.ts";
import { buildWidgetLines } from "./render.ts";
import {
  UNAVAILABLE_ASSIGNMENT,
  activity,
  short,
  taskSummary,
  runningIndicator,
  type AgentTask,
} from "./view-model.ts";
interface DockSource {
  readonly tasks: () => readonly AgentTask[];
  readonly pinned: () => AgentTask | undefined;
  readonly page: () => ReadonlyInput<HistoryRunPage> | undefined;
  readonly error: () => string | undefined;
  readonly loading: () => boolean;
  readonly jobs: () => ReadonlyInput<AsyncJobState[]>;
  readonly expanded: () => boolean;
  readonly below: () => readonly Component[];
  readonly shortcut: string;
  readonly live: () => boolean;
  readonly unpin: () => void;
  readonly open: (key?: string) => void;
}
type DockState = "needs action" | "waiting" | "running";
interface DockRow {
  readonly task: Readonly<AgentTask>;
  readonly state: DockState;
}
interface Hit {
  readonly start: number;
  readonly end: number;
  readonly key?: string;
  readonly unpin?: boolean;
  readonly row: number;
}
const STYLES = {
  running: { color: "success", symbol: "●" },
  waiting: { color: "dim", symbol: "◷" },
  "needs action": { color: "warning", symbol: "!" },
} as const;
function dockState(task: Readonly<AgentTask>): DockState {
  if (task.child.state === "blocked" || task.question?.state === "awaiting_input") {
    return "needs action";
  }
  return task.child.activity?.status === "pending" || task.question?.state === "answer_pending"
    ? "waiting"
    : "running";
}
function pinnedPreview(task: Readonly<AgentTask>): string {
  if (task.child.identityUnavailable === true) {
    return UNAVAILABLE_ASSIGNMENT;
  }
  if (task.child.state === "live") {
    return activity(task);
  }
  const result = task.child.result;
  return (
    (result && nonemptyText(getSingleResultOutput(result))) ??
    nonemptyText(task.history.findLast((item) => item.kind === "assistant")?.text) ??
    activity(task)
  );
}
export class AgentDock {
  private hits: Hit[] = [];
  readonly component: Component;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly source: DockSource;
  constructor(tui: TUI, theme: Theme, source: DockSource) {
    this.tui = tui;
    this.theme = theme;
    this.source = source;
    this.component = new MouseRegion(
      {
        render: (width) => this.render(width),
        invalidate() {
          /* Current source/theme are read on every render. */
        },
      },
      (event) => {
        if (tui.mode !== "fullscreen" || event.button !== "left" || !source.live()) {
          return;
        }
        const hit = this.hits.find(
          (candidate) =>
            candidate.row === event.y && event.x >= candidate.start && event.x < candidate.end,
        );
        if (!hit) {
          return;
        }
        if (event.type === "press") {
          return { handled: true };
        }
        if (event.type !== "click") {
          return;
        }
        if (hit.unpin === true) {
          source.unpin();
        } else {
          source.open(hit.key);
        }
        return { handled: true };
      },
    );
  }
  private empty(width: number): string[] {
    const failed = hasText(this.source.error());
    if (
      !failed &&
      !this.source.loading() &&
      this.source.page()?.freshness.state !== "catching-up"
    ) {
      return [];
    }
    const label = failed
      ? "Agents history unavailable · /agents to retry"
      : "Agents · loading history…";
    this.hits.push({ start: 0, end: width, row: 0 });
    return [truncateToWidth(this.theme.fg(failed ? "warning" : "dim", label), width)];
  }
  private heading(active: readonly DockRow[], width: number): string {
    const running = active.filter((row) => row.state === "running").length;
    const waiting = active.filter((row) => row.state === "waiting").length;
    const needsAction = active.filter((row) => row.state === "needs action").length;
    const counts = `${running} running${waiting > 0 ? ` · ${waiting} waiting` : ""}${needsAction > 0 ? ` · ${needsAction} needs action` : ""}`;
    const hint = readableText(rawKeyHint(this.source.shortcut, "")).trim();
    const entrance = `${this.theme.fg("accent", this.theme.bold("Agents"))} · ${this.theme.fg(running > 0 ? "success" : "muted", counts)} ${this.theme.fg("dim", `[${hint}]`)}`;
    this.hits.push({ start: 0, end: Math.min(width, visibleWidth(entrance)), row: 0 });
    return truncateToWidth(entrance, width);
  }
  private pulseFrom(rows: number, width: number): number {
    if (this.tui.mode !== "regular") {
      return 0;
    }
    // MainScreen repaints all scrollback if an offscreen row's ANSI changes.
    return (
      rows +
      this.source.below().reduce((height, child) => height + child.render(width).length, 0) -
      this.tui.terminal.rows
    );
  }
  private row(row: DockRow, width: number, pulse: boolean): string {
    const { task, state } = row,
      { color, symbol } = STYLES[state];
    const indicator =
      state === "running" && pulse ? runningIndicator(this.theme) : this.theme.fg(color, symbol);
    const { status, badge } = taskSummary(task);
    const statusText = status === "working" ? "" : this.theme.fg(color, ` · ${status}`);
    const available = width - visibleWidth(statusText + badge) - 4;
    const modelWidth = available - Math.min(30, visibleWidth(task.label)) - 3;
    const model = modelWidth >= 16 ? ` · ${short(task.model.summary, modelWidth)}` : "";
    const label = short(task.label, Math.max(1, available - visibleWidth(model)));
    return truncateToWidth(
      `  ${indicator} ${this.theme.bold(label)}${statusText}${this.theme.fg("accent", badge)}${this.theme.fg("dim", model)}`,
      width,
    );
  }
  private more(count: number, width: number, row: number): string | undefined {
    if (count <= 0) {
      return;
    }
    const more = `  +${count} more · /agents`,
      line = truncateToWidth(more, width, "...");
    this.hits.push({
      start: 2,
      end: visibleWidth(line) - (visibleWidth(more) > width ? 3 : 0),
      row,
    });
    return this.theme.fg("dim", line);
  }
  private pin(
    task: Readonly<AgentTask> | undefined,
    width: number,
    row: number,
  ): string | undefined {
    if (!task) {
      return;
    }
    const unpin = "[Unpin] ";
    const text = this.theme.fg(
      "dim",
      truncateToWidth(
        `${unpin}Pinned · ${task.child.state === "completed" ? "finished · " : ""}${short(task.label, 30)}: ${short(pinnedPreview(task), width)}`,
        width,
      ),
    );
    this.hits.push(
      { start: 0, end: unpin.length, row, unpin: true },
      { start: unpin.length, end: width, row, key: task.key },
    );
    return text;
  }
  private render(width: number): string[] {
    this.hits = [];
    const active = this.source
      .tasks()
      .filter(
        (task) =>
          task.child.state === "live" ||
          task.child.state === "blocked" ||
          task.question !== undefined,
      )
      .map((task) => ({ task, state: dockState(task) }));
    if (active.length === 0) {
      return this.empty(width);
    }
    const lines = [this.heading(active, width)];
    const visible = active.slice(
      0,
      Math.max(1, Math.min(4, Math.floor(this.tui.terminal.rows / 5))),
    );
    const pinned = this.source.pinned();
    const details = this.source.expanded()
      ? buildWidgetLines([...this.source.jobs()], this.theme, width, true)
      : [];
    const pulse = this.pulseFrom(
      visible.length +
        details.length +
        Number(pinned !== undefined) +
        Number(visible.length < active.length),
      width,
    );
    for (const [index, row] of visible.entries()) {
      this.hits.push({ start: 0, end: width, row: lines.length, key: row.task.key });
      lines.push(this.row(row, width, index >= pulse));
    }
    const more = this.more(active.length - visible.length, width, lines.length);
    if (more !== undefined) {
      lines.push(more);
    }
    const pin = this.pin(pinned, width, lines.length);
    if (pin !== undefined) {
      lines.push(pin);
    }
    lines.push(...details);
    return lines;
  }
}
