import { loadConfig } from "../extension/config.ts";
import type { ReadonlyDeep } from "type-fest";
import type {
  AgentProcessExit,
  ActivityState,
  AsyncJobStep,
  ManagementAction,
  ManagementControl,
  ManagementRunState,
  SubagentLiveIntercomHealth,
} from "./types.ts";

export function formatAgentProcessExit(exit: Readonly<AgentProcessExit> | undefined): string {
  return exit
    ? `Agent process exited (${exit.signal !== null ? `signal ${exit.signal}` : `code ${exit.code ?? "unrecorded"}`}). Command and descendant exit are not implied.`
    : "Agent process exit not recorded. Command exit is unconfirmed.";
}

export function formatRunAction(
  action: ManagementAction | "questions" | "answer",
  id: string,
  fields: Readonly<Record<string, string | number | boolean>> = {},
  childSafe = false,
): string {
  const legacyChild = childSafe && loadConfig().compactChildTools === false;
  const name = legacyChild ? action : parentActionName(action);
  const args = Object.entries({ action: name, id, ...fields })
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join(", ");
  const call = `${legacyChild || action === "extend" ? "subagent" : "agent_runs"}({ ${args} })`;
  return action === "extend" && !legacyChild ? `load_subagent({}), then ${call}` : call;
}

function parentActionName(action: ManagementAction | "questions" | "answer"): string {
  switch (action) {
    case "status":
      return "inspect";
    case "resume":
      return "continue";
    case "interrupt":
      return "stop";
    case "answer":
    case "extend":
    case "nudge":
    case "questions":
    case "review":
      return action;
  }
}

type ManagementInput = ReadonlyDeep<{
  state: ManagementRunState;
  runId: string;
  index?: number;
  intercomTarget?: string;
  canExtend?: boolean;
  canResume?: boolean;
  canNudge?: boolean;
  canInterrupt?: boolean;
  canReview?: boolean;
  unavailableActions?: Partial<Record<ManagementAction, string>>;
  revivedFromRunId?: string;
}>;
function managementCapabilities(input: ManagementInput): ManagementAction[] {
  const capabilities: ManagementAction[] = ["status"];
  if (input.state === "live") {
    if (input.canNudge === true) {
      capabilities.push("nudge");
    }
    if (input.canResume === true) {
      capabilities.push("resume");
    }
    if (input.canInterrupt === true) {
      capabilities.push("interrupt");
    }
  } else if (input.canResume === true) {
    capabilities.push("resume");
  }
  if (input.state === "live" && input.canExtend === true) {
    capabilities.push("extend");
  }
  if (input.canReview === true) {
    capabilities.push("review");
  }
  return capabilities;
}
function managementNextAction(
  action: ManagementAction,
  input: ManagementInput,
): ManagementControl["nextActions"][number] {
  return {
    action,
    runId: input.runId,
    ...(input.index !== undefined && (action === "nudge" || action === "resume")
      ? { index: input.index }
      : {}),
    ...(input.intercomTarget !== undefined &&
    input.intercomTarget !== "" &&
    (action === "nudge" || action === "resume")
      ? { intercomTarget: input.intercomTarget }
      : {}),
  };
}
export function buildManagementControl(input: ManagementInput): ManagementControl {
  const capabilities = managementCapabilities(input);
  return {
    state: input.state,
    runId: input.runId,
    capabilities,
    nextActions: capabilities.map((action) => managementNextAction(action, input)),
    ...(input.unavailableActions ? { unavailableActions: input.unavailableActions } : {}),
    ...(input.revivedFromRunId !== undefined && input.revivedFromRunId !== ""
      ? { revivedFromRunId: input.revivedFromRunId, pendingReplyContextValid: false }
      : {}),
  };
}

type StepStatusLike = Readonly<Pick<AsyncJobStep, "status">>;

