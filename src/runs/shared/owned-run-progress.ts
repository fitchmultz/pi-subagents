import { getSingleResultOutput, readStatus } from "../../shared/utils.ts";
import { getRunMetadataDir } from "./supervisor-questions.ts";
import type {
  OwnedRun,
  OwnedRunView,
  ReadonlyAgentProgress,
  ReadonlySingleResult,
  ReadonlyAsyncStatus,
  SubagentExecutionResult,
} from "../../shared/types.ts";
import type { OwnedRunReadState } from "./owned-run-read-state.ts";
import { ownedRunView } from "./owned-run-view.ts";
import { workflowDetails } from "./owned-workflow-details.ts";

type ChildView = OwnedRunView["children"][number];
type StatusStep = NonNullable<ReadonlyAsyncStatus["steps"]>[number];

function fallbackStatus(child: ChildView): ReadonlyAgentProgress["status"] {
  if (child.state === "live") {
    return "pending";
  }
  return child.state === "unknown" ? "failed" : child.state;
}

function activity(
  child: ChildView,
  step: StatusStep | undefined,
): Pick<
  ReadonlyAgentProgress,
  | "currentTool"
  | "currentToolArgs"
  | "currentToolStartedAt"
  | "currentPath"
  | "streamingText"
  | "recentTools"
  | "recentOutput"
> {
  if (child.state !== "live" || !step) {
    return { recentTools: [], recentOutput: [] };
  }
  return {
    currentTool: step.currentTool,
    currentToolArgs: step.currentToolArgs,
    currentToolStartedAt: step.currentToolStartedAt,
    currentPath: step.currentPath,
    streamingText: step.streamingText,
    recentTools: step.recentTools?.slice(-10) ?? [],
    recentOutput: step.recentOutput?.slice(-10) ?? [],
  };
}

function progressDuration(step: StatusStep | undefined, startedAt: number): number {
  return step?.durationMs ?? Math.max(0, Date.now() - (step?.startedAt ?? startedAt));
}

function progressCounters(
  step: StatusStep | undefined,
  startedAt: number,
): Pick<ReadonlyAgentProgress, "toolCount" | "turnCount" | "tokens" | "durationMs"> {
  return {
    toolCount: step?.toolCount ?? 0,
    turnCount: step?.turnCount,
    tokens: step?.tokens?.total ?? 0,
    durationMs: progressDuration(step, startedAt),
  };
}

function stepConfiguration(
  step: StatusStep | undefined,
): Pick<
  ReadonlyAgentProgress,
  "model" | "thinking" | "modelStartedAt" | "activityState" | "lastActivityAt" | "skills" | "error"
> {
  return step
    ? {
        model: step.model,
        thinking: step.thinking,
        modelStartedAt: step.modelStartedAt,
        activityState: step.activityState,
        lastActivityAt: step.lastActivityAt,
        skills: step.skills,
        error: step.error,
      }
    : {};
}

function childProgress(
  run: OwnedRun,
  child: ChildView,
  step: StatusStep | undefined,
): ReadonlyAgentProgress {
  return {
    index: child.index,
    agent: child.agent,
    task: child.task ?? run.task,
    status: step?.status ?? fallbackStatus(child),
    ...stepConfiguration(step),
    ...activity(child, step),
    ...progressCounters(step, run.startedAt),
  };
}

function progressUsage(
  item: ReadonlyAgentProgress,
  child: ChildView,
  step: StatusStep | undefined,
): ReadonlySingleResult["usage"] {
  return (
    child.result?.usage ?? {
      input: step?.tokens?.input ?? 0,
      output: step?.tokens?.output ?? 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: item.turnCount ?? 0,
    }
  );
}

function progressResult(
  item: ReadonlyAgentProgress,
  child: ChildView,
  step: StatusStep | undefined,
): ReadonlySingleResult {
  const output = getSingleResultOutput(child.result ?? {});
  const streaming = item.streamingText ?? "";
  const fallback = streaming !== "" ? streaming : item.recentOutput.at(-1);
  return {
    agent: item.agent,
    task: item.task,
    exitCode: child.result?.exitCode ?? 0,
    usage: progressUsage(item, child, step),
    progress: item,
    model: item.model,
    sessionFile: child.sessionFile,
    finalOutput: output !== "" ? output : fallback,
  };
}

function progressLine(item: ReadonlyAgentProgress): string {
  const tool = item.currentTool ?? "";
  const args = item.currentToolArgs ?? "";
  const suffix = tool !== "" ? ` — ${tool}${args !== "" ? ` ${args}` : ""}` : "";
  return `${item.agent}: ${item.status}${suffix}`;
}

/** Project native activity for waiting callers without copying or owning its journal. */
export function ownedRunProgressResult(
  run: OwnedRun,
  state: OwnedRunReadState,
  index?: number,
  view = ownedRunView(run, state, { readConfiguration: false, includeContinuations: false }),
): SubagentExecutionResult {
  const status = readStatus(run.asyncDir ?? getRunMetadataDir(run.runId));
  const children = view.children.filter((child) => index === undefined || child.index === index);
  const progress = children.map((child) => childProgress(run, child, status?.steps?.[child.index]));
  const results = progress.map((item, position) =>
    progressResult(item, children[position], status?.steps?.[item.index]),
  );
  return {
    content: [{ type: "text", text: progress.map(progressLine).join("\n") }],
    details: {
      mode: run.mode,
      runId: run.runId,
      asyncId: run.runId,
      asyncDir: run.asyncDir,
      results,
      progress,
      ...workflowDetails(status?.workflowGraph),
    },
  };
}
