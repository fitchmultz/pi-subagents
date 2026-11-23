import { basename } from "node:path";
import { IntercomClient } from "../broker/client.ts";
import type { NativeReadQuery } from "../broker/last.ts";
import { spawnBrokerIfNeeded } from "../broker/spawn.ts";
import type { IntercomConfig } from "../config.ts";
import { RemoteDevices } from "../devices.ts";
import { normalizeLine } from "../message-format.ts";
import { ReplyTracker } from "../reply-tracker.ts";
import { ReplyWait } from "../reply-wait.ts";
import {
  RECIPIENT_TURN_FAILED_ATTACHMENT,
  type IntercomToolParams,
  type ToolResultLike,
} from "../runtime-types.ts";
import {
  formatSessionTarget,
  resolveSessionGitContext,
  type SessionGitContext,
} from "../session-targets.ts";
import type { IntercomTransport } from "../transport.ts";
import type { Message, SessionInfo } from "../types.ts";
import { asError } from "../validation.ts";
import { formatAgyInboundMessage, formatAgyInboundTitle, sendViaAgentApi } from "./delivery.ts";
import {
  AgyInboundQueue,
  applyHookTransition,
  type AgyHookInput,
  type AgyHookResponse,
} from "./inbound-queue.ts";
import { agyPeerId, readWakeCredentials } from "./paths.ts";
import { executeAgyIntercomTool, type AgyToolPeer } from "./peer-tools.ts";
import { readAgyLastMessage } from "./transcript.ts";

export type { AgyHookInput, AgyHookResponse } from "./inbound-queue.ts";

const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 30000] as const;
const MAX_NAME_LENGTH = 64;

interface LastRequest {
  readonly requestId: string;
  readonly query: NativeReadQuery;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value !== "" ? value : undefined;
}

function formatModelLabel(modelName: string | undefined): string {
  const normalized = normalizeLine(modelName);
  if (normalized === undefined || normalized.toLowerCase() === "auto") {
    return "agy";
  }
  return `agy (${normalized})`;
}

function defaultSessionName(cwd: string): string {
  const base = normalizeLine(basename(cwd.replace(/\/+$/, "")));
  if (base === undefined) {
    return "agy";
  }
  return `agy-${base}`.slice(0, MAX_NAME_LENGTH);
}

export class AgyPeer {
  readonly conversationId: string;
  readonly peerId: string;
  private readonly config: IntercomConfig;
  private readonly replies: ReplyTracker;
  private readonly wait: ReplyWait;
  private readonly devices: RemoteDevices;
  private readonly inboundQueue = new AgyInboundQueue();
  private readonly startedAt = Date.now();
  private client: IntercomClient | null = null;
  private connecting: Promise<IntercomTransport> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private closed = false;
  private cwd: string;
  private transcriptPath?: string | undefined;
  private modelName?: string | undefined;
  private title?: string | undefined;
  private status = "idle";
  private workingOn?: string | undefined;
  private lastIntercomActivity?: number | undefined;
  private gitContext: SessionGitContext;
  private gitRefresh: AbortController | null = null;

  constructor(
    conversationId: string,
    config: IntercomConfig,
    initial: {
      readonly cwd: string;
      readonly transcriptPath?: string | undefined;
      readonly modelName?: string | undefined;
      readonly title?: string | undefined;
    },
  ) {
    this.conversationId = conversationId;
    this.peerId = agyPeerId(conversationId);
    this.config = config;
    this.cwd = initial.cwd;
    this.gitContext = { projectId: initial.cwd };
    this.transcriptPath = initial.transcriptPath;
    this.modelName = initial.modelName;
    this.title = normalizeLine(initial.title)?.slice(0, MAX_NAME_LENGTH);
    this.replies = new ReplyTracker(Math.max(config.askTimeoutMs, 10 * 60 * 1000));
    this.wait = new ReplyWait({ markActivity: () => this.markActivity() }, config.askTimeoutMs);
    this.devices = new RemoteDevices(config, false);
  }

  get currentStatus(): string {
    return this.status;
  }

  get isIdle(): boolean {
    return this.status === "idle";
  }

  start(): void {
    if (this.closed) {
      return;
    }
    void this.ensureConnected().catch(() => {
      this.scheduleReconnect();
    });
  }

  private displayName(): string {
    return this.title ?? defaultSessionName(this.cwd);
  }

  private acceptsAsks(): boolean {
    return this.status === "idle";
  }

  private registration(): Omit<SessionInfo, "id"> {
    return {
      name: this.displayName(),
      cwd: this.cwd,
      model: formatModelLabel(this.modelName),
      ...this.gitContext,
      ...(this.workingOn !== undefined ? { workingOn: this.workingOn } : {}),
      status: this.status,
      startedAt: this.startedAt,
      pendingAsks: this.replies.listPending().length,
      acceptsAsks: this.acceptsAsks(),
      ...(this.lastIntercomActivity !== undefined
        ? { lastIntercomActivity: this.lastIntercomActivity }
        : {}),
    };
  }

