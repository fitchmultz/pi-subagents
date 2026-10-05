import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SubagentExecutionResult } from "../shared/types.ts";
import type { ReadonlyInput } from "../shared/types/inputs.ts";
import { isRecord } from "../shared/unknown.ts";
import { copyExecutionResult } from "./result-snapshot.ts";

export function registerToolResultAdapter(
  pi: ExtensionAPI,
  toolNames: readonly string[],
): (result: ReadonlyInput<SubagentExecutionResult>) => SubagentExecutionResult {
  pi.on("tool_result", (event) => {
    const details: unknown = event.details;
    if (!toolNames.includes(event.toolName) || !isRecord(details) || details.isError !== true) {
      return;
    }
    const { isError, ...originalDetails } = details;
    return { isError, details: originalDetails };
  });
  // Native execute ignores returned isError; throwing discards content/details.
  // Carry the flag to its native result hook, which restores the original details.
  return (result) => {
    const snapshot = copyExecutionResult(result);
    return result.isError === true
      ? { ...snapshot, details: { ...snapshot.details, isError: true } }
      : snapshot;
  };
}
