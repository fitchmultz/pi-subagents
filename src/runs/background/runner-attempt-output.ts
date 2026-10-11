import type { ReadonlyDeep } from "type-fest";
import type { ChildAttemptResult, NativeAttemptSegment } from "../shared/child-attempt.ts";
import type { RunnerSubagentStep } from "../../shared/types.ts";
import { detectSubagentError } from "../../shared/utils.ts";
import {
  hasCompletedMutationToolCall,
  resolveCompletionPolicy,
} from "../shared/completion-guard.ts";
import { readStructuredOutput, type StructuredOutputRuntime } from "../shared/structured-output.ts";
import { type captureSingleOutputSnapshot, resolveSingleOutput } from "../shared/single-output.ts";
import {
  readFinalizationReport,
  resolveFinalizationOutput,
  stripAcceptanceReport,
} from "../shared/acceptance.ts";

export type StepAttempt = ReadonlyDeep<
  ChildAttemptResult & {
    readonly completionGuardTriggered?: boolean;
    readonly structuredOutput?: unknown;
    readonly reportSubmission?: ReturnType<typeof readFinalizationReport>;
    readonly resolvedOutput: ReturnType<typeof resolveSingleOutput>;
  }
>;

export interface AttemptReview {
  readonly turn: number;
  readonly sessionFile: string;
  readonly previousOutput: string;
  readonly reportRuntime?: StructuredOutputRuntime;
  readonly outputSnapshot?: ReturnType<typeof captureSingleOutputSnapshot>;
}

interface OutputContext {
  readonly model?: string;
  readonly structuredRuntime?: StructuredOutputRuntime;
  readonly review?: AttemptReview;
  readonly outputSnapshot?: ReturnType<typeof captureSingleOutputSnapshot>;
  readonly initialSegment?: NativeAttemptSegment;
  readonly structuredResult: boolean;
}

export function formatProcessExitFailure(
  input: Readonly<{ agent: string; exitCode: number | null; durationMs?: number }>,
): string {
  const duration = input.durationMs === undefined ? "" : ` after ${input.durationMs}ms`;
  if (input.exitCode === 143) {
    return `${input.agent} exited with code 143${duration}. The child process received SIGTERM or exited as if terminated by SIGTERM; if this was close to 300000ms, Pi's default HTTP idle timeout is a likely provider-side cause.`;
  }
  return `${input.agent} exited with code ${input.exitCode ?? 1}${duration} without producing a final assistant response.`;
}

function processFailure(
  step: ReadonlyDeep<RunnerSubagentStep>,
  run: ReadonlyDeep<ChildAttemptResult>,
): string | undefined {
  if (run.error !== undefined && run.error.length > 0) {
    return run.error;
  }
  if (run.exitCode === 0) {
    return;
  }
  const reason = formatProcessExitFailure({
    agent: step.agent,
    exitCode: run.exitCode,
    durationMs: run.durationMs,
  });
  const stderr = run.stderr.trim();
  return stderr.length === 0 ? reason : `${reason}\n${stderr}`;
}

function hiddenFailure(
  error: ReturnType<typeof detectSubagentError> | undefined,
): string | undefined {
  if (error?.hasError !== true) {
    return;
  }
  return error.details !== undefined && error.details.length > 0
    ? `${error.errorType ?? "Subagent"} failed (exit ${error.exitCode ?? 1}): ${error.details}`
    : `${error.errorType ?? "Subagent"} failed with exit code ${error.exitCode ?? 1}`;
}

function completionGuard(
  step: ReadonlyDeep<RunnerSubagentStep>,
  run: ReadonlyDeep<ChildAttemptResult>,
  review: AttemptReview | undefined,
): boolean {
  return (
    review === undefined &&
    resolveCompletionPolicy({
      completionGuardEnabled: step.completionGuard === true,
      usesAcceptanceContract: step.effectiveAcceptance?.explicit === true,
    }) === "mutation-guard" &&
    !run.observedCompletedMutation &&
    !hasCompletedMutationToolCall(run.messages)
  );
}

function resolveAttemptOutput(
  step: ReadonlyDeep<RunnerSubagentStep>,
  fullOutput: string,
  input: ReadonlyDeep<{
    context: OutputContext;
    run: ChildAttemptResult;
    exitCode: number;
    reportSubmission?: ReturnType<typeof readFinalizationReport>;
  }>,
): ReturnType<typeof resolveSingleOutput> {
  if (input.context.initialSegment) {
    return input.context.initialSegment.event.resolvedOutput;
  }
  if (
    step.outputPath === undefined ||
    step.outputPath.length === 0 ||
    input.exitCode !== 0 ||
    input.run.interrupted === true ||
    (input.reportSubmission?.reportSubmissionError !== undefined &&
      input.reportSubmission.reportSubmissionError.length > 0)
  ) {
    return { fullOutput };
  }
  return resolveSingleOutput(step.outputPath, fullOutput, input.context.outputSnapshot);
}

