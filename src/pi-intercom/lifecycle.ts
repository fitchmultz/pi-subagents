import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import type { IntercomConfig } from "./config.ts";
import { buildPresenceIdentity, type IntercomLineage } from "./identity.ts";
import { resolveSessionProjectId } from "./session-targets.ts";
import {
  isContextTarget,
  type ContextTarget,
  type DeliveryGuard,
  type SessionInfo,
} from "./types.ts";
import { isRecord, safeLabel } from "./validation.ts";

export function isContextRequest(value: unknown): value is Readonly<Record<string, unknown>> & {
  readonly respond: (response: unknown) => void;
} {
  return isRecord(value) && typeof value.respond === "function";
}

type ContextSnapshot = Readonly<Record<keyof ContextTarget, string | null>> &
  Pick<SessionInfo, "parentSessionId" | "applicationGuard"> & {
    readonly version: 1;
    readonly connected: boolean;
    readonly guardedDelivery: 1 | null;
  };

type ContextState =
  | { readonly kind: "inactive"; readonly epoch: number }
  | { readonly kind: "invalidated"; readonly epoch: number; readonly sessionId: string }
  | {
      readonly kind: "live";
      readonly epoch: number;
      readonly context: ExtensionContext;
      readonly sessionId: string;
      readonly incarnation: string;
    };
/** The registration this process holds; absent until a broker accepts its transport. */
interface TransportState {
  readonly peerId: string;
  readonly guardedDelivery: boolean;
}

/** Owns native context validity and occupancy, never journal or socket state. */
export class IntercomLifecycle {
  private state: ContextState = { kind: "inactive", epoch: 0 };
  private model = "unknown";
  private transportPeer?: TransportState | undefined;
  private applicationGuard: string | undefined;
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
    return this.state.epoch;
  }
  get currentSessionId(): string | null {
    return this.state.kind === "inactive" ? null : this.state.sessionId;
  }
  get toolCount(): number {
    return this.tools.size;
  }
  registerContextEvents(sync: () => void): void {
    this.pi.events.on("pi-intercom:context-query", (request) => this.contextRequest(request));
    this.pi.events.on("pi-intercom:application-guard", (request) =>
      this.contextRequest(request, sync),
    );
  }
  private contextRequest(request: unknown, sync?: () => void): void {
    if (!isContextRequest(request)) {
      return;
    }
    if (request.version !== 1) {
      request.respond({ error: "unsupported_version" });
      return;
    }
    if (sync) {
      if (
        !isContextTarget(request.target) ||
        !this.matches(request.target) ||
        !(
          request.revision === null ||
          (typeof request.revision === "string" && safeLabel(request.revision))
        )
      ) {
        request.respond({ error: "context_changed" });
        return;
      }
      this.applicationGuard = request.revision === null ? undefined : request.revision;
      sync();
      this.publishContext();
    }
    request.respond(this.snapshot());
  }
  snapshot(): ContextSnapshot {
    if (this.state.kind !== "live" || !this.live()) {
      return {
        version: 1,
        rootSessionId: null,
        peerId: null,
        incarnation: null,
        connected: false,
        guardedDelivery: null,
      } as const;
    }
    return {
      version: 1,
      rootSessionId: this.lineage?.rootSessionId ?? this.state.sessionId,
      parentSessionId: this.lineage?.parentSessionId,
      peerId: this.transportPeer?.peerId ?? null,
      incarnation: this.state.incarnation,
      connected: this.transportPeer !== undefined,
      guardedDelivery: this.transportPeer?.guardedDelivery === true ? 1 : null,
      applicationGuard: this.applicationGuard,
    } as const;
  }
  private publishContext(): void {
    this.pi.events.emit("pi-intercom:context-state", this.snapshot());
  }
  transport(peerId: string | null, guardedDelivery = false): void {
    this.transportPeer = peerId === null ? undefined : { peerId, guardedDelivery };
    this.publishContext();
  }
  private matches(target: ContextTarget): boolean {
    const current = this.snapshot();
    return (
      current.connected &&
      current.rootSessionId === target.rootSessionId &&
      current.peerId === target.peerId &&
      current.incarnation === target.incarnation
    );
  }
  accepts(guard: DeliveryGuard): boolean {
    return (
      this.transportPeer?.guardedDelivery === true &&
      this.lineage?.parentSessionId === undefined &&
      this.matches(guard) &&
      this.applicationGuard === guard.applicationGuard
    );
  }
  start(ctx: ExtensionContext): number {
    this.state = {
      kind: "live",
      epoch: this.state.epoch + 1,
      context: ctx,
      sessionId: ctx.sessionManager.getSessionId(),
      incarnation: randomUUID(),
    };
    this.applicationGuard = undefined;
    this.model = ctx.model?.id ?? "unknown";
    this.running = false;
    this.activity = 0;
    this.tools.clear();
    this.transport(null);
    return this.state.epoch;
  }
  invalidate(): void {
    const epoch = this.state.epoch + 1;
    this.state =
      this.state.kind === "inactive"
        ? { kind: "inactive", epoch }
        : { kind: "invalidated", epoch, sessionId: this.state.sessionId };
    this.running = false;
    this.tools.clear();
    this.publishContext();
  }
  clear(): void {
    this.state = { kind: "inactive", epoch: this.state.epoch };
  }
  live(
    ctx: ExtensionContext | null = this.state.kind === "live" ? this.state.context : null,
    generation = this.state.epoch,
  ): ExtensionContext | null {
    if (this.state.kind !== "live" || generation !== this.state.epoch || !ctx) {
      return null;
    }
    try {
      if (ctx.sessionManager.getSessionId() !== this.state.sessionId) {
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
  identity(sessionId: string): Pick<SessionInfo, "name" | "rootSessionId" | "parentSessionId"> {
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
  health(
    pendingAsks: number,
  ): Pick<SessionInfo, "pendingAsks" | "acceptsAsks" | "lastIntercomActivity"> {
    const live = this.live();
    return {
      pendingAsks,
      acceptsAsks: live ? this.isIdle(live) : false,
      lastIntercomActivity: this.activity,
    };
  }
  async registration(pendingAsks: number): Promise<Omit<SessionInfo, "id">> {
    const live = this.live();
    if (!live || this.state.kind !== "live") {
      throw new Error("Intercom runtime not initialized");
    }
    return {
      ...this.identity(this.state.sessionId),
      incarnation: this.state.incarnation,
      guardedDelivery: 1,
      applicationGuard: this.applicationGuard,
      cwd: live.cwd,
      model: this.model,
      projectId: await resolveSessionProjectId(live.cwd),
      lastSeen: Date.now(),
      status: this.status(),
      ...this.health(pendingAsks),
    };
  }
}
