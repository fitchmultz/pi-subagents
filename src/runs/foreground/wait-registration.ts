import type { SubagentState } from "../../shared/types.ts";

/** Own the waiter count; release the captured map even if session state is replaced. */
export function acquireRunWait(state: SubagentState, runId: string): () => void {
  if (state.waitingRuns === undefined) {
    state.waitingRuns = new Map<string, number>();
  }
  const waiting = state.waitingRuns;
  waiting.set(runId, (waiting.get(runId) ?? 0) + 1);
  return () => {
    const remaining = (waiting.get(runId) ?? 1) - 1;
    if (remaining !== 0) {
      waiting.set(runId, remaining);
    } else {
      waiting.delete(runId);
    }
  };
}
