import { EventEmitter } from "events";
import type net from "net";
import { randomUUID } from "crypto";
import { writeMessage } from "./framing.ts";
import { SendError, sendPacket } from "./client-send.ts";
import { BrokerConnection, connectBrokerSocket } from "./connection.ts";
import { SnapshotReader } from "./snapshot-reader.ts";
import { PendingRequests } from "./pending-requests.ts";
import { LastMessageRequests, lastRequest } from "./client-last.ts";
import { ParkRequests } from "./client-park.ts";
import { WakeMessages } from "./client-wake.ts";
import { isNativeReadResult } from "./last.ts";
import {
  errorMessage,
  isRecord,
  isUnknownArray,
  type UnknownRecord,
} from "../../shared/unknown.ts";
import {
  normalizeMessage,
  normalizeSessionInfo,
  type SessionInfo,
  type TopicUpdate,
  type TopicChange,
  type SessionSnapshot,
  type SendResult,
  type LastMessageQuery,
  type LastMessageResult,
  type SendOptions,
  type ReceiptQuery,
  type ReceiptResult,
} from "../types.ts";
export type { SendResult } from "../types.ts";
export { SendError };

/** Default delivery-ack timeout for `send` (broker acknowledges quickly). */
const DEFAULT_SEND_TIMEOUT_MS = 8000;
/** Default timeout for `listSessions` responses. */
const DEFAULT_LIST_TIMEOUT_MS = 5000;

export interface IntercomClientOptions {
  /** Timeout (ms) for the broker to acknowledge message delivery. */
  readonly sendTimeoutMs?: number;
  /** Timeout (ms) for a session list response. */
  readonly listTimeoutMs?: number;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(errorMessage(error));
}

type ClientPhase =
  | { readonly kind: "idle" | "connected" }
  | { readonly kind: "connecting" | "closing"; readonly task: Promise<void> };
/** Everything one accepted registration negotiated; absent until `registered` arrives. */
interface Registration {
  readonly sessionId: string;
  readonly topics: boolean;
  readonly guardedDelivery: boolean;
  readonly lastMessages: boolean;
  readonly receiptReads: boolean;
  readonly parking: boolean;
  readonly wakeResults: boolean;
}

export class IntercomClient extends EventEmitter {
  private connection: BrokerConnection | null = null;
  private registration?: Registration | undefined;
  private readonly parking = new ParkRequests();
  readonly wakes = new WakeMessages(this, () => this.requireActiveSocket());
  private readonly lastRequests: LastMessageRequests;
  private readonly pendingSends = new PendingRequests<{
    readonly resolve: (r: SendResult) => void;
    readonly reject: (e: Readonly<Error>) => void;
  }>();
  private readonly pendingLists = new PendingRequests<{
    readonly resolve: (snapshot: SessionSnapshot) => void;
    readonly reject: (e: Readonly<Error>) => void;
    readonly reader: SnapshotReader;
  }>();
  private phase: ClientPhase = { kind: "idle" };
  private readonly sendTimeoutMs: number;
  private readonly listTimeoutMs: number;

  constructor(options: IntercomClientOptions = {}) {
    super();
    this.sendTimeoutMs = options.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
    this.listTimeoutMs = options.listTimeoutMs ?? DEFAULT_LIST_TIMEOUT_MS;
    this.lastRequests = new LastMessageRequests(this.listTimeoutMs);
  }

  private failPending(error: Readonly<Error>): void {
    this.lastRequests.fail(error);
    this.pendingSends.fail(error);
    this.pendingLists.fail(error);
  }

  get sessionId(): string | null {
    return this.registration?.sessionId ?? null;
  }

  get supportsTopics(): boolean {
    return this.isConnected() && this.registration?.topics === true;
  }
  get supportsGuardedDelivery(): boolean {
    return this.isConnected() && this.registration?.guardedDelivery === true;
  }
  isConnected(): boolean {
    return (
      this.registration !== undefined &&
      this.phase.kind !== "closing" &&
      this.connection?.isActive() === true
    );
  }

