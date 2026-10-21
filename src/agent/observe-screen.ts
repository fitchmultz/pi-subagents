import { rawKeyHint, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  TruncatedText,
  sliceByColumn,
  visibleWidth,
  type Component,
  type TUI,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { type JournalTail, plainText } from "./journal-tail.ts";
import { actionText } from "../shared/tui-action.ts";

export type ObserverRow = {
  id: string;
  name: string;
  status: string;
  live: boolean;
  createdAt: number;
};
export type Watch = { tail: JournalTail; file: string; id: string; inherited: boolean };
export interface ObserverData {
  inventory: () => ObserverRow[];
  checking: () => boolean;
  row: (id: string) => ObserverRow | undefined;
  status: () => string;
  error: () => string;
  watch: (id: string) => Watch;
}
export class ObserverScreen {
  private selected: string;
  private watching?: Watch;
  private failure = "";
  private readonly data: ObserverData;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keys: KeybindingsManager;
  private readonly done: () => void;
  private readonly timer: NodeJS.Timeout;
  private readonly content = new Container();
  constructor(options: {
    data: ObserverData;
    tui: TUI;
    theme: Theme;
    keys: KeybindingsManager;
    done: () => void;
    selected: string;
  }) {
    this.data = options.data;
    this.tui = options.tui;
    this.theme = options.theme;
    this.keys = options.keys;
    this.done = options.done;
    this.selected = options.selected;
    if (this.selected.length > 0) {
      this.open(this.selected);
    }
    this.timer = setInterval(() => this.update(), 250);
    this.timer.unref();
    this.update();
  }
  private open(id: string): void {
    try {
      this.watching = this.data.watch(id);
      this.selected = this.watching.id;
      this.failure = "";
    } catch (error) {
      this.failure = error instanceof Error ? plainText(error.message) : "Journal unavailable.";
    }
  }
  update(): void {
    this.watching?.tail.poll();
    this.tui.requestRender();
  }
  private select(direction: number): void {
    const rows = this.data.inventory();
    const index = Math.max(
      0,
      rows.findIndex((row) => row.id === this.selected),
    );
    this.selected = rows[Math.max(0, Math.min(rows.length - 1, index + direction))]?.id ?? "";
  }
  private confirm(): void {
    this.select(0);
    if (this.selected.length > 0) {
      this.open(this.selected);
    }
  }
  private move(data: string): void {
    if (this.keys.matches(data, "tui.select.confirm")) {
      this.confirm();
    } else if (this.keys.matches(data, "tui.select.down")) {
      this.select(1);
    } else if (this.keys.matches(data, "tui.select.up")) {
      this.select(-1);
    }
  }
  handleInput(data: string): void {
    if (this.keys.matches(data, "tui.select.cancel")) {
      this.back();
    } else if (!this.watching) {
      this.move(data);
    }
    this.update();
  }
  private back(): void {
    if (this.watching) {
      this.watching = undefined;
      this.failure = "";
    } else {
      this.done();
    }
  }
  handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
    return this.content.handleMouse(event);
  }
  private listLines(height: number): Component[] {
    const rows = this.data.inventory();
    const index = Math.max(
      0,
      rows.findIndex((row) => row.id === this.selected),
    );
    const size = Math.max(1, height - 1);
    const start = Math.max(0, index - size + 1);
    const page = rows.slice(start, start + size);
    if (rows.length === 0) {
      return [
        new TruncatedText(
          this.data.checking()
            ? "Checking saved child runs…"
            : "No child runs to show. Completed runs are hidden.",
          0,
          0,
        ),
      ];
    }
    return [
      new TruncatedText(
        `Runs ${start + 1}–${start + page.length} of ${rows.length} · active first`,
        0,
        0,
      ),
      ...page.map((row, i) =>
        actionText(
          `${start + i === index ? ">" : " "} ${row.id.slice(0, 8)} ${row.status} · ${row.name}`,
          () => {
            this.open(row.id);
            this.update();
          },
        ),
      ),
    ];
  }
  private journalPath(width: number, file: string): string {
    const text = plainText(file.slice(-2048), 2048);
    const size = visibleWidth(text);
    const room = Math.max(0, width - 1);
    return size > width ? `…${sliceByColumn(text, size - room, room)}` : text;
  }
  private watchLines(height: number, watch: Watch, width: number): string[] {
    const row = this.data.row(this.selected);
    return [
      `${this.selected.slice(0, 8)} ${row?.status ?? "checking"} · ${row?.name ?? this.selected}`,
      this.journalPath(width, watch.file),
      ...(watch.inherited ? ["Fork context: includes inherited parent activity."] : []),
      ...watch.tail.lines.slice(-Math.max(1, height - 3)),
      watch.tail.notice,
    ];
  }
  render(width: number): string[] {
    const height = Math.max(1, Math.min(16, this.tui.terminal.rows - 9));
    const content = this.watching
      ? this.watchLines(height, this.watching, width).map((line) => new TruncatedText(line, 0, 0))
      : this.listLines(height);
    const hint = (
      key: "tui.select.cancel" | "tui.select.up" | "tui.select.down" | "tui.select.confirm",
      label: string,
      action: () => void,
    ): { text: string; action?: () => void } => ({
      text: rawKeyHint(this.keys.getKeys(key)[0] ?? "", label),
      action,
    });
    const hints = this.watching
      ? [
          hint("tui.select.cancel", "back", () => this.back()),
          { text: "native published entries, not token deltas" },
        ]
      : [
          hint("tui.select.up", "up", () => this.select(-1)),
          hint("tui.select.down", "down", () => this.select(1)),
          hint("tui.select.confirm", "watch", () => this.confirm()),
          hint("tui.select.cancel", "close", () => this.back()),
        ];
    const error = this.failure.length > 0 ? this.failure : this.data.error();
    this.content.clear();
    this.content.addChild(
      new TruncatedText(
        this.theme.fg(
          "accent",
          this.watching?.inherited === true
            ? "Agents · read-only · fork context"
            : "Agents · read-only",
        ),
        0,
        0,
      ),
    );
    this.content.addChild(new TruncatedText(this.theme.fg("muted", this.data.status()), 0, 0));
    for (const component of content) {
      this.content.addChild(component);
    }
    this.content.addChild(new TruncatedText(this.theme.fg("error", error), 0, 0));
    this.content.addChild(
      actionText(this.theme.fg("dim", hints.map((item) => item.text).join("  ")), (column) => {
        let start = 0;
        for (const item of hints) {
          const end = start + visibleWidth(item.text);
          if (column >= start && column < end) {
            item.action?.();
            this.update();
            return;
          }
          start = end + 2;
        }
      }),
    );
    return this.content.render(width);
  }
  invalidate(): void {
    this.tui.requestRender();
  }
  dispose(): void {
    clearInterval(this.timer);
  }
}
