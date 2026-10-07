import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import {
  RESULTS_DIR,
  type AsyncParallelGroupStatus,
  type AsyncStatus,
  type NestedRunSummary,
  type SubagentRunMode,
} from "../../shared/types.ts";
import type { ReadonlyInput } from "../../shared/types/inputs.ts";
import { normalizeParallelGroups } from "./parallel-groups.ts";
import {
  nestedSummaryFromAsyncStatus,
  projectNestedEvents,
  resolveNestedAsyncDir,
  writeNestedEvent,
  type NestedRoute,
} from "../shared/nested-events.ts";
import { isDurableRun } from "./async-result-file.ts";
import { readRunJson } from "../shared/supervisor-questions.ts";
import { readStatus } from "../../shared/utils.ts";
import type { AsyncRunRecord } from "./async-run-record.ts";
import {
  buildFailedRepair,
  terminalStatusFromResult,
  writeFailedRepair,
} from "./async-run-repair.ts";
import { errorCode, hasText } from "./async-value.ts";

export type PidLiveness = "alive" | "dead" | "unknown";
type KillFn = (pid: number, signal?: NodeJS.Signals | 0) => boolean;
interface StartedRunMetadata {
  readonly runId: string;
  readonly pid?: number;
  readonly sessionId?: string;
  readonly mode?: SubagentRunMode;
  readonly agents?: readonly string[];
  readonly chainStepCount?: number;
  readonly parallelGroups?: readonly AsyncParallelGroupStatus[];
  readonly startedAt?: number;
  readonly sessionFile?: string;
}
interface ReconcileAsyncRunOptions {
  readonly resultsDir?: string;
  readonly kill?: KillFn;
  readonly now?: () => number;
  readonly startedRun?: StartedRunMetadata;
  readonly missingStatusGraceMs?: number;
  readonly staleAlivePidMs?: number;
}
interface ReconcileAsyncRunResult {
  readonly status: ReadonlyInput<AsyncStatus> | null;
  readonly repaired: boolean;
  readonly resultPath?: string;
  readonly message?: string;
}
interface Recovery {
  readonly asyncDir: string;
  readonly resultPath: string;
  readonly now: number;
  readonly options: ReadonlyInput<ReconcileAsyncRunOptions>;
}

function buildStartedStatus(
  asyncDir: string,
  startedRun: ReadonlyInput<StartedRunMetadata>,
  now: number,
): AsyncStatus {
  const startedAt = startedRun.startedAt ?? now;
  const agents = (startedRun.agents?.length ?? 0) > 0 ? (startedRun.agents ?? []) : ["subagent"];
  const count = startedRun.chainStepCount;
  const groups =
    count === undefined
      ? []
      : normalizeParallelGroups(startedRun.parallelGroups, agents.length, count);
  return {
    runId: startedRun.runId.length > 0 ? startedRun.runId : path.basename(asyncDir),
    sessionId: startedRun.sessionId,
    mode: startedRun.mode ?? "single",
    state: "running",
    pid: startedRun.pid,
    startedAt,
    lastUpdate: now,
    currentStep: 0,
    chainStepCount: count,
    ...(groups.length > 0 ? { parallelGroups: groups } : {}),
    steps: agents.map((agent) => ({ agent, status: "running", startedAt })),
    sessionFile: startedRun.sessionFile,
  };
}
function terminal(state: AsyncStatus["state"]): boolean {
  return state === "complete" || state === "failed" || state === "blocked" || state === "paused";
}

