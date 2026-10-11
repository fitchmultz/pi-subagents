import * as fs from "node:fs";
import * as path from "node:path";
import { compactForegroundResult, getSingleResultOutput } from "../../shared/utils.ts";
import { readAsyncResultFile } from "../background/async-result-file.ts";
import { exactAsyncRunLocation } from "../background/async-resume.ts";
import { getRunMetadataDir } from "./supervisor-questions.ts";
import {
  ASYNC_DIR,
  DEFAULT_MAX_OUTPUT,
  RESULTS_DIR,
  truncateOutput,
  type OwnedRun,
  type OwnedRunView,
  type ReadonlyAsyncResultFile,
  type ReadonlySingleResult,
  type MaxOutputConfig,
  type SubagentExecutionResult,
} from "../../shared/types.ts";
import { repairOwnedRunAccounting } from "./run-persistence.ts";
import type { OwnedRunReadState } from "./owned-run-read-state.ts";
import { ownedRunView } from "./owned-run-view.ts";
import { ownedRunProgressResult } from "./owned-run-progress.ts";
import { workflowDetails } from "./owned-workflow-details.ts";
export { ownedRunProgressResult } from "./owned-run-progress.ts";

type ChildView = OwnedRunView["children"][number];
type Limits = Readonly<Required<MaxOutputConfig>>;

function initialOutput(
  result: ReadonlySingleResult,
  limits: Limits,
  artifactPath?: string,
): Pick<ReadonlySingleResult, "initialOutput"> {
  const initial = result.initialOutput;
  return initial !== undefined && initial !== ""
    ? { initialOutput: truncateOutput(initial, limits, artifactPath).text }
    : {};
}

function projectChild(child: ChildView, limits: Limits): ChildView {
  if (!child.result) {
    return { ...child, result: undefined };
  }
  const { artifactPaths, ...result } = child.result;
  const truncation =
    result.outputMode === "file-only" && result.exitCode === 0 && result.outputReference
      ? { text: result.outputReference.message, truncated: false }
      : truncateOutput(getSingleResultOutput(result), limits, artifactPaths?.outputPath);
  const compacted = compactForegroundResult({
    ...result,
    finalOutput: truncation.text,
    ...(truncation.truncated ? { truncation } : {}),
    ...initialOutput(result, limits, artifactPaths?.outputPath),
  });
  return { ...child, result: { ...compacted, ...(artifactPaths ? { artifactPaths } : {}) } };
}

function publicResult(child: ChildView): ReadonlySingleResult[] {
  if (!child.result) {
    return [];
  }
  const { artifactPaths, ...result } = child.result;
  if (
    artifactPaths?.inputPath !== undefined &&
    artifactPaths.inputPath !== "" &&
    artifactPaths.outputPath !== undefined &&
    artifactPaths.outputPath !== "" &&
    artifactPaths.metadataPath !== undefined &&
    artifactPaths.metadataPath !== ""
  ) {
    return [
      {
        ...result,
        artifactPaths: {
          inputPath: artifactPaths.inputPath,
          outputPath: artifactPaths.outputPath,
          metadataPath: artifactPaths.metadataPath,
        },
      },
    ];
  }
  return [result];
}

function resultFailed(view: OwnedRunView, children: readonly ChildView[], index?: number): boolean {
  return index === undefined
    ? ["failed", "unknown"].includes(view.state)
    : children.length === 0 ||
        children.some((child) => ["failed", "unknown"].includes(child.state));
}

function resultText(
  view: OwnedRunView,
  children: readonly ChildView[],
  saved: ReadonlyAsyncResultFile | undefined,
  index?: number,
): string {
  const summary = index === undefined ? saved?.summary : undefined;
  let text =
    summary !== undefined && summary !== ""
      ? summary
      : [
          ...children.map((child) => {
            if (!child.result) {
              return;
            }
            const output = getSingleResultOutput(child.result);
            return output !== "" ? output : child.result.error;
          }),
          view.diagnosis,
        ]
          .filter((part) => part !== undefined && part !== "")
          .join("\n\n");
  const error = saved?.error;
  if (
    resultFailed(view, children, index) &&
    error !== undefined &&
    error !== "" &&
    !text.includes(error)
  ) {
    text = `${error}\n\n${text}`;
  }
  return text;
}

function outputArtifact(
  run: OwnedRun,
  results: readonly ReadonlySingleResult[],
  directory: string,
): string | undefined {
  if (run.mode === "single") {
    return results[0]?.artifactPaths?.outputPath;
  }
  const logPath = path.join(directory, `subagent-log-${run.runId}.md`);
  return fs.existsSync(logPath) ? logPath : undefined;
}

