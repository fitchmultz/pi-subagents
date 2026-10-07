import * as fs from "node:fs";
import * as path from "node:path";
import type { ReadonlyDeep } from "type-fest";
import type { ModelAttempt, RunnerSubagentStep } from "../../shared/types.ts";
import type { StructuredOutputRuntime } from "../shared/structured-output.ts";
import { isClaudeCodeModel } from "../shared/claude-code.ts";
import { cleanupTempDir } from "../shared/pi-args.ts";
import {
  evaluateRunAcceptance,
  createFinalizationReportRuntime,
  stripAcceptanceReport,
  type resolveExecutionOutcome,
} from "../shared/acceptance.ts";
import type { StepAttempt } from "./runner-attempt-output.ts";
import type { RunnerAttempt } from "./runner-attempt.ts";

interface FinalizationContext {
  readonly sessionFile?: string;
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly structuredRuntime?: StructuredOutputRuntime;
  readonly modelAttempts: readonly ModelAttempt[];
}

function modelAttempt(result: ReadonlyDeep<StepAttempt>): ModelAttempt {
  return {
    model: result.model ?? "default",
    success:
      result.exitCode === 0 &&
      (result.error === undefined || result.error.length === 0) &&
      result.interrupted !== true,
    exitCode: result.exitCode,
    error: result.error,
    accounting: result.accounting,
    usage: { ...result.usage },
  };
}

/** Owns acceptance review turns and the currently confirmed execution/output state. */
export class RunnerFinalization {
  execution: StepAttempt;
  structuredOutput: unknown;
  resolvedOutput: StepAttempt["resolvedOutput"];
  output: string;
  readonly initialOutput: string;
  readonly modelAttempts: ModelAttempt[];
  private readonly step: RunnerSubagentStep;
  private readonly runner: RunnerAttempt;
  private readonly initial: StepAttempt;
  private readonly context: ReadonlyDeep<FinalizationContext>;
  private readonly nativeReport: boolean;

  constructor(
    step: RunnerSubagentStep,
    runner: RunnerAttempt,
    initial: StepAttempt,
    context: ReadonlyDeep<FinalizationContext>,
  ) {
    this.step = step;
    this.runner = runner;
    this.initial = initial;
    this.context = context;
    this.execution = initial;
    this.structuredOutput = initial.structuredOutput;
    this.resolvedOutput = initial.resolvedOutput;
    this.output = stripAcceptanceReport(this.resolvedOutput.fullOutput);
    this.initialOutput = this.output;
    this.nativeReport =
      initial.model === undefined ||
      initial.model.length === 0 ||
      !isClaudeCodeModel(initial.model);
    this.modelAttempts = [...context.modelAttempts];
    for (const segment of runner.nativeSegments) {
      this.modelAttempts.push(modelAttempt(runner.nativeAttempt(segment)));
    }
  }

  async evaluate(): Promise<Awaited<ReturnType<typeof evaluateRunAcceptance>> | undefined> {
    const acceptance = this.step.effectiveAcceptance;
    if (!acceptance) {
      return;
    }
    return await evaluateRunAcceptance({
      acceptance,
      initial: this.initial,
      initialOutput: this.initial.finalOutput,
      sessionFile: this.context.sessionFile,
      cwd: this.context.cwd,
      signal: this.context.signal,
      nativeReport: this.nativeReport,
      outputSchema: this.context.structuredRuntime?.schema,
      recordedTurns: this.runner.nativeSegments.length,
      initialAcceptance: this.runner.nativeExecution?.finalization?.[0]?.event.acceptance,
      runTurn: (prompt, turn, sessionFile) => this.runTurn(prompt, turn, sessionFile),
    });
  }

  includePreviousFailure(
    outcome: ReadonlyDeep<ReturnType<typeof resolveExecutionOutcome>>,
  ): ReturnType<typeof resolveExecutionOutcome> {
    const previous = this.modelAttempts
      .slice(0, -1)
      .reverse()
      .find((attempt) => attempt.error !== undefined && attempt.error.length > 0)?.error;
    if (
      outcome.exitCode === 0 ||
      outcome.error === undefined ||
      outcome.error.length === 0 ||
      previous === undefined ||
      this.execution.usage.turns !== 0
    ) {
      return outcome;
    }
    const context = `Previous attempt before the empty retry failed with: ${previous}`;
    const error = `${outcome.error}\n${context}`;
    this.output = this.output.length > 0 ? `${this.output}\n${context}` : error;
    return { ...outcome, error };
  }

  private async reviewTurn(
    prompt: string,
    turn: number,
    sessionFile: string,
  ): Promise<
    Readonly<{ reviewed: StepAttempt; cached: ReturnType<RunnerAttempt["nativeSegments"]["at"]> }>
  > {
    const cached = this.runner.nativeSegments.at(turn - 1);
    const reportRuntime =
      cached === undefined && (this.nativeReport || this.context.structuredRuntime !== undefined)
        ? createFinalizationReportRuntime(this.context.structuredRuntime?.schema)
        : undefined;
    try {
      const reviewed = cached
        ? this.runner.nativeAttempt(cached)
        : await this.runner.run(prompt, this.initial.model ?? this.step.model, {
            turn,
            sessionFile,
            previousOutput: this.output,
            reportRuntime,
            outputSnapshot: this.nativeReport ? this.resolvedOutput.writtenSnapshot : undefined,
          });
      return { reviewed, cached };
    } finally {
      if (reportRuntime) {
        cleanupTempDir(path.dirname(reportRuntime.schemaPath));
      }
    }
  }

  private async runTurn(
    prompt: string,
    turn: number,
    sessionFile: string,
  ): Promise<
    Awaited<ReturnType<NonNullable<Parameters<typeof evaluateRunAcceptance>[0]["runTurn"]>>>
  > {
    const { reviewed, cached } = await this.reviewTurn(prompt, turn, sessionFile);
    this.execution = reviewed;
    if (cached === undefined) {
      this.modelAttempts.push(modelAttempt(reviewed));
    }
    if (reviewFailed(reviewed)) {
      return {
        ...reviewed.reportSubmission,
        output: reviewed.finalOutput,
        error:
          reviewed.error ??
          reviewed.resourceLimitExceeded?.message ??
          "Acceptance finalization turn did not complete successfully.",
      };
    }
    if (
      reviewed.reportSubmission?.reportSubmissionError !== undefined &&
      reviewed.reportSubmission.reportSubmissionError.length > 0
    ) {
      return reviewed.reportSubmission;
    }
    this.commitReviewedOutput(reviewed);
    return {
      ...reviewed.reportSubmission,
      output: reviewed.finalOutput,
      acceptance: cached?.event.acceptance,
    };
  }

  private commitReviewedOutput(reviewed: StepAttempt): void {
    const runtime = this.context.structuredRuntime;
    if (runtime && reviewed.reportSubmission?.structuredOutput !== undefined) {
      this.structuredOutput = reviewed.reportSubmission.structuredOutput;
      fs.writeFileSync(runtime.outputPath, JSON.stringify(this.structuredOutput), { mode: 0o600 });
    }
    this.resolvedOutput = reviewed.resolvedOutput;
    this.output = stripAcceptanceReport(this.resolvedOutput.fullOutput);
  }
}

function reviewFailed(reviewed: ReadonlyDeep<StepAttempt>): boolean {
  return (
    reviewed.exitCode !== 0 ||
    (reviewed.error !== undefined && reviewed.error.length > 0) ||
    reviewed.interrupted === true
  );
}
