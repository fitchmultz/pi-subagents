import { hasText, errorText } from "./text-values.ts";
import { DynamicBorder, getSelectListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Box,
  Container,
  Input,
  SelectList,
  Spacer,
  Text,
  getKeybindings,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type TUI,
} from "@earendil-works/pi-tui";
import { readableText } from "./agent-history.ts";
import { actionHints } from "./action-hints.ts";
import type { PickerController } from "./view-ports.ts";
import { short, activity, primaryKey } from "./view-model.ts";
import { pickerPage, type PickerPage } from "./picker-page.ts";
export class AgentPicker extends Container {
  private list?: SelectList;
  private itemKeys: string[] = [];
  private closed = false;
  private readonly search: Input;
  private signature = "";
  private wasPending = false;
  private retryError?: string;
  private hasFocus = false;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly controller: PickerController;
  private readonly done: (key?: string) => void;
  constructor(tui: TUI, theme: Theme, controller: PickerController, done: (key?: string) => void) {
    super();
    this.tui = tui;
    this.theme = theme;
    this.controller = controller;
    this.done = done;
    this.search = new Input({
      placeholder: "Filter agents or assignments…",
      placeholderStyle: (text) => theme.fg("dim", text),
    });
    this.search.setValue(controller.listFilter);
    this.render(tui.terminal.columns);
  }
  get focused(): boolean {
    return this.hasFocus;
  }
  set focused(value: boolean) {
    this.hasFocus = value;
    this.search.focused = value;
  }
  refresh(): void {
    this.tui.requestRender();
  }
  private retry(): void {
    this.retryError = undefined;
    this.controller.retry().catch((error: unknown) => {
      if (!this.closed) {
        this.retryError = errorText(error);
        this.tui.requestRender();
      }
    });
  }
  private header(page: PickerPage, width: number, compact: boolean): Container {
    const header = new Container(),
      list = this.controller.listPage;
    header.addChild(
      new Text(
        this.theme.fg(
          "accent",
          this.theme.bold(
            truncateToWidth(
              `Agents · ${list?.total ?? "…"} owned runs · page ${Math.floor((list?.offset ?? 0) / 50) + 1}`,
              width,
            ),
          ),
        ),
        0,
        0,
      ),
    );
    header.addChild(this.search);
    const status = this.retryError ?? page.status;
    if (hasText(status)) {
      header.addChild(
        new Text(
          this.theme.fg(
            hasText(this.controller.listError) || this.retryError !== undefined ? "warning" : "dim",
            truncateToWidth(status, width),
          ),
          0,
          0,
        ),
      );
    }
    if (!compact) {
      header.addChild(new Spacer(1));
    }
    return header;
  }
  private controls(width: number, compact: boolean): ReturnType<typeof actionHints> {
    const up = primaryKey("tui.select.up"),
      down = primaryKey("tui.select.down");
    const choose = [
      { text: up, run: () => this.act("up") },
      hasText(up) && hasText(down) ? "/" : "",
      { text: `${down}${compact ? "" : " Choose"}`, run: () => this.act("down") },
    ];
    const open = {
      text: `${primaryKey("tui.select.confirm")}${compact ? "" : " Open"}`.trim(),
      run: () => this.act("open"),
    };
    const back = {
      text: `${primaryKey("tui.select.cancel")}${compact ? "" : " Back"}`.trim(),
      run: () => this.act("back"),
    };
    const filter = { text: "Type to filter", run: () => this.act("filter") };
    if (compact) {
      return actionHints([...choose, " · ", open, " · ", back], (text) =>
        this.theme.fg("dim", text),
      );
    }
    const controls =
      width < 60
        ? [...choose, " · ", open, "\n", back, " · ", filter]
        : [filter, " · ", ...choose, " · ", open, " · ", back];
    return actionHints(controls, (text) => this.theme.fg("dim", text));
  }
  private footer(page: PickerPage, width: number, compact: boolean): Container {
    const footer = new Container();
    if (!compact) {
      footer.addChild(new Spacer(1));
    }
    const task = page.task;
    if (task && !compact) {
      footer.addChild(
        new Text(
          this.theme.fg(
            "muted",
            short(`${task.child.agent} · ${activity(task)} · ${task.run.runId.slice(0, 8)}`, width),
          ),
          0,
          0,
        ),
      );
      footer.addChild(new Text(this.theme.fg("dim", short(task.model.summary, width)), 0, 0));
      const assignment = new Text(
        readableText(task.child.task ?? "Original assignment unavailable."),
        0,
        0,
      ).render(width);
      footer.addChild(new Text(assignment.slice(0, 3).join("\n"), 0, 0));
    }
    footer.addChild(this.controls(width + 2, compact));
    return footer;
  }
  private select(value: string): void {
    if (this.controller.listPending && !["retry", "peers"].includes(value)) {
      return;
    }
    if (value === "next-page" || value === "previous-page") {
      this.controller.pageTasks(value === "next-page" ? "later" : "earlier");
    } else if (value === "retry") {
      this.retry();
    } else {
      this.done(value);
    }
  }
  private selectList(page: PickerPage, width: number, visible: number): SelectList {
    // Native SelectList needs more than ten cells to show its description column.
    const descriptionWidth =
      width > 40
        ? Math.max(11, ...page.items.map((item) => visibleWidth(item.description ?? "")))
        : 0;
    const primaryWidth = Math.max(1, width - descriptionWidth - (descriptionWidth > 0 ? 4 : 2));
    const list = new SelectList([...page.items], visible, getSelectListTheme(), {
      minPrimaryColumnWidth: Math.min(24, primaryWidth),
      maxPrimaryColumnWidth: primaryWidth,
      truncatePrimary: ({ text, maxWidth }) => truncateToWidth(text, maxWidth),
    });
    list.setSelectedIndex(page.selectedIndex);
    list.onSelect = (item) => this.select(item.value);
    list.onCancel = () => this.act("back");
    return list;
  }
  private layout(page: PickerPage, width: number, height: number): void {
    const innerWidth = Math.max(1, width - 2),
      compact = height < 16;
    const header = this.header(page, innerWidth, compact),
      footer = this.footer(page, innerWidth, compact);
    const visible = Math.max(
      1,
      height - 3 - header.render(innerWidth).length - footer.render(innerWidth).length,
    );
    this.list = this.selectList(page, innerWidth, visible);
    const body = new Box(1, 0, (text) => this.theme.bg("customMessageBg", text));
    body.addChild(header);
    body.addChild(this.list);
    body.addChild(footer);
    this.clear();
    this.addChild(new DynamicBorder((text) => this.theme.fg("borderAccent", text)));
    this.addChild(body);
    this.addChild(new DynamicBorder((text) => this.theme.fg("borderAccent", text)));
  }
  private pageSignature(page: PickerPage, query: string, width: number, height: number): string {
    const task = page.task;
    return JSON.stringify([
      page.items,
      query,
      width,
      height,
      page.status,
      this.retryError,
      this.controller.listPage?.total,
      page.items.at(page.selectedIndex)?.value,
      task && activity(task),
      task?.model,
      task?.child.task,
      task?.run.runId,
    ]);
  }
  render(width: number): string[] {
    const height = this.controller.availableHeight(this.tui),
      query = this.search.getValue();
    const selected =
      this.controller.listPending || this.wasPending
        ? undefined
        : this.list?.getSelectedItem()?.value;
    this.wasPending = this.controller.listPending;
    const page = pickerPage(this.controller, query, Math.max(1, width - 2), selected);
    this.itemKeys = page.items.map((item) => item.value);
    const signature = this.pageSignature(page, query, width, height);
    if (signature !== this.signature) {
      this.layout(page, width, height);
      this.signature = signature;
    }
    return super.render(width);
  }
  invalidate(): void {
    this.signature = "";
    super.invalidate();
  }
  syncDraft(): void {
    /* The picker has no conversation draft editor. */
  }
  private move(delta: number): void {
    if (this.itemKeys.length === 0) {
      return;
    }
    const index = this.itemKeys.indexOf(this.list?.getSelectedItem()?.value ?? "");
    this.list?.setSelectedIndex((index + delta + this.itemKeys.length) % this.itemKeys.length);
  }
  private act(action: "up" | "down" | "open" | "back" | "filter"): void {
    if (this.closed) {
      return;
    }
    switch (action) {
      case "back":
        this.done();
        break;
      case "filter":
        this.tui.setFocus(this);
        break;
      case "open": {
        const item = this.list?.getSelectedItem();
        if (item) {
          this.select(item.value);
        }
        break;
      }
      case "up":
        this.move(-1);
        break;
      case "down":
        this.move(1);
        break;
    }
    this.tui.requestRender();
  }
  private listInput(data: string): void {
    const keys = getKeybindings();
    if (keys.matches(data, "tui.select.cancel")) {
      this.act("back");
      return;
    }
    if (
      (["tui.select.up", "tui.select.down", "tui.select.confirm"] as const).some((key) =>
        keys.matches(data, key),
      )
    ) {
      this.list?.handleInput(data);
    } else {
      const previous = this.search.getValue();
      this.search.handleInput(data);
      if (this.search.getValue() !== previous) {
        this.list = undefined;
      }
      this.controller.filterTasks(this.search.getValue());
    }
  }
  handleInput(data: string): void {
    if (this.closed) {
      return;
    }
    if (matchesKey(data, this.controller.shortcut)) {
      this.done();
      return;
    }
    if (matchesKey(data, "pageDown") || matchesKey(data, "pageUp")) {
      this.controller.pageTasks(matchesKey(data, "pageDown") ? "later" : "earlier");
      return;
    }
    if (matchesKey(data, "f5")) {
      this.retry();
      return;
    }
    this.listInput(data);
    this.tui.requestRender();
  }
  dispose(): void {
    this.closed = true;
  }
}
