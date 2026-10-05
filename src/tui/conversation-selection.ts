import type { ScrollView, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { AgentHistoryItem } from "./agent-history.ts";
import type { HistoryCards } from "./history-cards.ts";
/** Conversation selection and per-card expansion are independent of draft/control state. */
export class ConversationSelection {
  id?: string;
  toolsExpanded = false;
  readonly toolExpansion = new Map<string, boolean>();
  private readonly cards: HistoryCards;
  private readonly scroll: ScrollView;
  constructor(cards: HistoryCards, scroll: ScrollView) {
    this.cards = cards;
    this.scroll = scroll;
  }
  selected(detail?: AgentHistoryItem): AgentHistoryItem | undefined {
    return (
      detail ??
      this.cards.contentItems.find((item) => item.id === this.id) ??
      this.cards.contentItems.findLast((item) => item.kind === "assistant")
    );
  }
  mouse(event: Readonly<TuiMouseEvent>, detail: boolean): TuiMouseEventResult | undefined {
    if (event.type !== "click" || event.button !== "left") {
      return;
    }
    const row = this.cards.lines.find(
      (candidate) =>
        candidate.start <= event.y + this.scroll.scrollTop &&
        candidate.end > event.y + this.scroll.scrollTop,
    );
    if (!row) {
      return;
    }
    this.id = row.id;
    const item = this.selected();
    if ((item?.call || item?.result) && !detail) {
      this.toolExpansion.set(row.id, !(this.toolExpansion.get(row.id) ?? this.toolsExpanded));
    } else {
      this.cards.dispatch(row.id, {
        ...event,
        y: event.y + this.scroll.scrollTop - row.contentStart,
        height: row.end - row.contentStart,
      });
    }
    return { handled: true, focus: true };
  }
  select(delta: number, height: number): void {
    const current = this.cards.lines.findIndex((row) => row.id === this.id);
    const visible =
      current < 0 ? this.cards.lines.findIndex((row) => row.end > this.scroll.scrollTop) : current;
    const index = Math.max(0, Math.min(this.cards.lines.length - 1, visible + delta));
    const row = this.cards.lines.at(index);
    if (!row) {
      return;
    }
    this.id = row.id;
    if (row.start < this.scroll.scrollTop || row.start >= this.scroll.scrollTop + height) {
      this.scroll.scrollTo(row.start, { disableFollow: true });
    }
  }
  expand(): void {
    this.toolsExpanded = !this.toolsExpanded;
    this.toolExpansion.clear();
  }
}
