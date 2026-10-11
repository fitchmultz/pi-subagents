import { isDynamicParallelStep, isParallelStep } from "../../shared/settings.ts";
import type {
  ChainStep,
  SequentialStep,
  DynamicParallelStep,
  ParallelStep,
} from "../../shared/types/workflow.ts";
import type {
  ReadonlyInput,
  SingleResult,
  SubagentRunMode,
  WorkflowGraphNode,
  WorkflowGraphSnapshot,
  WorkflowNodeStatus,
  OwnedRun,
  ReadonlyAsyncStatus,
} from "../../shared/types.ts";

/** Pending fanouts keep their own slot until their actual children are known. */
export function workflowAgentNodes(
  graph: ReadonlyInput<WorkflowGraphSnapshot>,
): ReadonlyInput<WorkflowGraphNode>[] {
  return graph.nodes.flatMap((node) => {
    if ((node.children?.length ?? 0) > 0) {
      return node.children ?? [];
    }
    if (
      node.kind === "dynamic-parallel-group" &&
      node.status !== "completed" &&
      node.status !== "complete"
    ) {
      return [node];
    }
    return node.children ?? [node];
  });
}

export function workflowChildren(
  children: OwnedRun["children"],
  graph: WorkflowGraphSnapshot | undefined,
): OwnedRun["children"] {
  if (
    !graph ||
    (graph.mode !== "chain" && !children.some((child) => (child.workflowNodeId ?? "") !== ""))
  ) {
    return children;
  }
  const result: OwnedRun["children"][number][] = [];
  for (const [index, node] of workflowAgentNodes(graph).entries()) {
    const declared = children.find((child) => child.workflowNodeId === node.id);
    result.push({
      ...declared,
      index,
      workflowNodeId: node.id,
      agent: node.agent ?? declared?.agent ?? "unknown",
      ...(node.itemKey !== undefined ? { label: node.label } : {}),
    });
  }
  return result;
}

/** Admit saved node identity only when it agrees with the actual child slots. */
export function savedWorkflowNodes(
  status: ReadonlyAsyncStatus | null | undefined,
): readonly WorkflowGraphNode[] | undefined {
  if (!status?.workflowGraph || status.workflowGraph.runId !== status.runId) {
    return;
  }
  const nodes = workflowAgentNodes(status.workflowGraph);
  if (
    nodes.length !== status.steps?.length ||
    new Set(nodes.map((node) => node.id)).size !== nodes.length
  ) {
    return;
  }
  if (
    nodes.some(
      (node, index) =>
        node.id === "" ||
        ((node.agent ?? "") !== "" && node.agent !== status.steps?.[index]?.agent),
    )
  ) {
    return;
  }
  return nodes;
}

export interface WorkflowGraphBuildInput {
  readonly runId: string;
  readonly mode?: SubagentRunMode;
  readonly steps: ReadonlyInput<ChainStep[]>;
  readonly results?: ReadonlyInput<
    Array<
      Pick<
        SingleResult,
        "exitCode" | "detached" | "interrupted" | "timedOut" | "error" | "acceptance"
      >
    >
  >;
  readonly currentFlatIndex?: number;
  readonly currentStepIndex?: number;
  readonly stepStatuses?: readonly { readonly status?: string; readonly error?: string }[];
  readonly dynamicChildren?: Readonly<Record<number, readonly DynamicChild[]>>;
  readonly dynamicGroupStatuses?: Readonly<
    Record<
      number,
      {
        readonly status: WorkflowNodeStatus;
        readonly error?: string;
        readonly acceptance?: ReadonlyInput<SingleResult["acceptance"]>;
      }
    >
  >;
}
interface DynamicChild {
  readonly agent: string;
  readonly label?: string;
  readonly flatIndex: number;
  readonly itemKey: string;
  readonly outputName?: string;
  readonly structured?: boolean;
  readonly error?: string;
}
type ResultStatusInput = ReadonlyInput<
  Pick<SingleResult, "exitCode" | "detached" | "interrupted" | "timedOut" | "acceptance">
>;

function normalizeStatus(status: string | undefined): WorkflowNodeStatus | undefined {
  switch (status) {
    case "complete":
    case "completed":
      return "completed";
    case "running":
      return "running";
    case "failed":
      return "failed";
    case "paused":
      return "paused";
    case "blocked":
      return "blocked";
    case "detached":
      return "detached";
    case "timed-out":
      return "timed-out";
    case "pending":
      return "pending";
    case undefined:
      return undefined;
    default:
      return undefined;
  }
}

