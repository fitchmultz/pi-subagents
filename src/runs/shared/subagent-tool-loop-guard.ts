const REPEATED_SUBAGENT_CALL_LIMIT = 5;
const SUBAGENT_CALL_WINDOW_SIZE = REPEATED_SUBAGENT_CALL_LIMIT * 2 - 1;

interface SubagentCallStart {
	callKey?: string;
	failed?: boolean;
	isList: boolean;
	toolCallId?: string;
}

export interface RepeatedSubagentCallGuardState {
	recentStarts: SubagentCallStart[];
}

export function createRepeatedSubagentCallGuardState(): RepeatedSubagentCallGuardState {
	return { recentStarts: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (!isRecord(value)) return JSON.stringify(value) ?? "undefined";
	return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function subagentCallKey(toolName: unknown, args: unknown): string | undefined {
	return toolName === "subagent" && isRecord(args) ? stableStringify(args) : undefined;
}

export function recordToolStartForSubagentLoopGuard(input: {
	state: RepeatedSubagentCallGuardState;
	toolCallId?: unknown;
	toolName: unknown;
	args: unknown;
	limit?: number;
}): string | undefined {
	const callKey = subagentCallKey(input.toolName, input.args);
	const limit = input.limit ?? REPEATED_SUBAGENT_CALL_LIMIT;
	input.state.recentStarts.push({
		callKey,
		isList: input.toolName === "subagent" && isRecord(input.args) && input.args.action === "list",
		toolCallId: typeof input.toolCallId === "string" ? input.toolCallId : undefined,
	});
	if (input.state.recentStarts.length > SUBAGENT_CALL_WINDOW_SIZE) input.state.recentStarts.shift();
	const listCount = input.state.recentStarts.filter((entry) => entry.isList).length;
	if (listCount >= limit) {
		return `Child appears stuck repeating subagent({ action: "list" }) ${listCount} times. Stopping to avoid a tool loop.`;
	}
	return undefined;
}

export function recordToolEndForSubagentLoopGuard(input: {
	state: RepeatedSubagentCallGuardState;
	toolCallId?: unknown;
	toolName: unknown;
	isError: unknown;
	limit?: number;
}): string | undefined {
	if (input.toolName !== "subagent" || input.isError !== true) return undefined;
	const toolCallId = typeof input.toolCallId === "string" ? input.toolCallId : undefined;
	const entry = [...input.state.recentStarts].reverse().find((candidate) =>
		candidate.callKey && candidate.failed === undefined && (!toolCallId || candidate.toolCallId === toolCallId));
	if (!entry?.callKey) return undefined;
	entry.failed = true;
	const failedCount = input.state.recentStarts.filter((candidate) => candidate.failed && candidate.callKey === entry.callKey).length;
	const limit = input.limit ?? REPEATED_SUBAGENT_CALL_LIMIT;
	if (failedCount >= limit) {
		return `Child appears stuck repeating the same failed subagent call ${failedCount} times. Stopping to avoid a tool loop.`;
	}
	return undefined;
}
