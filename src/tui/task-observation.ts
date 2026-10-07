import type {
  HistoryRunRow,
  SupervisorQuestionView,
  HistoryConfiguration,
  ReadonlyInput,
} from "../shared/types.ts";
import { agentTaskLabel, type AgentTask, type AgentVisit } from "./view-model.ts";
type Child = ReadonlyInput<HistoryRunRow["children"][number]>;
type Task = Readonly<AgentTask>;
export function selectedChild(child: Child, prior: Task, updatedAt: number): Child {
  return {
    ...child,
    task: prior.child.task,
    launch: prior.child.launch,
    result: child.result && prior.run.updatedAt === updatedAt ? prior.child.result : child.result,
    activity: { ...prior.child.activity, ...child.activity },
  };
}
export function observedTask(
  prior: Task | undefined,
  state: Child["state"],
  updatedAt: number,
): boolean {
  return prior !== undefined && prior.child.state === state && prior.metadataAt === updatedAt;
}
export function observedLabel(child: Child, prior: Task | undefined, sameAttempt: boolean): string {
  if (child.identityUnavailable === true) {
    return "Saved assignment unavailable";
  }
  return sameAttempt ? agentTaskLabel(child) : (prior?.label ?? agentTaskLabel(child));
}
export function cachedHistory(
  prior: Task | undefined,
): Pick<AgentTask, "history" | "historyIds" | "page" | "historyLoading" | "finalId" | "replied"> {
  if (!prior) {
    return { history: [], historyIds: [], historyLoading: false, replied: false };
  }
  return {
    history: prior.history,
    historyIds: prior.historyIds,
    page: prior.page,
    historyLoading: prior.historyLoading,
    finalId: prior.finalId,
    replied: prior.replied,
  };
}
export function observedConfiguration(
  child: Child,
  prior: Task | undefined,
  canonical: boolean,
): HistoryConfiguration | undefined {
  if (child.nativeConfiguration) {
    return child.nativeConfiguration;
  }
  if (canonical && prior && child.sessionFile === prior.child.sessionFile) {
    return prior.page?.configuration;
  }
  return;
}
export function activityUnread(
  child: Child,
  updatedAt: number,
  visit: ReadonlyInput<AgentVisit> | undefined,
): boolean {
  return (
    visit !== undefined &&
    (child.activity?.lastActivityAt ?? updatedAt) > (visit.seenActivityAt ?? 0)
  );
}
export function observationFlags(
  prior: Task | undefined,
  observed: boolean,
  unread: boolean,
): Pick<AgentTask, "metadataAt" | "unread"> {
  return {
    metadataAt: observed ? prior?.metadataAt : undefined,
    unread: observed ? (prior?.unread ?? false) : unread,
  };
}
export function observedQuestion(
  child: Child,
  questions: readonly SupervisorQuestionView[],
): SupervisorQuestionView | undefined {
  if (child.identityUnavailable === true) {
    return;
  }
  return questions.findLast(
    (question) =>
      question.index === child.index &&
      ["awaiting_input", "answer_pending"].includes(question.state),
  );
}
