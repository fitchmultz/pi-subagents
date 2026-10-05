import * as path from "node:path";
import type { ReadonlyDeep } from "type-fest";
import type {
  ChainOutputMap,
  WorkflowGraphNode,
  WorkflowGraphSnapshot,
} from "../../shared/types.ts";
import { namespaceParallelOutput } from "../../shared/settings.ts";
import { injectSingleOutputInstruction, findDuplicateOutputPath } from "../shared/single-output.ts";
import { materializeDynamicParallelStep } from "../shared/dynamic-fanout.ts";
import type { DynamicRunnerGroup, RunnerSubagentStep } from "../../shared/types.ts";
import { resolveSubagentIntercomTarget } from "../../intercom/intercom-bridge.ts";
import {
  pendingRunnerStep,
  type RunnerStatusPayload,
  type RunnerStatusStep,
} from "./runner-status.ts";

export interface DynamicPlan {
  readonly tasks: RunnerSubagentStep[];
  readonly materialized: ReturnType<typeof materializeDynamicParallelStep>;
}

function namespaceOutput(
  step: RunnerSubagentStep,
  input: Readonly<{ chainDir: string; stepIndex: number; taskIndex: number }>,
): RunnerSubagentStep {
  if (
    step.output === false ||
    step.output === undefined ||
    step.output.length === 0 ||
    step.outputPath === undefined ||
    step.outputPath.length === 0
  ) {
    return step;
  }
  const output = namespaceParallelOutput(step.output, step.agent, input.stepIndex, input.taskIndex);
  if (output === false || output.length === 0) {
    return step;
  }
  const outputPath = path.resolve(input.chainDir, output);
  const task = step.task.includes(step.outputPath)
    ? step.task.split(step.outputPath).join(outputPath)
    : injectSingleOutputInstruction(step.task, outputPath);
  return { ...step, task, outputPath };
}

/** Validates fanout bindings and output collisions before changing live runner state. */
export function prepareDynamicGroup(
  step: DynamicRunnerGroup,
  outputs: ReadonlyDeep<ChainOutputMap>,
  input: Readonly<{ stepIndex: number; chainDir: string; maxItems?: number }>,
): DynamicPlan {
  const materialized = materializeDynamicParallelStep(step, outputs, input.stepIndex, {
    maxItems: input.maxItems,
    allowRunnerFields: true,
  });
  const tasks = materialized.parallel.map((task, taskIndex) =>
    namespaceOutput(
      {
        ...step.parallel,
        label: task.label ?? step.parallel.label,
        sessionFile: step.sessionFiles?.[taskIndex],
        structuredOutput: undefined,
        structuredOutputSchema:
          step.parallel.structuredOutputSchema ?? step.parallel.structuredOutput?.schema,
      },
      { ...input, taskIndex },
    ),
  );
  const error = findDuplicateOutputPath(tasks);
  if (error !== undefined && error.length > 0) {
    throw new Error(error);
  }
  return { tasks, materialized };
}

export function dynamicStatusSteps(
  plan: DynamicPlan,
  step: DynamicRunnerGroup,
): RunnerStatusStep[] {
  return plan.tasks.map((task) => ({
    ...pendingRunnerStep(task),
    phase: task.phase ?? step.phase,
    outputName: undefined,
    structured: task.structuredOutputSchema !== undefined,
  }));
}

interface ExpansionPosition {
  readonly runId: string;
  readonly stepIndex: number;
  readonly flatIndex: number;
}

export function reindexChildTargets(
  oldTargets: readonly (string | undefined)[] | undefined,
  steps: readonly ReadonlyDeep<RunnerStatusStep>[],
  input: Readonly<ExpansionPosition & { count: number }>,
): Array<string | undefined> | undefined {
  if (oldTargets === undefined) {
    return;
  }
  const dynamicUsesIntercom = oldTargets[input.flatIndex] !== undefined;
  return steps.map((step, index) => {
    const inGroup = index >= input.flatIndex && index < input.flatIndex + input.count;
    if (inGroup) {
      return dynamicUsesIntercom
        ? resolveSubagentIntercomTarget(input.runId, step.agent, index)
        : undefined;
    }
    const oldIndex = index < input.flatIndex ? index : index - (input.count - 1);
    return oldTargets[oldIndex] === undefined
      ? undefined
      : resolveSubagentIntercomTarget(input.runId, step.agent, index);
  });
}

/** This boundary owns replacing the placeholder and reindexing the mutable live status. */
export function expandDynamicStatus(
  statusPayload: RunnerStatusPayload,
  plan: DynamicPlan,
  step: DynamicRunnerGroup,
  position: ExpansionPosition,
): number {
  const children = dynamicStatusSteps(plan, step);
  statusPayload.steps.splice(position.flatIndex, 1, ...children);
  const delta = children.length - 1;
  for (const group of statusPayload.parallelGroups) {
    if (group.stepIndex === position.stepIndex) {
      group.start = position.flatIndex;
      group.count = children.length;
    } else if (group.stepIndex > position.stepIndex) {
      group.start += delta;
    }
  }
  return children.length;
}

export function expandDynamicGraph(
  graph: ReadonlyDeep<WorkflowGraphSnapshot>,
  plan: DynamicPlan,
  step: DynamicRunnerGroup,
  position: ExpansionPosition,
): WorkflowGraphSnapshot {
  const shiftNode = (node: ReadonlyDeep<WorkflowGraphNode>): WorkflowGraphNode => {
    const shift =
      node.stepIndex !== undefined &&
      node.stepIndex > position.stepIndex &&
      node.flatIndex !== undefined &&
      node.flatIndex >= position.flatIndex;
    return {
      ...node,
      dynamic: node.dynamic ? { ...node.dynamic } : undefined,
      flatIndex: shift ? (node.flatIndex ?? 0) + plan.tasks.length : node.flatIndex,
      children: node.children?.map(shiftNode),
    };
  };
  const nodes = graph.nodes.map(shiftNode);
  const children: WorkflowGraphNode[] = plan.materialized.items.map((item, itemIndex) => {
    const task = plan.tasks[itemIndex];
    const label = task.label?.trim();
    return {
      id: `step-${position.stepIndex}-item-${item.idKey}`,
      kind: "agent",
      agent: step.parallel.agent,
      phase: task.phase ?? step.phase,
      label:
        label === undefined || label.length === 0 ? `${step.parallel.agent} ${item.key}` : label,
      status: "pending",
      flatIndex: position.flatIndex + itemIndex,
      stepIndex: position.stepIndex,
      itemKey: item.key,
      structured: task.structuredOutputSchema !== undefined,
    };
  });
  return {
    ...graph,
    nodes: nodes.map((node) =>
      node.id === `step-${position.stepIndex}` ? { ...node, children } : node,
    ),
    phases: graph.phases.map((phase) => ({ ...phase, nodeIds: [...phase.nodeIds] })),
  };
}
