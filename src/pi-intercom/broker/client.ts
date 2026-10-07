import { EventEmitter } from "events";
import type net from "net";
import { randomUUID } from "crypto";
import { writeMessage } from "./framing.ts";
import { BrokerConnection, connectBrokerSocket } from "./connection.ts";
import { SnapshotReader } from "./snapshot-reader.ts";
import {
  errorMessage,
  isRecord,
  isUnknownArray,
  type UnknownRecord,
} from "../../shared/unknown.ts";
import {
  compactTopicMessage,
  normalizeMessage,
  normalizeSessionInfo,
  type SessionInfo,
  type Message,
  type Attachment,
  type MessageDelivery,
  type QueueMode,
  type HumanMessageOrigin,
  type TopicUpdate,
  type TopicChange,
  type SessionSnapshot,
  type SendResult,
} from "../types.ts";
export type { SendResult } from "../types.ts";

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

interface SendOptions {
  readonly text: string;
  readonly attachments?: readonly Attachment[];
  readonly replyTo?: string;
  readonly expectsReply?: boolean;
  readonly delivery?: MessageDelivery;
  readonly queueMode?: QueueMode;
  readonly threadId?: string;
  readonly passive?: boolean;
  readonly messageId?: string;
  readonly human?: HumanMessageOrigin;
  readonly topic?: TopicUpdate;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(errorMessage(error));
}

function messageDelivery(options: SendOptions): MessageDelivery | undefined {
  if (options.delivery !== undefined) {
    return options.delivery;
  }
  if (options.passive === true) {
    return "passive";
  }
  if (options.expectsReply === true) {
    return;
  }
  return "steer";
}

export class IntercomClient extends EventEmitter {
  private connection: BrokerConnection | null = null;
  private _sessionId: string | null = null;
  private _topicsSupported = false;
  private readonly pendingSends = new Map<
    string,
    { readonly resolve: (r: SendResult) => void; readonly reject: (e: Readonly<Error>) => void }
  >();
  private readonly pendingLists = new Map<
    string,
    {
      readonly resolve: (snapshot: SessionSnapshot) => void;
      readonly reject: (e: Readonly<Error>) => void;
      readonly reader: SnapshotReader;
    }
  >();
  private connecting = false;
  private disconnecting = false;
  private readonly sendTimeoutMs: number;
  private readonly listTimeoutMs: number;

  constructor(options: IntercomClientOptions = {}) {
    super();
    this.sendTimeoutMs = options.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
    this.listTimeoutMs = options.listTimeoutMs ?? DEFAULT_LIST_TIMEOUT_MS;
  }

