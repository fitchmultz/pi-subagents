import * as fs from "node:fs";
import * as path from "node:path";
import { compactForegroundResult, getSingleResultOutput, readStatus } from "../../shared/utils.ts";
import { readAsyncResultFile } from "../background/async-result-file.ts";
import { exactAsyncRunLocation } from "../background/async-resume.ts";
import { getRunMetadataDir } from "./supervisor-questions.ts";
import {
  ASYNC_DIR,
  DEFAULT_MAX_OUTPUT,
  RESULTS_DIR,
  truncateOutput,
  type AgentProgress,
  type Details,
  type OwnedRun,
  type SingleResult,
  type SubagentExecutionResult,
  type SubagentState,
  type WorkflowGraphSnapshot,
} from "../../shared/types.ts";
import { repairOwnedRunAccounting } from "./run-persistence.ts";
import type { OwnedRunReadState } from "./owned-run-read-state.ts";
import { ownedRunView } from "./owned-run-view.ts";

function workflowDetails(
  graph: WorkflowGraphSnapshot | undefined,
): Pick<Details, "workflowGraph" | "chainAgents" | "totalSteps" | "currentStepIndex"> {
  if (!graph) {
    return {};
  }
  if (graph.mode !== "chain") {
    return { workflowGraph: graph };
  }
  const current = graph.nodes.find(
    (node) =>
      node.id === graph.currentNodeId ||
      node.children?.some((child) => child.id === graph.currentNodeId),
  );
  return {
    workflowGraph: graph,
    chainAgents: graph.nodes.map((node) => node.agent ?? node.label),
    totalSteps: graph.nodes.length,
    ...(current?.stepIndex !== undefined ? { currentStepIndex: current.stepIndex } : {}),
  };
}

export function ownedRunExecutionResult(
  run: OwnedRun,
  state: OwnedRunReadState,
  index?: number,
  includeProgress = false,
): SubagentExecutionResult {
  try {
    repairOwnedRunAccounting(run);
  } catch (error) {
    console.error(`Native accounting for ${run.runId} remains incomplete:`, error);
  }
  const view = ownedRunView(run, state);
  const location = exactAsyncRunLocation(run.runId, ASYNC_DIR, RESULTS_DIR);
  const saved = location.resultPath ? readAsyncResultFile(location.resultPath) : undefined;
  const limits = {
    ...DEFAULT_MAX_OUTPUT,
    ...(saved?.maxOutput ?? view.children[0]?.launch?.maxOutput),
  };
  const children = view.children.filter((child) => index === undefined || child.index === index);
  const projected = view.children.map((child) => {
    if (!child.result) {
      return { ...child, result: undefined };
    }
    const { artifactPaths, ...result } = child.result;
    const finalOutput = getSingleResultOutput(result);
    const truncation =
      result.outputMode === "file-only" && result.exitCode === 0 && result.outputReference
        ? { text: result.outputReference.message, truncated: false }
        : truncateOutput(finalOutput, limits, artifactPaths?.outputPath);
    const compacted = compactForegroundResult({
      ...result,
      finalOutput: truncation.text,
      ...(truncation.truncated ? { truncation } : {}),
      ...(result.initialOutput
        ? {
            initialOutput: truncateOutput(result.initialOutput, limits, artifactPaths?.outputPath)
              .text,
          }
        : {}),
    });
    return { ...child, result: { ...compacted, ...(artifactPaths ? { artifactPaths } : {}) } };
  });
  const results: SingleResult[] = projected
    .filter((child) => index === undefined || child.index === index)
    .flatMap((child) => {
      if (!child.result) {
        return [];
      }
      const { artifactPaths, ...result } = child.result;
      return [
        {
          ...result,
          ...(artifactPaths?.inputPath && artifactPaths.outputPath && artifactPaths.metadataPath
            ? {
                artifactPaths: {
                  inputPath: artifactPaths.inputPath,
                  outputPath: artifactPaths.outputPath,
                  metadataPath: artifactPaths.metadataPath,
                },
              }
            : {}),
        },
      ];
    });
  let text =
    (index === undefined ? saved?.summary : undefined) ||
    [
      ...children.map((child) =>
        child.result ? getSingleResultOutput(child.result) || child.result.error : undefined,
      ),
      view.diagnosis,
    ]
      .filter(Boolean)
      .join("\n\n");
  const failed =
    index === undefined
      ? ["failed", "unknown"].includes(view.state)
      : children.length === 0 ||
        children.some((child) => ["failed", "unknown"].includes(child.state));
  if (failed && saved?.error && !text.includes(saved.error)) {
    text = `${saved.error}\n\n${text}`;
  }
  const logPath = path.join(
    location.asyncDir ?? run.asyncDir ?? getRunMetadataDir(run.runId),
    `subagent-log-${run.runId}.md`,
  );
  const artifactPath =
    run.mode === "single"
      ? results[0]?.artifactPaths?.outputPath
      : fs.existsSync(logPath)
        ? logPath
        : undefined;
  const referenceOnly =
    view.state === "completed" &&
    run.mode === "single" &&
    results.length === 1 &&
    results[0]?.outputMode === "file-only" &&
    results[0].outputReference;
  const truncation = referenceOnly
    ? { text: referenceOnly.message, truncated: false }
    : view.state === "blocked"
      ? { text, truncated: false }
      : truncateOutput(text, limits, artifactPath);
  const files = results.flatMap((result) => (result.artifactPaths ? [result.artifactPaths] : []));
  const progressSummary = {
    toolCount: results.reduce(
      (total, result) => total + (result.progressSummary?.toolCount ?? 0),
      0,
    ),
    tokens: results.reduce((total, result) => total + (result.progressSummary?.tokens ?? 0), 0),
    durationMs:
      saved?.durationMs ??
      Math.max(0, ...results.map((result) => result.progressSummary?.durationMs ?? 0)),
  };
  const share = saved?.shareUrl
    ? `Session: ${saved.shareUrl}`
    : saved?.shareError
      ? `Session share error: ${saved.shareError}`
      : undefined;
  const identity = run.predecessorRunId
    ? `Run: ${run.runId}\nPredecessor: ${run.predecessorRunId} (child ${run.predecessorIndex ?? 0})`
    : undefined;
  return {
    content: [
      {
        type: "text",
        text: [identity, truncation.text || `Run ${run.runId}: ${view.state}.`, share]
          .filter(Boolean)
          .join("\n\n"),
      },
    ],
    ...(failed ? { isError: true } : {}),
    details: {
      mode: run.mode,
      runId: run.runId,
      asyncId: run.runId,
      asyncDir: location.asyncDir ?? run.asyncDir,
      results,
      run: { ...view, children: projected },
      progressSummary,
      ...(includeProgress
        ? { progress: ownedRunProgressResult(run, state, index).details.progress }
        : {}),
      ...(saved?.shareUrl ? { shareUrl: saved.shareUrl } : {}),
      ...(saved?.gistUrl ? { gistUrl: saved.gistUrl } : {}),
      ...(saved?.shareError ? { shareError: saved.shareError } : {}),
      ...(files.length
        ? { artifacts: { dir: saved?.artifactsDir ?? path.dirname(files[0].outputPath), files } }
        : {}),
      ...(truncation.truncated ? { truncation } : {}),
      ...(saved?.outputs ? { outputs: saved.outputs } : {}),
      ...workflowDetails(saved?.workflowGraph),
    },
  };
}

