import * as fs from "node:fs";
import * as path from "node:path";
import type { ReadonlyDeep } from "type-fest";
import type { ArtifactPaths, RunnerSubagentStep } from "../../shared/types.ts";
import { getArtifactPaths } from "../../shared/artifacts.ts";
import {
  createStructuredOutputRuntime,
  type StructuredOutputRuntime,
} from "../shared/structured-output.ts";
import { formatAcceptancePrompt } from "../shared/acceptance.ts";
import { saveQuestionContract } from "../shared/supervisor-questions.ts";
import type { SingleStepContext } from "./runner-contract.ts";

export interface PreparedRunnerStep {
  readonly step: RunnerSubagentStep;
  readonly task: string;
  readonly artifactPaths?: ArtifactPaths;
  readonly interruptSignal: AbortSignal;
  readonly verificationSignal: AbortSignal;
  readonly structuredRuntime?: StructuredOutputRuntime;
  readonly sessionEnabled: boolean;
  readonly sessionDir?: string;
}

function saveStepContract(step: RunnerSubagentStep, ctx: ReadonlyDeep<SingleStepContext>): void {
  saveQuestionContract(ctx.id, ctx.flatIndex, {
    task: step.task,
    label: step.label,
    effectiveAcceptance: step.effectiveAcceptance,
    output: step.outputPath ?? false,
    outputMode: step.outputMode,
    outputSchema: step.structuredOutputSchema ?? step.structuredOutput?.schema,
    launch: step.launch
      ? {
          ...step.launch,
          cwd: step.cwd ?? ctx.cwd,
          output: step.outputPath ?? false,
          outputMode: step.outputMode ?? "inline",
          outputSchema: step.structuredOutputSchema ?? step.structuredOutput?.schema,
          model: step.model,
          thinking: step.thinking,
        }
      : undefined,
    sessionFile: step.sessionFile,
  });
}

function prepareArtifacts(
  step: RunnerSubagentStep,
  task: string,
  ctx: Readonly<Pick<SingleStepContext, "artifactsDir" | "id" | "flatStepCount" | "flatIndex">>,
): ArtifactPaths | undefined {
  const directory = ctx.artifactsDir;
  if (directory === undefined || directory.length === 0) {
    return;
  }
  const index = ctx.flatStepCount > 1 ? ctx.flatIndex : undefined;
  const paths = getArtifactPaths(directory, ctx.id, step.agent, index);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(paths.inputPath, `# Task for ${step.agent}\n\n${task}`, "utf-8");
  return paths;
}

function continuationStep(
  input: RunnerSubagentStep,
  ctx: Readonly<Pick<SingleStepContext, "nativeFinalization" | "outputFile" | "flatIndex">>,
): RunnerSubagentStep {
  if (ctx.nativeFinalization !== true || input.effectiveAcceptance?.explicit !== true) {
    return input;
  }
  if (input.sessionFile !== undefined && input.sessionFile.length > 0) {
    return input;
  }
  return {
    ...input,
    sessionFile: path.join(path.dirname(ctx.outputFile), `session-${ctx.flatIndex}.jsonl`),
  };
}

function structuredRuntime(
  step: RunnerSubagentStep,
  outputFile: string,
): StructuredOutputRuntime | undefined {
  if (step.structuredOutput) {
    return step.structuredOutput;
  }
  if (step.structuredOutputSchema === undefined) {
    return;
  }
  return createStructuredOutputRuntime(
    step.structuredOutputSchema,
    path.join(path.dirname(outputFile), "structured-output"),
  );
}

/** Establishes continuation persistence, acceptance prompt and owned interrupt signal before execution. */
export function prepareRunnerStep(
  input: RunnerSubagentStep,
  ctx: ReadonlyDeep<SingleStepContext>,
): PreparedRunnerStep {
  const step = continuationStep(input, ctx);
  saveStepContract(step, ctx);
  const interrupt = new AbortController();
  ctx.registerInterrupt?.(() => {
    interrupt.abort();
  });
  const interruptSignal = AbortSignal.any(
    [ctx.interruptSignal, interrupt.signal].filter((signal) => signal !== undefined),
  );
  const verificationSignal = AbortSignal.any(
    [ctx.signal, interruptSignal].filter((signal) => signal !== undefined),
  );
  const runtime = structuredRuntime(step, ctx.outputFile);
  const prompt = step.effectiveAcceptance ? formatAcceptancePrompt(step.effectiveAcceptance) : "";
  const task = prompt.length > 0 ? `${step.task}\n${prompt}` : step.task;
  const artifactPaths = prepareArtifacts(step, task, ctx);
  const hasSession = step.sessionFile !== undefined && step.sessionFile.length > 0;
  return {
    step,
    task,
    artifactPaths,
    interruptSignal,
    verificationSignal,
    structuredRuntime: runtime,
    sessionEnabled: hasSession || ctx.sessionEnabled,
    sessionDir: hasSession ? undefined : ctx.sessionDir,
  };
}
