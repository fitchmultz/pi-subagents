import * as fs from "node:fs";
import * as net from "node:net";
import { once } from "node:events";
import { timingSafeEqual } from "node:crypto";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { createMessageReader } from "../pi-intercom/broker/framing.ts";
import {
  agentObservationSocketPath,
  preparePrivateSocketPath,
} from "../pi-intercom/broker/paths.ts";
import { errorMessage, isRecord } from "../shared/unknown.ts";
import { LiveState, type ToolEvent } from "./observation-state.ts";
import { Viewer, type Level } from "./observation-view.ts";

const CONTENT_MS = 250;
const ACTIVITY_MS = 1000;
const HELLO_MS = 2000;
const HELLO_BYTES = 4096;
const LIMITS: Readonly<Record<Level, number>> = { detail: 4, activity: 8 };

export interface ObservationIdentity {
  readonly token: string;
  readonly rootId: string;
  readonly sessionId: string;
}
export interface ObservationStats {
  error?: string;
  viewers: number;
  refused: number;
  frames: number;
  bytes: number;
  largestFrame: number;
  largestBuffered: number;
  backpressured: number;
  drains: number;
  resyncs: number;
  flushes: number;
  flushMs: number;
  slowestFlushMs: number;
  listenerMs: number;
  subscriptions: number;
  events: number;
  toolEvents: number;
  progressUpdates: number;
  projections: number;
  unavailable: number;
  settled: number;
  evicted: number;
}

