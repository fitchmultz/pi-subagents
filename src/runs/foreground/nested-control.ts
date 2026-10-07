import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeAsyncInterruptRequest } from "../background/async-control.ts";
import type { ResolvedSubagentRunId } from "../background/run-id-resolver.ts";
import {
  readNestedControlResults,
  resolveNestedAsyncDir,
  writeNestedControlRequest,
  type NestedControlResultRecord,
} from "../shared/nested-events.ts";
import { readStatus } from "../../shared/utils.ts";
import { buildManagementControl, formatRunAction } from "../../shared/status-format.ts";
import { errorMessage } from "../../shared/unknown.ts";
import { deliverSubagentIntercomMessageEvent } from "../../intercom/result-intercom.ts";
import { resolveSubagentIntercomTarget } from "../../intercom/intercom-bridge.ts";
import type {
  ReadonlyInput,
  ReadonlyAsyncStatus,
  SubagentExecutionResult,
} from "../../shared/types.ts";

export type NestedTarget = Extract<
  ReadonlyInput<ResolvedSubagentRunId>,
  { readonly kind: "nested" }
>;
export const LIVE_ACCEPTANCE_OVERRIDE_NOTICE =
  "Acceptance override applies only to revive and was not applied to this live delivery.";
function failure(text: string): SubagentExecutionResult {
  return {
    content: [{ type: "text", text }],
    isError: true,
    details: { mode: "management", results: [] },
  };
}
async function waitForControl(
  target: NestedTarget,
  requestId: string,
): Promise<NestedControlResultRecord | undefined> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const result = readNestedControlResults(target.match.route).find(
      (candidate) =>
        candidate.requestId === requestId && candidate.targetRunId === target.match.run.id,
    );
    if (result) {
      return result;
    }
    // A response must be observed before the next poll; parallel polls cannot advance this deadline.
    // oxlint-disable-next-line no-await-in-loop
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  return;
}
async function sendControl(
  target: NestedTarget,
  action: "interrupt" | "resume",
  message?: string,
  index?: number,
): Promise<NestedControlResultRecord | undefined> {
  const requestId = randomUUID();
  const child = target.match.run.path.at(0)?.stepIndex ?? target.match.run.parentStepIndex;
  writeNestedControlRequest(target.match.route, {
    ts: Date.now(),
    requestId,
    targetRunId: target.match.run.id,
    ...(child !== undefined ? { targetChildIndex: child } : {}),
    action,
    ...(index !== undefined ? { index } : {}),
    ...(message !== undefined && message.length > 0 ? { message } : {}),
  });
  return waitForControl(target, requestId);
}
function observedAsyncOwner(
  target: NestedTarget,
): { readonly dir: string; readonly status: ReadonlyAsyncStatus } | undefined {
  const dir = resolveNestedAsyncDir(target.match.rootRunId, target.match.run);
  if (dir === undefined || dir.length === 0) {
    return;
  }
  const status = readStatus(dir);
  return status && status.runId === target.match.run.id && status.state === "running"
    ? { dir, status }
    : undefined;
}
function supportsSelectedStop(status: ReadonlyAsyncStatus, index: number | undefined): boolean {
  return index === undefined || status.indexedControl === true || (status.steps?.length ?? 0) <= 1;
}
function directInterrupt(
  target: NestedTarget,
  index?: number,
): SubagentExecutionResult | undefined {
  const run = target.match.run;
  const observed = observedAsyncOwner(target);
  if (!observed || !supportsSelectedStop(observed.status, index)) {
    return;
  }
  const { dir, status } = observed;
  if (index !== undefined && status.steps?.[index]?.status !== "running") {
    return failure(`No running nested child at index ${index}. No siblings were stopped.`);
  }
  try {
    writeAsyncInterruptRequest(dir, run.id, index);
    return {
      content: [{ type: "text", text: `Interrupt requested for nested async run ${run.id}.` }],
      details: {
        mode: "management",
        results: [],
        managementControl: buildManagementControl({
          state: "live",
          runId: run.id,
          intercomTarget: run.intercomTarget ?? run.leafIntercomTarget,
          canInterrupt: true,
        }),
      },
    };
  } catch (error) {
    return failure(`Failed to interrupt nested async run ${run.id}: ${errorMessage(error)}`);
  }
}
function terminalInterrupt(target: NestedTarget): SubagentExecutionResult | undefined {
  const run = target.match.run;
  if (run.state === "complete") {
    return failure(`Nested run ${run.id} is already complete and cannot be interrupted.`);
  }
  if (run.state === "failed") {
    return failure(`Nested run ${run.id} has failed and cannot be interrupted.`);
  }
  if (run.state === "paused") {
    return failure(`Nested run ${run.id} is already paused.`);
  }
  return;
}
function selectedStopUnavailable(
  target: NestedTarget,
  index: number | undefined,
): SubagentExecutionResult | undefined {
  if (index === undefined || target.match.run.indexedControl === true) {
    return;
  }
  return (
    directInterrupt(target, index) ??
    failure(
      "This nested owner does not advertise selected-child stop. No stop was sent; inspect the child or explicitly stop the whole run.",
    )
  );
}
export async function interruptNestedRun(
  target: NestedTarget,
  index?: number,
): Promise<SubagentExecutionResult> {
  const terminal = terminalInterrupt(target);
  if (terminal) {
    return terminal;
  }
  const run = target.match.run;
  const unsupported = selectedStopUnavailable(target, index);
  if (unsupported) {
    return unsupported;
  }
  const result = await sendControl(target, "interrupt", undefined, index);
  if (result?.ok === true) {
    return {
      content: [{ type: "text", text: result.message }],
      details: {
        mode: "management",
        results: [],
        managementControl: buildManagementControl({
          state: "live",
          runId: run.id,
          intercomTarget: run.intercomTarget ?? run.leafIntercomTarget,
          canResume: true,
          canInterrupt: true,
        }),
      },
    };
  }
  return (
    directInterrupt(target, index) ??
    failure(
      result?.message ??
        `Nested run ${run.id} owner is not reachable and no safe direct async interrupt fallback is available.`,
    )
  );
}
interface LiveResumeInput {
  readonly target: NestedTarget;
  readonly message: string;
  readonly index?: number;
  readonly acceptanceOverrideSupplied: boolean;
  readonly pi: ReadonlyInput<Pick<ExtensionAPI, "events">>;
  readonly childSafe: boolean;
}
function liveResult(message: string, override: boolean): SubagentExecutionResult {
  return {
    content: [
      { type: "text", text: override ? `${message}\n${LIVE_ACCEPTANCE_OVERRIDE_NOTICE}` : message },
    ],
    details: { mode: "management", results: [] },
  };
}
function directResumeTarget(input: LiveResumeInput): string | undefined {
  const run = input.target.match.run;
  if (input.index === undefined) {
    return run.leafIntercomTarget ?? run.intercomTarget;
  }
  const dir = resolveNestedAsyncDir(input.target.match.rootRunId, run);
  const selected =
    dir !== undefined && dir.length > 0 ? readStatus(dir)?.steps?.[input.index] : undefined;
  return selected?.status === "running"
    ? resolveSubagentIntercomTarget(run.id, selected.agent, input.index)
    : undefined;
}
export async function resumeLiveNestedRun(
  input: LiveResumeInput,
): Promise<SubagentExecutionResult> {
  const run = input.target.match.run;
  const result = await sendControl(input.target, "resume", input.message, input.index);
  if (result?.ok === true) {
    return liveResult(result.message, input.acceptanceOverrideSupplied);
  }
  const direct = directResumeTarget(input);
  if (direct !== undefined && direct.length > 0) {
    const delivered = await deliverSubagentIntercomMessageEvent(
      input.pi.events,
      direct,
      `Follow-up for nested run ${run.id}:\n\n${input.message}`,
      500,
      {
        source: "nested-resume-fallback",
        runId: run.id,
        agent: run.agent,
        index: input.index ?? run.currentStep,
      },
    );
    if (delivered) {
      return liveResult(
        `Delivered follow-up directly to live nested run ${run.id}.`,
        input.acceptanceOverrideSupplied,
      );
    }
  }
  return failure(
    result?.message ??
      `Nested run ${run.id} appears live but its owner route is not reachable. Wait for completion, then retry ${formatRunAction("resume", run.id, { message: "..." }, input.childSafe)}.`,
  );
}
