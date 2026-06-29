const REPEATED_SUBAGENT_LIST_LIMIT = 5;

export interface RepeatedSubagentListGuardState {
	count: number;
}

export function createRepeatedSubagentListGuardState(): RepeatedSubagentListGuardState {
	return { count: 0 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isSubagentListToolStart(toolName: unknown, args: unknown): boolean {
	return toolName === "subagent" && isRecord(args) && args.action === "list";
}

export function recordToolStartForSubagentListLoopGuard(input: {
	state: RepeatedSubagentListGuardState;
	toolName: unknown;
	args: unknown;
	limit?: number;
}): string | undefined {
	if (isSubagentListToolStart(input.toolName, input.args)) {
		input.state.count += 1;
		const limit = input.limit ?? REPEATED_SUBAGENT_LIST_LIMIT;
		if (input.state.count >= limit) {
			return `Child appears stuck repeating subagent({ action: "list" }) ${input.state.count} times. Stopping to avoid a tool loop.`;
		}
		return undefined;
	}
	input.state.count = 0;
	return undefined;
}
