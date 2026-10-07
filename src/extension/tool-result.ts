import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentExecutionResult } from "../shared/types.ts";
import type { ReadonlyInput } from "../shared/types/inputs.ts";
import { isRecord } from "../shared/unknown.ts";
import { copyExecutionResult } from "./result-snapshot.ts";
import { finalizedChildUsage, type ParentUsageRegistration } from "../runs/shared/parent-usage.ts";

/** Only completed, directly owned waits carry accounting intent to the native result boundary. */
export function adaptFinalizedToolResult(
  result: ReadonlyInput<SubagentExecutionResult>,
  ctx: ExtensionContext,
  parentUsage: ParentUsageRegistration,
  adapt: (result: ReadonlyInput<SubagentExecutionResult>) => SubagentExecutionResult,
): SubagentExecutionResult {
  const attached =
    result.details.wait?.status === "completed" &&
    result.details.run?.ownerSessionId === ctx.sessionManager.getSessionId()
      ? parentUsage.attach(
          result,
          finalizedChildUsage(result.details.run.children, result.details.wait.index),
          ctx,
        )
      : result;
  return adapt(attached);
}

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
