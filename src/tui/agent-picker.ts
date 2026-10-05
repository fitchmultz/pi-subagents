import { hasText } from "./text-values.ts";
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
import { taskSummary, short, activity, primaryKey } from "./view-model.ts";

export class AgentPicker extends Container {
  private list?: SelectList;
  private itemKeys: string[] = [];
  private closed = false;
  private readonly search: Input;
  private signature = "";
  private wasPending = false;
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
  render(width: number): string[] {
    const height = this.controller.availableHeight(this.tui),
      innerWidth = Math.max(1, width - 2);
    const query = this.search.getValue();
    const tasks = this.controller.tasks.filter((task) =>
      this.controller.listPage?.rows.some((run) => run.runId === task.run.runId),
    );
    const items = tasks.map((task) => {
      const { status, badge } = taskSummary(task);
      return {
        value: task.key,
        label: `${task.child.agent} · ${task.label}`,
        description: status + badge,
      };
    });
    if (this.controller.listPage?.offset) {
      items.push({ value: "previous-page", label: "Previous agents", description: "PgUp" });
    }
    if (this.controller.listPage?.nextOffset !== undefined) {
      items.push({ value: "next-page", label: "More agents", description: "PgDn" });
    }
    items.push({ value: "retry", label: "Refresh / retry history", description: "F5" });
    if (!hasText(query)) {
      items.push({
        value: "peers",
        label: "Other connected sessions",
        description: "All projects",
      });
    }
    const labelWidth = Math.min(
      Math.max(0, ...items.map((item) => visibleWidth(item.label))),
      Math.max(40, Math.floor(innerWidth / 2)),
    );
    for (const [index, task] of tasks.entries()) {
      const item = items[index],
        modelWidth = innerWidth - labelWidth - visibleWidth(item.description) - 7;
      if (modelWidth >= 16) {
        item.description += ` · ${short(task.model.summary, modelWidth)}`;
      }
    }
    this.itemKeys = items.map((item) => item.value);
    const selected =
      this.controller.listPending || this.wasPending
        ? undefined
        : this.list?.getSelectedItem()?.value;
    this.wasPending = this.controller.listPending;
    const selectedIndex = Math.max(
      0,
      items.findIndex((item) => item.value === selected),
    );
    const task = this.controller.task(items[selectedIndex]?.value ?? "");
    const status =
      this.controller.listError ??
      (this.controller.listPage?.freshness.state === "catching-up"
        ? "Catching up · partial results"
        : this.controller.listPage?.freshness.state === "degraded"
          ? "Some history unavailable · F5 retry"
          : this.controller.listLoading
            ? "Loading…"
            : "");
    const signature = JSON.stringify([
      items,
      query,
      width,
      height,
      status,
      this.controller.listPage?.total,
      items[selectedIndex]?.value,
      task && activity(task),
      task?.model,
      task?.child.task,
      task?.run.runId,
    ]);
    if (signature !== this.signature) {
      const compact = height < 16;
      const header = new Container();
      header.addChild(
        new Text(
          this.theme.fg(
            "accent",
            this.theme.bold(
              truncateToWidth(
                `Agents · ${this.controller.listPage?.total ?? "…"} owned runs · page ${Math.floor((this.controller.listPage?.offset ?? 0) / 50) + 1}`,
                innerWidth,
              ),
            ),
          ),
          0,
          0,
        ),
      );
      header.addChild(this.search);
      if (hasText(status)) {
        header.addChild(
          new Text(
            this.theme.fg(
              hasText(this.controller.listError) ? "warning" : "dim",
              truncateToWidth(status, innerWidth),
            ),
            0,
            0,
          ),
        );
      }
      if (!compact) {
        header.addChild(new Spacer(1));
      }
      const footer = new Container();
      if (!compact) {
        footer.addChild(new Spacer(1));
      }
      if (task && !compact) {
        footer.addChild(
          new Text(
            this.theme.fg(
              "muted",
              short(
                `${task.child.agent} · ${activity(task)} · ${task.run.runId.slice(0, 8)}`,
                innerWidth,
              ),
            ),
            0,
            0,
          ),
        );
        footer.addChild(
          new Text(this.theme.fg("dim", short(task.model.summary, innerWidth)), 0, 0),
        );
        const assignment = new Text(
          readableText(task.child.task ?? "Original assignment unavailable."),
          0,
          0,
        ).render(innerWidth);
        footer.addChild(new Text(assignment.slice(0, 3).join("\n"), 0, 0));
      }
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
      const controls = compact
        ? [...choose, " · ", open, " · ", back]
        : width < 60
          ? [...choose, " · ", open, "\n", back, " · ", filter]
          : [filter, " · ", ...choose, " · ", open, " · ", back];
      footer.addChild(actionHints(controls, (text) => this.theme.fg("dim", text)));
      const visible = Math.max(
        1,
        height - 3 - header.render(innerWidth).length - footer.render(innerWidth).length,
      );
      // Native SelectList needs more than ten cells to show its description column.
      const descriptionWidth =
        innerWidth > 40
          ? Math.max(11, ...items.map((item) => visibleWidth(item.description ?? "")))
          : 0;
      const primaryWidth = Math.max(1, innerWidth - descriptionWidth - (descriptionWidth ? 4 : 2));
      this.list = new SelectList(items, visible, getSelectListTheme(), {
        minPrimaryColumnWidth: Math.min(24, primaryWidth),
        maxPrimaryColumnWidth: primaryWidth,
        truncatePrimary: ({ text, maxWidth }) => truncateToWidth(text, maxWidth),
      });
      this.list.setSelectedIndex(selectedIndex);
      this.list.onSelect = (item) => {
        if (this.controller.listPending && !["retry", "peers"].includes(item.value)) {
          return;
        }
        if (item.value === "next-page" || item.value === "previous-page") {
          this.controller.pageTasks(item.value === "next-page" ? "later" : "earlier");
        } else if (item.value === "retry") {
          void this.controller.retry();
        } else {
          this.done(item.value);
        }
      };
      this.list.onCancel = () => this.act("back");
      const body = new Box(1, 0, (text) => this.theme.bg("customMessageBg", text));
      body.addChild(header);
      body.addChild(
        (items.length ?? 0) > 0
          ? this.list
          : new Text(
              hasText(query) ? "No matching agents." : "No agents owned by this session yet.",
              0,
              0,
            ),
      );
      body.addChild(footer);
      this.clear();
      this.addChild(new DynamicBorder((text) => this.theme.fg("borderAccent", text)));
      this.addChild(body);
      this.addChild(new DynamicBorder((text) => this.theme.fg("borderAccent", text)));
      this.signature = signature;
    }
    return super.render(width);
  }
  invalidate(): void {
    this.signature = "";
    super.invalidate();
  }
  syncDraft(): void {}
  private act(action: "up" | "down" | "open" | "back" | "filter"): void {
    if (this.closed) {
      return;
    }
    if (action === "back") {
      this.done();
    } else if (action === "filter") {
      this.tui.setFocus(this);
    } else if (action === "open") {
      const item = this.list?.getSelectedItem();
      if (item) {
        this.list?.onSelect?.(item);
      }
    } else if ((this.itemKeys.length ?? 0) > 0) {
      const index = this.itemKeys.indexOf(this.list?.getSelectedItem()?.value ?? "");
      this.list?.setSelectedIndex(
        (index + (action === "up" ? -1 : 1) + this.itemKeys.length) % this.itemKeys.length,
      );
    }
    this.tui.requestRender();
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
      void this.controller.retry();
      return;
    }
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
    this.tui.requestRender();
  }
  dispose(): void {
    this.closed = true;
  }
}