function summaryTruncation(
  view: OwnedRunView,
  results: readonly ReadonlySingleResult[],
  output: { readonly text: string; readonly limits: Limits },
): ReturnType<typeof truncateOutput> {
  const { text, limits } = output;
  const only = results.length === 1 ? results[0] : undefined;
  if (
    view.state === "completed" &&
    view.mode === "single" &&
    only?.outputMode === "file-only" &&
    only.outputReference
  ) {
    return { text: only.outputReference.message, truncated: false };
  }
  if (view.state === "blocked") {
    return { text, truncated: false };
  }
  const directory = view.asyncDir ?? getRunMetadataDir(view.runId);
  return truncateOutput(text, limits, outputArtifact(view, results, directory));
}

function progressSummary(
  results: readonly ReadonlySingleResult[],
  duration?: number,
): SubagentExecutionResult["details"]["progressSummary"] {
  return {
    toolCount: results.reduce(
      (total, result) => total + (result.progressSummary?.toolCount ?? 0),
      0,
    ),
    tokens: results.reduce((total, result) => total + (result.progressSummary?.tokens ?? 0), 0),
    durationMs:
      duration ?? Math.max(0, ...results.map((result) => result.progressSummary?.durationMs ?? 0)),
  };
}

function resultIdentity(run: OwnedRun): string[] {
  return (run.predecessorRunId ?? "") !== ""
    ? [
        `Run: ${run.runId}\nPredecessor: ${run.predecessorRunId ?? ""} (child ${run.predecessorIndex ?? 0})`,
      ]
    : [];
}

function sharingText(saved: ReadonlyAsyncResultFile | undefined): string[] {
  if (saved?.shareUrl !== undefined && saved.shareUrl !== "") {
    return [`Session: ${saved.shareUrl}`];
  }
  return saved?.shareError !== undefined && saved.shareError !== ""
    ? [`Session share error: ${saved.shareError}`]
    : [];
}

function savedDetails(
  saved: ReadonlyAsyncResultFile | undefined,
  results: readonly ReadonlySingleResult[],
): Pick<
  SubagentExecutionResult["details"],
  | "artifacts"
  | "shareUrl"
  | "gistUrl"
  | "shareError"
  | "outputs"
  | "workflowGraph"
  | "chainAgents"
  | "totalSteps"
  | "currentStepIndex"
> {
  if (!saved) {
    return resultArtifacts(results);
  }
  return {
    ...((saved.shareUrl ?? "") !== "" ? { shareUrl: saved.shareUrl } : {}),
    ...((saved.gistUrl ?? "") !== "" ? { gistUrl: saved.gistUrl } : {}),
    ...((saved.shareError ?? "") !== "" ? { shareError: saved.shareError } : {}),
    ...(saved.outputs ? { outputs: saved.outputs } : {}),
    ...workflowDetails(saved.workflowGraph),
    ...resultArtifacts(results, saved.artifactsDir),
  };
}

function resultArtifacts(
  results: readonly ReadonlySingleResult[],
  directory?: string,
): Pick<SubagentExecutionResult["details"], "artifacts"> {
  const files = results.flatMap((result) => (result.artifactPaths ? [result.artifactPaths] : []));
  const first = files.at(0);
  return first ? { artifacts: { dir: directory ?? path.dirname(first.outputPath), files } } : {};
}

function loadSavedResult(file: string | null): ReadonlyAsyncResultFile | undefined {
  return file !== null && file !== "" ? readAsyncResultFile(file) : undefined;
}

function outputLimits(saved: ReadonlyAsyncResultFile | undefined, view: OwnedRunView): Limits {
  return { ...DEFAULT_MAX_OUTPUT, ...(saved?.maxOutput ?? view.children.at(0)?.launch?.maxOutput) };
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
  const saved = loadSavedResult(location.resultPath);
  const limits = outputLimits(saved, view);
  const children = view.children.filter((child) => index === undefined || child.index === index);
  const projected = view.children.map((child) => projectChild(child, limits));
  const results = projected
    .filter((child) => index === undefined || child.index === index)
    .flatMap(publicResult);
  const truncation = summaryTruncation(
    { ...view, asyncDir: location.asyncDir ?? view.asyncDir },
    results,
    { text: resultText(view, children, saved, index), limits },
  );
  return {
    content: [
      {
        type: "text",
        text: [
          ...resultIdentity(run),
          truncation.text !== "" ? truncation.text : `Run ${run.runId}: ${view.state}.`,
          ...sharingText(saved),
        ].join("\n\n"),
      },
    ],
    ...(resultFailed(view, children, index) ? { isError: true } : {}),
    details: {
      mode: run.mode,
      runId: run.runId,
      asyncId: run.runId,
      asyncDir: location.asyncDir ?? run.asyncDir,
      results,
      run: { ...view, children: projected },
      progressSummary: progressSummary(results, saved?.durationMs),
      ...(includeProgress
        ? { progress: ownedRunProgressResult(run, state, index).details.progress }
        : {}),
      ...savedDetails(saved, results),
      ...(truncation.truncated ? { truncation } : {}),
    },
  };
}