  private failPending(error: Readonly<Error>): void {
    for (const pending of this.pendingSends.values()) {
      pending.reject(error);
    }
    this.pendingSends.clear();
    for (const pending of this.pendingLists.values()) {
      pending.reject(error);
    }
    this.pendingLists.clear();
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  get supportsTopics(): boolean {
    return this.isConnected() && this._topicsSupported;
  }
  isConnected(): boolean {
    return (
      (this._sessionId ?? "").length > 0 &&
      !this.disconnecting &&
      this.connection?.isActive() === true
    );
  }

  private requireActiveSocket(): net.Socket {
    if (this.disconnecting) {
      throw new Error("Client disconnecting");
    }
    const connection = this.connection;
    if (!connection || (this._sessionId ?? "").length === 0) {
      throw new Error("Not connected");
    }
    if (!connection.isActive()) {
      throw new Error("Client disconnected");
    }
    return connection.socket;
  }

  async connect(session: Omit<SessionInfo, "id">, requestedId?: string): Promise<void> {
    if (this.connection || this.connecting) {
      throw new Error("Already connected");
    }
    this.connecting = true;
    try {
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
          const established = this._sessionId !== null;
          this.connection = null;
          this._sessionId = null;
          this._topicsSupported = false;
          this.disconnecting = false;
          this.failPending(error);
          if (established && !expected) {
            this.emit("disconnected", error);
          }
        },
      });
      this.connection = connection;
      const { topics, subscriptions, ...identity } = session;
      try {
        await connection.start({
          type: "register",
          session: identity,
          requestedId,
          topicFrames: true,
        });
      } catch (error) {
        if (this.connection === connection) {
          this.connection = null;
        }
        throw error;
      }
      if (this.supportsTopics) {
        await this.restoreTopics(topics, subscriptions);
      }
    } finally {
      this.connecting = false;
    }
  }

  private async restoreTopics(
    topics: SessionInfo["topics"],
    subscriptions: SessionInfo["subscriptions"],
  ): Promise<void> {
    for (const topic of topics ?? []) {
      // Restore frames are individually acknowledged to preserve order and bound socket payloads.
      // oxlint-disable-next-line no-await-in-loop
      await this.updateTopics({ action: "restore", topic });
    }
    for (const subscription of subscriptions ?? []) {
      // Subscriptions are committed before connect resolves and subsequent messages can arrive.
      // oxlint-disable-next-line no-await-in-loop
      await this.updateTopics({ action: "restore", subscription });
    }
  }

  private handleBrokerMessage(msg: unknown): void {
    if (!isRecord(msg) || typeof msg.type !== "string") {
      throw new Error("Invalid broker message");
    }

    const brokerMessage = msg;
    const type = msg.type;

    if (this._sessionId === null && type !== "registered") {
      throw new Error(`Received ${type} before registered`);
    }

    switch (type) {
      case "registered":
        this.receiveRegistration(brokerMessage);
        break;
      case "sessions":
        this.receiveSessions(brokerMessage);
        break;
      case "message":
        this.receiveMessage(brokerMessage);
        break;
      case "delivered":
      case "delivery_queued":
      case "delivery_failed":
        this.receiveDelivery(brokerMessage);
        break;
      case "session_left":
        if (typeof brokerMessage.sessionId !== "string") {
          throw new Error("Invalid session_left message");
        }
        this.emit("session_left", brokerMessage.sessionId);
        break;
      default:
        throw new Error(`Unknown broker message type: ${type}`);
    }
  }

  private receiveRegistration(msg: UnknownRecord): void {
    if (typeof msg.sessionId !== "string") {
      throw new Error("Invalid registered message");
    }
    if (this._sessionId !== null) {
      throw new Error("Received duplicate registered message");
    }
    this._sessionId = msg.sessionId;
    this._topicsSupported = msg.topicsSupported === true && msg.topicFrames === true;
    this.connection?.confirmRegistration();
    this.emit("_registered", { type: "registered", sessionId: msg.sessionId });
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
    const pending = this.pendingSends.get(messageId);
    // Late responses are harmless after the caller has timed out.
    if (!pending) {
      return;
    }
    this.pendingSends.delete(messageId);
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
      this.pendingLists.delete(requestId);
      pending.reject(new Error(error));
      return;
    }
    pending.reader.append(sessions, receipts);
    if (more !== true) {
      this.pendingLists.delete(requestId);
      pending.resolve(pending.reader.finish());
    }
  }

  async disconnect(): Promise<void> {
    const connection = this.connection;
    if (!connection) {
      return;
    }
    this.disconnecting = true;
    this.failPending(new Error("Client disconnected"));
    await connection.disconnect();
  }

  listSessions(): Promise<SessionInfo[]> {
    return this.requestSessions().then((snapshot) => [...snapshot.sessions]);
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
      const wrappedResolve = (snapshot: SessionSnapshot) => {
        clearTimeout(timeout);
        try {
          // Commit confirmed subscriptions before handling a following message in the same read.
          onAccepted?.(snapshot);
          resolve(snapshot);
        } catch (error) {
          reject(toError(error));
        }
      };
      const wrappedReject = (error: Readonly<Error>) => {
        clearTimeout(timeout);
        reject(error);
      };
      const timeout = setTimeout(() => {
        if (this.pendingLists.has(requestId)) {
          this.pendingLists.delete(requestId);
          wrappedReject(new Error("List sessions timeout"));
        }
      }, this.listTimeoutMs);
      timeout.unref();
      this.pendingLists.set(requestId, {
        resolve: wrappedResolve,
        reject: wrappedReject,
        reader: new SnapshotReader(),
      });
      try {
        writeMessage(socket, {
          type: "list",
          requestId,
          stream: true,
          ...(change ? { change } : {}),
        });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingLists.delete(requestId);
        reject(toError(error));
      }
    });
  }

  send(to: string, options: SendOptions): Promise<SendResult> {
    let socket: net.Socket;
    try {
      socket = this.requireActiveSocket();
    } catch (error) {
      return Promise.reject(toError(error));
    }

    const messageId = options.messageId ?? randomUUID();
    const message: Message = {
      id: messageId,
      timestamp: Date.now(),
      replyTo: options.replyTo,
      expectsReply: options.expectsReply,
      ...(options.human ? { human: options.human } : {}),
      ...(options.topic ? { topic: options.topic } : {}),
      delivery: messageDelivery(options),
      queueMode: options.queueMode,
      threadId: options.threadId,
      passive: options.passive,
      content: {
        text: options.text,
        attachments: options.attachments,
      },
    };

    return new Promise((resolve, reject) => {
      const wrappedResolve = (result: SendResult) => {
        clearTimeout(timeout);
        resolve(result);
      };
      const wrappedReject = (error: Readonly<Error>) => {
        clearTimeout(timeout);
        reject(error);
      };
      const timeout = setTimeout(() => {
        if (this.pendingSends.has(messageId)) {
          this.pendingSends.delete(messageId);
          wrappedReject(new Error("Send timeout"));
        }
      }, this.sendTimeoutMs);
      timeout.unref();
      this.pendingSends.set(messageId, { resolve: wrappedResolve, reject: wrappedReject });

      try {
        writeMessage(socket, {
          type: "send",
          to,
          message: this._topicsSupported ? compactTopicMessage(message) : message,
        });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingSends.delete(messageId);
        reject(toError(error));
      }
    });
  }

  updatePresence(updates: {
    readonly name?: string;
    readonly status?: string;
    readonly model?: string;
    readonly pendingAsks?: number;
    readonly acceptsAsks?: boolean;
    readonly lastIntercomActivity?: number;
    readonly subscriptions?: SessionInfo["subscriptions"];
    readonly topics?: readonly TopicUpdate[];
  }): void {
    if (this.disconnecting) {
      return;
    }

    const socket = this.connection?.socket;
    if (
      !socket ||
      (this._sessionId ?? "").length === 0 ||
      socket.destroyed ||
      socket.writableEnded ||
      !socket.writable
    ) {
      return;
    }

    writeMessage(socket, { type: "presence", ...updates });
  }
}
