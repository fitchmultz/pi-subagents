import type { DynamicParallelStep } from "../../shared/settings.ts";
import type { ArtifactPaths, ChainOutputMap } from "../../shared/types.ts";
import { outputEntryFromResult } from "./chain-outputs.ts";
import { collectDynamicResults, validateDynamicCollection, type DynamicCollectedResult, type DynamicMaterializedItem } from "./dynamic-fanout.ts";
import { aggregateParallelOutputs, FAIL_FAST_REASON, mapConcurrent, type ParallelTaskResult } from "./parallel-utils.ts";

export interface WorkflowOutcome extends ParallelTaskResult {
	interrupted?: boolean;
	detached?: boolean;
	timedOut?: boolean;
	structuredOutput?: unknown;
	artifactPaths?: ArtifactPaths;
	savedOutputPath?: string;
}

export type ParallelStopReason = "cancelled" | "interrupted" | "fail-fast" | "detached" | "timed-out";

type ChildOutcome = Pick<WorkflowOutcome, "exitCode" | "interrupted" | "detached" | "timedOut">;
type WorkflowStepStatus = "completed" | "failed" | "paused" | "detached" | "timed-out";

export function workflowChildSucceeded(result: ChildOutcome): boolean {
	return result.exitCode === 0 && !result.interrupted && !result.detached && !result.timedOut;
}

export async function runParallelTasks<T, R extends ChildOutcome>(input: {
	tasks: T[];
	concurrency: number;
	failFast?: boolean;
	signal?: AbortSignal;
	interruptSignal?: AbortSignal;
	runTask: (task: T, index: number, failFastSignal: AbortSignal) => Promise<R>;
	stoppedTask: (task: T, index: number, reason: ParallelStopReason) => R;
}): Promise<R[]> {
	const failFast = new AbortController();
	let stopped: ParallelStopReason | undefined;
	return mapConcurrent(input.tasks, input.concurrency, async (task, index) => {
		const reason = input.signal?.aborted ? "cancelled" : input.interruptSignal?.aborted ? "interrupted" : stopped;
		if (reason) return input.stoppedTask(task, index, reason);
		const result = await input.runTask(task, index, failFast.signal);
		if (result.detached) stopped ??= "detached";
		else if (result.interrupted) stopped ??= "interrupted";
		else if (result.timedOut) stopped ??= "timed-out";
		else if (input.failFast && !workflowChildSucceeded(result)) {
			stopped ??= "fail-fast";
			failFast.abort(FAIL_FAST_REASON);
		}
		return result;
	});
}

export function completeWorkflowStep(input: {
	stepIndex: number;
	stepCount: number;
	results: WorkflowOutcome[];
	outputNames?: Array<string | undefined>;
	previousOutput: string;
	parallel?: boolean;
	dynamic?: { step: DynamicParallelStep; items: DynamicMaterializedItem[] };
}): {
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
} {
	const outputs: ChainOutputMap = {};
	const failedIndices: number[] = [];
	const timedOutIndex = input.results.findIndex((result) => result.timedOut);
	const interruptedIndex = input.results.findIndex((result) => result.interrupted);
	const detachedIndex = input.results.findIndex((result) => result.detached);
	for (const [index, result] of input.results.entries()) {
		if (workflowChildSucceeded(result)) {
			const name = input.outputNames?.[index];
			if (name) outputs[name] = outputEntryFromResult(result, input.stepIndex);
		} else if (!result.timedOut && !result.interrupted && !result.detached) {
			failedIndices.push(index);
		}
	}
	let status: WorkflowStepStatus = failedIndices.length > 0 ? "failed"
		: timedOutIndex >= 0 ? "timed-out"
		: interruptedIndex >= 0 ? "paused"
		: detachedIndex >= 0 ? "detached" : "completed";
	let error: string | undefined;
	let collection: DynamicCollectedResult[] | undefined;
	let previousOutput = input.previousOutput;
	if (status === "completed" && input.dynamic) {
		const { step, items } = input.dynamic;
		try {
			if (items.length !== input.results.length) throw new Error("Dynamic fanout did not complete every child.");
			collection = collectDynamicResults(step, items, input.results);
			validateDynamicCollection(step.collect.outputSchema, collection);
			outputs[step.collect.as] = { text: JSON.stringify(collection), structured: collection, agent: step.parallel.agent, stepIndex: input.stepIndex };
			previousOutput = items.length === 0 ? "Dynamic fanout produced 0 results." : aggregateParallelOutputs(input.results,
				(index, agent) => `=== Dynamic Item ${index + 1} (${agent}, key ${items[index]?.key ?? index}) ===`);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
			status = "failed";
		}
	} else if (status === "completed") {
		previousOutput = input.parallel ? aggregateParallelOutputs(input.results) : input.results[0]?.output ?? input.previousOutput;
	}
	const advance = status === "completed";
	return {
		advance,
		complete: advance && input.stepIndex + 1 === input.stepCount,
		status,
		failedIndices,
		timedOutIndex,
		interruptedIndex,
		detachedIndex,
		outputs,
		previousOutput,
		collection,
		error,
	};
}
