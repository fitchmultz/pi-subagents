import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Details, SubagentExecutionResult } from "../shared/types.ts";

export function registerToolResultAdapter(pi: ExtensionAPI, toolNames: readonly string[]) {
	pi.on("tool_result", (event) => {
		const details = event.details as (Details & { isError?: boolean }) | undefined;
		if (!toolNames.includes(event.toolName) || details?.isError !== true) return;
		const { isError, ...originalDetails } = details;
		return { isError, details: originalDetails };
	});
	// Native execute ignores returned isError; throwing discards content/details.
	// Carry the flag to its native result hook, which restores the original details.
	return (result: SubagentExecutionResult) => result.isError
		? { ...result, details: { ...result.details, isError: true } }
		: result;
}
