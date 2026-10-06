import { randomUUID } from "node:crypto";
import { IntercomClient } from "./broker/client.ts";
import {
  formatSessionTarget,
  resolveSessionProjectId,
  resolveSessionTarget,
} from "./session-targets.ts";
import type { Message, SendResult, SessionInfo } from "./types.ts";
import type { Identity } from "./bridge-config.ts";
import { Fault, INBOX_BYTES, INBOX_COUNT, cancelled, log, wait } from "./bridge-protocol.ts";
import type { UnknownRecord } from "../shared/unknown.ts";
import type { Operation } from "./bridge-routes.ts";

import { WaitingAsk, type Envelope } from "./bridge-ask.ts";
const MAX_REQUESTS = 8;
const IDLE_TIMEOUT = 5 * 60 * 1000;
const SEND_TIMEOUT = 8000;
const LIST_TIMEOUT = 5000;

interface InboxEntry extends Envelope {
  readonly bytes: number;
  replying: boolean;
}
interface RequestContext {
  readonly signal: AbortSignal;
  readonly requestId: string;
  readonly onPeer: (peer: string) => void;
}
interface SendOptions {
  readonly messageId?: string;
  readonly replyTo?: string;
  readonly expectsReply?: boolean;
}
export interface SessionOwner {
  readonly allowed: (identity: Identity) => boolean;
  readonly lost: (fp: string, count?: number) => void;
  readonly retired: (fp: string, generation: string) => void;
  readonly losses: (fp: string) => number;
}

export class Session {
  readonly generation = randomUUID();
  readonly identity: Identity;
  private readonly owner: SessionOwner;
  private readonly expires: number;
  private readonly client = new IntercomClient({
    sendTimeoutMs: SEND_TIMEOUT,
    listTimeoutMs: LIST_TIMEOUT,
  });
  private readonly requests = new Set<AbortController>();
  private readonly inbox = new Map<string, InboxEntry>();
  private inboxBytes = 0;
  private pending?: WaitingAsk;
  private closed = false;
  private connecting?: Promise<void>;
  private disconnecting?: Promise<void>;
  private retirement?: Promise<void>;
  private lease?: NodeJS.Timeout;
  private closeReason: Fault = new Fault(503, "broker_unavailable", "Broker connection failed.");

  constructor(owner: SessionOwner, identity: Identity, expires: number) {
    this.owner = owner;
    this.identity = identity;
    this.expires = expires;
    this.client.on("error", () =>
      this.close(new Fault(503, "broker_unavailable", "Broker connection failed.")),
    );
    this.client.on("disconnected", () =>
      this.close(new Fault(503, "broker_disconnected", "Broker disconnected.")),
    );
    this.client.on("_registered", () => {
      // Socket acquisition is not abortable: retire a cancelled generation before any application write.
      if (this.closed) {
        this.disconnect().catch((error: unknown) => this.cleanupFailed(error));
      }
    });
    this.client.on("message", (from: SessionInfo, message: Message) => this.receive(from, message));
    this.client.on("session_left", (id: string) => this.peerLeft(id));
    this.touch();
  }

  guard(signal?: AbortSignal): void {
    if (signal) {
      cancelled(signal);
    }
    if (this.closed) {
      throw this.closeReason;
    }
    if (!this.owner.allowed(this.identity)) {
      throw new Fault(403, "revoked", "Identity is no longer authorized.");
    }
    if (this.expires <= Date.now()) {
      const error = new Fault(403, "certificate_expired", "Client certificate expired.");
      this.close(error);
      throw error;
    }
  }
  private touch(): void {
    clearTimeout(this.lease);
    this.lease = setTimeout(
      () =>
        this.close(
          this.expires <= Date.now()
            ? new Fault(403, "certificate_expired", "Client certificate expired.")
            : new Fault(410, "lease_expired", "Bridge session idle lease expired."),
        ),
      Math.max(1, Math.min(IDLE_TIMEOUT, this.expires - Date.now())),
    );
  }
  begin(): AbortController {
    this.guard();
    if (this.requests.size >= MAX_REQUESTS) {
      throw new Fault(429, "too_many_requests", "Too many concurrent requests for this identity.");
    }
    const controller = new AbortController();
    this.requests.add(controller);
    this.touch();
    return controller;
  }
  end(controller: AbortController): void {
    this.requests.delete(controller);
  }
  fields(): UnknownRecord {
    return { name: this.identity.name, fingerprint: this.identity.fingerprint256 };
  }

