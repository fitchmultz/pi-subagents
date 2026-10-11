import { hasText } from "./text-values.ts";
import { acceptanceHumanAction } from "../runs/shared/acceptance.ts";
import { formatAgentProcessExit } from "../shared/status-format.ts";
import type { HistoryPage, ReadonlyInput } from "../shared/types.ts";
import type { AgentHistoryItem } from "./agent-history.ts";
import type { AgentTask, OutgoingMessage } from "./view-model.ts";
function notice(id: string, title: string, text = "", timestamp = 0): AgentHistoryItem {
  return { id, kind: "notice", title, text, timestamp };
}
export function historyStatus(page: HistoryPage | undefined, loading: boolean): string | undefined {
  if (loading && !page) {
    return "Loading conversation…";
  }
  if (page?.freshness.state === "catching-up") {
    return "Catching up · partial history";
  }
  return page?.freshness.state === "degraded"
    ? "Some saved history unavailable · F5 retry"
    : undefined;
}
export function pageNotices(
  task: Readonly<AgentTask>,
  status: string | undefined,
  latest: boolean,
): AgentHistoryItem[] {
  const items: AgentHistoryItem[] = [],
    page = task.page;
  if (hasText(status)) {
    items.push(notice("history-loading", status));
  }
  if (page && page.count > page.entries.length) {
    items.push(
      notice(
        "history-page",
        `History · ${page.entries.length} of ${page.count} native records${latest ? " · latest" : ""}`,
        "F2 Actions → Earlier history / Later history / Latest. Full details validates the selected native record.",
      ),
    );
  }
  if (task.child.identityUnavailable !== true && task.child.state !== "live") {
    items.push(
      notice(
        "process-exit",
        `Agent: ${task.child.state}`,
        formatAgentProcessExit(task.child.result?.agentProcessExit),
        task.run.updatedAt,
      ),
    );
  }
  return items;
}
function activityItem(task: Readonly<AgentTask>): AgentHistoryItem | undefined {
  const activity = task.child.activity;
  if (
    task.child.identityUnavailable === true ||
    task.child.state !== "live" ||
    !hasText(activity?.streamingText)
  ) {
    return;
  }
  return {
    id: `live:${task.run.runId}`,
    kind: "assistant",
    title: "Agent · writing",
    text: activity.streamingText,
    timestamp: activity.lastActivityAt ?? 0,
  };
}
export function taskNotices(task: Readonly<AgentTask>): AgentHistoryItem[] {
  const items: AgentHistoryItem[] = [];
  if (task.child.identityUnavailable !== true) {
    const action = task.child.humanAction ?? acceptanceHumanAction(task.child.result?.acceptance);
    if (hasText(action)) {
      items.push(
        notice(
          "human-action",
          "Needs your action — acceptance incomplete",
          action,
          task.run.updatedAt,
        ),
      );
    }
    if (hasText(task.unavailable)) {
      items.push(notice("unavailable", "Conversation unavailable", task.unavailable));
    }
  }
  if (task.question) {
    items.push(
      notice(
        `question:${task.question.questionId}`,
        "Waiting for your answer",
        task.question.message,
        task.question.createdAt,
      ),
    );
  }
  const activity = activityItem(task);
  if (activity) {
    items.push(activity);
  }
  return items;
}
const SENT_TITLES = {
  sending: "You · sending",
  waiting: "You · waiting for the child / tool boundary",
  unconfirmed: "You · delivery unconfirmed",
} as const;
export function outgoingHistory(sent: ReadonlyInput<OutgoingMessage>): AgentHistoryItem {
  return {
    id: `outgoing:${sent.id}`,
    kind: "user",
    title: SENT_TITLES[sent.status],
    text: `${sent.text}${sent.quote ? `\n\nRegarding ${sent.quote.title}:\n${sent.quote.text}` : ""}${hasText(sent.reason) ? `\n\n${sent.reason}` : ""}`,
    timestamp: sent.at,
  };
}
