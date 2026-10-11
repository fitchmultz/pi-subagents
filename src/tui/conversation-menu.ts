import { primaryKey, activity, type AgentTask, type AgentVisit } from "./view-model.ts";
import type { ReadonlyInput } from "../shared/types.ts";
import { matchesKey } from "@earendil-works/pi-tui";
interface Choice {
  readonly value: string;
  readonly label: string;
}
function taskCanControl(task: Readonly<AgentTask> | undefined): boolean {
  return task?.child.identityUnavailable !== true && task?.child.activity?.status !== "pending";
}
export function conversationChoices(
  task: Readonly<AgentTask> | undefined,
  options: {
    readonly expanded: boolean;
    readonly pinned: boolean;
    readonly quote: ReadonlyInput<AgentVisit["quote"]>;
  },
): Choice[] {
  const choices = [
    { value: "reply", label: "Reply to selected message / tool / change" },
    { value: "details", label: "Full details / diff" },
    { value: "expand", label: options.expanded ? "Collapse tool output" : "Expand tool output" },
    { value: "assignment", label: "Full original assignment" },
    { value: "changes", label: "Inspect working tree changes" },
    { value: "latest", label: "Jump to latest activity" },
    { value: "pin", label: options.pinned ? "Unpin this agent" : "Keep this agent visible" },
  ];
  if (options.quote) {
    choices.push({ value: "unquote", label: "Remove quoted context" });
  }
  if (taskCanControl(task)) {
    choices.push(
      task?.child.state === "live" || task?.question
        ? { value: "stop", label: "Stop this agent only" }
        : { value: "continue", label: "Continue with this message" },
    );
  }
  choices.push(
    { value: "picker", label: "Your other agents" },
    { value: "peers", label: "Other connected sessions" },
    { value: "earlier", label: "Earlier history" },
    { value: "later", label: "Later history" },
    { value: "retry", label: "Refresh / retry selected history" },
  );
  return choices;
}
const SHORTCUTS = [
  ["escape", "back"],
  ["f2", "actions"],
  ["f5", "retry"],
  ["alt+r", "reply"],
  ["alt+g", "changes"],
  ["alt+l", "latest"],
  ["alt+p", "pin"],
  ["alt+q", "unquote"],
  ["alt+s", "stop"],
  ["alt+c", "continue"],
] as const;
export function conversationShortcut(data: string): string | undefined {
  return SHORTCUTS.find(([key]) => matchesKey(data, key))?.[1];
}
export function primaryConversationAction(
  task: Readonly<AgentTask> | undefined,
  editor: boolean,
): string | undefined {
  if (!taskCanControl(task)) {
    return;
  }
  if (task?.child.state !== "live" && !task?.question) {
    return "continue";
  }
  return editor ? "send" : "details";
}
function composeLabel(task: Readonly<AgentTask> | undefined, busy: boolean): string {
  return `${task?.question ? "Answer" : "Message"} ${task?.label ?? "agent"}${busy ? " · sending" : ""}`;
}
export function conversationHeading(
  task: Readonly<AgentTask> | undefined,
  options: {
    readonly entrance: string;
    readonly detail: boolean;
    readonly following: boolean;
    readonly busy: boolean;
  },
): {
  readonly title: string;
  readonly status: string;
  readonly unread: boolean;
  readonly composeLabel: string;
} {
  return {
    title: `${options.entrance} › ${task?.label ?? "unavailable"}${options.detail ? " › details" : ""}`,
    status: task
      ? `${task.child.agent} · ${activity(task)} · ${task.model.summary}`
      : "Unavailable",
    unread: task?.unread === true && !options.following,
    composeLabel: composeLabel(task, options.busy),
  };
}
export function primaryConversationHint(
  action: string | undefined,
  width: number,
  loading: boolean,
  task: Readonly<AgentTask> | undefined,
): string {
  if (loading) {
    return "Loading quoted context…";
  }
  if (task?.child.identityUnavailable === true) {
    return "Assignment unavailable · draft kept";
  }
  if (task?.child.activity?.status === "pending") {
    return "Waiting to start · draft kept";
  }
  if (action === "continue") {
    return width < 60 ? "Alt+C Continue" : "Alt+C Continue with message";
  }
  return action === "send" ? `${primaryKey("tui.input.submit")} Send`.trim() : "Enter Details";
}
