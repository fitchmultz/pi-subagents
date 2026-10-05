import { errorMessage } from "../../shared/unknown.ts";
import type { DynamicParallelStep } from "../../shared/types/workflow.ts";
import type {
  AcceptanceLedger,
  ArtifactPaths,
  ChainOutputMap,
  ChainOutputMapEntry,
  ReadonlyInput,
} from "../../shared/types.ts";
import { outputEntryFromResult } from "./chain-outputs.ts";
import {
  collectDynamicResults,
  validateDynamicCollection,
  type DynamicCollectedResult,
  type DynamicMaterializedItem,
} from "./dynamic-fanout.ts";
import {
  aggregateParallelOutputs,
  FAIL_FAST_REASON,
  mapConcurrent,
  type ParallelTaskResult,
} from "./parallel-utils.ts";

export interface WorkflowOutcome extends ParallelTaskResult {
  interrupted?: boolean;
  detached?: boolean;
  timedOut?: boolean;
  acceptance?: AcceptanceLedger;
  structuredOutput?: unknown;
  artifactPaths?: ArtifactPaths;
  savedOutputPath?: string;
}
export type ParallelStopReason =
  | "cancelled"
  | "interrupted"
  | "fail-fast"
  | "detached"
  | "timed-out";
type ChildOutcome = ReadonlyInput<
  Pick<WorkflowOutcome, "exitCode" | "interrupted" | "detached" | "timedOut" | "acceptance">
>;
type WorkflowStepStatus = "completed" | "failed" | "blocked" | "paused" | "detached" | "timed-out";

export function workflowChildSucceeded(result: ChildOutcome): boolean {
  return (
    result.exitCode === 0 &&
    result.interrupted !== true &&
    result.detached !== true &&
    result.timedOut !== true &&
    result.acceptance?.status !== "blocked"
  );
}

function queuedStopReason(
  signal: AbortSignal | undefined,
  interruptSignal: AbortSignal | undefined,
  stopped: ParallelStopReason | undefined,
): ParallelStopReason | undefined {
  if (signal?.aborted === true) {
    return "cancelled";
  }
  return interruptSignal?.aborted === true ? "interrupted" : stopped;
}

function resultStopReason(result: ChildOutcome, failFast: boolean): ParallelStopReason | undefined {
  if (result.detached === true) {
    return "detached";
  }
  if (result.timedOut === true) {
    return "timed-out";
  }
  if (
    failFast &&
    result.interrupted !== true &&
    !childBlocked(result) &&
    !workflowChildSucceeded(result)
  ) {
    return "fail-fast";
  }
  return undefined;
}

export async function runParallelTasks<T, R extends ChildOutcome>(input: {
  readonly tasks: readonly ReadonlyInput<T>[];
  readonly concurrency: number;
  readonly failFast?: boolean;
  readonly signal?: AbortSignal;
  readonly interruptSignal?: AbortSignal;
  readonly runTask: (
    task: ReadonlyInput<T>,
    index: number,
    failFastSignal: AbortSignal,
  ) => Promise<R>;
  readonly stoppedTask: (task: ReadonlyInput<T>, index: number, reason: ParallelStopReason) => R;
}): Promise<R[]> {
  const failFast = new AbortController();
  let stopped: ParallelStopReason | undefined;
  return mapConcurrent(input.tasks, input.concurrency, async (task, index) => {
    const reason = queuedStopReason(input.signal, input.interruptSignal, stopped);
    if (reason !== undefined) {
      return input.stoppedTask(task, index, reason);
    }
    const result = await input.runTask(task, index, failFast.signal);
    // A selected-child stop must not skip independent siblings; whole-group stops use interruptSignal.
    const nextStop = resultStopReason(result, input.failFast === true);
    stopped ??= nextStop;
    if (nextStop === "fail-fast") {
      failFast.abort(FAIL_FAST_REASON);
    }
    return result;
  });
}

