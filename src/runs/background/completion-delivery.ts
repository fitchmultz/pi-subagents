import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RESULTS_DIR, SUBAGENT_ASYNC_COMPLETE_EVENT, type AsyncResultFile, type SubagentState } from "../../shared/types.ts";
import { entryMetadata, journalStamp, scanJournal } from "../../shared/journal-reader.ts";
import { nativeInvocationTarget, nativeInvocations } from "../shared/native-async.ts";
import { finalizedChildUsage, type registerParentUsage } from "../shared/parent-usage.ts";
import { ownedRunView, rememberOwnedRun, repairOwnedRunAccounting } from "../shared/run-records.ts";
import registerSubagentNotify from "./notify.ts";
import { createResultWatcher } from "./result-watcher.ts";

/** Completion authority is the published parent receipt, never queue/send acceptance. */
export function createCompletionDelivery(pi: ExtensionAPI, state: SubagentState, parentUsage: ReturnType<typeof registerParentUsage>) {
	const store = globalThis as Record<string, unknown>, queueKey = "__pi_subagents_queued_notifications__";
	const queued = store[queueKey] instanceof Set ? store[queueKey] as Set<string> : new Set<string>();
	store[queueKey] = queued;
	let cache: { file: string; stamp: string; receipts: Array<Record<string, any>> } | undefined;
	const receipts = () => {
		const file = state.lastUiContext?.sessionManager.getSessionFile();
		if (!file || !fs.existsSync(file)) return [];
		const stamp = journalStamp(fs.statSync(file, { bigint: true }));
		if (cache?.file === file && cache.stamp === stamp) return cache.receipts;
		const records: Array<Record<string, any>> = [];
		scanJournal(file, (path) => {
			if (!path.length || ["type", "id", "timestamp", "customType"].includes(String(path[0]))) return 4096;
			if (path[0] === "details") return path.length === 1 || ["completion", "subagentCompletion", "result"].includes(String(path[1])) && (path[1] !== "result" || path.length <= 3 || path[3] === "wait") ? 4096 : false;
			if (path[0] === "message") return path.length === 1 || ["role", "toolName"].includes(String(path[1])) || path[1] === "details" && (path.length === 2 || path[2] === "wait") ? 4096 : false;
			return false;
		}, ({ value }) => {
			if (value.type === "custom_message" || value.type === "message" && value.message?.role === "toolResult") records.push(value);
		}, { policy: "live" });
		cache = { file, stamp, receipts: records };
		return records;
	};
	const consumed = (entry: Record<string, any>, runId: string) => {
		const wait = entry.type === "message" ? entry.message?.details?.wait : entry.details?.result?.details?.wait;
		const run = state.ownedRuns?.get(runId);
		return wait?.runId === runId && wait.status === "completed" && (wait.index === undefined || run?.mode === "single" && wait.index === 0);
	};
	state.isRunResultConsumed = (runId) => receipts().some((entry) => consumed(entry, runId));
	state.hasNativeResultOwner = (runId) => {
		const ctx = state.lastUiContext;
		if (!ctx) return false;
		const completedCalls = new Set([...entryMetadata(ctx.sessionManager)].flatMap((entry) => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message.toolCallId] : []));
		return nativeInvocations(ctx).some((call) => {
			const target = nativeInvocationTarget(ctx, call);
			return !completedCalls.has(call.toolCallId) && target?.runId === runId && (target.index === undefined || state.ownedRuns?.get(runId)?.mode === "single" && target.index === 0);
		});
	};
	const matches = (entry: Record<string, any>, runId: string, key: string) => {
		if (consumed(entry, runId)) return true;
		if (entry.type !== "custom_message") return false;
		const completion = entry.details?.completion ?? entry.details?.subagentCompletion;
		return completion?.runId === runId && (completion.key === key || completion.completionId && `completion:${completion.completionId}` === key
			|| key.startsWith("completion:legacy:") && !completion.completionId && (completion.ownerSessionId === undefined || completion.ownerSessionId === state.currentSessionId));
	};
	const recordAccounting = (runId: string) => {
		const run = state.ownedRuns?.get(runId), ctx = state.lastUiContext;
		if (!run || !ctx) return;
		try {
			repairOwnedRunAccounting(run);
			const children = ownedRunView(run, state, { readConfiguration: false }).children;
			const incomplete = children.find((child) => child.result?.accounting?.state === "incomplete");
			const accounting = incomplete ? { state: "incomplete" as const, error: incomplete.result?.accounting?.error }
				: { state: parentUsage.record(finalizedChildUsage(children), ctx) ? "complete" as const : "pending" as const };
			rememberOwnedRun(state, { ...state.ownedRuns!.get(runId)!, accounting });
		} catch (error) {
			try { rememberOwnedRun(state, { ...state.ownedRuns!.get(runId)!, accounting: { state: "incomplete", error: String(error) } }); }
			catch (saveError) { console.error(`Could not save accounting projection for ${runId}:`, saveError); }
			console.error(`Subagent ${runId} accounting remains incomplete:`, error);
		}
	};
	const reconcileDelivery = (runId: string, key: string, accounting = true): boolean => {
		const run = state.ownedRuns?.get(runId);
		if (!run) return false;
		const receipt = receipts().find((entry) => matches(entry, runId, key));
		if (receipt) {
			queued.delete(key);
			// Save delivery before optional accounting. Even a failed owner append cannot
			// make this published identity eligible for another notification.
			try { rememberOwnedRun(state, { ...run, completion: { id: key, state: "journaled", entryId: receipt.id },
				delivery: { notifiedAt: Date.parse(receipt.timestamp), intercomDelivered: receipt.customType === "intercom_message", completionId: key, entryId: receipt.id } }); }
			catch (error) { console.error(`Could not save delivery projection for ${runId}:`, error); }
			if (accounting) recordAccounting(runId);
			return true;
		}
		const ctx = state.lastUiContext;
		if (!ctx) return true;
		// An accepted but unflushed receipt or a native pending queue is ambiguous:
		// keep pending rather than enqueueing a second copy. Official hosts expose
		// queue occupancy, not individual queue contents.
		if ([...entryMetadata(ctx.sessionManager)].some((entry) => {
			if (!(entry.type === "custom_message" && ["subagent-notify", "intercom_message", "subagent-slash-result"].includes(entry.customType)
				|| entry.type === "message" && entry.message.role === "toolResult" && ["subagent", "delegate", "agent_runs"].includes(entry.message.toolName))) return false;
			return matches(ctx.sessionManager.getEntry(entry.id) ?? entry, runId, key);
		})) return true;
		if (queued.has(key) || run.completion?.id === key && run.completion.state === "queued") {
			// The durable Intercom inbox owns its own queue/restart reconciliation.
			// A remote acknowledgement exposes no parent commit/queue boundary.
			if (run.completion?.channel === "intercom") return true;
			if (!ctx.isIdle() || ctx.hasPendingMessages()) return true;
			queued.delete(key); state.completionSeen.delete(key);
			rememberOwnedRun(state, { ...run, completion: { id: key, state: "dropped" } });
		}
		return false;
	};
	const watcher = createResultWatcher(pi, state, RESULTS_DIR, { reconcileDelivery });
	let unsubscribe: (() => void) | undefined, unsubscribeNotify: (() => void) | undefined;
	const markQueued = (runId: string, key: string, channel: "notification" | "intercom" = "notification") => {
		queued.add(key);
		const run = state.ownedRuns?.get(runId);
		if (run) rememberOwnedRun(state, { ...run, completion: { id: key, state: "queued", channel, queuedAt: Date.now() } });
	};
	const start = () => {
		if (!unsubscribe) {
			unsubscribeNotify = registerSubagentNotify(pi, (key, runId) => { if (runId) markQueued(runId, key); });
			unsubscribe = pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (data) => {
				const result = data as AsyncResultFile & { completionKey?: string; intercomResultDelivered?: boolean; suppressNotification?: boolean };
				const run = state.ownedRuns?.get(result.runId ?? result.id ?? "");
				if (!run || result.sessionId !== state.currentSessionId && run.ownerSessionId !== state.currentSessionId) return;
				if (result.completionKey) {
					if (result.intercomResultDelivered) markQueued(run.runId, result.completionKey, "intercom");
					reconcileDelivery(run.runId, result.completionKey);
				}
				if (result.suppressNotification) recordAccounting(run.runId);
			});
		}
		fs.mkdirSync(RESULTS_DIR, { recursive: true });
		watcher.startResultWatcher(); watcher.primeExistingResults();
	};
	const stop = () => { watcher.stopResultWatcher(); unsubscribe?.(); unsubscribe = undefined; unsubscribeNotify?.(); unsubscribeNotify = undefined; cache = undefined; };
	return { start, stop, holdCheckpoint: watcher.holdCheckpoint };
}
