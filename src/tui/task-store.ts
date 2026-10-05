import { hasText, errorText } from "./text-values.ts";
import { listOwnedRunQuestions } from "../runs/shared/supervisor-questions.ts";
import { ownedRunView } from "../runs/shared/run-records.ts";
import type {
  SubagentState,
  OwnedRun,
  OwnedRunView,
  HistoryRunRow,
  HistoryPageInput,
  HistoryPage,
  SupervisorQuestionView,
} from "../shared/types.ts";
import {
  UNAVAILABLE_ASSIGNMENT,
  PENDING_MESSAGE_NOTICE,
  agentModel,
  unavailableModel,
  type AgentTask,
  type AgentVisit,
} from "./view-model.ts";
import {
  selectedChild,
  observedTask,
  observedLabel,
  cachedHistory,
  observedConfiguration,
  activityUnread,
  observationFlags,
  observedQuestion,
} from "./task-observation.ts";
type Identity = Pick<
  OwnedRunView["children"][number],
  "index" | "workflowNodeId" | "sessionFile" | "identityUnavailable"
>;
function identityKey(run: OwnedRun, child: Identity, stable: boolean): string {
  let identity: string | number = child.index;
  if (child.workflowNodeId !== undefined) {
    identity = child.workflowNodeId;
  } else if (run.mode === "chain") {
    identity = chainIdentity(child, stable);
  }
  return `${run.runId}:${identity}`;
}
function chainIdentity(child: Identity, stable: boolean): string | number {
  if (!stable) {
    return child.sessionFile ?? child.index;
  }
  return hasText(child.sessionFile) && child.identityUnavailable !== true
    ? `session:${child.sessionFile}`
    : child.index;
}
function authorityUnavailable(task: Readonly<AgentTask>, reason: string): AgentTask {
  return {
    ...task,
    child: { ...task.child, state: "unknown", identityUnavailable: true },
    question: undefined,
    unavailable: reason,
  };
}
/** Drafts/outbox and the current task observation cache have one mutable owner. */
export class AgentTaskStore {
  tasks: AgentTask[] = [];
  dockTasks: AgentTask[] = [];
  readonly taskKeys = new Map<string, string>();
  visits = new Map<string, AgentVisit>();
  selectedKey?: string;
  pinned?: string;
  private readonly state: SubagentState;
  private readonly syncDraft: () => void;
  constructor(state: SubagentState, syncDraft: () => void) {
    this.state = state;
    this.syncDraft = syncDraft;
  }
  visit(key: string): AgentVisit {
    let visit = this.visits.get(key);
    if (!visit) {
      visit = { draft: "", outbox: [] };
      this.visits.set(key, visit);
    }
    return visit;
  }
  task(key: string): AgentTask | undefined {
    return this.tasks.find((task) => task.key === key);
  }
  private taskKey(run: OwnedRun, child: Identity): string {
    const path = new Set<string>();
    let cursor = { run, child },
      key: string;
    for (;;) {
      const cache = identityKey(cursor.run, cursor.child, false),
        cached = this.taskKeys.get(cache);
      if (cached !== undefined) {
        key = cached;
        break;
      }
      if (path.has(cache)) {
        throw new Error("Cyclic saved continuation ancestry");
      }
      path.add(cache);
      const predecessor = hasText(cursor.run.predecessorRunId)
        ? this.state.ownedRuns?.get(cursor.run.predecessorRunId)
        : undefined;
      if (!predecessor) {
        key = identityKey(cursor.run, cursor.child, true);
        break;
      }
      const index = cursor.run.predecessorIndex ?? 0;
      cursor = {
        run: predecessor,
        child: predecessor.children.find((candidate) => candidate.index === index) ?? { index },
      };
    }
    for (const cache of path) {
      this.taskKeys.set(cache, key);
    }
    return key;
  }
  fromView(view: HistoryRunRow, questions = view.questions ?? [], canonical = false): AgentTask[] {
    return view.children
      .filter(
        (child) =>
          view.matchedChildIndexes === undefined || view.matchedChildIndexes.includes(child.index),
      )
      .map((child) => this.taskFromChild(view, child, questions, canonical));
  }
  private taskFromChild(
    view: HistoryRunRow,
    child: HistoryRunRow["children"][number],
    questions: readonly SupervisorQuestionView[],
    canonical: boolean,
  ): AgentTask {
    const key = this.taskKey(view, child),
      prior = this.task(key) ?? this.dockTasks.find((task) => task.key === key),
      visit = this.visits.get(key);
    const sameAttempt = prior?.run.runId === view.runId,
      retained = sameAttempt ? prior : undefined;
    const selected = !canonical && this.selectedKey === key && retained !== undefined;
    const display = selected ? selectedChild(child, retained, view.updatedAt) : child;
    const observed = observedTask(retained, child.state, view.updatedAt);
    return {
      key,
      label: observedLabel(child, prior, sameAttempt),
      run: view,
      child: display,
      model: agentModel(display, observedConfiguration(child, retained, canonical)),
      ...cachedHistory(retained),
      ...observationFlags(retained, observed, activityUnread(child, view.updatedAt, visit)),
      unavailable:
        child.missingSession === true && child.state !== "live"
          ? "Saved conversation unavailable."
          : view.diagnosis,
      question: observedQuestion(child, questions),
    };
  }
  unavailableTask(key: string, run: OwnedRunView): AgentTask {
    return {
      key,
      label: "Saved assignment unavailable",
      run,
      child: {
        agent: "unknown",
        index: -1,
        state: "unknown",
        configuration: "legacy-partial",
        identityUnavailable: true,
      },
      model: unavailableModel,
      history: [],
      historyIds: [],
      unavailable: UNAVAILABLE_ASSIGNMENT,
      unread: false,
      replied: false,
    };
  }
  private latestTasks(rows: readonly HistoryRunRow[]): Map<string, AgentTask> {
    const tasks = new Map<string, AgentTask>();
    for (const row of rows) {
      for (const task of this.fromView(row)) {
        const prior = tasks.get(task.key);
        if (!prior || prior.run.startedAt <= task.run.startedAt) {
          tasks.set(task.key, task);
        }
      }
    }
    return tasks;
  }
  private retainDrafts(tasks: Map<string, AgentTask>, rows: readonly HistoryRunRow[]): void {
    for (const [key, visit] of this.visits) {
      const empty =
        !hasText(visit.draft) && !visit.quote && visit.outbox.length === 0 && this.pinned !== key;
      if (tasks.has(key) || empty) {
        continue;
      }
      const row = rows.find((run) => run.runId === key.split(":")[0]);
      if (row) {
        tasks.set(key, this.unavailableTask(key, row));
      }
    }
  }
  browsePage(rows: readonly HistoryRunRow[]): void {
    const tasks = this.latestTasks(rows);
    this.retainDrafts(tasks, rows);
    for (const key of [this.selectedKey, this.pinned]) {
      if (!hasText(key)) {
        continue;
      }
      const retained = this.task(key);
      if (retained && !tasks.has(key)) {
        tasks.set(key, retained);
      }
    }
    this.tasks = [...tasks.values()];
  }
  historyInput(task: Readonly<AgentTask>): HistoryPageInput {
    const visit = this.visits.get(task.key),
      ids = visit?.outbox.slice(0, 999).map((sent) => sent.id) ?? [];
    if (hasText(visit?.lastSentId)) {
      ids.push(visit.lastSentId);
    }
    const common = {
      runId: task.run.runId,
      index: task.child.index,
      messageIds: [...new Set(ids)],
      readThrough: visit?.readThrough,
    };
    if (task.child.state === "live") {
      return common;
    }
    const terminal = task.child.result?.terminalEntryId;
    return {
      ...common,
      leaf: task.child.result?.terminalLeafId,
      terminalEntryId: terminal,
      endedAt: hasText(terminal) ? undefined : task.run.updatedAt,
    };
  }
  applyMetadata(task: AgentTask, page: HistoryPage): void {
    const visit = this.visits.get(task.key),
      delivered = new Map(page.deliveredMessages);
    if (page.freshness.state !== "catching-up") {
      task.metadataAt = task.run.updatedAt;
    }
    task.model = agentModel(task.child, page.configuration);
    task.unread = page.unreadAfter === true || activityUnread(task.child, 0, visit);
    task.replied = hasText(visit?.lastSentId) && delivered.get(visit.lastSentId) === true;
    this.applyDelivery(task.key, delivered);
  }
  private applyDelivery(key: string, delivered: Readonly<ReadonlyMap<string, boolean>>): void {
    const visit = this.visits.get(key);
    if (!visit) {
      return;
    }
    if (
      hasText(visit.lastSentId) &&
      delivered.has(visit.lastSentId) &&
      visit.notice === PENDING_MESSAGE_NOTICE
    ) {
      visit.notice = undefined;
    }
    for (const sent of visit.outbox) {
      if (!delivered.has(sent.id) || visit.draft !== sent.draft) {
        continue;
      }
      visit.draft = "";
      visit.quote = undefined;
      if (this.selectedKey === key) {
        this.syncDraft();
      }
    }
    visit.outbox = visit.outbox.filter((sent) => !delivered.has(sent.id));
  }
  metadataUnavailable(key: string, reason: string): void {
    for (const task of [...this.tasks, ...this.dockTasks]) {
      if (task.key === key) {
        task.unavailable ??= reason;
      }
    }
  }
  private authorityTask(
    key: string,
    root: string,
    ownerSessionId: string | undefined,
  ): { selected?: AgentTask; rootView?: OwnedRunView } {
    let selected: AgentTask | undefined, rootView: OwnedRunView | undefined;
    for (const run of this.state.ownedRuns?.values() ?? []) {
      if (run.rootRunId !== root || run.ownerSessionId !== ownerSessionId) {
        continue;
      }
      const questions = listOwnedRunQuestions(run.ownerSessionId, run.runId);
      const view = ownedRunView(run, this.state, {
        pendingInput: questions.some((question) =>
          ["awaiting_input", "answer_pending"].includes(question.state),
        ),
        includeContinuations: false,
        readConfiguration: false,
      });
      if (view.runId === key.split(":")[0]) {
        rootView = view;
      }
      const candidate = this.fromView(view, questions, true).find((task) => task.key === key);
      if (candidate && (!selected || selected.run.startedAt <= candidate.run.startedAt)) {
        selected = candidate;
      }
    }
    return { selected, rootView };
  }
  private missingAuthority(
    key: string,
    current: AgentTask | undefined,
    rootView: OwnedRunView | undefined,
  ): AgentTask | undefined {
    if (current) {
      return authorityUnavailable(current, UNAVAILABLE_ASSIGNMENT);
    }
    return rootView && this.visits.has(key) ? this.unavailableTask(key, rootView) : undefined;
  }
  private replaceTask(task: AgentTask): void {
    const position = this.tasks.findIndex((candidate) => candidate.key === task.key);
    if (position < 0) {
      this.tasks.push(task);
    } else {
      this.tasks[position] = task;
    }
    this.dockTasks = this.dockTasks.map((candidate) =>
      candidate.key === task.key ? task : candidate,
    );
  }
  /** Browse SQLite is not authority: recheck this lineage before sending or stopping. */
  refreshSelected(key: string, ownerSessionId: string | undefined): void {
    const current = this.task(key),
      root =
        current?.run.rootRunId ?? this.state.ownedRuns?.get(key.split(":")[0] ?? "")?.rootRunId;
    if (!hasText(root)) {
      return;
    }
    this.taskKeys.clear();
    let selected: AgentTask | undefined;
    try {
      const authority = this.authorityTask(key, root, ownerSessionId);
      selected = authority.selected ?? this.missingAuthority(key, current, authority.rootView);
    } catch (error) {
      if (current) {
        selected = authorityUnavailable(current, `Run authority unavailable: ${errorText(error)}`);
      }
    }
    if (selected) {
      this.replaceTask(selected);
    }
  }
}
