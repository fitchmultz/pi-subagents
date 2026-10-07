import type { ReadonlyInput } from "../shared/types/inputs.ts";
import { copyDetails, copyResult } from "../extension/result-snapshot.ts";
import { compactNestedResultChildren, formatNestedResultLines } from "./nested-result-tree.ts";
export {
  compactNestedResultChildren,
  attachNestedChildrenToResultChildren,
} from "./nested-result-tree.ts";
export {
  deliverSubagentResultIntercomEvent,
  deliverSubagentIntercomMessageEvent,
} from "./result-delivery.ts";
import * as fs from "node:fs";
import { formatRunAction } from "../shared/status-format.ts";
import { SUBAGENT_CHILD_ENV, SUBAGENT_FANOUT_CHILD_ENV } from "../runs/shared/pi-args.ts";
import type {
  Details,
  SingleResult,
  SubagentResultIntercomChild,
  SubagentResultIntercomPayload,
  SubagentResultStatus,
  SubagentRunMode,
} from "../shared/types.ts";

function hasText(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

interface ResultStatusInput {
  readonly exitCode?: number;
  readonly success?: boolean;
  readonly state?: string;
  readonly interrupted?: boolean;
  readonly detached?: boolean;
  readonly timedOut?: boolean;
  readonly acceptance?: SingleResult["acceptance"];
}

function completedStatus(input: ResultStatusInput): SubagentResultStatus {
  if (input.success !== undefined) {
    return input.success ? "completed" : "failed";
  }
  if (input.state === "complete") {
    return "completed";
  }
  if (input.state === "failed") {
    return "failed";
  }
  return input.exitCode === 0 ? "completed" : "failed";
}

function isBlockedResult(input: ResultStatusInput): boolean {
  return (
    (input.exitCode === undefined || input.exitCode === 0) &&
    (input.acceptance?.status === "blocked" || input.state === "blocked")
  );
}

export function resolveSubagentResultStatus(input: ResultStatusInput): SubagentResultStatus {
  if (input.detached === true) {
    return "detached";
  }
  if (input.timedOut === true || input.state === "timed-out") {
    return "timed-out";
  }
  if (input.interrupted === true || input.state === "paused") {
    return "paused";
  }
  if (isBlockedResult(input)) {
    return "blocked";
  }
  return completedStatus(input);
}

function countStatuses(
  children: readonly SubagentResultIntercomChild[],
): Record<SubagentResultStatus, number> {
  const counts: Record<SubagentResultStatus, number> = {
    completed: 0,
    failed: 0,
    blocked: 0,
    paused: 0,
    detached: 0,
    "timed-out": 0,
  };
  for (const child of children) {
    counts[child.status] += 1;
  }
  return counts;
}

function formatStatusCounts(counts: Readonly<Record<SubagentResultStatus, number>>): string {
  const parts = [
    counts.completed > 0 ? `${counts.completed} completed` : undefined,
    counts.failed > 0 ? `${counts.failed} failed` : undefined,
    counts.blocked > 0 ? `${counts.blocked} need human action` : undefined,
    counts.paused > 0 ? `${counts.paused} paused` : undefined,
    counts.detached > 0 ? `${counts.detached} detached` : undefined,
    counts["timed-out"] > 0 ? `${counts["timed-out"]} timed out` : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join(", ") : "0 results";
}

function resolveGroupedStatus(
  children: readonly SubagentResultIntercomChild[],
  workflowStatus?: SubagentResultStatus,
): SubagentResultStatus {
  const counts = countStatuses(children);
  if (workflowStatus !== undefined) {
    counts[workflowStatus] += 1;
  }
  if (counts.failed > 0) {
    return "failed";
  }
  if (counts["timed-out"] > 0) {
    return "timed-out";
  }
  if (counts.blocked > 0) {
    return "blocked";
  }
  if (counts.paused > 0) {
    return "paused";
  }
  if (counts.completed > 0) {
    return "completed";
  }
  if (counts.detached > 0) {
    return "detached";
  }
  return "failed";
}

interface GroupedResultIntercomMessageInput {
  readonly completionId?: string;
  readonly to: string;
  readonly runId: string;
  readonly mode: SubagentRunMode;
  readonly source: "foreground" | "async";
  readonly children: readonly SubagentResultIntercomChild[];
  readonly status?: SubagentResultStatus;
  readonly error?: string;
  readonly resultPath?: string;
  readonly asyncId?: string;
  readonly asyncDir?: string;
  readonly chainSteps?: number;
}

function asyncResumeGuidance(input: GroupedResultIntercomMessageInput): string | undefined {
  if (input.source !== "async" || input.asyncId === undefined || input.asyncId.length === 0) {
    return undefined;
  }
  const childSafe =
    process.env[SUBAGENT_CHILD_ENV] === "1" && process.env[SUBAGENT_FANOUT_CHILD_ENV] === "1";
  const resumable = input.children.filter(
    (child) => typeof child.sessionPath === "string" && fs.existsSync(child.sessionPath),
  );
  if (input.children.length === 1 && resumable.length === 1) {
    return `Continue: ${formatRunAction("resume", input.asyncId, { message: "..." }, childSafe)}`;
  }
  const first = resumable.at(0);
  if (first) {
    const firstIndex = first.index ?? input.children.indexOf(first);
    return `Continue child: ${formatRunAction("resume", input.asyncId, { index: firstIndex, message: "..." }, childSafe)}`;
  }
  return "Resume: unavailable; no child session file was persisted.";
}

function formatChildOutput(
  child: SubagentResultIntercomChild,
  source: "foreground" | "async",
): string[] {
  const lines: string[] = [];
  if (hasText(child.intercomTarget)) {
    lines.push(
      `${source === "async" ? "Previous intercom target" : "Run intercom target"}: ${child.intercomTarget}`,
    );
  }
  if (hasText(child.artifactPath)) {
    lines.push(`Output artifact: ${child.artifactPath}`);
  }
  if (hasText(child.metadataPath)) {
    lines.push(
      `Result metadata (acceptance details when configured): ${child.metadataPath}${fs.existsSync(child.metadataPath) ? "" : " (missing)"}`,
    );
  }
  if (hasText(child.sessionPath)) {
    lines.push(`Session: ${child.sessionPath}`);
  }
  lines.push(...formatNestedResultLines(child.children), "Summary:", child.summary);
  return lines;
}

function formatRunLocations(input: GroupedResultIntercomMessageInput): string[] {
  const lines: string[] = [];
  if (input.mode === "chain" && input.chainSteps !== undefined) {
    lines.push(`Chain steps: ${input.chainSteps}`);
  }
  for (const [field, label] of [
    ["resultPath", "Saved result (acceptance details when configured)"],
    ["asyncId", "Async id"],
    ["asyncDir", "Async dir"],
  ] as const) {
    const value = input[field];
    if (hasText(value)) {
      lines.push(`${label}: ${value}`);
    }
  }
  const guidance = asyncResumeGuidance(input);
  if (hasText(guidance)) {
    lines.push(guidance);
  }
  if (input.children.some((child) => hasText(child.intercomTarget))) {
    lines.push(
      "",
      input.source === "async"
        ? "Previous intercom targets below identify child sessions used while they were running. Inspect artifacts or session logs if resume is unavailable."
        : "Intercom targets below identify child sessions used while they were running; completed child sessions may no longer be reachable. Inspect artifacts or session logs for follow-up.",
    );
  }
  return lines;
}

function formatSubagentResultIntercomMessage(
  input: GroupedResultIntercomMessageInput & { readonly status: SubagentResultStatus },
): string {
  const counts = countStatuses(input.children);
  const lines: string[] = [
    "subagent results",
    "",
    `Run: ${input.runId}`,
    `Mode: ${input.mode}`,
    `Status: ${input.status}`,
    `Children: ${formatStatusCounts(counts)}`,
    ...(hasText(input.error)
      ? [`Workflow ${input.status === "paused" ? "paused" : "error"}: ${input.error}`]
      : []),
  ];
  if (input.source === "foreground" && input.status === "completed") {
    lines.push(
      "This completes the matching subagent call. Continue the parent task without relaunching the same call.",
    );
  }
  lines.push(...formatRunLocations(input));

  for (const [index, child] of input.children.entries()) {
    lines.push(
      "",
      `${index + 1}. ${child.agent} — ${child.status}`,
      ...formatChildOutput(child, input.source),
    );
  }

  return lines.join("\n");
}

function payloadLocations(
  input: GroupedResultIntercomMessageInput,
): Record<string, string | number> {
  const locations: Record<string, string | number> = {};
  for (const key of ["completionId", "error", "resultPath", "asyncId", "asyncDir"] as const) {
    const value = input[key];
    if (hasText(value)) {
      locations[key] = value;
    }
  }
  if (input.chainSteps !== undefined) {
    locations.chainSteps = input.chainSteps;
  }
  return locations;
}

function firstChildDetails(
  child: SubagentResultIntercomChild | undefined,
): Pick<SubagentResultIntercomPayload, "agent" | "index" | "artifactPath" | "sessionPath"> {
  if (!child) {
    return {};
  }
  return {
    ...(child.agent.length > 0 ? { agent: child.agent } : {}),
    ...(child.index !== undefined ? { index: child.index } : {}),
    ...(hasText(child.artifactPath) ? { artifactPath: child.artifactPath } : {}),
    ...(hasText(child.sessionPath) ? { sessionPath: child.sessionPath } : {}),
  };
}

export function buildSubagentResultIntercomPayload(
  input: ReadonlyInput<GroupedResultIntercomMessageInput>,
): SubagentResultIntercomPayload {
  const children = input.children.map((child) =>
    Object.assign({}, child, {
      summary: child.summary.trim().length > 0 ? child.summary.trim() : "(no output)",
      children: compactNestedResultChildren(child.children),
    }),
  );
  const status = resolveGroupedStatus(children, input.status);
  const summary = formatStatusCounts(countStatuses(children));
  const firstChild = children.at(0);
  const payload = {
    ...payloadLocations(input),
    to: input.to,
    runId: input.runId,
    mode: input.mode,
    status,
    summary,

    source: input.source,
    children,
    ...firstChildDetails(firstChild),
  };
  return { ...payload, message: formatSubagentResultIntercomMessage(payload) };
}

function stripSingleResultOutputs(result: ReadonlyInput<SingleResult>): SingleResult {
  return {
    ...copyResult(result),
    messages: undefined,
    finalOutput: undefined,
    truncation: undefined,
  };
}

export function stripDetailsOutputsForIntercomReceipt(
  details: ReadonlyInput<Details>,
  delivery?: Details["intercomDelivery"],
): Details {
  return {
    ...copyDetails(details),
    results: details.results.map(stripSingleResultOutputs),
    ...(delivery ? { intercomDelivery: delivery } : {}),
  };
}

function compactReceiptSummary(summary: string): string {
  const withoutOutput = summary.split(/\n\nOutput:\n|\sOutput:\s/)[0] ?? summary;
  const normalized = withoutOutput.replace(/\s+/g, " ").trim();
  return normalized.length > 240 ? `${normalized.slice(0, 239)}…` : normalized;
}

function formatChildReferences(
  children: readonly SubagentResultIntercomChild[],
  field: "artifactPath" | "intercomTarget" | "sessionPath",
  heading: string,
): string[] {
  const lines: string[] = [];
  for (const child of children) {
    const value = child[field];
    if (typeof value === "string") {
      lines.push(`- ${child.agent} [${child.status}]: ${value}`);
    }
  }
  return lines.length > 0 ? [heading, ...lines] : [];
}

function formatReceiptReferences(payload: SubagentResultIntercomPayload): string[] {
  const lines: string[] = [];
  if (hasText(payload.resultPath)) {
    lines.push(`Saved result (acceptance details when configured): ${payload.resultPath}`);
  }
  for (const child of payload.children) {
    if (hasText(child.metadataPath)) {
      lines.push(
        `Result metadata (${child.agent}; acceptance details when configured): ${child.metadataPath}${fs.existsSync(child.metadataPath) ? "" : " (missing)"}`,
      );
    }
  }
  lines.push(
    ...formatChildReferences(payload.children, "artifactPath", "Artifacts:"),
    ...formatChildReferences(
      payload.children,
      "intercomTarget",
      "Run intercom targets (may be inactive after completion):",
    ),
    ...formatChildReferences(payload.children, "sessionPath", "Sessions:"),
  );
  const nonCompleted = payload.children.filter((child) => child.status !== "completed");
  if (nonCompleted.length > 0) {
    lines.push("Non-completed children:");
    for (const child of nonCompleted) {
      lines.push(`- ${child.agent} [${child.status}]: ${compactReceiptSummary(child.summary)}`);
    }
  }
  return lines;
}

export function formatSubagentResultReceipt(input: {
  readonly mode: SubagentRunMode;
  readonly runId: string;
  readonly payload: SubagentResultIntercomPayload;
}): string {
  const counts = countStatuses(input.payload.children);
  const modeLabel = {
    single: "single subagent result",
    parallel: "parallel subagent results",
    chain: "chain subagent results",
  }[input.mode];
  const lines = [
    `Delivered ${modeLabel} via intercom.`,
    "Delivery: succeeded",
    `Run: ${input.runId}`,
    `Child outcome: ${input.payload.status}`,
    `Children: ${formatStatusCounts(counts)}`,
    ...(hasText(input.payload.error)
      ? [
          `Workflow ${input.payload.status === "paused" ? "paused" : "error"}: ${input.payload.error}`,
        ]
      : []),
  ];

  lines.push(...formatReceiptReferences(input.payload));
  lines.push("Full grouped output was sent over intercom.");
  return lines.join("\n");
}
