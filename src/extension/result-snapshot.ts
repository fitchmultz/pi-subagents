import type {
  AgentProgress,
  Details,
  SingleResult,
  SubagentExecutionResult,
} from "../shared/types.ts";
import type { ReadonlyInput } from "../shared/types/inputs.ts";

/** A new result owns its progress buffers; native messages and accounting stay shared snapshots. */
export function copyProgress(progress: ReadonlyInput<AgentProgress>): AgentProgress {
  return {
    ...progress,
    recentTools: progress.recentTools.map((tool) => ({ ...tool })),
    recentOutput: [...progress.recentOutput],
  };
}

export function copyResult(result: ReadonlyInput<SingleResult>): SingleResult {
  return { ...result, progress: result.progress ? copyProgress(result.progress) : undefined };
}

export function copyDetails(details: ReadonlyInput<Details>): Details {
  return {
    ...details,
    results: details.results.map(copyResult),
    progress: details.progress?.map(copyProgress),
  };
}

/** Preserve the native result envelope while giving the receiving tool its own content array. */
export function copyExecutionResult(
  result: ReadonlyInput<SubagentExecutionResult>,
): SubagentExecutionResult {
  return { ...result, content: [...result.content] };
}
