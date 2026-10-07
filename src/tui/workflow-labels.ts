import { nonemptyText } from "./text-values.ts";
import type {
  AsyncParallelGroupStatus,
  Details,
  ReadonlyInput,
  WorkflowGraphNode,
  WorkflowNodeStatus,
} from "../shared/types.ts";
import {
  isDoneResult,
  parallelStatuses,
  groupStatus,
  outcomeLabel,
  spanCompleted,
} from "./workflow-outcomes.ts";
export { isDoneResult } from "./workflow-outcomes.ts";
type DetailsInput = ReadonlyInput<Details>;
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
    const missing = span.isParallel
      ? span.count === 0
      : details.results.at(span.start) === undefined;
    if (missing) {
      entries.push(placeholder(span, details));
      continue;
    }
    for (let index = span.start; index < span.start + span.count; index++) {
      const agentName =
        details.results.at(index)?.agent ??
        details.chainAgents?.[span.stepIndex] ??
        `step-${span.stepIndex + 1}`;
      entries.push({ kind: "result", resultIndex: index, rowNumber: index + 1, agentName });
    }
  }
  return entries;
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
    span = spans.at(current),
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
  details: Pick<DetailsInput, "results" | "chainAgents">,
  index: number,
  direct: boolean,
  fallback: string,
): string {
  const agent = details.results.at(index)?.agent;
  if (direct) {
    return nonemptyText(agent) ?? fallback;
  }
  return nonemptyText(details.chainAgents?.at(index)) ?? nonemptyText(agent) ?? fallback;
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
  const chainCount = details.chainAgents?.length ?? 0;
  const direct = label.hasParallelInChain || chainCount === 0;
  const start = label.showActiveGroupOnly ? label.groupStartIndex : 0;
  let end = direct ? details.results.length : chainCount;
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
      agentName: fallbackName(details, index, direct, `${fallback}-${row}`),
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