function sameSecret(actual: unknown, expected: string): boolean {
  const left = Buffer.from(typeof actual === "string" ? actual : "");
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Actor-owned, read-only, push-only live view of the native child session. The actor is the sole
 * publisher; viewers can only connect, say hello once and read. The journal stays authoritative.
 */
export class ActorObservation {
  private readonly state: LiveState;
  private readonly viewers = new Set<Viewer>();
  private readonly greeting = new Set<net.Socket>();
  private server?: net.Server | undefined;
  private socketPath?: string | undefined;
  private inode?: number;
  private unsubscribe?: (() => void) | undefined;
  private timer?: NodeJS.Timeout | undefined;
  private closed = false;
  /** The actor's run is in progress, including native work before and after the agent loop. */
  private running = false;
  private lastContent = -Infinity;
  private lastActivity = -Infinity;
  private dueAt = 0;
  private readonly stats: Omit<
    ObservationStats,
    | "events"
    | "toolEvents"
    | "progressUpdates"
    | "projections"
    | "unavailable"
    | "settled"
    | "evicted"
  > = {
    viewers: 0,
    refused: 0,
    frames: 0,
    bytes: 0,
    largestFrame: 0,
    largestBuffered: 0,
    backpressured: 0,
    drains: 0,
    resyncs: 0,
    flushes: 0,
    flushMs: 0,
    slowestFlushMs: 0,
    listenerMs: 0,
    subscriptions: 0,
  };
  private readonly session: AgentSession;
  private readonly identity: ObservationIdentity;
  private constructor(session: AgentSession, identity: ObservationIdentity) {
    this.session = session;
    this.identity = identity;
    this.state = new LiveState(
      session,
      () => this.schedule(),
      (error) => this.fail(error),
    );
  }
  /** Never rejects: observation faults disable observation, not native execution. */
  static async open(
    session: AgentSession,
    identity: ObservationIdentity,
  ): Promise<ActorObservation> {
    const observation = new ActorObservation(session, identity);
    try {
      await observation.listen();
    } catch (error) {
      observation.fail(error);
    }
    return observation;
  }
  private async listen(): Promise<void> {
    const socketPath = preparePrivateSocketPath(agentObservationSocketPath(this.identity.token));
    if (fs.lstatSync(socketPath, { throwIfNoEntry: false }) !== undefined) {
      throw new Error("Observation endpoint already exists; refusing to replace it.");
    }
    const server = net.createServer(this.accept);
    this.server = server;
    server.on("error", (error) => this.fail(error));
    server.listen(socketPath);
    await once(server, "listening");
    this.socketPath = socketPath;
    fs.chmodSync(socketPath, 0o600);
    this.inode = fs.lstatSync(socketPath).ino;
  }
  /** Native callbacks run inline before persistence: assign references, never throw or await. */
  private native(apply: () => void): void {
    if (this.closed) {
      return;
    }
    const started = performance.now();
    try {
      apply();
      this.schedule();
    } catch (error) {
      this.fail(error);
    }
    this.stats.listenerMs += performance.now() - started;
  }
  private readonly listener = (event: AgentSessionEvent): void => {
    this.native(() => this.state.apply(event));
  };
  /** Sparse tool lifecycle hook, registered by the actor's own extension. */
  tool(event: ToolEvent): void {
    this.native(() => this.state.tool(event));
  }
  /** Run lifecycle from the actor: compact activity is sampled from native state meanwhile. */
  working(running: boolean): void {
    this.native(() => {
      this.running = running;
      this.state.activityVersion++;
    });
  }
  private busy(): boolean {
    const { session } = this;
    return this.running || session.isStreaming || session.isCompacting || session.isRetrying;
  }
  /** A live viewer keeps its actor resident; parking would end the native stream it reads. */
  get watched(): boolean {
    return this.viewers.size + this.greeting.size > 0;
  }
  private details(): number {
    return [...this.viewers].filter((viewer) => viewer.level === "detail").length;
  }
  /** Token-rate native events are subscribed only while a validated detail viewer reads them. */
  private observe(on: boolean): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.state.observe(on);
    if (on) {
      this.stats.subscriptions++;
      this.unsubscribe = this.session.subscribe(this.listener);
    }
  }
  private readonly accept = (socket: net.Socket): void => {
    socket.on("error", () => {
      socket.destroy();
    });
    if (this.closed || this.viewers.size + this.greeting.size >= LIMITS.detail + LIMITS.activity) {
      this.stats.refused++;
      socket.destroy();
      return;
    }
    this.greeting.add(socket);
    const timeout = setTimeout(() => {
      socket.destroy();
    }, HELLO_MS);
    timeout.unref();
    let viewer: Viewer | undefined;
    let greeted = false;
    const reader = createMessageReader(
      (message) => {
        clearTimeout(timeout);
        // Observation is push-only: anything after the hello closes this viewer.
        viewer = greeted ? viewer : this.hello(socket, message);
        if (greeted || viewer === undefined) {
          socket.destroy();
        }
        greeted = true;
      },
      () => {
        socket.destroy();
      },
      HELLO_BYTES,
    );
    socket.on("data", reader);
    socket.on("close", () => {
      clearTimeout(timeout);
      this.greeting.delete(socket);
      const detail = viewer?.level === "detail";
      if (viewer && this.viewers.delete(viewer) && detail && this.details() === 0 && !this.closed) {
        this.observe(false);
        this.schedule();
      }
    });
  };
  private hello(socket: net.Socket, message: unknown): Viewer | undefined {
    this.greeting.delete(socket);
    const level = this.helloLevel(message);
    const count = [...this.viewers].filter((viewer) => viewer.level === level).length;
    if (level === undefined || this.closed || count >= LIMITS[level]) {
      this.stats.refused++;
      return undefined;
    }
    const viewer = new Viewer(socket, level);
    socket.on("drain", () => {
      viewer.blocked = false;
      this.stats.drains++;
      this.schedule();
    });
    this.viewers.add(viewer);
    this.stats.viewers++;
    try {
      if (level === "detail" && this.details() === 1) {
        this.observe(true);
      }
      this.send(viewer, this.snapshot(viewer));
      this.schedule();
    } catch (error) {
      this.fail(error);
    }
    return viewer;
  }
  private helloLevel(message: unknown): Level | undefined {
    if (
      !isRecord(message) ||
      message.t !== "hello" ||
      message.v !== 1 ||
      !sameSecret(message.token, this.identity.token) ||
      message.rootId !== this.identity.rootId ||
      message.sessionId !== this.identity.sessionId
    ) {
      return undefined;
    }
    return message.level === "detail" || message.level === "activity" ? message.level : undefined;
  }
  /** Published entries are found first, so the leaf covers everything no longer live. */
  private snapshot(viewer: Viewer): string {
    this.state.resolve();
    const { token, rootId, sessionId } = this.identity;
    const head = JSON.stringify({ t: "snapshot", v: 1, generation: token, rootId, sessionId });
    const leafId = JSON.stringify(this.session.sessionManager.getLeafId());
    const activity = this.state.activity(this.running);
    return viewer.snapshot(this.state, `${head.slice(0, -1)},"leafId":${leafId}`, activity);
  }
  private contentWork(): boolean {
    return [...this.viewers].some((viewer) => viewer.wants(this.state));
  }
  /** Sampled once a second while native work runs; otherwise only after a sparse change. */
  private activityWork(): boolean {
    const version = this.state.activityVersion;
    return (
      this.busy() ||
      [...this.viewers].some((viewer) => !viewer.blocked && viewer.activitySeen !== version)
    );
  }
  /** One timer, armed only while a connected viewer has unsent changes or native work runs. */
  private schedule(): void {
    // An armed timer already covers anything due no earlier than the next content slot.
    const armed = this.timer === undefined ? Infinity : this.dueAt;
    if (armed <= this.lastContent + CONTENT_MS || this.closed || this.viewers.size === 0) {
      return;
    }
    const content = this.contentWork() ? this.lastContent + CONTENT_MS : Infinity;
    const activity = this.activityWork() ? this.lastActivity + ACTIVITY_MS : Infinity;
    const due = Math.min(content, activity);
    if (due < armed) {
      clearTimeout(this.timer);
      this.dueAt = due;
      this.timer = setTimeout(this.flush, Math.max(0, due - performance.now()));
      this.timer.unref();
    }
  }
  private readonly flush = (): void => {
    const started = performance.now();
    // Node's cached loop clock can fire a timer just before performance.now() reaches it.
    const now = Math.max(started, this.dueAt);
    try {
      // Retry unresolved publication without a timer of its own.
      this.state.resolve();
      if (now >= this.lastContent + CONTENT_MS && this.contentWork()) {
        this.lastContent = now;
        this.broadcastContent();
      }
      if (now >= this.lastActivity + ACTIVITY_MS && this.activityWork()) {
        this.lastActivity = now;
        this.broadcastActivity();
      }
      const elapsed = performance.now() - started;
      this.stats.flushes++;
      this.stats.flushMs += elapsed;
      this.stats.slowestFlushMs = Math.max(this.stats.slowestFlushMs, elapsed);
      this.timer = undefined;
      this.schedule();
    } catch (error) {
      this.timer = undefined;
      this.fail(error);
    }
  };
  private broadcastContent(): void {
    for (const viewer of this.viewers) {
      if (viewer.wants(this.state) && viewer.stale(this.state)) {
        this.stats.resyncs++;
        this.send(viewer, this.snapshot(viewer));
      }
      const delta = viewer.wants(this.state) ? viewer.delta(this.state) : undefined;
      if (delta !== undefined) {
        this.send(viewer, delta);
      }
    }
  }
  private broadcastActivity(): void {
    const activity = this.state.activity(this.running);
    for (const viewer of this.viewers) {
      const frame = viewer.activityFrame(this.state, activity);
      if (frame !== undefined) {
        this.send(viewer, frame);
      }
    }
  }
  private send(viewer: Viewer, json: string): void {
    const bytes = Buffer.byteLength(json) + 4;
    const buffered = viewer.write(json);
    this.stats.frames++;
    this.stats.bytes += bytes;
    this.stats.largestFrame = Math.max(this.stats.largestFrame, bytes);
    this.stats.largestBuffered = Math.max(this.stats.largestBuffered, buffered);
    this.stats.backpressured += viewer.blocked ? 1 : 0;
  }
  private fail(error: unknown): void {
    this.stats.error ??= errorMessage(error);
    if (!this.closed) {
      this.closed = true;
      console.error(`Child observation disabled: ${this.stats.error}`);
      // Teardown leaves the native callback that observed the fault.
      setImmediate(() => this.release());
    }
  }
  /** Observation-only teardown; its own failures are recorded, never thrown into the actor. */
  private release(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.state.dispose();
    // The endpoint goes first: a disconnected viewer proves removal was already attempted.
    const socketPath = this.socketPath;
    this.socketPath = undefined;
    try {
      if (
        socketPath !== undefined &&
        fs.lstatSync(socketPath, { throwIfNoEntry: false })?.ino === this.inode
      ) {
        fs.unlinkSync(socketPath);
      }
    } catch (error) {
      this.stats.error ??= `Observation endpoint removal failed: ${errorMessage(error)}`;
    }
    this.server?.close();
    this.server = undefined;
    for (const socket of [...this.greeting, ...[...this.viewers].map((viewer) => viewer.socket)]) {
      socket.destroy();
    }
  }
  /** Idempotent. Releases observation only; never stops or signals the actor's work. */
  close(): ObservationStats {
    this.closed = true;
    this.release();
    const { events, toolEvents, progressUpdates, projections, unavailable, settled, evicted } =
      this.state;
    const counts = { events, toolEvents, progressUpdates, projections, unavailable };
    return { ...this.stats, ...counts, settled, evicted };
  }
}
