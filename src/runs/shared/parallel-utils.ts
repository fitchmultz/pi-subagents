import type { ReadonlyInput } from "../../shared/types/inputs.ts";
import type {
  RunnerStep,
  RunnerSubagentStep,
  ParallelStepGroup,
  DynamicRunnerGroup,
} from "../../shared/types/workflow.ts";
export type {
  RunnerStep,
  RunnerSubagentStep,
  ParallelStepGroup,
  DynamicRunnerGroup,
} from "../../shared/types/workflow.ts";

export function isParallelGroup(
  step: ReadonlyInput<RunnerStep>,
): step is ReadonlyInput<ParallelStepGroup> {
  return "parallel" in step && Array.isArray(step.parallel);
}

export function isDynamicRunnerGroup(
  step: ReadonlyInput<RunnerStep>,
): step is ReadonlyInput<DynamicRunnerGroup> {
  return (
    "expand" in step && "collect" in step && "parallel" in step && !Array.isArray(step.parallel)
  );
}

export function flattenSteps(
  steps: readonly ReadonlyInput<RunnerStep>[],
): ReadonlyInput<RunnerSubagentStep>[] {
  const flat: ReadonlyInput<RunnerSubagentStep>[] = [];
  for (const step of steps) {
    if (isParallelGroup(step)) {
      for (const task of step.parallel) {
        flat.push(task);
      }
    } else if (isDynamicRunnerGroup(step)) {
      continue;
    } else {
      flat.push(step);
    }
  }
  return flat;
}

export { mapConcurrent } from "../../shared/concurrency.ts";

export interface ParallelTaskResult {
  agent: string;
  taskIndex?: number;
  output: string;
  exitCode: number | null;
  error?: string;
  model?: string;
  attemptedModels?: string[];
  outputTargetPath?: string;
  outputTargetExists?: boolean;
}

function parallelResultStatus(
  result: ReadonlyInput<ParallelTaskResult>,
  hasOutput: boolean,
): string {
  const error = result.error ?? "";
  const suffix = error.length > 0 ? `: ${error}` : "";
  if (result.exitCode === -1) {
    return `SKIPPED${suffix}`;
  }
  if (result.exitCode !== 0 && result.exitCode !== null) {
    return `FAILED (exit code ${result.exitCode})${suffix}`;
  }
  if (error.length > 0) {
    return `WARNING: ${error}`;
  }
  return emptyOutputStatus(result, hasOutput);
}

function emptyOutputStatus(result: ReadonlyInput<ParallelTaskResult>, hasOutput: boolean): string {
  if (hasOutput) {
    return "";
  }
  const target = result.outputTargetPath ?? "";
  if (target.length === 0) {
    return "EMPTY OUTPUT (no textual response returned)";
  }
  return result.outputTargetExists === false
    ? `EMPTY OUTPUT (expected output file missing: ${target})`
    : "";
}

export function aggregateParallelOutputs(
  results: readonly ReadonlyInput<ParallelTaskResult>[],
  headerFormat: (index: number, agent: string) => string = (i, agent) =>
    `=== Parallel Task ${i + 1} (${agent}) ===`,
): string {
  return results
    .map((result, index) => {
      const header = headerFormat(result.taskIndex ?? index, result.agent);
      const hasOutput = result.output.trim().length > 0;
      const status = parallelResultStatus(result, hasOutput);
      let body = result.output;
      if (status.length > 0) {
        body = hasOutput ? `${status}\n${result.output}` : status;
      }
      return `${header}\n${body}`;
    })
    .join("\n\n");
}

export const FAIL_FAST_REASON = "subagent-fail-fast";

export function isFailFastAbort(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true && signal.reason === FAIL_FAST_REASON;
}

export const MAX_PARALLEL_CONCURRENCY = 4;
