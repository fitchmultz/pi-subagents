import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { IntercomClient } from "./broker/client.ts";
import { resolveSessionProjectId } from "./session-targets.ts";
import type { Message, SendResult, SessionInfo } from "./types.ts";
import type { Identity } from "./bridge-config.ts";
import { Fault, cancelled, log, wait } from "./bridge-protocol.ts";
import { Mailbox } from "./bridge-mailbox.ts";
import { hasErrorCode, type UnknownRecord } from "../shared/unknown.ts";
import type { Operation } from "./bridge-routes.ts";
import type { RequestContext } from "./bridge-http.ts";
import { resolveBridgeTarget, bridgeSessionList } from "./bridge-target.ts";
const MAX_REQUESTS = 8;
const IDLE_TIMEOUT = 5 * 60 * 1000;
const SEND_TIMEOUT = 8000;
const LIST_TIMEOUT = 5000;

interface SendOptions extends Pick<Message, "replyTo" | "expectsReply" | "delivery"> {
  readonly messageId?: string;
}
export interface SessionOwner {
  readonly stateDir?: string;
  readonly notifications?: boolean;
  readonly mailboxChanged?: () => void;
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
  private readonly inbox: Mailbox;
  private inboxChanged = new AbortController();
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
    this.inbox = new Mailbox(owner.stateDir, identity.fingerprint256, owner.notifications);
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
    this.touch();
  }

  guard(signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (this.closed) {
      throw this.closeReason;
    }
    this.authorize();
  }
  authorize(): void {
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
    this.armLease(IDLE_TIMEOUT);
  }
  private armLease(idle: number): void {
    const due = Math.max(1, Math.min(idle, this.expires - Date.now()));
    this.lease = setTimeout(() => {
      if (this.expires <= Date.now()) {
        this.close(new Fault(403, "certificate_expired", "Client certificate expired."));
      } else if (due < idle) {
        // Node can fire before Date.now() reaches the certificate deadline; keep the idle budget.
        this.armLease(idle - due);
      } else {
        this.close(new Fault(410, "lease_expired", "Bridge session idle lease expired."));
      }
    }, due);
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
    this.presence();
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
    this.owner.lost(this.identity.fingerprint256, this.inbox.close());
    this.owner.retired(this.identity.fingerprint256, this.generation);
    log("session_closed", { ...this.fields(), result: this.closeReason.code });
  }
  close(fault: Readonly<Fault>): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeReason = fault;
    clearTimeout(this.lease);
    for (const controller of this.requests) {
      controller.abort(fault);
    }
    // Retain the generation until acquisition/registration AND final disconnect settle.
    this.retirement = this.retire().catch((caught: unknown) => this.cleanupFailed(caught));
  }
  async settled(): Promise<void> {
    await this.retirement;
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
    this.storeReceive(from, message);
  }
  private storeReceive(from: SessionInfo, message: Message): void {
    let result: "stored" | "duplicate" | "lost";
    try {
      result = this.inbox.add({ from, message });
    } catch {
      log("inbox_overflow", {
        ...this.fields(),
        peer: from.id,
        messageId: message.id,
        result: "storage_failed",
        lossRecorded: false,
      });
      this.close(
        new Fault(
          507,
          "mailbox_storage_failed",
          "Mailbox storage failed; inspect the metadata audit for unrecorded losses.",
        ),
      );
      return;
    }
    if (result !== "duplicate" || !this.inbox.persistent) {
      if (result !== "stored") {
        this.owner.lost(this.identity.fingerprint256);
      }
      this.inboxChanged.abort();
      this.inboxChanged = new AbortController();
    }
    log(result === "lost" ? "inbox_overflow" : "received", {
      ...this.fields(),
      peer: from.id,
      messageId: message.id,
      result: result === "lost" && this.inbox.persistent ? "storage_failed" : result,
    });
    if (result !== "lost") {
      this.owner.mailboxChanged?.();
    }
    this.presence();
  }
  private presence(): void {
    if (this.closed) {
      return;
    }
    this.client.updatePresence(this.inbox.presence());
  }
  private async peers(signal: AbortSignal): Promise<SessionInfo[]> {
    this.guard(signal);
    let peers: SessionInfo[];
    try {
      peers = await wait(this.client.listSessions(), signal);
    } catch (error) {
      cancelled(signal);
      if (hasErrorCode(error, "list_timeout")) {
        throw new Fault(504, "list_timeout", "Broker session list deadline exceeded.");
      }
      throw new Fault(503, "broker_unavailable", "Broker session list failed.");
    }
    this.guard(signal);
    return peers;
  }
  async connectedPeers(signal: AbortSignal): Promise<SessionInfo[]> {
    await this.connect(signal);
    return this.peers(signal);
  }
  private async target(to: string, signal: AbortSignal): Promise<SessionInfo> {
    return resolveBridgeTarget(await this.peers(signal), to, this.client.sessionId);
  }
  async send(
    peer: string,
    message: string,
    context: RequestContext,
    options: SendOptions = {},
  ): Promise<SendResult> {
    await this.connect(context.signal);
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
  private async readInbox(
    operation: Extract<Operation, { readonly route: "GET /v1/inbox" }>,
    context: RequestContext,
  ): Promise<UnknownRecord> {
    const read = (): ReturnType<Mailbox["page"]> & UnknownRecord => ({
      ...this.inbox.page(operation.after, operation.limit),
      ...this.inbox.status(this.owner.losses(this.identity.fingerprint256)),
    });
    const deadline = performance.now() + operation.waitMs;
    const losses = read().lostMessages;
    for (;;) {
      // Subscribe to the post-commit signal before rereading the authoritative cursor page.
      const signal = AbortSignal.any([this.inboxChanged.signal, context.signal]);
      const page = read();
      const remaining = deadline - performance.now();
      if (page.messages.length > 0 || page.lostMessages !== losses || remaining <= 0) {
        return page;
      }
      log("inbox_wait", { ...this.fields(), requestId: context.requestId, after: operation.after });
      try {
        // A nonmatching commit must rearm the same cursor, not start parallel readers.
        // oxlint-disable-next-line no-await-in-loop
        await delay(remaining, undefined, { signal });
      } catch (error) {
        if (!signal.aborted) {
          throw error;
        }
      }
      this.guard(context.signal);
    }
  }
  async execute(operation: Operation, context: RequestContext): Promise<UnknownRecord> {
    this.guard(context.signal);
    if (operation.route === "GET /v1/inbox" || operation.route === "POST /v1/ack") {
      // Durable reads/acks remain available while the local broker is down.
      if (!this.inbox.persistent) {
        await this.connect(context.signal);
      }
      if (operation.route === "POST /v1/ack") {
        const result = this.inbox.ack(operation.ids);
        this.owner.mailboxChanged?.();
        this.presence();
        return result;
      }
      return this.readInbox(operation, context);
    }
    await this.connect(context.signal);
    switch (operation.route) {
      case "POST /v1/register":
        return { sessionId: this.client.sessionId, name: this.identity.name };
      case "GET /v1/list":
        return {
          sessionId: this.client.sessionId,
          sessions: bridgeSessionList(await this.peers(context.signal)),
        };
      case "POST /v1/send": {
        const peer = await this.target(operation.to, context.signal);
        const receipt = await this.send(peer.id, operation.message, context, {
          messageId: operation.messageId,
          replyTo: operation.replyTo,
          expectsReply: operation.expectsReply,
          delivery: operation.passive === true ? "passive" : "steer",
        });
        return { ...receipt };
      }
    }
  }
}
