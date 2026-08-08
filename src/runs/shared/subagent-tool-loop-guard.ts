const REPEATED_SUBAGENT_CALL_LIMIT = 5;
const SUBAGENT_CALL_WINDOW_SIZE = REPEATED_SUBAGENT_CALL_LIMIT * 2 - 1;

export interface RepeatedSubagentCallGuardState {
	recentStarts: Array<string | undefined>;
}

export function createRepeatedSubagentCallGuardState(): RepeatedSubagentCallGuardState {
	return { recentStarts: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function subagentCallKey(toolName: unknown, args: unknown): string | undefined {
	return toolName === "subagent" && isRecord(args) ? JSON.stringify(args) : undefined;
}

export function recordToolStartForSubagentLoopGuard(input: {
	state: RepeatedSubagentCallGuardState;
	toolName: unknown;
	args: unknown;
	limit?: number;
}): string | undefined {
	const callKey = subagentCallKey(input.toolName, input.args);
	const limit = input.limit ?? REPEATED_SUBAGENT_CALL_LIMIT;
	input.state.recentStarts.push(callKey);
	if (input.state.recentStarts.length > SUBAGENT_CALL_WINDOW_SIZE) input.state.recentStarts.shift();
	if (!callKey) return undefined;
	const recentCount = input.state.recentStarts.filter((entry) => entry === callKey).length;
	if (recentCount >= limit) {
		return `Child appears stuck repeating the same subagent call ${recentCount} times. Stopping to avoid a tool loop.`;
	}
	return undefined;
}
