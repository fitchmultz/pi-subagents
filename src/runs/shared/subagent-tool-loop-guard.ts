import { createHash } from "node:crypto";

const REPEATED_SUBAGENT_CALL_LIMIT = 5;
const SUBAGENT_CALL_WINDOW_SIZE = REPEATED_SUBAGENT_CALL_LIMIT * 2 - 1;

interface SubagentCallStart {
	callKey: string;
	failed?: boolean;
	toolCallId?: string;
}

export interface RepeatedSubagentCallGuardState {
	recentStarts: boolean[];
	recentSubagentCalls: SubagentCallStart[];
}

export function createRepeatedSubagentCallGuardState(): RepeatedSubagentCallGuardState {
	return { recentStarts: [], recentSubagentCalls: [] };
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
	if (toolName !== "subagent" || !isRecord(args)) return undefined;
	try {
		return createHash("sha256").update(stableStringify(args)).digest("hex");
	} catch {
		return undefined;
	}
}

export function recordToolStartForSubagentLoopGuard(input: {
	state: RepeatedSubagentCallGuardState;
	toolCallId?: unknown;
	toolName: unknown;
	args: unknown;
}): string | undefined {
	const isList = input.toolName === "subagent" && isRecord(input.args) && input.args.action === "list";
	input.state.recentStarts.push(isList);
	if (input.state.recentStarts.length > SUBAGENT_CALL_WINDOW_SIZE) input.state.recentStarts.shift();
	const callKey = subagentCallKey(input.toolName, input.args);
	if (callKey) {
		input.state.recentSubagentCalls.push({
			callKey,
			toolCallId: typeof input.toolCallId === "string" ? input.toolCallId : undefined,
		});
		if (input.state.recentSubagentCalls.length > SUBAGENT_CALL_WINDOW_SIZE) input.state.recentSubagentCalls.shift();
	}
	if (!isList) return undefined;
	const listCount = input.state.recentStarts.filter(Boolean).length;
	if (listCount >= REPEATED_SUBAGENT_CALL_LIMIT) {
		return `Child appears stuck repeating subagent({ action: "list" }) ${listCount} times. Stopping to avoid a tool loop.`;
	}
	return undefined;
}

export function recordToolEndForSubagentLoopGuard(input: {
	state: RepeatedSubagentCallGuardState;
	toolCallId?: unknown;
	toolName: unknown;
	isError: unknown;
}): string | undefined {
	if (input.toolName !== "subagent" || input.isError !== true) return undefined;
	const toolCallId = typeof input.toolCallId === "string" ? input.toolCallId : undefined;
	const entry = [...input.state.recentSubagentCalls].reverse().find((candidate) =>
		candidate.failed === undefined && (!toolCallId || !candidate.toolCallId || candidate.toolCallId === toolCallId));
	if (!entry) return undefined;
	entry.failed = true;
	const failedCount = input.state.recentSubagentCalls.filter((candidate) => candidate.failed && candidate.callKey === entry.callKey).length;
	if (failedCount >= REPEATED_SUBAGENT_CALL_LIMIT) {
		return `Child appears stuck repeating the same failed subagent call ${failedCount} times. Stopping to avoid a tool loop.`;
	}
	return undefined;
}
