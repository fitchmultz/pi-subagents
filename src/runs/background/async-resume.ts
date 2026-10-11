import * as fs from "node:fs";
import * as path from "node:path";
import {
  ASYNC_DIR,
  RESULTS_DIR,
  type AsyncStatus,
  type ResolvedAcceptanceConfig,
  type SupervisorRunContract,
} from "../../shared/types.ts";
import type { ReadonlyInput } from "../../shared/types/inputs.ts";
import { resolveSubagentIntercomTarget } from "../../intercom/intercom-bridge.ts";
import { checkPidLiveness, reconcileAsyncRun } from "./stale-run-reconciler.ts";
import { readAsyncResultFile, type ParsedAsyncResultFile } from "./async-result-file.ts";
import { readQuestionContract } from "../shared/supervisor-questions.ts";
import { resolveAsyncRunLocation, type AsyncResumeParams } from "./async-run-location.ts";
import type { AsyncRunLocation } from "./async-run-record.ts";
import { hasText, isRecord } from "./async-value.ts";

export type { AsyncResumeParams } from "./async-run-location.ts";
export type { AsyncRunLocation, AsyncRunRecord } from "./async-run-record.ts";
export {
  asyncRunRoots,
  exactAsyncRunLocation,
  readAsyncRunRecord,
  findAsyncRunPrefixMatches,
  resolveAsyncRunLocation,
} from "./async-run-location.ts";

export interface AsyncResumeDeps {
  readonly asyncDirRoot?: string;
  readonly resultsDir?: string;
  readonly kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
  readonly now?: () => number;
}
export interface AsyncResumeTarget {
  readonly kind: "live" | "revive";
  readonly runId: string;
  readonly asyncDir?: string;
  readonly state: AsyncStatus["state"];
  readonly agent: string;
  readonly index: number;
  readonly intercomTarget: string;
  readonly cwd?: string;
  readonly sessionFile?: string;
  readonly effectiveAcceptance?: ResolvedAcceptanceConfig;
}

function optionalStrings(value: unknown, fields: readonly string[], source: string): void {
  if (!isRecord(value)) {
    throw new Error(`Invalid async status '${source}': expected an object.`);
  }
  for (const field of fields) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      throw new Error(`Invalid async status '${source}': ${field} must be a string.`);
    }
  }
}

function validateStatusForResume(value: unknown, source: string): void {
  if (value === null) {
    return;
  }
  if (!isRecord(value) || typeof value.runId !== "string") {
    throw new Error(`Invalid async status '${source}': runId must be a string.`);
  }
  optionalStrings(value, ["sessionId", "cwd", "sessionFile"], source);
  if (value.steps === undefined) {
    return;
  }
  if (!Array.isArray(value.steps)) {
    throw new Error(`Invalid async status '${source}': steps must be an array.`);
  }
  const steps: readonly unknown[] = value.steps;
  steps.forEach((step, index) => {
    if (!isRecord(step)) {
      throw new Error(`Invalid async status '${source}': steps[${index}] must be an object.`);
    }
    if (typeof step.agent !== "string") {
      throw new Error(`Invalid async status '${source}': steps[${index}].agent must be a string.`);
    }
    if (step.sessionFile !== undefined && typeof step.sessionFile !== "string") {
      throw new Error(
        `Invalid async status '${source}': steps[${index}].sessionFile must be a string.`,
      );
    }
  });
}

function validateResultRecord(value: unknown, resultPath: string, prefix = ""): void {
  if (!isRecord(value)) {
    throw new Error(`Invalid async result file '${resultPath}': expected an object.`);
  }
  const fields =
    prefix.length > 0
      ? ["agent", "sessionFile", "intercomTarget"]
      : ["id", "runId", "agent", "mode", "state", "cwd", "sessionFile"];
  for (const field of fields) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      throw new Error(
        `Invalid async result file '${resultPath}': ${prefix}${field} must be a string.`,
      );
    }
  }
  if (value.success !== undefined && typeof value.success !== "boolean") {
    throw new Error(
      `Invalid async result file '${resultPath}': ${prefix}success must be a boolean.`,
    );
  }
}

function readResultFile(file: string): ParsedAsyncResultFile {
  const data = readAsyncResultFile(file);
  data.results?.forEach((child, index) => validateResultRecord(child, file, `results[${index}].`));
  validateResultRecord(data, file);
  return data;
}

interface ResumeEvidence {
  readonly location: AsyncRunLocation;
  readonly status: ReadonlyInput<AsyncStatus> | null;
  readonly result?: ReadonlyInput<ParsedAsyncResultFile>;
  readonly runId: string;
  readonly state: AsyncStatus["state"];
  readonly stepCount: number;
  readonly steps: ReadonlyInput<NonNullable<AsyncStatus["steps"]>>;
  readonly resultSteps: ReadonlyInput<NonNullable<ParsedAsyncResultFile["results"]>>;
}

