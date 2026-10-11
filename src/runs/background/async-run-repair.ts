import * as fs from "node:fs";
import * as path from "node:path";
import { readOutputPage } from "../../shared/journal-reader.ts";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import {
  RUNNER_ERROR_LOG_FILE,
  type AsyncResultChild,
  type AsyncResultTerminalState,
  type AsyncStatus,
} from "../../shared/types.ts";
import type { ReadonlyInput } from "../../shared/types/inputs.ts";
import { isDurableRun, readAsyncResultFileIfExists } from "./async-result-file.ts";
import { errorCode, hasText } from "./async-value.ts";

type StatusStep = NonNullable<AsyncStatus["steps"]>[number];

function childState(
  overall: AsyncResultTerminalState,
  child: ReadonlyInput<AsyncResultChild> | undefined,
): AsyncResultTerminalState {
  if (child === undefined) {
    return overall;
  }
  if (child.success === true) {
    return "complete";
  }
  if (child.interrupted === true) {
    return "paused";
  }
  if (
    child.acceptance?.status === "blocked" &&
    (child.exitCode === 0 || child.exitCode === undefined)
  ) {
    return "blocked";
  }
  return child.success === false ? "failed" : overall;
}

function clearedActivity(): {
  readonly activityState: undefined;
  readonly currentTool: undefined;
  readonly currentToolArgs: undefined;
  readonly currentToolStartedAt: undefined;
  readonly currentPath: undefined;
} {
  return {
    activityState: undefined,
    currentTool: undefined,
    currentToolArgs: undefined,
    currentToolStartedAt: undefined,
    currentPath: undefined,
  };
}

function childRepairFields(
  step: ReadonlyInput<StatusStep>,
  child: ReadonlyInput<AsyncResultChild> | undefined,
): Pick<
  StatusStep,
  "sessionFile" | "model" | "attemptedModels" | "modelAttempts" | "acceptance" | "agentProcessExit"
> {
  const result: ReadonlyInput<AsyncResultChild> = child ?? {};
  return {
    sessionFile: step.sessionFile ?? result.sessionFile,
    model: step.model ?? result.model,
    attemptedModels: step.attemptedModels ?? result.attemptedModels,
    modelAttempts: step.modelAttempts ?? result.modelAttempts,
    acceptance: step.acceptance ?? result.acceptance,
    agentProcessExit: step.agentProcessExit ?? result.agentProcessExit,
  };
}

function repairedOutcome(
  step: ReadonlyInput<StatusStep>,
  child: ReadonlyInput<AsyncResultChild> | undefined,
  state: AsyncResultTerminalState,
  now: number,
): Pick<StatusStep, "status" | "endedAt" | "durationMs" | "exitCode" | "error"> {
  return {
    status: state,
    endedAt: step.endedAt ?? now,
    durationMs: duration(step, now),
    exitCode: step.exitCode ?? (state === "failed" ? 1 : 0),
    error: state === "failed" ? (step.error ?? child?.error) : step.error,
  };
}

function repairedStep(
  step: ReadonlyInput<StatusStep>,
  child: ReadonlyInput<AsyncResultChild> | undefined,
  repair: {
    readonly state: AsyncResultTerminalState;
    readonly now: number;
    readonly durable: boolean;
  },
): StatusStep {
  if (step.status !== "running" && step.status !== "pending") {
    return { ...step, ...clearedActivity() };
  }
  if (repair.durable && step.status === "pending" && child === undefined) {
    return { ...step, ...clearedActivity() };
  }
  const state = childState(repair.state, child);
  return {
    ...step,
    ...clearedActivity(),
    ...repairedOutcome(step, child, state, repair.now),
    ...childRepairFields(step, child),
  };
}

function duration(step: ReadonlyInput<StatusStep>, now: number): number | undefined {
  return step.startedAt !== undefined && step.durationMs === undefined
    ? Math.max(0, now - step.startedAt)
    : step.durationMs;
}

export function terminalStatusFromResult(
  status: ReadonlyInput<AsyncStatus>,
  resultPath: string,
  now: number,
): AsyncStatus | undefined {
  const data = readAsyncResultFileIfExists(resultPath);
  if (!data) {
    return undefined;
  }
  const endedAt = data.timestamp ?? now;
  const repair = { state: data.terminalState, now: endedAt, durable: isDurableRun(status) };
  const steps = (status.steps ?? []).map((step, index) =>
    repairedStep(step, data.results?.[index], repair),
  );
  return {
    ...status,
    ...clearedActivity(),
    state: data.terminalState,
    lastUpdate: endedAt,
    endedAt: status.endedAt ?? endedAt,
    steps,
  };
}

function completedOutput(asyncDir: string, index: number): string {
  try {
    return readOutputPage(path.join(asyncDir, `output-${index}.log`)).text.trim();
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return "";
    }
    throw error;
  }
}

const STDERR_BYTES = 16 * 1024;
// Render untrusted runner stderr without terminal control sequences; preserve tabs/newlines.
// oxlint-disable-next-line no-control-regex
const UNSAFE_CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

