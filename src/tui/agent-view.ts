import { hasText, nonemptyText } from "./text-values.ts";
import { isRecord } from "./history-text.ts";
import { directionRenderer, type DirectionDetails } from "./direction-message.ts";
import { restoredView } from "./view-persistence.ts";
import { AgentControls } from "./agent-controls.ts";
import { AgentBrowser } from "./agent-browser.ts";
import { ViewSession } from "./view-session.ts";
import { AgentTaskStore } from "./task-store.ts";
import { AgentDock } from "./agent-dock.ts";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type Container,
  type Component,
  type OverlayOptions,
  type TUI,
} from "@earendil-works/pi-tui";
import { loadConfig as loadIntercomConfig } from "../pi-intercom/config.ts";
import { isTuiContext } from "../shared/ui-mode.ts";
import {
  WIDGET_KEY,
  type SubagentState,
  type HistoryPage,
  type HistoryPageInput,
  type HistoryRunPage,
} from "../shared/types.ts";
import { type AgentHistoryItem } from "./agent-history.ts";
import { type AgentTask, type AgentVisit, type ExecuteControl } from "./view-model.ts";
import { AgentConversation } from "./agent-conversation.ts";
import { AgentPicker } from "./agent-picker.ts";

const VIEW_ENTRY = "subagent-view";

const DIRECTION_MESSAGE = "subagent-human-direction";
/** In-process open request: the consuming owner acknowledges this mutable event. */
interface SessionView {
  readonly sessionManager: { readonly getSessionId: () => unknown };
}
interface OpenAgentsRequest {
  readonly ctx?: SessionView;
  handled?: boolean;
}
function isSessionView(value: unknown): value is SessionView {
  return (
    isRecord(value) &&
    isRecord(value.sessionManager) &&
    typeof value.sessionManager.getSessionId === "function"
  );
}
function isOpenRequest(value: unknown): value is OpenAgentsRequest {
  return (
    isRecord(value) &&
    (value.ctx === undefined || isSessionView(value.ctx)) &&
    (value.handled === undefined || typeof value.handled === "boolean")
  );
}

/** One UI controller over the existing owned runs, session files, and executor. */
export class AgentViewController {
  private timer?: ReturnType<typeof setInterval>;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private unsubscribe?: () => void;

  private lastSaved = "";
  private render?: () => void;
  private closeOverlay?: (next?: string) => void;
  private widget?: Component;
  readonly shortcut = loadIntercomConfig().shortcut;
  private overlay?: AgentConversation | AgentPicker;