function childEvidence(
  status: ReadonlyInput<AsyncStatus> | null,
  result: ReadonlyInput<ParsedAsyncResultFile> | undefined,
): Pick<ResumeEvidence, "steps" | "resultSteps" | "stepCount"> {
  const steps = status?.steps ?? [];
  const resultSteps = result?.results ?? [];
  const count = steps.length > 0 ? steps.length : resultSteps.length;
  return { steps, resultSteps, stepCount: count > 0 ? count : Number(hasText(result?.agent)) };
}

function persistedRunId(
  location: AsyncRunLocation,
  status: ReadonlyInput<AsyncStatus> | null,
  result: ReadonlyInput<ParsedAsyncResultFile> | undefined,
): string {
  const fallback = location.asyncDir === null ? "unknown" : path.basename(location.asyncDir);
  return status?.runId ?? result?.runId ?? result?.id ?? location.resolvedId ?? fallback;
}

function resumeIdentity(
  location: AsyncRunLocation,
  status: ReadonlyInput<AsyncStatus> | null,
  result: ReadonlyInput<ParsedAsyncResultFile> | undefined,
): Pick<ResumeEvidence, "runId" | "state"> {
  const runId = persistedRunId(location, status, result);
  const state = status?.state ?? result?.terminalState;
  if (state === undefined) {
    throw new Error(`Status file not found for async run '${runId}'.`);
  }
  return { runId, state };
}

function readEvidence(
  params: ReadonlyInput<AsyncResumeParams>,
  deps: AsyncResumeDeps,
): ResumeEvidence {
  const resultsDir = deps.resultsDir ?? RESULTS_DIR;
  const location = resolveAsyncRunLocation(params, deps.asyncDirRoot ?? ASYNC_DIR, resultsDir);
  if (location.asyncDir === null && location.resultPath === null) {
    throw new Error("Async run not found. Provide id or dir.");
  }
  const status =
    location.asyncDir === null
      ? null
      : reconcileAsyncRun(location.asyncDir, { resultsDir, kill: deps.kill, now: deps.now }).status;
  validateStatusForResume(
    status,
    location.asyncDir === null ? "status.json" : path.join(location.asyncDir, "status.json"),
  );
  const result = location.resultPath === null ? undefined : readResultFile(location.resultPath);
  return {
    location,
    status,
    result,
    ...resumeIdentity(location, status, result),
    ...childEvidence(status, result),
  };
}

function assertIndex(evidence: ReadonlyInput<ResumeEvidence>, index: number): void {
  if (!Number.isInteger(index)) {
    throw new Error(`Async run '${evidence.runId}' index must be an integer.`);
  }
  if (index < 0 || index >= evidence.stepCount) {
    throw new Error(
      `Async run '${evidence.runId}' has ${evidence.stepCount} children. Index ${index} is out of range.`,
    );
  }
}

function baseTarget(
  evidence: ReadonlyInput<ResumeEvidence>,
  agent: string,
  index: number,
): Omit<AsyncResumeTarget, "kind"> {
  return {
    runId: evidence.runId,
    asyncDir: evidence.location.asyncDir ?? undefined,
    state: evidence.state,
    agent,
    index,
    intercomTarget: resolveSubagentIntercomTarget(evidence.runId, agent, index),
    cwd: evidence.status?.cwd ?? evidence.result?.cwd,
  };
}

function liveIndex(evidence: ReadonlyInput<ResumeEvidence>, requested: number | undefined): number {
  if (requested !== undefined) {
    return requested;
  }
  const running = evidence.steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.status === "running");
  const selected = running.at(0);
  if (running.length !== 1 || selected === undefined) {
    throw new Error(
      `Async run '${evidence.runId}' has ${running.length} running children. Provide index to choose one.`,
    );
  }
  return selected.index;
}

function liveTarget(
  evidence: ReadonlyInput<ResumeEvidence>,
  requestedIndex: number | undefined,
): AsyncResumeTarget | undefined {
  if (evidence.state !== "running") {
    return undefined;
  }
  const steps = evidence.steps;
  const index = liveIndex(evidence, requestedIndex);
  assertIndex(evidence, index);
  const step = steps.at(index);
  if (step?.status === "running") {
    return {
      ...baseTarget(evidence, step.agent, index),
      kind: "live",
      sessionFile: childSession(evidence, index),
    };
  }
  if (step?.status === "pending") {
    throw new Error(
      `Async run '${evidence.runId}' child ${index} is pending and has not started yet. Wait for it to run or complete before resuming.`,
    );
  }
  if (step && !["complete", "completed", "failed", "blocked", "paused"].includes(step.status)) {
    throw new Error(
      `Async run '${evidence.runId}' child ${index} is ${step.status} and cannot be revived yet.`,
    );
  }
  return undefined;
}

