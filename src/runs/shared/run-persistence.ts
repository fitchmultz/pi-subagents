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
  ReadonlySingleResult,
  ReadonlyAsyncResultChild,
  SubagentState,
} from "../../shared/types.ts";
import type { OwnedRunReadState } from "./owned-run-read-state.ts";
import { setOwnedRun } from "./run-state-owner.ts";

export const OWNED_RUN_ENTRY = "subagent-run";
const failedAccountingSources = new Map<string, string>();

function accountingSource(
  run: OwnedRun,
  index: number,
  child: ReadonlyAsyncResultChild,
):
  | {
      readonly key: string;
      readonly stamp: string;
      readonly source: string;
      readonly terminalEntryId: string;
      readonly baseline: readonly string[];
    }
  | undefined {
  const contract = readQuestionContract(run.runId, index, undefined, { readConfiguration: false });
  if (!contract?.attemptBaseline) {
    return undefined;
  }
  const terminalEntryId = child.terminalEntryId ?? contract.terminalEntryId ?? "";
  const source = child.sessionFile ?? contract.sessionFile ?? "";
  if (terminalEntryId === "" || source === "") {
    return undefined;
  }
  const stat = fs.statSync(source, { bigint: true, throwIfNoEntry: false });
  return {
    key: `${run.runId}:${index}`,
    stamp: `${stat ? journalStamp(stat) : "missing"}:${terminalEntryId}:${JSON.stringify(contract.attemptBaseline)}`,
    source,
    terminalEntryId,
    baseline: contract.attemptBaseline,
  };
}

function repairChildAccounting(
  run: OwnedRun,
  index: number,
  child: ReadonlyAsyncResultChild,
): ReadonlyAsyncResultChild {
  if (child.accounting?.state !== "incomplete") {
    return child;
  }
  const evidence = accountingSource(run, index, child);
  if (!evidence || failedAccountingSources.get(evidence.key) === evidence.stamp) {
    return child;
  }
  let usage;
  try {
    usage = readNativeUsage(evidence.source, new Set(evidence.baseline), [], {
      terminalEntryId: evidence.terminalEntryId,
    })?.[0];
  } catch (error) {
    failedAccountingSources.set(evidence.key, evidence.stamp);
    throw error;
  }
  if (!usage) {
    return child;
  }
  failedAccountingSources.delete(evidence.key);
  const repaired: ReadonlyAsyncResultChild = { ...child, usage, accounting: { state: "complete" } };
  const contract = readQuestionContract(run.runId, index, undefined, { readConfiguration: false });
  if (contract?.result) {
    saveQuestionContract(run.runId, index, {
      accounting: repaired.accounting,
      result: { ...contract.result, usage, accounting: repaired.accounting },
    });
  }
  return repaired;
}

/** Repair only recorded native billing evidence; never execute or verify work again. */
export function repairOwnedRunAccounting(run: OwnedRun): void {
  const file = path.join(getRunMetadataDir(run.runId), "result.json");
  if (!fs.existsSync(file)) {
    return;
  }
  const saved = readAsyncResultFile(file);
  const children = saved.results ?? [];
  const results = children.map((child, index) => repairChildAccounting(run, index, child));
  if (results.some((child, index) => child !== children[index])) {
    saveAsyncRunResult(run.runId, { ...saved, results });
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
  readonly runId: string;
  readonly mode: ForegroundResumeRun["mode"];
  readonly cwd: string;
  readonly results: readonly ReadonlySingleResult[];
  readonly error?: string;
  readonly pausedReason?: string;
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
