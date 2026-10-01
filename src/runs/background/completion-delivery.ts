import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext, SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { RESULTS_DIR, SUBAGENT_ASYNC_COMPLETE_EVENT, type AsyncResultFile, type SubagentState } from "../../shared/types.ts";
import { SessionEntryCursor } from "../../shared/session-entries.ts";
import { createParentReceiptReader } from "../shared/parent-receipts.ts";
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
	const indexReceipts = (saved: ReadonlyMap<string, SessionEntry>) => {
		const completed = new Map<string, SessionEntry>(), singles = new Map<string, SessionEntry>();
		const completions = new Map<string, SessionEntry>(), legacy = new Map<string, SessionEntry>();
		for (const entry of saved.values()) {
			const details = entry.type === "message" && entry.message.role === "toolResult" ? entry.message.details
				: entry.type === "custom_message" ? entry.details : undefined;
			const data = details as Record<string, any> | undefined;
			const wait = entry.type === "message" ? data?.wait : data?.result?.details?.wait;
			if (wait?.status === "completed") {
				const target = wait.index === undefined ? completed : wait.index === 0 ? singles : undefined;
				if (target && !target.has(wait.runId)) target.set(wait.runId, entry);
			}
			if (entry.type !== "custom_message") continue;
			const completion = data?.completion ?? data?.subagentCompletion;
			if (!completion?.runId) continue;
			for (const key of [completion.key, completion.completionId && `completion:${completion.completionId}`]) {
				const identity = `${completion.runId}\0${key}`;
				if (key && !completions.has(identity)) completions.set(identity, entry);
			}
			if (!completion.completionId && (completion.ownerSessionId === undefined || completion.ownerSessionId === state.currentSessionId)
				&& !legacy.has(completion.runId)) legacy.set(completion.runId, entry);
		}
		return { saved, completed, singles, completions, legacy };
	};
	let batching = false;
	let snapshot: { manager: ExtensionContext["sessionManager"] | undefined; file: string | undefined; leaf: string | null | undefined; count: number | undefined; index: ReturnType<typeof indexReceipts> } | undefined;
	const readReceipts = () => {
		const manager = state.lastUiContext?.sessionManager, file = manager?.getSessionFile();
		const leaf = manager?.getLeafId?.(), count = (manager as Partial<SessionManager> | undefined)?.getEntryCount?.();
		if (batching && count !== undefined && snapshot && snapshot.manager === manager && snapshot.file === file && snapshot.leaf === leaf && snapshot.count === count) return snapshot.index;
		const index = indexReceipts(publishedReceipts.read(file));
		if (batching) snapshot = { manager, file, leaf, count, index };
		return index;
	};
	const withReceiptBatch = (work: () => void) => {
		// Proof is scoped to this synchronous stack, never async delivery. Every
		// parent append changes count/leaf and forces another SHA-verified read.
		batching = true; snapshot = undefined;
		try { work(); } finally { batching = false; snapshot = undefined; }
	};
	const consumedReceipt = (index: ReturnType<typeof indexReceipts>, runId: string) => index.completed.get(runId)
		?? (state.ownedRuns?.get(runId)?.mode === "single" ? index.singles.get(runId) : undefined);
	const publishedReceipt = (index: ReturnType<typeof indexReceipts>, runId: string, key: string) => consumedReceipt(index, runId)
		?? index.completions.get(`${runId}\0${key}`) ?? (key.startsWith("completion:legacy:") ? index.legacy.get(runId) : undefined);
	const completedCursor = new SessionEntryCursor();
	const receiptEntryIds = new Set<string>();
	const readParentChanges = () => {
		const ctx = state.lastUiContext;
		if (!ctx) return;
		const changes = completedCursor.read(ctx.sessionManager);
		if (changes.reset) receiptEntryIds.clear();
		for (const entry of changes.entries) {
			if (entry.type === "message" && entry.message.role === "toolResult") {
				if (["subagent", "delegate", "agent_runs"].includes(entry.message.toolName)) receiptEntryIds.add(entry.id);
			} else if (entry.type === "custom_message" && ["subagent-notify", "intercom_message", "subagent-slash-result"].includes(entry.customType)) receiptEntryIds.add(entry.id);
		}
	};
	const consumed = (entry: Record<string, any>, runId: string) => {
		const wait = entry.type === "message" ? entry.message?.details?.wait : entry.details?.result?.details?.wait;
		const run = state.ownedRuns?.get(runId);
		return wait?.runId === runId && wait.status === "completed" && (wait.index === undefined || run?.mode === "single" && wait.index === 0);
	};
	state.isRunResultConsumed = (runId) => Boolean(consumedReceipt(readReceipts(), runId));
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
				: { state: parentUsage.isRecorded(finalizedChildUsage(children), ctx, readReceipts().saved) ? "complete" as const : "pending" as const };
			rememberOwnedRun(state, { ...state.ownedRuns!.get(runId)!, accounting });
		} catch (error) {
			try { rememberOwnedRun(state, { ...state.ownedRuns!.get(runId)!, accounting: { state: "incomplete", error: String(error) } }); }
			catch (saveError) { console.error(`Could not save accounting projection for ${runId}:`, saveError); }
			console.error(`Subagent ${runId} accounting remains incomplete:`, error);
		}
	};
	const reconcileDelivery = (runId: string, key: string, accounting = true): boolean => {
		const run = state.ownedRuns?.get(runId);
		const index = readReceipts(), saved = index.saved;
		const receipt = publishedReceipt(index, runId, key);
		if (receipt) {
			queued.delete(key);
			state.completionSeen.delete(key);
			// Save delivery before optional accounting. Even a failed owner append cannot
			// make this published identity eligible for another notification.
			try { if (run) rememberOwnedRun(state, { ...run, completion: { id: key, state: "journaled", entryId: receipt.id },
				delivery: { notifiedAt: Date.parse(receipt.timestamp), intercomDelivered: receipt.type === "custom_message" && receipt.customType === "intercom_message", completionId: key, entryId: receipt.id } }); }
			catch (error) { console.error(`Could not save delivery projection for ${runId}:`, error); }
			if (accounting) recordAccounting(runId);
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
	const watcher = createResultWatcher(pi, state, RESULTS_DIR, { reconcileDelivery, withReceiptBatch,
		isCompletionPublished: (runId, key) => Boolean(publishedReceipt(readReceipts(), runId, key)) });
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
	const stopListening = () => {
		unsubscribe?.(); unsubscribe = undefined; unsubscribeNotify?.(); unsubscribeNotify = undefined;
		publishedReceipts.clear(); completedCursor.reset(); receiptEntryIds.clear();
	};
	const stop = () => { watcher.stopResultWatcher(); stopListening(); };
	const stopAndJoin = async (options: { preservePending?: boolean } = {}) => {
		// Finish accepted delivery while the old owner and its listeners are valid.
		watcher.stopResultWatcher({ ...options, joinInFlight: true });
		await watcher.joinInFlight();
		stopListening();
	};
	return { start, stop, stopAndJoin };
}
