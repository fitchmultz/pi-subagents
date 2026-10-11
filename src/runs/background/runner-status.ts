import * as path from "node:path";
import type { ReadonlyDeep } from "type-fest";
import { resolveEffectiveThinking } from "../../shared/model-info.ts";
import type {
  RunnerSubagentStep,
  AsyncStatus,
  ModelAttempt,
  TokenUsage,
} from "../../shared/types.ts";
import type { RunSingleStepResult } from "./runner-contract.ts";

export function pendingRunnerStep(task: ReadonlyDeep<RunnerSubagentStep>): RunnerStatusStep {
  return {
    agent: task.agent,
    phase: task.phase,
    label: task.label,
    outputName: task.outputName,
    structured: task.structured,
    status: "pending",
    ...(task.sessionFile !== undefined && task.sessionFile.length > 0
      ? { sessionFile: task.sessionFile }
      : {}),
    skills: task.skills?.slice(),
    model: task.model,
    thinking: task.thinking,
    attemptedModels: pendingModelCandidates(task),
    recentTools: [],
    recentOutput: [],
  };
}

function pendingModelCandidates(task: ReadonlyDeep<RunnerSubagentStep>): string[] | undefined {
  const candidates = task.modelCandidates;
  if (candidates !== undefined && candidates.length > 0) {
    return [...candidates];
  }
  if (task.model !== undefined && task.model.length > 0) {
    return [task.model];
  }
  return;
}

export function tokenUsageFromAttempts(
  attempts: readonly ReadonlyDeep<ModelAttempt>[] | undefined,
): TokenUsage | null {
  if (!attempts || attempts.length === 0) {
    return null;
  }
  let input = 0;
  let output = 0;
  for (const attempt of attempts) {
    input += attempt.usage?.input ?? 0;
    output += attempt.usage?.output ?? 0;
  }
  const total = input + output;
  return total > 0 ? { input, output, total } : null;
}

export function appendRecentStepOutput(step: RunnerStatusStep, lines: readonly string[]): void {
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  if (nonEmpty.length === 0) {
    return;
  }
  step.recentOutput ??= [];
  step.recentOutput.push(...nonEmpty);
  if (step.recentOutput.length > 50) {
    step.recentOutput.splice(0, step.recentOutput.length - 50);
  }
}

export function clearStepCurrentActivity(step: RunnerStatusStep): void {
  step.currentTool = undefined;
  step.currentToolArgs = undefined;
  step.currentToolStartedAt = undefined;
  step.currentPath = undefined;
}

export function resetStepLiveDetail(step: RunnerStatusStep): void {
  clearStepCurrentActivity(step);
  step.recentTools = [];
  step.recentOutput = [];
}

export function markStepPaused(step: RunnerStatusStep, now: number): void {
  step.status = "paused";
  step.activityState = undefined;
  clearStepCurrentActivity(step);
  step.startedAt ??= now;
  step.endedAt = now;
  step.durationMs = now - step.startedAt;
  step.lastActivityAt = now;
  step.exitCode = 0;
}

export type RunnerStatusStep = Omit<
  NonNullable<AsyncStatus["steps"]>[number],
  "recentTools" | "recentOutput"
> & {
  exitCode?: number | null;
  recentTools?: Array<{ readonly tool: string; readonly args: string; readonly endMs: number }>;
  recentOutput?: string[];
};

export type RunnerStatusPayload = Omit<
  AsyncStatus,
  "steps" | "parallelGroups" | "pid" | "cwd" | "currentStep" | "chainStepCount" | "lastUpdate"
> & {
  pid: number;
  cwd: string;
  currentStep: number;
  chainStepCount: number;
  parallelGroups: Array<{ start: number; count: number; stepIndex: number }>;
  steps: RunnerStatusStep[];
  lastUpdate: number;
  artifactsDir?: string;
  shareUrl?: string;
  gistUrl?: string;
  shareError?: string;
};

export function runnerResultStatus(
  result: ReadonlyDeep<RunSingleStepResult>,
): RunnerStatusStep["status"] {
  if (result.interrupted === true) {
    return "paused";
  }
  if (result.exitCode !== 0) {
    return "failed";
  }
  return result.acceptance?.status === "blocked" ? "blocked" : "complete";
}

export function runnerResultEvent(result: ReadonlyDeep<RunSingleStepResult>): string {
  const status = runnerResultStatus(result);
  return status === "complete" ? "subagent.step.completed" : `subagent.step.${status}`;
}

interface StepStart {
  readonly asyncDir: string;
  readonly sequential?: boolean;
  readonly resetTiming?: boolean;
  readonly index: number;
}

/** Mutates only the live step owned by this status boundary; callers publish after transition. */
export function startRunnerStep(
  statusPayload: RunnerStatusPayload,
  task: ReadonlyDeep<RunnerSubagentStep>,
  input: StepStart,
): number {
  const startedAt = Date.now();
  const step = statusPayload.steps[input.index];
  statusPayload.currentStep = input.index;
  step.status = "running";
  step.activityState = undefined;
  resetStepLiveDetail(step);
  step.startedAt = startedAt;
  if (input.sequential === true) {
    statusPayload.activityState = undefined;
    step.skills = task.skills?.slice();
  } else {
    step.error = undefined;
  }
  if (input.resetTiming === true) {
    step.endedAt = undefined;
    step.durationMs = undefined;
  }
  step.lastActivityAt = startedAt;
  statusPayload.outputFile = path.join(input.asyncDir, `output-${input.index}.log`);
  statusPayload.lastActivityAt = startedAt;
  statusPayload.lastUpdate = startedAt;
  return startedAt;
}

interface StepFinish {
  readonly startedAt: number;
  readonly sequential?: boolean;
  readonly index: number;
}

export function finishRunnerStep(
  statusPayload: RunnerStatusPayload,
  result: ReadonlyDeep<RunSingleStepResult>,
  input: StepFinish,
): number {
  const endedAt = Date.now();
  const step = statusPayload.steps[input.index];
  Object.assign(step, {
    status: runnerResultStatus(result),
    endedAt,
    durationMs: endedAt - input.startedAt,
    exitCode: result.exitCode,
    agentProcessExit: result.agentProcessExit,
    model: result.model,
    thinking: resolveEffectiveThinking(result.model, step.thinking),
    attemptedModels: result.attemptedModels,
    modelAttempts: result.modelAttempts,
    error: result.error,
    structuredOutput: result.structuredOutput,
    structuredOutputPath: result.structuredOutputPath,
    structuredOutputSchemaPath: result.structuredOutputSchemaPath,
    acceptance: result.acceptance,
    resourceLimitExceeded: result.resourceLimitExceeded,
  });
  clearStepCurrentActivity(step);
  const tokens = tokenUsageFromAttempts(result.modelAttempts);
  if (tokens !== null || input.sequential !== true) {
    step.tokens = tokens ?? undefined;
    statusPayload.totalTokens = statusPayload.steps.reduce(
      (total, candidate) => ({
        input: total.input + (candidate.tokens?.input ?? 0),
        output: total.output + (candidate.tokens?.output ?? 0),
        total: total.total + (candidate.tokens?.total ?? 0),
      }),
      { input: 0, output: 0, total: 0 },
    );
  }
  statusPayload.lastUpdate = endedAt;
  return endedAt;
}
