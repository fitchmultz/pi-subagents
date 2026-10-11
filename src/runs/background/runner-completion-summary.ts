import type { ReadonlyDeep } from "type-fest";
import {
  type AsyncResultFile,
  type MaxOutputConfig,
  type SubagentRunMode,
  truncateOutput,
} from "../../shared/types.ts";
import { acceptanceHumanAction } from "../shared/acceptance.ts";
import { appendWorktreeSummary } from "../shared/worktree.ts";
import type { StepResult } from "./runner-contract.ts";

function childText(result: ReadonlyDeep<StepResult>): string {
  if (
    result.error !== undefined &&
    result.error.length > 0 &&
    !result.output.includes(result.error)
  ) {
    return `${result.error}\n${result.output}`.trim();
  }
  return result.output;
}

export function runLabel(mode: SubagentRunMode): string {
  if (mode === "parallel") {
    return "Parallel run";
  }
  return mode === "chain" ? "Chain" : "Run";
}

export function completionSummary(
  input: ReadonlyDeep<{
    mode: SubagentRunMode;
    results: readonly StepResult[];
    error?: string;
    timedOut?: boolean;
    worktreeSummaries: readonly string[];
  }>,
): string {
  const onlyResult = input.results.at(0);
  let summary =
    input.mode === "single" && input.results.length === 1 && onlyResult !== undefined
      ? childText(onlyResult)
      : input.results.map((result) => `${result.agent}:\n${childText(result)}`).join("\n\n");
  if (input.error !== undefined && input.error.length > 0 && !summary.includes(input.error)) {
    summary = `${input.error}\n\n${summary}`.trim();
  }
  if (input.timedOut === true) {
    summary = [`${runLabel(input.mode)} timed out.`, summary]
      .filter((line) => line.length > 0)
      .join("\n\n");
  }
  if (input.worktreeSummaries.length > 0) {
    summary = appendWorktreeSummary(summary, input.worktreeSummaries.join("\n\n"));
  }
  return summary;
}

export function truncateStepResult(
  result: ReadonlyDeep<StepResult>,
  limits: ReadonlyDeep<Required<MaxOutputConfig>>,
): NonNullable<AsyncResultFile["results"]>[number] {
  const outputPath = result.artifactPaths?.outputPath;
  const reference =
    result.outputMode === "file-only" && result.exitCode === 0 ? result.outputReference : undefined;
  const childOutput =
    reference !== undefined
      ? { text: reference.message, truncated: false }
      : truncateOutput(result.output, limits, outputPath);
  let finalOutput = result.finalOutput;
  if (reference !== undefined) {
    finalOutput = reference.message;
  } else if (finalOutput !== undefined) {
    finalOutput = truncateOutput(finalOutput, limits, outputPath).text;
  }
  const initialOutput =
    result.initialOutput === undefined
      ? undefined
      : truncateOutput(result.initialOutput, limits, outputPath).text;
  return Object.assign({}, result, {
    output: childOutput.text,
    finalOutput,
    initialOutput,
    truncated: result.truncated === true || childOutput.truncated ? true : undefined,
  });
}

export function terminalSummary(
  input: ReadonlyDeep<{
    state: AsyncResultFile["state"];
    results: readonly StepResult[];
    summary: string;
    setupCleanupWarning: string;
  }>,
): string {
  if (input.state === "blocked") {
    const actions = input.results
      .map((result) => acceptanceHumanAction(result.acceptance))
      .filter((action) => action !== undefined && action.length > 0);
    return `Needs your action — acceptance incomplete.\n${actions.join("\n")}`;
  }
  if (input.state === "paused") {
    const warning = input.setupCleanupWarning.length > 0 ? `\n\n${input.setupCleanupWarning}` : "";
    return `Paused after interrupt. Waiting for explicit next action.${warning}`;
  }
  return input.summary;
}
