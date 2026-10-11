import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "../agents/agents.ts";
import {
  ARTIFACT_CLEANUP_DAYS,
  cleanupAllArtifactDirs,
  cleanupOldArtifacts,
  getArtifactsDir,
} from "../shared/artifacts.ts";
import { resolveCurrentSessionId } from "../shared/session-identity.ts";
import { cleanupOldChainDirs } from "../shared/settings.ts";
import { cleanupOldRunStorage } from "../shared/temp-root.ts";
import { AgentViewController } from "../tui/agent-view.ts";
import { createSubagentExecutor } from "../runs/foreground/subagent-executor.ts";
import { createAsyncJobTracker } from "../runs/background/async-job-tracker.ts";
import { rememberOwnedRun, restoreOwnedRunsAsync } from "../runs/shared/run-records.ts";
import { closeRunHistory, runHistoryIndex, startRunHistory } from "../runs/shared/history-index.ts";
import { registerParentUsage } from "../runs/shared/parent-usage.ts";
import { createCompletionDelivery } from "../runs/background/completion-delivery.ts";
import { isObsoleteIdleNotice } from "../runs/shared/subagent-control.ts";
import { registerSlashCommands } from "../slash/slash-commands.ts";
import { clearSlashSnapshots, restoreSlashFinalSnapshots } from "../slash/slash-live-state.ts";
import { isTuiContext } from "../shared/ui-mode.ts";
import { isRecord } from "../shared/unknown.ts";
import type { ReadonlyInput } from "../shared/types/inputs.ts";
import {
  ASYNC_DIR,
  RESULTS_DIR,
  SUBAGENT_ASYNC_COMPLETE_EVENT,
  SUBAGENT_ASYNC_STARTED_EVENT,
  SUBAGENT_CONTROL_EVENT,
  WIDGET_KEY,
  type ExtensionConfig,
  type SubagentExecutionResult,
  type SubagentState,
} from "../shared/types.ts";
import {
  handleSubagentControlNotice,
  SUBAGENT_CONTROL_MESSAGE_TYPE,
  type SubagentControlMessageDetails,
} from "./control-notices.ts";
import { parseControlNotice } from "./control-notice-schema.ts";
import { adaptFinalizedToolResult, registerToolResultAdapter } from "./tool-result.ts";
import { registerCompactSubagentTools } from "./compact-tools.ts";
import { registerParentSubagentTool, SUBAGENT_GUIDELINES } from "./primary-tool.ts";
import { registerMessageRenderers } from "./message-renderers.ts";
import { registerDelegationBridges } from "./delegation-bridges.ts";
import {
  createRuntimeState,
  ensureAccessibleDir,
  expandTilde,
  getSubagentSessionRoot,
} from "./runtime-storage.ts";
import {
  cleanupStaleSubscriptions,
  EVENT_UNSUBSCRIBES_KEY,
  isStaleExtensionContextError,
  removeSharedRuntimeValue,
  RUNTIME_CLEANUP_KEY,
  setSharedRuntimeValue,
  visibleControlNotices,
} from "./runtime-reload.ts";

const TOOL_NAMES = ["subagent", "delegate", "agent_runs"];

/** Owns one extension runtime's session projection, timers, delivery, subscriptions and UI. */
export class ParentSubagentRuntime {
  private readonly pi: ExtensionAPI;
  private readonly config: ExtensionConfig;
  private readonly state: SubagentState;
  private readonly tracker: ReturnType<typeof createAsyncJobTracker>;
  private readonly executor: ReturnType<typeof createSubagentExecutor>;
  private readonly agentView: AgentViewController;
  private readonly parentUsage: ReturnType<typeof registerParentUsage>;
  private readonly completionDelivery: ReturnType<typeof createCompletionDelivery>;
  private readonly adaptToolResult: ReturnType<typeof registerToolResultAdapter>;
  private readonly bridges: ReturnType<typeof registerDelegationBridges>;
  private readonly visibleNotices = visibleControlNotices();
  private readonly pendingIdleNotices = new Map<string, SubagentControlMessageDetails>();
  private readonly pendingReconciliations = new Set<Promise<void>>();
  private readonly runtimeCleanup = (): void => this.cleanupRuntime();
  private eventUnsubscribes: Array<() => void> = [];
  private sessionReset: Promise<void> | undefined;
  private reconcileTools: () => Promise<void> = () => Promise.resolve();

  constructor(pi: ExtensionAPI, config: ExtensionConfig) {
    this.pi = pi;
    this.config = config;
    this.state = createRuntimeState(pi);
    this.tracker = createAsyncJobTracker(pi, this.state, ASYNC_DIR, {
      render: () => {
        this.refreshView();
      },
    });
    this.executor = createSubagentExecutor({
      pi,
      state: this.state,
      config,
      asyncByDefault: config.asyncByDefault !== false,
      tempArtifactsDir: getArtifactsDir(null),
      getSubagentSessionRoot,
      expandTilde,
      discoverAgents,
      ensureSessionState: (ctx) => this.ensureSession(ctx),
    });
    this.agentView = new AgentViewController(pi, this.state, (params, ctx) =>
      this.executor.execute({ toolCallId: randomUUID(), params, ctx }),
    );
    this.parentUsage = registerParentUsage(pi, TOOL_NAMES);
    this.completionDelivery = createCompletionDelivery(pi, this.state, this.parentUsage);
    this.adaptToolResult = registerToolResultAdapter(pi, TOOL_NAMES);
    this.bridges = registerDelegationBridges({
      events: pi.events,
      getContext: () => this.state.lastUiContext,
      executor: this.executor,
    });
    setSharedRuntimeValue(RUNTIME_CLEANUP_KEY, this.runtimeCleanup);
  }