function formatActivityAge(ms: number): string {
  if (ms < 1000) {
    return "now";
  }
  if (ms < 60000) {
    return `${Math.floor(ms / 1000)}s`;
  }
  return `${Math.floor(ms / 60000)}m`;
}

export function formatActivityLabel(
  lastActivityAt: number | undefined,
  activityState?: ActivityState,
  now = Date.now(),
): string | undefined {
  if (lastActivityAt === undefined) {
    if (activityState === "needs_attention") {
      return "needs attention";
    }
    return undefined;
  }
  const age = formatActivityAge(Math.max(0, now - lastActivityAt));
  if (activityState === "needs_attention") {
    return `no activity for ${age}`;
  }
  return age === "now" ? "active now" : `active ${age} ago`;
}

function isCompletedStepStatus(status: AsyncJobStep["status"]): boolean {
  return status === "complete" || status === "completed";
}

export function aggregateStepStatus(steps: readonly StepStatusLike[]): AsyncJobStep["status"] {
  if (steps.some((step) => step.status === "running")) {
    return "running";
  }
  if (steps.some((step) => step.status === "failed")) {
    return "failed";
  }
  if (steps.some((step) => step.status === "blocked")) {
    return "blocked";
  }
  if (steps.some((step) => step.status === "paused")) {
    return "paused";
  }
  if (steps.length > 0 && steps.every((step) => isCompletedStepStatus(step.status))) {
    return "complete";
  }
  return "pending";
}

export function formatAgentRunningLabel(count: number): string {
  return count === 1 ? "1 agent running" : `${count} agents running`;
}

function intercomHealth(health: ReadonlyDeep<SubagentLiveIntercomHealth> | undefined): string {
  if (!health) {
    return "unknown";
  }
  if (health.status !== "registered") {
    return health.status.replace(/_/g, " ");
  }
  return `registered${health.sessionStatus !== undefined && health.sessionStatus !== "" ? `, ${health.sessionStatus}` : ""}${health.acceptsAsks !== undefined ? `, accepts_asks:${health.acceptsAsks}` : ""}${health.pendingAsks !== undefined ? `, pending_asks:${health.pendingAsks}` : ""}`;
}

export function formatLiveIntercomActionLines(
  input: ReadonlyDeep<{
    runId: string;
    target: string;
    index?: number;
    health?: SubagentLiveIntercomHealth;
    indent?: string;
    childSafe?: boolean;
  }>,
): string[] {
  const fields = {
    ...(input.index !== undefined ? { index: input.index } : {}),
    message: "What are you blocked on?",
  };
  const healthText = intercomHealth(input.health);
  const indent = input.indent ?? "";
  return [
    `${indent}Intercom: ${healthText} (${input.target})`,
    `${indent}Nudge (preferred live coordination): ${formatRunAction("nudge", input.runId, fields, input.childSafe)}`,
    `${indent}Ask (blocking wait only; parent must remain alive): intercom({ action: "ask", to: "${input.target}", delivery: "steer", message: "What are you blocked on?" })`,
  ];
}

export function formatParallelOutcome(
  steps: readonly StepStatusLike[],
  total: number,
  options: { readonly showRunning?: boolean } = {},
): string {
  const running = steps.filter((step) => step.status === "running").length;
  const succeeded = steps.filter((step) => isCompletedStepStatus(step.status)).length;
  const failed = steps.filter((step) => step.status === "failed").length;
  const paused = steps.filter((step) => step.status === "paused").length;
  const blocked = steps.filter((step) => step.status === "blocked").length;
  const parts = [`${succeeded}/${total} succeeded`];
  if (options.showRunning !== false && running > 0) {
    parts.unshift(formatAgentRunningLabel(running));
  }
  if (failed > 0) {
    parts.push(`${failed} failed`);
  }
  if (paused > 0) {
    parts.push(`${paused} paused`);
  }
  if (blocked > 0) {
    parts.push(`${blocked} need human action`);
  }
  return parts.join(" · ");
}
