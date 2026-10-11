import type { ReadonlyDeep } from "type-fest";
import type {
  WorkflowGraphNode,
  WorkflowGraphSnapshot,
  WorkflowNodeStatus,
} from "../../shared/types.ts";
import type { RunnerStatusStep } from "./runner-status.ts";

function normalizeStepStatus(status: RunnerStatusStep["status"]): WorkflowNodeStatus {
  if (status === "complete" || status === "completed") {
    return "completed";
  }
  if (
    status === "running" ||
    status === "failed" ||
    status === "blocked" ||
    status === "paused" ||
    status === "pending"
  ) {
    return status;
  }
  return "pending";
}

function aggregateStatus(
  children: readonly ReadonlyDeep<WorkflowGraphNode>[],
  fallback: WorkflowNodeStatus,
): WorkflowNodeStatus {
  if (children.length === 0) {
    return fallback;
  }
  if (children.every((child) => child.status === "completed")) {
    return "completed";
  }
  for (const status of ["running", "failed", "blocked", "paused"] as const) {
    if (children.some((child) => child.status === status)) {
      return status;
    }
  }
  return fallback;
}

function projectedNode(
  node: ReadonlyDeep<WorkflowGraphNode>,
  step: ReadonlyDeep<RunnerStatusStep> | undefined,
): ReadonlyDeep<WorkflowGraphNode> {
  if (step === undefined) {
    return node;
  }
  return {
    ...node,
    status: normalizeStepStatus(step.status),
    error: step.error,
    acceptanceStatus: step.acceptance?.status,
  };
}

/** Builds a new graph from status snapshots without modifying launch inputs or graph nodes. */
export function refreshRunnerGraph(
  graph: ReadonlyDeep<WorkflowGraphSnapshot>,
  steps: readonly ReadonlyDeep<RunnerStatusStep>[],
  currentStep: number,
): WorkflowGraphSnapshot {
  let currentNodeId = graph.currentNodeId;
  const updateNode = (node: ReadonlyDeep<WorkflowGraphNode>): WorkflowGraphNode => {
    const step = node.flatIndex === undefined ? undefined : steps.at(node.flatIndex);
    if (node.flatIndex !== undefined && node.flatIndex === currentStep) {
      currentNodeId = node.id;
    }
    const projected = projectedNode(node, step);
    const children = projected.children?.map(updateNode);
    const error = projected.error;
    let status = aggregateStatus(children ?? [], projected.status);
    if (error !== undefined && error.length > 0) {
      status = "failed";
    }
    return {
      ...projected,
      dynamic: projected.dynamic ? { ...projected.dynamic } : undefined,
      children,
      status,
    };
  };
  const nodes = graph.nodes.map(updateNode);
  return {
    ...graph,
    phases: graph.phases.map((phase) => ({ ...phase, nodeIds: [...phase.nodeIds] })),
    nodes,
    currentNodeId,
  };
}
