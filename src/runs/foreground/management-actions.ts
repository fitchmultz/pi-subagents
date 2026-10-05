import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { handleManagementAction } from "../../agents/agent-management.ts";
import { buildDoctorReport } from "../../extension/doctor.ts";
import {
  resolveIntercomSessionTarget,
  resolveOrchestratorIntercomTarget,
} from "../../intercom/intercom-bridge.ts";
import { queryLiveIntercomHealth, queryLiveIntercomStatus } from "../../intercom/live-intercom.ts";
import { inspectSubagentStatus } from "../background/run-status.ts";
import { resolveSubagentRunId, type ResolvedSubagentRunId } from "../background/run-id-resolver.ts";
import {
  ownedRunList,
  ownedRunStatusResult,
  ownedRunView,
  rememberOwnedRun,
  resolveOwnedRun,
} from "../shared/run-records.ts";
import { ownedHistoryQuery } from "../shared/run-history-queries.ts";
import { errorMessage } from "../../shared/unknown.ts";
import { SUBAGENT_ACTIONS, type SubagentExecutionResult } from "../../shared/types.ts";
import { controlSupervisorQuestion } from "./question-control.ts";
import {
  MUTATING_MANAGEMENT_ACTIONS,
  extendAsyncTimeoutResult,
  interruptAsyncRun,
  interruptNestedRun,
  nestedResolutionScopeForExecutor,
  nudgeSubagentRun,
  rememberedForegroundStatusResult,
  resolveRememberedForegroundRun,
  resumeAsyncRun,
} from "./foreground-control.ts";
import type { ExecutorDeps, SubagentParamsLike } from "./subagent-params.ts";

