import type { Message } from "@earendil-works/pi-ai";
import type { ReadonlyInput } from "../shared/types/inputs.ts";
import type { ChainStep, SequentialStep } from "../shared/types/workflow.ts";
import { isRecord, isUnknownArray } from "../shared/unknown.ts";
import type { SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import type { SlashSubagentResponse, SlashSubagentUpdate } from "./slash-bridge.ts";
import {
  SLASH_RESULT_TYPE,
  type Details,
  type SingleResult,
  type SubagentExecutionResult,
  type Usage,
} from "../shared/types.ts";

export interface SlashMessageDetails {
  readonly requestId: string;
  readonly result: ReadonlyInput<SubagentExecutionResult>;
}

interface SlashSnapshot {
  readonly result: ReadonlyInput<SubagentExecutionResult>;
  readonly version: number;
}

const liveSnapshots = new Map<string, SlashSnapshot>();
const finalSnapshots = new Map<string, SlashSnapshot>();
let versionCounter = 1;

const EMPTY_MESSAGES: Message[] = [];
const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  turns: 0,
};

function nextVersion(): number {
  return versionCounter++;
}

function cloneUsage(): Usage {
  return { ...EMPTY_USAGE };
}

function createPlaceholderResult(
  agent: string,
  task: string,
  status: "pending" | "running",
  index = 0,
): SingleResult {
  return {
    agent,
    task,
    exitCode: 0,
    messages: EMPTY_MESSAGES,
    usage: cloneUsage(),
    progress: {
      index,
      agent,
      status,
      task,
      recentTools: [],
      recentOutput: [],
      toolCount: 0,
      tokens: 0,
      durationMs: 0,
    },
  };
}

function buildParallelInitialResult(
  params: ReadonlyInput<SubagentParamsLike>,
): SubagentExecutionResult {
  const tasks = params.tasks ?? [];
  return {
    content: [
      { type: "text", text: tasks.map((task) => `${task.agent}: ${task.task}`).join("\n\n") },
    ],
    details: {
      mode: "parallel",
      ...(params.context !== undefined ? { context: params.context } : {}),
      results: tasks.map((task, index) =>
        createPlaceholderResult(task.agent, task.task, "running", index),
      ),
      progress: tasks.map((task, index) => ({
        index,
        agent: task.agent,
        status: "running" as const,
        task: task.task,
        recentTools: [],
        recentOutput: [],
        toolCount: 0,
        tokens: 0,
        durationMs: 0,
      })),
    },
  };
}

function chainTasks(step: ReadonlyInput<ChainStep>): readonly ReadonlyInput<SequentialStep>[] {
  if ("agent" in step) {
    return [step];
  }
  return "expand" in step ? [step.parallel] : step.parallel;
}

function chainStepLabel(step: ReadonlyInput<ChainStep>): string {
  const label = chainTasks(step)
    .map((task) => task.agent)
    .join("+");
  return "parallel" in step ? `[${label}]` : label;
}

function flattenChainResults(
  chain: readonly ReadonlyInput<ChainStep>[],
  fallbackTask: string | undefined,
): SingleResult[] {
  const results: SingleResult[] = [];
  let flatIndex = 0;
  for (const step of chain) {
    for (const task of chainTasks(step)) {
      results.push(
        createPlaceholderResult(
          task.agent,
          task.task ?? fallbackTask ?? "",
          results.length === 0 ? "running" : "pending",
          flatIndex,
        ),
      );
      flatIndex++;
    }
  }
  return results;
}

function buildChainInitialResult(
  params: ReadonlyInput<SubagentParamsLike>,
): SubagentExecutionResult {
  const chain = params.chain ?? [];
  const results = flattenChainResults(chain, params.task);
  return {
    content: [
      {
        type: "text",
        text: results
          .map((result, index) => `Step ${index + 1}: ${result.agent}\n${result.task}`)
          .join("\n\n"),
      },
    ],
    details: {
      mode: "chain",
      ...(params.context !== undefined ? { context: params.context } : {}),
      results,
      progress: results.map((result, index) => ({
        index,
        agent: result.agent,
        status: index === 0 ? ("running" as const) : ("pending" as const),
        task: result.task,
        recentTools: [],
        recentOutput: [],
        toolCount: 0,
        tokens: 0,
        durationMs: 0,
      })),
      chainAgents: chain.map((step) => chainStepLabel(step)),
      totalSteps: chain.length,
      currentStepIndex: 0,
    },
  };
}

function buildSingleInitialResult(
  params: ReadonlyInput<SubagentParamsLike>,
): SubagentExecutionResult {
  const agent = params.agent ?? "subagent";
  const task = params.task ?? "";
  return {
    content: [{ type: "text", text: task }],
    details: {
      mode: "single",
      ...(params.context !== undefined ? { context: params.context } : {}),
      results: [createPlaceholderResult(agent, task, "running")],
      progress: [
        {
          index: 0,
          agent,
          status: "running",
          task,
          recentTools: [],
          recentOutput: [],
          toolCount: 0,
          tokens: 0,
          durationMs: 0,
        },
      ],
    },
  };
}

