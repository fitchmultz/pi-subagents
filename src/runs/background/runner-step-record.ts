import * as fs from "node:fs";
import type { ReadonlyDeep } from "type-fest";
import type { ArtifactPaths, ModelAttempt } from "../../shared/types.ts";
import { saveQuestionContract } from "../shared/supervisor-questions.ts";
import type { RunSingleStepResult } from "./runner-contract.ts";
import type { StepAttempt } from "./runner-attempt-output.ts";

export function nativeResultFields(
  execution: ReadonlyDeep<StepAttempt>,
  attempts: readonly ReadonlyDeep<ModelAttempt>[],
): Pick<
  RunSingleStepResult,
  | "accounting"
  | "nativeSessionId"
  | "terminalLeafId"
  | "terminalEntryId"
  | "auditPath"
  | "auditSaveError"
  | "agentProcessExit"
> {
  return {
    accounting:
      attempts.find((attempt) => attempt.accounting?.state === "incomplete")?.accounting ??
      execution.accounting,
    nativeSessionId: execution.nativeSessionId,
    terminalLeafId: execution.terminalLeafId,
    terminalEntryId: execution.terminalEntryId,
    auditPath: execution.auditPath,
    auditSaveError: execution.auditSaveError,
    agentProcessExit: execution.agentProcessExit,
  };
}

/** Publishes immutable completed-step evidence after output preservation is finished. */
export function saveStepRecord(
  result: ReadonlyDeep<RunSingleStepResult>,
  input: Readonly<{ runId: string; flatIndex: number; task: string; fullOutput: string }>,
  paths: Readonly<ArtifactPaths> | undefined,
): void {
  if (result.task === undefined || result.usage === undefined) {
    throw new Error("Completed step evidence requires task and usage.");
  }
  if (paths) {
    fs.writeFileSync(paths.outputPath, input.fullOutput, "utf-8");
    fs.writeFileSync(
      paths.metadataPath,
      JSON.stringify(
        {
          runId: input.runId,
          agent: result.agent,
          task: input.task,
          exitCode: result.exitCode,
          interrupted: result.interrupted,
          agentProcessExit: result.agentProcessExit,
          error: result.error,
          acceptance: result.acceptance,
          initialOutput: result.initialOutput,
          usage: result.usage,
          model: result.model,
          attemptedModels: result.attemptedModels,
          modelAttempts: result.modelAttempts,
          resourceLimitExceeded: result.resourceLimitExceeded,
          skills: result.skills,
          timestamp: Date.now(),
        },
        null,
        2,
      ),
      "utf-8",
    );
  }
  saveQuestionContract(input.runId, input.flatIndex, {
    result: { ...result, task: result.task, usage: result.usage, finalOutput: result.finalOutput },
    updatedAt: Date.now(),
  });
}
