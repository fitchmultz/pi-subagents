import * as fs from "node:fs";
import * as path from "node:path";
import type { ReadonlyDeep } from "type-fest";
import type { AcceptanceLedger } from "../../shared/types.ts";
import {
  cleanupSingleOutputFile,
  finalizeSingleOutput,
  formatConsumedOutputReference,
  formatSavedOutputReference,
  resolveSingleOutput,
} from "../shared/single-output.ts";
import {
  formatUnconfirmedFinalizationOutput,
  resolveExecutionOutcome,
} from "../shared/acceptance.ts";
import type { RunnerSubagentStep } from "../../shared/types.ts";
import type { RunSingleStepResult, SingleStepContext } from "./runner-contract.ts";

interface OutputState {
  readonly output: string;
  readonly acceptance?: AcceptanceLedger;
  readonly resolvedOutput: ReturnType<typeof resolveSingleOutput>;
  readonly outcome: ReturnType<typeof resolveExecutionOutcome>;
  readonly attemptNotes: readonly string[];
}

function decorateOutput(input: ReadonlyDeep<OutputState>): string {
  let output = input.output;
  const { acceptance, resolvedOutput, outcome } = input;
  if (acceptance?.unconfirmedOutput !== undefined) {
    const saved = resolvedOutput.savedPath;
    const auditOutput =
      saved !== undefined && saved.length > 0 && !resolvedOutput.writtenSnapshot
        ? output
        : acceptance.unconfirmedOutput;
    output = formatUnconfirmedFinalizationOutput(auditOutput);
  }
  if (outcome.timedOut === true) {
    const reason = outcome.error ?? "Timed out.";
    const partial = output.trim();
    output =
      partial.length > 0 && partial !== reason
        ? `${reason}\n\nPartial output before timeout:\n${partial}`
        : reason;
  }
  return output;
}

function relocateOutput(
  ctx: ReadonlyDeep<SingleStepContext>,
  savedPath: string | undefined,
  cleanup: ReadonlyDeep<ReturnType<typeof cleanupSingleOutputFile>>,
): string | undefined {
  const worktree = ctx.worktreePath;
  if (
    worktree === undefined ||
    worktree.length === 0 ||
    savedPath === undefined ||
    savedPath.length === 0 ||
    (cleanup !== undefined && cleanup.action !== "skipped")
  ) {
    return savedPath;
  }
  const relative = path.relative(worktree, savedPath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return savedPath;
  }
  const destination = path.join(
    path.dirname(ctx.outputFile),
    "outputs",
    String(ctx.flatIndex),
    path.basename(savedPath),
  );
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(savedPath, destination);
  return destination;
}

function outputReference(
  savedPath: string | undefined,
  output: string,
  cleanup: ReturnType<typeof cleanupSingleOutputFile>,
): ReturnType<typeof formatSavedOutputReference> | undefined {
  if (savedPath === undefined || savedPath.length === 0) {
    return;
  }
  return cleanup
    ? formatConsumedOutputReference(savedPath, output, cleanup)
    : formatSavedOutputReference(savedPath, output);
}

/** Consumes eligible default output or preserves it outside a worktree before that worktree is removed. */
export function publishStepOutput(
  step: ReadonlyDeep<RunnerSubagentStep>,
  ctx: ReadonlyDeep<SingleStepContext>,
  state: ReadonlyDeep<OutputState>,
): Readonly<{
  output: string;
  displayOutput: string;
  savedPath?: string;
  cleanup: ReturnType<typeof cleanupSingleOutputFile>;
  reference: ReturnType<typeof formatSavedOutputReference> | undefined;
}> {
  const output = decorateOutput(state);
  const exitCode = state.outcome.exitCode ?? 1;
  const originalPath = state.resolvedOutput.savedPath;
  const shouldConsume =
    exitCode === 0 &&
    state.outcome.interrupted !== true &&
    originalPath !== undefined &&
    originalPath.length > 0 &&
    step.outputMode !== "file-only" &&
    step.outputPathFromAgentDefault === true;
  const cleanup = shouldConsume
    ? cleanupSingleOutputFile(originalPath, output, undefined)
    : undefined;
  const savedPath = relocateOutput(ctx, originalPath, cleanup);
  const reference = outputReference(savedPath, output, cleanup);
  const displayOutput = finalizeSingleOutput({
    fullOutput:
      state.attemptNotes.length > 0
        ? `${state.attemptNotes.join("\n")}\n\n${output}`.trim()
        : output,
    outputPath: step.outputPath,
    outputMode: step.outputMode,
    exitCode,
    savedPath,
    outputReference: reference,
    saveError: state.resolvedOutput.saveError,
    cleanup,
  }).displayOutput;
  return { output, displayOutput, savedPath, cleanup, reference };
}

export function stepOutputFields(
  step: ReadonlyDeep<RunnerSubagentStep>,
  published: ReadonlyDeep<ReturnType<typeof publishStepOutput>>,
  input: ReadonlyDeep<{ acceptance?: AcceptanceLedger; initialOutput: string; saveError?: string }>,
): Pick<
  RunSingleStepResult,
  | "finalOutput"
  | "initialOutput"
  | "outputMode"
  | "outputReference"
  | "outputCleanup"
  | "outputSaveError"
  | "savedOutputPath"
> {
  const cleanup = published.cleanup;
  return {
    finalOutput: step.outputMode === "file-only" ? published.displayOutput : published.output,
    initialOutput: input.acceptance?.finalization ? input.initialOutput : undefined,
    outputMode: step.outputMode ?? "inline",
    outputReference: published.reference,
    outputCleanup: cleanup,
    outputSaveError: input.saveError,
    savedOutputPath: cleanup && cleanup.action !== "skipped" ? undefined : published.savedPath,
  };
}