  private requireActiveSocket(): net.Socket {
    if (this.phase.kind === "closing") {
      throw new Error("Client disconnecting");
    }
    const connection = this.connection;
    if (!connection || this.registration === undefined) {
      throw new Error("Not connected");
    }
    if (!connection.isActive()) {
      throw new Error("Client disconnected");
    }
    return connection.socket;
  }

  async connect(session: Omit<SessionInfo, "id">, requestedId?: string): Promise<void> {
    if (this.connection || this.phase.kind !== "idle") {
      throw new Error("Already connected");
    }
    const task = this.establish(session, requestedId);
    this.phase = { kind: "connecting", task };
    try {
      await task;
    } finally {
      if (this.phase.kind === "connecting" && this.phase.task === task) {
        this.phase = { kind: this.isConnected() ? "connected" : "idle" };
      }
    }
  }

  private async establish(session: Omit<SessionInfo, "id">, requestedId?: string): Promise<void> {
    const socket = await connectBrokerSocket();
    const connection = new BrokerConnection(socket, {
      message: (message) => this.handleBrokerMessage(message),
      error: (error) => {
        this.emit("error", error);
      },
      closed: (error, expected) => {
        if (this.connection !== connection) {
          return;
        }
        const established = this.registration !== undefined;
        this.connection = null;
        this.registration = undefined;
        this.parking.settle(false);
        if (this.phase.kind === "connected") {
          this.phase = { kind: "idle" };
        }
        this.failPending(error);
        if (established && !expected) {
          this.emit("disconnected", error);
        }
      },
    });
    this.connection = connection;
    if (this.phase.kind === "closing") {
      await connection.disconnect();
      throw new Error("Client disconnecting");
    }
    const { topics, subscriptions, ...identity } = session;
    try {
      await connection.start({
        type: "register",
        session: identity,
        requestedId,
        topicFrames: true,
        lastMessages: true,
        parking: true,
        receiptReads: 1,
        guardedDelivery: 1,
        ...this.wakes.registration(),
      });
    } catch (error) {
      await connection.disconnect();
      throw error;
    }
    if (this.supportsTopics) {
      await this.restoreTopics(topics, subscriptions);
    }
  }

  private async restoreTopics(
    topics: SessionInfo["topics"],
    subscriptions: SessionInfo["subscriptions"],
  ): Promise<void> {
    for (const topic of topics ?? []) {
      // Restore frames are individually acknowledged to preserve order and bound socket payloads.
      await this.updateTopics({ action: "restore", topic });
    }
    for (const subscription of subscriptions ?? []) {
      // Subscriptions are committed before connect resolves and subsequent messages can arrive.
      await this.updateTopics({ action: "restore", subscription });
    }
  }

  private handleBrokerMessage(msg: unknown): void {
    if (!isRecord(msg) || typeof msg.type !== "string") {
      throw new Error("Invalid broker message");
    }

    if (this.registration === undefined && msg.type !== "registered") {
      throw new Error(`Received ${msg.type} before registered`);
    }

    switch (msg.type) {
      case "registered":
        this.receiveRegistration(msg);
        break;
      case "sessions":
        this.receiveSessions(msg);
        break;
      case "last_request":
        this.receiveLastRequest(msg);
        break;
      case "last_response":
        this.lastRequests.receive(msg);
        break;
      case "message":
        this.receiveMessage(msg);
        break;
      case "delivered":
      case "delivery_queued":
      case "delivery_failed":
        this.receiveDelivery(msg);
        break;
      case "parked":
        this.parking.settle(true);
        break;
      case "session_left":
        if (typeof msg.sessionId !== "string") {
          throw new Error(`Invalid ${msg.type} message`);
        }
        this.emit(msg.type, msg.sessionId);
        break;
      case "wake":
      case "wake_failed":
      case "wake_registered":
        this.wakes.receive(msg, this.registration?.wakeResults === true);
        break;
      default:
        throw new Error(`Unknown broker message type: ${msg.type}`);
    }
  }

