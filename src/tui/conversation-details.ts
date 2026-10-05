import { hasText, errorText } from "./text-values.ts";
import type { TUI } from "@earendil-works/pi-tui";
import { readableText, type AgentHistoryItem } from "./agent-history.ts";
import type { AgentTask, AgentVisit, Anchor, Quote } from "./view-model.ts";
function quote(item: AgentHistoryItem): Quote {
  const parts =
    item.call || item.result
      ? [item.diff, item.details ?? item.text]
      : [item.text, item.diff, item.details];
  return { title: item.title, text: parts.filter(Boolean).join("\n\n") };
}
interface DetailEffects {
  readonly task: () => AgentTask | undefined;
  readonly visit: () => AgentVisit;
  readonly selected: () => AgentHistoryItem | undefined;
  readonly following: () => boolean;
  readonly anchor: () => Anchor | undefined;
  readonly compose: (value: boolean) => void;
  readonly closeMenu: () => void;
  readonly restore: (anchor: Anchor | undefined) => void;
  readonly toStart: () => void;
  readonly toEnd: () => void;
  readonly changed: () => void;
  readonly back: () => void;
  readonly changes: () => Promise<AgentHistoryItem | undefined>;
}
export class ConversationDetails {
  detail?: AgentHistoryItem;
  detailError?: string;
  loadingDetail = false;
  pendingDetail = false;
  detailRequest = 0;
  conversationAnchor?: Anchor;
  private closed = false;
  private readonly tui: TUI;
  private readonly effects: DetailEffects;
  constructor(tui: TUI, effects: DetailEffects) {
    this.tui = tui;
    this.effects = effects;
  }
  private active(request: number): boolean {
    return !this.closed && request === this.detailRequest;
  }
  private sameAttempt(request: number, runId: string | undefined): boolean {
    return this.active(request) && this.effects.task()?.run.runId === runId;
  }
  private begin(item: AgentHistoryItem): void {
    this.conversationAnchor = this.effects.following() ? undefined : this.effects.anchor();
    this.loadingDetail = item.load !== undefined;
    this.detailError = undefined;
    this.detail = item.load
      ? {
          id: item.id,
          kind: "notice",
          title: "Loading selected details…",
          text: "Native record validation is running in the history process.",
          timestamp: item.timestamp,
        }
      : item;
    this.effects.closeMenu();
    this.effects.compose(false);
    this.effects.toStart();
    this.effects.restore({ id: item.id, line: 0 });
    this.tui.requestRender();
  }
  async inspectSelected(): Promise<void> {
    const item = this.effects.selected();
    if (item) {
      await this.inspect(item);
    }
  }
  async inspect(item: AgentHistoryItem): Promise<void> {
    const request = ++this.detailRequest,
      runId = this.effects.task()?.run.runId;
    this.begin(item);
    try {
      const detail = item.load ? await item.load() : item;
      if (this.sameAttempt(request, runId)) {
        this.detail = detail;
      }
    } catch (error) {
      if (this.sameAttempt(request, runId)) {
        this.detailError = readableText(errorText(error));
        this.detail = {
          id: item.id,
          kind: "notice",
          title: "Details unavailable",
          text: this.detailError,
          timestamp: item.timestamp,
        };
      }
    }
    if (this.active(request)) {
      this.loadingDetail = false;
      this.tui.requestRender();
    }
  }
  private replyAnchor(): Anchor | undefined {
    if (this.detail) {
      return this.conversationAnchor;
    }
    return this.effects.following() ? undefined : this.effects.anchor();
  }
  private async quoteItem(item: AgentHistoryItem): Promise<AgentHistoryItem | undefined> {
    if (!item.load || this.detail) {
      return item;
    }
    const request = ++this.detailRequest,
      runId = this.effects.task()?.run.runId;
    this.loadingDetail = true;
    this.effects.compose(true);
    this.tui.requestRender();
    try {
      const full = await item.load();
      return this.sameAttempt(request, runId) ? full : undefined;
    } catch (error) {
      if (this.active(request)) {
        this.effects.visit().notice = `Quoted context unavailable; draft kept. ${readableText(errorText(error))}`;
        this.effects.changed();
      }
      return;
    } finally {
      if (this.active(request)) {
        this.loadingDetail = false;
        this.tui.requestRender();
      }
    }
  }
  async reply(): Promise<void> {
    if (this.loadingDetail) {
      return;
    }
    if (this.detail && hasText(this.detailError)) {
      this.effects.visit().notice = `Quoted context unavailable; draft kept. ${this.detailError}`;
      this.effects.back();
      this.effects.changed();
      return;
    }
    const selected = this.effects.selected();
    if (!selected) {
      return;
    }
    const anchor = this.replyAnchor();
    let item: AgentHistoryItem | undefined = selected;
    if (selected.load && !this.detail) {
      item = await this.quoteItem(selected);
    }
    if (!item) {
      return;
    }
    this.effects.visit().quote = quote(item);
    this.detailRequest++;
    this.detail = undefined;
    this.effects.closeMenu();
    this.effects.compose(true);
    this.effects.restore(anchor);
    this.effects.changed();
  }
  async changes(): Promise<void> {
    if (this.pendingDetail) {
      return;
    }
    const request = ++this.detailRequest,
      runId = this.effects.task()?.run.runId;
    this.pendingDetail = true;
    try {
      const item = await this.effects.changes();
      if (item && this.sameAttempt(request, runId)) {
        await this.inspect(item);
        this.tui.requestRender();
      }
    } catch (error) {
      if (this.sameAttempt(request, runId)) {
        this.effects.visit().notice = `Changes unavailable: ${errorText(error)}`;
      }
    } finally {
      this.pendingDetail = false;
    }
  }
  close(): boolean {
    if (!this.detail) {
      return false;
    }
    this.detailRequest++;
    this.loadingDetail = false;
    this.detail = undefined;
    this.effects.compose(true);
    this.effects.restore(this.conversationAnchor);
    if (!this.conversationAnchor) {
      this.effects.toEnd();
    }
    return true;
  }
  unquote(): void {
    if (this.loadingDetail && !this.detail) {
      this.detailRequest++;
      this.loadingDetail = false;
    }
    this.effects.visit().quote = undefined;
    this.effects.changed();
  }
  dispose(): void {
    this.closed = true;
    this.detailRequest++;
  }
}
