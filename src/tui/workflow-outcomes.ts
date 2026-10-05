import type { Details, ReadonlyInput, WorkflowNodeStatus } from "../shared/types.ts";
import { formatAgentRunningLabel } from "../shared/status-format.ts";

type OutcomeInput = Pick<ReadonlyInput<Details>, "results" | "progress">;
type Result = OutcomeInput["results"][number];

function pausedResult(result: Result | undefined): boolean {
  return result?.interrupted === true || result?.detached === true;
}
function blockedResult(result: Result | undefined): boolean {
  return result?.acceptance?.status === "blocked";
}
export function isDoneResult(result: Result): boolean {
  if (pausedResult(result) || result.timedOut === true || blockedResult(result)) {
    return false;
  }
  const status = result.progress?.status;
  if (status === "completed") {
    return true;
  }
  return status !== "running" && status !== "pending" && result.exitCode === 0;
}
function resultStatus(result: Result): WorkflowNodeStatus {
  if (result.progress) {
    return result.progress.status;
  }
  if (result.timedOut === true) {
    return "timed-out";
  }
  if (pausedResult(result)) {
    return "detached";
  }
  if (result.exitCode !== 0) {
    return "failed";
  }
  return blockedResult(result) ? "blocked" : "completed";
}
function resultIndex(details: OutcomeInput, result: Result, position: number): number {
  const progress =
    details.progress?.find((entry) => entry.index === position) ??
    details.progress?.find((entry) => entry.agent === result.agent && entry.status === "running");
  return result.progress?.index ?? progress?.index ?? position;
}
export function parallelStatuses(details: OutcomeInput, total: number): WorkflowNodeStatus[] {
  const statuses = Array.from({ length: total }, (): WorkflowNodeStatus => "pending");
  for (const progress of details.progress ?? []) {
    if (progress.index >= 0 && progress.index < total) {
      statuses[progress.index] = progress.status;
    }
  }
  for (const [position, result] of details.results.entries()) {
    const index = resultIndex(details, result, position);
    if (index >= 0 && index < total) {
      statuses[index] = resultStatus(result);
    }
  }
  return statuses;
}
function stoppedGroupStatus(
  status: WorkflowNodeStatus | undefined,
  result: Result | undefined,
): WorkflowNodeStatus | undefined {
  if (status === "failed" || status === "timed-out" || result?.timedOut === true) {
    return "failed";
  }
  if (status === "paused" || status === "detached" || pausedResult(result)) {
    return "paused";
  }
  return;
}
function completedGroupStatus(
  status: WorkflowNodeStatus | undefined,
  result: Result | undefined,
): WorkflowNodeStatus {
  if (result !== undefined && result.exitCode !== 0) {
    return "failed";
  }
  if (status === "blocked" || blockedResult(result)) {
    return "blocked";
  }
  return status === "completed" || (result !== undefined && isDoneResult(result))
    ? "completed"
    : "pending";
}
export function groupStatus(details: OutcomeInput, index: number): WorkflowNodeStatus {
  const progress = details.progress?.find((entry) => entry.index === index);
  const result = details.results.find(
    (entry, position) => (entry.progress?.index ?? position) === index,
  );
  const status = progress?.status ?? result?.progress?.status;
  if (status === "running") {
    return "running";
  }
  return stoppedGroupStatus(status, result) ?? completedGroupStatus(status, result);
}
export function outcomeLabel(
  statuses: readonly WorkflowNodeStatus[],
  total: number,
  running: boolean,
  blockedFirst = false,
): string {
  const count = (states: readonly WorkflowNodeStatus[]) =>
    statuses.filter((status) => states.includes(status)).length;
  const parts = [`${count(["completed"])}/${total} succeeded`];
  const blocked = count(["blocked"]),
    failed = count(["failed", "timed-out"]),
    paused = count(["paused", "detached"]);
  if (blockedFirst && blocked > 0) {
    parts.push(`${blocked} need human action`);
  }
  if (running) {
    parts.unshift(formatAgentRunningLabel(count(["running"])));
  }
  if (failed > 0) {
    parts.push(`${failed} failed`);
  }
  if (paused > 0) {
    parts.push(`${paused} paused`);
  }
  if (!blockedFirst && blocked > 0) {
    parts.push(`${blocked} need human action`);
  }
  return parts.join(" · ");
}
function completedAt(details: OutcomeInput, index: number): boolean {
  const progress = details.progress?.find((entry) => entry.index === index);
  const result =
    details.results.find((entry) => entry.progress?.index === index) ?? details.results.at(index);
  if (["running", "pending", "failed"].includes(progress?.status ?? "")) {
    return false;
  }
  return result !== undefined && isDoneResult(result);
}
export function spanCompleted(
  details: OutcomeInput,
  span: { readonly status?: WorkflowNodeStatus; readonly count: number; readonly start: number },
): boolean {
  if (span.status !== undefined && span.status !== "completed") {
    return false;
  }
  if (span.count === 0) {
    return span.status === "completed";
  }
  for (let index = span.start; index < span.start + span.count; index++) {
    if (!completedAt(details, index)) {
      return false;
    }
  }
  return true;
}
