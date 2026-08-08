import net from "net";
import { chmodSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { getPiAgentDir } from "../agent-dir.ts";
import { writeMessage, createMessageReader, validateIntercomMessageSize } from "./framing.ts";
import { prepareBrokerSocketPath } from "./paths.ts";
import { isMessage, isSessionRegistration, normalizeSessionInfo } from "../types.ts";
import type { SessionInfo, Message, BrokerMessage } from "../types.ts";

const INTERCOM_DIR = join(getPiAgentDir(), "intercom");
const PID_PATH = join(INTERCOM_DIR, "broker.pid");

const REPLACE_DELIVERY_DELAY_MS = 1500;
const MAX_PENDING_REPLACE_DELIVERIES_PER_SENDER = 100;
const MAX_PENDING_REPLACE_DELIVERIES = 1000;

interface ConnectedSession {
  socket: net.Socket;
  info: SessionInfo;
}

interface PendingReplaceDelivery {
  from: SessionInfo;
  fromId: string;
  toId: string;
  message: Message;
  timer: NodeJS.Timeout;
}

class IntercomBroker {
  private sessions = new Map<string, ConnectedSession>();
  private pendingReplaceDeliveries = new Map<string, PendingReplaceDelivery>();
  private server: net.Server;
  private shutdownTimer: NodeJS.Timeout | null = null;
  private readonly socketPath: string;

  constructor() {
    mkdirSync(INTERCOM_DIR, { recursive: true });
    this.socketPath = prepareBrokerSocketPath();
    if (process.platform !== "win32") {
      try {
        unlinkSync(this.socketPath);
      } catch {
        // A clean startup has no stale socket to remove.
      }
    }
    this.server = net.createServer(this.handleConnection.bind(this));
    this.server.on("error", (error) => {
      console.error(`Intercom broker failed: ${error.message}`);
      process.exitCode = 1;
    });
  }

  start(): void {
    this.server.listen(this.socketPath, () => {
      if (process.platform !== "win32") chmodSync(this.socketPath, 0o600);
      writeFileSync(PID_PATH, String(process.pid), { mode: 0o600 });
      console.log(`Intercom broker started (pid: ${process.pid})`);
    });
    process.on("SIGTERM", () => this.shutdown());
    process.on("SIGINT", () => this.shutdown());
  }

  private handleConnection(socket: net.Socket): void {
    let sessionId: string | null = null;

    const reader = createMessageReader((msg) => {
      this.handleMessage(socket, msg, sessionId, (id) => {
        sessionId = id;
      });
    }, (error) => {
      socket.destroy(error);
    });

    socket.on("data", reader);

    socket.on("close", () => {
      if (sessionId) {
        this.sessions.delete(sessionId);
        this.clearPendingReplaceDeliveries(sessionId);
        this.broadcast({ type: "session_left", sessionId }, sessionId);

        this.scheduleShutdownCheck();
      }
    });

    socket.on("error", (error) => {
      console.error("Socket error:", error);
    });
  }

  private scheduleShutdownCheck(): void {
    if (this.shutdownTimer) return;

    this.shutdownTimer = setTimeout(() => {
      this.shutdownTimer = null;
      if (this.sessions.size === 0) {
        console.log("No sessions connected, shutting down");
        this.shutdown();
      }
    }, 5000);
  }

  private handleMessage(
    socket: net.Socket,
    msg: unknown,
    currentId: string | null,
    setId: (id: string | null) => void,
  ): void {
    if (typeof msg !== "object" || msg === null || !("type" in msg) || typeof msg.type !== "string") {
      throw new Error("Invalid client message");
    }

    const clientMessage = msg as { type: string } & Record<string, unknown>;

    if (currentId === null && clientMessage.type !== "register") {
      throw new Error(`Received ${clientMessage.type} before register`);
    }

    if (currentId !== null) {
      this.touchActivity(currentId, false);
    }

    switch (clientMessage.type) {
      case "register": {
        if (!isSessionRegistration(clientMessage.session)) {
          throw new Error("Invalid register message");
        }

        if (currentId) {
          throw new Error("Received duplicate register message");
        }

        const requestedId = typeof clientMessage.requestedId === "string" && /^[a-zA-Z0-9_-]{8,80}$/.test(clientMessage.requestedId)
          ? clientMessage.requestedId
          : undefined;
        const id = requestedId && !this.sessions.has(requestedId) ? requestedId : randomUUID();
        setId(id);
        const now = Date.now();
        const info: SessionInfo = {
          ...clientMessage.session,
          id,
          lastSeen: clientMessage.session.lastSeen ?? now,
        };
        this.sessions.set(id, { socket, info });

        if (this.shutdownTimer) {
          clearTimeout(this.shutdownTimer);
          this.shutdownTimer = null;
        }

        writeMessage(socket, { type: "registered", sessionId: id });
        break;
      }

      case "unregister": {
        if (currentId === null) {
          throw new Error("Received unregister before register");
        }
        const sessionId = currentId;
        this.sessions.delete(sessionId);
        this.clearPendingReplaceDeliveries(sessionId);
        this.broadcast({ type: "session_left", sessionId }, sessionId);
        setId(null);
        this.scheduleShutdownCheck();
        break;
      }

      case "list": {
        if (typeof clientMessage.requestId !== "string") {
          throw new Error("Invalid list message");
        }

        const sessions = Array.from(this.sessions.values()).map(s => s.info);
        writeMessage(socket, { type: "sessions", requestId: clientMessage.requestId, sessions });
        break;
      }

      case "send": {
        const message = clientMessage.message;
        const messageId = isMessage(message) ? message.id : "unknown";

        if (typeof clientMessage.to !== "string" || !isMessage(message)) {
          writeMessage(socket, {
            type: "delivery_failed",
            messageId,
            reason: "Invalid message format",
          });
          break;
        }

        if (currentId === null) {
          writeMessage(socket, {
            type: "delivery_failed",
            messageId: message.id,
            reason: "Sender session not found",
          });
          break;
        }

        const targets = this.findSessions(clientMessage.to);
        if (targets.length === 1) {
          const fromSession = this.sessions.get(currentId);
          if (!fromSession) {
            writeMessage(socket, {
              type: "delivery_failed",
              messageId: message.id,
              reason: "Sender session not found",
            });
            break;
          }
          this.touchActivity(currentId, true);
          const target = targets[0].info;
          const targetStatus = target.status ?? "";
          const targetIsIdle = targetStatus === "idle" || targetStatus.startsWith("idle ");
          if (message.delivery === "queue" && message.queueMode === "replace" && message.threadId && (message.expectsReply || (targetIsIdle && target.acceptsAsks !== false))) {
            this.queueReplaceDelivery(socket, currentId, target.id, fromSession.info, message);
            break;
          }
          const deliveryFailure = this.deliverMessage(target.id, fromSession.info, message);
          if (!deliveryFailure) {
            writeMessage(socket, { type: "delivered", messageId: message.id });
          } else {
            writeMessage(socket, {
              type: "delivery_failed",
              messageId: message.id,
              reason: deliveryFailure,
            });
          }
          break;
        }

        if (targets.length > 1) {
          writeMessage(socket, {
            type: "delivery_failed",
            messageId: message.id,
            reason: `Multiple sessions named \"${clientMessage.to}\" are connected. Use the session ID instead.`,
          });
          break;
        }

        writeMessage(socket, {
          type: "delivery_failed",
          messageId: message.id,
          reason: "Session not found",
        });
        break;
      }

      case "presence": {
        if (currentId === null) {
          throw new Error("Received presence before register");
        }
        const session = this.sessions.get(currentId);
        if (session) {
          const nextInfo = normalizeSessionInfo({
            ...session.info,
            ...(clientMessage.name !== undefined ? { name: clientMessage.name } : {}),
            ...(clientMessage.status !== undefined ? { status: clientMessage.status } : {}),
            ...(clientMessage.model !== undefined ? { model: clientMessage.model } : {}),
            ...(clientMessage.pendingAsks !== undefined ? { pendingAsks: clientMessage.pendingAsks } : {}),
            ...(clientMessage.acceptsAsks !== undefined ? { acceptsAsks: clientMessage.acceptsAsks } : {}),
            ...(clientMessage.lastIntercomActivity !== undefined ? { lastIntercomActivity: clientMessage.lastIntercomActivity } : {}),
            lastSeen: Date.now(),
          });
          if (!nextInfo) throw new Error("Invalid presence update");
          session.info = nextInfo;
        }
        break;
      }

      default:
        throw new Error(`Unknown client message type: ${clientMessage.type}`);
    }
  }

  /** Update liveness/intercom-activity timestamps for a connected session. */
  private touchActivity(sessionId: string, comms: boolean): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    const now = Date.now();
    session.info.lastSeen = now;
    if (comms) {
      session.info.lastIntercomActivity = now;
    }
  }

  private replaceKey(fromId: string, toId: string, threadId: string): string {
    return `${fromId}\0${toId}\0${threadId}`;
  }

  private queueReplaceDelivery(senderSocket: net.Socket, fromId: string, toId: string, from: SessionInfo, message: Message): void {
    const validationError = this.validateDeliveryPayload(from, message);
    if (validationError) {
      writeMessage(senderSocket, {
        type: "delivery_failed",
        messageId: message.id,
        reason: validationError,
      });
      return;
    }
    const key = this.replaceKey(fromId, toId, message.threadId ?? "");
    const existing = this.pendingReplaceDeliveries.get(key);
    if (existing) {
      clearTimeout(existing.timer);
    } else {
      let senderPending = 0;
      for (const pending of this.pendingReplaceDeliveries.values()) {
        if (pending.fromId === fromId) senderPending++;
      }
      if (senderPending >= MAX_PENDING_REPLACE_DELIVERIES_PER_SENDER || this.pendingReplaceDeliveries.size >= MAX_PENDING_REPLACE_DELIVERIES) {
        writeMessage(senderSocket, {
          type: "delivery_failed",
          messageId: message.id,
          reason: "Replace-mode delivery queue is full; retry after pending updates are delivered.",
        });
        return;
      }
    }
    writeMessage(senderSocket, {
      type: "delivery_queued",
      messageId: message.id,
      reason: "Queued for replace-mode delivery",
    });
    const timer = setTimeout(() => {
      this.pendingReplaceDeliveries.delete(key);
      this.deliverMessage(toId, from, message);
    }, REPLACE_DELIVERY_DELAY_MS);
    timer.unref?.();
    this.pendingReplaceDeliveries.set(key, { from, fromId, toId, message, timer });
  }

  private clearPendingReplaceDeliveries(sessionId: string): void {
    for (const [key, pending] of this.pendingReplaceDeliveries) {
      if (pending.toId === sessionId || (pending.fromId === sessionId && pending.message.expectsReply)) {
        clearTimeout(pending.timer);
        this.pendingReplaceDeliveries.delete(key);
      }
    }
  }

  private validateDeliveryPayload(from: SessionInfo, message: Message): string | null {
    return validateIntercomMessageSize({ type: "message", from, message })?.message ?? null;
  }

  private deliverMessage(toId: string, from: SessionInfo, message: Message): string | null {
    const target = this.sessions.get(toId);
    if (!target || target.socket.destroyed || target.socket.writableEnded || !target.socket.writable) {
      return "Recipient disconnected before delivery";
    }
    const validationError = this.validateDeliveryPayload(from, message);
    if (validationError) return validationError;
    this.touchActivity(toId, true);
    try {
      writeMessage(target.socket, {
        type: "message",
        from,
        message,
      });
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  private findSessions(nameOrId: string): ConnectedSession[] {
    const byId = this.sessions.get(nameOrId);
    if (byId) {
      return [byId];
    }

    const lowerName = nameOrId.toLowerCase();
    return Array.from(this.sessions.values()).filter(session => session.info.name?.toLowerCase() === lowerName);
  }

  private broadcast(msg: BrokerMessage, exclude?: string): void {
    for (const [id, session] of this.sessions) {
      if (id !== exclude) {
        writeMessage(session.socket, msg);
      }
    }
  }

  private shutdown(): void {
    console.log("Broker shutting down");

    for (const session of this.sessions.values()) {
      session.socket.end();
    }
    this.sessions.clear();
    if (process.platform !== "win32") {
      try {
        unlinkSync(this.socketPath);
      } catch {
        // The socket may already be gone if shutdown started after a disconnect.
      }
    }
    try {
      unlinkSync(PID_PATH);
    } catch {
      // The PID file may already be gone if startup never completed.
    }
    this.server.close();
    process.exit(0);
  }
}

new IntercomBroker().start();
