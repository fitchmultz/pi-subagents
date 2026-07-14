import type { ChildProcess } from "node:child_process";
import type { Message } from "@earendil-works/pi-ai/compat";
import {
	appendClaudeCodeMessage,
	claudeCodeMessageFromResult,
	writeClaudeCodeSessionMetadata,
	type ClaudeCodeInvocation,
	type ClaudeCodeResultEvent,
} from "./claude-code.ts";
import { trySignalChild } from "../../shared/post-exit-stdio-guard.ts";

export interface ChildUsage {
	input?: number;
	inputTokens?: number;
	output?: number;
	outputTokens?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
}

export type ChildMessage = Message & {
	model?: string;
	errorMessage?: string;
	usage?: ChildUsage;
};

export interface ChildProcessEvent {
	type?: string;
	message?: ChildMessage;
	toolName?: string;
	args?: Record<string, unknown>;
}

export function parseChildProcessEvent(line: string, options?: {
	claudeCodeInvocation?: ClaudeCodeInvocation;
	sessionFile?: string;
	model?: string;
}): ChildProcessEvent | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const event = parsed as ChildProcessEvent;
	const invocation = options?.claudeCodeInvocation;
	if (!invocation || event.type !== "result") return event;
	const result = event as ClaudeCodeResultEvent;
	const message = claudeCodeMessageFromResult(result, options?.model ?? invocation.model.inputModel);
	if (options?.sessionFile) {
		writeClaudeCodeSessionMetadata(options.sessionFile, {
			sessionId: result.session_id || invocation.sessionId,
			model: invocation.model.inputModel,
			cliModel: invocation.model.cliModel,
			family: invocation.model.family,
			context: invocation.model.context,
			updatedAt: Date.now(),
		});
		appendClaudeCodeMessage(options.sessionFile, message);
	}
	return { type: "message_end", message } as ChildProcessEvent;
}

export const FINAL_STOP_GRACE_MS = 1000;
const FINAL_STOP_HARD_KILL_MS = 3000;

export function createFinalDrain(
	child: Pick<ChildProcess, "kill">,
	isStopped: () => boolean,
	onForcedTermination: (cleanTerminalStop: boolean) => void,
): {
	start(cleanTerminalStop: boolean): void;
	markExited(): void;
	clear(): void;
	readonly forcedTerminationSignal: boolean;
	readonly cleanTerminalStop: boolean;
} {
	let childExited = false;
	let forcedTerminationSignal = false;
	let cleanTerminalStop = false;
	let drainTimer: NodeJS.Timeout | undefined;
	let hardKillTimer: NodeJS.Timeout | undefined;
	const clear = () => {
		if (drainTimer) clearTimeout(drainTimer);
		if (hardKillTimer) clearTimeout(hardKillTimer);
		drainTimer = hardKillTimer = undefined;
	};
	return {
		start(clean) {
			cleanTerminalStop ||= clean;
			if (childExited || drainTimer || isStopped()) return;
			drainTimer = setTimeout(() => {
				if (isStopped() || !trySignalChild(child, "SIGTERM")) return;
				forcedTerminationSignal = true;
				onForcedTermination(cleanTerminalStop);
				hardKillTimer = setTimeout(() => {
					if (!isStopped()) forcedTerminationSignal = trySignalChild(child, "SIGKILL") || forcedTerminationSignal;
				}, FINAL_STOP_HARD_KILL_MS);
				hardKillTimer.unref?.();
			}, FINAL_STOP_GRACE_MS);
			drainTimer.unref?.();
		},
		markExited() {
			childExited = true;
			clear();
		},
		clear,
		get forcedTerminationSignal() { return forcedTerminationSignal; },
		get cleanTerminalStop() { return cleanTerminalStop; },
	};
}

export function stopChildWithEscalation(
	child: Pick<ChildProcess, "kill">,
	isStopped: () => boolean,
	options: { initialSignal?: NodeJS.Signals; escalationSignal?: NodeJS.Signals; delayMs?: number } = {},
): NodeJS.Timeout {
	trySignalChild(child, options.initialSignal ?? "SIGINT");
	const timer = setTimeout(() => {
		if (!isStopped()) trySignalChild(child, options.escalationSignal ?? "SIGTERM");
	}, options.delayMs ?? 1000);
	timer.unref?.();
	return timer;
}

export function clearTimer(timer: NodeJS.Timeout | undefined): undefined {
	if (timer) clearTimeout(timer);
	return undefined;
}
