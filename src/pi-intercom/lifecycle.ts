import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { IntercomConfig } from "./config.ts";
import { buildPresenceIdentity } from "./identity.ts";
import { resolveSessionProjectId } from "./session-targets.ts";
import type { SessionInfo } from "./types.ts";

/** Owns native context validity and occupancy, never journal or socket state. */
export class IntercomLifecycle {
  private context: ExtensionContext | null = null;
  private sessionId: string | null = null;
  private model = "unknown";
  private disposed = true;
  private started = false;
  private epoch = 0;
  private running = false;
  private activity = 0;
  private readonly tools = new Map<string, string>();
  private readonly pi: ExtensionAPI;
  private readonly config: IntercomConfig;
  constructor(pi: ExtensionAPI, config: IntercomConfig) {
    this.pi = pi;
    this.config = config;
  }
  get generation(): number {
    return this.epoch;
  }
  get currentSessionId(): string | null {
    return this.sessionId;
  }
  get runtimeStarted(): boolean {
    return this.started;
  }
  get toolCount(): number {
    return this.tools.size;
  }
  start(ctx: ExtensionContext): number {
    this.disposed = false;
    this.started = true;
    this.epoch += 1;
    this.context = ctx;
    this.sessionId = ctx.sessionManager.getSessionId();
    this.model = ctx.model?.id ?? "unknown";
    this.running = false;
    this.activity = 0;
    this.tools.clear();
    return this.epoch;
  }
  invalidate(): void {
    this.disposed = true;
    this.epoch += 1;
    this.running = false;
    this.tools.clear();
  }
  clear(): void {
    this.context = null;
    this.sessionId = null;
  }
  live(
    ctx: ExtensionContext | null = this.context,
    generation = this.epoch,
  ): ExtensionContext | null {
    if (this.disposed || generation !== this.epoch || !ctx) {
      return null;
    }
    try {
      if (this.sessionId !== null && ctx.sessionManager.getSessionId() !== this.sessionId) {
        return null;
      }
      // Reading a native property detects invalidated contexts without modifying them.
      const hasUI = ctx.hasUI;
      if (typeof hasUI !== "boolean") {
        return null;
      }
      return ctx;
    } catch {
      return null;
    }
  }
  notify(
    ctx: ExtensionContext,
    message: string,
    level: "info" | "warning" | "error",
    generation = this.epoch,
  ): void {
    const live = this.live(ctx, generation);
    if (live?.hasUI !== true) {
      return;
    }
    try {
      live.ui.notify(message, level);
    } catch {
      // The UI may disappear while an asynchronous overlay settles during shutdown.
    }
  }
  isIdle(ctx: ExtensionContext): boolean {
    // ponytail: Pi 1.0 has no busy signal during foreign prompt preparation.
    if (this.running || this.tools.size > 0) {
      return false;
    }
    try {
      return ctx.isIdle();
    } catch {
      return false;
    }
  }
  agentStart(): void {
    this.running = true;
    this.tools.clear();
  }
  agentSettled(): void {
    this.running = false;
    this.tools.clear();
  }
  toolStart(id: string, name: string): void {
    this.tools.set(id, name);
  }
  toolEnd(id: string): void {
    this.tools.delete(id);
  }
  selectModel(id: string): void {
    this.model = id;
  }
  markActivity(): void {
    this.activity = Date.now();
  }
  identity(sessionId: string): { readonly name: string } {
    return buildPresenceIdentity(this.pi, sessionId);
  }
  status(): string {
    const tool = this.tools.values().next().value;
    let status = this.running ? "thinking" : "idle";
    if (tool !== undefined && tool !== "") {
      status = `tool:${tool}`;
    }
    return this.config.status !== undefined && this.config.status !== ""
      ? `${status} · ${this.config.status}`
      : status;
  }
  health(pendingAsks: number): {
    readonly pendingAsks: number;
    readonly acceptsAsks: boolean;
    readonly lastIntercomActivity: number;
  } {
    const live = this.live();
    return {
      pendingAsks,
      acceptsAsks: live ? this.isIdle(live) : false,
      lastIntercomActivity: this.activity,
    };
  }
  async registration(pendingAsks: number): Promise<Omit<SessionInfo, "id">> {
    const live = this.live();
    if (!live || this.sessionId === null) {
      throw new Error("Intercom runtime not initialized");
    }
    const cwd = live.cwd;
    return {
      ...this.identity(this.sessionId),
      cwd,
      model: this.model,
      projectId: await resolveSessionProjectId(cwd),
      lastSeen: Date.now(),
      status: this.status(),
      ...this.health(pendingAsks),
    };
  }
  targetMatches(to: string, resolvedTo?: string | null, brokerId?: string | null): boolean {
    const targets = [
      this.sessionId,
      brokerId,
      this.pi.getSessionName(),
      this.sessionId === null ? undefined : this.identity(this.sessionId).name,
    ];
    return (
      (resolvedTo !== undefined &&
        resolvedTo !== null &&
        brokerId !== undefined &&
        brokerId !== null &&
        resolvedTo === brokerId) ||
      targets.some((target) => target?.trim().toLowerCase() === to.trim().toLowerCase())
    );
  }
}
