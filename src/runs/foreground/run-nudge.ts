import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveSubagentIntercomTarget } from "../../intercom/intercom-bridge.ts";
import { sendLiveSubagentMessage } from "../../intercom/live-intercom.ts";
import { resolveAsyncResumeTarget } from "../background/async-resume.ts";
import { resolveSubagentRunId } from "../background/run-id-resolver.ts";
import { inspectSubagentStatus } from "../background/run-status.ts";
import { ownedRunStatusResult, ownedRunView, resolveOwnedRun } from "../shared/run-records.ts";
import { buildManagementControl, formatRunAction } from "../../shared/status-format.ts";
import { errorMessage } from "../../shared/unknown.ts";
import type {
  NestedRunSummary,
  ManagementRunState,
  OwnedRun,
  SubagentExecutionResult,
} from "../../shared/types.ts";
import { nestedResolutionScopeForExecutor } from "./execution-routing.ts";
import {
  rememberedForegroundStatusResult,
  resolveRememberedForegroundRun,
} from "./foreground-memory.ts";
import { getAsyncInterruptTarget } from "./run-interrupt.ts";
import type { ExecutorReadDeps, SubagentParamsLike } from "./subagent-params.ts";

type Target = {
  readonly kind: "target";
  readonly runId: string;
  readonly agent: string;
  readonly index: number;
  readonly target: string;
};
type Resolution = Target | { readonly kind: "result"; readonly result: SubagentExecutionResult };
function resolvedResult(result: SubagentExecutionResult): Resolution {
  return { kind: "result", result };
}
function failure(text: string): SubagentExecutionResult {
  return {
    content: [{ type: "text", text }],
    isError: true,
    details: { mode: "management", results: [] },
  };
}
function terminalOwnedNudge(
  owned: OwnedRun,
  deps: ExecutorReadDeps,
): SubagentExecutionResult | undefined {
  const result = ownedRunStatusResult(owned, deps.state, undefined, {
    childSafe: nestedResolutionScopeForExecutor(deps) !== undefined,
  });
  const state = result.details.run?.state;
  if (state === undefined || state === "live") {
    return;
  }
  const outcome = state === "unknown" ? "completion is unconfirmed" : `run is already ${state}`;
  return {
    ...result,
    content: [
      {
        type: "text",
        text: `Nudge not sent: ${outcome}. No child was restarted.\n\n${result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n")}`,
      },
    ],
  };
}
function terminalNudgeResult(
  runId: string,
  deps: ExecutorReadDeps,
): SubagentExecutionResult | undefined {
  const owned = resolveOwnedRun(deps.state, runId);
  const childSafe = nestedResolutionScopeForExecutor(deps) !== undefined;
  if (owned) {
    return terminalOwnedNudge(owned, deps);
  }
  const remembered = deps.state.foregroundRuns?.get(runId);
  const result = remembered
    ? rememberedForegroundStatusResult(remembered, childSafe)
    : inspectSubagentStatus(
        { id: runId },
        { state: deps.state, nested: nestedResolutionScopeForExecutor(deps) },
      );
  const state = result.details.managementControl?.state;
  if (result.isError === true || state === undefined || state === "live" || state === "unknown") {
    return;
  }
  return {
    ...result,
    content: [
      {
        type: "text",
        text: `Nudge not sent: run is already ${state}. No child was restarted.\n\n${result.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")}`,
      },
    ],
  };
}
function ownedTarget(
  run: OwnedRun,
  params: SubagentParamsLike,
  deps: ExecutorReadDeps,
): Resolution {
  const terminal = terminalNudgeResult(run.runId, deps);
  if (terminal) {
    return resolvedResult(terminal);
  }
  const children = ownedRunView(run, deps.state).children.filter(
    (child) =>
      child.state === "live" && (params.index === undefined || params.index === child.index),
  );
  const child = children.at(0);
  if (children.length !== 1 || !child) {
    throw new Error(
      `Run '${run.runId}' has ${children.length} matching live children. Provide index to choose one.`,
    );
  }
  if (child.activity?.status === "pending") {
    throw new Error(
      `Child ${child.index} is waiting to start in run ${run.runId}. No message was sent and no continuation was started.`,
    );
  }
  return {
    kind: "target",
    runId: run.runId,
    agent: child.agent,
    index: child.index,
    target: resolveSubagentIntercomTarget(run.runId, child.agent, child.index),
  };
}
function nestedState(run: NestedRunSummary): ManagementRunState {
  switch (run.state) {
    case "running":
    case "queued":
      return "live";
    case "complete":
      return "completed";
    case "paused":
    case "blocked":
    case "failed":
      return run.state;
  }
}
function nestedNudgeResult(run: NestedRunSummary, deps: ExecutorReadDeps): SubagentExecutionResult {
  const state = nestedState(run),
    childSafe = nestedResolutionScopeForExecutor(deps) !== undefined;
  const intercomTarget = run.intercomTarget ?? run.leafIntercomTarget;
  const resumable =
    state === "live" || (run.sessionFile !== undefined && run.sessionFile.length > 0);
  const valid = [formatRunAction("status", run.id, {}, childSafe)];
  if (resumable) {
    valid.push(formatRunAction("resume", run.id, { message: "..." }, childSafe));
  }
  if (state === "live") {
    valid.push(formatRunAction("interrupt", run.id, {}, childSafe));
  }
  const address =
    intercomTarget !== undefined && intercomTarget.length > 0
      ? `. Intercom target: ${intercomTarget}`
      : ".";
  return {
    content: [
      {
        type: "text",
        text: `Nested run ${run.id} cannot be nudged. Valid actions: ${valid.join(" or ")}${address}`,
      },
    ],
    isError: true,
    details: {
      mode: "management",
      results: [],
      managementControl: buildManagementControl({
        state,
        runId: run.id,
        intercomTarget,
        canNudge: false,
        canResume: resumable,
        canInterrupt: state === "live",
        unavailableActions: {
          nudge:
            "Nested runs do not support nudge; use an advertised exact action or intercom target.",
        },
      }),
    },
  };
}
function unownedTarget(params: SubagentParamsLike, deps: ExecutorReadDeps): Resolution {
  const requested = params.id ?? params.runId;
  const resolved = resolveNudgeId(requested, deps);
  const remembered = rememberedNudgeRun(requested, resolved !== undefined, deps);
  const resolvedId = resolved?.id ?? remembered?.runId;
  const terminal = resolvedId !== undefined ? terminalNudgeResult(resolvedId, deps) : undefined;
  if (terminal) {
    return resolvedResult(terminal);
  }
  if (resolved?.kind === "nested") {
    return resolvedResult(nestedNudgeResult(resolved.match.run, deps));
  }
  if (remembered) {
    return resolvedResult(
      rememberedForegroundStatusResult(
        remembered,
        nestedResolutionScopeForExecutor(deps) !== undefined,
      ),
    );
  }
  return resolveAsyncNudge(params, deps, resolvedId);
}
function resolveNudgeId(
  requested: string | undefined,
  deps: ExecutorReadDeps,
): ReturnType<typeof resolveSubagentRunId> {
  if (requested === undefined || requested.length === 0) {
    return;
  }
  return resolveSubagentRunId(requested, {
    state: deps.state,
    nested: nestedResolutionScopeForExecutor(deps),
  });
}
function rememberedNudgeRun(
  requested: string | undefined,
  resolved: boolean,
  deps: ExecutorReadDeps,
): ReturnType<typeof resolveRememberedForegroundRun> {
  if (resolved || requested === undefined || requested.length === 0) {
    return;
  }
  return resolveRememberedForegroundRun(requested, deps.state);
}
function resolveAsyncNudge(
  params: SubagentParamsLike,
  deps: ExecutorReadDeps,
  resolvedId: string | undefined,
): Resolution {
  try {
    return asyncTarget(params, deps);
  } catch (error) {
    return resolvedResult(
      (resolvedId !== undefined ? terminalNudgeResult(resolvedId, deps) : undefined) ??
        failure(errorMessage(error)),
    );
  }
}
function asyncTarget(params: SubagentParamsLike, deps: ExecutorReadDeps): Resolution {
  const requested = params.id ?? params.runId;
  const target = resolveAsyncResumeTarget({
    id:
      params.id ??
      (requested === undefined || requested.length === 0
        ? getAsyncInterruptTarget(deps.state)?.asyncId
        : undefined),
    runId: params.runId,
    dir: params.dir,
    index: params.index,
  });
  if (target.kind !== "live") {
    return resolvedResult(
      terminalNudgeResult(target.runId, deps) ??
        inspectSubagentStatus(
          { id: target.runId },
          { state: deps.state, nested: nestedResolutionScopeForExecutor(deps) },
        ),
    );
  }
  return {
    kind: "target",
    runId: target.runId,
    agent: target.agent,
    index: target.index,
    target: target.intercomTarget,
  };
}
function resolveOwnedNudge(
  params: SubagentParamsLike,
  deps: ExecutorReadDeps,
): OwnedRun | undefined {
  if (params.dir !== undefined && params.dir.length > 0) {
    return;
  }
  const requested =
    params.id ?? params.runId ?? getAsyncInterruptTarget(deps.state)?.asyncId ?? "latest";
  return resolveOwnedRun(deps.state, requested);
}
function resolveNudge(params: SubagentParamsLike, deps: ExecutorReadDeps): Resolution {
  let runId: string | undefined;
  try {
    const owned = resolveOwnedNudge(params, deps);
    runId = owned?.runId;
    return owned ? ownedTarget(owned, params, deps) : unownedTarget(params, deps);
  } catch (error) {
    return resolvedResult(
      (runId !== undefined ? terminalNudgeResult(runId, deps) : undefined) ??
        failure(errorMessage(error)),
    );
  }
}
/** Resolve only live ownership, send once, then re-check terminal facts if delivery failed. */
export async function nudgeSubagentRun(input: {
  readonly params: SubagentParamsLike;
  readonly deps: ExecutorReadDeps;
  readonly ctx?: ExtensionContext;
}): Promise<SubagentExecutionResult> {
  const resolution = resolveNudge(input.params, input.deps);
  if (resolution.kind === "result") {
    return resolution.result;
  }
  const { runId, agent, index, target } = resolution;
  const requestedMessage = input.params.message?.trim() ?? "";
  const message =
    requestedMessage.length > 0
      ? requestedMessage
      : "What are you blocked on? Reply with the smallest next step, or state the exact decision you need.";
  const result = await sendLiveSubagentMessage(input.deps.pi.events, {
    to: target,
    message: `Nudge for subagent run ${runId} (${agent} step ${index + 1}):\n\n${message}`,
    delivery: "steer",
    extra: { source: "subagent-nudge", runId, agent, index },
  });
  if (!result.delivered) {
    const terminal = terminalNudgeResult(runId, input.deps);
    if (terminal) {
      return terminal;
    }
    const lines = ["Nudge was not delivered.", `Run: ${runId}`, `Intercom target: ${target}`];
    if (result.reason !== undefined && result.reason.length > 0) {
      lines.push(`Reason: ${result.reason}`);
    }
    return failure(lines.join("\n"));
  }
  return {
    content: [
      {
        type: "text",
        text: [
          "Nudge delivered to live subagent.",
          `Run: ${runId}`,
          `Agent: ${agent}`,
          `Intercom target: ${target}`,
        ].join("\n"),
      },
    ],
    details: {
      mode: "management",
      results: [],
      managementControl: buildManagementControl({
        state: "live",
        runId,
        index,
        intercomTarget: target,
        canNudge: true,
        canResume: true,
        canInterrupt: true,
      }),
    },
  };
}
