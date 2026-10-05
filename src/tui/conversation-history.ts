import { hasText } from "./text-values.ts";
import type { TUI } from "@earendil-works/pi-tui";
import type { HistoryPageInput } from "../shared/types.ts";
import { getSingleResultOutput } from "../shared/utils.ts";
import { acceptanceHumanAction } from "../runs/shared/acceptance.ts";
import { formatAgentProcessExit } from "../shared/status-format.ts";
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
    } catch (error) {
      if (this.active(request)) {
        this.pageError = `History unavailable: ${error instanceof Error ? error.message : String(error)}. F5 retries the selected run.`;
      }
    } finally {
      if (this.active(request)) {
        this.loadingPage = false;
        const current = this.controller.task(this.key);
        if (current) {
          current.historyLoading = false;
        }
        this.tui.requestRender();
      }
    }
  }

  private async initialReportPage(
    result: HistorySelection,
    request: number,
  ): Promise<HistorySelection | undefined> {
    const task = this.controller.task(this.key),
      visit = this.source.initialVisit();
    if (!task) {
      return;
    }
    const finalId = result.history.finalId;
    if (
      !this.source.initialPosition() ||
      visit.readThrough !== undefined ||
      visit.anchor ||
      task.child.state === "live" ||
      finalId === undefined ||
      result.history.entryIds.includes(finalId)
    ) {
      return result;
    }
    const report = await this.controller.historyPage(this.key, {}, finalId);
    if (!this.active(request) || !this.controller.task(this.key)) {
      return;
    }
    return report ?? result;
  }

  private async savedReport(
    history: AgentHistory,
    request: number,
  ): Promise<AgentHistory | undefined> {
    const task = this.controller.task(this.key);
    if (!task) {
      return;
    }
    const showsFinal = history.finalId !== undefined && history.entryIds.includes(history.finalId);
    if (
      !(this.source.initialPosition() || this.latestPage || showsFinal) ||
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
    const page = task.page;
    const status =
      this.pageError ??
      (this.loadingPage && !task.page
        ? "Loading conversation…"
        : page?.freshness.state === "catching-up"
          ? "Catching up · partial history"
          : page?.freshness.state === "degraded"
            ? "Some saved history unavailable · F5 retry"
            : undefined);
    const items = [
      this.assignment(),
      ...(hasText(status)
        ? [
            {
              id: "history-loading",
              kind: "notice" as const,
              title: status,
              text: "",
              timestamp: 0,
            },
          ]
        : []),
      ...(page && page.count > page.entries.length
        ? [
            {
              id: "history-page",
              kind: "notice" as const,
              title: `History · ${page.entries.length} of ${page.count} native records${this.latestPage ? " · latest" : ""}`,
              text: "F2 Actions → Earlier history / Later history / Latest. Full details validates the selected native record.",
              timestamp: 0,
            },
          ]
        : []),
      ...(!(task.child.identityUnavailable === true) && task.child.state !== "live"
        ? [
            {
              id: "process-exit",
              kind: "notice" as const,
              title: `Agent: ${task.child.state}`,
              text: formatAgentProcessExit(task.child.result?.agentProcessExit),
              timestamp: task.run.updatedAt,
            },
          ]
        : []),
      ...task.history,
    ];
    const humanAction =
      task.child.humanAction ?? acceptanceHumanAction(task.child.result?.acceptance);
    if (hasText(humanAction) && !(task.child.identityUnavailable === true)) {
      items.push({
        id: "human-action",
        kind: "notice",
        title: "Needs your action — acceptance incomplete",
        text: humanAction,
        timestamp: task.run.updatedAt,
      });
    }
    if (hasText(task.unavailable) && !(task.child.identityUnavailable === true)) {
      items.push({
        id: "unavailable",
        kind: "notice",
        title: "Conversation unavailable",
        text: task.unavailable,
        timestamp: 0,
      });
    }
    if (task.question) {
      items.push({
        id: `question:${task.question.questionId}`,
        kind: "notice",
        title: "Waiting for your answer",
        text: task.question.message,
        timestamp: task.question.createdAt,
      });
    }
    if (
      !(task.child.identityUnavailable === true) &&
      task.child.state === "live" &&
      hasText(task.child.activity?.streamingText)
    ) {
      items.push({
        id: `live:${task.run.runId}`,
        kind: "assistant",
        title: "Agent · writing",
        text: task.child.activity.streamingText,
        timestamp: task.child.activity.lastActivityAt ?? 0,
      });
    }
    for (const sent of this.controller.visit(this.key).outbox) {
      items.push({
        id: `outgoing:${sent.id}`,
        kind: "user",
        title:
          sent.status === "sending"
            ? "You · sending"
            : sent.status === "waiting"
              ? "You · waiting for the child / tool boundary"
              : "You · delivery unconfirmed",
        text: `${sent.text}${sent.quote ? `\n\nRegarding ${sent.quote.title}:\n${sent.quote.text}` : ""}${hasText(sent.reason) ? `\n\n${sent.reason}` : ""}`,
        timestamp: sent.at,
      });
    }
    return items;
  }
  dispose(): void {
    this.closed = true;
    this.pageRequest++;
  }
}