  private async establish(): Promise<void> {
    const projectId = await resolveSessionProjectId(this.identity.cwd);
    this.guard();
    const id = `remote-${this.identity.fingerprint256.toLowerCase()}`;
    await this.client.connect(
      {
        name: this.identity.name,
        cwd: this.identity.cwd,
        model: "remote-bridge",
        projectId,
        status: "idle",
        acceptsAsks: true,
        pendingAsks: 0,
      },
      id,
    );
    if (this.closed) {
      await this.disconnect();
      return;
    }
    if (this.client.sessionId !== id) {
      const fault = new Fault(
        409,
        "identity_in_use",
        "This remote identity is already registered by another connection.",
      );
      this.close(fault);
      throw fault;
    }
    log("registered", this.fields());
  }
  private async connect(signal: AbortSignal): Promise<void> {
    this.guard(signal);
    this.connecting ??= this.establish().catch((error: unknown) => {
      if (!this.closed) {
        this.close(
          error instanceof Fault
            ? error
            : new Fault(
                503,
                "broker_unavailable",
                "Local broker is unavailable; bridge does not start it.",
              ),
        );
      }
      throw error;
    });
    await wait(this.connecting, signal);
    this.guard(signal);
  }
  private disconnect(): Promise<void> {
    this.disconnecting ??= this.client.disconnect().finally(() => {
      this.disconnecting = undefined;
    });
    return this.disconnecting;
  }
  private cleanupFailed(_error: unknown): void {
    // Never log caught broker details or remove an unsuccessfully retired generation.
    log("session_cleanup", { ...this.fields(), result: "failed" });
  }
  private async retire(): Promise<void> {
    await this.disconnect();
    try {
      await this.connecting;
    } catch {
      // The original request receives the connection failure; teardown must still close a late socket.
    }
    await this.disconnect();
    this.owner.retired(this.identity.fingerprint256, this.generation);
  }
  close(error: Readonly<Fault>): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeReason = error;
    clearTimeout(this.lease);
    this.pending?.reject(error);
    for (const controller of this.requests) {
      controller.abort(error);
    }
    this.owner.lost(this.identity.fingerprint256, this.inbox.size);
    this.inbox.clear();
    this.inboxBytes = 0;
    // Retain the generation until acquisition/registration AND final disconnect settle.
    this.startRetirement();
    log("session_closed", { ...this.fields(), result: error.code });
  }
  private startRetirement(): void {
    this.retirement = this.retire().catch((caught: unknown) => this.cleanupFailed(caught));
  }
  async settled(): Promise<void> {
    await this.retirement;
  }

  private peerLeft(id: string): void {
    if (this.pending?.peer === id && !this.pending.settled) {
      this.pending.reject(
        new Fault(409, "peer_offline", "Ask recipient disconnected.", { id: this.pending.id }),
      );
    }
    for (const [messageId, entry] of this.inbox) {
      if (entry.from.id === id && entry.message.expectsReply === true) {
        this.remove(messageId);
        this.owner.lost(this.identity.fingerprint256);
      }
    }
    this.presence();
  }
  private receive(from: SessionInfo, message: Message): void {
    if (this.closed) {
      return;
    }
    try {
      this.guard();
    } catch (error) {
      this.close(
        error instanceof Fault
          ? error
          : new Fault(403, "revoked", "Identity is no longer authorized."),
      );
      return;
    }
    log("received", { ...this.fields(), peer: from.id, messageId: message.id, result: "received" });
    const pending = this.pending;
    if (pending?.matches(from.id, message.replyTo) === true) {
      pending.resolve({ from, message });
      return;
    }
    if (this.inbox.has(message.id)) {
      this.owner.lost(this.identity.fingerprint256);
      return;
    }
    const bytes = Buffer.byteLength(JSON.stringify({ from, message }));
    if (this.inbox.size >= INBOX_COUNT || this.inboxBytes + bytes > INBOX_BYTES) {
      this.owner.lost(this.identity.fingerprint256);
      log("inbox_overflow", {
        ...this.fields(),
        peer: from.id,
        messageId: message.id,
        result: "lost",
      });
      return;
    }
    // ponytail: bounded volatile inbox; use a private durable journal if restart/lease-loss recovery is required.
    this.inbox.set(message.id, { from, message, bytes, replying: false });
    this.inboxBytes += bytes;
    this.presence();
  }
  private remove(id: string): void {
    const entry = this.inbox.get(id);
    if (entry) {
      this.inboxBytes -= entry.bytes;
      this.inbox.delete(id);
    }
  }
  private presence(): void {
    if (this.closed) {
      return;
    }
    const pendingAsks = [...this.inbox.values()].filter(
      (entry) => entry.message.expectsReply === true,
    ).length;
    this.client.updatePresence({
      pendingAsks,
      acceptsAsks: this.inbox.size < INBOX_COUNT && this.inboxBytes < INBOX_BYTES,
    });
  }
  private async peers(signal: AbortSignal): Promise<SessionInfo[]> {
    this.guard(signal);
    let peers: SessionInfo[];
    try {
      peers = await wait(this.client.listSessions(), signal);
    } catch (error) {
      cancelled(signal);
      if (error instanceof Error && error.message === "List sessions timeout") {
        throw new Fault(504, "list_timeout", "Broker session list deadline exceeded.");
      }
      throw new Fault(503, "broker_unavailable", "Broker session list failed.");
    }
    this.guard(signal);
    return peers;
  }
  private async target(to: string, signal: AbortSignal): Promise<SessionInfo> {
    const resolution = resolveSessionTarget(await this.peers(signal), to);
    if (resolution.status === "none") {
      throw new Fault(404, "peer_offline", "Peer is not connected.");
    }
    if (resolution.status !== "found" || !resolution.target) {
      throw new Fault(
        409,
        "ambiguous_target",
        "Use an unambiguous peer name or session ID (prefixes need at least 8 characters).",
      );
    }
    if (resolution.target.id === this.client.sessionId) {
      throw new Fault(400, "self_target", "Choose another peer.");
    }
    return resolution.target;
  }
  private async send(
    peer: string,
    message: string,
    context: RequestContext,
    options: SendOptions = {},
  ): Promise<SendResult> {
    const { signal, requestId } = context;
    context.onPeer(peer);
    this.guard(signal);
    const id = options.messageId ?? randomUUID();
    log("send", { ...this.fields(), requestId, peer, messageId: id, result: "attempt" });
    let result: SendResult;
    try {
      result = await wait(
        this.client.send(peer, { text: message, delivery: "steer", ...options, messageId: id }),
        signal,
      );
    } catch {
      cancelled(signal);
      const fault = new Fault(
        504,
        "send_unconfirmed",
        "Broker acknowledgement was not received; delivery is unknown. Do not automatically retry.",
        { id, deliveryUnknown: true },
      );
      this.close(fault);
      throw fault;
    }
    this.guard(signal);
    log("send_result", {
      ...this.fields(),
      requestId,
      peer,
      messageId: id,
      result: result.accepted ? "accepted" : "rejected",
    });
    if (!result.accepted) {
      throw new Fault(409, "delivery_failed", result.reason ?? "Broker rejected delivery.", {
        id,
        accepted: false,
        delivered: false,
      });
    }
    return result;
  }
  private async ask(
    operation: Extract<Operation, { readonly route: "POST /v1/ask" }>,
    context: RequestContext,
  ): Promise<UnknownRecord> {
    if (this.pending) {
      throw new Fault(409, "ask_in_progress", "Only one concurrent ask is allowed per identity.");
    }
    const waiting = new WaitingAsk();
    this.pending = waiting;
    const { signal } = context;
    const abort = () => {
      try {
        cancelled(signal);
      } catch (error) {
        waiting.reject(
          error instanceof Error
            ? error
            : new Fault(
                499,
                "client_aborted",
                "HTTP client disconnected; delivery may be unknown.",
              ),
        );
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      await this.connect(signal);
      const peer = await this.target(operation.to, signal);
      this.guard(signal);
      waiting.peer = peer.id;
      waiting.deadline(operation.timeoutMs, (error) => this.close(error));
      waiting.receipt = await this.send(peer.id, operation.message, context, {
        messageId: waiting.id,
        expectsReply: true,
      });
      const answer = await wait(waiting.reply, signal);
      this.guard(signal);
      return { ...waiting.receipt, replied: true, reply: answer };
    } finally {
      waiting.clear();
      signal.removeEventListener("abort", abort);
      if (this.pending === waiting) {
        this.pending = undefined;
      }
    }
  }
  private ack(ids: readonly string[]): UnknownRecord {
    const acked: string[] = [];
    const retained: string[] = [];
    for (const id of ids) {
      const entry = this.inbox.get(id);
      if (entry?.message.expectsReply === true) {
        retained.push(id);
      } else if (entry) {
        this.remove(id);
        acked.push(id);
      }
    }
    this.presence();
    return { acked, retained };
  }
  private async answer(
    replyTo: string,
    message: string,
    context: RequestContext,
  ): Promise<UnknownRecord> {
    const entry = this.inbox.get(replyTo);
    if (entry?.message.expectsReply !== true) {
      throw new Fault(404, "unknown_ask", "replyTo must identify an unanswered inbound ask.");
    }
    if (entry.replying) {
      throw new Fault(409, "reply_in_progress", "This ask already has a reply in flight.");
    }
    entry.replying = true;
    const peer = entry.from.id;
    context.onPeer(peer);
    try {
      const peers = await this.peers(context.signal);
      if (!peers.some((candidate) => candidate.id === peer)) {
        throw new Fault(409, "peer_offline", "Original ask sender is disconnected.");
      }
      this.guard(context.signal);
      if (this.inbox.get(replyTo) !== entry) {
        throw new Fault(409, "ask_retired", "Inbound ask is no longer replyable.");
      }
      const data = { ...(await this.send(peer, message, context, { replyTo })) };
      this.remove(replyTo);
      this.presence();
      return data;
    } finally {
      entry.replying = false;
    }
  }
  async execute(operation: Operation, context: RequestContext): Promise<UnknownRecord> {
    this.guard(context.signal);
    if (operation.route === "POST /v1/ask") {
      return this.ask(operation, context);
    }
    await this.connect(context.signal);
    switch (operation.route) {
      case "POST /v1/register":
        return { sessionId: this.client.sessionId, name: this.identity.name };
      case "GET /v1/list": {
        const sessions = await this.peers(context.signal);
        return {
          sessionId: this.client.sessionId,
          sessions: sessions.map(({ topics: _topics, subscriptions: _subscriptions, ...entry }) => {
            return Object.assign(entry, { target: formatSessionTarget(entry, sessions) });
          }),
        };
      }
      case "GET /v1/inbox": {
        const lostMessages = this.owner.losses(this.identity.fingerprint256);
        return {
          messages: [...this.inbox.values()].map(({ from, message }) => ({ from, message })),
          overflow: lostMessages > 0,
          lostMessages,
        };
      }
      case "POST /v1/ack":
        return this.ack(operation.ids);
      case "POST /v1/send":
        return {
          ...(await this.send(
            (await this.target(operation.to, context.signal)).id,
            operation.message,
            context,
          )),
        };
      case "POST /v1/reply":
        return this.answer(operation.replyTo, operation.message, context);
    }
  }
}
