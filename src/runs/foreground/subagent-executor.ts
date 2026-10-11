import { resolveExecutionCwd } from "../../shared/execution-cwd.ts";
import { errorMessage } from "../../shared/unknown.ts";
import { ownedRunStatusResult, resolveOwnedRun } from "../shared/run-records.ts";
import type { SubagentExecutionResult } from "../../shared/types.ts";
import type { ExecutorDeps, SubagentParamsLike } from "./subagent-params.ts";
import { nestedResolutionScopeForExecutor, resolveRequestedCwd } from "./execution-routing.ts";
import { cancelSupervisorInput, projectSupervisorQuestions } from "./question-control.ts";
import { waitForOwnedRun } from "./wait-run.ts";
import { ManagementActions } from "./management-actions.ts";
import { InvocationExecution, type ExecutionInvocation } from "./invocation-execution.ts";

export type { SubagentParamsLike } from "./subagent-params.ts";
export { normalizeSubagentParamsLike, resolveAsyncExecutionMode } from "./subagent-params.ts";
export { writeAsyncInterruptRequest } from "./foreground-control.ts";

export interface SubagentExecutionRequest extends Omit<ExecutionInvocation, "invocationCwd"> {
  readonly toolCallId: string;
  readonly executionCwd?: string;
}
interface WaitTarget {
  readonly id: string;
  readonly index?: number;
}
function present(value: string | undefined): boolean {
  return value !== undefined && value.length > 0;
}
function needsExecutionCwd(params: SubagentParamsLike): boolean {
  return (
    !present(params.action) ||
    params.cwd !== undefined ||
    ["list", "get", "create", "update", "delete", "doctor"].some(
      (action) => action === params.action,
    )
  );
}
function waitsForReceipt(params: SubagentParamsLike): boolean {
  return params.async === false && (params.action === "resume" || params.action === "answer");
}
type ReceiptQuestion = NonNullable<SubagentExecutionResult["details"]["questions"]>[number];
function receiptQuestion(result: SubagentExecutionResult): ReceiptQuestion | undefined {
  return result.details.questions?.find(
    (entry) => entry.delivery !== undefined || entry.state === "answer_pending",
  );
}
function launchReceiptId(result: SubagentExecutionResult): string | undefined {
  return result.details.asyncId ?? result.details.managementControl?.runId;
}
function questionReceiptId(question: ReceiptQuestion | undefined): string | undefined {
  return question?.delivery?.runId ?? question?.runId;
}
function pendingReceiptIndex(result: SubagentExecutionResult): number | undefined {
  return result.details.managementControl?.nextActions.find((action) => action.index !== undefined)
    ?.index;
}
function receiptIndex(
  result: SubagentExecutionResult,
  question: ReceiptQuestion | undefined,
  params: SubagentParamsLike,
): number | undefined {
  if (present(result.details.asyncId) || question?.delivery?.kind === "revive") {
    return 0;
  }
  return pendingReceiptIndex(result) ?? question?.index ?? params.index;
}
function receiptTarget(
  result: SubagentExecutionResult,
  params: SubagentParamsLike,
): WaitTarget | undefined {
  const question = receiptQuestion(result);
  const id = launchReceiptId(result) ?? questionReceiptId(question) ?? params.id ?? params.runId;
  if (id === undefined || id.length === 0) {
    return;
  }
  return { id, index: receiptIndex(result, question, params) };
}
/** Owns invocation/session preparation and foreground waiting; domain owners handle management and launch. */
class ForegroundExecutor {
  private readonly deps: ExecutorDeps;
  private readonly management: ManagementActions;
  private readonly launch: InvocationExecution;
  constructor(
    // Native tool invocation owns session state preparation and run/wait lifecycle through these dependencies.
    deps: ExecutorDeps,
  ) {
    this.deps = deps;
    this.management = new ManagementActions(deps);
    this.launch = new InvocationExecution(deps);
  }
  async execute(call: SubagentExecutionRequest): Promise<SubagentExecutionResult> {
    const waiting = waitsForReceipt(call.params);
    const before = waiting ? new Set(this.deps.state.ownedRuns?.keys()) : undefined;
    const result = await this.invoke(call);
    // Launch/answer receipts are durable before waiting; wait failure cannot undo an accepted launch.
    if (waiting && result.isError !== true) {
      const target = receiptTarget(result, call.params);
      if (target) {
        return this.waitForReceipt(call, target, before);
      }
    }
    return this.projectAction(result, call);
  }
  private async invoke(call: SubagentExecutionRequest): Promise<SubagentExecutionResult> {
    const needsCwd = needsExecutionCwd(call.params);
    const cwd = needsCwd
      ? (call.executionCwd ?? resolveExecutionCwd(this.deps.pi, call.ctx))
      : call.ctx.cwd;
    await this.deps.ensureSessionState?.(call.ctx);
    const state = this.deps.state;
    if (needsCwd) {
      state.baseCwd = cwd;
    }
    state.foregroundRuns ??= new Map();
    const requestCwd = resolveRequestedCwd(cwd, call.params.cwd);
    const params =
      call.params.cwd === undefined ? call.params : { ...call.params, cwd: requestCwd };
    if (present(params.action)) {
      return this.management.execute({ params, requestCwd, ctx: call.ctx, signal: call.signal });
    }
    return this.launch.execute({
      params,
      invocationCwd: cwd,
      ctx: call.ctx,
      signal: call.signal,
      onUpdate: call.onUpdate,
    });
  }
  private waitForReceipt(
    call: SubagentExecutionRequest,
    target: WaitTarget,
    before: Readonly<ReadonlySet<string>> | undefined,
  ): Promise<SubagentExecutionResult> {
    const newlyLaunched =
      before?.has(target.id) !== true && this.deps.state.ownedRuns?.has(target.id) === true;
    return waitForOwnedRun({
      ...target,
      deps: this.deps,
      ctx: call.ctx,
      signal: call.signal,
      onUpdate: call.onUpdate,
      cancelNewRun: call.params.async === false && newlyLaunched,
      executionResult: true,
      includeProgress: call.params.includeProgress,
    });
  }
  private projectAction(
    result: SubagentExecutionResult,
    call: SubagentExecutionRequest,
  ): SubagentExecutionResult {
    const { params, ctx } = call;
    if (params.action === "interrupt") {
      return cancelSupervisorInput(
        result,
        params,
        ctx.sessionManager.getSessionId(),
        this.deps.pi.events,
      );
    }
    if (params.action !== "status" || result.details.runList) {
      return result;
    }
    let projected: SubagentExecutionResult;
    try {
      projected = this.projectOwnedStatus(result, params);
    } catch (error) {
      return {
        content: [{ type: "text", text: errorMessage(error) }],
        isError: true,
        details: { mode: "management", results: [] },
      };
    }
    return projectSupervisorQuestions(
      projected,
      params,
      ctx.sessionManager.getSessionId(),
      nestedResolutionScopeForExecutor(this.deps) !== undefined,
    );
  }
  private projectOwnedStatus(
    result: SubagentExecutionResult,
    params: SubagentParamsLike,
  ): SubagentExecutionResult {
    const requested = params.id ?? params.runId;
    if (requested === undefined || requested.length === 0 || present(params.dir)) {
      return result;
    }
    const owned = resolveOwnedRun(this.deps.state, requested);
    return owned
      ? ownedRunStatusResult(owned, this.deps.state, result, {
          full: params.full,
          childSafe: nestedResolutionScopeForExecutor(this.deps) !== undefined,
        })
      : result;
  }
}
export function createSubagentExecutor(
  // This factory transfers the actual session mutation owner to the native executor and its domain owners.
  deps: ExecutorDeps,
): { execute: (request: SubagentExecutionRequest) => Promise<SubagentExecutionResult> } {
  const owner = new ForegroundExecutor(deps);
  return {
    execute: async (request) => owner.execute(request),
  };
}
