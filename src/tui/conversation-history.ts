import { errorText } from "./text-values.ts";
import {
  historyStatus,
  pageNotices,
  taskNotices,
  outgoingHistory,
} from "./conversation-notices.ts";
import type { TUI } from "@earendil-works/pi-tui";
import type { HistoryPageInput } from "../shared/types.ts";
import { getSingleResultOutput } from "../shared/utils.ts";
import { withFinalResult, type AgentHistoryItem, type AgentHistory } from "./agent-history.ts";
import { UNAVAILABLE_ASSIGNMENT, type AgentVisit } from "./view-model.ts";
import type { ConversationController, HistorySelection } from "./view-ports.ts";
interface PageSource {
  readonly initialPosition: () => boolean;
  readonly initialVisit: () => Pick<AgentVisit, "anchor" | "readThrough">;
  readonly readSequence: (sequence: number) => void;
  readonly clearCards: () => void;
}

export class ConversationHistory {
  loadingPage = false;
  pageError?: string;
  latestPage = true;
  seenSource = false;
  private pageRequest = 0;
  private closed = false;
  private readonly tui: TUI;
  private readonly controller: ConversationController;
  private readonly key: string;
  private readonly source: PageSource;
  constructor(tui: TUI, controller: ConversationController, key: string, source: PageSource) {
    this.tui = tui;
    this.controller = controller;
    this.key = key;
    this.source = source;
    this.seenSource = Boolean(controller.task(key)?.page?.count);
  }

  private active(request: number): boolean {
    return !this.closed && request === this.pageRequest;
  }

  async loadPage(
    paging: Pick<HistoryPageInput, "before" | "after" | "cursor"> = {},
    anchor?: string | null,
  ): Promise<void> {
    if (this.closed) {
      return;
    }
    const request = ++this.pageRequest;
    this.loadingPage = true;
    this.pageError = undefined;
    const task = this.controller.task(this.key);
    if (task) {
      task.historyLoading = true;
    }
    this.latestPage =
      paging.before === undefined && paging.after === undefined && paging.cursor === undefined;
    this.tui.requestRender();
    try {
      await this.resolvePage(paging, anchor, request);
    } catch (error) {
      if (this.active(request)) {
        this.pageError = `History unavailable: ${errorText(error)}. F5 retries the selected run.`;
      }
    } finally {
      this.finishPage(request);
    }
  }

  private finishPage(request: number): void {
    if (!this.active(request)) {
      return;
    }
    this.loadingPage = false;
    const current = this.controller.task(this.key);
    if (current) {
      current.historyLoading = false;
    }
    this.tui.requestRender();
  }
  private async resolvePage(
    paging: Pick<HistoryPageInput, "before" | "after" | "cursor">,
    anchor: string | null | undefined,
    request: number,
  ): Promise<void> {
    const selected = await this.controller.historyPage(this.key, paging, anchor);
    if (!selected || !this.active(request)) {
      return;
    }
    const result = await this.initialReportPage(selected, request);
    if (!result || !this.active(request)) {
      return;
    }
    if (result.readThroughSequence !== undefined) {
      this.source.readSequence(result.readThroughSequence);
    }
    this.latestPage = result.latestPage;
    const history = await this.savedReport(result.history, request);
    if (history && this.active(request)) {
      this.applyPage(history, result);
    }
  }
  private needsInitialReport(result: HistorySelection): boolean {
    const task = this.controller.task(this.key),
      visit = this.source.initialVisit();
    if (
      !task ||
      !this.source.initialPosition() ||
      visit.readThrough !== undefined ||
      visit.anchor ||
      task.child.state === "live"
    ) {
      return false;
    }
    const finalId = result.history.finalId;
    return finalId !== undefined && !result.history.entryIds.includes(finalId);
  }
  private async initialReportPage(
    result: HistorySelection,
    request: number,
  ): Promise<HistorySelection | undefined> {
    if (!this.controller.task(this.key)) {
      return;
    }
    if (!this.needsInitialReport(result)) {
      return result;
    }
    const report = await this.controller.historyPage(this.key, {}, result.history.finalId);
    if (!this.active(request) || !this.controller.task(this.key)) {
      return;
    }
    return report ?? result;
  }

  private includeReport(history: AgentHistory): boolean {
    return (
      this.source.initialPosition() ||
      this.latestPage ||
      (history.finalId !== undefined && history.entryIds.includes(history.finalId))
    );
  }
  private async savedReport(
    history: AgentHistory,
    request: number,
  ): Promise<AgentHistory | undefined> {
    const task = this.controller.task(this.key);
    if (!task) {
      return;
    }
    const includeReport = this.includeReport(history);
    if (
      !includeReport ||
      task.child.state === "live" ||
      !task.child.result ||
      getSingleResultOutput(task.child.result).length === 0
    ) {
      return history;
    }
    const runId = task.run.runId;
    const report = await this.controller.savedResult(this.key, `result:${runId}`);
    const current = this.controller.task(this.key);
    if (!this.active(request) || !current || current.run.runId !== runId) {
      return;
    }
    return withFinalResult(history, report.text, runId, current.run.updatedAt);
  }

  private applyPage(history: AgentHistory, result: HistorySelection): void {
    const task = this.controller.task(this.key);
    if (!task) {
      return;
    }
    task.history = history.items.map((item) =>
      item.id === `result:${task.run.runId}`
        ? { ...item, load: () => this.controller.savedResult(this.key, item.id) }
        : item,
    );
    task.historyIds = history.entryIds;
    task.finalId = history.finalId;
    task.page = result.page;
    this.seenSource ||= result.page.count > 0;
    task.unavailable =
      !this.seenSource &&
      task.child.state === "live" &&
      ["missing", "pending", "indexing", "unlinked"].includes(result.page.sourceState)
        ? undefined
        : history.unavailable;
    this.controller.applyMetadata(task, result.page);
    this.source.clearCards();
  }

  assignment(): AgentHistoryItem {
    const task = this.controller.task(this.key);
    if (!task) {
      return {
        id: "assignment",
        kind: "notice",
        title: "Assignment unavailable",
        text: UNAVAILABLE_ASSIGNMENT,
        timestamp: 0,
      };
    }
    return {
      id: "assignment",
      kind: "notice",
      title:
        task.child.identityUnavailable === true
          ? "Assignment unavailable"
          : `Assignment · ${task.child.agent}`,
      text:
        task.child.identityUnavailable === true
          ? UNAVAILABLE_ASSIGNMENT
          : `${task.model.details}\n\n${task.child.task ?? "The original per-child assignment was not saved for this older run."}`,
      timestamp: task.run.startedAt,
    };
  }

  items(detail?: AgentHistoryItem): AgentHistoryItem[] {
    const task = this.controller.task(this.key);
    if (!task) {
      return [
        {
          id: "unavailable",
          kind: "notice",
          title: "Agent unavailable",
          text: "The owning session or run is no longer available.",
          timestamp: 0,
        },
      ];
    }
    if (detail) {
      return [detail];
    }
    const status = this.pageError ?? historyStatus(task.page, this.loadingPage);
    return [
      this.assignment(),
      ...pageNotices(task, status, this.latestPage),
      ...task.history,
      ...taskNotices(task),
      ...this.controller.visit(this.key).outbox.map(outgoingHistory),
    ];
  }
  dispose(): void {
    this.closed = true;
    this.pageRequest++;
  }
}
