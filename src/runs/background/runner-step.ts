import type { ReadonlyDeep } from "type-fest";
import { findLatestSessionFile } from "../../shared/utils.ts";
import { runModelAttempts, sumAttemptUsage } from "../shared/model-fallback.ts";
import { recordRun } from "../shared/run-history.ts";
import { resolveExecutionOutcome, type evaluateRunAcceptance } from "../shared/acceptance.ts";
import type { RunnerSubagentStep } from "../../shared/types.ts";
import { RunnerAttempt } from "./runner-attempt.ts";
import { RunnerFinalization } from "./runner-finalization.ts";
import type { StepAttempt } from "./runner-attempt-output.ts";
import type { RunSingleStepResult, SingleStepContext } from "./runner-contract.ts";
import { prepareRunnerStep, type PreparedRunnerStep } from "./runner-prepare-step.ts";
import { publishStepOutput, stepOutputFields } from "./runner-step-output.ts";
import { nativeResultFields, saveStepRecord } from "./runner-step-record.ts";

interface StepExecution {
  readonly runner: RunnerAttempt;
  readonly finalization: RunnerFinalization;
  readonly initial: StepAttempt;
  readonly attemptedModels: readonly string[];
  readonly attemptNotes: readonly string[];
  readonly acceptance: Awaited<ReturnType<typeof evaluateRunAcceptance>> | undefined;
  readonly outcome: ReturnType<typeof resolveExecutionOutcome>;
  readonly sessionFile?: string;
}

async function executePreparedStep(
  prepared: PreparedRunnerStep,
  ctx: ReadonlyDeep<SingleStepContext>,
): Promise<StepExecution> {
  const {
    step,
    interruptSignal,
    verificationSignal,
    structuredRuntime,
    sessionDir,
    sessionEnabled,
  } = prepared;
  const runner = new RunnerAttempt(step, ctx, {
    interruptSignal,
    verificationSignal,
    effectiveStructuredOutput: structuredRuntime,
    sessionEnabled,
    sessionDir,
  });
  const candidates = step.modelCandidates;
  const series = await runModelAttempts({
    candidates: candidates !== undefined && candidates.length > 0 ? candidates : [step.model],
    signal: verificationSignal,
    runAttempt: (model) => runner.run(prepared.task, model),
  });
  const sessionFile =
    step.sessionFile ??
    (sessionDir !== undefined && sessionDir.length > 0
      ? (findLatestSessionFile(sessionDir) ?? undefined)
      : undefined);
  const finalization = new RunnerFinalization(step, runner, series.result, {
    sessionFile,
    cwd: step.cwd ?? ctx.cwd,
    signal: verificationSignal,
    structuredRuntime,
    modelAttempts: series.modelAttempts,
  });
  const acceptance = await finalization.evaluate();
  const outcome = finalization.includePreviousFailure(
    resolveExecutionOutcome({
      result: finalization.execution,
      acceptance,
      signal: ctx.signal,
      interruptSignal,
    }),
  );
  return {
    runner,
    finalization,
    initial: series.result,
    attemptedModels: series.attemptedModels,
    attemptNotes: series.notes,
    acceptance,
    outcome,
    sessionFile,
  };
}

/** Runs fallback attempts, acceptance review and output preservation in that order. */
export async function runSingleStep(
  input: RunnerSubagentStep,
  ctx: ReadonlyDeep<SingleStepContext>,
): Promise<RunSingleStepResult> {
  const startedAt = Date.now();
  if (ctx.signal?.aborted === true) {
    return { agent: input.agent, output: "", exitCode: 1, error: "Subagent cancelled." };
  }
  const prepared = prepareRunnerStep(input, ctx);
  const execution = await executePreparedStep(prepared, ctx);
  const { initial, finalization, runner, attemptedModels, outcome, acceptance, sessionFile } =
    execution;
  const { step } = prepared;
  const published = publishStepOutput(step, ctx, {
    output: finalization.output,
    acceptance,
    resolvedOutput: finalization.resolvedOutput,
    outcome,
    attemptNotes: execution.attemptNotes,
  });
  const exitCode = outcome.exitCode ?? 1;
  const usage = sumAttemptUsage(finalization.modelAttempts);
  const progressSummary = {
    toolCount: runner.toolCount,
    tokens: usage.input + usage.output,
    durationMs: Date.now() - startedAt,
  };
  const result: RunSingleStepResult = {
    ...nativeResultFields(finalization.execution, finalization.modelAttempts),
    agent: step.agent,
    output: published.displayOutput,
    exitCode,
    error: outcome.error,
    usage,
    timedOut: outcome.timedOut,
    task: step.task,
    skills: step.skills,
    ...stepOutputFields(step, published, {
      acceptance,
      initialOutput: finalization.initialOutput,
      saveError: finalization.resolvedOutput.saveError,
    }),
    toolCalls: runner.toolCalls.length > 0 ? runner.toolCalls : undefined,
    progressSummary,
    sessionFile,
    intercomTarget: ctx.childIntercomTarget,
    model: initial.model,
    attemptedModels: attemptedModels.length > 0 ? [...attemptedModels] : undefined,
    modelAttempts: finalization.modelAttempts,
    artifactPaths: prepared.artifactPaths,
    interrupted: outcome.interrupted,
    completionGuardTriggered: initial.completionGuardTriggered,
    structuredOutput: finalization.structuredOutput,
    structuredOutputPath: prepared.structuredRuntime?.outputPath,
    structuredOutputSchemaPath: prepared.structuredRuntime?.schemaPath,
    acceptance,
    resourceLimitExceeded: outcome.resourceLimitExceeded,
  };
  recordRun(step.agent, step.task, exitCode, progressSummary.durationMs);
  saveStepRecord(
    result,
    { runId: ctx.id, flatIndex: ctx.flatIndex, task: prepared.task, fullOutput: published.output },
    prepared.artifactPaths,
  );
  return result;
}
