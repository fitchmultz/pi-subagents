import type { SubagentExecutionResult } from "../shared/types.ts";
import type { ReadonlyInput } from "../shared/types/inputs.ts";

/** Preserve the native result envelope while giving the receiving tool its own content array. */
export function copyExecutionResult(
  result: ReadonlyInput<SubagentExecutionResult>,
): SubagentExecutionResult {
  return { ...result, content: [...result.content] };
}
