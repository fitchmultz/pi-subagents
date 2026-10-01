import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SubagentHistoryIndex } from "../../history/index.ts";
import type { OwnedRun, SubagentState } from "../../shared/types.ts";
import { getAgentDir } from "../../shared/utils.ts";

export function closeRunHistory(state: SubagentState): Promise<void> {
	const index = state.historyIndex;
	state.historyIndex = undefined;
	state.historyReady = undefined;
	if (index) state.historyClosing = Promise.all([state.historyClosing, index.close()]).then(() => {});
	return state.historyClosing ?? Promise.resolve();
}

function admitOwner(state: SubagentState, ownerSessionId: string, ownerSessionFile?: string): SubagentHistoryIndex {
	const index = state.historyIndex = new SubagentHistoryIndex(getAgentDir());
	const snapshot = { ownerSessionId, ownerSessionFile,
		runs: [...(state.ownedRuns?.values() ?? [])], foregroundRuns: [...(state.foregroundRuns?.values() ?? [])] };
	state.historyReady = (state.historyClosing ?? Promise.resolve()).then(() => index.setOwner(snapshot));
	index.onChanged(() => { if (state.historyIndex === index) state.onRunsChanged?.(); });
	void state.historyReady.catch((error) => {
		if (state.historyIndex !== index) return;
		console.error("Subagent history unavailable:", error);
		void closeRunHistory(state).catch((closeError) => console.error("Could not close subagent history:", closeError));
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
	void state.historyReady.catch((error) => {
		if (state.historyIndex !== index) return;
		console.error("Subagent history update failed:", error);
		void closeRunHistory(state).catch((closeError) => console.error("Could not close subagent history:", closeError));
	});
}

export async function runHistoryIndex(state: SubagentState): Promise<SubagentHistoryIndex> {
	if (!state.historyIndex) {
		// Non-UI callers can hold restored owner handles without an ExtensionContext.
		// Never infer ownership from a directory or adopt records found by the index.
		const owners = new Set([...(state.ownedRuns?.values() ?? [])].map((run) => run.ownerSessionId));
		if (owners.size > 1) throw new Error("History requires one verified owning session.");
		const ownerSessionId = state.lastUiContext?.sessionManager.getSessionId() ?? owners.values().next().value ?? state.currentSessionId;
		if (!ownerSessionId) throw new Error("History requires an active owning session.");
		admitOwner(state, ownerSessionId, state.lastUiContext?.sessionManager.getSessionFile());
	}
	const index = state.historyIndex!;
	await state.historyReady;
	if (state.historyIndex !== index) throw new Error("Owning session changed while history was loading.");
	return index;
}
