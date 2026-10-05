import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { IntercomClient } from "./broker/client.ts";
import type { IntercomTransport } from "./transport.ts";
import { spawnBrokerIfNeeded } from "./broker/spawn.ts";
import type { IntercomConfig } from "./config.ts";
import type { Lifecycle } from "./lifecycle.ts";
import type { TopicOwner } from "./topics.ts";
import type { Message, SessionInfo, TopicChange } from "./types.ts";
import { asError, errorMessage } from "./validation.ts";
import { formatTargetOptions, resolveSessionTarget } from "./session-targets.ts";

export type ConnectionReason = "startup" | "background" | "tool" | "overlay" | "peer-awareness";
interface ConnectionHooks {
  readonly restoring: () => Promise<void> | undefined;
  readonly pendingAsks: () => number;
  readonly incoming: (ctx: ExtensionContext, from: SessionInfo, message: Message) => Promise<void>;
  readonly peerLeft: (id: string) => void;
  readonly disconnected: (error: Readonly<Error>) => void;
}
/** Owns socket registration, coalesced connects and the reconnect/startup timers. */
export class IntercomConnection {
  private client: IntercomClient | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  private connecting: Promise<IntercomTransport> | null = null;
  private connectingGeneration: number | null = null;
  private attempt = 0;
  private syncError: string | undefined;
  private readonly lifecycle: Lifecycle;
  private readonly config: IntercomConfig;
  private readonly topics: TopicOwner;
  private readonly hooks: ConnectionHooks;
  constructor(
    lifecycle: Lifecycle,
    config: IntercomConfig,
    topics: TopicOwner,
    hooks: ConnectionHooks,
  ) {
    this.lifecycle = lifecycle;
    this.config = config;
    this.topics = topics;
    this.hooks = hooks;
  }
  get active(): IntercomTransport | null {
    return this.client;
  }
  get topicSyncError(): string | undefined {
    return this.syncError;
  }
  get isConnecting(): boolean {
    return this.startupTimer !== null || this.connecting !== null;
  }
  clearTopicSyncError(): void {
    this.syncError = undefined;
  }
  start(ctx: ExtensionContext, generation: number): void {
    this.attempt = 0;
    this.syncError = undefined;
    this.clearTimers();
    this.scheduleStartup(ctx, generation);
  }
  clearStartup(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
  }
  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
  clearTimers(): void {
    this.clearStartup();
    this.clearReconnect();
  }
  scheduleStartup(ctx: ExtensionContext, generation: number): void {
    this.clearStartup();
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      if (!this.lifecycle.live(ctx, generation)) {
        return;
      }
      this.ensure("startup").catch(() => {
        if (!this.lifecycle.live(ctx, generation)) {
          return;
        }
        this.client = null;
        this.scheduleReconnect();
      });
    }, 0);
    this.startupTimer.unref();
  }
  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.connecting || !this.lifecycle.live()) {
      return;
    }
    const generation = this.lifecycle.generation;
    const delays = [1000, 2000, 5000, 10000, 30000];
    const delay = delays[Math.min(this.attempt, delays.length - 1)] ?? 30000;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.lifecycle.generation !== generation || !this.lifecycle.live()) {
        return;
      }
      this.attempt += 1;
      this.ensure("background").catch(() => {
        /* ensure owns the next retry after settlement. */
      });
    }, delay);
    this.reconnectTimer.unref();
  }
  syncIdentity(sessionId: string): void {
    if (this.client && this.lifecycle.live()) {
      this.client.updatePresence({
        ...this.lifecycle.identity(sessionId),
        status: this.lifecycle.status(),
        ...this.lifecycle.health(this.hooks.pendingAsks()),
      });
    }
  }
  syncStatus(): void {
    if (this.client && this.lifecycle.currentSessionId !== null && this.lifecycle.live()) {
      this.client.updatePresence({
        status: this.lifecycle.status(),
        ...this.lifecycle.health(this.hooks.pendingAsks()),
      });
    }
  }
  private createClient(): IntercomClient {
    const next = new IntercomClient({
      sendTimeoutMs: this.config.sendTimeoutMs,
      listTimeoutMs: this.config.listTimeoutMs,
    });
    this.client = next;
    next.on("message", (from: SessionInfo, message: Message) => {
      const ctx = this.lifecycle.live();
      if (this.client !== next || !ctx) {
        return;
      }
      this.hooks.incoming(ctx, from, message).catch((error: unknown) => {
        console.error("Intercom inbound delivery failed:", error);
      });
    });
    next.on("session_left", (id: string) => {
      if (this.client !== next) {
        return;
      }
      this.topics.disconnected(id);
      this.hooks.peerLeft(id);
    });
    next.on("disconnected", (error: Readonly<Error>) => {
      if (this.client !== next) {
        return;
      }
      this.hooks.disconnected(error);
      this.client = null;
      this.topics.disconnected();
      this.clearReconnect();
      this.scheduleReconnect();
    });
    next.on("error", () => {
      /* Disconnect owns recovery; suppress socket noise in the TUI. */
    });
    return next;
  }
  private async restoreTopics(active: IntercomTransport): Promise<string | undefined> {
    const changes: TopicChange[] = [
      ...[...this.topics.presence().topics].map((topic): TopicChange => ({
        action: "restore",
        topic,
      })),
      ...[...this.topics.presence().subscriptions].map((subscription): TopicChange => ({
        action: "restore",
        subscription,
      })),
    ];
    let failure: string | undefined;
    for (const change of changes) {
      try {
        // Restore order preserves publication/subscription admission and bounded transport pressure.
        // oxlint-disable-next-line no-await-in-loop
        await active.updateTopics(change);
      } catch (error) {
        if (!active.isConnected()) {
          throw error;
        }
        failure ??= errorMessage(error);
      }
    }
    return failure;
  }
  private async synchronizeTopics(
    next: IntercomTransport,
    ctx: ExtensionContext,
    generation: number,
  ): Promise<void> {
    if (!next.supportsTopics) {
      this.topics.disconnected();
      return;
    }
    const failure = await this.restoreTopics(next);
    const sessions = await next.listSessions();
    if (!this.lifecycle.live(ctx, generation)) {
      return;
    }
    this.syncError = failure;
    this.topics.refresh(sessions);
    if (failure !== undefined && failure !== "" && next.sessionId !== null) {
      this.topics.disconnected(next.sessionId);
    }
  }
  private async connect(
    reason: ConnectionReason,
    ctx: ExtensionContext,
    generation: number,
    sessionId: string,
  ): Promise<IntercomTransport> {
    const next = this.createClient();
    try {
      if (reason !== "peer-awareness") {
        await spawnBrokerIfNeeded(this.config.brokerCommand, this.config.brokerArgs);
      }
      await next.connect(
        await this.lifecycle.registration(this.hooks.pendingAsks()),
        `pi-${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}`,
      );
      if (!this.lifecycle.live(ctx, generation)) {
        await next.disconnect();
        throw new Error("Intercom runtime no longer active");
      }
      this.client = next;
      this.syncIdentity(ctx.sessionManager.getSessionId());
      this.attempt = 0;
      await this.synchronizeTopics(next, ctx, generation);
      return next;
    } catch (error) {
      if (this.client === next) {
        this.client = null;
      }
      throw asError(error);
    }
  }
  async ensure(reason: ConnectionReason): Promise<IntercomTransport> {
    const generation = this.lifecycle.generation;
    const restoring = this.hooks.restoring();
    if (restoring) {
      await restoring;
    }
    const ctx = this.lifecycle.live();
    if (!ctx || generation !== this.lifecycle.generation) {
      throw new Error("Intercom shutting down");
    }
    if (this.connecting && this.connectingGeneration === generation) {
      return this.connecting;
    }
    if (this.client?.isConnected() === true) {
      return this.client;
    }
    const sessionId = this.lifecycle.currentSessionId;
    if (sessionId === null) {
      throw new Error("Intercom runtime not initialized");
    }
    this.clearReconnect();
    // Publish ownership before registration, which can synchronously invoke subscribers.
    const attempt = Promise.resolve().then(() => this.connect(reason, ctx, generation, sessionId));
    this.connecting = attempt;
    this.connectingGeneration = generation;
    return await this.finishAttempt(attempt, ctx, generation);
  }
  private async finishAttempt(
    attempt: Promise<IntercomTransport>,
    ctx: ExtensionContext,
    generation: number,
  ): Promise<IntercomTransport> {
    let retry = false;
    try {
      return await attempt;
    } catch (error) {
      retry = this.lifecycle.live(ctx, generation) !== null;
      throw error;
    } finally {
      if (this.connecting === attempt) {
        this.connecting = null;
        this.connectingGeneration = null;
      }
      if (retry) {
        this.scheduleReconnect();
      }
    }
  }
  async shutdown(): Promise<void> {
    this.clearTimers();
    // The bounded launcher attempt is joined before socket shutdown.
    await Promise.allSettled([this.connecting]);
    if (this.client) {
      await this.client.disconnect();
      this.client = null;
    }
  }
}
export type Connection = Readonly<IntercomConnection>;
export async function resolveConnectedTarget(
  active: IntercomTransport,
  name: string,
): Promise<string | null> {
  const sessions = await active.listSessions();
  const resolution = resolveSessionTarget(sessions, name);
  if (resolution.status === "found" && resolution.target) {
    return resolution.target.id;
  }
  if (resolution.status === "ambiguous") {
    throw new Error(
      `Target "${name}" matches multiple sessions. Use one of these targets: ${formatTargetOptions(resolution.matches, sessions)}.`,
    );
  }
  if (resolution.status === "prefix_too_short") {
    throw new Error(
      `Target "${name}" is too short. Use the displayed target from intercom list, such as ${formatTargetOptions(resolution.matches, sessions)}.`,
    );
  }
  return null;
}
export async function resolvePeerHealth(
  active: IntercomTransport,
  id: string,
): Promise<SessionInfo | null> {
  try {
    return (await active.listSessions()).find((session) => session.id === id) ?? null;
  } catch {
    return null; /* Unknown health must not skip an ordinary blocking reply. */
  }
}
