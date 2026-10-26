import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { IntercomClient } from "./broker/client.ts";
import type { IntercomTransport } from "./transport.ts";
import { spawnBrokerIfNeeded } from "./broker/spawn.ts";
import type { IntercomConfig } from "./config.ts";
import type { IntercomLifecycle } from "./lifecycle.ts";
import type { Message, SessionInfo, ReceiptQuery, ReceiptResult } from "./types.ts";
import type { NativeReadQuery } from "./broker/last.ts";
import { readLastMessage } from "./last-message.ts";
import { asError } from "./validation.ts";
import { RecoveryError } from "./tool-results.ts";
import { formatTargetOptions, resolveSessionTarget, nativePeerId } from "./session-targets.ts";

type Lifecycle = Pick<
  Readonly<IntercomLifecycle>,
  "currentSessionId" | "generation" | "health" | "identity" | "live" | "registration" | "status"
> &
  Pick<Readonly<IntercomLifecycle>, "snapshot" | "transport">;

interface ConnectionHooks {
  readonly restoring: () => Promise<void> | undefined;
  readonly pendingAsks: () => number;
  readonly receipt: (query: ReceiptQuery) => ReceiptResult;
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
  private readonly lifecycle: Lifecycle;
  private readonly config: IntercomConfig;
  private readonly hooks: ConnectionHooks;
  constructor(lifecycle: Lifecycle, config: IntercomConfig, hooks: ConnectionHooks) {
    this.lifecycle = lifecycle;
    this.config = config;
    this.hooks = hooks;
  }
  get active(): IntercomTransport | null {
    return this.client;
  }
  start(ctx: ExtensionContext, generation: number): void {
    this.attempt = 0;
    this.clearTimers();
    this.scheduleStartup(ctx, generation);
  }
  private clearStartup(): void {
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
  private scheduleStartup(ctx: ExtensionContext, generation: number): void {
    this.clearStartup();
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      if (!this.lifecycle.live(ctx, generation)) {
        return;
      }
      this.ensure().catch(() => {
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
      this.ensure().catch(() => {
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
        applicationGuard: this.lifecycle.snapshot().applicationGuard ?? null,
      });
    }
  }
  private createClient(): IntercomClient {
    const next = new IntercomClient({
      sendTimeoutMs: this.config.sendTimeoutMs,
      listTimeoutMs: this.config.listTimeoutMs,
    });
    this.client = next;
    next.on(
      "last_request",
      (request: { readonly requestId: string; readonly query: NativeReadQuery }) => {
        const ctx = this.lifecycle.live();
        const id = next.sessionId;
        if (this.client !== next || !ctx || id === null) {
          next.respondLast(request.requestId, { error: "Intercom runtime no longer active" });
          return;
        }
        try {
          if ("messageId" in request.query) {
            next.respondLast(request.requestId, this.hooks.receipt(request.query));
            return;
          }
          next.respondLast(
            request.requestId,
            readLastMessage(
              ctx.sessionManager,
              {
                id,
                ...this.lifecycle.identity(ctx.sessionManager.getSessionId()),
                cwd: ctx.cwd,
                model: ctx.model?.id ?? "unknown",
                status: this.lifecycle.status(),
              },
              request.query,
            ),
          );
        } catch (error) {
          next.respondLast(request.requestId, { error: asError(error).message });
        }
      },
    );
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
      this.hooks.peerLeft(id);
    });
    next.on("disconnected", (error: Readonly<Error>) => {
      if (this.client !== next) {
        return;
      }
      this.hooks.disconnected(error);
      this.client = null;
      this.lifecycle.transport(null);
      this.clearReconnect();
      this.scheduleReconnect();
    });
    next.on("error", () => {
      /* Disconnect owns recovery; suppress socket noise in the TUI. */
    });
    return next;
  }
  private async connect(
    ctx: ExtensionContext,
    generation: number,
    sessionId: string,
  ): Promise<IntercomTransport> {
    const next = this.createClient();
    try {
      await spawnBrokerIfNeeded(this.config.brokerCommand, this.config.brokerArgs);
      await next.connect(
        await this.lifecycle.registration(this.hooks.pendingAsks()),
        nativePeerId(sessionId),
      );
      if (!this.lifecycle.live(ctx, generation)) {
        await next.disconnect();
        throw new Error("Intercom runtime no longer active");
      }
      this.client = next;
      this.lifecycle.transport(next.sessionId, next.supportsGuardedDelivery);
      this.syncIdentity(ctx.sessionManager.getSessionId());
      this.attempt = 0;
      return next;
    } catch (error) {
      if (this.client === next) {
        this.client = null;
      }
      // A failed registration still owns its socket.
      await next.disconnect().catch((cleanupError: unknown) => {
        console.error("Intercom failed connection cleanup:", cleanupError);
      });
      throw asError(error);
    }
  }
  async ensure(): Promise<IntercomTransport> {
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
    const attempt = Promise.resolve().then(() => this.connect(ctx, generation, sessionId));
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
    throw new RecoveryError(
      "ambiguous_target",
      `Target "${name}" matches multiple sessions. Use one of these targets: ${formatTargetOptions(resolution.matches, sessions)}.`,
    );
  }
  if (resolution.status === "prefix_too_short") {
    throw new RecoveryError(
      "ambiguous_target",
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
