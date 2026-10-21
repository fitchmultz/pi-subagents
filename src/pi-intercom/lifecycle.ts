import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { IntercomConfig } from "./config.ts";
import { buildPresenceIdentity, type IntercomLineage } from "./identity.ts";
import { resolveSessionProjectId } from "./session-targets.ts";
import type { SessionInfo } from "./types.ts";

/** Owns native context validity and occupancy, never journal or socket state. */
export class IntercomLifecycle {
  private context: ExtensionContext | null = null;
  private sessionId: string | null = null;
  private model = "unknown";
  private disposed = true;
  private epoch = 0;
  private running = false;
  private activity = 0;
  private readonly tools = new Map<string, string>();
  private readonly pi: ExtensionAPI;
  private readonly config: IntercomConfig;
  private readonly lineage: IntercomLineage | undefined;
  constructor(pi: ExtensionAPI, config: IntercomConfig, lineage?: IntercomLineage) {
    this.pi = pi;
    this.config = config;
    this.lineage = lineage;
  }
  get generation(): number {
    return this.epoch;
  }
  get currentSessionId(): string | null {
    return this.sessionId;
  }
  get toolCount(): number {
    return this.tools.size;
  }
  start(ctx: ExtensionContext): number {
    this.disposed = false;
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
  identity(sessionId: string): {
    readonly name: string;
    readonly rootSessionId: string;
    readonly parentSessionId?: string;
  } {
    return {
      ...buildPresenceIdentity(this.pi, sessionId),
      rootSessionId: this.lineage?.rootSessionId ?? sessionId,
      parentSessionId: this.lineage?.parentSessionId,
    };
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
}
