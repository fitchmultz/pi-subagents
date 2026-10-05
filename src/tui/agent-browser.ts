import type {
  SubagentState,
  HistoryPageInput,
  HistoryPage,
  HistoryRunPage,
  HistoryIndexHandle,
  HistoryEntry,
} from "../shared/types.ts";
import { runHistoryIndex } from "../runs/shared/history-index.ts";
import { indexedHistory, readableText, type AgentHistoryItem } from "./agent-history.ts";
import type { AgentTask } from "./view-model.ts";
import type { HistorySelection } from "./view-ports.ts";
import { AgentTaskStore } from "./task-store.ts";
import { ViewSession } from "./view-session.ts";
import { hasText, errorText } from "./text-values.ts";
interface BrowseRequest {
  readonly generation: number;
  readonly request: number;
  readonly offset: number;
  readonly text: string;
}
type Paging = Pick<HistoryPageInput, "before" | "after" | "cursor">;
function boundary(
  input: HistoryPageInput,
): Pick<HistoryPageInput, "runId" | "index" | "terminalEntryId" | "endedAt"> {
  return {
    runId: input.runId,
    index: input.index,
    terminalEntryId: input.terminalEntryId,
    endedAt: input.endedAt,
  };
}
async function readMarker(
  index: HistoryIndexHandle,
  input: HistoryPageInput,
): Promise<HistoryEntry | null | undefined> {
  if (!hasText(input.readThrough) || input.readThrough.startsWith("result:")) {
    return;
  }
  return index.entry({
    ...boundary(input),
    entryId: input.readThrough.replace(/:(?:\d+|error)$/, ""),
  });
}
async function anchorPaging(
  index: HistoryIndexHandle,
  input: HistoryPageInput,
  anchor: string | null | undefined,
  marker: HistoryEntry | null | undefined,
): Promise<Paging | undefined> {
  if (anchor === null) {
    return { after: 0 };
  }
  if (!hasText(anchor) || anchor.startsWith("result:")) {
    return;
  }
  const entry =
    anchor === input.readThrough
      ? marker
      : await index.entry({ ...boundary(input), entryId: anchor.replace(/:(?:\d+|error)$/, "") });
  return entry ? { after: Math.max(0, entry.sequence - 1) } : undefined;
}

