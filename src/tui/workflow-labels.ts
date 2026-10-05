import type {
  AsyncParallelGroupStatus,
  Details,
  ReadonlyInput,
  WorkflowGraphNode,
  WorkflowNodeStatus,
} from "../shared/types.ts";
import { formatAgentRunningLabel } from "../shared/status-format.ts";
type DetailsInput = ReadonlyInput<Details>;
type Result = DetailsInput["results"][number];
type ChainDetails = Pick<DetailsInput, "chainAgents" | "workflowGraph">;
type LabelDetails = Pick<
  DetailsInput,
  | "mode"
  | "results"
  | "progress"
  | "totalSteps"
  | "currentStepIndex"
  | "chainAgents"
  | "workflowGraph"
>;
interface ChainStepSpan {
  readonly stepIndex: number;
  readonly start: number;
  readonly count: number;
  readonly isParallel: boolean;
  readonly status?: WorkflowNodeStatus;
  readonly label?: string;
  readonly error?: string;
}
function parallelLabelCount(label: string): number | undefined {
  if (!label.startsWith("[") || !label.endsWith("]")) {
    return;
  }
  const inner = label.slice(1, -1).trim();
  return inner.length === 0
    ? 0
    : inner
        .split("+")
        .map((part) => part.trim())
        .filter(Boolean).length;
}
function graphSpan(node: WorkflowGraphNode, cursor: number, stepIndex: number): ChainStepSpan {
  const parallel = node.kind === "parallel-group" || node.kind === "dynamic-parallel-group";
  if (!parallel) {
    return {
      stepIndex,
      start: node.flatIndex ?? cursor,
      count: 1,
      isParallel: false,
      status: node.status,
      label: node.label,
      error: node.error,
    };
  }
  const indexes = (node.children ?? []).flatMap((child) =>
    child.flatIndex === undefined ? [] : [child.flatIndex],
  );
  return {
    stepIndex,
    start: indexes.length > 0 ? Math.min(...indexes) : cursor,
    count: node.children?.length ?? 0,
    isParallel: true,
    status: node.status,
    label: node.label,
    error: node.error,
  };
}
function graphSpans(nodes: readonly WorkflowGraphNode[]): ChainStepSpan[] {
  const spans: ChainStepSpan[] = [];
  let cursor = 0;
  for (const node of nodes) {
    if (node.stepIndex === undefined) {
      continue;
    }
    const span = graphSpan(node, cursor, node.stepIndex);
    spans.push(span);
    cursor = Math.max(cursor, span.start + span.count);
  }
  return spans.sort((left, right) => left.stepIndex - right.stepIndex);
}
export function buildChainStepSpans(details: ChainDetails): ChainStepSpan[] {
  const graph = graphSpans(details.workflowGraph?.nodes ?? []);
  if (graph.length > 0) {
    return graph;
  }
  let start = 0;
  return (details.chainAgents ?? []).map((label, stepIndex) => {
    const parallel = parallelLabelCount(label),
      count = parallel ?? 1;
    const span = { stepIndex, start, count, isParallel: parallel !== undefined };
    start += count;
    return span;
  });
}
function activeChainGroup(details: LabelDetails): boolean {
  if (details.mode !== "chain" || details.currentStepIndex === undefined) {
    return false;
  }
  return buildChainStepSpans(details).some(
    (span) => span.stepIndex === details.currentStepIndex && span.isParallel,
  );
}
export function buildAsyncChainStepSpans(
  total: number,
  stepCount: number,
  parallelGroups: ReadonlyInput<AsyncParallelGroupStatus[]> = [],
): ChainStepSpan[] {
  const spans: ChainStepSpan[] = [];
  let flat = 0;
  for (let stepIndex = 0; stepIndex < total; stepIndex++) {
    const group = parallelGroups.find((candidate) => candidate.stepIndex === stepIndex);
    if (group) {
      spans.push({ stepIndex, start: group.start, count: group.count, isParallel: true });
      flat = Math.max(flat, group.start + group.count);
      continue;
    }
    spans.push({ stepIndex, start: flat, count: flat < stepCount ? 1 : 0, isParallel: false });
    flat++;
  }
  return spans;
}
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
export function workflowGraphHasStatus(
  details: Pick<DetailsInput, "workflowGraph">,
  statuses: readonly WorkflowNodeStatus[],
): boolean {
  return details.workflowGraph?.nodes.some((node) => statuses.includes(node.status)) ?? false;
}
interface ChainRenderResultEntry {
  readonly kind: "result";
  readonly resultIndex: number;
  readonly rowNumber: number;
  readonly agentName: string;
}
interface ChainRenderPlaceholderEntry {
  readonly kind: "placeholder";
  readonly rowNumber: number;
  readonly stepLabel: string;
  readonly agentName: string;
  readonly status: WorkflowNodeStatus;
  readonly error?: string;
}
export type ChainRenderEntry = ChainRenderResultEntry | ChainRenderPlaceholderEntry;
export interface MultiProgressLabel {
  readonly headerLabel: string;
  readonly itemTitle: "Step" | "Agent";
  readonly totalCount: number;
  readonly hasParallelInChain: boolean;
  readonly activeParallelGroup: boolean;
  readonly groupStartIndex: number;
  readonly groupEndIndex: number;
  readonly showActiveGroupOnly: boolean;
}
function hasChainRows(details: DetailsInput, label: MultiProgressLabel): boolean {
  return (
    details.mode === "chain" &&
    (label.hasParallelInChain || (details.workflowGraph?.nodes.length ?? 0) > 0) &&
    !label.showActiveGroupOnly
  );
}
function placeholder(span: ChainStepSpan, details: DetailsInput): ChainRenderPlaceholderEntry {
  const single = span.isParallel ? undefined : details.chainAgents?.[span.stepIndex];
  const agentName =
    single ?? span.label ?? details.chainAgents?.[span.stepIndex] ?? `step-${span.stepIndex + 1}`;
  return {
    kind: "placeholder",
    rowNumber: span.stepIndex + 1,
    stepLabel: `Step ${span.stepIndex + 1}`,
    agentName,
    status: span.status ?? "pending",
    error: span.error,
  };
}
export function buildChainRenderEntries(
  details: DetailsInput,
  label: MultiProgressLabel,
): ChainRenderEntry[] | undefined {
  if (!hasChainRows(details, label)) {
    return;
  }
  const entries: ChainRenderEntry[] = [];
  for (const span of buildChainStepSpans(details)) {
    const missing = span.isParallel ? span.count === 0 : details.results[span.start] === undefined;
    if (missing) {
      entries.push(placeholder(span, details));
      continue;
    }
    for (let index = span.start; index < span.start + span.count; index++) {
      const agentName =
        details.results[index]?.agent ??
        details.chainAgents?.[span.stepIndex] ??
        `step-${span.stepIndex + 1}`;
      entries.push({ kind: "result", resultIndex: index, rowNumber: index + 1, agentName });
    }
  }
  return entries;
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
function progressForResult(
  details: LabelDetails,
  result: Result,
  index: number,
): DetailsInput["progress"] extends readonly (infer P)[] | undefined ? P | undefined : never {
  return (
    details.progress?.find((progress) => progress.index === index) ??
    details.progress?.find(
      (progress) => progress.agent === result.agent && progress.status === "running",
    )
  );
}
function parallelStatuses(details: LabelDetails, total: number): WorkflowNodeStatus[] {
  const statuses = Array.from({ length: total }, (): WorkflowNodeStatus => "pending");
  for (const progress of details.progress ?? []) {
    if (progress.index >= 0 && progress.index < total) {
      statuses[progress.index] = progress.status;
    }
  }
  for (const [position, result] of details.results.entries()) {
    const index =
      result.progress?.index ?? progressForResult(details, result, position)?.index ?? position;
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
function groupStatus(details: LabelDetails, index: number): WorkflowNodeStatus {
  const progress = details.progress?.find((entry) => entry.index === index);
  const result = details.results.find(
    (entry, position) => (entry.progress?.index ?? position) === index,
  );
  const status = progress?.status ?? result?.progress?.status;
  if (status === "running") {
    return "running";
  }
  const stopped = stoppedGroupStatus(status, result);
  if (stopped !== undefined) {
    return stopped;
  }
  if (result && result.exitCode !== 0) {
    return "failed";
  }
  if (status === "blocked" || blockedResult(result)) {
    return "blocked";
  }
  return status === "completed" || (result && isDoneResult(result)) ? "completed" : "pending";
}
function outcomeLabel(
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
function spanCompleted(details: LabelDetails, span: ChainStepSpan): boolean {
  if (span.status !== undefined && span.status !== "completed") {
    return false;
  }
  if (span.count === 0) {
    return span.status === "completed";
  }
  for (let index = span.start; index < span.start + span.count; index++) {
    const progress = details.progress?.find((entry) => entry.index === index);
    const result =
      details.results.find((entry) => entry.progress?.index === index) ?? details.results[index];
    if (["running", "pending", "failed"].includes(progress?.status ?? "")) {
      return false;
    }
    if (!result || !isDoneResult(result)) {
      return false;
    }
  }
  return true;
}
type LabelBase = Omit<MultiProgressLabel, "headerLabel" | "totalCount">;
function labelBase(details: LabelDetails, spans: readonly ChainStepSpan[]): LabelBase {
  const active = activeChainGroup(details);
  return {
    itemTitle: details.mode === "parallel" || active ? "Agent" : "Step",
    hasParallelInChain: details.mode === "chain" && spans.some((span) => span.isParallel),
    activeParallelGroup: active,
    groupStartIndex: 0,
    groupEndIndex: details.results.length,
    showActiveGroupOnly: false,
  };
}
function activeGroupLabel(
  details: LabelDetails,
  spans: readonly ChainStepSpan[],
  base: LabelBase,
  running: boolean,
): MultiProgressLabel {
  const current = details.currentStepIndex ?? 0,
    span = spans[current],
    count = span?.count ?? 1,
    start = span?.start ?? 0;
  const total = details.totalSteps ?? details.chainAgents?.length ?? 1;
  const statuses = Array.from({ length: count }, (_, offset) =>
    groupStatus(details, start + offset),
  );
  return {
    ...base,
    totalCount: count,
    groupStartIndex: start,
    groupEndIndex: start + count,
    showActiveGroupOnly: true,
    headerLabel: `step ${current + 1}/${total} · parallel group: ${outcomeLabel(statuses, count, running)}`,
  };
}
function chainLabel(
  details: LabelDetails,
  spans: readonly ChainStepSpan[],
  base: LabelBase,
  running: boolean,
): MultiProgressLabel {
  const total = details.totalSteps ?? details.chainAgents?.length ?? details.results.length;
  const logical = details.mode === "chain" && (details.chainAgents?.length ?? 0) > 0;
  const done = logical
    ? spans.filter((span) => spanCompleted(details, span)).length
    : details.results.filter(isDoneResult).length;
  const current =
    details.currentStepIndex === undefined
      ? Math.min(total, done + Number(running))
      : details.currentStepIndex + 1;
  return { ...base, totalCount: total, headerLabel: `step ${running ? current : done}/${total}` };
}
export function buildMultiProgressLabel(
  details: LabelDetails,
  running: boolean,
): MultiProgressLabel {
  const spans = buildChainStepSpans(details),
    base = labelBase(details, spans);
  if (details.mode === "parallel") {
    const total = details.totalSteps ?? details.results.length;
    return {
      ...base,
      totalCount: total,
      groupEndIndex: total,
      headerLabel: outcomeLabel(parallelStatuses(details, total), total, running, true),
    };
  }
  return base.activeParallelGroup
    ? activeGroupLabel(details, spans, base, running)
    : chainLabel(details, spans, base, running);
}
function fallbackName(
  details: DetailsInput,
  index: number,
  row: number,
  direct: boolean,
  fallback: string,
): string {
  const result = details.results[index];
  if (direct) {
    return result?.agent || `${fallback}-${row}`;
  }
  return details.chainAgents?.[index] || result?.agent || `${fallback}-${row}`;
}
export function renderEntries(
  details: DetailsInput,
  label: MultiProgressLabel,
  fallback = "step",
): ChainRenderEntry[] {
  const chain = buildChainRenderEntries(details, label);
  if (chain) {
    return chain;
  }
  const direct = label.hasParallelInChain || (details.chainAgents?.length ?? 0) === 0;
  const start = label.showActiveGroupOnly ? label.groupStartIndex : 0;
  let end = direct ? details.results.length : (details.chainAgents?.length ?? 0);
  if (label.showActiveGroupOnly) {
    end = label.groupEndIndex;
  }
  return Array.from({ length: end - start }, (_, offset) => {
    const index = start + offset,
      row = label.showActiveGroupOnly ? index - label.groupStartIndex + 1 : index + 1;
    return {
      kind: "result",
      resultIndex: index,
      rowNumber: row,
      agentName: fallbackName(details, index, row, direct, fallback),
    };
  });
}
export function resultRowLabel(
  details: Pick<DetailsInput, "mode" | "chainAgents" | "workflowGraph">,
  label: MultiProgressLabel,
  index: number,
  step: number,
): string {
  if (details.mode === "chain" && label.hasParallelInChain) {
    const span = buildChainStepSpans(details).find(
      (candidate) => index >= candidate.start && index < candidate.start + candidate.count,
    );
    if (span?.isParallel === true) {
      return `Agent ${index - span.start + 1}/${span.count}`;
    }
    if (span) {
      return `Step ${span.stepIndex + 1}`;
    }
  }
  if (label.itemTitle !== "Agent") {
    return `Step ${step}`;
  }
  const local = label.activeParallelGroup ? Math.max(1, step - label.groupStartIndex) : step;
  return `Agent ${local}/${label.totalCount}`;
}