function publishNestedRepair(
  result: ReadonlyInput<ReconcileAsyncRunResult>,
  route: ReadonlyInput<NestedRoute>,
  child: ReadonlyInput<NestedRunSummary>,
  ts: number,
): void {
  if (
    !result.status ||
    isDurableRun(result.status) ||
    (!result.repaired && !terminal(result.status.state))
  ) {
    return;
  }
  writeNestedEvent(route, {
    type: terminal(result.status.state) ? "subagent.nested.completed" : "subagent.nested.updated",
    ts,
    parentRunId: child.parentRunId,
    parentStepIndex: child.parentStepIndex,
    child,
  });
}
function projectedNestedChild(
  run: ReadonlyInput<NestedRunSummary>,
  status: ReadonlyInput<AsyncStatus>,
  asyncDir: string,
  ts: number,
): NestedRunSummary {
  const child = nestedSummaryFromAsyncStatus(status, asyncDir, {
    id: run.id,
    parentRunId: run.parentRunId,
    parentStepIndex: run.parentStepIndex,
    depth: run.depth,
    path: run.path,
    mode: run.mode,
    ts,
  });
  const steps = child.steps?.map((step, index) => {
    return { ...step, children: run.steps?.at(index)?.children };
  });
  return { ...child, steps };
}
function reconcileNestedRun(
  run: ReadonlyInput<NestedRunSummary>,
  route: ReadonlyInput<NestedRoute>,
  options: ReadonlyInput<ReconcileAsyncRunOptions>,
): NestedRunSummary {
  if (run.state !== "running" && run.state !== "queued") {
    return run;
  }
  const asyncDir = resolveNestedAsyncDir(route.rootRunId, run);
  if (!hasText(asyncDir)) {
    return run;
  }
  const result = reconcileAsyncRun(asyncDir, {
    ...options,
    resultsDir: path.join(options.resultsDir ?? RESULTS_DIR, "nested", route.rootRunId),
  });
  if (!result.status) {
    return run;
  }
  const ts = options.now?.() ?? Date.now();
  const child = projectedNestedChild(run, result.status, asyncDir, ts);
  publishNestedRepair(result, route, child, ts);
  return { ...run, ...child, ...(hasText(result.message) ? { error: result.message } : {}) };
}
function reconcileNestedTree(
  run: ReadonlyInput<NestedRunSummary>,
  route: ReadonlyInput<NestedRoute>,
  options: ReadonlyInput<ReconcileAsyncRunOptions>,
): NestedRunSummary {
  const projected = reconcileNestedRun(run, route, options);
  const children = projected.children?.map((child) => reconcileNestedTree(child, route, options));
  const steps = projected.steps?.map((step) => {
    return {
      ...step,
      children: step.children?.map((child) => reconcileNestedTree(child, route, options)),
    };
  });
  return { ...projected, children, steps };
}
export function reconcileNestedAsyncDescendants(
  route: ReadonlyInput<NestedRoute>,
  options: ReadonlyInput<ReconcileAsyncRunOptions> = {},
): NestedRunSummary[] {
  return projectNestedEvents(route).children.map((run) => reconcileNestedTree(run, route, options));
}
export function checkPidLiveness(
  pid: number,
  kill: KillFn = (target, signal) => process.kill(target, signal),
): PidLiveness {
  try {
    kill(pid, 0);
    return "alive";
  } catch (error) {
    return errorCode(error) === "ESRCH" ? "dead" : "unknown";
  }
}

