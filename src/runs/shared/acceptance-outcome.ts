import type { AcceptanceLedger, ReadonlyInput } from "../../shared/types.ts";
import type { AttemptOutcome } from "./model-fallback.ts";
import { acceptanceFailureMessage } from "./acceptance-evaluation.ts";
import { isFailFastAbort } from "./parallel-utils.ts";

export type ExecutionOutcome = ReadonlyInput<
  Pick<AttemptOutcome, "exitCode" | "error" | "interrupted" | "timedOut" | "resourceLimitExceeded">
>;
interface OutcomeInput {
  readonly result: ExecutionOutcome;
  readonly acceptance?: AcceptanceLedger;
  readonly signal?: AbortSignal;
  readonly interruptSignal?: AbortSignal;
}

function cancellationOutcome(input: OutcomeInput): ExecutionOutcome | undefined {
  const { signal, result } = input;
  if (signal?.aborted === true) {
    const reason: unknown = signal.reason;
    if (reason instanceof Error && reason.name === "TimeoutError") {
      return {
        ...result,
        exitCode: 124,
        timedOut: true,
        interrupted: false,
        error: reason.message.length > 0 ? reason.message : "Subagent timed out.",
      };
    }
    return { ...result, exitCode: 1, interrupted: false, error: "Subagent cancelled." };
  }
  if (isFailFastAbort(input.interruptSignal)) {
    return { ...result, exitCode: -1, interrupted: false, error: "Interrupted due to fail-fast" };
  }
  return undefined;
}

function executionStopOutcome(input: OutcomeInput): ExecutionOutcome | undefined {
  const { result } = input;
  if (result.timedOut === true || result.resourceLimitExceeded) {
    return {
      ...result,
      exitCode: result.timedOut === true ? 124 : 1,
      interrupted: result.interrupted === undefined ? undefined : false,
    };
  }
  if (input.interruptSignal?.aborted === true || result.interrupted === true) {
    return { ...result, exitCode: 0, interrupted: true, error: undefined };
  }
  return undefined;
}

function configuredAcceptanceFailure(acceptance: AcceptanceLedger | undefined): string | undefined {
  return acceptance?.explicit === true ? acceptanceFailureMessage(acceptance) : undefined;
}

/** Cancellation and resource limits outrank interruption; acceptance only rejects successful execution. */
export function resolveExecutionOutcome(input: OutcomeInput): ExecutionOutcome {
  const stopped = cancellationOutcome(input) ?? executionStopOutcome(input);
  if (stopped) {
    return stopped;
  }
  const { result } = input;
  const failure = configuredAcceptanceFailure(input.acceptance);
  if (failure !== undefined && failure.length > 0 && result.exitCode === 0) {
    const error = (result.error ?? "").length > 0 ? `${result.error ?? ""}\n${failure}` : failure;
    return { ...result, exitCode: 1, error };
  }
  return result;
}
