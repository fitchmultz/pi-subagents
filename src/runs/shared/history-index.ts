import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SubagentHistoryIndex } from "../../history/index.ts";
import type { OwnedRun, SubagentState } from "../../shared/types.ts";
import { getAgentDir } from "../../shared/utils.ts";

export function closeRunHistory(state: SubagentState): Promise<void> {
	const index = state.historyIndex;
	state.historyIndex = undefined;
	state.historyReady = undefined;
	state.historyClosing = Promise.all([state.historyClosing, index?.close()]).then(() => {});
	return state.historyClosing;
}

function admitOwner(state: SubagentState, ownerSessionId: string, ownerSessionFile?: string): SubagentHistoryIndex {
	const index = state.historyIndex = new SubagentHistoryIndex(getAgentDir());
	const snapshot = { ownerSessionId, ownerSessionFile,
		runs: [...(state.ownedRuns?.values() ?? [])], foregroundRuns: [...(state.foregroundRuns?.values() ?? [])] };
	state.historyReady = (state.historyClosing ?? Promise.resolve()).then(() => index.setOwner(snapshot));
	index.onChanged(() => { if (state.historyIndex === index) state.onRunsChanged?.(); });
	// Retain failed readiness until an explicit retry; background updates must not start a crash loop.
	void state.historyReady.catch(() => {
		if (state.historyIndex === index) void index.close();
	});
	return index;
}

export function startRunHistory(state: SubagentState, ctx: ExtensionContext): void {
	void closeRunHistory(state).catch((error) => console.error("Could not close subagent history:", error));
	// Fresh sessions pay no process/database startup cost until they actually browse or own work.
	if (state.ownedRuns?.size) admitOwner(state, ctx.sessionManager.getSessionId(), ctx.sessionManager.getSessionFile());
}

export function updateRunHistory(state: SubagentState, run: OwnedRun): void {
	const index = state.historyIndex;
	if (!index) return;
	state.historyReady = (state.historyReady ?? Promise.resolve()).then(() => index.updateRun(run, state.foregroundRuns?.get(run.runId)));
	void state.historyReady.catch(() => {
		if (state.historyIndex === index) void index.close();
	});
}

function historyOwner(state: SubagentState): string {
	const current = state.lastUiContext?.sessionManager.getSessionId();
	if (current) return current;
	// Non-UI callers can hold restored owner handles without an ExtensionContext.
	// Never infer ownership from a directory or adopt records found by the index.
	const owners = new Set([...(state.ownedRuns?.values() ?? [])].map((run) => run.ownerSessionId));
	if (owners.size > 1) throw new Error("History requires one verified owning session.");
	const owner = owners.values().next().value ?? state.currentSessionId;
	if (!owner) throw new Error("History requires an active owning session.");
	return owner;
}

export async function runHistoryIndex(state: SubagentState, retry = false): Promise<SubagentHistoryIndex> {
	const ownerSessionId = historyOwner(state);
	if (retry && state.historyIndex?.failure) {
		const closing = closeRunHistory(state);
		await closing;
		if (state.historyClosing !== closing || historyOwner(state) !== ownerSessionId) throw new Error("Owning session changed while history was loading.");
	}
	if (!state.historyIndex) {
		admitOwner(state, ownerSessionId, state.lastUiContext?.sessionManager.getSessionFile());
	}
	const index = state.historyIndex!;
	await state.historyReady;
	if (state.historyIndex !== index || historyOwner(state) !== ownerSessionId) throw new Error("Owning session changed while history was loading.");
	if (index.failure) throw index.failure;
	return index;
}
