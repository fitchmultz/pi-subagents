import * as fs from "node:fs";
import * as path from "node:path";
import { journalStamp } from "../../shared/journal-reader.ts";
import { readNativeUsage } from "./native-usage.ts";
import { updateRunHistory } from "./history-index.ts";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { compactForegroundResult, getSingleResultOutput } from "../../shared/utils.ts";
import { resolveSubagentResultStatus } from "../../intercom/result-intercom.ts";
import { readAsyncResultFile } from "../background/async-result-file.ts";
import { formatRunIdAmbiguity } from "./run-id-ambiguity.ts";
import { workflowAgentNodes } from "./workflow-graph.ts";
import {
  compactOwnerResult,
  getRunMetadataDir,
  readQuestionContract,
  saveAsyncRunResult,
  saveQuestionContract,
} from "./supervisor-questions.ts";
import type {
  ForegroundResumeRun,
  OwnedRun,
  SingleResult,
  SubagentState,
  WorkflowGraphSnapshot,
} from "../../shared/types.ts";
import type { OwnedRunReadState } from "./owned-run-read-state.ts";
import { setOwnedRun } from "./run-state-owner.ts";

export const OWNED_RUN_ENTRY = "subagent-run";
const failedAccountingSources = new Map<string, string>();

/** Repair only recorded native billing evidence; never execute or verify work again. */
export function repairOwnedRunAccounting(run: OwnedRun): void {
  const file = path.join(getRunMetadataDir(run.runId), "result.json");
  if (!fs.existsSync(file)) {
    return;
  }
  const saved = readAsyncResultFile(file);
  let changed = false;
  saved.results?.forEach((child, index) => {
    if (child.accounting?.state !== "incomplete") {
      return;
    }
    const contract = readQuestionContract(run.runId, index, undefined, {
      readConfiguration: false,
    });
    const terminalEntryId = child.terminalEntryId ?? contract?.terminalEntryId;
    if (!contract?.attemptBaseline || terminalEntryId === undefined || terminalEntryId === "") {
      return;
    }
    const source = child.sessionFile ?? contract.sessionFile;
    if (source === undefined || source === "") {
      return;
    }
    const stat = fs.statSync(source, { bigint: true, throwIfNoEntry: false });
    const key = `${run.runId}:${index}`,
      stamp = `${stat ? journalStamp(stat) : "missing"}:${terminalEntryId}:${JSON.stringify(contract.attemptBaseline)}`;
    if (failedAccountingSources.get(key) === stamp) {
      return;
    }
    let usage;
    try {
      usage = readNativeUsage(source, new Set(contract.attemptBaseline), [], {
        terminalEntryId,
      })?.[0];
    } catch (error) {
      failedAccountingSources.set(key, stamp);
      throw error;
    }
    if (!usage) {
      return;
    }
    failedAccountingSources.delete(key);
    child.usage = usage;
    child.accounting = { state: "complete" };
    changed = true;
    if (contract.result) {
      saveQuestionContract(run.runId, index, {
        accounting: child.accounting,
        result: { ...contract.result, usage, accounting: child.accounting },
      });
    }
  });
  if (changed) {
    saveAsyncRunResult(run.runId, saved);
  }
}

export function rememberOwnedRun(state: SubagentState, run: OwnedRun): void {
  const previous = setOwnedRun(state, run);
  if (JSON.stringify(previous) !== JSON.stringify(run)) {
    state.persistOwnedRun?.(run);
    updateRunHistory(state, run);
    state.onRunsChanged?.();
  }
}

export function resolveOwnedRun(state: OwnedRunReadState, requested: string): OwnedRun | undefined {
  const id = requested.trim();
  getRunMetadataDir(id); // Same ID boundary as the question and result files.
  const exact = state.ownedRuns?.get(id);
  if (exact && id !== "latest" && id !== "last") {
    return exact;
  }
  const runs = [...(state.ownedRuns?.values() ?? [])];
  if (id === "latest" || id === "last") {
    return runs.sort((a, b) => b.startedAt - a.startedAt)[0];
  }
  const matches = runs.filter((run) => run.runId.startsWith(id));
  if (matches.length > 1) {
    throw new Error(
      formatRunIdAmbiguity(
        "owned",
        id,
        matches.map((run) => run.runId),
      ),
    );
  }
  return matches[0];
}

export function saveForegroundRun(input: {
  runId: string;
  mode: ForegroundResumeRun["mode"];
  cwd: string;
  results: SingleResult[];
  error?: string;
  pausedReason?: string;
}): ForegroundResumeRun {
  const run: ForegroundResumeRun = {
    runId: input.runId,
    mode: input.mode,
    cwd: input.cwd,
    updatedAt: Date.now(),
    ...((input.error ?? "") !== "" ? { error: input.error } : {}),
    ...((input.pausedReason ?? "") !== "" ? { pausedReason: input.pausedReason } : {}),
    children: input.results.map((result, index) => ({
      agent: result.agent,
      index,
      status: resolveSubagentResultStatus(result),
      ...(result.detached !== true
        ? {
            summary: (getSingleResultOutput(result) === ""
              ? result.error
              : getSingleResultOutput(result)
            )?.slice(-8192),
          }
        : {}),
      artifactPath: result.artifactPaths?.outputPath,
      sessionFile: result.sessionFile,
      effectiveAcceptance: result.acceptance?.effectiveAcceptance,
      result: compactOwnerResult(input.runId, index, compactForegroundResult(result)),
    })),
  };
  writeAtomicJson(path.join(getRunMetadataDir(input.runId), "foreground.json"), run);
  return run;
}

export function workflowChildren(
  children: OwnedRun["children"],
  graph: WorkflowGraphSnapshot | undefined,
): OwnedRun["children"] {
  if (
    !graph ||
    (graph.mode !== "chain" && !children.some((child) => (child.workflowNodeId ?? "") !== ""))
  ) {
    return children;
  }
  return workflowAgentNodes(graph).map((node, index) => {
    const declared = children.find((child) => child.workflowNodeId === node.id);
    return {
      ...declared,
      index,
      workflowNodeId: node.id,
      agent: node.agent ?? declared?.agent ?? "unknown",
      ...(node.itemKey !== undefined ? { label: node.label } : {}),
    };
  });
}
