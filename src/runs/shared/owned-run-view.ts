import * as path from "node:path";
import { listOwnedRunQuestions } from "./supervisor-questions.ts";
import type { ManagementRunState, OwnedRun, OwnedRunView } from "../../shared/types.ts";
import type { OwnedRunReadState } from "./owned-run-read-state.ts";
import { RunObservation, type OwnedRunViewOptions } from "./owned-run-observation.ts";
export { savedWorkflowNodes, type OwnedRunViewOptions } from "./owned-run-observation.ts";

function runAttention(run: OwnedRun, state: ManagementRunState, pendingInput: boolean): string[] {
  return [
    ...(pendingInput ? ["awaiting_input"] : []),
    ...(run.review?.decision === "needs_changes" ? ["needs_changes"] : []),
    ...(run.review?.decision !== "accepted" &&
    ["failed", "blocked", "paused", "unknown"].includes(state)
      ? [state]
      : []),
    ...(state === "completed" && !run.review ? ["unreviewed"] : []),
  ];
}

function continuations(run: OwnedRun, state: OwnedRunReadState): OwnedRunView["continuations"] {
  return [...(state.ownedRuns?.values() ?? [])]
    .filter((candidate) => candidate.rootRunId === run.rootRunId)
    .sort((a, b) => a.startedAt - b.startedAt)
    .flatMap((candidate) =>
      candidate.predecessorRunId !== undefined && candidate.predecessorRunId !== ""
        ? [
            {
              runId: candidate.runId,
              predecessorRunId: candidate.predecessorRunId,
              predecessorIndex: candidate.predecessorIndex,
            },
          ]
        : [],
    );
}

export function ownedRunView(
  requestedRun: OwnedRun,
  state: OwnedRunReadState,
  options: OwnedRunViewOptions = {},
): OwnedRunView {
  const run = state.ownedRuns?.get(requestedRun.runId) ?? requestedRun;
  const observed = new RunObservation(run, state, options);
  const children = observed.indices.map((index) => observed.child(index));
  const live = observed.live(children);
  const error = observed.error();
  const executionState = observed.executionState(children, live, error);
  const pendingInput =
    options.pendingInput ??
    listOwnedRunQuestions(run.ownerSessionId, run.runId).some(
      (question) => question.state === "awaiting_input" || question.state === "answer_pending",
    );
  const resultPath = observed.result ? observed.resultPath : undefined;
  return {
    ...run,
    state: executionState,
    children,
    attention: runAttention(run, executionState, pendingInput),
    canInterrupt: observed.canInterrupt(live, pendingInput),
    updatedAt: observed.updatedAt(),
    continuations: options.includeContinuations === false ? [] : continuations(run, state),
    ...(resultPath !== undefined ? { resultPath } : {}),
    ...(!observed.result && observed.foreground
      ? { resultPath: path.join(observed.root, "foreground.json") }
      : {}),
    diagnosis: observed.diagnosis(executionState, error),
  };
}
