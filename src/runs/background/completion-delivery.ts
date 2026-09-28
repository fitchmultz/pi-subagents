import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RESULTS_DIR, SLASH_RESULT_TYPE, SUBAGENT_ASYNC_COMPLETE_EVENT, type AsyncResultFile, type Details, type SubagentState } from "../../shared/types.ts";
import type { SlashMessageDetails } from "../../slash/slash-live-state.ts";
import { nativeInvocationTarget, nativeInvocations } from "../shared/native-async.ts";
import { finalizedChildUsage, type registerParentUsage } from "../shared/parent-usage.ts";
import { ownedRunView, rememberOwnedRun } from "../shared/run-records.ts";
import { getRunMetadataDir, saveAsyncRunResult } from "../shared/supervisor-questions.ts";
import registerSubagentNotify, { type SubagentNotifyDetails } from "./notify.ts";
import { createResultWatcher } from "./result-watcher.ts";

/** The same saved-parent delivery contract applies to root and child-safe callers. */
export function createCompletionDelivery(pi: ExtensionAPI, state: SubagentState, parentUsage: ReturnType<typeof registerParentUsage>) {
	// Host queues can survive extension reload, but not process restart. Values track the one idle retry.
	const store = globalThis as Record<string, unknown>;
	const queueKey = "__pi_subagents_queued_notifications__";
	const queued = store[queueKey] instanceof Map ? store[queueKey] as Map<string, boolean> : new Map<string, boolean>();
	store[queueKey] = queued;
	state.isRunResultConsumed = (runId) => {
		const run = state.ownedRuns?.get(runId);
		return state.lastUiContext?.sessionManager.getEntries().some((entry) => {
			const details = entry.type === "message" && entry.message.role === "toolResult"
				? entry.message.details as Details | undefined
				: entry.type === "custom_message" && entry.customType === SLASH_RESULT_TYPE
					? (entry.details as SlashMessageDetails | undefined)?.result?.details : undefined;
			return details?.wait?.runId === runId && details.wait.status === "completed"
				&& (details.wait.index === undefined || (run?.mode === "single" && details.wait.index === 0));
		}) ?? false;
	};
	state.hasNativeResultOwner = (runId) => {
		const ctx = state.lastUiContext;
		if (!ctx) return false;
		const completedCalls = new Set(ctx.sessionManager.getEntries().flatMap((entry) =>
			entry.type === "message" && entry.message.role === "toolResult" ? [entry.message.toolCallId] : []));
		return nativeInvocations(ctx).some((call) => {
			const target = nativeInvocationTarget(ctx, call);
			return !completedCalls.has(call.toolCallId) && target?.runId === runId
				&& (target.index === undefined || (state.ownedRuns?.get(runId)?.mode === "single" && target.index === 0));
		});
	};
	const reconcileDelivery = (runId: string, completionKey: string): boolean => {
		const ctx = state.lastUiContext;
		const run = state.ownedRuns?.get(runId);
		if (!ctx || !run) return false;
		const receipt = ctx.sessionManager.getEntries().find((entry) => {
			if (entry.type !== "custom_message" || entry.customType !== "subagent-notify") return false;
			const completion = (entry.details as SubagentNotifyDetails | undefined)?.completion;
			return completion?.runId === runId && completion.key === completionKey;
		});
		if (!receipt) return false;
		queued.delete(completionKey);
		// The notification entry is the authority, including after a crash before accounting.
		parentUsage.record(finalizedChildUsage(ownedRunView(run, state).children), ctx);
		rememberOwnedRun(state, { ...run, delivery: { notifiedAt: Date.parse(receipt.timestamp), intercomDelivered: false } });
		return true;
	};
	const watcher = createResultWatcher(pi, state, RESULTS_DIR, 10 * 60 * 1000, {
		reconcileDelivery: (runId, key) => {
			if (reconcileDelivery(runId, key)) return true;
			const retried = queued.get(key);
			if (retried === undefined) return false;
			if (retried || !state.lastUiContext?.isIdle()) return true;
			// Idle without a journal entry means the host dropped the first queued message.
			state.completionSeen.delete(key);
			return false;
		},
	});
	let unsubscribe: (() => void) | undefined;
	let unsubscribeNotify: (() => void) | undefined;
	const start = () => {
		if (!unsubscribe) {
			unsubscribeNotify = registerSubagentNotify(pi, (key) => queued.set(key, queued.has(key)));
			unsubscribe = pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (data) => {
				const result = data as AsyncResultFile & { completionKey?: string; intercomResultDelivered?: boolean; suppressNotification?: boolean };
				const run = state.ownedRuns?.get(result.runId ?? result.id ?? "");
				if (!run || result.sessionId !== state.currentSessionId) return;
				if (state.lastUiContext) parentUsage.record(finalizedChildUsage(ownedRunView(run, state).children), state.lastUiContext);
				if (result.suppressNotification === true) return;
				if (result.runtimeVersion !== 2 && !fs.existsSync(path.join(getRunMetadataDir(run.runId), "result.json"))) saveAsyncRunResult(run.runId, result);
				if (result.intercomResultDelivered === true) {
					rememberOwnedRun(state, { ...run, delivery: { notifiedAt: Date.now(), intercomDelivered: true } });
				} else if (result.completionKey) {
					// sendMessage may only have queued work. Never persist delivery before its journal entry.
					reconcileDelivery(run.runId, result.completionKey);
				}
			});
		}
		fs.mkdirSync(RESULTS_DIR, { recursive: true });
		watcher.startResultWatcher();
		watcher.primeExistingResults();
	};
	const stop = () => {
		watcher.stopResultWatcher();
		unsubscribe?.();
		unsubscribe = undefined;
		unsubscribeNotify?.();
		unsubscribeNotify = undefined;
	};
	return { start, stop, holdCheckpoint: watcher.holdCheckpoint };
}
