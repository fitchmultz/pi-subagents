import * as fs from "node:fs";
import * as path from "node:path";
import { resolveSubagentRunId } from "../background/run-id-resolver.ts";
import {
  getRunMetadataDir,
  questionProcessAlive,
  recordQuestionDelivery,
  type SupervisorQuestionView,
} from "../shared/supervisor-questions.ts";
import {
  ASYNC_DIR,
  getAsyncConfigPath,
  RUNNER_ERROR_LOG_FILE,
  type ReadonlyInput,
  type SubagentExecutionResult,
} from "../../shared/types.ts";
import { nestedResolutionScopeForExecutor } from "./execution-routing.ts";
import { reviveSavedSubagent, type RevivalInput } from "./saved-revival.ts";
import type { ExecutorReadDeps, SubagentParamsLike } from "./subagent-params.ts";

type SavedQuestion = ReadonlyInput<SupervisorQuestionView>;
function asyncLocationExists(location: {
  readonly resultPath: string | null;
  readonly asyncDir: string | null;
}): boolean {
  if (location.resultPath !== null && location.resultPath.length > 0) {
    return true;
  }
  return (
    location.asyncDir !== null &&
    location.asyncDir.length > 0 &&
    fs.existsSync(path.join(location.asyncDir, "status.json"))
  );
}
function priorRevivalExists(question: SavedQuestion, deps: ExecutorReadDeps): boolean {
  const revival = question.revival;
  if (!revival) {
    return false;
  }
  const prior = resolveSubagentRunId(revival.runId, {
    state: deps.state,
    nested: nestedResolutionScopeForExecutor(deps),
  });
  const saved = prior?.kind === "async" ? asyncLocationExists(prior.location) : prior !== undefined;
  return (
    questionProcessAlive(revival) ||
    saved ||
    fs.existsSync(getAsyncConfigPath(revival.runId)) ||
    fs.existsSync(path.join(getRunMetadataDir(revival.runId), "launch.json")) ||
    fs.existsSync(path.join(ASYNC_DIR, revival.runId, RUNNER_ERROR_LOG_FILE))
  );
}
function assertContinuable(question: SavedQuestion, deps: ExecutorReadDeps): void {
  if (questionProcessAlive(question)) {
    throw new Error(
      "The question's child is still alive. Answer the question or stop it before continuing.",
    );
  }
  if (question.delivery?.kind === "revive") {
    throw new Error(`Use continue with the answer's continuation run ${question.delivery.runId}.`);
  }
  if (priorRevivalExists(question, deps)) {
    throw new Error(
      `Continuation ${question.revival?.runId ?? "unknown"} may already have launched. Inspect or continue that run; the original question was not restarted.`,
    );
  }
}
function continuationMessage(params: SubagentParamsLike, question: SavedQuestion): string {
  const answer = question.answer
    ? `Saved supervisor answer:\n${question.answer.message}\n\nOriginal question:\n${question.message}`
    : undefined;
  return [params.message ?? params.task, answer]
    .filter((part) => part !== undefined && part.length > 0)
    .join("\n\n");
}
function recordSuccessfulDelivery(question: SavedQuestion, result: SubagentExecutionResult): void {
  if (result.isError === true || !question.answer || question.delivery) {
    return;
  }
  const id = result.details.asyncId ?? result.details.managementControl?.runId;
  if (id === undefined) {
    throw new Error("Continuation launch did not publish a run identity.");
  }
  recordQuestionDelivery(question, { kind: "revive", runId: id, deliveredAt: Date.now() });
}
/** Recover a dead question waiter without relaunching a live child or a previously claimed continuation. */
export function continueQuestionSession(
  // The question's session owner launches its continuation and records the resulting durable delivery.
  input: RevivalInput,
  questions: readonly SavedQuestion[],
): SubagentExecutionResult {
  if (
    input.params.index === undefined &&
    new Set(questions.map((question) => question.index)).size > 1
  ) {
    throw new Error("Provide index to choose which child question to continue.");
  }
  const question = questions.findLast(
    (entry) => input.params.index === undefined || entry.index === input.params.index,
  );
  if (!question) {
    throw new Error("No saved question for that child index.");
  }
  assertContinuable(question, input.deps);
  const message = continuationMessage(input.params, question);
  const result = reviveSavedSubagent(
    { ...input, params: { ...input.params, message } },
    { ...question, source: "question" },
  );
  recordSuccessfulDelivery(question, result);
  return result;
}
