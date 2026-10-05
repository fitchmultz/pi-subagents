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
export class AgentDock {
  private hits: Array<{ start: number; end: number; key?: string; unpin?: boolean; row: number }> =
    [];
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
          /* Rendering reads current theme and source every time. */
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
  private render(width: number): string[] {
    this.hits = [];
    const active = this.source
      .tasks()
      .filter(
        (task) => task.child.state === "live" || task.child.state === "blocked" || task.question,
      )
      .map((task) => ({
        task,
        state:
          task.child.state === "blocked" || task.question?.state === "awaiting_input"
            ? "needs action"
            : task.child.activity?.status === "pending" || task.question?.state === "answer_pending"
              ? "waiting"
              : "running",
      }));
    if (!((active.length ?? 0) > 0)) {
      if (
        !hasText(this.source.error()) &&
        !this.source.loading() &&
        this.source.page()?.freshness.state !== "catching-up"
      ) {
        return [];
      }
      const label = hasText(this.source.error())
        ? "Agents history unavailable · /agents to retry"
        : "Agents · loading history…";
      this.hits.push({ start: 0, end: width, row: 0 });
      return [
        truncateToWidth(
          this.theme.fg(hasText(this.source.error()) ? "warning" : "dim", label),
          width,
        ),
      ];
    }
    const running = active.filter((row) => row.state === "running").length;
    const waiting = active.filter((row) => row.state === "waiting").length;
    const needsAction = active.filter((row) => row.state === "needs action").length;
    const counts = `${running} running${waiting ? ` · ${waiting} waiting` : ""}${needsAction ? ` · ${needsAction} needs action` : ""}`;
    const hint = readableText(rawKeyHint(this.source.shortcut, "")).trim();
    const entrance = `${this.theme.fg("accent", this.theme.bold("Agents"))} · ${this.theme.fg(running ? "success" : "muted", counts)} ${this.theme.fg("dim", `[${hint}]`)}`;
    const lines = [truncateToWidth(entrance, width)];
    this.hits.push({ start: 0, end: Math.min(width, visibleWidth(entrance)), row: 0 });
    const visible = active.slice(
      0,
      Math.max(1, Math.min(4, Math.floor(this.tui.terminal.rows / 5))),
    );
    const pinned = this.source.pinned();
    const details = this.source.expanded()
      ? buildWidgetLines([...this.source.jobs()], this.theme, width, true)
      : [];
    // MainScreen repaints all scrollback if an offscreen row's ANSI changes.
    const pulseFrom =
      this.tui.mode === "regular"
        ? visible.length +
          details.length +
          Number(Boolean(pinned)) +
          Number(visible.length < active.length) +
          (this.source.below() ?? []).reduce(
            (height, child) => height + child.render(width).length,
            0,
          ) -
          this.tui.terminal.rows
        : 0;
    for (const [index, { task, state }] of visible.entries()) {
      const color = state === "running" ? "success" : state === "waiting" ? "dim" : "warning";
      const symbol = state === "running" ? "●" : state === "waiting" ? "◷" : "!";
      const indicator =
        state === "running" && index >= pulseFrom
          ? runningIndicator(this.theme)
          : this.theme.fg(color, symbol);
      const { status, badge } = taskSummary(task);
      const statusText = status === "working" ? "" : this.theme.fg(color, ` · ${status}`);
      const available = width - visibleWidth(statusText + badge) - 4;
      const modelWidth = available - Math.min(30, visibleWidth(task.label)) - 3;
      const model = modelWidth >= 16 ? ` · ${short(task.model.summary, modelWidth)}` : "";
      const label = short(task.label, Math.max(1, available - visibleWidth(model)));
      this.hits.push({ start: 0, end: width, row: lines.length, key: task.key });
      lines.push(
        truncateToWidth(
          `  ${indicator} ${this.theme.bold(label)}${statusText}${this.theme.fg("accent", badge)}${this.theme.fg("dim", model)}`,
          width,
        ),
      );
    }
    if (visible.length < active.length) {
      const more = `  +${active.length - visible.length} more · /agents`,
        line = truncateToWidth(more, width, "...");
      this.hits.push({
        start: 2,
        end: visibleWidth(line) - (visibleWidth(more) > width ? 3 : 0),
        row: lines.length,
      });
      lines.push(this.theme.fg("dim", line));
    }
    if (pinned) {
      const preview =
        pinned.child.identityUnavailable === true
          ? UNAVAILABLE_ASSIGNMENT
          : pinned.child.state === "live"
            ? activity(pinned)
            : (pinned.child.result && nonemptyText(getSingleResultOutput(pinned.child.result))) ||
              pinned.history.findLast((item) => item.kind === "assistant")?.text ||
              activity(pinned);
      const unpin = "[Unpin] ",
        row = lines.length;
      lines.push(
        this.theme.fg(
          "dim",
          truncateToWidth(
            `${unpin}Pinned · ${pinned.child.state === "completed" ? "finished · " : ""}${short(pinned.label, 30)}: ${short(preview, width)}`,
            width,
          ),
        ),
      );
      this.hits.push(
        { start: 0, end: unpin.length, row, unpin: true },
        { start: unpin.length, end: width, row, key: pinned.key },
      );
    }
    lines.push(...details);
    return lines;
  }
}