  private readonly pi: ExtensionAPI;
  private readonly state: SubagentState;
  private readonly store: AgentTaskStore;
  private readonly session: ViewSession;
  private readonly browser: AgentBrowser;
  private readonly controls: AgentControls;
  get tasks(): readonly AgentTask[] {
    return this.store.tasks;
  }
  get pinned(): string | undefined {
    return this.store.pinned;
  }
  get listPage(): HistoryRunPage | undefined {
    return this.browser.listPage;
  }
  get listLoading(): boolean {
    return this.browser.listLoading;
  }
  get listError(): string | undefined {
    return this.browser.listError;
  }
  get listFilter(): string {
    return this.browser.listFilter;
  }
  get listPending(): boolean {
    return this.browser.listPending;
  }
  visit(key: string): AgentVisit {
    return this.store.visit(key);
  }
  task(key: string): AgentTask | undefined {
    return this.store.task(key);
  }
  applyMetadata(task: AgentTask, page: HistoryPage): void {
    this.store.applyMetadata(task, page);
  }
  refresh(browse = false): Promise<void> {
    return this.browser.refresh(browse);
  }
  filterTasks(text: string): void {
    this.browser.filterTasks(text);
  }
  pageTasks(direction: "earlier" | "later"): void {
    this.browser.pageTasks(direction);
  }
  retry(key?: string): Promise<void> {
    return this.browser.retry(key);
  }
  historyPage(
    key: string,
    paging: Pick<HistoryPageInput, "before" | "after" | "cursor"> = {},
    anchor?: string | null,
  ): ReturnType<AgentBrowser["historyPage"]> {
    return this.browser.historyPage(key, paging, anchor);
  }
  savedResult(key: string, id: string): Promise<AgentHistoryItem> {
    return this.browser.savedResult(key, id);
  }
  send(key: string, text: string, continueExplicitly = false): Promise<void> {
    return this.controls.send(key, text, continueExplicitly);
  }
  stop(key: string): Promise<void> {
    return this.controls.stop(key);
  }
  changes(key: string): Promise<AgentHistoryItem | undefined> {
    return this.controls.changes(key);
  }
  isBusy(key: string): boolean {
    return this.controls.isBusy(key);
  }
  private reportFailure(error: unknown): void {
    if (this.live()) {
      this.session.ctx?.ui.notify(
        `Agents: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  }

  constructor(pi: ExtensionAPI, state: SubagentState, execute: ExecuteControl) {
    this.pi = pi;
    this.state = state;

    this.store = new AgentTaskStore(state, () => this.overlay?.syncDraft());
    this.session = new ViewSession(state);
    this.browser = new AgentBrowser(state, this.store, this.session, () => {
      this.overlay?.refresh();
      this.render?.();
    });
    this.controls = new AgentControls(pi, this.store, this.session, {
      execute,
      changed: () => this.changed(),
      save: () => this.save(),
      refreshSelected: (key) => this.refreshSelected(key),
      syncDraft: () => this.overlay?.syncDraft(),
    });
    pi.registerCommand("agents", {
      description: "View, message, answer, stop, or continue your agents",
      handler: async (_args, ctx) => this.open(undefined, ctx),
    });
    pi.registerMessageRenderer<DirectionDetails>(DIRECTION_MESSAGE, directionRenderer());
  }

  start(ctx: ExtensionContext): void {
    this.dispose();
    if (!isTuiContext(ctx)) {
      return;
    }
    this.session.start(ctx);
    const ownerSessionId = ctx.sessionManager.getSessionId();
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== VIEW_ENTRY) {
        continue;
      }
      const restored = restoredView(entry.data, ownerSessionId);
      if (restored) {
        this.store.visits = restored.visits;
        this.store.pinned = restored.pinned;
      }
    }
    this.unsubscribe = this.pi.events.on("subagent:open-agents", (request) => {
      if (!isOpenRequest(request)) {
        return;
      }
      if (!this.live() || request.ctx?.sessionManager.getSessionId() !== ownerSessionId) {
        return;
      }
      request.handled = true;
      void this.open();
    });
    ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
      this.render = () => tui.requestRender();
      const dock = new AgentDock(tui, theme, {
        tasks: () => this.store.dockTasks,
        pinned: () => this.store.tasks.find((task) => task.key === this.store.pinned),
        page: () => this.browser.listPage,
        error: () => this.browser.listError,
        loading: () => this.browser.listLoading,
        jobs: () => [...this.state.asyncJobs.values()],
        expanded: () => ctx.ui.getToolsExpanded(),
        below: () => this.componentsBelowWidget(tui) ?? [],
        shortcut: this.shortcut,
        live: () => this.live(),
        unpin: () => this.pin(undefined),
        open: (key) => {
          this.open(key).catch((error: unknown) => this.reportFailure(error));
        },
      });
      this.widget = dock.component;
      return dock.component;
    });
    void this.refresh();
    this.timer = setInterval(() => {
      if (
        !hasText(this.browser.listError) &&
        (this.overlay ||
          nonemptyText(this.store.pinned) ||
          this.store.dockTasks.some((task) => task.child.state === "live" || task.question) ||
          this.store.tasks.some((task) => this.store.visits.get(task.key)?.outbox.length))
      ) {
        this.render?.();
        void this.refresh();
      }
    }, 500);
    this.timer.unref?.();
  }

  private live(generation = this.session.generation): boolean {
    return this.session.live(generation);
  }
  private refreshSelected(key: string): void {
    this.store.refreshSelected(key, this.session.ownerSessionId);
    this.overlay?.refresh();
    this.render?.();
  }

  changed(): void {
    if (!this.live()) {
      return;
    }
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => this.save(), 300);
    this.saveTimer.unref?.();
    this.render?.();
  }

  private save(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = undefined;
    if (!this.live()) {
      return;
    }
    const saved = {
      ownerSessionId: this.session.ctx!.sessionManager.getSessionId(),
      visits: [...this.store.visits],
      pinned: this.store.pinned,
    };
    const serialized = JSON.stringify(saved);
    if (serialized === this.lastSaved) {
      return;
    }
    this.pi.appendEntry(VIEW_ENTRY, saved);
    this.lastSaved = serialized;
  }

  pin(key: string | undefined): void {
    this.store.pinned = key;
    this.save();
    this.render?.();
  }

  private componentsBelowWidget(tui: TUI): Component[] | undefined {
    if (!this.widget) {
      return undefined;
    }
    // Public children work across loader boundaries; never render the parent history to measure the dock.
    const parent = tui.children.find(
      (child): child is Component & Pick<Container, "children"> =>
        "children" in child &&
        Array.isArray(child.children) &&
        child.children.includes(this.widget),
    );
    return (
      parent && [
        ...parent.children.slice(parent.children.indexOf(this.widget) + 1),
        ...tui.children.slice(tui.children.indexOf(parent) + 1),
      ]
    );
  }

  availableHeight(tui: TUI): number {
    if (tui.mode !== "fullscreen" || !this.widget) {
      return Math.max(1, tui.terminal.rows - 2);
    }
    const below = this.componentsBelowWidget(tui);
    if (!below) {
      return Math.max(1, tui.terminal.rows - 2);
    }
    const dock = [this.widget, ...below].reduce(
      (height, child) => height + child.render(tui.terminal.columns).length,
      0,
    );
    return Math.max(1, tui.terminal.rows - dock - 1);
  }

  async open(key?: string, ctx = this.session.ctx): Promise<void> {
    if (!ctx || !isTuiContext(ctx)) {
      return;
    }
    if (
      !this.session.ctx ||
      this.session.ctx.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId()
    ) {
      this.start(ctx);
    }
    if (!this.live()) {
      return;
    }
    if (this.overlay) {
      this.closeOverlay?.(
        this.overlay instanceof AgentConversation && this.overlay.key === key ? undefined : key,
      );
      return;
    }
    const generation = this.session.generation;
    if (!this.browser.listPage) {
      await this.refresh(true);
    }
    if (!this.live(generation)) {
      return;
    }
    let selected =
      key ??
      (this.browser.listFilter.length === 0 &&
      this.store.tasks.length === 1 &&
      this.browser.listPage?.total === 1
        ? this.store.tasks[0].key
        : undefined);
    while (this.live(generation)) {
      this.store.selectedKey = selected;
      if (hasText(selected)) {
        this.refreshSelected(selected);
      }
      let height: (() => number) | undefined;
      const overlayOptions: OverlayOptions = {
        width: "96%",
        margin: 1,
        anchor: "center",
        get maxHeight() {
          return height?.();
        },
      };
      const result = await ctx.ui.custom<string | undefined>(
        (tui, theme, keys, done) => {
          height = () => this.availableHeight(tui);
          if (tui.mode === "fullscreen") {
            overlayOptions.anchor = "top-center";
          }
          this.closeOverlay = (next) => done(next);
          this.overlay =
            hasText(selected) && this.task(selected)
              ? new AgentConversation(tui, theme, { controller: this, key: selected, done, keys })
              : new AgentPicker(tui, theme, this, done);
          return this.overlay;
        },
        { overlay: true, overlayOptions },
      );
      if (!this.live(generation)) {
        return;
      }
      this.overlay = undefined;
      for (const task of [...this.store.tasks, ...this.store.dockTasks]) {
        if (task.key === this.store.selectedKey) {
          task.history = [];
          task.historyIds = [];
          task.page = undefined;
          task.finalId = undefined;
          task.historyLoading = false;
        }
      }
      this.store.selectedKey = undefined;
      this.closeOverlay = undefined;
      this.save();
      void this.refresh();
      if (result === "peers") {
        this.pi.events.emit("intercom:open", {});
        return;
      }
      if (!hasText(result)) {
        return;
      }
      selected = result === "picker" ? undefined : result;
    }
  }

  dispose(): void {
    this.save();
    this.session.dispose();
    this.browser.dispose();
    this.closeOverlay?.();
    this.overlay?.dispose();
    this.closeOverlay = undefined;
    this.overlay = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.browser.listPage = undefined;
    this.browser.listError = undefined;
    this.browser.listLoading = false;
    this.store.selectedKey = undefined;

    if (this.timer) {
      clearInterval(this.timer);
    }
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.timer = this.saveTimer = undefined;
    this.render = undefined;
    this.widget = undefined;
    this.session.ctx = undefined;
    this.session.ownerSessionId = undefined;
    this.store.tasks = [];
    this.store.dockTasks = [];
    this.store.taskKeys.clear();
    this.store.visits.clear();
    this.controls.dispose();
    this.store.pinned = undefined;
    this.lastSaved = "";
  }
}
export { AgentConversation } from "./agent-conversation.ts";
export { agentTaskLabel, type AgentTask, type AgentVisit } from "./view-model.ts";
