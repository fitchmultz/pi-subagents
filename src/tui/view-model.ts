import { nonemptyText, hasText } from "./text-values.ts";
import { rawKeyHint, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, truncateToWidth, type Keybinding } from "@earendil-works/pi-tui";
import type { SupervisorQuestionView } from "../shared/types.ts";
import type { SubagentParamsLike } from "../runs/foreground/subagent-params.ts";
import { formatModelThinking } from "../shared/formatters.ts";
import type {
  OwnedRunView,
  SubagentExecutionResult,
  ReadonlyInput,
  HistoryPage,
  HistoryRunRow,
} from "../shared/types.ts";
import { readableText, type AgentHistory, type AgentHistoryItem } from "./agent-history.ts";

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
  readonly run: OwnedRunView;
  readonly child: HistoryRunRow["children"][number];
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

export const short = (text: string, width = 48) =>
  truncateToWidth(readableText(text).replace(/\s+/g, " ").trim(), width);

export const resultText = (result: SubagentExecutionResult) =>
  result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");

export function primaryKey(action: Keybinding): string {
  const key = getKeybindings().getKeys(action)[0];
  return (
    ({ enter: "Enter", escape: "Esc", up: "↑", down: "↓" } as Record<string, string>)[key ?? ""] ??
    readableText(rawKeyHint(key ?? "", "")).trim()
  );
}

export function agentTaskLabel(child: OwnedRunView["children"][number]): string {
  return readableText(
    nonemptyText(child.label) ||
      nonemptyText(child.task?.split("\n").find((line) => line.trim())) ||
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
  const live = task.child.activity;
  if (live?.status === "pending") {
    return "waiting to start";
  }
  return hasText(live?.currentTool)
    ? short(
        `${live.currentTool} ${nonemptyText(live.currentToolArgs) || nonemptyText(live.currentPath) || ""}`,
        42,
      )
    : hasText(live?.streamingText)
      ? short(live.streamingText, 42)
      : "working";
}

export function taskSummary(task: Readonly<AgentTask>): { status: string; badge: string } {
  let status: string;
  if (task.child.identityUnavailable === true) {
    status = "unavailable";
  } else if (task.question) {
    status = task.question.state === "answer_pending" ? "answer pending" : "needs answer";
  } else if (task.child.state === "blocked") {
    status = "needs action";
  } else if (task.child.state === "live") {
    status = task.child.activity?.status === "pending" ? "queued" : "working";
  } else {
    status = task.child.state === "completed" ? "done" : task.child.state;
  }
  return { status, badge: task.unread ? (task.replied ? " · replied" : " · new") : "" };
}

export const unavailableModel = {
  summary: "model unavailable",
  details: "Model unavailable. No provider/model was recorded for this assignment.",
};

export function agentModel(
  child: AgentTask["child"],
  native?: AgentHistory["configuration"],
): AgentTask["model"] {
  if (child.identityUnavailable === true) {
    return unavailableModel;
  }
  const live = child.state === "live",
    selected = child.modelSelection;
  // A continuation shares its file with the finished run; only the latter's frozen snapshot belongs to it.
  const recorded = live
    ? native
    : hasText(native?.model)
      ? { ...(child.savedConfiguration ?? child.launch), ...native }
      : (child.savedConfiguration ?? child.launch);
  const current =
    selected?.modelStartedAt !== undefined &&
    (recorded?.modelRecordedAt ?? 0) > selected.modelStartedAt;
  let source = "selected",
    value: { model?: string; thinking?: string } | undefined = selected;
  if (hasText(recorded?.model) && (current || (!live && selected?.modelStartedAt === undefined))) {
    value = recorded;
    source = live ? "session" : "saved";
  } else if (!hasText(value?.model)) {
    value =
      live && hasText(native?.model)
        ? native
        : hasText(child.launch?.model)
          ? child.launch
          : child.result;
    source = "saved";
  }
  if (!hasText(value?.model)) {
    return unavailableModel;
  }
  const formatted = readableText(formatModelThinking(value.model, value.thinking));
  const selectedText =
    hasText(selected?.model) &&
    readableText(formatModelThinking(selected.model, selected.thinking));
  const nativeText =
    hasText(native?.model) && readableText(formatModelThinking(native.model, native.thinking));
  const details = [`Model (${source}): ${formatted}`];
  if (hasText(selectedText) && selectedText !== formatted) {
    details.push(`Selected model: ${selectedText}`);
  }
  if (live && hasText(nativeText) && nativeText !== formatted) {
    details.push(`Last saved session model (may precede this attempt): ${nativeText}`);
  }
  return {
    summary: source === "session" ? formatted : `${source}: ${formatted}`,
    details: details.join("\n"),
  };
}

export function runningIndicator(theme: Theme): string {
  // Six seconds, sampled by the existing 500 ms refresh; typing cannot speed up the pulse.
  const phase = Math.floor(Date.now() / 500) % 12;
  const ansi = theme.getFgAnsi("success");
  const rgb = theme.getColorMode() === "truecolor" && /^\x1b\[38;2;(\d+);(\d+);(\d+)m$/.exec(ansi);
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
