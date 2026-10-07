import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SubagentHistoryIndex } from "../../history/index.ts";
import type { HistoryIndexHandle } from "../../shared/types/history.ts";
import type { OwnedRun, SubagentState } from "../../shared/types.ts";
import { getAgentDir } from "../../shared/agent-dir.ts";
import type { OwnedRunReadState } from "./owned-run-read-state.ts";

function reportCloseFailure(error: unknown): void {
  console.error("Could not close subagent history:", error);
}

async function closeOwners(
  previous: Promise<void> | undefined,
  index: HistoryIndexHandle | undefined,
): Promise<void> {
  await Promise.all([previous, index?.close()]);
}

export function closeRunHistory(state: SubagentState): Promise<void> {
  const index = state.historyIndex;
  state.historyIndex = undefined;
  state.historyReady = undefined;
  const closing = closeOwners(state.historyClosing, index);
  state.historyClosing = closing;
  return closing;
}

function observeReadiness(state: SubagentState, index: HistoryIndexHandle): void {
  // Keep the original rejected readiness promise for callers and explicit retry.
  // This observer owns disposal, not a replacement readiness result.
  state.historyReady?.catch(() => {
    if (state.historyIndex === index) {
      index.close().catch(reportCloseFailure);
    }
  });
}

function admitOwner(
  state: SubagentState,
  ownerSessionId: string,
  ownerSessionFile?: string,
): HistoryIndexHandle {
  const index = new SubagentHistoryIndex(getAgentDir());
  state.historyIndex = index;
  const snapshot = {
    ownerSessionId,
    ownerSessionFile,
    runs: [...(state.ownedRuns?.values() ?? [])],
    foregroundRuns: [...(state.foregroundRuns?.values() ?? [])],
  };
  state.historyReady = (state.historyClosing ?? Promise.resolve()).then(() =>
    index.setOwner(snapshot),
  );
  index.onChanged(() => {
    if (state.historyIndex === index) {
      state.onRunsChanged?.();
    }
  });
  observeReadiness(state, index);
  return index;
}

export function startRunHistory(state: SubagentState, ctx: ExtensionContext): void {
  closeRunHistory(state).catch(reportCloseFailure);
  // Fresh sessions pay no process/database startup cost until they browse or own work.
  if ((state.ownedRuns?.size ?? 0) > 0) {
    admitOwner(state, ctx.sessionManager.getSessionId(), ctx.sessionManager.getSessionFile());
  }
}

export function updateRunHistory(state: SubagentState, run: OwnedRun): void {
  const index = state.historyIndex;
  if (!index) {
    return;
  }
  state.historyReady = (state.historyReady ?? Promise.resolve()).then(() =>
    index.updateRun(run, state.foregroundRuns?.get(run.runId)),
  );
  observeReadiness(state, index);
}

type HistoryOwnerState = OwnedRunReadState &
  Readonly<Pick<SubagentState, "lastUiContext" | "currentSessionId">>;

function historyOwner(state: HistoryOwnerState): string {
  const current = state.lastUiContext?.sessionManager.getSessionId();
  if (current !== undefined && current !== "") {
    return current;
  }
  // Non-UI callers hold restored handles; a directory/index record cannot grant ownership.
  const owners = new Set([...(state.ownedRuns?.values() ?? [])].map((run) => run.ownerSessionId));
  if (owners.size > 1) {
    throw new Error("History requires one verified owning session.");
  }
  const owner = owners.values().next().value ?? state.currentSessionId;
  if (owner === null || owner === "") {
    throw new Error("History requires an active owning session.");
  }
  return owner;
}

async function retryFailedOwner(state: SubagentState, ownerSessionId: string): Promise<void> {
  const closing = closeRunHistory(state);
  await closing;
  if (state.historyClosing !== closing || historyOwner(state) !== ownerSessionId) {
    throw new Error("Owning session changed while history was loading.");
  }
}

export async function runHistoryIndex(
  state: SubagentState,
  retry = false,
): Promise<HistoryIndexHandle> {
  const ownerSessionId = historyOwner(state);
  if (retry && state.historyIndex?.failure !== undefined) {
    await retryFailedOwner(state, ownerSessionId);
  }
  const index =
    state.historyIndex ??
    admitOwner(state, ownerSessionId, state.lastUiContext?.sessionManager.getSessionFile());
  await state.historyReady;
  if (state.historyIndex !== index || historyOwner(state) !== ownerSessionId) {
    throw new Error("Owning session changed while history was loading.");
  }
  const failure = index.failure;
  if (failure instanceof Error) {
    throw failure;
  }
  return index;
}
