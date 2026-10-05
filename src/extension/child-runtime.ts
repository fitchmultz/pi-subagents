import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "../agents/agents.ts";
import { getArtifactsDir } from "../shared/artifacts.ts";
import {
  createSubagentExecutor,
  normalizeSubagentParamsLike,
} from "../runs/foreground/subagent-executor.ts";
import { interruptAsyncRun } from "../runs/foreground/foreground-control.ts";
import {
  SUBAGENT_EAGER_TOOL_ENV,
  SUBAGENT_PARENT_CHILD_INDEX_ENV,
} from "../runs/shared/pi-args.ts";
import {
  resolveNestedRouteFromEnv,
  type NestedControlRequestRecord,
} from "../runs/shared/nested-events.ts";
import { deliverSubagentIntercomMessageEvent } from "../intercom/result-intercom.ts";
import { resolveSubagentIntercomTarget } from "../intercom/intercom-bridge.ts";
import { readStatus } from "../shared/utils.ts";
import { SubagentParams } from "./schemas.ts";
import { loadConfig } from "./config.ts";
import { registerCompactSubagentTools } from "./compact-tools.ts";
import { registerToolResultAdapter } from "./tool-result.ts";
import { renderSubagentResult } from "../tui/render.ts";
import type { AsyncStatus, ReadonlyDetails, SubagentExecutionResult } from "../shared/types.ts";
import type { ReadonlyInput } from "../shared/types/inputs.ts";
import { finalizedChildUsage, registerParentUsage } from "../runs/shared/parent-usage.ts";
import { resolveCurrentSessionId } from "../shared/session-identity.ts";
import { ownedRunList, restoreOwnedRunsAsync } from "../runs/shared/run-records.ts";
import { closeRunHistory, runHistoryIndex, startRunHistory } from "../runs/shared/history-index.ts";
import { createCompletionDelivery } from "../runs/background/completion-delivery.ts";
import { createRuntimeState, expandTilde, getSubagentSessionRoot } from "./runtime-storage.ts";
import { copyExecutionResult } from "./result-snapshot.ts";
import { NestedControlInbox } from "./nested-control-inbox.ts";
import { removeSharedRuntimeValue, setSharedRuntimeValue } from "./runtime-reload.ts";

export const CHILD_CLEANUP_KEY = "__piSubagentFanoutChildControlInboxCleanup";
const acceptanceGuidelines = [
  "For goal-style requests such as /goal, goal, active goal, or work until evidence says done, use explicit acceptance on the delegated run: criteria for the target, evidence/verify for proof, stopRules for constraints, and maxFinalizationTurns for the bounded loop.",
  "For implementation handoffs from a plan, PRD, spec, issue, or broad fix, put implementation instructions and plan paths in task, and put the definition of done, evidence, verification commands, constraints, and loop cap in acceptance.",
];

/** Owns the fanout child's session, completion delivery and inbox resources. */
export class FanoutChildRuntime {
  private readonly config = loadConfig();
  private readonly state;
  private readonly parentUsage;
  private readonly completionDelivery;
  private readonly adaptToolResult;
  private readonly executor;
  private readonly compact = this.config.compactChildTools !== false;
  private sessionReset: Promise<void> | undefined;
  private inbox: NestedControlInbox | undefined;
  private readonly checks = new Set<Promise<void>>();
  private readonly cleanup = (): Promise<void> => this.shutdown();