/** Browse requests own paging, subscriptions and stale-observation guards, never execution authority. */
export class AgentBrowser {
  private refreshPromise?: Promise<void>;
  private indexUnsubscribe?: () => void;
  private listRequest = 0;
  private appliedListRequest = -1;
  private filter = "";
  private offset = 0;
  listPage?: HistoryRunPage;
  listLoading = false;
  listError?: string;
  private readonly state: SubagentState;
  private readonly store: AgentTaskStore;
  private readonly session: ViewSession;
  private readonly notify: () => void;
  constructor(
    state: SubagentState,
    store: AgentTaskStore,
    session: ViewSession,
    notify: () => void,
  ) {
    this.state = state;
    this.store = store;
    this.session = session;
    this.notify = notify;
  }
  get listFilter(): string {
    return this.filter;
  }
  get listPending(): boolean {
    return !this.listPage || this.appliedListRequest !== this.listRequest;
  }
  private active(snapshot: BrowseRequest): boolean {
    return this.session.live(snapshot.generation) && snapshot.request === this.listRequest;
  }
  private wake(): void {
    this.refresh().catch((error: unknown) => {
      if (this.session.live()) {
        this.listError = errorText(error);
        this.notify();
      }
    });
  }
  refresh(browse = false): Promise<void> {
    if (!this.session.live()) {
      return Promise.resolve();
    }
    if (!browse && (this.state.ownedRuns?.size ?? 0) === 0 && !this.state.historyIndex) {
      return Promise.resolve();
    }
    if (this.refreshPromise) {
      return this.refreshPromise;
    }
    const snapshot = {
      generation: this.session.generation,
      request: this.listRequest,
      offset: this.offset,
      text: this.filter,
    };
    this.listLoading = this.listPending;
    this.refreshPromise = this.refreshPage(snapshot);
    return this.refreshPromise;
  }
  private async refreshPage(snapshot: BrowseRequest): Promise<void> {
    try {
      const index = await runHistoryIndex(this.state);
      if (!this.session.live(snapshot.generation)) {
        return;
      }
      this.indexUnsubscribe ??= index.onChanged(() => this.wake());
      const page = await index.listRuns({
        offset: snapshot.offset,
        limit: 50,
        text: hasText(snapshot.text) ? snapshot.text : undefined,
        sort: "attention",
        latestTasksOnly: true,
      });
      const dock =
        hasText(snapshot.text) || snapshot.offset !== 0
          ? await index.listRuns({ limit: 50, sort: "attention", latestTasksOnly: true })
          : page;
      if (!this.active(snapshot)) {
        return;
      }
      this.applyLists(page, dock, snapshot);
      await this.observeMetadata(index, snapshot);
    } catch (error) {
      if (this.active(snapshot)) {
        this.listError = `Agents history unavailable: ${errorText(error)}. Retry (F5).`;
      }
    } finally {
      this.finishRefresh(snapshot);
    }
  }
  private applyLists(page: HistoryRunPage, dock: HistoryRunPage, snapshot: BrowseRequest): void {
    this.listPage = page;
    this.appliedListRequest = snapshot.request;
    this.listError = undefined;
    this.store.browsePage(page.rows);
    this.store.dockTasks = dock.rows.flatMap((row) => this.store.fromView(row));
  }
  private shouldObserve(task: Readonly<AgentTask>): boolean {
    const visit = this.store.visits.get(task.key);
    if (!visit || task.child.identityUnavailable === true) {
      return false;
    }
    const idle =
      task.child.state !== "live" &&
      !task.question &&
      task.key !== this.store.selectedKey &&
      task.key !== this.store.pinned;
    return !idle || visit.outbox.length > 0 || task.metadataAt !== task.run.updatedAt;
  }
  private async observeMetadata(index: HistoryIndexHandle, snapshot: BrowseRequest): Promise<void> {
    const markers = new Map(
      [...this.store.tasks, ...this.store.dockTasks].map((task) => [task.key, task]),
    );
    for (const task of markers.values()) {
      if (!this.shouldObserve(task)) {
        continue;
      }
      // Each observation applies before the next bounded query; owner/read markers may change at its await.
      // oxlint-disable-next-line no-await-in-loop
      await this.observeTask(index, task, snapshot);
      if (!this.active(snapshot)) {
        return;
      }
    }
  }
  private async observeTask(
    index: HistoryIndexHandle,
    task: Readonly<AgentTask>,
    snapshot: BrowseRequest,
  ): Promise<void> {
    try {
      const page = await index.historyPage({ ...this.store.historyInput(task), limit: 1 });
      if (!this.active(snapshot)) {
        return;
      }
      for (const observed of [...this.store.tasks, ...this.store.dockTasks].filter(
        (candidate) => candidate.key === task.key,
      )) {
        this.store.applyMetadata(observed, page);
      }
    } catch (error) {
      if (this.active(snapshot)) {
        this.store.metadataUnavailable(
          task.key,
          `Conversation metadata unavailable: ${errorText(error)}`,
        );
      }
    }
  }
  private finishRefresh(snapshot: BrowseRequest): void {
    if (!this.session.live(snapshot.generation)) {
      return;
    }
    this.listLoading = false;
    this.refreshPromise = undefined;
    this.notify();
    if (snapshot.request !== this.listRequest) {
      this.wake();
    }
  }
  filterTasks(text: string): void {
    if (text === this.filter) {
      return;
    }
    this.filter = text.slice(0, 256);
    this.offset = 0;
    this.listRequest++;
    this.store.tasks = this.store.tasks.filter(
      (task) => task.key === this.store.selectedKey || task.key === this.store.pinned,
    );
    this.wake();
  }
  pageTasks(direction: "earlier" | "later"): void {
    const next = direction === "later" ? this.listPage?.nextOffset : Math.max(0, this.offset - 50);
    if (next === undefined || next === this.offset) {
      return;
    }
    this.offset = next;
    this.listRequest++;
    this.wake();
  }
  async retry(key?: string): Promise<void> {
    const generation = this.session.generation;
    try {
      const index = await runHistoryIndex(this.state, true);
      await index.refresh(hasText(key) ? this.store.task(key)?.run.runId : undefined);
    } catch (error) {
      if (this.session.live(generation)) {
        this.listError = `History refresh unavailable: ${errorText(error)}`;
      }
    }
    if (this.session.live(generation)) {
      await this.refresh();
    }
  }
  async historyPage(
    key: string,
    paging: Paging = {},
    anchor?: string | null,
  ): Promise<HistorySelection | undefined> {
    const task = this.store.task(key),
      generation = this.session.generation;
    if (!task || !this.session.live() || task.child.identityUnavailable === true) {
      return;
    }
    const input = this.store.historyInput(task),
      index = await runHistoryIndex(this.state);
    const marker = await readMarker(index, input),
      selectedPaging = (await anchorPaging(index, input, anchor, marker)) ?? paging;
    const result = await indexedHistory(index, { ...input, limit: 100, ...selectedPaging });
    if (!this.session.live(generation) || this.store.task(key)?.run.runId !== task.run.runId) {
      return;
    }
    const latestPage =
      selectedPaging.after !== undefined
        ? !result.page.hasMore
        : selectedPaging.before === undefined && selectedPaging.cursor === undefined;
    const unreadStart =
      input.readThrough === null || input.readThrough === undefined ? -1 : undefined;
    return { ...result, latestPage, readThroughSequence: marker?.sequence ?? unreadStart };
  }
  async savedResult(key: string, id: string): Promise<AgentHistoryItem> {
    const task = this.store.task(key),
      generation = this.session.generation;
    if (!task || !this.session.live()) {
      throw new Error("The owning session is no longer available.");
    }
    const index = await runHistoryIndex(this.state),
      result = await index.result({ runId: task.run.runId, index: task.child.index });
    if (!this.session.live(generation) || this.store.task(key)?.run.runId !== task.run.runId) {
      throw new Error("The selected attempt changed; choose the report again.");
    }
    if (!result) {
      throw new Error("The selected saved report is unavailable.");
    }
    return {
      id,
      kind: "assistant",
      title: "Saved result",
      text: readableText(result.text),
      timestamp: result.timestamp,
    };
  }
  dispose(): void {
    this.indexUnsubscribe?.();
    this.indexUnsubscribe = undefined;
    this.refreshPromise = undefined;
    this.listRequest++;
    this.listPage = undefined;
    this.listError = undefined;
    this.listLoading = false;
    this.offset = 0;
    this.filter = "";
  }
}
