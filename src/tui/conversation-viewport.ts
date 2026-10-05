import {
  ScrollView,
  type TUI,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { ReadonlyInput } from "../shared/types.ts";
import type { AgentTask, AgentVisit, Anchor } from "./view-model.ts";
import type { HistoryCards } from "./history-cards.ts";
interface ViewportSource {
  readonly task: () => AgentTask | undefined;
  readonly visit: () => AgentVisit;
  readonly loading: () => boolean;
  readonly detail: () => boolean;
  readonly initialVisit: ReadonlyInput<Pick<AgentVisit, "anchor" | "readThrough">>;
  readonly content: Component;
}
function firstUnread(
  ids: readonly string[],
  readThrough: string | null | undefined,
): string | undefined {
  if (readThrough === null) {
    return ids.at(0);
  }
  if (readThrough === undefined) {
    return;
  }
  const index = ids.indexOf(readThrough);
  return index >= 0 ? ids.at(index + 1) : undefined;
}
export class ConversationViewport implements Component {
  readonly scroll: ScrollView;
  initialPosition = true;
  restoreAnchor?: Anchor;
  readSequence = -1;
  height = 1;
  private lastWidth?: number;
  private readonly tui: TUI;
  private readonly cards: HistoryCards;
  private readonly source: ViewportSource;
  private readonly mouse: (event: Readonly<TuiMouseEvent>) => TuiMouseEventResult | undefined;
  constructor(
    tui: TUI,
    cards: HistoryCards,
    source: ViewportSource,
    mouse: (event: Readonly<TuiMouseEvent>) => TuiMouseEventResult | undefined,
  ) {
    this.tui = tui;
    this.cards = cards;
    this.source = source;
    this.mouse = mouse;
    this.scroll = new ScrollView(source.content, { follow: "end", scrollbar: "hidden" });
  }
  invalidate(): void {
    this.scroll.invalidate();
  }
  handleMouse(event: Readonly<TuiMouseEvent>): TuiMouseEventResult | undefined {
    return this.mouse(event);
  }
  anchor(): Anchor | undefined {
    const row = this.cards.lines.findLast((candidate) => candidate.start <= this.scroll.scrollTop);
    return row ? { id: row.id, line: this.scroll.scrollTop - row.start } : undefined;
  }
  private initialize(): void {
    const task = this.source.task();
    if (!this.initialPosition || this.source.loading() || !task) {
      return;
    }
    if (!task.page && task.child.identityUnavailable !== true) {
      return;
    }
    this.initialPosition = false;
    const initial = this.source.initialVisit;
    const unread = firstUnread(task.historyIds, initial.readThrough);
    this.restoreAnchor = unread !== undefined ? { id: unread, line: 0 } : initial.anchor;
    if (!this.restoreAnchor && task.finalId !== undefined) {
      this.restoreAnchor = { id: task.finalId, line: 0 };
      // The finished report is the starting point; earlier activity stays available above it.
      const finalIndex = task.historyIds.indexOf(task.finalId);
      this.source.visit().readThrough ??=
        finalIndex > 0 ? (task.historyIds.at(finalIndex - 1) ?? null) : null;
    }
  }
  private restore(): void {
    const anchor = this.restoreAnchor;
    if (!anchor) {
      return;
    }
    const row = this.cards.lines.find((candidate) => candidate.entryIds.includes(anchor.id));
    if (row) {
      this.scroll.scrollTo(
        row.start + Math.min(anchor.line, Math.max(0, row.end - row.start - 1)),
        { disableFollow: true },
      );
    }
    this.restoreAnchor = undefined;
  }
  private visibleRead(
    task: ReadonlyInput<AgentTask>,
  ): { id: string; index: number; sequence: number } | undefined {
    const seen = new Set(
      this.cards.lines
        .filter(
          (row) =>
            row.end > this.scroll.scrollTop && row.end <= this.scroll.scrollTop + this.height,
        )
        .flatMap((row) => row.entryIds),
    );
    const index = task.historyIds.findLastIndex((id) => seen.has(id));
    const entry = task.historyIds.at(index);
    if (index < 0 || entry === undefined) {
      return;
    }
    const id = entry.startsWith("result:") ? (task.page?.latestEntryId ?? entry) : entry;
    const nativeId = id.replace(/:(?:\d+|error)$/, "");
    const sequence = task.page?.entries.find((record) => record.id === nativeId)?.sequence;
    return sequence === undefined ? undefined : { id, index, sequence };
  }
  private recordRead(): void {
    if (this.source.detail() || this.source.loading() || this.initialPosition) {
      return;
    }
    const task = this.source.task(),
      visit = this.source.visit();
    visit.anchor = this.scroll.isFollowingEnd ? undefined : this.anchor();
    const read = task && this.visibleRead(task);
    const priorIndex =
      typeof visit.readThrough === "string"
        ? (task?.historyIds.indexOf(visit.readThrough) ?? -1)
        : -1;
    if (
      read &&
      (read.sequence > this.readSequence ||
        (read.sequence === this.readSequence && read.index > priorIndex))
    ) {
      visit.readThrough = read.id;
      this.readSequence = read.sequence;
    }
    visit.readThrough ??= null;
    if (this.scroll.isFollowingEnd) {
      visit.seenActivityAt = task?.child.activity?.lastActivityAt ?? Date.now();
    }
  }
  render(width: number): string[] {
    if (this.lastWidth !== width && !this.scroll.isFollowingEnd) {
      this.restoreAnchor ??= this.anchor();
    }
    this.lastWidth = width;
    const lines = this.scroll.render(width);
    this.scroll.updateLayout(lines.length, this.height, () => this.tui.requestRender());
    this.initialize();
    this.restore();
    const visible = lines.slice(this.scroll.scrollTop, this.scroll.scrollTop + this.height);
    while (visible.length < this.height) {
      visible.push("");
    }
    this.recordRead();
    return visible;
  }
}
