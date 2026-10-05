import type { ReadonlyInput } from "../../shared/types.ts";
import type { ChildAttemptOptions, ChildAttemptResult } from "./child-attempt-types.ts";
import { readFinalizationReport } from "./acceptance.ts";
import { readStructuredOutput } from "./structured-output.ts";
import { nonempty } from "./child-json.ts";

interface OutcomeInput {
  readonly result: ReadonlyInput<ChildAttemptResult>;
  readonly options: ReadonlyInput<ChildAttemptOptions>;
  readonly code: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly spawnError?: Readonly<Error>;
  readonly stopping: boolean;
  readonly settledCleanup: boolean;
  readonly cleanAssistantStop: boolean;
  readonly assistantError?: string;
}

function processExitCode(input: OutcomeInput, drainedSuccess: boolean): number {
  const result = input.result;
  if (result.timedOut === true) {
    return 124;
  }
  if (result.resourceLimitExceeded || result.terminalFailure === true) {
    return 1;
  }
  if (result.interrupted === true || drainedSuccess) {
    return 0;
  }
  return input.code ?? (input.stopping || nonempty(input.signal) ? 1 : 0);
}

function completedOutput(input: OutcomeInput): { completed: boolean; report: boolean } {
  const runtime = input.options.nativeFinalization?.reportRuntime ?? input.options.reportRuntime;
  const report = runtime
    ? readFinalizationReport([...input.result.messages], runtime).output
    : undefined;
  const structured = input.options.structuredOutput
    ? readStructuredOutput(input.options.structuredOutput)
    : undefined;
  return {
    completed:
      input.cleanAssistantStop ||
      nonempty(report) ||
      (structured !== undefined && !nonempty(structured.error)),
    report: nonempty(report),
  };
}

function drainedNativeSuccess(
  input: OutcomeInput,
  report: boolean,
  error: string | undefined,
): boolean {
  return input.settledCleanup && (input.cleanAssistantStop || report) && !nonempty(error);
}
function processDiagnostic(code: number | null, stderr: string): string | undefined {
  const diagnostics = stderr.trim();
  if (code === 143) {
    // Keep startup diagnostics without hiding the terminated process's actual exit status.
    return `Child process exited with code 143.${diagnostics.length > 0 ? `\n${diagnostics}` : ""}`;
  }
  return diagnostics.length > 0 ? diagnostics : undefined;
}
function executionError(
  input: OutcomeInput,
  report: boolean,
): { error?: string; drainedSuccess: boolean } {
  let error =
    input.result.error ?? (report ? undefined : input.assistantError) ?? input.spawnError?.message;
  const drainedSuccess = drainedNativeSuccess(input, report, error);
  if (
    input.code !== 0 &&
    !nonempty(error) &&
    !drainedSuccess &&
    input.result.interrupted !== true
  ) {
    error = processDiagnostic(input.code, input.result.stderr);
  }
  return { error, drainedSuccess };
}

/** Keep process cleanup distinct from completed native work and owner interruption. */
export function childExecutionOutcome(
  input: OutcomeInput,
): Pick<ChildAttemptResult, "error" | "exitCode" | "terminalFailure"> {
  const completion = completedOutput(input);
  const { error, drainedSuccess } = executionError(input, completion.report);
  const exitCode = processExitCode(input, drainedSuccess);
  if (input.result.interrupted === true) {
    return { error: undefined, exitCode, terminalFailure: input.result.terminalFailure };
  }
  if (exitCode === 0 && !nonempty(error) && !completion.completed) {
    return {
      error: input.options.nativeFinalization
        ? "Native self-review boundary did not return a result."
        : "Child exit was observed, but no completed assistant result was returned.",
      exitCode: 1,
      terminalFailure: true,
    };
  }
  return { error, exitCode, terminalFailure: input.result.terminalFailure };
}