  register(): void {
    registerMessageRenderers(this.pi);
    this.registerTools();
    registerSlashCommands(this.pi, this.state);
    this.registerRunEvents();
    this.registerSessionEvents();
  }

  private registerTools(): void {
    const asyncByDefault = this.config.asyncByDefault !== false;
    const adapt = (
      result: ReadonlyInput<SubagentExecutionResult>,
      ctx: ExtensionContext,
    ): SubagentExecutionResult =>
      adaptFinalizedToolResult(result, ctx, this.parentUsage, this.adaptToolResult);
    this.reconcileTools = registerCompactSubagentTools(this.pi, {
      executor: this.executor,
      state: this.state,
      adapt,
      guidelines: SUBAGENT_GUIDELINES,
      asyncByDefault,
      getHistoryIndex: () => runHistoryIndex(this.state),
    });
    this.state.onRunsChanged = () => {
      this.reconcileInBackground();
      this.refreshView();
    };
    registerParentSubagentTool(this.pi, {
      executor: this.executor,
      adapt,
      config: this.config,
      asyncByDefault,
    });
  }

  private refreshView(): void {
    this.agentView.refresh().catch((error: unknown) => {
      console.error("Could not refresh subagent view:", error);
    });
  }

  private reconcileInBackground(): void {
    const operation = this.reconcileTools();
    this.pendingReconciliations.add(operation);
    operation
      .finally(() => {
        this.pendingReconciliations.delete(operation);
      })
      .catch((error: unknown) => {
        console.error("Could not reconcile subagent run controls:", error);
      });
  }

  private deliverControlNotice(details: SubagentControlMessageDetails): void {
    handleSubagentControlNotice({
      pi: this.pi,
      visibleControlNotices: this.visibleNotices,
      details,
    });
  }

  private controlEvent(data: unknown): void {
    const details = parseControlNotice(data);
    if (!details) {
      return;
    }
    // Keep idle references out of Pi's active turn queue until its native settle boundary.
    if (
      details.source === "async" &&
      details.event.reason === "idle" &&
      !details.event.supervisorQuestion &&
      this.state.lastUiContext &&
      !this.state.lastUiContext.isIdle()
    ) {
      this.pendingIdleNotices.set(`${details.event.runId}:${details.event.index ?? ""}`, details);
      return;
    }
    this.deliverControlNotice(details);
  }

  private flushIdleNotices(): void {
    for (const details of this.pendingIdleNotices.values()) {
      this.deliverControlNotice(details);
    }
    this.pendingIdleNotices.clear();
  }

  private startedEvent(data: unknown): void {
    this.tracker.handleStarted(data);
    if (!isRecord(data) || typeof data.id !== "string" || data.id.length === 0) {
      return;
    }
    const run = this.state.ownedRuns?.get(data.id);
    if (run) {
      rememberOwnedRun(this.state, {
        ...run,
        source: "async",
        asyncDir: typeof data.asyncDir === "string" ? data.asyncDir : undefined,
        pid: typeof data.pid === "number" ? data.pid : undefined,
      });
    }
  }

