import * as path from "node:path";
import { errorMessage } from "../../shared/unknown.ts";
import { listSupervisorQuestions, readQuestionContract } from "../shared/supervisor-questions.ts";
import { deliverSubagentIntercomMessageEvent } from "../../intercom/result-intercom.ts";
import { resolveSubagentRunId } from "../background/run-id-resolver.ts";
import { buildManagementControl, formatRunAction } from "../../shared/status-format.ts";
import { ownedRunView, resolveOwnedRun } from "../shared/run-records.ts";
import type { SubagentExecutionResult, OwnedRun, OwnedRunView } from "../../shared/types.ts";
import type { ExecutorReadDeps, SubagentParamsLike } from "./subagent-params.ts";
import { nestedResolutionScopeForExecutor } from "./execution-routing.ts";
import {
  resolveResumeTarget,
  resolveNestedResumeTarget,
  type ResumeSourceTarget,
} from "./resume-target.ts";
import { LIVE_ACCEPTANCE_OVERRIDE_NOTICE, resumeLiveNestedRun } from "./nested-control.ts";
import { nudgeSubagentRun } from "./run-nudge.ts";
import { reviveSavedSubagent, type RevivalInput, type RevivalTarget } from "./saved-revival.ts";
import { continueQuestionSession } from "./question-continuation.ts";

export { writeAsyncInterruptRequest } from "../background/async-control.ts";
export {
  MUTATING_MANAGEMENT_ACTIONS,
  resolveRequestedCwd,
  nestedResolutionScopeForExecutor,
} from "./execution-routing.ts";
export {
  rememberedForegroundStatusResult,
  resolveRememberedForegroundRun,
} from "./foreground-memory.ts";
export { extendAsyncTimeoutResult, interruptAsyncRun } from "./run-interrupt.ts";
export { interruptNestedRun } from "./nested-control.ts";
export { nudgeSubagentRun } from "./run-nudge.ts";
export { reviveSavedSubagent } from "./saved-revival.ts";

type ReadResumeInput = Readonly<Omit<RevivalInput, "deps">> & { readonly deps: ExecutorReadDeps };
type Resolution =
  | { readonly kind: "result"; readonly result: SubagentExecutionResult }
  | { readonly kind: "target"; readonly target: ResumeSourceTarget };
