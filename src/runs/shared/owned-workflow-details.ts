import type { Details, WorkflowGraphSnapshot } from "../../shared/types.ts";

/** Saved graph facts shared by result and activity projections, never workflow execution. */
export function workflowDetails(
  graph: WorkflowGraphSnapshot | undefined,
): Pick<Details, "workflowGraph" | "chainAgents" | "totalSteps" | "currentStepIndex"> {
  if (!graph) {
    return {};
  }
  if (graph.mode !== "chain") {
    return { workflowGraph: graph };
  }
  const current = graph.nodes.find(
    (node) =>
      node.id === graph.currentNodeId ||
      node.children?.some((child) => child.id === graph.currentNodeId) === true,
  );
  return {
    workflowGraph: graph,
    chainAgents: graph.nodes.map((node) => node.agent ?? node.label),
    totalSteps: graph.nodes.length,
    ...(current?.stepIndex !== undefined ? { currentStepIndex: current.stepIndex } : {}),
  };
}
