import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getArtifactsDir } from "../../shared/artifacts.ts";
import { isParallelStep, isDynamicParallelStep } from "../../shared/settings.ts";
import { createPerAgentForkContextResolver } from "../../shared/agent-context-policy.ts";
import { resolveCurrentSessionId } from "../../shared/session-identity.ts";
import {
  resolveIntercomBridge,
  resolveIntercomSessionTarget,
  resolveOrchestratorIntercomTarget,
  type IntercomBridgeState,
} from "../../intercom/intercom-bridge.ts";
import { resolveControlConfig } from "../shared/subagent-control.ts";
import { createNestedRoute, resolveInheritedNestedRouteFromEnv } from "../shared/nested-events.ts";
import { applyForceTopLevelAsyncOverride } from "../background/top-level-async.ts";
import { saveQuestionOwner } from "../shared/supervisor-questions.ts";
import { buildWorkflowGraphSnapshot, workflowAgentNodes } from "../shared/workflow-graph.ts";
import { rememberOwnedRun, workflowChildren } from "../shared/run-records.ts";
import { errorMessage } from "../../shared/unknown.ts";
import {
  type SubagentExecutionResult,
  type SubagentExecutionUpdateCallback,
  type SubagentRunMode,
  type ReadonlyInput,
  checkSubagentDepth,
} from "../../shared/types.ts";
import {
  type ExecutionContextData,
  type ExecutorDeps,
  type SubagentParamsLike,
  resolveAsyncExecutionMode,
} from "./subagent-params.ts";
import {
  buildRequestedModeError,
  normalizeRepeatedParallelCounts,
  normalizeRoleForegroundTimeout,
  resolveForegroundTimeoutMs,
  toExecutionErrorResult,
  validateExecutionInput,
  withForkContext,
} from "./execution-input.ts";
import { runAsyncPath } from "./run-async-path.ts";
import { canClarifyInvocation, clarifyInvocation } from "./clarify-invocation.ts";
import { waitForOwnedRun } from "./wait-run.ts";