  private receiveRegistration(msg: UnknownRecord): void {
    if (typeof msg.sessionId !== "string") {
      throw new Error("Invalid registered message");
    }
    if (this.registration !== undefined) {
      throw new Error("Received duplicate registered message");
    }
    this.registration = {
      sessionId: msg.sessionId,
      topics: msg.topicsSupported === true && msg.topicFrames === true,
      guardedDelivery: msg.guardedDelivery === 1,
      lastMessages: msg.lastMessages === true,
      receiptReads: msg.receiptReads === 1,
      parking: msg.parking === true,
      wakeResults: msg.wakeResults === 1,
    };
    this.connection?.confirmRegistration();
    this.emit("_registered", { type: "registered", sessionId: msg.sessionId });
  }

  private receiveLastRequest(msg: UnknownRecord): void {
    const request = lastRequest(msg);
    if (!this.emit("last_request", request)) {
      this.respondLast(request.requestId, { error: "Recipient has no last-message reader." });
    }
  }

  private receiveMessage(msg: UnknownRecord): void {
    const message = normalizeMessage(msg.message);
    const from = normalizeSessionInfo(msg.from);
    if (!from || !message) {
      throw new Error("Invalid message event");
    }
    this.emit("message", from, message);
  }

  private receiveDelivery(msg: UnknownRecord): void {
    const { messageId, reason, type } = msg;
    if (typeof messageId !== "string") {
      throw new Error(`Invalid ${errorMessage(type)} message`);
    }
    if (type !== "delivered" && typeof reason !== "string") {
      throw new Error(`Invalid ${errorMessage(type)} message`);
    }
    const pending = this.pendingSends.take(messageId);
    // Late responses are harmless after the caller has timed out.
    if (!pending) {
      return;
    }
    pending.resolve({
      id: messageId,
      accepted: type !== "delivery_failed",
      delivered: type === "delivered",
      ...(type === "delivery_queued" ? { queued: true } : {}),
      ...(typeof reason === "string" && type !== "delivered" ? { reason } : {}),
    });
  }

  private receiveSessions(brokerMessage: UnknownRecord): void {
    const { requestId, sessions, receipts, more, error } = brokerMessage;
    if (
      typeof requestId !== "string" ||
      !isUnknownArray(sessions) ||
      (more !== undefined && typeof more !== "boolean")
    ) {
      throw new Error("Invalid sessions message");
    }
    const pending = this.pendingLists.get(requestId);
    if (!pending) {
      return;
    }
    if (typeof error === "string") {
      this.pendingLists.take(requestId)?.reject(new Error(error));
      return;
    }
    pending.reader.append(sessions, receipts);
    if (more !== true) {
      this.pendingLists.take(requestId)?.resolve(pending.reader.finish());
    }
  }

  park(on = true): Promise<boolean> {
    return this.parking.request(
      () => this.requireActiveSocket(),
      on,
      this.registration?.parking === true,
    );
  }

  disconnect(): Promise<void> {
    const phase = this.phase;
    if (phase.kind === "closing") {
      return phase.task;
    }
    const connecting = phase.kind === "connecting" ? phase.task : undefined;
    const task = Promise.resolve().then(() => this.close(connecting));
    this.phase = { kind: "closing", task };
    return task;
  }

  private async close(connecting: Promise<void> | undefined): Promise<void> {
    this.failPending(new Error("Client disconnected"));
    try {
      await this.connection?.disconnect();
      try {
        await connecting;
      } catch {
        // The connect caller owns acquisition failure; close still joins any acquired socket.
      }
      await this.connection?.disconnect();
    } finally {
      this.phase = { kind: "idle" };
    }
  }

  listSessions(): Promise<SessionInfo[]> {
    return this.requestSessions().then((snapshot) => [...snapshot.sessions]);
  }

  async last(to: string, query: LastMessageQuery = {}): Promise<LastMessageResult> {
    return await this.lastRequests.last(this.requireActiveSocket(), to, query, {
      lastMessages: this.registration?.lastMessages === true,
      receiptReads: this.registration?.receiptReads === true,
    });
  }
  async receipt(to: string, query: ReceiptQuery): Promise<ReceiptResult> {
    return await this.lastRequests.receipt(this.requireActiveSocket(), to, query, {
      lastMessages: this.registration?.lastMessages === true,
      receiptReads: this.registration?.receiptReads === true,
    });
  }
  respondWake(requestId: string, result: Parameters<WakeMessages["respond"]>[1]): void {
    this.wakes.respond(requestId, result, this.registration?.wakeResults === true);
  }

