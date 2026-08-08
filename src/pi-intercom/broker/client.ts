import { EventEmitter } from "events";
import net from "net";
import { randomUUID } from "crypto";
import { writeMessage, createMessageReader } from "./framing.ts";
import { getBrokerSocketPath, getLegacyBrokerSocketPath, isOwnedBrokerSocket } from "./paths.ts";
import { isMessage, normalizeSessionInfo } from "../types.ts";
import type { SessionInfo, Message, Attachment, MessageDelivery, QueueMode } from "../types.ts";

/** Default delivery-ack timeout for `send` (broker acknowledges quickly). */
const DEFAULT_SEND_TIMEOUT_MS = 8000;
/** Default timeout for `listSessions` responses. */
const DEFAULT_LIST_TIMEOUT_MS = 5000;

export interface IntercomClientOptions {
  /** Timeout (ms) for the broker to acknowledge message delivery. */
  sendTimeoutMs?: number;
  /** Timeout (ms) for a session list response. */
  listTimeoutMs?: number;
}

interface SendOptions {
  text: string;
  attachments?: Attachment[];
  replyTo?: string;
  expectsReply?: boolean;
  delivery?: MessageDelivery;
  queueMode?: QueueMode;
  threadId?: string;
  passive?: boolean;
  messageId?: string;
}

export interface SendResult {
  id: string;
  accepted: boolean;
  delivered: boolean;
  queued?: boolean;
  reason?: string;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function connectSocket(socketPath: string, timeoutMs = 500): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      socket.off("connect", onConnect);
      socket.off("error", onError);
      if (error) {
        socket.destroy();
        reject(error);
      } else {
        resolve(socket);
      }
    };
    const onConnect = () => finish();
    const onError = (error: Error) => finish(error);
    socket.once("connect", onConnect);
    socket.once("error", onError);
    const timeout = setTimeout(() => finish(new Error(`Connection timeout: ${socketPath}`)), timeoutMs);
    timeout.unref?.();
  });
}

async function connectBrokerSocket(): Promise<net.Socket> {
  const preferred = getBrokerSocketPath();
  const legacy = process.platform === "win32" ? preferred : getLegacyBrokerSocketPath();
  const candidates = [preferred, ...(legacy !== preferred ? [legacy] : [])];
  let lastError: Error | undefined;
  for (const candidate of candidates) {
    if (!isOwnedBrokerSocket(candidate)) continue;
    try {
      return await connectSocket(candidate);
    } catch (error) {
      lastError = toError(error);
    }
  }
  throw lastError ?? new Error(`Intercom broker socket is unavailable: ${preferred}`);
}