export interface ExecutionInvocation {
  readonly params: SubagentParamsLike;
  readonly invocationCwd: string;
  readonly ctx: ExtensionContext;
  readonly signal?: AbortSignal;
  readonly onUpdate?: SubagentExecutionUpdateCallback;
}
import {
  discoverInvocation,
  validateInvocationForkModel,
  type AgentInvocation,
} from "./invocation-context.ts";
interface LaunchPreparation {
  readonly call: ExecutionInvocation;
  readonly params: SubagentParamsLike;
  readonly cwd: string;
  readonly parentSessionFile: string | null;
  readonly agents: AgentInvocation;
  readonly runId: string;
  readonly intercomBridge: Readonly<IntercomBridgeState>;
  readonly nestedRoute: NonNullable<ExecutionContextData["nestedRoute"]>;
}
interface SessionLayout {
  readonly root: string;
  readonly dir: (index?: number) => string;
}
interface LaunchResources {
  readonly sessions: Readonly<ReturnType<typeof createPerAgentForkContextResolver>>;
  readonly policy: AsyncPolicy;
  readonly layout: SessionLayout;
  readonly artifactsDir: string;
  readonly controlConfig: ExecutionContextData["controlConfig"];
}
type Assignments = readonly {
  readonly agent: string;
  readonly task?: string;
  readonly label?: string;
}[];
interface AsyncPolicy {
  readonly backgroundRequestedWhileClarifying: boolean;
  readonly effectiveAsync: boolean;
  readonly foregroundTimeoutMs?: number;
}
function mode(params: SubagentParamsLike): SubagentRunMode {
  if ((params.chain?.length ?? 0) > 0) {
    return "chain";
  }
  if ((params.tasks?.length ?? 0) > 0) {
    return "parallel";
  }
  return "single";
}
function invocationModes(params: SubagentParamsLike, ctx: ExtensionContext) {
  const hasChain = (params.chain?.length ?? 0) > 0,
    hasTasks = (params.tasks?.length ?? 0) > 0;
  return {
    hasChain,
    hasTasks,
    hasSingle: !hasChain && !hasTasks && params.agent !== undefined && params.agent.length > 0,
    allowClarifyTaskPrompt: hasChain && canClarifyInvocation(params, ctx),
  };
}
/** Owns launch planning and its durable registration, not management or existing-run waits. */
export class InvocationExecution {
  private readonly deps: ExecutorDeps;
  constructor(
    // Launch owns the current session identity and tracked/durable run records through these dependencies.
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types
    deps: ExecutorDeps,
  ) {
    this.deps = deps;
  }
  async execute(call: ExecutionInvocation): Promise<SubagentExecutionResult> {
    const depth = checkSubagentDepth(this.deps.config.maxSubagentDepth);
    if (depth.blocked) {
      return {
        content: [
          {
            type: "text",
            text: `Nested subagent call blocked (depth=${depth.depth}, max=${depth.maxDepth}). You are running at the maximum subagent nesting depth. Complete your current task directly without delegating to further subagents.`,
          },
        ],
        isError: true,
        details: { mode: "single", results: [] },
      };
    }
    const normalized = normalizeRepeatedParallelCounts(call.params);
    if (normalized.error) {
      return normalized.error;
    }
    if (!normalized.params) {
      throw new Error("Task normalization did not return launch input.");
    }
    const params = applyForceTopLevelAsyncOverride(
      normalized.params,
      depth.depth,
      this.deps.config.forceTopLevelAsync === true,
    );
    const cwd = params.cwd ?? call.invocationCwd;
    const parentSessionFile = call.ctx.sessionManager.getSessionFile() ?? null;
    this.deps.state.currentSessionId = resolveCurrentSessionId(call.ctx.sessionManager);
    const agents = discoverInvocation(params, cwd, call.ctx, this.deps);
    const fallback = resolveIntercomSessionTarget(
      this.deps.pi.getSessionName(),
      call.ctx.sessionManager.getSessionId(),
    );
    const intercomBridge = resolveIntercomBridge(
      resolveOrchestratorIntercomTarget(this.deps.pi.events, fallback),
    );
    const runId = randomUUID();
    const nestedRoute = resolveInheritedNestedRouteFromEnv() ?? createNestedRoute(runId);
    const invalid =
      validateExecutionInput(params, agents.agents, invocationModes(params, call.ctx)) ??
      validateInvocationForkModel(params, agents, call.ctx);
    if (invalid) {
      return invalid;
    }
    return this.prepareLaunch({
      call,
      params,
      agents,
      cwd,
      runId,
      parentSessionFile,
      intercomBridge,
      nestedRoute,
    });
  }
  private async prepareLaunch(input: LaunchPreparation): Promise<SubagentExecutionResult> {
    const { call, params, agents, cwd, runId, parentSessionFile } = input;
    const clarified = await this.clarify(params, agents, {
      ctx: call.ctx,
      signal: call.signal,
      cwd,
      runId,
    });
    if ("details" in clarified) {
      return clarified;
    }
    const sessions = this.resolveForkSessions(agents, call.ctx, clarified);
    if ("details" in sessions) {
      return sessions;
    }
    const policy = this.asyncPolicy(clarified);
    if ("details" in policy) {
      return policy;
    }
    const controlConfig = resolveControlConfig(this.deps.config.control, clarified.control);
    const artifactsDir = policy.effectiveAsync
      ? this.deps.tempArtifactsDir
      : getArtifactsDir(parentSessionFile);
    const layout = this.sessionLayout(clarified, parentSessionFile, runId, agents.context);
    if ("details" in layout) {
      return layout;
    }
    return this.launch(
      this.executionData(input, clarified, {
        sessions,
        policy,
        layout,
        artifactsDir,
        controlConfig,
      }),
      agents.context,
    );
  }
  private executionData(
    input: LaunchPreparation,
    clarified: SubagentParamsLike,
    resources: LaunchResources,
  ): ExecutionContextData {
    const { call, agents, cwd, runId, intercomBridge, nestedRoute } = input;
    const { sessions, policy, layout, artifactsDir, controlConfig } = resources;
    const update = this.progressUpdate(runId, agents.context, call.onUpdate);
    return {
      params: clarified,
      effectiveCwd: cwd,
      ctx: call.ctx,
      signal: call.signal,
      onUpdate: update,
      agents: agents.agents,
      runId,
      shareEnabled: clarified.share === true,
      sessionRoot: layout.root,
      sessionDirForIndex: layout.dir,
      sessionFileForIndex: (index) =>
        sessions.sessionFileForIndex(index) ?? path.join(layout.dir(index), "session.jsonl"),
      sessionFileForAgentIndex: (agent, index) =>
        sessions.sessionFileForAgentIndex(agent, index) ??
        path.join(layout.dir(index), "session.jsonl"),
      artifactsEnabled: clarified.artifacts !== false,
      artifactsDir,
      ...policy,
      controlConfig,
      intercomBridge,
      nestedRoute,
    };
  }
  private async clarify(
    params: SubagentParamsLike,
    agents: AgentInvocation,
    call: {
      readonly ctx: ExtensionContext;
      readonly signal?: AbortSignal;
      readonly cwd: string;
      readonly runId: string;
    },
  ): Promise<SubagentParamsLike | SubagentExecutionResult> {
    try {
      const clarified = await clarifyInvocation({
        params,
        agents: agents.agents,
        ctx: call.ctx,
        cwd: call.cwd,
        runId: call.runId,
      });
      if (!clarified) {
        return {
          content: [{ type: "text", text: "Cancelled" }],
          details: { mode: mode(params), results: [] },
        };
      }
      if (call.signal?.aborted === true) {
        return toExecutionErrorResult(
          clarified,
          new Error("Subagent cancelled before launch."),
          agents.context,
        );
      }
      return clarified;
    } catch (error) {
      return toExecutionErrorResult(params, error, agents.context);
    }
  }
  private resolveForkSessions(
    agents: AgentInvocation,
    ctx: ExtensionContext,
    params: SubagentParamsLike,
  ): ReturnType<typeof createPerAgentForkContextResolver> | SubagentExecutionResult {
    try {
      return createPerAgentForkContextResolver(ctx.sessionManager, agents.resolveContextForIndex, {
        resolveContextForAgentIndex: (name) => agents.resolveContextForAgent(name),
      });
    } catch (error) {
      return toExecutionErrorResult(params, error, agents.context);
    }
  }
  private asyncPolicy(params: SubagentParamsLike): AsyncPolicy | SubagentExecutionResult {
    const async = resolveAsyncExecutionMode(params, this.deps.asyncByDefault);
    const timeout = resolveForegroundTimeoutMs(params);
    if (timeout.error !== undefined) {
      return buildRequestedModeError(params, timeout.error);
    }
    if (async.effectiveAsync && timeout.timeoutMs !== undefined) {
      return buildRequestedModeError(
        params,
        "timeoutMs/maxRuntimeMs only applies to foreground subagent runs. Set async:false or use action:'interrupt' for background runs.",
      );
    }
    return {
      effectiveAsync: async.effectiveAsync,
      backgroundRequestedWhileClarifying:
        mode(params) !== "single" && async.backgroundRequestedWhileClarifying,
      foregroundTimeoutMs: async.effectiveAsync
        ? timeout.timeoutMs
        : normalizeRoleForegroundTimeout(params, timeout.timeoutMs),
    };
  }
  private sessionLayout(
    params: SubagentParamsLike,
    parent: string | null,
    runId: string,
    context: SubagentParamsLike["context"],
  ): { readonly root: string; readonly dir: (index?: number) => string } | SubagentExecutionResult {
    const requested = params.sessionDir;
    const configured = this.deps.config.defaultSessionDir;
    let root: string;
    if (requested !== undefined && requested.length > 0) {
      root = path.resolve(this.deps.expandTilde(requested));
    } else {
      const base =
        configured !== undefined && configured.length > 0
          ? path.resolve(this.deps.expandTilde(configured))
          : this.deps.getSubagentSessionRoot(parent);
      root = path.join(base, runId);
    }
    try {
      fs.mkdirSync(root, { recursive: true });
    } catch (error) {
      return toExecutionErrorResult(
        params,
        new Error(`Failed to create session directory '${root}': ${errorMessage(error)}`),
        context,
      );
    }
    return { root, dir: (index) => path.join(root, `run-${index ?? 0}`) };
  }
  private progressUpdate(
    runId: string,
    context: SubagentParamsLike["context"],
    onUpdate: SubagentExecutionUpdateCallback | undefined,
  ): SubagentExecutionUpdateCallback {
    return (result) => {
      const owned = this.deps.state.ownedRuns?.get(runId);
      if (owned && result.details.workflowGraph) {
        rememberOwnedRun(this.deps.state, {
          ...owned,
          children: workflowChildren(owned.children, result.details.workflowGraph),
        });
      }
      onUpdate?.(withForkContext(result, context));
    };
  }
  private rememberLaunch(
    data: ExecutionContextData,
    result: SubagentExecutionResult,
    nodes: ReadonlyInput<ReturnType<typeof workflowAgentNodes>> | undefined,
    assignments: Assignments,
  ): void {
    const params = data.params;
    rememberOwnedRun(this.deps.state, {
      runId: data.runId,
      ownerSessionId: data.ctx.sessionManager.getSessionId(),
      rootRunId: data.runId,
      source: "async",
      mode: mode(params),
      cwd: data.effectiveCwd,
      task:
        params.task ?? params.tasks?.map((task) => task.task).join("\n") ?? "Delegated workflow",
      asyncDir: result.details.asyncDir,
      pid: result.details.asyncPid ?? this.deps.state.asyncJobs.get(data.runId)?.pid,
      startedAt: Date.now(),
      children: assignments.map((assignment, index) => ({
        agent: assignment.agent,
        index,
        task: assignment.task,
        label: assignment.label,
        workflowNodeId: nodes?.at(index)?.id,
      })),
    });
  }
  private assignments(params: SubagentParamsLike): Assignments {
    if (params.tasks) {
      return params.tasks;
    }
    if (params.chain) {
      return params.chain.flatMap((step) => {
        if (isParallelStep(step)) {
          return step.parallel;
        }
        return isDynamicParallelStep(step) ? [step.parallel] : [step];
      });
    }
    if (params.agent === undefined) {
      throw new Error("Single launch requires an agent.");
    }
    return [{ agent: params.agent, task: params.task, label: params.label }];
  }
  private async launch(
    data: ExecutionContextData,
    context: SubagentParamsLike["context"],
  ): Promise<SubagentExecutionResult> {
    const graph = data.params.chain
      ? buildWorkflowGraphSnapshot({ runId: data.runId, steps: data.params.chain })
      : undefined;
    const nodes = graph ? workflowAgentNodes(graph) : undefined;
    const assignments = this.assignments(data.params);
    saveQuestionOwner(data.runId, data.ctx.sessionManager.getSessionId());
    try {
      const result = runAsyncPath(data, this.deps);
      if (!result) {
        throw new Error("Invalid subagent execution mode.");
      }
      if (result.isError === true) {
        return withForkContext(result, context);
      }
      this.rememberLaunch(data, result, nodes, assignments);
      if (this.foregroundWaitNeeded(data, result)) {
        return withForkContext(
          await waitForOwnedRun({
            id: data.runId,
            deps: this.deps,
            ctx: data.ctx,
            signal: data.signal,
            onUpdate: data.onUpdate,
            cancelNewRun: true,
            executionResult: true,
            includeProgress: data.params.includeProgress,
          }),
          context,
        );
      }
      return withForkContext(result, context);
    } catch (error) {
      const result = toExecutionErrorResult(data.params, error, context);
      this.rememberLaunchFailure(data.runId, result);
      return result;
    }
  }
  private foregroundWaitNeeded(
    data: ExecutionContextData,
    result: SubagentExecutionResult,
  ): boolean {
    const id = result.details.asyncId;
    return !data.effectiveAsync && id !== undefined && id.length > 0;
  }
  private rememberLaunchFailure(runId: string, result: SubagentExecutionResult): void {
    const owned = this.deps.state.ownedRuns?.get(runId);
    if (owned) {
      rememberOwnedRun(this.deps.state, {
        ...owned,
        error: result.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n"),
      });
    }
  }
}
