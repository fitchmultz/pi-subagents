import * as path from "node:path";
import {
  writeAsyncControlRequest,
  writeAsyncInterruptRequest,
} from "../background/async-control.ts";
import { questionProcessAlive, readRunJson } from "../shared/supervisor-questions.ts";
import { readStatus } from "../../shared/utils.ts";
import { resolveOwnedRun } from "../shared/run-records.ts";
import { buildManagementControl } from "../../shared/status-format.ts";
import { errorMessage } from "../../shared/unknown.ts";
import type {
  ReadonlySubagentState,
  SubagentState,
  SubagentExecutionResult,
  ReadonlyAsyncStatus,
} from "../../shared/types.ts";

interface InterruptTarget {
  readonly asyncId: string;
  readonly asyncDir: string;
}
interface TimedTarget extends InterruptTarget {
  readonly updatedAt: number;
}
function requestedTarget(state: ReadonlySubagentState, runId: string): InterruptTarget | undefined {
  const direct = state.asyncJobs.get(runId);
  if (direct) {
    return { asyncId: direct.asyncId, asyncDir: direct.asyncDir };
  }
  const owned = resolveOwnedRun(state, runId);
  return owned?.asyncDir !== undefined && owned.asyncDir.length > 0
    ? { asyncId: owned.runId, asyncDir: owned.asyncDir }
    : undefined;
}
function newestTrackedTarget(state: ReadonlySubagentState): TimedTarget | undefined {
  let newest: TimedTarget | undefined;
  for (const job of state.asyncJobs.values()) {
    if (job.status !== "running") {
      continue;
    }
    const updatedAt = job.updatedAt ?? 0;
    if (!newest || updatedAt > newest.updatedAt) {
      newest = { asyncId: job.asyncId, asyncDir: job.asyncDir, updatedAt };
    }
  }
  return newest;
}
function ownedProducerAlive(run: { readonly asyncDir: string; readonly pid?: number }): boolean {
  const status = readStatus(run.asyncDir);
  if (status) {
    return status.state === "running" || status.state === "queued";
  }
  return run.pid !== undefined && run.pid !== 0 && questionProcessAlive({ pid: run.pid });
}
function newestOwnedTarget(
  state: ReadonlySubagentState,
  tracked: TimedTarget | undefined,
): TimedTarget | undefined {
  let newest = tracked;
  for (const run of state.ownedRuns?.values() ?? []) {
    const dir = run.asyncDir;
    if (dir === undefined || dir.length === 0 || (newest && run.startedAt <= newest.updatedAt)) {
      continue;
    }
    if (ownedProducerAlive({ asyncDir: dir, pid: run.pid })) {
      newest = { asyncId: run.runId, asyncDir: dir, updatedAt: run.startedAt };
    }
  }
  return newest;
}
export function getAsyncInterruptTarget(
  state: ReadonlySubagentState,
  runId?: string,
): InterruptTarget | undefined {
  if (runId !== undefined && runId.length > 0) {
    return requestedTarget(state, runId);
  }
  const newest = newestOwnedTarget(state, newestTrackedTarget(state));
  return newest ? { asyncId: newest.asyncId, asyncDir: newest.asyncDir } : undefined;
}
function failure(text: string): SubagentExecutionResult {
  return {
    content: [{ type: "text", text }],
    isError: true,
    details: { mode: "management", results: [] },
  };
}
function extendable(target: InterruptTarget): boolean {
  const status = readStatus(target.asyncDir);
  if (status) {
    return (
      status.runtimeVersion === 2 &&
      status.state === "running" &&
      status.timedOut !== true &&
      (status.timeoutAt ?? 0) !== 0
    );
  }
  const launch = readRunJson<{ readonly runtimeVersion?: number; readonly timeoutMs?: number }>(
    path.join(target.asyncDir, "launch.json"),
  );
  return launch?.runtimeVersion === 2 && (launch.timeoutMs ?? 0) !== 0;
}
export function extendAsyncTimeoutResult(
  state: ReadonlySubagentState,
  runId: string | undefined,
  extendMs: number,
): SubagentExecutionResult {
  const target = getAsyncInterruptTarget(state, runId);
  if (!target || !extendable(target)) {
    return failure("No live run with an extendable timeout was found. No extension was requested.");
  }
  try {
    writeAsyncControlRequest(target.asyncDir, target.asyncId, "extend", { extendMs });
    return {
      content: [
        {
          type: "text",
          text: `Requested ${extendMs}ms more for run ${target.asyncId}. Inspect status for the owner's updated deadline.`,
        },
      ],
      details: {
        mode: "management",
        results: [],
        managementControl: buildManagementControl({
          state: "live",
          runId: target.asyncId,
          canInterrupt: true,
          canExtend: true,
        }),
      },
    };
  } catch (error) {
    return failure(errorMessage(error));
  }
}
function runningChild(status: ReadonlyAsyncStatus, index: number): boolean {
  return Number.isSafeInteger(index) && index >= 0 && status.steps?.at(index)?.status === "running";
}
function selectedChildError(
  status: ReadonlyAsyncStatus,
  id: string,
  index: number | undefined,
): string | undefined {
  if (index === undefined) {
    return;
  }
  if (status.indexedControl !== true && (status.steps?.length ?? 0) > 1) {
    return "This older runner does not support selected-child stop. No stop was sent; whole-run stop remains an explicit separate action.";
  }
  if (!runningChild(status, index)) {
    return `Async run ${id} has no running child at index ${index}. No siblings were stopped.`;
  }
  return;
}
export function interruptAsyncRun(
  // This control boundary owns the tracked job activity reset after publishing a stop request.
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types
  state: SubagentState,
  runId: string | undefined,
  index?: number,
): SubagentExecutionResult | null {
  const target = getAsyncInterruptTarget(state, runId);
  if (!target) {
    return null;
  }
  const status = readStatus(target.asyncDir);
  if (!status || status.runId !== target.asyncId || status.state !== "running") {
    return failure(
      `No running async run with a matching control channel was found for '${runId ?? "current"}'.`,
    );
  }
  const invalid = selectedChildError(status, target.asyncId, index);
  if (invalid !== undefined) {
    return failure(invalid);
  }
  try {
    writeAsyncInterruptRequest(target.asyncDir, target.asyncId, index);
    const tracked = state.asyncJobs.get(target.asyncId);
    if (tracked) {
      tracked.activityState = undefined;
      tracked.updatedAt = Date.now();
    }
    return {
      content: [
        {
          type: "text",
          text: `Interrupt requested for async run ${target.asyncId}${index !== undefined ? ` child ${index} only` : ""}. Agent and command exit are not yet confirmed.`,
        },
      ],
      details: {
        mode: "management",
        results: [],
        managementControl: buildManagementControl({ state: "live", runId: target.asyncId }),
      },
    };
  } catch (error) {
    return failure(`Failed to interrupt async run ${target.asyncId}: ${errorMessage(error)}`);
  }
}