export class IntercomClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private _sessionId: string | null = null;
  private pendingSends = new Map<string, { resolve: (r: SendResult) => void; reject: (e: Error) => void }>();
  private pendingLists = new Map<string, { resolve: (sessions: SessionInfo[]) => void; reject: (e: Error) => void }>();
  private connecting = false;
  private disconnecting = false;
  private disconnectError: Error | null = null;
  private readonly sendTimeoutMs: number;
  private readonly listTimeoutMs: number;

  constructor(options: IntercomClientOptions = {}) {
    super();
    this.sendTimeoutMs = options.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
    this.listTimeoutMs = options.listTimeoutMs ?? DEFAULT_LIST_TIMEOUT_MS;
  }

  private failPending(error: Error): void {
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

  isConnected(): boolean {
    const socket = this.socket;
    return Boolean(socket && this._sessionId && !this.disconnecting && !socket.destroyed && !socket.writableEnded && socket.writable);
  }

  private requireActiveSocket(): net.Socket {
    if (this.disconnecting) {
      throw new Error("Client disconnecting");
    }

    const socket = this.socket;
    if (!socket || !this._sessionId) {
      throw new Error("Not connected");
    }

    if (socket.destroyed || socket.writableEnded || !socket.writable) {
      throw new Error("Client disconnected");
    }

    return socket;
  }

  async connect(session: Omit<SessionInfo, "id">, requestedId?: string): Promise<void> {
    if (this.socket || this.connecting) {
      throw new Error("Already connected");
    }

    this.connecting = true;
    let socket: net.Socket;
    try {
      socket = await connectBrokerSocket();
    } finally {
      this.connecting = false;
    }
    return new Promise((resolve, reject) => {
      this.socket = socket;
      this.disconnectError = null;
      let settled = false;
      const timeout = setTimeout(() => {
        if (!this._sessionId) {
          cleanupConnectionAttempt();
          cleanupSocketListeners();
          if (this.socket === socket) {
            this.socket = null;
          }
          socket.destroy();
          reject(new Error("Connection timeout"));
        }
      }, 10000);
      timeout.unref?.();

      let connectionEstablished = false;

      const onRegistered = () => {
        settled = true;
        connectionEstablished = true;
        cleanupConnectionAttempt();
        resolve();
      };

      const onError = (err: Error) => {
        settled = true;
        cleanupConnectionAttempt();
        cleanupSocketListeners();
        if (this.socket === socket) {
          this.socket = null;
        }
        socket.destroy();
        reject(err);
      };

      const onClose = () => {
        const wasConnecting = !settled && !this._sessionId;
        const wasDisconnecting = this.disconnecting;
        const disconnectError = this.disconnectError ?? new Error("Client disconnected");
        this.disconnecting = false;
        cleanupConnectionAttempt();
        cleanupSocketListeners();
        this.failPending(disconnectError);
        if (this.socket === socket) {
          this.socket = null;
        }
        this._sessionId = null;
        this.disconnectError = null;
        if (connectionEstablished && !wasDisconnecting) {
          this.emit("disconnected", disconnectError);
        }
        if (wasConnecting) {
          reject(new Error("Connection closed before registration"));
        }
      };

      const onSocketError = (err: Error) => {
        if (connectionEstablished) {
          this.disconnectError = err;
          this.emit("error", err);
        }
      };

      const onReaderError = (error: Error) => {
        const protocolError = new Error(`Intercom protocol error: ${error.message}`, { cause: error });
        if (!connectionEstablished) {
          onError(protocolError);
          return;
        }
        this.disconnectError = protocolError;
        this.emit("error", protocolError);
        socket.destroy();
      };

      const reader = createMessageReader((msg) => {
        this.handleBrokerMessage(msg);
      }, onReaderError);

      const cleanupConnectionAttempt = () => {
        this.off("_registered", onRegistered);
        socket.off("error", onError);
        clearTimeout(timeout);
      };

      const cleanupSocketListeners = () => {
        socket.off("data", reader);
        socket.off("error", onSocketError);
        socket.off("close", onClose);
      };

      socket.on("data", reader);
      socket.on("error", onError);
      socket.on("close", onClose);

      socket.on("error", onSocketError);
      this.once("_registered", onRegistered);

      try {
        writeMessage(socket, { type: "register", session, requestedId });
      } catch (error) {
        cleanupConnectionAttempt();
        cleanupSocketListeners();
        if (this.socket === socket) {
          this.socket = null;
        }
        socket.destroy();
        reject(toError(error));
      }
    });
  }

  private handleBrokerMessage(msg: unknown): void {
    if (typeof msg !== "object" || msg === null || !("type" in msg) || typeof msg.type !== "string") {
      throw new Error("Invalid broker message");
    }

    const brokerMessage = msg as { type: string } & Record<string, unknown>;

    if (this._sessionId === null && brokerMessage.type !== "registered") {
      throw new Error(`Received ${brokerMessage.type} before registered`);
    }

    switch (brokerMessage.type) {
      case "registered": {
        if (typeof brokerMessage.sessionId !== "string") {
          throw new Error("Invalid registered message");
        }

        if (this._sessionId !== null) {
          throw new Error("Received duplicate registered message");
        }

        this._sessionId = brokerMessage.sessionId;
        this.emit("_registered", { type: "registered", sessionId: brokerMessage.sessionId });
        break;
      }

      case "sessions": {
        const { requestId, sessions } = brokerMessage;
        const normalizedSessions = Array.isArray(sessions)
          ? sessions.map(normalizeSessionInfo).filter((session): session is SessionInfo => session !== null)
          : null;
        if (typeof requestId !== "string" || !normalizedSessions) {
          throw new Error("Invalid sessions message");
        }

        const pending = this.pendingLists.get(requestId);
        if (!pending) {
          // Late list responses can still arrive after the caller has already timed out.
          return;
        }

        this.pendingLists.delete(requestId);
        pending.resolve(normalizedSessions);
        break;
      }

      case "message": {
        const { from, message } = brokerMessage;
        const normalizedFrom = normalizeSessionInfo(from);
        if (!normalizedFrom || !isMessage(message)) {
          throw new Error("Invalid message event");
        }

        this.emit("message", normalizedFrom, message);
        break;
      }

      case "delivered": {
        const { messageId } = brokerMessage;
        if (typeof messageId !== "string") {
          throw new Error("Invalid delivered message");
        }

        const pending = this.pendingSends.get(messageId);
        if (!pending) {
          // Late send responses are harmless once the caller has already timed out.
          return;
        }

        this.pendingSends.delete(messageId);
        pending.resolve({ id: messageId, accepted: true, delivered: true });
        break;
      }

      case "delivery_queued": {
        const { messageId, reason } = brokerMessage;
        if (typeof messageId !== "string" || typeof reason !== "string") {
          throw new Error("Invalid delivery_queued message");
        }

        const pending = this.pendingSends.get(messageId);
        if (!pending) {
          // Late send responses are harmless once the caller has already timed out.
          return;
        }

        this.pendingSends.delete(messageId);
        pending.resolve({ id: messageId, accepted: true, delivered: false, queued: true, reason });
        break;
      }

      case "delivery_failed": {
        const { messageId, reason } = brokerMessage;
        if (typeof messageId !== "string" || typeof reason !== "string") {
          throw new Error("Invalid delivery_failed message");
        }

        const pending = this.pendingSends.get(messageId);
        if (!pending) {
          // Late send responses are harmless once the caller has already timed out.
          return;
        }

        this.pendingSends.delete(messageId);
        pending.resolve({ id: messageId, accepted: false, delivered: false, reason });
        break;
      }

      case "session_left": {
        if (typeof brokerMessage.sessionId !== "string") {
          throw new Error("Invalid session_left message");
        }

        this.emit("session_left", brokerMessage.sessionId);
        break;
      }

      default:
        throw new Error(`Unknown broker message type: ${brokerMessage.type}`);
    }
  }

  async disconnect(): Promise<void> {
    const socket = this.socket;
    if (!socket) {
      return;
    }

    this.disconnecting = true;
    this.disconnectError = null;
    this.failPending(new Error("Client disconnected"));

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        socket.off("close", onClose);
        socket.off("error", onError);
        resolve();
      };
      const onClose = () => finish();
      const onError = () => {
        socket.destroy();
      };
      const timeout = setTimeout(() => {
        socket.destroy();
      }, 2000);

      socket.once("close", onClose);
      socket.once("error", onError);

      try {
        writeMessage(socket, { type: "unregister" });
        socket.end();
      } catch {
        // Disconnect should still finish even if the unregister write fails.
        socket.destroy();
      }
    });
  }

  listSessions(): Promise<SessionInfo[]> {
    let socket: net.Socket;
    try {
      socket = this.requireActiveSocket();
    } catch (error) {
      return Promise.reject(toError(error));
    }

    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const wrappedResolve = (sessions: SessionInfo[]) => {
        clearTimeout(timeout);
        resolve(sessions);
      };
      const wrappedReject = (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      };
      const timeout = setTimeout(() => {
        if (this.pendingLists.has(requestId)) {
          this.pendingLists.delete(requestId);
          wrappedReject(new Error("List sessions timeout"));
        }
      }, this.listTimeoutMs);
      timeout.unref?.();
      this.pendingLists.set(requestId, { resolve: wrappedResolve, reject: wrappedReject });
      try {
        writeMessage(socket, { type: "list", requestId });
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
      delivery: options.delivery ?? (options.passive === true ? "passive" : options.expectsReply === true ? undefined : "steer"),
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
      const wrappedReject = (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      };
      const timeout = setTimeout(() => {
        if (this.pendingSends.has(messageId)) {
          this.pendingSends.delete(messageId);
          wrappedReject(new Error("Send timeout"));
        }
      }, this.sendTimeoutMs);
      timeout.unref?.();
      this.pendingSends.set(messageId, { resolve: wrappedResolve, reject: wrappedReject });

      try {
        writeMessage(socket, { type: "send", to, message });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingSends.delete(messageId);
        reject(toError(error));
      }
    });
  }

  updatePresence(updates: { name?: string; status?: string; model?: string; pendingAsks?: number; acceptsAsks?: boolean; lastIntercomActivity?: number }): void {
    if (this.disconnecting) {
      return;
    }

    const socket = this.socket;
    if (!socket || !this._sessionId || socket.destroyed || socket.writableEnded || !socket.writable) {
      return;
    }

    writeMessage(socket, { type: "presence", ...updates });
  }
}