function resultStatus(result: ResultStatusInput | undefined): WorkflowNodeStatus | undefined {
  if (!result) {
    return undefined;
  }
  if (result.detached === true) {
    return "detached";
  }
  if (result.timedOut === true) {
    return "timed-out";
  }
  if (result.interrupted === true) {
    return "paused";
  }
  if (result.exitCode !== 0) {
    return "failed";
  }
  return result.acceptance?.status === "blocked" ? "blocked" : "completed";
}

function summarizeParallelStatuses(statuses: readonly WorkflowNodeStatus[]): WorkflowNodeStatus {
  for (const priority of [
    "running",
    "failed",
    "timed-out",
    "blocked",
    "paused",
    "detached",
  ] as const) {
    if (statuses.includes(priority)) {
      return priority;
    }
  }
  if (statuses.length > 0 && statuses.every((status) => status === "completed")) {
    return "completed";
  }
  return statuses.includes("completed") ? "running" : "pending";
}

function firstLabel(...labels: readonly (string | undefined)[]): string {
  return (
    labels
      .slice(0, -1)
      .find((label) => (label?.trim().length ?? 0) > 0)
      ?.trim() ??
    labels.at(-1) ??
    ""
  );
}

function agentLabel(label: string | undefined, agent: string, fallback: string): string {
  const trimmed = label?.trim() ?? "";
  if (trimmed.length > 0) {
    return trimmed;
  }
  return agent.length > 0 ? agent : fallback;
}

/** Owns graph assembly, phase membership, and flat-index assignment during a single snapshot. */
class GraphBuilder {
  private readonly nodes: WorkflowGraphNode[] = [];
  private readonly phases: Array<{ title: string; nodeIds: string[] }> = [];
  private flatIndex = 0;
  private currentNodeId: string | undefined;
  private readonly input: WorkflowGraphBuildInput;
  constructor(input: WorkflowGraphBuildInput) {
    this.input = input;
  }

  private status(index: number): WorkflowNodeStatus {
    return (
      normalizeStatus(this.input.stepStatuses?.[index]?.status) ??
      resultStatus(this.input.results?.[index]) ??
      (this.input.currentFlatIndex === index ? "running" : "pending")
    );
  }

  private addPhase(phase: string | undefined, nodeId: string): void {
    if (phase === undefined || phase.length === 0) {
      return;
    }
    let group = this.phases.find((candidate) => candidate.title === phase);
    if (!group) {
      group = { title: phase, nodeIds: [] };
      this.phases.push(group);
    }
    group.nodeIds.push(nodeId);
  }

  private observations(
    index: number,
    fallbackError?: string,
  ): Pick<WorkflowGraphNode, "acceptanceStatus" | "error"> {
    return {
      acceptanceStatus: this.input.results?.[index]?.acceptance?.status,
      error:
        this.input.stepStatuses?.[index]?.error ??
        this.input.results?.[index]?.error ??
        fallbackError,
    };
  }

  private trackChild(child: ReadonlyInput<WorkflowGraphNode>): void {
    this.addPhase(child.phase, child.id);
    if (child.status === "running" || this.input.currentFlatIndex === child.flatIndex) {
      this.currentNodeId = child.id;
    }
  }

  private markCurrentGroup(stepIndex: number, groupId: string): void {
    if (this.input.currentStepIndex === stepIndex && this.currentNodeId === undefined) {
      this.currentNodeId = groupId;
    }
  }

  private addParallel(step: ReadonlyInput<ParallelStep>, stepIndex: number): void {
    const groupId = `step-${stepIndex}`;
    const children = step.parallel.map((task, taskIndex): WorkflowGraphNode => {
      const index = this.flatIndex++;
      const child: WorkflowGraphNode = {
        id: `step-${stepIndex}-agent-${taskIndex}`,
        kind: "agent",
        agent: task.agent,
        phase: task.phase,
        label: agentLabel(task.label, task.agent, `Agent ${taskIndex + 1}`),
        status: this.status(index),
        flatIndex: index,
        stepIndex,
        outputName: task.as,
        structured: Boolean(task.outputSchema),
        ...this.observations(index),
      };
      this.trackChild(child);
      return child;
    });
    this.markCurrentGroup(stepIndex, groupId);
    this.nodes.push({
      id: groupId,
      kind: "parallel-group",
      label:
        step.parallel.length === 1 ? "Parallel task" : `Parallel group (${step.parallel.length})`,
      status: summarizeParallelStatuses(children.map((child) => child.status)),
      stepIndex,
      children,
    });
  }