  private readonly pi: ExtensionAPI;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
    this.state = createRuntimeState(pi);
    const toolNames = this.compact ? ["subagent", "delegate", "agent_runs"] : ["subagent"];
    this.parentUsage = registerParentUsage(pi, toolNames);
    this.completionDelivery = createCompletionDelivery(pi, this.state, this.parentUsage);
    this.adaptToolResult = registerToolResultAdapter(pi, toolNames);
    this.executor = createSubagentExecutor({
      pi,
      state: this.state,
      config: this.config,
      asyncByDefault: this.config.asyncByDefault === true,
      tempArtifactsDir: getArtifactsDir(null),
      getSubagentSessionRoot,
      expandTilde,
      discoverAgents,
      allowMutatingManagementActions: false,
      ensureSessionState: (ctx) => this.ensureSessionState(ctx),
    });
  }

  private ensureSessionState(ctx: ExtensionContext): Promise<void> {
    const sessionId = resolveCurrentSessionId(ctx.sessionManager);
    if (this.sessionReset) {
      return this.sessionReset;
    }
    if (this.state.currentSessionId === sessionId) {
      this.state.lastUiContext = ctx;
      return Promise.resolve();
    }
    this.sessionReset = this.resetSession(ctx, sessionId).finally(() => {
      this.sessionReset = undefined;
    });
    return this.sessionReset;
  }

  private async resetSession(ctx: ExtensionContext, sessionId: string | null): Promise<void> {
    await this.completionDelivery.stopAndJoin();
    await closeRunHistory(this.state);
    this.state.lastUiContext = ctx;
    this.state.foregroundRuns?.clear();
    await restoreOwnedRunsAsync(this.state, ctx);
    this.state.currentSessionId = sessionId;
    startRunHistory(this.state, ctx);
    this.completionDelivery.start();
  }

  private adapt(
    result: ReadonlyInput<SubagentExecutionResult>,
    ctx: ExtensionContext,
  ): SubagentExecutionResult {
    const nativeResult = copyExecutionResult(result);
    return this.adaptToolResult(
      result.details.wait?.status === "completed" &&
        result.details.run?.ownerSessionId === ctx.sessionManager.getSessionId()
        ? this.parentUsage.attach(
            nativeResult,
            finalizedChildUsage(result.details.run.children, result.details.wait.index),
            ctx,
          )
        : nativeResult,
    );
  }

  private guidelines(): string[] {
    return [
      "Delegate useful helper work within your assigned task when it saves time or improves quality; the original parent owns integration and final delivery.",
      "Nested execution defaults to foreground unless configuration explicitly opts into async. Set async:false whenever the nested result must appear in this child's report; use async:true only for intentionally detached work.",
      this.compact
        ? "Use load_subagent({advanced:false}), then agent_runs({action:'profiles'}) before delegation unless the executable agent is already known. Use load_subagent for advanced workflows."
        : "Use subagent action:list before nested execution unless the executable nested agent is already known from the task context.",
      "Do not use subagent child-safe mode for agent config mutation actions; create, update, and delete are blocked here.",
    ];
  }

  private registerTools(): void {
    if (this.compact) {
      const checkRuns = registerCompactSubagentTools(this.pi, {
        executor: this.executor,
        state: this.state,
        getHistoryIndex: () => runHistoryIndex(this.state),
        adapt: (result, ctx) => this.adapt(result, ctx),
        guidelines: [...this.guidelines(), ...acceptanceGuidelines],
        childSafe: true,
        asyncByDefault: this.config.asyncByDefault === true,
        keepAdvancedActive: process.env[SUBAGENT_EAGER_TOOL_ENV] === "1",
        listRuns: async (params, ctx) => {
          await this.ensureSessionState(ctx);
          return ownedRunList(this.state, params);
        },
      });
      this.state.onRunsChanged = () => this.trackCheck(checkRuns());
    }
    const tool: ToolDefinition<typeof SubagentParams, ReadonlyDetails> = {
      name: "subagent",
      defaultActive: !this.compact,
      label: "Subagent",
      description: [
        "Delegate to subagents from child-safe fanout mode.",
        ...acceptanceGuidelines,
        "Allowed management/control actions: list, get, status, history, search, nudge, interrupt, extend, resume, questions, answer, review, doctor. History/search browse only directly owned saved work; bounded previews and index freshness are not canonical proof. Exact status is concise; full:true includes the full task/configuration. Review notes are parent-only, not sent to children. Put actionable instructions in resume/nudge. Resume/answer overrides do not amend live acceptance.",
        "Agent config mutation actions create, update, and delete are blocked in this mode.",
      ].join("\n"),
      promptSnippet:
        "Delegate nested child-safe subagent work from an explicitly allowed fanout child.",
      promptGuidelines: this.guidelines(),
      parameters: SubagentParams,
      execute: async (id, params, signal, onUpdate, ctx) =>
        this.adapt(
          await this.executor.execute({
            toolCallId: id,
            params: normalizeSubagentParamsLike(params),
            signal,
            onUpdate,
            ctx,
          }),
          ctx,
        ),
      renderResult: renderSubagentResult,
    };
    this.pi.registerTool(tool);
  }

  private trackCheck(pending: Promise<void>): void {
    this.checks.add(pending);
    pending
      .finally(() => {
        this.checks.delete(pending);
      })
      .catch((error: unknown) => {
        console.error("Could not reconcile nested subagent controls:", error);
      });
  }

  private async executeControl(
    request: ReadonlyInput<NestedControlRequestRecord>,
  ): Promise<{ readonly ok: boolean; readonly message: string }> {
    const asyncDir =
      this.state.ownedRuns?.get(request.targetRunId)?.asyncDir ??
      this.state.asyncJobs.get(request.targetRunId)?.asyncDir;
    const status = asyncDir !== undefined && asyncDir.length > 0 ? readStatus(asyncDir) : null;
    if (!status || status.state !== "running") {
      return {
        ok: false,
        message: `Nested run ${request.targetRunId} is not active in this fanout child.`,
      };
    }
    return request.action === "interrupt"
      ? this.interruptControl(request)
      : this.resumeControl(request, status);
  }

  private interruptControl(request: ReadonlyInput<NestedControlRequestRecord>): {
    readonly ok: boolean;
    readonly message: string;
  } {
    const receipt = interruptAsyncRun(this.state, request.targetRunId, request.index);
    return {
      ok: receipt !== null && receipt.isError !== true,
      message:
        receipt?.content.map((part) => (part.type === "text" ? part.text : "")).join("\n") ??
        "Nested run is not interruptible.",
    };
  }

  private async resumeControl(
    request: ReadonlyInput<NestedControlRequestRecord>,
    status: ReadonlyInput<AsyncStatus>,
  ): Promise<{ readonly ok: boolean; readonly message: string }> {
    const message = request.message?.trim() ?? "";
    if (message.length === 0) {
      return { ok: false, message: "Nested resume requires message." };
    }
    const { index, agent } = this.activeMessageRoute(request.index, status);
    if (agent === undefined || agent.length === 0) {
      return {
        ok: false,
        message: `Nested run ${request.targetRunId} has no active child message route.`,
      };
    }
    return this.deliverFollowUp(request.targetRunId, agent, index, message);
  }

  private activeMessageRoute(
    requestedIndex: number | undefined,
    status: ReadonlyInput<AsyncStatus>,
  ): { readonly index: number; readonly agent?: string } {
    const index =
      requestedIndex ?? status.steps?.findIndex((step) => step.status === "running") ?? -1;
    const step = status.steps?.[index];
    return { index, agent: step?.status === "running" ? step.agent : undefined };
  }

  private async deliverFollowUp(
    runId: string,
    agent: string,
    index: number,
    message: string,
  ): Promise<{ readonly ok: boolean; readonly message: string }> {
    const target = resolveSubagentIntercomTarget(runId, agent, index);
    const ok = await deliverSubagentIntercomMessageEvent(
      this.pi.events,
      target,
      `Follow-up for nested run ${runId} (${agent}):\n\n${message}`,
      500,
      { source: "nested-resume", runId, agent, index },
    );
    return {
      ok,
      message: ok
        ? `Delivered follow-up to live nested run ${runId}.`
        : `Nested child intercom target is not registered: ${target}`,
    };
  }

  private startInbox(): void {
    let route;
    try {
      route = resolveNestedRouteFromEnv();
    } catch {
      return;
    }
    if (!route) {
      return;
    }
    const parsed = Number(process.env[SUBAGENT_PARENT_CHILD_INDEX_ENV]);
    this.inbox = new NestedControlInbox({
      route,
      childIndex: Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined,
      restoring: () => this.sessionReset !== undefined,
      owns: (id) => this.state.ownedRuns?.has(id) === true || this.state.asyncJobs.has(id),
      execute: (request) => this.executeControl(request),
    });
  }

  register(): void {
    this.pi.on("session_start", async (_event, ctx) => {
      await this.ensureSessionState(ctx);
    });
    this.registerTools();
    this.startInbox();
    setSharedRuntimeValue(CHILD_CLEANUP_KEY, this.cleanup);
    this.pi.on("session_shutdown", () => this.shutdown());
  }

  private async shutdown(): Promise<void> {
    this.inbox?.stop();
    await this.sessionReset;
    await this.inbox?.stopAndJoin();
    await this.completionDelivery.stopAndJoin({ preservePending: true });
    await Promise.all(this.checks);
    await closeRunHistory(this.state);
    removeSharedRuntimeValue(CHILD_CLEANUP_KEY, this.cleanup);
  }
}
