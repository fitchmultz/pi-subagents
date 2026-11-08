import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Container, TUI, TuiMouseEvent } from "@earendil-works/pi-tui";
import {
  renderLayoutFrame,
  dispatchLayoutMouse,
  type LayoutFrame,
  TruncatedText,
  VStack,
} from "./observe-layout.ts";
import { errorMessage } from "../shared/unknown.ts";
import { plainText } from "./journal-tail.ts";
import { Reading } from "./observe-reading.ts";
import { ObservationChannel, type ObservationClient, type Watch } from "./observe-client.ts";

import {
  ChildList,
  Details,
  activityLabel,
  appendConversation,
  appendHeader,
  appendHints,
  type ObserverRow,
  type ScreenAction,
} from "./observe-chrome.ts";

export interface ObserverData {
  inventory: () => ObserverRow[];
  checking: () => boolean;
  row: (id: string) => ObserverRow | undefined;
  status: () => string;
  error: () => string;
  watch: (id: string) => Watch;
}
interface ScreenOptions {
  data: ObserverData;
  tui: TUI;
  theme: Theme;
  keys: KeybindingsManager;
  done: () => void;
  selected: string;
  hideThinking: boolean;
}

type ReadingVisibility =
  | { readonly kind: "empty" }
  | { readonly kind: "visible" | "hidden" | "failed"; readonly reading: Reading };

