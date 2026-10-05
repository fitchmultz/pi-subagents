import { hasText } from "./text-values.ts";
import type { TUI } from "@earendil-works/pi-tui";
import { readableText, type AgentHistoryItem } from "./agent-history.ts";
import type { AgentTask, AgentVisit, Anchor } from "./view-model.ts";
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

  async inspect(item: AgentHistoryItem): Promise<void> {
    const request = ++this.detailRequest,
      runId = this.effects.task()?.run.runId;
    this.conversationAnchor = this.effects.following() ? undefined : this.effects.anchor();
    this.loadingDetail = Boolean(item.load);
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
    try {
      const detail = item.load ? await item.load() : item;
      if (
        !this.closed &&
        request === this.detailRequest &&
        this.effects.task()?.run.runId === runId
      ) {
        this.detail = detail;
      }
    } catch (error) {
      if (
        !this.closed &&
        request === this.detailRequest &&
        this.effects.task()?.run.runId === runId
      ) {
        this.detailError = readableText(error instanceof Error ? error.message : String(error));
        this.detail = {
          id: item.id,
          kind: "notice",
          title: "Details unavailable",
          text: this.detailError,
          timestamp: item.timestamp,
        };
      }
    }
    if (!this.closed && request === this.detailRequest) {
      this.loadingDetail = false;
      this.tui.requestRender();
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
    let item = this.effects.selected();
    if (!item) {
      return;
    }
    const anchor = this.detail
      ? this.conversationAnchor
      : this.effects.following()
        ? undefined
        : this.effects.anchor();
    if (item.load && !this.detail) {
      const request = ++this.detailRequest,
        runId = this.effects.task()?.run.runId;
      this.loadingDetail = true;
      this.effects.compose(true);

      this.tui.requestRender();
      try {
        item = await item.load();
        if (
          this.closed ||
          request !== this.detailRequest ||
          this.effects.task()?.run.runId !== runId
        ) {
          return;
        }
      } catch (error) {
        if (!this.closed && request === this.detailRequest) {
          this.effects.visit().notice = `Quoted context unavailable; draft kept. ${readableText(error instanceof Error ? error.message : String(error))}`;
          this.effects.changed();
        }
        return;
      } finally {
        if (!this.closed && request === this.detailRequest) {
          this.loadingDetail = false;
          this.tui.requestRender();
        }
      }
    }
    this.effects.visit().quote = {
      title: item.title,
      text: (item.call || item.result
        ? [item.diff, item.details ?? item.text]
        : [item.text, item.diff, item.details]
      )
        .filter(Boolean)
        .join("\n\n"),
    };
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
      if (
        !this.closed &&
        request === this.detailRequest &&
        this.effects.task()?.run.runId === runId &&
        item
      ) {
        await this.inspect(item);
        this.tui.requestRender();
      }
    } catch (error) {
      if (
        !this.closed &&
        request === this.detailRequest &&
        this.effects.task()?.run.runId === runId
      ) {
        this.effects.visit().notice = `Changes unavailable: ${String(error)}`;
      }
    } finally {
      this.pendingDetail = false;
    }
  }
  dispose(): void {
    this.closed = true;
    this.detailRequest++;
  }
}
