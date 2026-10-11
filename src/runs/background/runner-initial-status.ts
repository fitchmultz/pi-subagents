import * as path from "node:path";
import type { ReadonlyDeep } from "type-fest";
import type { RunnerStep, AsyncParallelGroupStatus } from "../../shared/types.ts";
import { flattenSteps, isDynamicRunnerGroup, isParallelGroup } from "../shared/parallel-utils.ts";
import type { SubagentRunConfig } from "./runner-contract.ts";
import { refreshRunnerGraph } from "./runner-graph.ts";
import {
  pendingRunnerStep,
  type RunnerStatusStep,
  type RunnerStatusPayload,
} from "./runner-status.ts";

function initialSteps(
  steps: readonly RunnerStep[],
): Readonly<{ steps: RunnerStatusStep[]; groups: AsyncParallelGroupStatus[] }> {
  const statusSteps: RunnerStatusStep[] = [];
  const groups: AsyncParallelGroupStatus[] = [];
  for (const [stepIndex, step] of steps.entries()) {
    const start = statusSteps.length;
    if (isParallelGroup(step)) {
      groups.push({ start, count: step.parallel.length, stepIndex });
      statusSteps.push(...step.parallel.map(pendingRunnerStep));
    } else if (isDynamicRunnerGroup(step)) {
      groups.push({ start, count: 1, stepIndex });
      statusSteps.push({
        agent: `expand:${step.parallel.agent}`,
        phase: step.phase ?? step.parallel.phase,
        label: step.label ?? step.parallel.label ?? `Dynamic fanout (${step.collect.as})`,
        outputName: step.collect.as,
        structured: step.collect.outputSchema !== undefined,
        status: "pending",
        recentTools: [],
        recentOutput: [],
      });
    } else {
      statusSteps.push(pendingRunnerStep(step));
    }
  }
  return { steps: statusSteps, groups };
}

export function createRunnerStatus(
  config: ReadonlyDeep<SubagentRunConfig>,
  startedAt: number,
): RunnerStatusPayload {
  const initial = initialSteps(config.steps);
  const graph = config.workflowGraph;
  return {
    runId: config.id,
    runtimeVersion: config.runtimeVersion,
    indexedControl: true,
    controlRequestFiles: true,
    ...(config.sessionId !== undefined && config.sessionId !== null && config.sessionId.length > 0
      ? { sessionId: config.sessionId }
      : {}),
    mode: config.resultMode ?? (flattenSteps(config.steps).length > 1 ? "chain" : "single"),
    state: "running",
    lastActivityAt: startedAt,
    startedAt,
    lastUpdate: startedAt,
    pid: process.pid,
    cwd: config.cwd,
    currentStep: 0,
    chainStepCount: config.steps.length,
    parallelGroups: initial.groups,
    workflowGraph: graph ? refreshRunnerGraph(graph, initial.steps, 0) : undefined,
    steps: initial.steps,
    artifactsDir: config.artifactsDir,
    sessionDir: config.sessionDir,
    outputFile: path.join(config.asyncDir, "output-0.log"),
  };
}
