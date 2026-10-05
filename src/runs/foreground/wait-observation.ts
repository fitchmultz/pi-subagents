import * as path from "node:path";
import { ownedRunStatusResult, ownedRunView, resolveOwnedRun } from "../shared/run-records.ts";
import {
  getRunMetadataDir,
  listOwnedRunQuestions,
  questionProcessAlive,
  readRunJson,
} from "../shared/supervisor-questions.ts";
import { getSingleResultOutput, readStatus } from "../../shared/utils.ts";
import { isRecord } from "../../shared/unknown.ts";
import type {
  OwnedRun,
  OwnedRunView,
  ReadonlySubagentState,
  SubagentExecutionResult,
  SupervisorQuestionView,
} from "../../shared/types.ts";
import { resolveSubagentRunId } from "../background/run-id-resolver.ts";
import { resolveNestedAsyncDir } from "../shared/nested-events.ts";
import { nestedResolutionScopeForExecutor } from "./execution-routing.ts";
import type { ExecutorReadDeps } from "./subagent-params.ts";

/** Small projections deliberately consume unknown JSON, not asserted persisted contracts. */
export function savedRunString(runId: string, file: string, field: string): string | undefined {
  const saved = readRunJson(path.join(getRunMetadataDir(runId), file));
  return isRecord(saved) && typeof saved[field] === "string" ? saved[field] : undefined;
}

export function resolveWaitTarget(
  id: string,
  deps: ExecutorReadDeps,
): { readonly run?: OwnedRun; readonly nested: boolean } {
  const run = resolveOwnedRun(deps.state, id);
  return run ? { run, nested: false } : resolveNestedWaitTarget(id, deps);
}

function resolveNestedWaitTarget(
  id: string,
  deps: ExecutorReadDeps,
): { readonly run?: OwnedRun; readonly nested: boolean } {
  const resolved = resolveSubagentRunId(id, {
    state: deps.state,
    nested: nestedResolutionScopeForExecutor(deps),
  });
  if (resolved?.kind !== "nested") {
    return { nested: false };
  }
  const asyncDir = resolveNestedAsyncDir(resolved.match.rootRunId, resolved.match.run);
  const status = asyncDir === undefined ? null : readStatus(asyncDir);
  if (status?.runId !== resolved.id) {
    return { nested: false };
  }
  // Read only through the authorized route: never adopt or account a descendant here.
  return {
    nested: true,
    run: {
      runId: resolved.id,
      rootRunId: resolved.match.rootRunId,
      ownerSessionId:
        savedRunString(resolved.id, "question-owner.json", "sessionId") ?? status.sessionId ?? "",
      source: "async",
      mode: status.mode,
      cwd: status.cwd ?? "",
      task: "Nested delegated run",
      startedAt: status.startedAt,
      asyncDir,
      pid: status.pid,
      children: (status.steps ?? []).map((step, childIndex) => ({
        agent: step.agent,
        index: childIndex,
        sessionFile: step.sessionFile,
      })),
    },
  };
}

type WaitChildren = OwnedRunView["children"];
export interface WaitObservation {
  readonly view: OwnedRunView;
  readonly children: WaitChildren;
  readonly questions: readonly SupervisorQuestionView[];
}

export function observeWait(
  run: OwnedRun,
  state: ReadonlySubagentState,
  owner: string,
  index?: number,
): WaitObservation {
  const runQuestions = listOwnedRunQuestions(run.ownerSessionId, run.runId);
  // Exactly one fresh view per poll; transcripts and unrelated questions stay outside the hot path.
  const view = ownedRunView(run, state, {
    pendingInput: runQuestions.some(
      (question) => question.state === "awaiting_input" || question.state === "answer_pending",
    ),
    readConfiguration: false,
    includeContinuations: false,
  });
  return {
    view,
    children: view.children.filter((child) => index === undefined || child.index === index),
    questions: runQuestions.filter(
      (question) =>
        question.ownerSessionId === owner &&
        (index === undefined || question.index === index) &&
        question.state === "awaiting_input",
    ),
  };
}

export function waitHasSavedResult(observation: WaitObservation, index?: number): boolean {
  const { view, children } = observation;
  return (
    (index !== undefined || (view.resultPath !== undefined && view.resultPath.length > 0)) &&
    children.every(
      (child) => child.result !== undefined && child.state !== "live" && child.state !== "unknown",
    ) &&
    (index !== undefined || view.state !== "live")
  );
}

export function waitProducerAlive(run: OwnedRun, children: WaitChildren): boolean {
  const pid =
    run.pid ??
    (run.asyncDir !== undefined && run.asyncDir.length > 0
      ? readStatus(run.asyncDir)?.pid
      : undefined);
  return pid !== undefined && pid !== 0
    ? questionProcessAlive({ pid })
    : children.some((child) => child.state === "live");
}

function childSavedOutput(child: WaitChildren[number]): string {
  const output = child.result === undefined ? "" : getSingleResultOutput(child.result);
  const text = output.length > 0 ? output : child.result?.error;
  return `\n${child.agent}: ${child.state}\n${text !== undefined && text.length > 0 ? text : "(no output)"}`;
}

export function savedWaitResult(
  run: OwnedRun,
  state: ReadonlySubagentState,
  observation: WaitObservation,
  index?: number,
): { readonly result: SubagentExecutionResult; readonly text: string } {
  const { view, children } = observation;
  const result = ownedRunStatusResult(run, state);
  const isError =
    children.some((child) => child.state === "failed") ||
    (index === undefined && view.state === "failed") ||
    undefined;
  const selectedState = index === undefined ? view.state : children[0]?.state;
  return {
    result: { ...result, isError },
    text: [
      `Saved result for ${run.runId}${index !== undefined ? ` child ${index}` : ""}: ${selectedState}`,
      ...children.map(childSavedOutput),
      result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"),
    ].join("\n"),
  };
}
