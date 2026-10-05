import type { ForegroundResumeRun, OwnedRun, SubagentState } from "../../shared/types.ts";

/** Explicit state-management boundary: these operations alone publish owner maps. */
export function resetOwnedRuns(state: SubagentState): void {
  state.ownedRuns = new Map();
}

export function setOwnedRun(state: SubagentState, run: OwnedRun): OwnedRun | undefined {
  const previous = state.ownedRuns?.get(run.runId);
  (state.ownedRuns ??= new Map()).set(run.runId, {
    ...run,
    children: run.children.map((child) => ({ ...child })),
  });
  return previous;
}

export function setForegroundRun(state: SubagentState, run: ForegroundResumeRun): void {
  (state.foregroundRuns ??= new Map()).set(run.runId, run);
}

/** Restoration owns notification suspension; the returned release restores the same hook. */
export function suspendRunChanges(state: SubagentState): () => void {
  const onRunsChanged = state.onRunsChanged;
  state.onRunsChanged = undefined;
  return () => {
    state.onRunsChanged = onRunsChanged;
  };
}