  private sessionSnapshot(): SessionInfo {
    return {
      id: this.client?.sessionId ?? this.peerId,
      ...this.registration(),
    };
  }

  private markActivity(): void {
    this.lastIntercomActivity = Date.now();
  }

  private syncPresence(): void {
    if (this.closed || !this.client || !this.client.isConnected()) {
      return;
    }
    this.client.updatePresence({
      name: this.displayName(),
      model: formatModelLabel(this.modelName),
      status: this.status,
      startedAt: this.startedAt,
      pendingAsks: this.replies.listPending().length,
      acceptsAsks: this.acceptsAsks(),
      ...(this.lastIntercomActivity !== undefined
        ? { lastIntercomActivity: this.lastIntercomActivity }
        : {}),
      workingOn: this.workingOn ?? null,
      gitRepo: this.gitContext.gitRepo ?? null,
      gitBranch: this.gitContext.gitBranch ?? null,
    });
  }

  private refreshGitContext(): void {
    if (this.closed) {
      return;
    }
    this.gitRefresh?.abort();
    const controller = new AbortController();
    this.gitRefresh = controller;
    void resolveSessionGitContext(this.cwd, controller.signal)
      .then((git) => {
        if (this.closed || this.gitRefresh !== controller) {
          return;
        }
        const changed =
          git.gitRepo !== this.gitContext.gitRepo || git.gitBranch !== this.gitContext.gitBranch;
        this.gitContext = git;
        if (changed) {
          this.syncPresence();
        }
      })
      .catch(() => {
        // Git context is best-effort.
      })
      .finally(() => {
        if (this.gitRefresh === controller) {
          this.gitRefresh = null;
        }
      });
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== null || this.connecting !== null) {
      return;
    }
    const delayMs =
      RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)] ?? 30000;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed) {
        return;
      }
      this.reconnectAttempt += 1;
      void this.ensureConnected().catch(() => {
        this.scheduleReconnect();
      });
    }, delayMs);
    this.reconnectTimer.unref();
  }

  private createClient(): IntercomClient {
    const next = new IntercomClient({
      sendTimeoutMs: this.config.sendTimeoutMs,
      listTimeoutMs: this.config.listTimeoutMs,
    });
    next.on("message", (from: SessionInfo, message: Message) => {
      void this.handleIncomingMessage(from, message).catch(() => {
        // Inbound delivery handles its own fallback queue.
      });
    });
    next.on("last_request", (request: LastRequest) => {
      this.handleLastRequest(next, request);
    });
    next.on("session_left", (id: string) => {
      this.wait.peerDisconnected(id);
      if (this.replies.expireSender(id) > 0) {
        this.syncPresence();
      }
    });
    next.on("disconnected", (error: Readonly<Error>) => {
      if (this.client !== next) {
        return;
      }
      this.wait.reject(error);
      this.client = null;
      this.scheduleReconnect();
    });
    next.on("error", () => {
      // Disconnected event owns reconnect recovery.
    });
    return next;
  }

  async ensureConnected(): Promise<IntercomTransport> {
    if (this.closed) {
      throw new Error("Antigravity intercom peer is closed.");
    }
    if (this.client?.isConnected() === true) {
      return this.client;
    }
    if (this.connecting) {
      return await this.connecting;
    }
    this.clearReconnectTimer();
    const attempt = this.connectOnce();
    this.connecting = attempt;
    try {
      return await attempt;
    } finally {
      if (this.connecting === attempt) {
        this.connecting = null;
      }
    }
  }

  private async connectOnce(): Promise<IntercomTransport> {
    const next = this.createClient();
    try {
      await spawnBrokerIfNeeded(this.config.brokerCommand, this.config.brokerArgs);
      this.gitContext = await resolveSessionGitContext(this.cwd);
      await next.connect(this.registration(), this.peerId);
      if (this.closed) {
        await next.disconnect();
        throw new Error("Antigravity intercom peer is closed.");
      }
      this.client = next;
      this.reconnectAttempt = 0;
      this.syncPresence();
      return next;
    } catch (error) {
      await next.disconnect().catch(() => {
        // Ignore cleanup failures for a failed connection attempt.
      });
      throw asError(error);
    }
  }

  private async resolveReplyTargetLabel(from: SessionInfo): Promise<string> {
    if (!this.client || !this.client.isConnected()) {
      return from.id;
    }
    try {
      const sessions = await this.client.listSessions();
      return formatSessionTarget(from, sessions);
    } catch {
      return from.id;
    }
  }

  private async notifyUnwakeableAsk(
    from: SessionInfo,
    message: Message,
    detail: string,
  ): Promise<void> {
    this.replies.markReplied(message.id);
    this.syncPresence();
    if (!this.client || !this.client.isConnected()) {
      return;
    }
    try {
      await this.client.send(from.id, {
        text: detail,
        replyTo: message.id,
        attachments: [
          {
            type: "context",
            name: RECIPIENT_TURN_FAILED_ATTACHMENT,
            content: detail,
          },
        ],
      });
    } catch {
      // Best-effort fast-fail so the caller does not wait until ask timeout.
    }
  }

  private async handleIncomingMessage(from: SessionInfo, message: Message): Promise<void> {
    if (this.closed) {
      return;
    }
    const matchedWait = this.wait.receive(from, message, () => {
      this.markActivity();
      this.syncPresence();
    });
    if (matchedWait) {
      return;
    }
    if (!this.inboundQueue.remember(message.id)) {
      return;
    }
    this.markActivity();
    if (message.expectsReply === true) {
      this.replies.recordIncomingMessage(from, message);
      this.syncPresence();
    }
    const replyTarget = await this.resolveReplyTargetLabel(from);
    const formatted = formatAgyInboundMessage(from, message, {
      replyHint: this.config.replyHint,
      replyTarget,
    });
    const credentials = readWakeCredentials(this.conversationId);
    if (credentials) {
      const title = formatAgyInboundTitle(from, message.expectsReply === true);
      const delivery = await sendViaAgentApi(credentials, this.conversationId, title, formatted);
      if (delivery.ok) {
        return;
      }
      await this.handleFallbackDelivery(from, message, formatted, delivery.reason);
      return;
    }
    await this.handleFallbackDelivery(from, message, formatted);
  }

  private async handleFallbackDelivery(
    from: SessionInfo,
    message: Message,
    formatted: string,
    wakeError?: string,
  ): Promise<void> {
    if (message.expectsReply === true && this.isIdle) {
      const reason =
        wakeError !== undefined
          ? `This agy session could not be woken via agentapi (${wakeError}).`
          : "This agy session is idle and has not run a shell command yet, so Antigravity's wake endpoint is not available yet.";
      const note = `${reason} The message was queued for its next turn; send again once it is active or after it runs any shell command.`;
      await this.notifyUnwakeableAsk(from, message, note);
      this.inboundQueue.enqueue(
        message.id,
        `${formatted}\n\n_(Note: the sender's ask failed immediately because this session could not be woken while idle. Use intercom action="send" if you still want to respond.)_`,
      );
      return;
    }
    this.inboundQueue.enqueue(message.id, formatted);
  }

  private handleLastRequest(active: IntercomClient, request: LastRequest): void {
    if (this.closed || this.client !== active) {
      active.respondLast(request.requestId, { error: "Intercom runtime no longer active" });
      return;
    }
    if ("messageId" in request.query) {
      active.respondLast(request.requestId, { error: "publication_unavailable" });
      return;
    }
    try {
      active.respondLast(
        request.requestId,
        readAgyLastMessage(this.transcriptPath, this.sessionSnapshot(), request.query),
      );
    } catch (error) {
      active.respondLast(request.requestId, { error: asError(error).message });
    }
  }

  updateTitle(title: string | undefined): void {
    const normalized = normalizeLine(title)?.slice(0, MAX_NAME_LENGTH);
    if (normalized === undefined || normalized === this.title) {
      return;
    }
    this.title = normalized;
    this.syncPresence();
  }

  private updateMetadata(input: AgyHookInput): void {
    const nextCwd = nonEmpty(input.cwd) ?? nonEmpty(input.workspacePaths?.[0]);
    if (nextCwd !== undefined && nextCwd !== this.cwd) {
      this.cwd = nextCwd;
      this.refreshGitContext();
    }
    this.transcriptPath = nonEmpty(input.transcriptPath) ?? this.transcriptPath;
    this.modelName = nonEmpty(input.modelName) ?? this.modelName;
  }

  onHookEvent(input: AgyHookInput): AgyHookResponse {
    this.updateMetadata(input);
    const { status, response } = applyHookTransition(input, this.inboundQueue);
    if (status !== undefined) {
      this.status = status;
      this.syncPresence();
    }
    return response;
  }

  async executeTool(
    params: IntercomToolParams,
    signal: AbortSignal | undefined,
  ): Promise<ToolResultLike> {
    const toolPeer: AgyToolPeer = {
      ensureConnected: () => this.ensureConnected(),
      replies: this.replies,
      wait: this.wait,
      devices: this.devices,
      config: this.config,
      wakeReady: () => readWakeCredentials(this.conversationId) !== undefined,
      queuedInboundCount: () => this.inboundQueue.length,
      setWorkingOn: (value) => {
        this.workingOn = value;
        this.syncPresence();
      },
      markActivity: () => this.markActivity(),
      syncPresence: () => this.syncPresence(),
    };
    return await executeAgyIntercomTool(toolPeer, params, signal);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.clearReconnectTimer();
    this.gitRefresh?.abort();
    this.gitRefresh = null;
    this.wait.reject(new Error("Antigravity session exited."));
    const connecting = this.connecting;
    this.connecting = null;
    await Promise.allSettled([connecting]);
    if (this.client) {
      await this.client.disconnect().catch(() => {
        // Ignore broker disconnect errors on shutdown.
      });
      this.client = null;
    }
  }
}