function runnerStderr(asyncDir: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(path.join(asyncDir, RUNNER_ERROR_LOG_FILE), "r");
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, STDERR_BYTES);
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(fd, buffer, 0, length, Math.max(0, size - length));
    const excerpt = buffer
      .subarray(0, read)
      .toString("utf-8")
      .replace(UNSAFE_CONTROL_CHARACTERS, "�")
      .trim();
    if (excerpt.length === 0) {
      return undefined;
    }
    return size > length
      ? `[runner stderr truncated to last ${length} bytes]\n${excerpt}`
      : excerpt;
  } catch {
    // Missing stderr must not prevent recording the runner's unconfirmed completion.
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Diagnostics cannot mask recovery if the descriptor was already closed.
      }
    }
  }
}

function isNotQueued(value: string): boolean {
  return value !== "queued";
}

function failedStep(step: ReadonlyInput<StatusStep>, now: number, message: string): StatusStep {
  if (step.status !== "running" && isNotQueued(step.status) && step.status !== "pending") {
    return { ...step, ...clearedActivity() };
  }
  return {
    ...step,
    ...clearedActivity(),
    status: "failed",
    endedAt: step.endedAt ?? now,
    durationMs: duration(step, now),
    exitCode: step.exitCode ?? 1,
    error: step.error ?? message,
  };
}

function resultChildren(
  steps: ReadonlyInput<StatusStep[]>,
  asyncDir: string,
  message: string,
): AsyncResultChild[] {
  return steps.map((step, index) => {
    const success = step.status === "complete" || step.status === "completed";
    return {
      agent: step.agent,
      output: success ? completedOutput(asyncDir, index) : message,
      error: success ? undefined : (step.error ?? message),
      success,
      model: step.model,
      attemptedModels: step.attemptedModels,
      modelAttempts: step.modelAttempts,
      sessionFile: step.sessionFile,
    };
  });
}

function repairResultAgent(
  status: ReadonlyInput<AsyncStatus>,
  steps: ReadonlyInput<StatusStep[]>,
): string {
  return steps.at(status.currentStep ?? 0)?.agent ?? steps.at(0)?.agent ?? "subagent";
}

export function buildFailedRepair(
  status: ReadonlyInput<AsyncStatus>,
  asyncDir: string,
  now: number,
  reason?: string,
): { readonly status: AsyncStatus; readonly result: object; readonly message: string } {
  const runId = status.runId.length > 0 ? status.runId : path.basename(asyncDir);
  const pid = typeof status.pid === "number" ? status.pid : "unknown";
  const defaultMessage = `Async runner process ${pid} exited or disappeared before writing a result. Completion is unconfirmed.`;
  const stderr = hasText(reason) ? undefined : runnerStderr(asyncDir);
  const message =
    reason ?? (hasText(stderr) ? `${defaultMessage}\n\nRunner stderr:\n${stderr}` : defaultMessage);
  const steps: ReadonlyInput<StatusStep[]> =
    (status.steps?.length ?? 0) > 0
      ? (status.steps ?? [])
      : [{ agent: "subagent", status: "running" }];
  const repairedSteps = steps.map((step) => failedStep(step, now, message));
  const repairedStatus: AsyncStatus = {
    ...status,
    ...clearedActivity(),
    state: "failed",
    lastUpdate: now,
    endedAt: now,
    steps: repairedSteps,
  };
  return {
    status: repairedStatus,
    message,
    result: {
      id: runId,
      agent: repairResultAgent(status, repairedSteps),
      mode: status.mode,
      success: false,
      state: "failed",
      summary: message,
      results: resultChildren(repairedSteps, asyncDir, message),
      exitCode: 1,
      timestamp: now,
      durationMs: Math.max(0, now - status.startedAt),
      asyncDir,
      sessionId: status.sessionId,
      cwd: status.cwd,
      sessionFile: status.sessionFile,
    },
  };
}

export function writeFailedRepair(
  asyncDir: string,
  status: ReadonlyInput<AsyncStatus>,
  resultPath: string,
  repairOptions: { readonly now: number; readonly reason?: string },
): {
  readonly status: AsyncStatus;
  readonly repaired: boolean;
  readonly resultPath: string;
  readonly message: string;
} {
  const repair = buildFailedRepair(status, asyncDir, repairOptions.now, repairOptions.reason);
  // Result publication precedes status and the journaled repair event.
  writeAtomicJson(resultPath, repair.result);
  writeAtomicJson(path.join(asyncDir, "status.json"), repair.status);
  const eventsPath = path.join(asyncDir, "events.jsonl");
  fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
  fs.appendFileSync(
    eventsPath,
    `${JSON.stringify({ type: "subagent.run.repaired_stale", ts: repairOptions.now, runId: repair.status.runId, pid: status.pid, resultPath, message: repair.message })}\n`,
    "utf-8",
  );
  return { status: repair.status, repaired: true, resultPath, message: repair.message };
}