function childBlocked(result: ChildOutcome): boolean {
  return result.exitCode === 0 && result.acceptance?.status === "blocked";
}
interface StepInput {
  readonly stepIndex: number;
  readonly stepCount: number;
  readonly results: readonly ReadonlyInput<WorkflowOutcome>[];
  readonly outputNames?: readonly (string | undefined)[];
  readonly previousOutput: string;
  readonly parallel?: boolean;
  readonly dynamic?: {
    readonly step: ReadonlyInput<DynamicParallelStep>;
    readonly items: readonly DynamicMaterializedItem[];
  };
}
interface StepResult {
  advance: boolean;
  complete: boolean;
  status: WorkflowStepStatus;
  failedIndices: number[];
  timedOutIndex: number;
  interruptedIndex: number;
  detachedIndex: number;
  outputs: ChainOutputMap;
  previousOutput: string;
  collection?: DynamicCollectedResult[];
  error?: string;
}

function summarizeStep(
  results: readonly ReadonlyInput<WorkflowOutcome>[],
): Pick<
  StepResult,
  "status" | "failedIndices" | "timedOutIndex" | "interruptedIndex" | "detachedIndex"
> {
  const timedOutIndex = results.findIndex((result) => result.timedOut === true);
  const interruptedIndex = results.findIndex((result) => result.interrupted === true);
  const detachedIndex = results.findIndex((result) => result.detached === true);
  const failedIndices = results.flatMap((result, index) =>
    !workflowChildSucceeded(result) &&
    result.timedOut !== true &&
    result.interrupted !== true &&
    result.detached !== true &&
    !childBlocked(result)
      ? [index]
      : [],
  );
  let status: WorkflowStepStatus = "completed";
  if (failedIndices.length > 0) {
    status = "failed";
  } else if (timedOutIndex >= 0) {
    status = "timed-out";
  } else if (results.some(childBlocked)) {
    status = "blocked";
  } else if (interruptedIndex >= 0) {
    status = "paused";
  } else if (detachedIndex >= 0) {
    status = "detached";
  }
  return { status, failedIndices, timedOutIndex, interruptedIndex, detachedIndex };
}

function collectStepOutput(input: StepInput): {
  outputs: ChainOutputMap;
  previousOutput: string;
  collection?: DynamicCollectedResult[];
} {
  if (!input.dynamic) {
    return {
      outputs: {},
      previousOutput:
        input.parallel === true
          ? aggregateParallelOutputs(input.results)
          : (input.results[0]?.output ?? input.previousOutput),
    };
  }
  const { step, items } = input.dynamic;
  if (items.length !== input.results.length) {
    throw new Error("Dynamic fanout did not complete every child.");
  }
  const collection = collectDynamicResults(step, items, input.results);
  validateDynamicCollection(step.collect.outputSchema, collection);
  const outputs: ChainOutputMap = {
    [step.collect.as]: {
      text: JSON.stringify(collection),
      structured: collection,
      agent: step.parallel.agent,
      stepIndex: input.stepIndex,
    },
  };
  const previousOutput =
    items.length === 0
      ? "Dynamic fanout produced 0 results."
      : aggregateParallelOutputs(
          input.results,
          (index, agent) =>
            `=== Dynamic Item ${index + 1} (${agent}, key ${items[index]?.key ?? index}) ===`,
        );
  return { outputs, previousOutput, collection };
}

function successfulNamedOutputs(input: StepInput): Record<string, ChainOutputMapEntry> {
  const outputs: Record<string, ChainOutputMapEntry> = {};
  for (const [index, result] of input.results.entries()) {
    const name = input.outputNames?.[index];
    if (workflowChildSucceeded(result) && name !== undefined && name.length > 0) {
      Object.defineProperty(outputs, name, {
        value: outputEntryFromResult(result, input.stepIndex),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return outputs;
}

export function completeWorkflowStep(input: StepInput): StepResult {
  const summary = summarizeStep(input.results);
  let outputs = successfulNamedOutputs(input);
  let status = summary.status;
  let previousOutput = input.previousOutput;
  let collection: DynamicCollectedResult[] | undefined;
  let error: string | undefined;
  if (status === "completed") {
    try {
      const collected = collectStepOutput(input);
      outputs = { ...outputs, ...collected.outputs };
      previousOutput = collected.previousOutput;
      collection = collected.collection;
    } catch (cause) {
      error = errorMessage(cause);
      status = "failed";
    }
  }
  const advance = status === "completed";
  return {
    ...summary,
    status,
    advance,
    complete: advance && input.stepIndex + 1 === input.stepCount,
    outputs,
    previousOutput,
    collection,
    error,
  };
}