/** Project the run owner's native activity for waiting callers without copying its journal. */
export function ownedRunProgressResult(
  run: OwnedRun,
  state: OwnedRunReadState,
  index?: number,
  view = ownedRunView(run, state, { readConfiguration: false, includeContinuations: false }),
): SubagentExecutionResult {
  const status = readStatus(run.asyncDir ?? getRunMetadataDir(run.runId));
  const children = view.children.filter((child) => index === undefined || child.index === index);
  const progress: AgentProgress[] = children.map((child) => {
    const step = status?.steps?.[child.index];
    const live = child.state === "live";
    return {
      index: child.index,
      agent: child.agent,
      task: child.task ?? run.task,
      status:
        step?.status ??
        (child.state === "live" ? "pending" : child.state === "unknown" ? "failed" : child.state),
      model: step?.model,
      thinking: step?.thinking,
      modelStartedAt: step?.modelStartedAt,
      activityState: step?.activityState,
      lastActivityAt: step?.lastActivityAt,
      skills: step?.skills,
      ...(live
        ? {
            currentTool: step?.currentTool,
            currentToolArgs: step?.currentToolArgs,
            currentToolStartedAt: step?.currentToolStartedAt,
            currentPath: step?.currentPath,
            streamingText: step?.streamingText,
          }
        : {}),
      recentTools: live ? (step?.recentTools?.slice(-10) ?? []) : [],
      recentOutput: live ? (step?.recentOutput?.slice(-10) ?? []) : [],
      toolCount: step?.toolCount ?? 0,
      turnCount: step?.turnCount,
      tokens: step?.tokens?.total ?? 0,
      durationMs: step?.durationMs ?? Math.max(0, Date.now() - (step?.startedAt ?? run.startedAt)),
      error: step?.error,
    };
  });
  const results: SingleResult[] = progress.map((item, position) => ({
    agent: item.agent,
    task: item.task,
    exitCode: children[position]?.result?.exitCode ?? 0,
    usage: children[position]?.result?.usage ?? {
      input: status?.steps?.[item.index]?.tokens?.input ?? 0,
      output: status?.steps?.[item.index]?.tokens?.output ?? 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: item.turnCount ?? 0,
    },
    progress: item,
    model: item.model,
    sessionFile: children[position]?.sessionFile,
    finalOutput:
      getSingleResultOutput(children[position]?.result ?? {}) ||
      item.streamingText ||
      item.recentOutput.at(-1),
  }));
  return {
    content: [
      {
        type: "text",
        text: progress
          .map(
            (item) =>
              `${item.agent}: ${item.status}${item.currentTool ? ` — ${item.currentTool}${item.currentToolArgs ? ` ${item.currentToolArgs}` : ""}` : ""}`,
          )
          .join("\n"),
      },
    ],
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