function failure(text: string): SubagentExecutionResult {
  return {
    content: [{ type: "text", text }],
    isError: true,
    details: { mode: "management", results: [] },
  };
}
function requestedOwnedId(params: SubagentParamsLike): string | undefined {
  const id = params.id ?? params.runId;
  return id !== undefined && id.length > 0 && (params.dir === undefined || params.dir.length === 0)
    ? id
    : undefined;
}
export function liveLaunchOverrideNotice(params: SubagentParamsLike): string | undefined {
  if (params.acceptance !== undefined) {
    return LIVE_ACCEPTANCE_OVERRIDE_NOTICE;
  }
  return [
    params.agent,
    params.model,
    params.cwd,
    params.output,
    params.outputMode,
    params.outputSchema,
    params.skill,
    params.maxOutput,
    params.control,
    params.artifacts,
    params.share,
  ].some((value) => value !== undefined)
    ? "Launch overrides change a newly started continuation, not this live child. No launch settings were changed."
    : undefined;
}
function withLiveNotice(
  result: SubagentExecutionResult,
  params: SubagentParamsLike,
): SubagentExecutionResult {
  const notice = liveLaunchOverrideNotice(params);
  if (notice !== undefined) {
    result.content.push({ type: "text", text: notice });
  }
  return result;
}
function normalizedFollowUp(params: SubagentParamsLike): string {
  return (params.message ?? params.task ?? "").trim();
}
function usesSession(candidate: OwnedRun, deps: ExecutorReadDeps, sessionFile: string): boolean {
  return (
    candidate.children.some((child) => child.sessionFile === sessionFile) ||
    deps.state.asyncJobs.get(candidate.runId)?.sessionFile === sessionFile
  );
}
function nudgeContinuation(
  input: ReadResumeInput,
  runId: string,
  sessionFile: string | undefined,
): Promise<SubagentExecutionResult> | undefined {
  if (sessionFile === undefined || sessionFile.length === 0) {
    return;
  }
  for (const candidate of input.deps.state.ownedRuns?.values() ?? []) {
    if (candidate.runId === runId) {
      continue;
    }
    if (!usesSession(candidate, input.deps, sessionFile)) {
      continue;
    }
    const active = ownedRunView(candidate, input.deps.state, {
      readConfiguration: false,
    }).children.find((child) => child.sessionFile === sessionFile && child.state === "live");
    if (!active) {
      continue;
    }
    return nudgeSubagentRun({
      params: {
        ...input.params,
        dir: undefined,
        id: candidate.runId,
        index: active.index,
        message: normalizedFollowUp(input.params),
      },
      deps: input.deps,
      ctx: input.ctx,
    }).then((result) => withLiveNotice(result, input.params));
  }
  return;
}
async function resumeOwned(
  // Owned continuation may persist a new run; deps retains the actual session mutation owner.
  input: RevivalInput,
  owned: OwnedRun,
): Promise<SubagentExecutionResult> {
  const view = ownedRunView(owned, input.deps.state);
  if (view.children.length > 1 && input.params.index === undefined) {
    throw new Error(
      `Run '${owned.runId}' has ${view.children.length} children. Provide index to choose one.`,
    );
  }
  const child = view.children.find((entry) => entry.index === (input.params.index ?? 0));
  if (!child) {
    throw new Error(`Run '${owned.runId}' has no child at index ${input.params.index ?? 0}.`);
  }
  if (child.state === "live") {
    return withLiveNotice(
      await nudgeSubagentRun({
        params: {
          ...input.params,
          id: owned.runId,
          message: normalizedFollowUp(input.params),
        },
        deps: input.deps,
        ctx: input.ctx,
      }),
      input.params,
    );
  }
  const liveContinuation = nudgeContinuation(input, owned.runId, child.sessionFile);
  if (liveContinuation) {
    return await liveContinuation;
  }
  return reviveSavedSubagent(input, ownedRevivalTarget(owned, child));
}
function ownedRevivalTarget(
  owned: OwnedRun,
  child: OwnedRunView["children"][number],
): RevivalTarget {
  const contract = readQuestionContract(owned.runId, child.index);
  return {
    ...contract,
    runId: owned.runId,
    agent: child.agent,
    index: child.index,
    source: owned.source,
    cwd: child.launch?.cwd ?? owned.cwd,
    sessionFile: child.sessionFile,
    effectiveAcceptance:
      contract?.effectiveAcceptance ?? child.result?.acceptance?.effectiveAcceptance,
    model: child.result?.model,
  };
}
function trustedSessionRoots(
  input: ReadResumeInput,
  parentSessionFile: string | null,
): readonly string[] {
  const roots: string[] = [];
  const configured = input.deps.config.defaultSessionDir;
  if (configured !== undefined && configured.length > 0) {
    roots.push(path.resolve(input.deps.expandTilde(configured)));
  }
  if (parentSessionFile !== null && parentSessionFile.length > 0) {
    roots.push(input.deps.getSubagentSessionRoot(parentSessionFile));
  }
  return roots;
}
function resolveRequestedRun(
  params: SubagentParamsLike,
  deps: ExecutorReadDeps,
): ReturnType<typeof resolveSubagentRunId> {
  const id = params.id ?? params.runId;
  if (id === undefined || id.length === 0) {
    return;
  }
  return resolveSubagentRunId(id, {
    state: deps.state,
    nested: nestedResolutionScopeForExecutor(deps),
  });
}
async function resolveContinuation(
  // Resolution includes question/owned revival, whose durable updates belong to this session owner.
  input: RevivalInput,
  parentSessionFile: string | null,
): Promise<Resolution> {
  const requested = requestedOwnedId(input.params);
  const questions =
    requested !== undefined
      ? listSupervisorQuestions(input.ctx.sessionManager.getSessionId(), requested).filter(
          (question) => question.state === "awaiting_input" || question.state === "answer_pending",
        )
      : [];
  if (questions.length > 0) {
    return { kind: "result", result: continueQuestionSession(input, questions) };
  }
  const owned = requested !== undefined ? resolveOwnedRun(input.deps.state, requested) : undefined;
  if (owned) {
    return { kind: "result", result: await resumeOwned(input, owned) };
  }
  const resolved = resolveRequestedRun(input.params, input.deps);
  if (resolved?.kind !== "nested") {
    return { kind: "target", target: resolveResumeTarget(input.params, input.deps.state) };
  }
  if (resolved.match.run.state === "running" || resolved.match.run.state === "queued") {
    return {
      kind: "result",
      result: await resumeLiveNestedRun({
        target: resolved,
        message: normalizedFollowUp(input.params),
        index: input.params.index,
        acceptanceOverrideSupplied: input.params.acceptance !== undefined,
        pi: input.deps.pi,
        childSafe: nestedResolutionScopeForExecutor(input.deps) !== undefined,
      }),
    };
  }
  return {
    kind: "target",
    target: resolveNestedResumeTarget(resolved, trustedSessionRoots(input, parentSessionFile)),
  };
}
function lookupFailure(
  // Recovery may revive a saved question; the real dependency state remains owned, not frozen.
  input: RevivalInput,
  error: unknown,
): SubagentExecutionResult {
  const message = errorMessage(error),
    requested = requestedOwnedId(input.params);
  const recoverable =
    (error instanceof Error && error.message.startsWith("Async run not found.")) ||
    message.includes("is detached for intercom coordination");
  if (requested !== undefined && recoverable) {
    try {
      const questions = listSupervisorQuestions(input.ctx.sessionManager.getSessionId(), requested);
      if (questions.length > 0) {
        return continueQuestionSession(input, questions);
      }
    } catch (questionError) {
      return failure(errorMessage(questionError));
    }
  }
  return failure(message);
}
async function deliverLiveContinuation(
  input: ReadResumeInput,
  target: Extract<ResumeSourceTarget, { readonly kind: "live" }>,
): Promise<SubagentExecutionResult> {
  const followUp = normalizedFollowUp(input.params);
  const delivered = await deliverSubagentIntercomMessageEvent(
    input.deps.pi.events,
    target.intercomTarget,
    `Follow-up for async run ${target.runId} (${target.agent}):\n\n${followUp}`,
    500,
    { source: "async-resume", runId: target.runId, agent: target.agent, index: target.index },
  );
  if (!delivered) {
    return failure(
      [
        "Async child appears live but its intercom target is not registered.",
        `Run: ${target.runId}`,
        `Intercom target: ${target.intercomTarget}`,
        `Wait for completion, then retry ${formatRunAction("resume", target.runId, { message: "..." }, nestedResolutionScopeForExecutor(input.deps) !== undefined)}.`,
      ].join("\n"),
    );
  }
  const lines = [
    "Delivered follow-up to live async child.",
    `Run: ${target.runId}`,
    `Intercom target: ${target.intercomTarget}`,
  ];
  if (input.params.acceptance !== undefined) {
    lines.push(LIVE_ACCEPTANCE_OVERRIDE_NOTICE);
  }
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: {
      mode: "management",
      results: [],
      managementControl: buildManagementControl({
        state: "live",
        runId: target.runId,
        index: target.index,
        intercomTarget: target.intercomTarget,
        canNudge: true,
        canResume: true,
        canInterrupt: true,
      }),
    },
  };
}
/** Pending question, owned/live continuation, then saved session revival—in that order. */
export async function resumeAsyncRun(
  // Resume owns durable question delivery and newly launched continuation state through its helpers.
  input: RevivalInput,
): Promise<SubagentExecutionResult> {
  if (normalizedFollowUp(input.params).length === 0) {
    return failure("action='resume' requires message.");
  }
  const parentSessionFile = input.ctx.sessionManager.getSessionFile() ?? null;
  let resolution: Resolution;
  try {
    resolution = await resolveContinuation(input, parentSessionFile);
  } catch (error) {
    return lookupFailure(input, error);
  }
  if (resolution.kind === "result") {
    return resolution.result;
  }
  const { target } = resolution;
  if (target.kind === "live") {
    return deliverLiveContinuation(input, target);
  }
  return (
    nudgeContinuation(input, target.runId, target.sessionFile) ?? reviveSavedSubagent(input, target)
  );
}