export interface ManagementInvocation {
  readonly params: SubagentParamsLike;
  readonly requestCwd: string;
  readonly ctx: ExtensionContext;
  readonly signal?: AbortSignal;
}
function failure(error: unknown): SubagentExecutionResult {
  return {
    content: [{ type: "text", text: errorMessage(error) }],
    isError: true,
    details: { mode: "management", results: [] },
  };
}
function present(value: string | undefined): boolean {
  return value !== undefined && value.length > 0;
}
function reviewRequest(params: SubagentParamsLike): {
  readonly id: string;
  readonly decision: "accepted" | "needs_changes";
} {
  const id = params.id ?? params.runId;
  if (
    id === undefined ||
    id.length === 0 ||
    (params.decision !== "accepted" && params.decision !== "needs_changes")
  ) {
    throw new Error("action='review' requires id and decision ('accepted' or 'needs_changes').");
  }
  return { id, decision: params.decision };
}
/** Owns management actions against the current session's durable and tracked run state. */
export class ManagementActions {
  private readonly deps: ExecutorDeps;
  constructor(
    // Reviews and stop requests update this session's actual tracked state and persistence owner.
    deps: ExecutorDeps,
  ) {
    this.deps = deps;
  }
  async execute(call: ManagementInvocation): Promise<SubagentExecutionResult> {
    switch (call.params.action) {
      case "review":
        return this.review(call);
      case "history":
      case "search":
        return this.history(call);
      case "questions":
      case "answer":
        return controlSupervisorQuestion({ ...call, deps: this.deps });
      case "doctor":
        return this.doctor(call);
      case "status":
        return this.status(call);
      case "nudge":
        return nudgeSubagentRun({ params: call.params, deps: this.deps, ctx: call.ctx });
      case "resume":
        return resumeAsyncRun({ ...call, deps: this.deps });
      case "extend":
        return this.extend(call.params);
      case "interrupt":
        return this.interrupt(call.params);
      case undefined:
      default:
        return this.manageAgent(call);
    }
  }
  private review(call: ManagementInvocation): SubagentExecutionResult {
    const { params } = call;
    try {
      const request = reviewRequest(params);
      const run = resolveOwnedRun(this.deps.state, request.id);
      if (!run) {
        throw new Error("Run not found in this parent session.");
      }
      if (ownedRunView(run, this.deps.state).state === "live") {
        throw new Error(
          "The run is still live. Use nudge for guidance, or stop it before reviewing its result.",
        );
      }
      const reviewed = {
        ...run,
        review: {
          decision: request.decision,
          ...(present(params.message) ? { message: params.message } : {}),
          reviewedAt: Date.now(),
        },
      };
      rememberOwnedRun(this.deps.state, reviewed);
      const result = ownedRunStatusResult(reviewed, this.deps.state, undefined, {
        childSafe: nestedResolutionScopeForExecutor(this.deps) !== undefined,
      });
      const tool =
        this.deps.allowMutatingManagementActions === false &&
        this.deps.config.compactChildTools === false
          ? "subagent resume/nudge"
          : "agent_runs continue/nudge";
      return {
        ...result,
        content: [
          {
            type: "text",
            text: `Saved parent review for ${run.runId}: ${request.decision}.\nThe review note is parent-only and was not sent to the child. Put actionable instructions in ${tool}. No work started.`,
          },
        ],
      };
    } catch (error) {
      return failure(error);
    }
  }
  private async history(call: ManagementInvocation): Promise<SubagentExecutionResult> {
    try {
      return await ownedHistoryQuery(this.deps.state, call.params, call.signal);
    } catch (error) {
      return failure(error);
    }
  }
  private doctorSession(ctx: ExtensionContext) {
    let currentSessionFile: string | null = null;
    let currentSessionId = this.deps.state.currentSessionId;
    let sessionError: string | undefined;
    try {
      currentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
      currentSessionId = ctx.sessionManager.getSessionId();
    } catch (error) {
      sessionError =
        error instanceof Error ? `${error.name}: ${error.message}` : errorMessage(error);
    }
    return { currentSessionFile, currentSessionId, sessionError };
  }
  private async doctor(call: ManagementInvocation): Promise<SubagentExecutionResult> {
    const session = this.doctorSession(call.ctx);
    let orchestratorTarget: string | undefined;
    try {
      const fallback = resolveIntercomSessionTarget(
        this.deps.pi.getSessionName(),
        call.ctx.sessionManager.getSessionId(),
      );
      orchestratorTarget = resolveOrchestratorIntercomTarget(this.deps.pi.events, fallback);
    } catch {
      /* Identity lookup is optional; the doctor still reports the other observed session facts. */
    }
    const { connection } = await queryLiveIntercomStatus(this.deps.pi.events);
    return {
      content: [
        {
          type: "text",
          text: buildDoctorReport({
            cwd: call.requestCwd,
            nativeSessionCwd: call.ctx.cwd,
            config: this.deps.config,
            state: this.deps.state,
            requestedSessionDir: call.params.sessionDir,
            ...session,
            orchestratorTarget,
            connection,
            projectTrusted: call.ctx.isProjectTrusted(),
            expandTilde: this.deps.expandTilde,
          }),
        },
      ],
      details: { mode: "management", results: [] },
    };
  }
  private async status(call: ManagementInvocation): Promise<SubagentExecutionResult> {
    const id = call.params.id ?? call.params.runId;
    if (this.isParentListQuery(call.params) && this.deps.state.ownedRuns !== undefined) {
      try {
        return await ownedRunList(this.deps.state, { ...call.params, signal: call.signal });
      } catch (error) {
        return failure(error);
      }
    }
    let includeRunHeader = true;
    try {
      includeRunHeader = this.includeRunHeader(call.params);
    } catch (error) {
      return failure(error);
    }
    const inspected = await this.inspectStatus(call.params, includeRunHeader);
    const remembered = this.statusFallback(id, inspected);
    if (remembered) {
      return remembered;
    }
    return this.isParentListQuery(call.params)
      ? this.appendForegroundStatuses(inspected)
      : inspected;
  }
  private isParentListQuery(params: SubagentParamsLike): boolean {
    return (
      !present(params.id ?? params.runId) &&
      !present(params.dir) &&
      this.deps.allowMutatingManagementActions !== false
    );
  }
  private includeRunHeader(params: SubagentParamsLike): boolean {
    const id = params.id ?? params.runId;
    if (id === undefined || id.length === 0) {
      return true;
    }
    return present(params.dir) || !resolveOwnedRun(this.deps.state, id);
  }
  private async inspectStatus(
    params: SubagentParamsLike,
    includeRunHeader: boolean,
  ): Promise<SubagentExecutionResult> {
    const scope = {
      state: this.deps.state,
      nested: nestedResolutionScopeForExecutor(this.deps),
      includeRunHeader,
    };
    let inspected = inspectSubagentStatus({ ...params, action: "status" }, scope);
    const targets = inspected.details.intercomTargets ?? [];
    if (inspected.isError !== true && targets.length > 0) {
      const intercomHealth = await queryLiveIntercomHealth(this.deps.pi.events, targets);
      if (intercomHealth.size > 0) {
        inspected = inspectSubagentStatus(
          { ...params, action: "status" },
          { ...scope, intercomHealth },
        );
      }
    }
    return inspected;
  }
  private statusFallback(
    id: string | undefined,
    inspected: SubagentExecutionResult,
  ): SubagentExecutionResult | undefined {
    const first = inspected.content.at(0);
    if (
      !present(id) ||
      inspected.isError !== true ||
      first?.type !== "text" ||
      !first.text.startsWith("Async run not found.")
    ) {
      return;
    }
    try {
      const remembered = resolveRememberedForegroundRun(id, this.deps.state);
      return remembered
        ? rememberedForegroundStatusResult(
            remembered,
            nestedResolutionScopeForExecutor(this.deps) !== undefined,
          )
        : undefined;
    } catch (error) {
      return failure(error);
    }
  }
  private appendForegroundStatuses(inspected: SubagentExecutionResult): SubagentExecutionResult {
    const foreground = [...(this.deps.state.foregroundRuns?.values() ?? [])]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((run) => rememberedForegroundStatusResult(run));
    if (foreground.length === 0) {
      return inspected;
    }
    return {
      ...inspected,
      content: [...foreground.flatMap((result) => result.content), ...inspected.content],
      details: {
        ...inspected.details,
        managementControls: [
          ...foreground.flatMap((result) =>
            result.details.managementControl ? [result.details.managementControl] : [],
          ),
          ...(inspected.details.managementControls ?? []),
        ],
      },
    };
  }
  private resolveControlRun(params: SubagentParamsLike): ResolvedSubagentRunId | undefined {
    const id = params.runId ?? params.id;
    return id !== undefined && id.length > 0
      ? resolveSubagentRunId(id, {
          state: this.deps.state,
          nested: nestedResolutionScopeForExecutor(this.deps),
        })
      : undefined;
  }
  private extend(params: SubagentParamsLike): SubagentExecutionResult {
    try {
      const resolved = this.resolveControlRun(params);
      return extendAsyncTimeoutResult(
        this.deps.state,
        resolved?.id ?? params.runId ?? params.id,
        params.extendMs ?? params.timeoutMs ?? params.maxRuntimeMs ?? 0,
      );
    } catch (error) {
      return failure(error);
    }
  }
  private interrupt(
    params: SubagentParamsLike,
  ): Promise<SubagentExecutionResult> | SubagentExecutionResult {
    let resolved: ResolvedSubagentRunId | undefined;
    try {
      resolved = this.resolveControlRun(params);
    } catch (error) {
      return failure(error);
    }
    if (resolved?.kind === "nested") {
      return interruptNestedRun(resolved, params.index);
    }
    return (
      interruptAsyncRun(
        this.deps.state,
        resolved?.kind === "async" ? resolved.id : (params.runId ?? params.id),
        params.index,
      ) ?? failure("No interrupt-capable run found in this session.")
    );
  }
  private manageAgent(
    call: ManagementInvocation,
  ): Promise<SubagentExecutionResult> | SubagentExecutionResult {
    const action = call.params.action ?? "";
    if (!SUBAGENT_ACTIONS.some((candidate) => candidate === action)) {
      return failure(`Unknown action: ${action}. Valid: ${SUBAGENT_ACTIONS.join(", ")}`);
    }
    if (
      this.deps.allowMutatingManagementActions === false &&
      MUTATING_MANAGEMENT_ACTIONS.has(action)
    ) {
      return failure(`Action '${action}' is not available from child-safe subagent fanout mode.`);
    }
    return handleManagementAction(action, call.params, { ...call.ctx, cwd: call.requestCwd });
  }
}
