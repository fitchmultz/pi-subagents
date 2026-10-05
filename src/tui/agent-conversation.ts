import { hasText } from "./text-values.ts";
import { ConversationViewport } from "./conversation-viewport.ts";
import { ConversationHistory } from "./conversation-history.ts";
import { ConversationDetails } from "./conversation-details.ts";
import { HistoryCards } from "./history-cards.ts";
import {
  getSelectListTheme,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  CURSOR_MARKER,
  Editor,
  type ScrollView,
  SelectList,
  matchesKey,
  type Component,
  type TUI,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import type { AgentHistoryItem } from "./agent-history.ts";
import { type AgentVisit, activity, type AgentTask, primaryKey } from "./view-model.ts";
import type { ConversationController } from "./view-ports.ts";
import { conversationControls, conversationFrame } from "./conversation-frame.ts";

/** Native ScrollView owns follow/scroll state; overlays only need a bounded render adapter. */
export class AgentConversation extends Container {
  private readonly details: ConversationDetails;
  private readonly history: ConversationHistory;
  private readonly cards: HistoryCards;
  readonly editor: Editor;
  readonly scroll: ScrollView;
  private readonly viewport: ConversationViewport;
  private readonly editorViewport: Component;
  private editorHeight = Infinity;
  private editorFocus = true;
  private hasFocus = false;
  private closed = false;
  private beforeInput = "";
  private selectedId?: string;
  private menu?: SelectList;
  private readonly initialVisit: Pick<AgentVisit, "anchor" | "readThrough">;
  private toolsExpanded = false;
  private readonly toolExpansion = new Map<string, boolean>();
  private readonly keys?: KeybindingsManager;

  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly controller: ConversationController;
  readonly key: string;
  private readonly done: (key?: string) => void;

  constructor(
    tui: TUI,
    theme: Theme,
    options: {
      readonly controller: ConversationController;
      readonly key: string;
      readonly done: (key?: string) => void;
      readonly keys?: KeybindingsManager;
    },
  ) {
    super();
    const { controller, key, done, keys } = options;
    this.tui = tui;
    this.theme = theme;
    this.controller = controller;
    this.key = key;
    this.done = done;
    this.keys = keys;
    this.details = new ConversationDetails(tui, {
      task: () => this.task,
      visit: () => this.visit,
      selected: () => this.selected(),
      following: () => this.scroll.isFollowingEnd,
      anchor: () => this.viewport.anchor(),
      compose: (value) => {
        this.editorFocus = value;
        this.focused = this.hasFocus;
      },
      closeMenu: () => {
        this.menu = undefined;
      },
      restore: (anchor) => {
        this.viewport.restoreAnchor = anchor;
      },
      toStart: () => this.scroll.scrollToStart(),
      changed: () => this.controller.changed(),
      back: () => this.act("back"),
      changes: () => this.controller.changes(this.key),
    });

    this.initialVisit = { anchor: this.visit.anchor, readThrough: this.visit.readThrough };
    this.history = new ConversationHistory(tui, controller, key, {
      initialPosition: () => this.viewport.initialPosition,
      initialVisit: () => this.initialVisit,
      readSequence: (sequence) => {
        this.viewport.readSequence = sequence;
      },
      clearCards: () => this.cards.clear(),
    });

    this.cards = new HistoryCards(
      tui,
      theme,
      () => this.task?.child.launch?.cwd ?? this.task?.run.cwd ?? process.cwd(),
    );
    this.editor = new Editor(
      tui,
      { borderColor: (text) => theme.fg("accent", text), selectList: getSelectListTheme() },
      { paddingX: 0 },
    );
    this.editor.setText(this.visit.draft);
    this.editor.onChange = () => {
      if (this.closed) {
        return;
      }
      this.visit.draft = this.editor.getExpandedText();
      this.controller.changed();
    };
    this.editor.onSubmit = (text) => {
      this.editor.setText(this.beforeInput);
      if (!this.details.loadingDetail) {
        void this.controller.send(this.key, text);
      }
    };
    let editorOffset = 0;
    this.editorViewport = {
      invalidate: () => this.editor.invalidate(),
      render: (width) => {
        const lines = this.editor.render(width);
        // Native overlays do not allocate editor height; keep Pi's cursor and input handling intact when space is short.
        const cursor = lines.findIndex((line) => line.includes(CURSOR_MARKER));
        if (cursor >= 0) {
          editorOffset = Math.max(0, cursor - this.editorHeight + 1);
        }
        editorOffset = Math.max(0, Math.min(editorOffset, lines.length - this.editorHeight));
        return lines.slice(editorOffset, editorOffset + this.editorHeight);
      },
      handleMouse: (event) => this.editor.handleMouse({ ...event, y: event.y + editorOffset }),
    };
    this.viewport = new ConversationViewport(
      tui,
      this.cards,
      {
        task: () => this.task,
        visit: () => this.visit,
        loading: () => this.history.loadingPage,
        detail: () => Boolean(this.details.detail),
        initialVisit: this.initialVisit,
        content: {
          render: (width) =>
            this.cards.render(width, this.history.items(this.details.detail), {
              selectedId: this.selectedId,
              editorFocus: this.editorFocus,
              detail: Boolean(this.details.detail),
              toolsExpanded: this.toolsExpanded,
              toolExpansion: this.toolExpansion,
            }),
          invalidate() {
            /* HistoryCards caches are invalidated by the conversation. */
          },
        },
      },
      (event) => this.historyMouse(event),
    );
    this.scroll = this.viewport.scroll;
    void this.history.loadPage({}, this.visit.anchor?.id ?? this.visit.readThrough);
  }

  private get visit(): AgentVisit {
    return this.controller.visit(this.key);
  }
  private get task(): AgentTask | undefined {
    return this.controller.task(this.key);
  }
  get focused(): boolean {
    return this.hasFocus;
  }
  set focused(value: boolean) {
    this.hasFocus = value;
    this.editor.focused = value && this.editorFocus && !this.details.detail && !this.menu;
  }
  refresh(): void {
    if (this.closed) {
      return;
    }
    if (this.details.detail?.id === "assignment" && this.task) {
      this.details.detail = this.history.assignment();
    }
    if (!this.viewport.initialPosition && !this.scroll.isFollowingEnd) {
      this.viewport.restoreAnchor = this.viewport.anchor();
    }
    if (
      !this.history.loadingPage &&
      this.history.latestPage &&
      this.scroll.isFollowingEnd &&
      !this.details.detail &&
      !hasText(this.history.pageError)
    ) {
      void this.history.loadPage();
    }
    this.tui.requestRender();
  }
  syncDraft(): void {
    if (!this.closed && this.editor.getExpandedText() !== this.visit.draft) {
      this.editor.setText(this.visit.draft);
    }
  }

  private primaryHint(width: number, terminal: boolean): string {
    if (this.details.loadingDetail && !this.details.detail) {
      return "Loading quoted context…";
    }
    if (this.task?.child.identityUnavailable === true) {
      return "Assignment unavailable · draft kept";
    }
    if (this.task?.child.activity?.status === "pending") {
      return "Waiting to start · draft kept";
    }
    if (terminal) {
      return width < 60 ? "Alt+C Continue" : "Alt+C Continue with message";
    }
    return this.editorFocus ? `${primaryKey("tui.input.submit")} Send`.trim() : "Enter Details";
  }

  render(width: number): string[] {
    const task = this.task,
      height = this.controller.availableHeight(this.tui);
    const terminal = task?.child.state !== "live" && !task?.question;
    let primary: string | undefined;
    if (task?.child.identityUnavailable !== true && task?.child.activity?.status !== "pending") {
      primary = terminal ? "continue" : this.editorFocus ? "send" : "details";
    }
    const footer = conversationControls(
      {
        menu: Boolean(this.menu),
        detail: Boolean(this.details.detail),
        compact: height < 16,
        width,
        primary,
        actionHint: this.primaryHint(width, terminal),
        act: (action) => this.act(action),
      },
      this.theme,
    );
    let entrance = "Agents";
    if (this.history.loadingPage && !task?.page && !this.details.detail) {
      entrance = "Loading conversation…";
    } else if (this.history.pageError !== undefined && !this.details.detail) {
      entrance = "History unavailable · F5 retry";
    }
    this.editorHeight = Infinity;
    const frame = conversationFrame(
      {
        width,
        height,
        title: `${entrance} › ${task?.label ?? "unavailable"}${this.details.detail ? " › details" : ""}`,
        status: task
          ? `${task.child.agent} · ${activity(task)} · ${task.model.summary}`
          : "Unavailable",
        unread: task?.unread === true && !this.scroll.isFollowingEnd,
        menu: this.menu,
        detail: Boolean(this.details.detail),
        footer,
        viewport: this.viewport,
        editorViewport: this.editorViewport,
        editorRows: this.editor.render(Math.max(1, width - 2)).length,
        composeLabel: `${task?.question ? "Answer" : "Message"} ${task?.label ?? "agent"}${this.controller.isBusy(this.key) ? " · sending" : ""}`,
        notice: this.visit.notice,
        quoteTitle: this.visit.quote?.title,
        act: (action) => this.act(action),
      },
      this.theme,
    );
    this.editorHeight = frame.editorHeight;
    this.viewport.height = frame.historyHeight;
    this.clear();
    this.addChild(frame.component);
    this.focused = this.hasFocus;
    return super.render(width);
  }

  invalidate(): void {
    this.cards.clear();
    super.invalidate();
  }

  handleMouse(event: TuiMouseEvent) {
    const result = super.handleMouse(event);
    if (result?.target.component === this.editorViewport) {
      this.editorFocus = true;
      this.focused = this.hasFocus;
    }
    return result;
  }

  private historyMouse(event: TuiMouseEvent) {
    if (event.type === "wheel") {
      this.scroll.scrollBy(event.wheelDelta ?? 0);
      this.viewport.restoreAnchor = this.viewport.anchor();
      return { handled: true };
    }
    if (event.type !== "click" || event.button !== "left") {
      return;
    }
    const line = this.cards.lines.find(
      (line) =>
        line.start <= event.y + this.scroll.scrollTop && line.end > event.y + this.scroll.scrollTop,
    );
    if (!line) {
      return;
    }
    this.viewport.restoreAnchor = this.viewport.anchor();
    this.editorFocus = false;
    this.selectedId = line.id;
    const item = this.selected();
    if ((item?.call || item?.result) && !this.details.detail) {
      this.toolExpansion.set(line.id, !(this.toolExpansion.get(line.id) ?? this.toolsExpanded));
    } else {
      this.cards.dispatch(line.id, {
        ...event,
        y: event.y + this.scroll.scrollTop - line.contentStart,
        height: line.end - line.contentStart,
      });
    }
    return { handled: true, focus: true };
  }

  private select(delta: number): void {
    const current = this.cards.lines.findIndex((line) => line.id === this.selectedId);
    const index = Math.max(
      0,
      Math.min(
        this.cards.lines.length - 1,
        (current < 0
          ? this.cards.lines.findIndex((line) => line.end > this.scroll.scrollTop)
          : current) + delta,
      ),
    );
    const line = this.cards.lines[index];
    if (!line) {
      return;
    }
    this.selectedId = line.id;
    if (
      line.start < this.scroll.scrollTop ||
      line.start >= this.scroll.scrollTop + this.viewport.height
    ) {
      this.scroll.scrollTo(line.start, { disableFollow: true });
    }
    this.viewport.restoreAnchor = this.viewport.anchor();
  }

  private selected(): AgentHistoryItem | undefined {
    return (
      this.details.detail ??
      this.cards.contentItems.find((item) => item.id === this.selectedId) ??
      this.cards.contentItems.findLast((item) => item.kind === "assistant")
    );
  }
  private actions(): void {
    const task = this.task;
    const choices = [
      { value: "reply", label: "Reply to selected message / tool / change" },
      { value: "details", label: "Full details / diff" },
      {
        value: "expand",
        label: this.toolsExpanded ? "Collapse tool output" : "Expand tool output",
      },
      { value: "assignment", label: "Full original assignment" },
      { value: "changes", label: "Inspect working tree changes" },
      { value: "latest", label: "Jump to latest activity" },
      {
        value: "pin",
        label: this.controller.pinned === this.key ? "Unpin this agent" : "Keep this agent visible",
      },
      ...(this.visit.quote ? [{ value: "unquote", label: "Remove quoted context" }] : []),
      ...(task?.child.identityUnavailable === true || task?.child.activity?.status === "pending"
        ? []
        : task?.child.state === "live" || task?.question
          ? [{ value: "stop", label: "Stop this agent only" }]
          : [{ value: "continue", label: "Continue with this message" }]),
      { value: "picker", label: "Your other agents" },
      { value: "peers", label: "Other connected sessions" },
      { value: "earlier", label: "Earlier history" },
      { value: "later", label: "Later history" },
      { value: "retry", label: "Refresh / retry selected history" },
    ];
    this.menu = new SelectList(
      choices,
      Math.max(1, this.controller.availableHeight(this.tui) - 7),
      getSelectListTheme(),
    );
    this.menu.onSelect = (item) => {
      this.menu = undefined;
      this.act(item.value);
    };
    this.menu.onCancel = () => {
      this.menu = undefined;
    };
  }
  private act(action: string): void {
    if (this.closed) {
      return;
    }
    if (action === "back") {
      if (this.menu) {
        this.menu.onCancel?.();
      } else if (this.details.detail) {
        this.details.detailRequest++;
        this.details.loadingDetail = false;
        this.details.detail = undefined;
        this.editorFocus = true;
        this.viewport.restoreAnchor = this.details.conversationAnchor;
        if (!this.viewport.restoreAnchor) {
          this.scroll.scrollToEnd();
        }
      } else {
        this.finish();
      }
    } else if (action === "choose") {
      const item = this.menu?.getSelectedItem();
      if (item) {
        this.menu?.onSelect?.(item);
      }
    } else if (action === "actions") {
      this.actions();
    } else if (action === "focus" && !this.details.detail) {
      this.editorFocus = !this.editorFocus;
      if (!this.editorFocus) {
        this.select(0);
      }
    } else if (action === "send" && !this.details.loadingDetail) {
      void this.controller.send(this.key, this.editor.getExpandedText().trim());
    } else if (action === "reply") {
      void this.details.reply();
    } else if (action === "details") {
      const item = this.selected();
      if (item) {
        void this.details.inspect(item);
      }
    } else if (action === "earlier" || action === "later") {
      const page = this.task?.page;
      if (action === "earlier" && page?.previousBefore !== undefined) {
        void this.history.loadPage({ before: page.previousBefore });
      } else if (action === "later" && !this.history.latestPage && page?.nextAfter !== undefined) {
        void this.history.loadPage({ after: page.nextAfter });
      }
      this.cards.clear();
      this.selectedId = undefined;
      this.scroll.scrollToEnd();
      this.tui.requestRender();
    } else if (action === "retry") {
      void this.controller.retry(this.key).then(() => {
        if (!this.closed) {
          void this.history.loadPage();
        }
      });
    } else if (action === "assignment" && this.task) {
      void this.details.inspect(this.history.assignment());
    } else if (action === "expand") {
      if (!this.scroll.isFollowingEnd) {
        this.viewport.restoreAnchor = this.viewport.anchor();
      }
      this.toolsExpanded = !this.toolsExpanded;
      this.toolExpansion.clear();
    } else if (action === "changes") {
      void this.details.changes();
    } else if (action === "latest") {
      this.viewport.initialPosition = false;
      this.details.detailRequest++;
      this.details.loadingDetail = false;
      this.details.detail = undefined;
      this.cards.clear();
      void this.history.loadPage();
      this.viewport.restoreAnchor = undefined;
      this.details.conversationAnchor = undefined;
      this.scroll.scrollToEnd();
      this.selectedId = this.editorFocus ? undefined : this.history.items().at(-1)?.id;
    } else if (action === "pin") {
      this.controller.pin(this.controller.pinned === this.key ? undefined : this.key);
    } else if (action === "unquote") {
      if (this.details.loadingDetail && !this.details.detail) {
        this.details.detailRequest++;
        this.details.loadingDetail = false;
      }
      this.visit.quote = undefined;
      this.controller.changed();
    } else if (action === "stop") {
      void this.controller.stop(this.key);
    } else if (action === "continue" && !this.details.loadingDetail) {
      void this.controller.send(this.key, this.editor.getExpandedText(), true);
    } else if (action === "picker" || action === "peers") {
      this.finish(action);
    }
    this.focused = this.hasFocus;
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (this.closed) {
      return;
    }
    if (matchesKey(data, this.controller.shortcut)) {
      this.finish();
      return;
    }
    if (this.menu) {
      this.menu.handleInput(data);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "escape")) {
      this.act("back");
    } else if (this.keys?.matches(data, "app.tools.expand") ?? matchesKey(data, "ctrl+o")) {
      this.act("expand");
    } else if (matchesKey(data, "f2")) {
      this.act("actions");
    } else if (matchesKey(data, "f5")) {
      this.act("retry");
    } else if (matchesKey(data, "alt+r")) {
      this.act("reply");
    } else if (matchesKey(data, "alt+d") && (!this.editorFocus || this.details.detail)) {
      this.act("details");
    } else if (matchesKey(data, "alt+g")) {
      this.act("changes");
    } else if (matchesKey(data, "alt+l")) {
      this.act("latest");
    } else if (matchesKey(data, "alt+p")) {
      this.act("pin");
    } else if (matchesKey(data, "alt+q")) {
      this.act("unquote");
    } else if (matchesKey(data, "alt+s")) {
      this.act("stop");
    } else if (matchesKey(data, "alt+c")) {
      this.act("continue");
    } else if (matchesKey(data, "tab") && !this.details.detail) {
      this.act("focus");
    } else if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
      this.scroll.scrollBy(
        matchesKey(data, "pageUp") ? -this.viewport.height : this.viewport.height,
      );
      this.viewport.restoreAnchor = this.viewport.anchor();
    } else if (!this.editorFocus || this.details.detail) {
      if (matchesKey(data, "up")) {
        this.select(-1);
      } else if (matchesKey(data, "down")) {
        this.select(1);
      } else if (matchesKey(data, "home")) {
        this.scroll.scrollToStart();
        this.viewport.restoreAnchor = this.viewport.anchor();
      } else if (matchesKey(data, "end")) {
        this.act("latest");
      } else if (matchesKey(data, "enter")) {
        this.act("details");
      }
    } else {
      this.beforeInput = this.editor.getExpandedText();
      this.editor.handleInput(data);
    }
    this.focused = this.hasFocus;
    this.tui.requestRender();
  }

  private finish(key?: string): void {
    this.controller.changed();
    this.done(key);
  }
  dispose(): void {
    this.closed = true;
    this.details.dispose();
    this.history.dispose();
    this.details.detailRequest++;
    this.editor.onChange = undefined;
    this.editor.onSubmit = undefined;
    this.cards.clear();
  }
}
