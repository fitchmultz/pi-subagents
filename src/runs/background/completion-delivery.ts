import * as fs from "node:fs";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { RESULTS_DIR, SUBAGENT_ASYNC_COMPLETE_EVENT, type AsyncResultFile, type SubagentState } from "../../shared/types.ts";
import { SessionEntryCursor } from "../../shared/session-entries.ts";
import { createParentReceiptReader } from "../shared/parent-receipts.ts";
import { nativeInvocationTarget, nativeInvocations } from "../shared/native-async.ts";
import { finalizedChildUsage, type registerParentUsage } from "../shared/parent-usage.ts";
import { ownedRunView, rememberOwnedRun, repairOwnedRunAccounting } from "../shared/run-records.ts";
import registerSubagentNotify, { type SubagentNotifyDetails } from "./notify.ts";
import { createResultWatcher } from "./result-watcher.ts";

/** Completion authority is the published parent receipt, never queue/send acceptance. */
export function createCompletionDelivery(pi: ExtensionAPI, state: SubagentState, parentUsage: ReturnType<typeof registerParentUsage>) {
	type Admission = { sessionId: string | null; pending: boolean; channel: "notification" | "intercom" };
	const store = globalThis as Record<string, unknown>, queueKey = "__pi_subagents_queued_notifications__";
	// Native custom queues survive extension reload, so their admission authority must too.
	const queued = store[queueKey] instanceof Map ? store[queueKey] as Map<string, Admission> : new Map<string, Admission>();
	store[queueKey] = queued;
	pi.on("turn_end", (event, ctx) => {
		const pending = new Set(event.context.pendingMessages.flatMap((message) => {
			const completion = message.role === "custom" && message.customType === "subagent-notify"
				? (message.details as SubagentNotifyDetails)?.completion : undefined;
			return completion ? [completion.key] : [];
		}));
		for (const [key, admission] of queued) {
			if (admission.channel !== "notification" || admission.sessionId !== ctx.sessionManager.getSessionId()) continue;
			admission.pending = pending.has(key);
			if (!admission.pending) {
				queued.delete(key); state.completionSeen.delete(key);
			}
		}
	});
	const publishedReceipts = createParentReceiptReader("live");
	const completedCursor = new SessionEntryCursor();
	const completedCalls = new Set<string>();
	const receiptEntryIds = new Set<string>();
	const readParentChanges = () => {
		const ctx = state.lastUiContext;
		if (!ctx) return;
		const changes = completedCursor.read(ctx.sessionManager);
		if (changes.reset) { completedCalls.clear(); receiptEntryIds.clear(); }
		for (const entry of changes.entries) {
			if (entry.type === "message" && entry.message.role === "toolResult") {
				completedCalls.add(entry.message.toolCallId);
				if (["subagent", "delegate", "agent_runs"].includes(entry.message.toolName)) receiptEntryIds.add(entry.id);
			} else if (entry.type === "custom_message" && ["subagent-notify", "intercom_message", "subagent-slash-result"].includes(entry.customType)) receiptEntryIds.add(entry.id);
		}
	};
	const receipts = () => [...publishedReceipts.read(state.lastUiContext?.sessionManager.getSessionFile()).values()];
	const consumed = (entry: Record<string, any>, runId: string) => {
		const wait = entry.type === "message" ? entry.message?.details?.wait : entry.details?.result?.details?.wait;
		const run = state.ownedRuns?.get(runId);
		return wait?.runId === runId && wait.status === "completed" && (wait.index === undefined || run?.mode === "single" && wait.index === 0);
	};
	state.isRunResultConsumed = (runId) => receipts().some((entry) => consumed(entry, runId));
	state.hasNativeResultOwner = (runId) => {
		const ctx = state.lastUiContext;
		if (!ctx) return false;
		readParentChanges();
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
	const recordAccounting = (runId: string, saved?: ReadonlyMap<string, SessionEntry>) => {
		const run = state.ownedRuns?.get(runId), ctx = state.lastUiContext;
		if (!run || !ctx) return;
		try {
			repairOwnedRunAccounting(run);
			const children = ownedRunView(run, state, { readConfiguration: false }).children;
			const incomplete = children.find((child) => child.result?.accounting?.state === "incomplete");
			const accounting = incomplete ? { state: "incomplete" as const, error: incomplete.result?.accounting?.error }
				: { state: parentUsage.record(finalizedChildUsage(children), ctx, saved) ? "complete" as const : "pending" as const };
			rememberOwnedRun(state, { ...state.ownedRuns!.get(runId)!, accounting });
		} catch (error) {
			try { rememberOwnedRun(state, { ...state.ownedRuns!.get(runId)!, accounting: { state: "incomplete", error: String(error) } }); }
			catch (saveError) { console.error(`Could not save accounting projection for ${runId}:`, saveError); }
			console.error(`Subagent ${runId} accounting remains incomplete:`, error);
		}
	};
	const reconcileDelivery = (runId: string, key: string, accounting = true): boolean => {
		const run = state.ownedRuns?.get(runId);
		const saved = publishedReceipts.read(state.lastUiContext?.sessionManager.getSessionFile());
		const receipt = [...saved.values()].find((entry) => matches(entry, runId, key));
		if (receipt) {
			queued.delete(key);
			state.completionSeen.delete(key);
			// Save delivery before optional accounting. Even a failed owner append cannot
			// make this published identity eligible for another notification.
			try { if (run) rememberOwnedRun(state, { ...run, completion: { id: key, state: "journaled", entryId: receipt.id },
				delivery: { notifiedAt: Date.parse(receipt.timestamp), intercomDelivered: receipt.type === "custom_message" && receipt.customType === "intercom_message", completionId: key, entryId: receipt.id } }); }
			catch (error) { console.error(`Could not save delivery projection for ${runId}:`, error); }
			if (accounting) recordAccounting(runId, saved);
			return true;
		}
		const ctx = state.lastUiContext;
		if (!ctx) return true;
		// An accepted but unflushed receipt or a native pending queue is ambiguous:
		// keep pending rather than enqueueing a second copy. Official hosts expose
		// queue occupancy, not individual queue contents.
		readParentChanges();
		if ([...receiptEntryIds].some((id) => {
			if (saved.has(id)) return false; // Published candidates were checked above.
			const entry = ctx.sessionManager.getEntry(id);
			return entry !== undefined && matches(entry, runId, key);
		})) {
			queued.delete(key); state.completionSeen.delete(key);
			return true;
		}
		if (queued.has(key) || run?.completion?.id === key && run.completion.state === "queued") {
			// The durable Intercom inbox owns its own queue/restart reconciliation.
			// A remote acknowledgement exposes no parent commit/queue boundary.
			if (run?.completion?.channel === "intercom") return true;
			// Settlement after abort need not drain the custom queue. Its actual
			// turn boundary remains authoritative when coarse occupancy says idle.
			if (queued.get(key)?.pending || !ctx.isIdle() || ctx.hasPendingMessages()) return true;
			queued.delete(key); state.completionSeen.delete(key);
			if (run) rememberOwnedRun(state, { ...run, completion: { id: key, state: "dropped" } });
		}
		return false;
	};
	const watcher = createResultWatcher(pi, state, RESULTS_DIR, { reconcileDelivery });
	let unsubscribe: (() => void) | undefined, unsubscribeNotify: (() => void) | undefined;
	const markQueued = (runId: string, key: string, channel: "notification" | "intercom" = "notification") => {
		const run = state.ownedRuns?.get(runId);
		queued.set(key, { sessionId: state.currentSessionId, pending: false, channel });
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
	const stop = () => {
		watcher.stopResultWatcher(); unsubscribe?.(); unsubscribe = undefined; unsubscribeNotify?.(); unsubscribeNotify = undefined;
		publishedReceipts.clear(); completedCursor.reset(); completedCalls.clear(); receiptEntryIds.clear();
	};
	return { start, stop, holdCheckpoint: watcher.holdCheckpoint };
}
