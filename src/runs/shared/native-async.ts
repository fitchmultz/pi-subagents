import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { listSupervisorQuestions } from "./supervisor-questions.ts";
import { SessionEntryCursor } from "../../shared/session-entries.ts";

/** Optional public fork ABI; official Pi retains ordinary receipts and abort-aware waits. */
export type AsyncContext = ExtensionContext & {
	getPendingToolCalls?: () => readonly { toolCallId: string; toolName: string; state: "pending" | "started" | "detached" }[];
};

const INVOCATION_ENTRY = "subagent-invocation";
const invocationIndexes = new WeakMap<ExtensionContext["sessionManager"], { cursor: SessionEntryCursor; calls: Map<string, NativeInvocation> }>();

export interface NativeInvocation {
	toolCallId: string;
	ownerSessionId: string;
	runId: string;
	index?: number;
	kind: "launch" | "delivery" | "answer";
	includeProgress?: boolean;
	accepted?: boolean;
	questionId?: string;
	answer?: string;
}

export function isNativeAsyncCall(ctx: ExtensionContext, toolCallId: string): boolean {
	const compat = ctx.model?.compat;
	return Boolean(compat && "supportsAsyncTools" in compat && compat.supportsAsyncTools === true
		&& (ctx as AsyncContext).getPendingToolCalls?.().some((call) => call.toolCallId === toolCallId));
}

export function nativeInvocations(ctx: ExtensionContext): NativeInvocation[] {
	let index = invocationIndexes.get(ctx.sessionManager);
	if (!index) {
		index = { cursor: new SessionEntryCursor(), calls: new Map() };
		invocationIndexes.set(ctx.sessionManager, index);
	}
	const { entries, reset } = index.cursor.read(ctx.sessionManager);
	if (reset) index.calls.clear();
	for (const metadata of entries) {
		const entry = metadata.type === "custom" && metadata.customType === INVOCATION_ENTRY ? ctx.sessionManager.getEntry?.(metadata.id) ?? metadata : metadata;
		if (entry.type !== "custom" || entry.customType !== INVOCATION_ENTRY) continue;
		const call = entry.data as NativeInvocation | undefined;
		if (call?.ownerSessionId === ctx.sessionManager.getSessionId() && typeof call.toolCallId === "string" && typeof call.runId === "string") index.calls.set(call.toolCallId, call);
	}
	return [...index.calls.values()];
}

/** Journal the original call binding before launch, answer publication, or live message delivery. */
export function bindNativeInvocation(pi: ExtensionAPI, ctx: ExtensionContext | undefined, toolCallId: string | undefined, target: Omit<NativeInvocation, "toolCallId" | "ownerSessionId">): void {
	if (!toolCallId) return;
	if (!ctx) throw new Error("Native subagent calls require their owning session context.");
	const previous = nativeInvocations(ctx).find((call) => call.toolCallId === toolCallId);
	if (previous && (previous.runId !== target.runId || previous.index !== target.index || previous.kind !== target.kind || previous.questionId !== target.questionId || previous.answer !== target.answer)) throw new Error("A native subagent call cannot be rebound to different work.");
	const call = { ...previous, ...target, toolCallId, ownerSessionId: ctx.sessionManager.getSessionId() };
	if (JSON.stringify(call) !== JSON.stringify(previous)) pi.appendEntry(INVOCATION_ENTRY, call);
}

/** Recovery follows saved effects; it never delivers a message or starts a replacement process. */
export function nativeInvocationTarget(ctx: ExtensionContext, call: NativeInvocation): { runId: string; index?: number } | undefined {
	if (call.ownerSessionId !== ctx.sessionManager.getSessionId()) return;
	if (call.kind === "delivery" && !call.accepted) return;
	if (call.kind === "answer") {
		const question = listSupervisorQuestions(call.ownerSessionId, call.runId).find((question) => question.questionId === call.questionId);
		if (!question?.answer || question.answer.message !== call.answer) return;
		if (question.delivery?.kind === "revive") return { runId: question.delivery.runId, index: 0 };
		if (question.revival) return { runId: question.revival.runId, index: 0 };
	}
	return { runId: call.runId, ...(call.index !== undefined ? { index: call.index } : {}) };
}
