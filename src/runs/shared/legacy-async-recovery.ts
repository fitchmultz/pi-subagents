import * as fs from "node:fs";
import * as path from "node:path";
import type { AsyncRunRecord } from "../background/async-resume.ts";
import { readAsyncResultFile } from "../background/async-result-file.ts";
import { getRunMetadataDir, saveAsyncRunResult, saveRunStatus } from "./supervisor-questions.ts";
import {
  RESULTS_DIR,
  type OwnedRun,
  type ReadonlyAsyncStatus,
  type ReadonlyAsyncResultChild,
} from "../../shared/types.ts";
import { savedWorkflowNodes } from "./owned-run-observation.ts";
import { workflowChildren } from "./run-persistence.ts";
import { recoverLegacyTerminalOutput } from "./legacy-output-recovery.ts";

type StatusStep = NonNullable<ReadonlyAsyncStatus["steps"]>[number];

function childSession(step: StatusStep, status: ReadonlyAsyncStatus): string | undefined {
  return step.sessionFile ?? (status.steps?.length === 1 ? status.sessionFile : undefined);
}

function recoveredChild(step: StatusStep, status: ReadonlyAsyncStatus): ReadonlyAsyncResultChild {
  const sessionFile = childSession(step, status);
  return {
    agent: step.agent,
    sessionFile,
    model: step.model,
    acceptance: step.acceptance,
    exitCode: step.exitCode,
    agentProcessExit: step.agentProcessExit,
    success: step.status === "complete" || step.status === "completed",
    interrupted: step.status === "paused" || undefined,
    timedOut: step.status === "timed-out" || undefined,
    error: step.error,
    output:
      recoverLegacyTerminalOutput(
        sessionFile,
        step.startedAt ?? status.startedAt,
        step.endedAt ?? status.endedAt,
        step.acceptance,
      ) ?? "",
  };
}

function needsResultRepair(record: Readonly<AsyncRunRecord>): boolean {
  return (
    record.status !== null &&
    !record.durable &&
    !["running", "queued"].includes(record.status.state) &&
    !fs.existsSync(path.join(getRunMetadataDir(record.status.runId), "result.json"))
  );
}

/** Metadata recovery never runs the child or treats live logs as a final answer. */
export function repairLegacyAsyncResult(record: Readonly<AsyncRunRecord>): void {
  const { location, status } = record;
  if (!status || !needsResultRepair(record)) {
    return;
  }
  const resultPath = path.join(RESULTS_DIR, `${status.runId}.json`);
  if (fs.existsSync(resultPath)) {
    saveAsyncRunResult(status.runId, readAsyncResultFile(resultPath));
    return;
  }
  const steps = status.steps ?? [];
  if (steps.length === 0 || steps.some((step) => ["running", "pending"].includes(step.status))) {
    return;
  }
  saveAsyncRunResult(status.runId, {
    id: status.runId,
    sessionId: status.sessionId,
    mode: status.mode,
    state: status.state,
    success: status.state === "complete",
    error: status.error,
    timestamp: status.endedAt ?? status.lastUpdate ?? status.startedAt,
    cwd: status.cwd,
    asyncDir: location.asyncDir ?? undefined,
    sessionFile: status.sessionFile,
    results: steps.map((step) => recoveredChild(step, status)),
  });
}

function declaredWorkflowChildren(
  status: ReadonlyAsyncStatus,
  old: OwnedRun | undefined,
  nodes: ReturnType<typeof savedWorkflowNodes>,
): OwnedRun["children"] {
  return status.mode === "chain" &&
    nodes &&
    old?.children.some((child) => (child.workflowNodeId ?? "") !== "") !== true
    ? []
    : (old?.children ?? []);
}

function projectedChildren(
  status: ReadonlyAsyncStatus,
  old: OwnedRun | undefined,
): OwnedRun["children"] {
  const nodes = savedWorkflowNodes(status);
  const declared = declaredWorkflowChildren(status, old, nodes);
  const children = workflowChildren(declared, nodes ? status.workflowGraph : undefined);
  const projected: OwnedRun["children"][number][] = [];
  for (const [index, step] of (status.steps ?? []).entries()) {
    const previous = children.find((child) => child.index === index);
    const node = status.mode === "chain" ? nodes?.[index] : undefined;
    projected.push({
      ...previous,
      agent: step.agent,
      index,
      ...(node ? { workflowNodeId: node.id } : {}),
      label: step.label ?? children[index]?.label,
      sessionFile: childSession(step, status),
    });
  }
  return projected;
}

function asyncLineage(
  old: OwnedRun | undefined,
  status: ReadonlyAsyncStatus,
  durable: boolean,
): Pick<OwnedRun, "rootRunId" | "task" | "legacy"> {
  return {
    rootRunId: old?.rootRunId ?? status.runId,
    task: old?.task ?? "Recovered background run",
    legacy: old?.legacy ?? !durable,
  };
}

export function recoveredAsyncRun(
  record: Readonly<AsyncRunRecord>,
  old: OwnedRun | undefined,
  owner: { readonly ownerSessionId: string; readonly cwd: string },
): OwnedRun | undefined {
  const { location, status, durable } = record;
  const asyncDir = location.asyncDir;
  if (!status || asyncDir === null || asyncDir === "") {
    return undefined;
  }
  if (!durable && !["running", "queued"].includes(status.state)) {
    saveRunStatus(status.runId, status);
  }
  return {
    ...old,
    runId: status.runId,
    ownerSessionId: owner.ownerSessionId,
    ...asyncLineage(old, status, durable),
    source: "async",
    mode: status.mode,
    cwd: status.cwd ?? old?.cwd ?? owner.cwd,
    startedAt: status.startedAt,
    asyncDir,
    pid: status.pid,
    children: projectedChildren(status, old),
  };
}