/** Classifies a completed attempt, validates structured output and publishes its single output. */
export function interpretAttemptOutput(
  step: ReadonlyDeep<RunnerSubagentStep>,
  run: ReadonlyDeep<ChildAttemptResult>,
  context: ReadonlyDeep<OutputContext>,
): StepAttempt {
  const { reportSubmission, hiddenError, structured, successful } = analyzeAttempt(run, context);
  const guardTriggered = successful && completionGuard(step, run, context.review);
  const error = attemptError(step, run, {
    guardTriggered,
    structuredError: structured?.error,
    hiddenError,
  });
  const exitCode = failureExitCode(run.exitCode, {
    guardTriggered,
    structuredError: structured?.error,
    hiddenError,
    error,
  });
  const { finalOutput, fullOutput } = attemptText(run, reportSubmission, context.review);
  const resolvedOutput = resolveAttemptOutput(step, fullOutput, {
    context,
    run,
    exitCode,
    reportSubmission,
  });
  const state = outputState(step, resolvedOutput, error, exitCode);
  return {
    ...run,
    ...state,
    model: context.model ?? run.model,
    structuredOutput: structured?.value,
    reportSubmission,
    finalOutput,
    resolvedOutput,
    completionGuardTriggered: guardTriggered,
    terminalFailure: terminalFailure(
      guardTriggered,
      structured?.error,
      hiddenError,
      resolvedOutput.saveError,
    ),
  };
}

function attemptError(
  step: ReadonlyDeep<RunnerSubagentStep>,
  run: ReadonlyDeep<ChildAttemptResult>,
  input: ReadonlyDeep<{
    guardTriggered: boolean;
    structuredError?: string;
    hiddenError?: ReturnType<typeof detectSubagentError>;
  }>,
): string | undefined {
  if (input.guardTriggered) {
    return "Subagent completed without making edits required by completionGuard: true.\nUse an acceptance contract when a valid no-op is allowed.";
  }
  return input.structuredError ?? hiddenFailure(input.hiddenError) ?? processFailure(step, run);
}

function attemptText(
  run: ReadonlyDeep<ChildAttemptResult>,
  report: ReadonlyDeep<ReturnType<typeof readFinalizationReport>> | undefined,
  review: ReadonlyDeep<AttemptReview> | undefined,
) {
  const finalOutput = report?.output ?? run.finalOutput;
  const fullOutput =
    review === undefined
      ? stripAcceptanceReport(finalOutput)
      : resolveFinalizationOutput(finalOutput, review.previousOutput);
  return { finalOutput, fullOutput };
}

function hiddenAttemptFailure(
  run: ReadonlyDeep<ChildAttemptResult>,
  report: ReadonlyDeep<ReturnType<typeof readFinalizationReport>> | undefined,
) {
  return successfulProcess(run) && (report === undefined || report.output.length === 0)
    ? detectSubagentError(run.messages)
    : undefined;
}

function analyzeAttempt(
  run: ReadonlyDeep<ChildAttemptResult>,
  context: ReadonlyDeep<OutputContext>,
) {
  const reportSubmission = context.review?.reportRuntime
    ? readFinalizationReport(run.messages, context.review.reportRuntime, {
        structuredResult: context.structuredResult,
      })
    : undefined;
  const hiddenError = hiddenAttemptFailure(run, reportSubmission);
  const successful =
    successfulProcess(run) && hiddenError?.hasError !== true && run.interrupted !== true;
  const structured =
    successful && context.review === undefined && context.structuredRuntime
      ? readStructuredOutput(context.structuredRuntime)
      : undefined;
  return { reportSubmission, hiddenError, structured, successful };
}

function successfulProcess(run: ReadonlyDeep<ChildAttemptResult>): boolean {
  return run.exitCode === 0 && (run.error === undefined || run.error.length === 0);
}

function terminalFailure(
  guard: boolean,
  structuredError: string | undefined,
  hiddenError: ReturnType<typeof detectSubagentError> | undefined,
  saveError: string | undefined,
): boolean {
  return (
    guard ||
    (structuredError !== undefined && structuredError.length > 0) ||
    hiddenError?.hasError === true ||
    (saveError !== undefined && saveError.length > 0)
  );
}

function outputState(
  step: ReadonlyDeep<RunnerSubagentStep>,
  resolvedOutput: ReadonlyDeep<ReturnType<typeof resolveSingleOutput>>,
  error: string | undefined,
  exitCode: number,
) {
  if (resolvedOutput.saveError !== undefined && resolvedOutput.saveError.length > 0) {
    return {
      exitCode: 1,
      error: `Failed to save output file '${step.outputPath ?? ""}': ${resolvedOutput.saveError}`,
    };
  }
  return { error, exitCode };
}

function failureExitCode(
  exitCode: number,
  input: ReadonlyDeep<{
    guardTriggered: boolean;
    structuredError?: string;
    hiddenError?: ReturnType<typeof detectSubagentError>;
    error?: string;
  }>,
): number {
  if (
    input.guardTriggered ||
    (input.structuredError !== undefined && input.structuredError.length > 0)
  ) {
    return 1;
  }
  if (input.hiddenError?.hasError === true) {
    return input.hiddenError.exitCode ?? 1;
  }
  if (input.error !== undefined && input.error.length > 0 && exitCode === 0) {
    return 1;
  }
  return exitCode;
}
