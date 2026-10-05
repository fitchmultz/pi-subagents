import { nonemptyText, hasText } from "./text-values.ts";
import { rawKeyHint, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, truncateToWidth, type Keybinding } from "@earendil-works/pi-tui";
import type {
  SupervisorQuestionView,
  OwnedRunView,
  SubagentExecutionResult,
  ReadonlyInput,
  HistoryPage,
  HistoryRunRow,
} from "../shared/types.ts";
import type { SubagentParamsLike } from "../runs/foreground/subagent-params.ts";
import { readableText, type AgentHistoryItem } from "./agent-history.ts";

export const UNAVAILABLE_ASSIGNMENT =
  "Assignment identity unavailable. Your draft is kept; no message or Stop was sent. Inspect the run and choose a verified assignment before sending it.";

export const PENDING_MESSAGE_NOTICE =
  "This message is already waiting for the child. You can keep working or write a different message.";

export const CONTINUE_HINT = "Continue with this message (Alt+C)";

export const CONTINUE_NOTICES = {
  finished: "This agent has finished. Your draft is kept. Choose ",
  blocked: "This agent needs your action; acceptance is incomplete. Your draft is kept. Choose ",
};

export type ExecuteControl = (
  params: Readonly<
    Pick<SubagentParamsLike, "action" | "id" | "index" | "questionId" | "message" | "messageOrigin">
  >,
  ctx: ExtensionContext,
) => Promise<SubagentExecutionResult>;

export type Quote = { readonly title: string; readonly text: string };

export type Anchor = { readonly id: string; readonly line: number };

export interface OutgoingMessage {
  id: string;
  runId: string;
  index: number;
  text: string;
  draft: string;
  quote?: Quote;
  at: number;
  status: "sending" | "waiting" | "unconfirmed";
  reason?: string;
}

export interface AgentVisit {
  draft: string;
  quote?: Quote;
  anchor?: Anchor;
  /** null records a visit before the first saved history entry. */
  readThrough?: string | null;
  seenActivityAt?: number;
  outbox: OutgoingMessage[];
  lastSentId?: string;
  notice?: string | { continue: keyof typeof CONTINUE_NOTICES };
}

export interface AgentTask {
  readonly key: string;
  readonly label: string;
  readonly run: ReadonlyInput<OwnedRunView>;
  readonly child: ReadonlyInput<HistoryRunRow["children"][number]>;
  model: { readonly summary: string; readonly details: string };
  question?: SupervisorQuestionView;
  history: readonly AgentHistoryItem[];
  historyIds: readonly string[];
  finalId?: string;
  unavailable?: string;
  unread: boolean;
  replied: boolean;
  page?: HistoryPage;
  historyLoading?: boolean;
  metadataAt?: number;
}

export const short = (text: string, width = 48): string =>
  truncateToWidth(readableText(text).replace(/\s+/g, " ").trim(), width);

export const resultText = (result: SubagentExecutionResult): string =>
  result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");

export function primaryKey(action: Keybinding): string {
  const key = getKeybindings().getKeys(action).at(0);
  const labels: Readonly<Record<string, string | undefined>> = {
    enter: "Enter",
    escape: "Esc",
    up: "↑",
    down: "↓",
  };
  return labels[key ?? ""] ?? readableText(rawKeyHint(key ?? "", "")).trim();
}

export function agentTaskLabel(child: OwnedRunView["children"][number]): string {
  return readableText(
    nonemptyText(child.label) ??
      nonemptyText(child.task?.split("\n").find((line) => line.trim().length > 0)) ??
      `${child.agent} · assignment unavailable`,
  )
    .replace(/\s+/g, " ")
    .trim();
}

export function activity(task: Readonly<AgentTask>): string {
  if (task.child.identityUnavailable === true) {
    return "assignment unavailable";
  }
  if (task.question) {
    return task.question.state === "answer_pending" ? "answer saved · waiting" : "needs an answer";
  }
  if (task.child.state === "blocked") {
    return "needs your action · acceptance incomplete";
  }
  if (task.child.state !== "live") {
    return task.child.state === "completed" ? "done" : task.child.state;
  }
  return liveActivity(task.child.activity);
}
function liveActivity(live: AgentTask["child"]["activity"]): string {
  if (live?.status === "pending") {
    return "waiting to start";
  }
  if (hasText(live?.currentTool)) {
    return short(
      `${live.currentTool} ${nonemptyText(live.currentToolArgs) ?? nonemptyText(live.currentPath) ?? ""}`,
      42,
    );
  }
  return hasText(live?.streamingText) ? short(live.streamingText, 42) : "working";
}

function taskStatus(task: Readonly<AgentTask>): string {
  if (task.child.identityUnavailable === true) {
    return "unavailable";
  }
  if (task.question) {
    return task.question.state === "answer_pending" ? "answer pending" : "needs answer";
  }
  if (task.child.state === "blocked") {
    return "needs action";
  }
  if (task.child.state === "live") {
    return task.child.activity?.status === "pending" ? "queued" : "working";
  }
  return task.child.state === "completed" ? "done" : task.child.state;
}
export function taskSummary(task: Readonly<AgentTask>): { status: string; badge: string } {
  let badge = "";
  if (task.unread) {
    badge = task.replied ? " · replied" : " · new";
  }
  return { status: taskStatus(task), badge };
}

export { agentModel, unavailableModel } from "./agent-model.ts";

export function runningIndicator(theme: Theme): string {
  // Six seconds, sampled by the existing 500 ms refresh; typing cannot speed up the pulse.
  const phase = Math.floor(Date.now() / 500) % 12;
  const ansi = theme.getFgAnsi("success");
  // Parse the native SGR truecolor foreground sequence for the display-only pulse.
  // oxlint-disable-next-line no-control-regex
  const colorPattern = /^\x1b\[38;2;(\d+);(\d+);(\d+)m$/;
  const rgb = theme.getColorMode() === "truecolor" ? colorPattern.exec(ansi) : null;
  if (!rgb) {
    return theme.fg("success", phase < 6 ? theme.bold("●") : "●");
  }
  const brightness = 0.9 + 0.1 * Math.cos((phase * Math.PI) / 6);
  return theme.fg("success", "●").replace(
    ansi,
    `\x1b[38;2;${rgb
      .slice(1)
      .map((value) => Math.round(Number(value) * brightness))
      .join(";")}m`,
  );
}
