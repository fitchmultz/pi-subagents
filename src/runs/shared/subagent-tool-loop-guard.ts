const REPEATED_SUBAGENT_LIST_LIMIT = 5;
const SUBAGENT_LIST_WINDOW_SIZE = REPEATED_SUBAGENT_LIST_LIMIT * 2 - 1;

export interface RepeatedSubagentListGuardState {
	recentStarts: boolean[];
}

export function createRepeatedSubagentListGuardState(): RepeatedSubagentListGuardState {
	return { recentStarts: [] };
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
	const isList = isSubagentListToolStart(input.toolName, input.args);
	const limit = input.limit ?? REPEATED_SUBAGENT_LIST_LIMIT;
	input.state.recentStarts.push(isList);
	if (input.state.recentStarts.length > SUBAGENT_LIST_WINDOW_SIZE) input.state.recentStarts.shift();
	if (!isList) return undefined;
	const recentCount = input.state.recentStarts.filter(Boolean).length;
	if (recentCount >= limit) {
		return `Child appears stuck repeating subagent({ action: "list" }) ${recentCount} times. Stopping to avoid a tool loop.`;
	}
	return undefined;
}