function validateResumeSessionFile(runId: string, sessionFile: string): string {
  if (path.extname(sessionFile) !== ".jsonl") {
    throw new Error(`Async run '${runId}' session file must be a .jsonl file: ${sessionFile}`);
  }
  const resolved = path.resolve(sessionFile);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Async run '${runId}' session file does not exist: ${sessionFile}`);
  }
  return resolved;
}

function childAgent(
  evidence: ReadonlyInput<ResumeEvidence>,
  index: number,
  fallback?: string,
): string | undefined {
  return (
    evidence.steps.at(index)?.agent ??
    evidence.resultSteps.at(index)?.agent ??
    evidence.result?.agent ??
    fallback
  );
}

function childSession(evidence: ReadonlyInput<ResumeEvidence>, index: number): string | undefined {
  const fallback =
    evidence.stepCount === 1
      ? (evidence.status?.sessionFile ?? evidence.result?.sessionFile)
      : undefined;
  return (
    evidence.steps.at(index)?.sessionFile ?? evidence.resultSteps.at(index)?.sessionFile ?? fallback
  );
}

function childAcceptance(
  evidence: ReadonlyInput<ResumeEvidence>,
  index: number,
): ResolvedAcceptanceConfig | undefined {
  return (
    evidence.steps.at(index)?.acceptance?.effectiveAcceptance ??
    evidence.resultSteps.at(index)?.acceptance?.effectiveAcceptance
  );
}

function contractIsLive(
  contract: ReadonlyInput<SupervisorRunContract> | undefined,
  kill: AsyncResumeDeps["kill"],
): boolean {
  const pid = contract?.pid;
  return pid !== undefined && pid !== 0 && checkPidLiveness(pid, kill) !== "dead";
}

function revivalTarget(
  evidence: ReadonlyInput<ResumeEvidence>,
  index: number,
  deps: AsyncResumeDeps,
): AsyncResumeTarget {
  const contract = readQuestionContract(evidence.runId, index);
  const live = contractIsLive(contract, deps.kill);
  const agent = childAgent(evidence, index, live ? contract?.launch?.agent.name : undefined);
  if (!hasText(agent)) {
    throw new Error(`Could not determine child agent for async run '${evidence.runId}'.`);
  }
  const base = baseTarget(evidence, agent, index);
  if (live) {
    return { ...base, kind: "live", sessionFile: contract?.sessionFile };
  }
  const sessionFile = childSession(evidence, index);
  if (!hasText(sessionFile)) {
    throw new Error(
      `Async run '${evidence.runId}' child ${index} does not have a persisted session file to resume from.`,
    );
  }
  return {
    ...base,
    kind: "revive",
    sessionFile: validateResumeSessionFile(evidence.runId, sessionFile),
    effectiveAcceptance: childAcceptance(evidence, index),
  };
}

export function resolveAsyncResumeTarget(
  params: ReadonlyInput<AsyncResumeParams>,
  deps: AsyncResumeDeps = {},
): AsyncResumeTarget {
  const evidence = readEvidence(params, deps);
  if (params.index !== undefined && !Number.isInteger(params.index)) {
    throw new Error(`Async run '${evidence.runId}' index must be an integer.`);
  }
  const live = liveTarget(evidence, params.index);
  if (live) {
    return live;
  }
  if (evidence.stepCount > 1 && params.index === undefined) {
    throw new Error(
      `Async run '${evidence.runId}' has ${evidence.stepCount} children. Provide index to choose one.`,
    );
  }
  const index = params.index ?? 0;
  assertIndex(evidence, index);
  return revivalTarget(evidence, index, deps);
}

export function buildRevivedAsyncTask(
  target: Readonly<Pick<AsyncResumeTarget, "runId" | "agent" | "sessionFile">>,
  message: string,
  origin?: "human",
): string {
  return [
    "You are reviving a previous subagent conversation.",
    "",
    `Original run: ${target.runId}`,
    `Original agent: ${target.agent}`,
    hasText(target.sessionFile) ? `Original session file: ${target.sessionFile}` : undefined,
    "",
    origin === "human"
      ? "Use the stored session context as background. This is a direct user follow-up (human origin); respond in this conversation where the user can see it. Do not relay it to the parent."
      : "Use the stored session context as background. Answer the orchestrator's follow-up below. Do not assume the original child process is still alive.",
    "",
    "Follow-up:",
    message,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}