  private dynamicChild(
    step: ReadonlyInput<DynamicParallelStep>,
    task: DynamicChild,
    stepIndex: number,
  ): WorkflowGraphNode {
    return {
      id: `step-${stepIndex}-item-${task.itemKey.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
      kind: "agent",
      agent: task.agent,
      phase: step.parallel.phase ?? step.phase,
      label: firstLabel(task.label, step.parallel.label, `${task.agent} ${task.itemKey}`),
      status: this.status(task.flatIndex),
      flatIndex: task.flatIndex,
      stepIndex,
      itemKey: task.itemKey,
      outputName: task.outputName,
      structured: task.structured,
      ...this.observations(task.flatIndex, task.error),
    };
  }

  private dynamicStatus(
    children: readonly WorkflowGraphNode[],
    stepIndex: number,
  ): WorkflowNodeStatus {
    const override = this.input.dynamicGroupStatuses?.[stepIndex];
    const emptyStatus = this.input.currentStepIndex === stepIndex ? "running" : "pending";
    return (
      override?.status ??
      (children.length > 0
        ? summarizeParallelStatuses(children.map((child) => child.status))
        : emptyStatus)
    );
  }

  private addDynamic(step: ReadonlyInput<DynamicParallelStep>, stepIndex: number): void {
    const groupId = `step-${stepIndex}`;
    const materialized = this.input.dynamicChildren?.[stepIndex] ?? [];
    const override = this.input.dynamicGroupStatuses?.[stepIndex];
    const children = materialized.map((task) => {
      const child = this.dynamicChild(step, task, stepIndex);
      this.trackChild(child);
      return child;
    });
    const status = this.dynamicStatus(children, stepIndex);
    this.markCurrentGroup(stepIndex, groupId);
    this.nodes.push({
      id: groupId,
      kind: "dynamic-parallel-group",
      label: firstLabel(step.label, step.parallel.label, `Dynamic fanout (${step.collect.as})`),
      status,
      stepIndex,
      outputName: step.collect.as,
      structured: Boolean(step.collect.outputSchema),
      acceptanceStatus: override?.acceptance?.status,
      error: override?.error,
      dynamic: {
        sourceOutput: step.expand.from.output,
        sourcePath: step.expand.from.path,
        itemName: step.expand.item ?? "item",
        maxItems: step.expand.maxItems,
        collectAs: step.collect.as,
      },
      children,
    });
    if (materialized.length > 0) {
      this.flatIndex = Math.max(
        this.flatIndex,
        ...materialized.map((child) => child.flatIndex + 1),
      );
    }
  }

  private addSequential(step: ReadonlyInput<SequentialStep>, stepIndex: number): void {
    const index = this.flatIndex++;
    const status = this.status(index);
    const id = `step-${stepIndex}`;
    this.nodes.push({
      id,
      kind: "step",
      agent: step.agent,
      phase: step.phase,
      label: agentLabel(step.label, step.agent, `Step ${stepIndex + 1}`),
      status,
      flatIndex: index,
      stepIndex,
      outputName: step.as,
      structured: Boolean(step.outputSchema),
      ...this.observations(index),
    });
    this.addPhase(step.phase, id);
    if (
      status === "running" ||
      this.input.currentFlatIndex === index ||
      this.input.currentStepIndex === stepIndex
    ) {
      this.currentNodeId = id;
    }
  }

  build(): WorkflowGraphSnapshot {
    for (const [stepIndex, step] of this.input.steps.entries()) {
      if (isParallelStep(step)) {
        this.addParallel(step, stepIndex);
      } else if (isDynamicParallelStep(step)) {
        this.addDynamic(step, stepIndex);
      } else {
        this.addSequential(step, stepIndex);
      }
    }
    return {
      runId: this.input.runId,
      mode: this.input.mode ?? "chain",
      phases: this.phases,
      nodes: this.nodes,
      currentNodeId: this.currentNodeId,
    };
  }
}

export function buildWorkflowGraphSnapshot(input: WorkflowGraphBuildInput): WorkflowGraphSnapshot {
  return new GraphBuilder(input).build();
}