function durableProjection(
  status: ReadonlyInput<AsyncStatus>,
  recovery: Recovery,
): ReconcileAsyncRunResult {
  const { asyncDir, resultPath, options, now } = recovery;
  const final = terminalStatusFromResult(status, resultPath, status.endedAt ?? now);
  if (final) {
    return { status: final, repaired: false, resultPath };
  }
  if (typeof status.pid === "number" && checkPidLiveness(status.pid, options.kill) === "dead") {
    const failure = buildFailedRepair(status, asyncDir, status.lastUpdate ?? status.startedAt);
    return { status: failure.status, repaired: false, message: failure.message };
  }
  if (terminal(status.state)) {
    return {
      status: { ...status, state: "running" },
      repaired: false,
      message: "Waiting for the owner's final result. Completion is unconfirmed.",
    };
  }
  return { status, repaired: false };
}
function legacyProjection(
  status: ReadonlyInput<AsyncStatus> | null,
  effective: ReadonlyInput<AsyncStatus>,
  recovery: Recovery,
): ReconcileAsyncRunResult {
  const { asyncDir, resultPath, now } = recovery;
  if (fs.existsSync(resultPath)) {
    const final =
      effective.state === "running" || effective.state === "queued"
        ? terminalStatusFromResult(effective, resultPath, now)
        : undefined;
    if (final) {
      writeAtomicJson(path.join(asyncDir, "status.json"), final);
      return {
        status: final,
        repaired: true,
        resultPath,
        message: "Existing async result file was used to repair stale running status.",
      };
    }
    return { status: effective, repaired: false, resultPath };
  }
  return legacyMissingResult(status, effective, recovery);
}
function awaitingInitialStatus(
  status: ReadonlyInput<AsyncStatus> | null,
  effective: ReadonlyInput<AsyncStatus>,
  recovery: Recovery,
): boolean {
  const start = recovery.options.startedRun?.startedAt ?? effective.startedAt;
  return status === null && recovery.now - start < (recovery.options.missingStatusGraceMs ?? 1000);
}
function legacyMissingResult(
  status: ReadonlyInput<AsyncStatus> | null,
  effective: ReadonlyInput<AsyncStatus>,
  recovery: Recovery,
): ReconcileAsyncRunResult {
  const { options, now, asyncDir, resultPath } = recovery;
  const unchanged = { status, repaired: false, resultPath };
  if (
    (effective.state !== "running" && effective.state !== "queued") ||
    typeof effective.pid !== "number" ||
    awaitingInitialStatus(status, effective, recovery)
  ) {
    return unchanged;
  }
  if (checkPidLiveness(effective.pid, options.kill) === "dead") {
    return writeFailedRepair(asyncDir, effective, resultPath, { now });
  }
  const lastUpdate = effective.lastUpdate ?? effective.startedAt;
  if (now - lastUpdate <= (options.staleAlivePidMs ?? 24 * 60 * 60 * 1000)) {
    return unchanged;
  }
  const reason = `Async runner process ${effective.pid} still has a live PID, but status has not updated for ${now - lastUpdate}ms. Marked run failed by stale-run reconciliation because PID ownership cannot be verified.`;
  return writeFailedRepair(asyncDir, effective, resultPath, { now, reason });
}
function resultLocation(
  asyncDir: string,
  status: ReadonlyInput<AsyncStatus>,
  options: ReadonlyInput<ReconcileAsyncRunOptions>,
  record: ReadonlyInput<Pick<AsyncRunRecord, "status" | "durable">> | undefined,
): { readonly durable: boolean; readonly resultPath: string } {
  const runId = status.runId.length > 0 ? status.runId : path.basename(asyncDir);
  const durable =
    isDurableRun(status) ||
    (record === undefined
      ? isDurableRun(readRunJson(path.join(asyncDir, "launch.json")))
      : record.durable);
  return {
    durable,
    resultPath: durable
      ? path.join(asyncDir, "result.json")
      : path.join(options.resultsDir ?? RESULTS_DIR, `${runId}.json`),
  };
}
export function reconcileAsyncRun(
  asyncDir: string,
  options: ReadonlyInput<ReconcileAsyncRunOptions> = {},
  record?: ReadonlyInput<Pick<AsyncRunRecord, "status" | "durable">>,
): ReconcileAsyncRunResult {
  const now = options.now?.() ?? Date.now();
  const status = record === undefined ? readStatus(asyncDir) : record.status;
  const effective =
    status ??
    (options.startedRun === undefined
      ? undefined
      : buildStartedStatus(asyncDir, options.startedRun, now));
  if (!effective) {
    return { status: null, repaired: false };
  }
  const location = resultLocation(asyncDir, effective, options, record);
  const recovery = { asyncDir, resultPath: location.resultPath, options, now };
  // The detached durable owner is the only execution writer. Inspection projects its evidence.
  return location.durable
    ? durableProjection(effective, recovery)
    : legacyProjection(status, effective, recovery);
}
