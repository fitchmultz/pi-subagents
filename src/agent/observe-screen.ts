import { rawKeyHint, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { type JournalTail, plainText } from "./journal-tail.ts";

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
  private move(data: string): void {
    const rows = this.data.inventory();
    const index = Math.max(
      0,
      rows.findIndex((row) => row.id === this.selected),
    );
    if (this.keys.matches(data, "tui.select.confirm")) {
      const row = rows.at(index);
      if (row) {
        this.open(row.id);
      }
    } else if (this.keys.matches(data, "tui.select.down")) {
      this.selected = rows[Math.min(rows.length - 1, index + 1)]?.id ?? "";
    } else if (this.keys.matches(data, "tui.select.up")) {
      this.selected = rows[Math.max(0, index - 1)]?.id ?? "";
    }
  }
  handleInput(data: string): void {
    if (this.keys.matches(data, "tui.select.cancel")) {
      if (this.watching) {
        this.watching = undefined;
        this.failure = "";
      } else {
        this.done();
      }
    } else if (!this.watching) {
      this.move(data);
    }
    this.update();
  }
  private listLines(height: number): string[] {
    const rows = this.data.inventory();
    const index = Math.max(
      0,
      rows.findIndex((row) => row.id === this.selected),
    );
    const size = Math.max(1, height - 1);
    const start = Math.max(0, index - size + 1);
    const page = rows.slice(start, start + size);
    return rows.length === 0
      ? ["No child runs to show. Completed runs are hidden."]
      : [
          `Runs ${start + 1}–${start + page.length} of ${rows.length} · active first`,
          ...page.map(
            (row, i) =>
              `${start + i === index ? ">" : " "} ${row.id.slice(0, 8)} ${row.status} · ${row.name}`,
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
      ? this.watchLines(height, this.watching, width)
      : this.listLines(height);
    const cancel = this.keys.getKeys("tui.select.cancel").join("/");
    const hint = this.watching
      ? `${rawKeyHint(cancel, "back")} · native published entries, not token deltas`
      : [
          rawKeyHint(
            [...this.keys.getKeys("tui.select.up"), ...this.keys.getKeys("tui.select.down")].join(
              "/",
            ),
            "select",
          ),
          rawKeyHint(this.keys.getKeys("tui.select.confirm").join("/"), "watch"),
          rawKeyHint(cancel, "close"),
        ].join(" · ");
    const error = this.failure.length > 0 ? this.failure : this.data.error();
    return [
      this.theme.fg(
        "accent",
        this.watching?.inherited === true
          ? "Agents · read-only · fork context"
          : "Agents · read-only",
      ),
      this.theme.fg("muted", this.data.status()),
      ...content,
      this.theme.fg("error", error),
      this.theme.fg("dim", hint),
    ].map((line) => truncateToWidth(line, width));
  }
  invalidate(): void {
    this.tui.requestRender();
  }
  dispose(): void {
    clearInterval(this.timer);
  }
}