/** Native layout, cards and scrolling; all controls affect local reading state only. */
export class ObserverScreen extends VStack {
  private selected: string;
  private readonly list = new ChildList((id) => this.open(id));
  private reading?: Reading | undefined;
  private visibility: ReadingVisibility = { kind: "empty" };
  private readonly connection = new ObservationChannel(() => this.schedule());
  private get client(): ObservationClient | undefined {
    return this.connection.current;
  }
  private observed = { revision: -1, status: "", signature: "" };
  private readonly saved = new Map<string, Reading>();
  private focus: "list" | "conversation" = "list";
  private details?: Details | undefined;
  private failure = "";
  private selectionFailure = "";
  private timer?: NodeJS.Timeout | undefined;
  private indexer?: NodeJS.Immediate | undefined;
  private lastFlush = -Infinity;
  private closed = false;
  private frame?: LayoutFrame;
  private readonly options: ScreenOptions;
  constructor(options: ScreenOptions) {
    super();
    this.options = options;
    this.selected = options.selected;
    if (options.selected.length > 0) {
      this.open(this.selected);
    }
    this.structure();
  }
  private open(id: string): void {
    try {
      const watch = this.options.data.watch(id);
      const reading: Reading =
        this.saved.get(watch.launch.id) ??
        new Reading(watch, {
          tui: this.options.tui,
          hideThinking: this.options.hideThinking,
          changed: (kind) => {
            if (this.reading === reading) {
              if (kind === "history") {
                this.flush(true);
              } else {
                this.paint();
              }
            }
          },
          loaded: () => {
            if (this.activeReading() === reading) {
              this.schedule();
            }
          },
        });
      this.saved.delete(watch.launch.id);
      this.saved.set(watch.launch.id, reading);
      this.reading = reading;
      this.details = undefined;
      this.selected = watch.launch.id;
      this.focus = "conversation";
      this.failure = "";
      this.selectionFailure = "";
      this.reconcileVisibility();
      this.structure();
      this.options.tui.requestRender();
      for (const key of this.saved.keys()) {
        if (this.saved.size > 4 && key !== this.selected) {
          this.saved.delete(key);
        }
      }
    } catch (error) {
      this.selectionFailure = plainText(errorMessage(error));
      this.paint();
    }
  }
  private visible(): Reading | undefined {
    return this.focus === "conversation" || (this.reading?.width ?? 0) >= 100
      ? this.reading
      : undefined;
  }
  private reconcileVisibility(): void {
    const previous = this.visibility;
    const reading = this.reading;
    let kind: ReadingVisibility["kind"] = "hidden";
    if (this.failure.length > 0) {
      kind = "failed";
    } else if (this.visible()) {
      kind = "visible";
    }
    const replaced = (previous.kind === "empty" ? undefined : previous.reading) !== reading;
    if (previous.kind === "visible" && (replaced || kind !== "visible")) {
      previous.reading.transcript.pause();
      clearTimeout(this.timer);
      this.timer = undefined;
      clearImmediate(this.indexer);
      this.indexer = undefined;
      this.connection.pause();
    }
    if (replaced) {
      this.connection.clear();
    }
    this.visibility = reading ? { kind, reading } : { kind: "empty" };
    const visible = this.activeReading();
    if (visible) {
      visible.transcript.resume();
      this.connect();
      this.index();
    }
  }
  private activeReading(): Reading | undefined {
    return this.visibility.kind === "visible" ? this.visibility.reading : undefined;
  }
  private connect(): void {
    const reading = this.activeReading();
    if (!reading) {
      return;
    }
    try {
      const id = reading.watch.launch.id;
      const watch = this.options.data.watch(id);
      if (!watch.identity || this.options.data.row(id)?.live !== true) {
        return;
      }
      this.connection.connect(watch.identity);
    } catch {
      /* The owner refresh retries; preserve the last confirmed conversation meanwhile. */
    }
  }
  private index(): void {
    const reading = this.activeReading();
    if (
      !reading ||
      reading.transcript.journal.native.indexed ||
      this.indexer !== undefined ||
      this.closed
    ) {
      return;
    }
    this.indexer = setImmediate(() => {
      this.indexer = undefined;
      if (this.activeReading() !== reading) {
        return;
      }
      try {
        reading.transcript.journal.native.refresh();
        this.index();
      } catch (error) {
        this.failure = plainText(errorMessage(error));
        this.saved.delete(reading.watch.launch.id);
        this.reconcileVisibility();
      }
      this.schedule();
    });
    this.indexer.unref();
  }
  private schedule(): void {
    if (this.closed || this.timer !== undefined) {
      return;
    }
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.flush();
      },
      Math.max(0, this.lastFlush + 250 - performance.now()),
    );
    this.timer.unref();
  }
  private snapshot(): typeof this.observed {
    const revision = this.client?.revision ?? -1;
    const status = this.options.data.row(this.selected)?.status ?? "";
    const signature = JSON.stringify([
      this.options.data.status(),
      this.options.data.inventory().map(({ id, name, status: state }) => [id, name, state]),
      this.client
        ? [this.client.activity, this.client.connected, this.client.model, this.client.thinking]
        : undefined,
      this.selected,
      this.failure,
      this.selectionFailure,
      this.reading?.transcript.version,
    ]);
    return { revision, status, signature };
  }
  private flush(force = false): void {
    if (this.closed) {
      return;
    }
    const before = this.observed;
    this.observed = this.snapshot();
    const changed =
      before.revision !== this.observed.revision || before.status !== this.observed.status;
    const pending = this.reading?.pending;
    const applied = this.apply(force, changed);
    this.lastFlush = performance.now();
    if (
      force ||
      before.signature !== this.observed.signature ||
      applied ||
      pending !== this.reading?.pending
    ) {
      this.structure();
      this.options.tui.requestRender();
    }
    this.index();
    this.wait();
  }
  private apply(force: boolean, changed: boolean): boolean {
    try {
      return this.refreshReading(force, changed);
    } catch (error) {
      this.failure = plainText(errorMessage(error));
      this.saved.delete(this.reading?.watch.launch.id ?? "");
      this.reconcileVisibility();
      return true;
    }
  }
  private wait(): void {
    const reading = this.activeReading();
    const live = this.options.data.row(this.selected)?.live === true;
    if (reading && reading.transcript.waiting && live) {
      this.schedule();
    }
  }
  private refreshReading(force: boolean, changed: boolean): boolean {
    const reading = this.activeReading();
    if (!reading) {
      return false;
    }
    reading.observeScroll();
    if (!reading.following && !force) {
      reading.transcript.observe(this.client);
      if (changed) {
        reading.markPending();
      }
      return false;
    }
    const client =
      this.options.data.row(reading.watch.launch.id)?.live === true ? this.client : undefined;
    const applied = reading.transcript.sync(client);
    if (reading.following) {
      reading.scroll.scrollToEnd();
    }
    return applied;
  }
  update(): void {
    this.reconcileVisibility();
    this.flush();
  }
  private back(): void {
    if (this.details) {
      this.details = undefined;
    } else if (this.reading) {
      this.reading = undefined;
      this.focus = "list";
      this.reconcileVisibility();
    } else {
      this.options.done();
      return;
    }
    this.structure();
    this.options.tui.requestRender();
  }
  private move(direction: number): void {
    if (this.focus === "conversation") {
      if (this.details) {
        this.details.scrollBy(direction);
      } else {
        this.visible()?.scrollBy(direction);
      }
      return;
    }
    const rows = this.options.data.inventory();
    const index = Math.max(
      0,
      rows.findIndex((row) => row.id === this.selected),
    );
    const next = Math.max(0, Math.min(rows.length - 1, index + direction));
    this.selected = rows[next]?.id ?? "";
    this.list.reveal(next);
  }
  private page(direction: -1 | 1): void {
    if (this.focus === "list") {
      this.list.scrollBy(direction * this.list.viewportHeight);
      return;
    }
    if (this.details) {
      this.details.scrollBy(direction * this.details.viewportHeight);
      return;
    }
    this.reading?.page(direction);
  }
  private end(): void {
    if (this.details && this.focus === "conversation") {
      this.details.scrollToEnd();
      return;
    }
    if (!this.reading) {
      return;
    }
    this.focus = "conversation";
    this.reconcileVisibility();
    this.reading.follow();
    this.flush(true);
  }
  private confirm(): void {
    if (this.focus === "list") {
      this.open(
        this.selected.length > 0 ? this.selected : (this.options.data.inventory()[0]?.id ?? ""),
      );
    } else if (this.reading) {
      this.reading.transcript.toggle();
    }
  }
  private switchFocus(): void {
    this.focus = this.focus === "list" && this.reading ? "conversation" : "list";
    this.reconcileVisibility();
  }
  private toggleDetails(): void {
    this.details =
      !this.details && this.reading ? new Details(this.reading.watch.launch) : undefined;
  }
  private actions(): ScreenAction[] {
    return [
      ["tui.select.cancel", this.reading ? "back" : "close", () => this.back()],
      ["tui.select.confirm", this.focus === "list" ? "open" : "expand", () => this.confirm()],
      ["tui.select.up", "", () => this.move(-1)],
      ["tui.select.down", "", () => this.move(1)],
      ["tui.select.pageUp", "read up", () => this.page(-1)],
      ["tui.select.pageDown", "read down", () => this.page(1)],
      ["tui.editor.cursorLineEnd", this.details ? "details end" : "live", () => this.end()],
      ["app.session.togglePath", "details", () => this.toggleDetails()],
      [
        "tui.input.tab",
        this.focus === "list" && this.reading ? "conversation" : "children",
        () => this.switchFocus(),
      ],
    ];
  }
  private perform(action: () => void): void {
    action();
    this.paint();
  }
  private paint(): void {
    if (this.closed) {
      return;
    }
    this.structure();
    this.options.tui.requestRender();
  }
  handleInput(data: string): void {
    const action = this.actions().find(([key]) => this.options.keys.matches(data, key));
    if (action) {
      this.perform(action[2]);
    }
  }
  private conversation(reading: Reading): void {
    const configuration = this.client ?? reading.watch.launch;
    appendHeader(this, {
      launch: reading.watch.launch,
      model: configuration.model,
      thinking: configuration.thinking,
      activity: activityLabel({
        row: this.options.data.row(reading.watch.launch.id),
        client: this.client,
        connecting: this.connection.connecting,
      }),
      details: this.details,
      toggle: () => this.perform(() => this.toggleDetails()),
    });
    appendConversation(this, {
      list: this.list,
      reading,
      follow: () => this.end(),
    });
  }
  private structure(): void {
    this.clear();
    this.addChild(new TruncatedText(this.options.theme.fg("accent", "Agents · read-only"), 0, 0), {
      basis: 1,
    });
    const rows = this.options.data.inventory();
    if (this.selected.length === 0) {
      this.selected = rows[0]?.id ?? "";
    }
    this.list.update(rows, this.selected, this.options.data.checking());
    const reading = this.visible();
    if (reading) {
      this.conversation(reading);
    } else {
      this.addChild(new TruncatedText(this.options.data.status(), 0, 0), { basis: 1 });
      this.addChild(this.list, {
        basis: 0,
        grow: 1,
        minSize: 1,
      });
    }
    const error = [this.failure, this.selectionFailure, this.options.data.error()].find(
      (message) => message.length > 0,
    );
    if (error !== undefined) {
      this.addChild(new TruncatedText(this.options.theme.fg("warning", error), 0, 0), { basis: 1 });
    }
    appendHints(this, {
      actions: this.actions(),
      keys: this.options.keys,
      perform: (action) => this.perform(action),
    });
  }
  override render(width: number): string[] {
    const reading = this.reading;
    const anchor = reading?.anchor();
    const resized = reading?.resize(width);
    this.reconcileVisibility();
    if (resized === true) {
      this.structure();
    }
    const frame = () =>
      renderLayoutFrame(this, width, Math.max(1, this.options.tui.terminal.rows), () =>
        this.options.tui.requestRender(),
      );
    this.frame = frame();
    const visible = this.visible();
    const selected =
      visible?.transcript.select(visible.scroll.scrollTop, visible.scroll.viewportHeight) === true;
    if (visible && anchor) {
      visible.reveal(anchor);
    }
    if (selected || (visible && anchor)) {
      this.frame = frame();
    }
    return this.frame.lines;
  }
  override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
    const result = this.frame ? dispatchLayoutMouse(this, this.frame, event) : undefined;
    const reading = this.visible();
    if (reading?.observeScroll() === true) {
      this.structure();
    }
    return result;
  }
  dispose(): void {
    this.closed = true;
    this.reading = undefined;
    this.reconcileVisibility();
    clearTimeout(this.timer);
    clearImmediate(this.indexer);
    this.saved.clear();
  }
}
