import type { TUI } from "@earendil-works/pi-tui";
import { recordAt, errorMessage } from "../shared/unknown.ts";
import { actionText, actionHints } from "../shared/tui-action.ts";
import { ConversationJournal, plainText, type ConversationPage } from "./journal-tail.ts";
import type { NativeRecord } from "../shared/native-journal.ts";
import type { ObservationClient, ViewedTool } from "./observe-client.ts";
import { Card, type CardOptions } from "./observe-card.ts";
import { Container, Text } from "./observe-layout.ts";

export interface EntryAnchor {
  id: string;
  offset: number;
  end?: boolean;
}

interface PageRequest {
  requested: number;
  navigation?: -1 | 1;
}

type TranscriptChange =
  | { kind: "history"; direction: -1 | 1 }
  | { kind: "content"; id: string; direction: -1 | 1 }
  | { kind: "pending" };

interface Hydration {
  entry: NativeRecord;
  card: Card;
  request: PageRequest;
  controller: AbortController;
}

/** One mounted conversation page. Frozen cards are never mutated while the reader is above live. */
export class ObserverTranscript extends Container {
  readonly journal: ConversationJournal;
  readonly positions: Array<{ id: string; start: number; end: number }> = [];
  private readonly cards = new Map<string, Card>();
  private readonly pages = new Map<string, PageRequest>();
  private readonly expanded = new Set<string>();
  private before?: string;
  private start = 0;
  private stop = 0;
  private entries: NativeRecord[] = [];
  private selected?: string;
  height = 0;
  private mounted: Card[] = [];
  waiting = false;
  private revision = "";
  private readonly display: CardOptions;
  private readonly changed: (event: TranscriptChange) => void;
  private readonly loaded: () => void;
  private paused = false;
  private hydration?: Promise<void>;
  private active?: Hydration;
  private readonly jobs = new Map<string, Hydration>();
  private readonly pending = new Map<string, PageRequest>();
  version = 0;
  constructor(options: {
    file: string;
    sessionId: string;
    cwd: string;
    tui: TUI;
    hideThinking: boolean;
    changed: (event: TranscriptChange) => void;
    loaded: () => void;
  }) {
    super();
    this.journal = new ConversationJournal(options.file, options.sessionId);
    this.display = options;
    this.changed = options.changed;
    this.loaded = options.loaded;
  }
  observe(client?: ObservationClient): void {
    const native = this.journal.native;
    native.refresh();
    this.waiting = !native.indexed;
    if (client && !client.settle((id) => native.byId.has(id))) {
      this.waiting = true;
    }
  }
  private refresh(client?: ObservationClient): boolean {
    this.observe(client);
    const revision = `${this.journal.native.records.length}:${client?.revision ?? -1}:${this.before ?? ""}`;
    if (revision === this.revision) {
      return false;
    }
    this.revision = revision;
    return true;
  }
  sync(client?: ObservationClient): boolean {
    if (!this.refresh(client)) {
      return false;
    }
    const entries = this.journal.entries(client?.leaf);
    this.entries = entries;
    const stop = this.boundary(entries);
    const start = Math.max(0, stop - 24);
    this.start = start;
    this.stop = stop;
    const selected = entries.slice(start, stop);
    this.clear();
    if (start > 0) {
      this.historyRow("↑ Load earlier activity", -1);
    }
    this.mounted = [];
    for (const entry of selected.toReversed()) {
      this.mounted.unshift(
        this.card(entry, this.before === undefined && entry === selected.at(-1)),
      );
    }
    for (const card of this.mounted) {
      this.addChild(card);
    }
    if (this.before === undefined) {
      this.live(client);
    }
    if (this.before !== undefined) {
      this.historyRow("↓ Load later activity", 1);
    }
    this.evict();
    return true;
  }
  pause(): void {
    this.paused = true;
    this.active?.controller.abort();
    this.jobs.clear();
    this.pending.clear();
  }
  resume(): void {
    if (!this.paused) {
      return;
    }
    this.paused = false;
    for (const card of this.mounted) {
      const entry = this.journal.native.byId.get(card.id);
      const request = this.pages.get(card.id) ?? { requested: 0 };
      if (entry && (!card.ready || request.requested !== card.page)) {
        this.load(entry, card, request);
      }
    }
  }
  private card(entry: NativeRecord, latest: boolean): Card {
    const id = entry.value.id;
    let card = this.cards.get(id);
    if (!card) {
      const call = recordAt(entry.value, "message")?.toolCallId;
      const live = typeof call === "string" ? `tool:${call}` : "";
      card = this.cards.get(live) ?? new Card(id);
      this.cards.delete(live);
      card.id = id;
      if (!card.tool && !card.assistant) {
        card.content.addChild(new Text("Loading published content…", 0, 0));
      }
      this.cards.set(id, card);
    }
    if (!card.ready) {
      this.load(entry, card, this.pages.get(id) ?? { requested: latest ? -1 : 0 });
    }
    return card;
  }
  private current({ card, request, controller }: Hydration): boolean {
    return (
      !controller.signal.aborted &&
      this.cards.get(card.id) === card &&
      this.pending.get(card.id) === request
    );
  }
  private load(entry: NativeRecord, card: Card, request: PageRequest): void {
    if (this.paused || this.pending.get(card.id) === request) {
      return;
    }
    this.pending.set(card.id, request);
    this.pages.set(card.id, request);
    this.jobs.set(card.id, { entry, card, request, controller: new AbortController() });
    if (this.active?.card === card) {
      this.active.controller.abort();
    }
    this.drain();
  }
  private drain(): void {
    const job = this.jobs.values().next().value;
    if (this.hydration || this.paused || !job) {
      return;
    }
    this.jobs.delete(job.card.id);
    const { card } = job;
    this.active = job;
    this.hydration = this.hydrate(job)
      .catch((error: unknown) => {
        if (!this.current(job)) {
          return;
        }
        this.pending.delete(card.id);
        card.footer.clear();
        card.footer.addChild(
          new Text(`Content unavailable: ${plainText(errorMessage(error))}`, 0, 0),
        );
        card.invalidate();
        this.version++;
        this.loaded();
      })
      .finally(() => {
        this.hydration = undefined;
        this.active = undefined;
        this.drain();
      });
  }
  private async hydrate(job: Hydration): Promise<void> {
    if (!this.current(job)) {
      return;
    }
    const { entry, card, request, controller } = job;
    const options = { signal: controller.signal, hideThinking: this.display.hideThinking };
    let page = await this.journal.page(entry, Math.max(0, request.requested), options);
    if (request.requested < 0 && page.pages > 1) {
      page = await this.journal.page(entry, page.pages - 1, options);
    }
    const call =
      typeof page.message.toolCallId === "string" && !card.tool
        ? await this.journal.call(page.message.toolCallId, card.id, controller.signal)
        : undefined;
    if (!this.current(job)) {
      return;
    }
    this.durable(card.id, page, call?.arguments);
    this.pages.set(card.id, { requested: page.page });
    this.pending.delete(card.id);
    this.version++;
    if (request.navigation === undefined) {
      this.loaded();
    } else {
      this.changed({ kind: "content", id: card.id, direction: request.navigation });
    }
  }
  private evict(): void {
    const mounted = new Set(this.mounted.map((card) => card.id));
    for (const id of this.cards.keys()) {
      if (!mounted.has(id)) {
        this.cards.delete(id);
        this.jobs.delete(id);
        this.pending.delete(id);
      }
    }
    if (this.active && !mounted.has(this.active.card.id)) {
      this.active.controller.abort();
    }
    for (const choices of [this.pages, this.expanded]) {
      for (const id of choices.keys()) {
        if (choices.size > 48 && !mounted.has(id)) {
          choices.delete(id);
        }
      }
    }
  }
  private durable(id: string, page: ConversationPage, args: unknown): void {
    const card = this.cards.get(id);
    if (!card) {
      return;
    }
    card.expanded ||= this.expanded.has(id);
    card.publish(page, args, this.display);
    if (page.pages > 1) {
      card.footer.addChild(new Text(`Content page ${page.page + 1}/${page.pages}`, 0, 0));
      card.footer.addChild(
        actionHints(
          ([-1, 1] as const).map((direction) => ({
            text: direction < 0 ? "Previous page" : "Next page",
            action: () => {
              this.changePage(id, direction);
            },
          })),
        ),
      );
    }
    card.invalidate();
  }
  private changePage(id: string, direction: -1 | 1): boolean {
    const card = this.cards.get(id);
    const entry = this.journal.native.byId.get(id);
    if (!card || !entry) {
      return false;
    }
    const page = Math.max(0, Math.min(card.pages - 1, card.page + direction));
    if (page === card.page) {
      return false;
    }
    const request = { requested: page, navigation: direction };
    this.pages.set(id, request);
    this.changed({ kind: "pending" });
    this.load(entry, card, request);
    return true;
  }
  contentPage(line: number, height: number, direction: -1 | 1): boolean {
    const positions = direction < 0 ? this.positions.toReversed() : this.positions;
    return positions.some((item) => {
      const visible = item.end > line && item.start < line + height;
      const boundary = direction < 0 ? line <= item.start : line + height >= item.end;
      return visible && boundary && this.changePage(item.id, direction);
    });
  }
  private live(client?: ObservationClient): void {
    if (!client) {
      return;
    }
    const message = client.message;
    if (message) {
      const id = `live:${message.key}`;
      let card = this.cards.get(id);
      if (!card) {
        card = new Card(id);
        this.cards.set(id, card);
      }
      card.stream(message, this.display.hideThinking);
      this.mounted.push(card);
      this.addChild(card);
    }
    this.pendingCalls(client);
    for (const value of client.tools.values()) {
      this.liveTool(value);
    }
  }
  private pendingCalls(client: ObservationClient): void {
    for (const block of client.message?.blocks.filter(Boolean) ?? []) {
      if (
        block.type === "toolCall" &&
        block.id !== undefined &&
        block.name !== undefined &&
        !client.tools.has(block.id)
      ) {
        this.liveTool({ id: block.id, name: block.name, args: block.args }, true);
      }
    }
  }
  private liveTool(value: ViewedTool, preparing = false): void {
    const id = `tool:${value.id}`;
    let card = this.cards.get(id);
    if (!card) {
      card = new Card(id);
      card.expanded = this.expanded.has(id);
      this.cards.set(id, card);
    }
    card.updateTool(value, this.display, preparing);
    this.mounted.push(card);
    this.addChild(card);
  }
  private boundary(entries: NativeRecord[]): number {
    const found = entries.findIndex((entry) => entry.value.id === this.before);
    this.before = found < 0 ? undefined : this.before;
    return this.before === undefined || found < 0 ? entries.length : found;
  }
  private historyRow(label: string, direction: -1 | 1): void {
    this.addChild(
      actionText(label, () => {
        this.changed({ kind: "history", direction });
      }),
    );
  }
  history(direction: -1 | 1): string | undefined {
    if ((direction < 0 && this.start === 0) || (direction > 0 && this.before === undefined)) {
      return;
    }
    const anchor =
      direction < 0
        ? this.mounted.at(0)
        : this.mounted.findLast((card) => this.journal.native.byId.has(card.id));
    const stop = direction < 0 ? this.start + 1 : this.stop + 23;
    this.before = this.entries[stop]?.value.id;
    return anchor?.id;
  }
  latest(): void {
    this.before = undefined;
    const entry = this.entries.at(-1);
    if (!entry) {
      return;
    }
    const card = this.cards.get(entry.value.id);
    if (card?.ready === true && card.page === card.pages - 1) {
      return;
    }
    const request = { requested: -1 };
    this.pages.set(entry.value.id, request);
    if (card) {
      this.load(entry, card, request);
    }
  }
  select(line: number, height: number): boolean {
    const position = this.positions.find(
      (item) =>
        item.end > line &&
        item.start < line + height &&
        this.cards.get(item.id)?.tool !== undefined,
    );
    this.selected = position?.id;
    let changed = false;
    for (const card of this.mounted) {
      const selected = card.id === this.selected;
      if (card.selected !== selected) {
        card.selected = selected;
        card.invalidate();
        changed = true;
      }
    }
    return changed;
  }
  toggle(): void {
    this.cards.get(this.selected ?? "")?.toggle();
  }
  anchor(line: number): EntryAnchor | undefined {
    const position = this.positions.find((item) => item.end > line);
    return position && { id: position.id, offset: Math.max(0, line - position.start) };
  }
  line(anchor: EntryAnchor): number {
    const position = this.positions.find((item) => item.id === anchor.id);
    return (anchor.end === true ? (position?.end ?? 0) : (position?.start ?? 0)) + anchor.offset;
  }
  override render(width: number): string[] {
    this.positions.length = 0;
    let start = 0;
    for (const child of this.children) {
      const height = child.render(width).length;
      if (child instanceof Card) {
        this.positions.push({ id: child.id, start, end: start + height });
        if (child.expanded) {
          this.expanded.add(child.id);
        } else {
          this.expanded.delete(child.id);
        }
      }
      start += height;
    }
    this.height = start;
    return super.render(width);
  }
}