  respondLast(requestId: string, result: unknown): void {
    if (!isNativeReadResult(result)) {
      throw new Error("Invalid last-message result");
    }
    writeMessage(this.requireActiveSocket(), { type: "last_response", requestId, result });
  }

  updateTopics(
    change: TopicChange,
    onAccepted?: (snapshot: SessionSnapshot) => void,
  ): Promise<SessionSnapshot> {
    if (!this.supportsTopics) {
      return Promise.reject(new Error("This broker does not support topic snapshots."));
    }
    return this.requestSessions(change, onAccepted);
  }

  private requestSessions(
    change?: TopicChange,
    onAccepted?: (snapshot: SessionSnapshot) => void,
  ): Promise<SessionSnapshot> {
    let socket: net.Socket;
    try {
      socket = this.requireActiveSocket();
    } catch (error) {
      return Promise.reject(toError(error));
    }

    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const reader = new SnapshotReader();
      const wrappedResolve = (snapshot: SessionSnapshot) => {
        try {
          // Commit confirmed subscriptions before handling a following message in the same read.
          onAccepted?.(snapshot);
          resolve(snapshot);
        } catch (error) {
          reject(toError(error));
        }
      };
      const wrappedReject = (error: Readonly<Error>) => {
        reader.fail();
        reject(error);
      };
      this.pendingLists.set(
        requestId,
        {
          resolve: wrappedResolve,
          reject: wrappedReject,
          reader,
        },
        this.listTimeoutMs,
        () => Object.assign(new Error("List sessions timeout"), { code: "list_timeout" }),
      );
      try {
        writeMessage(socket, {
          type: "list",
          requestId,
          stream: true,
          ...(change ? { change } : {}),
        });
      } catch (error) {
        this.pendingLists.take(requestId)?.reject(toError(error));
      }
    });
  }

  private requireSendSocket(options: SendOptions): net.Socket {
    const socket = this.requireActiveSocket();
    if (options.guard && this.registration?.guardedDelivery !== true) {
      throw new Error("This broker does not support guarded delivery; no message sent.");
    }
    return socket;
  }

  async send(to: string, options: SendOptions): Promise<SendResult> {
    const messageId = options.messageId ?? (options.guard ? "" : randomUUID());
    let socket: net.Socket;
    try {
      socket = this.requireSendSocket(options);
    } catch (error) {
      throw new SendError({ kind: "not-sent", messageId }, toError(error));
    }

    if (this.pendingSends.get(messageId)) {
      throw new SendError(
        { kind: "unconfirmed", messageId },
        new Error("Message ID already has a pending send"),
      );
    }
    const packet = sendPacket({
      to,
      messageId,
      options,
      topicsSupported: this.registration?.topics === true,
    });
    return await new Promise((resolve, reject) => {
      this.pendingSends.set(
        messageId,
        {
          resolve,
          reject: (error) => reject(new SendError({ kind: "unconfirmed", messageId }, error)),
        },
        this.sendTimeoutMs,
        () => new Error("Send timeout"),
      );

      try {
        writeMessage(socket, packet);
      } catch (error) {
        this.pendingSends.take(messageId)?.reject(toError(error));
      }
    });
  }

  updatePresence(updates: {
    readonly applicationGuard?: string | null | undefined;
    readonly name?: string | undefined;
    readonly status?: string | undefined;
    readonly model?: string | undefined;
    readonly pendingAsks?: number | undefined;
    readonly acceptsAsks?: boolean | undefined;
    readonly lastIntercomActivity?: number | undefined;
    readonly subscriptions?: SessionInfo["subscriptions"] | undefined;
    readonly topics?: readonly TopicUpdate[] | undefined;
  }): void {
    if (this.phase.kind === "closing") {
      return;
    }

    const socket = this.connection?.socket;
    if (
      !socket ||
      this.registration === undefined ||
      socket.destroyed ||
      socket.writableEnded ||
      !socket.writable
    ) {
      return;
    }

    writeMessage(socket, { type: "presence", ...updates });
  }
}