  private subscribeEvents(): void {
    this.eventUnsubscribes = [];
    setSharedRuntimeValue(EVENT_UNSUBSCRIBES_KEY, this.eventUnsubscribes);
    // Retain each successful subscription even if a later registration fails.
    this.eventUnsubscribes.push(
      this.pi.events.on(SUBAGENT_ASYNC_STARTED_EVENT, (data) => this.startedEvent(data)),
    );
    this.eventUnsubscribes.push(
      this.pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, this.tracker.handleComplete),
    );
    this.eventUnsubscribes.push(
      this.pi.events.on(SUBAGENT_CONTROL_EVENT, (data) => this.controlEvent(data)),
    );
  }

  private registerRunEvents(): void {
    cleanupStaleSubscriptions();
    this.subscribeEvents();
    this.pi.on("turn_end", () => this.flushIdleNotices());
    this.pi.on("agent_before_settle", () => this.flushIdleNotices());
    this.pi.on("context", (event) => ({
      messages: event.messages.filter((message) => {
        if (message.role !== "custom" || message.customType !== SUBAGENT_CONTROL_MESSAGE_TYPE) {
          return true;
        }
        const notice = parseControlNotice(message.details);
        return !notice || !isObsoleteIdleNotice(notice);
      }),
    }));
    this.pi.on("tool_result", (event, ctx) => {
      if (!TOOL_NAMES.includes(event.toolName) || !isTuiContext(ctx)) {
        return;
      }
      this.state.lastUiContext = ctx;
      if (this.state.asyncJobs.size > 0) {
        this.refreshView();
        const ui: ExtensionContext["ui"] & { requestRender?: () => void } = ctx.ui;
        ui.requestRender?.();
        this.tracker.ensurePoller();
      }
    });
  }

  private registerSessionEvents(): void {
    this.pi.on("session_start", async (_event, ctx) => {
      if (this.eventUnsubscribes.length === 0) {
        this.subscribeEvents();
      }
      await this.resetSession(ctx);
      await this.reconcileTools();
    });
    this.pi.on("session_shutdown", () => this.shutdown());
  }

  private stopPoller(): void {
    if (this.state.poller) {
      clearInterval(this.state.poller);
    }
    this.state.poller = null;
  }

  private cleanupRuntime(): void {
    this.agentView.dispose();
    closeRunHistory(this.state).catch((error: unknown) => {
      console.error("Could not close subagent history:", error);
    });
    this.completionDelivery.stop();
    this.stopPoller();
  }

  private ensureSession(ctx: ExtensionContext): Promise<void> {
    if (this.sessionReset) {
      return this.sessionReset;
    }
    return this.state.currentSessionId !== resolveCurrentSessionId(ctx.sessionManager)
      ? this.resetSession(ctx)
      : Promise.resolve();
  }

  private resetSession(ctx: ExtensionContext): Promise<void> {
    if (this.sessionReset) {
      return this.sessionReset;
    }
    this.sessionReset = this.restoreSession(ctx).finally(() => {
      this.sessionReset = undefined;
    });
    return this.sessionReset;
  }

  private async restoreSession(ctx: ExtensionContext): Promise<void> {
    this.pendingIdleNotices.clear();
    this.agentView.dispose();
    this.stopPoller();
    await this.completionDelivery.stopAndJoin();
    closeRunHistory(this.state).catch((error: unknown) => {
      console.error("Could not close subagent history:", error);
    });
    ensureAccessibleDir(RESULTS_DIR);
    ensureAccessibleDir(ASYNC_DIR);
    this.state.baseCwd = ctx.cwd;
    this.state.currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
    this.state.lastUiContext = ctx;
    this.tracker.resetJobs();
    const restoration = await restoreOwnedRunsAsync(this.state, ctx);
    try {
      this.tracker.restoreJobs(this.state.currentSessionId, ctx, restoration);
    } catch (error) {
      console.error("Failed to restore active async jobs:", error);
      this.tracker.resetJobs(ctx);
    }
    startRunHistory(this.state, ctx);
    this.reconcileInBackground();
    this.agentView.start(ctx);
    await this.cleanupArtifacts(ctx);
    restoreSlashFinalSnapshots(ctx.sessionManager.getEntries());
    this.completionDelivery.start();
  }

  private async cleanupArtifacts(ctx: ExtensionContext): Promise<void> {
    await cleanupOldRunStorage();
    await cleanupOldChainDirs();
    await cleanupAllArtifactDirs(ARTIFACT_CLEANUP_DAYS);
    try {
      const file = ctx.sessionManager.getSessionFile();
      if (file !== undefined && file.length > 0) {
        await cleanupOldArtifacts(getArtifactsDir(file), ARTIFACT_CLEANUP_DAYS);
      }
    } catch {
      // Artifact failures must not block native session lifecycle events.
    }
  }

  private async shutdown(): Promise<void> {
    // A reset can still publish history, view and delivery after its awaited restoration/cleanup.
    // Join that owner before disposing the resources it may start.
    try {
      await this.sessionReset;
    } finally {
      await this.disposeSession();
    }
  }

  private async disposeSession(): Promise<void> {
    this.agentView.dispose();
    this.stopPoller();
    await this.completionDelivery.stopAndJoin({ preservePending: true });
    await closeRunHistory(this.state);
    await Promise.allSettled(this.pendingReconciliations);
    for (const unsubscribe of this.eventUnsubscribes) {
      try {
        unsubscribe();
      } catch {
        /* Shutdown also owns already-disposed subscriptions. */
      }
    }
    removeSharedRuntimeValue(EVENT_UNSUBSCRIBES_KEY, this.eventUnsubscribes);
    this.eventUnsubscribes = [];
    for (const timer of this.state.cleanupTimers.values()) {
      clearTimeout(timer);
    }
    this.state.cleanupTimers.clear();
    this.state.asyncJobs.clear();
    clearSlashSnapshots();
    this.bridges.slash.cancelAll();
    this.bridges.slash.dispose();
    this.bridges.template.cancelAll();
    this.bridges.template.dispose();
    removeSharedRuntimeValue(RUNTIME_CLEANUP_KEY, this.runtimeCleanup);
    this.clearWidget();
  }

  private clearWidget(): void {
    try {
      if (this.state.lastUiContext && isTuiContext(this.state.lastUiContext)) {
        this.state.lastUiContext.ui.setWidget(WIDGET_KEY, undefined);
      }
    } catch (error) {
      if (!isStaleExtensionContextError(error)) {
        throw error;
      }
    }
  }
}
