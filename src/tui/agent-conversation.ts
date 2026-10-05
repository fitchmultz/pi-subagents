import { hasText, errorText } from "./text-values.ts";
import {
  conversationChoices,
  conversationHeading,
  conversationShortcut,
  primaryConversationAction,
  primaryConversationHint,
} from "./conversation-menu.ts";
import { ConversationViewport } from "./conversation-viewport.ts";
import { ConversationHistory } from "./conversation-history.ts";
import { ConversationDetails } from "./conversation-details.ts";
import { ConversationSelection } from "./conversation-selection.ts";
import { HistoryCards } from "./history-cards.ts";
import {
  getSelectListTheme,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Editor,
  type ScrollView,
  SelectList,
  matchesKey,
  type Component,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { AgentVisit, AgentTask } from "./view-model.ts";
import type { ConversationController } from "./view-ports.ts";
import { conversationControls, conversationFrame } from "./conversation-frame.ts";
import { editorViewport } from "./editor-viewport.ts";

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
  private readonly selection: ConversationSelection;
  private menu?: SelectList;
  private readonly initialVisit: Pick<AgentVisit, "anchor" | "readThrough">;
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
    this.details = this.createDetails();

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
    this.bindEditor();
    this.editorViewport = editorViewport(this.editor, () => this.editorHeight);
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
              selectedId: this.selection.id,
              editorFocus: this.editorFocus,
              detail: Boolean(this.details.detail),
              toolsExpanded: this.selection.toolsExpanded,
              toolExpansion: this.selection.toolExpansion,
            }),
          invalidate() {
            /* HistoryCards caches are invalidated by the conversation. */
          },
        },
      },
      (event) => this.historyMouse(event),
    );
    this.scroll = this.viewport.scroll;
    this.selection = new ConversationSelection(this.cards, this.scroll);
    this.run(this.history.loadPage({}, this.visit.anchor?.id ?? this.visit.readThrough));
  }

  private createDetails(): ConversationDetails {
    return new ConversationDetails(this.tui, {
      task: () => this.task,
      visit: () => this.visit,
      selected: () => this.selection.selected(this.details.detail),
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
      toEnd: () => this.scroll.scrollToEnd(),
      changed: () => this.controller.changed(),
      back: () => this.act("back"),
      changes: () => this.controller.changes(this.key),
    });
  }
  private bindEditor(): void {
    this.editor.setText(this.visit.draft);
    this.editor.onChange = () => {
      if (!this.closed) {
        this.visit.draft = this.editor.getExpandedText();
        this.controller.changed();
      }
    };
    this.editor.onSubmit = (text) => {
      this.editor.setText(this.beforeInput);
      if (!this.details.loadingDetail) {
        this.run(this.controller.send(this.key, text));
      }
    };
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
    this.refreshFollowing();
    this.tui.requestRender();
  }
  private refreshFollowing(): void {
    if (
      !this.history.loadingPage &&
      this.history.latestPage &&
      this.scroll.isFollowingEnd &&
      !this.details.detail &&
      !hasText(this.history.pageError)
    ) {
      this.run(this.history.loadPage());
    }
  }
  syncDraft(): void {
    if (!this.closed && this.editor.getExpandedText() !== this.visit.draft) {
      this.editor.setText(this.visit.draft);
    }
  }

  private run(operation: Promise<void>): void {
    operation.catch((error: unknown) => {
      if (!this.closed) {
        this.visit.notice = errorText(error);
        this.tui.requestRender();
      }
    });
  }

  private entrance(): string {
    if (this.details.detail) {
      return "Agents";
    }
    if (this.history.loadingPage && !this.task?.page) {
      return "Loading conversation…";
    }
    return this.history.pageError !== undefined ? "History unavailable · F5 retry" : "Agents";
  }
  render(width: number): string[] {
    const task = this.task,
      height = this.controller.availableHeight(this.tui);
    const primary = primaryConversationAction(task, this.editorFocus);
    const footer = conversationControls(
      {
        menu: Boolean(this.menu),
        detail: Boolean(this.details.detail),
        compact: height < 16,
        width,
        primary,
        actionHint: primaryConversationHint(
          primary,
          width,
          this.details.loadingDetail && !this.details.detail,
          task,
        ),
        act: (action) => this.act(action),
      },
      this.theme,
    );
    const entrance = this.entrance();
    this.editorHeight = Infinity;
    const frame = conversationFrame(
      {
        width,
        height,
        ...conversationHeading(task, {
          entrance,
          detail: this.details.detail !== undefined,
          following: this.scroll.isFollowingEnd,
          busy: this.controller.isBusy(this.key),
        }),
        menu: this.menu,
        detail: Boolean(this.details.detail),
        footer,
        viewport: this.viewport,
        editorViewport: this.editorViewport,
        editorRows: this.editor.render(Math.max(1, width - 2)).length,
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

  handleMouse(event: Readonly<TuiMouseEvent>): ReturnType<Container["handleMouse"]> {
    const result = super.handleMouse(event);
    if (result?.target.component === this.editorViewport) {
      this.editorFocus = true;
      this.focused = this.hasFocus;
    }
    return result;
  }

  private historyMouse(event: Readonly<TuiMouseEvent>): TuiMouseEventResult | undefined {
    if (event.type === "wheel") {
      this.scroll.scrollBy(event.wheelDelta ?? 0);
      this.viewport.restoreAnchor = this.viewport.anchor();
      return { handled: true };
    }
    this.viewport.restoreAnchor = this.viewport.anchor();
    const result = this.selection.mouse(event, this.details.detail !== undefined);
    if (result?.focus === true) {
      this.editorFocus = false;
    }
    return result;
  }
  private select(delta: number): void {
    this.selection.select(delta, this.viewport.height);
    this.viewport.restoreAnchor = this.viewport.anchor();
  }
  private actions(): void {
    const choices = conversationChoices(this.task, {
      expanded: this.selection.toolsExpanded,
      pinned: this.controller.pinned === this.key,
      quote: this.visit.quote,
    });
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
  private back(): void {
    if (this.menu) {
      this.menu.onCancel?.();
      return;
    }
    if (!this.details.close()) {
      this.finish();
    }
  }
  private choose(): void {
    const menu = this.menu,
      item = menu?.getSelectedItem();
    if (menu && item) {
      menu.onSelect?.(item);
    }
  }
  private focusEditor(): void {
    if (this.details.detail) {
      return;
    }
    this.editorFocus = !this.editorFocus;
    if (!this.editorFocus) {
      this.select(0);
    }
  }
  private page(direction: string): void {
    const page = this.task?.page;
    if (direction === "earlier" && page?.previousBefore !== undefined) {
      this.run(this.history.loadPage({ before: page.previousBefore }));
    } else if (direction === "later" && !this.history.latestPage && page?.nextAfter !== undefined) {
      this.run(this.history.loadPage({ after: page.nextAfter }));
    }
    this.cards.clear();
    this.selection.id = undefined;
    this.scroll.scrollToEnd();
  }
  private async retry(): Promise<void> {
    await this.controller.retry(this.key);
    if (!this.closed) {
      await this.history.loadPage();
    }
  }
  private latest(): void {
    this.viewport.initialPosition = false;
    this.details.detailRequest++;
    this.details.loadingDetail = false;
    this.details.detail = undefined;
    this.cards.clear();
    this.run(this.history.loadPage());
    this.viewport.restoreAnchor = undefined;
    this.details.conversationAnchor = undefined;
    this.scroll.scrollToEnd();
    this.selection.id = this.editorFocus ? undefined : this.history.items().at(-1)?.id;
  }
  private expand(): void {
    if (!this.scroll.isFollowingEnd) {
      this.viewport.restoreAnchor = this.viewport.anchor();
    }
    this.selection.expand();
  }
  private submit(continuing: boolean): void {
    if (this.details.loadingDetail) {
      return;
    }
    const text = this.editor.getExpandedText();
    this.run(this.controller.send(this.key, continuing ? text : text.trim(), continuing));
  }
  private readonly commands: Readonly<Record<string, (() => void) | undefined>> = {
    back: () => this.back(),
    choose: () => this.choose(),
    actions: () => this.actions(),
    focus: () => this.focusEditor(),
    send: () => this.submit(false),
    continue: () => this.submit(true),
    reply: () => this.run(this.details.reply()),
    details: () => this.run(this.details.inspectSelected()),
    earlier: () => this.page("earlier"),
    later: () => this.page("later"),
    retry: () => this.run(this.retry()),
    assignment: () => {
      if (this.task) {
        this.run(this.details.inspect(this.history.assignment()));
      }
    },
    expand: () => this.expand(),
    changes: () => this.run(this.details.changes()),
    latest: () => this.latest(),
    pin: () => this.controller.pin(this.controller.pinned === this.key ? undefined : this.key),
    unquote: () => this.details.unquote(),
    stop: () => this.run(this.controller.stop(this.key)),
    picker: () => this.finish("picker"),
    peers: () => this.finish("peers"),
  };
  private act(action: string): void {
    if (this.closed) {
      return;
    }
    this.commands[action]?.();
    this.focused = this.hasFocus;
    this.tui.requestRender();
  }
  private shortcut(data: string): string | undefined {
    if (this.keys?.matches(data, "app.tools.expand") ?? matchesKey(data, "ctrl+o")) {
      return "expand";
    }
    if (matchesKey(data, "alt+d") && (!this.editorFocus || this.details.detail)) {
      return "details";
    }
    if (matchesKey(data, "tab") && !this.details.detail) {
      return "focus";
    }
    return conversationShortcut(data);
  }
  private navigate(data: string): void {
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
  }
  private input(data: string): void {
    const action = this.shortcut(data);
    if (action !== undefined) {
      this.act(action);
      return;
    }
    if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
      this.scroll.scrollBy(
        matchesKey(data, "pageUp") ? -this.viewport.height : this.viewport.height,
      );
      this.viewport.restoreAnchor = this.viewport.anchor();
    } else if (!this.editorFocus || this.details.detail) {
      this.navigate(data);
    } else {
      this.beforeInput = this.editor.getExpandedText();
      this.editor.handleInput(data);
    }
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
    } else {
      this.input(data);
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
    this.editor.onChange = undefined;
    this.editor.onSubmit = undefined;
    this.cards.clear();
  }
}