export function buildSlashInitialResult(
  requestId: string,
  params: ReadonlyInput<SubagentParamsLike>,
): SlashMessageDetails {
  let result: SubagentExecutionResult;
  if ((params.tasks?.length ?? 0) > 0) {
    result = buildParallelInitialResult(params);
  } else if ((params.chain?.length ?? 0) > 0) {
    result = buildChainInitialResult(params);
  } else {
    result = buildSingleInitialResult(params);
  }
  liveSnapshots.set(requestId, { result, version: nextVersion() });
  finalSnapshots.delete(requestId);
  return { requestId, result };
}

function cloneResultsWithProgress(
  results: ReadonlyInput<SingleResult[]>,
  progress: ReadonlyInput<Details["progress"]>,
): ReadonlyInput<SingleResult[]> {
  return results.map((result, index) => {
    const nextProgress =
      progress?.find((entry) => entry.index === index) ?? progress?.[index] ?? result.progress;
    return nextProgress ? Object.assign({}, result, { progress: nextProgress }) : result;
  });
}

export function applySlashUpdate(
  requestId: string,
  update: ReadonlyInput<SlashSubagentUpdate>,
): void {
  const snapshot = liveSnapshots.get(requestId);
  if (!snapshot) {
    return;
  }
  const progress = update.progress;
  if (!progress) {
    return;
  }
  const currentStepIndex = progress.findIndex((entry) => entry.status === "running");
  const nextDetails: ReadonlyInput<Details> = {
    ...snapshot.result.details,
    progress,
    results: cloneResultsWithProgress(snapshot.result.details.results, progress),
    ...(snapshot.result.details.mode === "chain" && currentStepIndex >= 0
      ? { currentStepIndex }
      : {}),
  };
  liveSnapshots.set(requestId, {
    result: {
      ...snapshot.result,
      details: nextDetails,
    },
    version: nextVersion(),
  });
}

export function finalizeSlashResult(
  response: ReadonlyInput<SlashSubagentResponse>,
): SlashMessageDetails {
  const snapshot = {
    result: response.result,
    version: nextVersion(),
  };
  finalSnapshots.set(response.requestId, snapshot);
  liveSnapshots.delete(response.requestId);
  return {
    requestId: response.requestId,
    result: response.result,
  };
}

export function failSlashResult(
  requestId: string,
  params: ReadonlyInput<SubagentParamsLike>,
  message: string,
): SlashMessageDetails {
  const initial = buildSlashInitialResult(requestId, params).result;
  const failedResults = initial.details.results.map((result) => ({
    ...result,
    exitCode: 1,
    error: message,
    progress: result.progress ? { ...result.progress, status: "failed" as const } : result.progress,
  }));
  const result: ReadonlyInput<SubagentExecutionResult> = {
    content: [{ type: "text", text: message }],
    details: {
      ...initial.details,
      results: failedResults,
      progress: failedResults.flatMap((entry) => (entry.progress ? [entry.progress] : [])),
    },
  };
  const snapshot = { result, version: nextVersion() };
  finalSnapshots.set(requestId, snapshot);
  liveSnapshots.delete(requestId);
  return { requestId, result };
}

function isSlashMessageDetails(value: unknown): value is SlashMessageDetails {
  if (!isRecord(value)) {
    return false;
  }
  const v = value;
  if (typeof v.requestId !== "string" || v.requestId.length === 0) {
    return false;
  }
  if (!isRecord(v.result) || !isUnknownArray(v.result.content)) {
    return false;
  }
  return isRecord(v.result.details) && isUnknownArray(v.result.details.results);
}

export function resolveSlashMessageDetails(value: unknown): SlashMessageDetails | undefined {
  return isSlashMessageDetails(value) ? value : undefined;
}

export function getSlashRenderableSnapshot(
  details: ReadonlyInput<SlashMessageDetails>,
): SlashSnapshot {
  return (
    finalSnapshots.get(details.requestId) ??
    liveSnapshots.get(details.requestId) ?? { result: details.result, version: 0 }
  );
}

export function restoreSlashFinalSnapshots(entries: readonly unknown[]): void {
  liveSnapshots.clear();
  finalSnapshots.clear();
  for (const entry of entries) {
    if (!isRecord(entry)) {
      continue;
    }
    const e = entry;
    if (e.type !== "custom_message" || e.customType !== SLASH_RESULT_TYPE) {
      continue;
    }
    const details = resolveSlashMessageDetails(e.details);
    if (!details) {
      continue;
    }
    finalSnapshots.set(details.requestId, { result: details.result, version: nextVersion() });
  }
}

export function clearSlashSnapshots(): void {
  liveSnapshots.clear();
  finalSnapshots.clear();
}
