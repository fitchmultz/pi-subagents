import net from "net";
import { chmodSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { getPiAgentDir } from "../agent-dir.ts";
import { writeMessage, createMessageReader, validateIntercomMessageSize } from "./framing.ts";
import { prepareBrokerSocketPath } from "./paths.ts";
import { brokerPidRecord } from "./pid.ts";
import {
  compactTopicMessage,
  isSessionRegistration,
  normalizeMessage,
  normalizeSessionInfo,
  type SessionInfo,
  type Message,
  type BrokerMessage,
  type SendResult,
  type SessionSnapshot,
  type TopicUpdate,
} from "../types.ts";

import { errorMessage, isRecord, type UnknownRecord } from "../../shared/unknown.ts";
import {
  messageSender,
  snapshotFrames,
  prepareTopicChange,
  publicationMessage,
  deliveryAcknowledgement,
  shouldReplaceDelivery,
} from "./snapshots.ts";

const INTERCOM_DIR = join(getPiAgentDir(), "intercom");
const PID_PATH = join(INTERCOM_DIR, "broker.pid");
const REPLACE_DELIVERY_DELAY_MS = 1500;

interface ConnectedSession {
  readonly socket: net.Socket;
  info: SessionInfo;
  readonly topicFrames: boolean;
}

interface PendingReplaceDelivery {
  readonly fromId: string;
  readonly toId: string;
  readonly message: Message;
  readonly timer: NodeJS.Timeout;
}

class IntercomBroker {
  private readonly sessions = new Map<string, ConnectedSession>();
  private readonly pendingReplaceDeliveries = new Map<string, PendingReplaceDelivery>();
  private readonly server: net.Server;
  private shutdownTimer: NodeJS.Timeout | null = null;
  private readonly socketPath: string;

  constructor() {
    mkdirSync(INTERCOM_DIR, { recursive: true });
    this.socketPath = prepareBrokerSocketPath();
    try {
      unlinkSync(this.socketPath);
    } catch {
      // A clean startup has no stale socket to remove.
    }
    this.server = net.createServer(this.handleConnection.bind(this));
    this.server.on("error", (error) => {
      console.error(`Intercom broker failed: ${error.message}`);
      process.exitCode = 1;
    });
  }

  start(): void {
    this.server.listen(this.socketPath, () => {
      chmodSync(this.socketPath, 0o600);
      writeFileSync(PID_PATH, brokerPidRecord(), { mode: 0o600 });
      console.log(`Intercom broker started (pid: ${process.pid})`);
      // A broker no session ever registers with (for example, its spawning client exited first) must still exit.
      this.scheduleShutdownCheck();
    });
    process.on("SIGTERM", () => this.shutdown());
    process.on("SIGINT", () => this.shutdown());
  }

  private handleConnection(socket: net.Socket): void {
    let sessionId: string | null = null;

    const reader = createMessageReader(
      (msg) => {
        this.handleMessage(socket, msg, sessionId, (id) => {
          sessionId = id;
        });
      },
      (error) => {
        socket.destroy(error);
      },
    );

    socket.on("data", reader);

    socket.on("close", () => {
      if (sessionId !== null) {
        this.removeSession(sessionId);
      }
    });

    socket.on("error", (error) => {
      console.error("Socket error:", error);
    });
  }

  private scheduleShutdownCheck(): void {
    if (this.shutdownTimer) {
      return;
    }

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
    if (!isRecord(msg) || typeof msg.type !== "string") {
      throw new Error("Invalid client message");
    }
    if (currentId === null && msg.type !== "register") {
      throw new Error(`Received ${msg.type} before register`);
    }
    if (currentId !== null) {
      this.touchActivity(currentId, false);
    }
    if (msg.type === "register") {
      if (currentId !== null) {
        throw new Error("Received duplicate register message");
      }
      this.register(socket, msg, setId);
      return;
    }
    if (currentId === null) {
      throw new Error("Sender session not found");
    }
    switch (msg.type) {
      case "unregister":
        this.removeSession(currentId);
        setId(null);
        break;
      case "list":
        this.list(socket, msg, currentId);
        break;
      case "send":
        this.send(socket, msg, currentId);
        break;
      case "presence":
        this.presence(msg, currentId);
        break;
      default:
        throw new Error(`Unknown client message type: ${msg.type}`);
    }
  }

  private register(socket: net.Socket, msg: UnknownRecord, setId: (id: string) => void): void {
    if (!isSessionRegistration(msg.session)) {
      throw new Error("Invalid register message");
    }
    const requestedId =
      typeof msg.requestedId === "string" && /^[a-zA-Z0-9_-]{8,80}$/.test(msg.requestedId)
        ? msg.requestedId
        : undefined;
    const id =
      requestedId !== undefined && !this.sessions.has(requestedId) ? requestedId : randomUUID();
    const info: SessionInfo = { ...msg.session, id, lastSeen: msg.session.lastSeen ?? Date.now() };
    snapshotFrames(randomUUID(), [info], true);
    const topicFrames = msg.topicFrames === true;
    this.sessions.set(id, { socket, info, topicFrames });
    setId(id);
    if (this.shutdownTimer) {
      clearTimeout(this.shutdownTimer);
      this.shutdownTimer = null;
    }
    writeMessage(socket, {
      type: "registered",
      sessionId: id,
      ...(topicFrames ? { topicsSupported: true, topicFrames: true } : {}),
    });
  }

  private removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.clearPendingReplaceDeliveries(sessionId);
    this.broadcast({ type: "session_left", sessionId }, sessionId);
    this.scheduleShutdownCheck();
  }

  private planPublications(
    fromId: string,
    from: SessionInfo,
    publication?: TopicUpdate,
  ): Array<{ to: string; message: Message }> {
    const deliveries: Array<{ to: string; message: Message }> = [];
    if (!publication) {
      return deliveries;
    }
    for (const target of this.sessions.values()) {
      const subscription = target.info.subscriptions?.find(
        (entry) => entry.topic === publication.topic,
      );
      if (target.info.id === fromId || !subscription) {
        continue;
      }
      const message = publicationMessage(publication, subscription.awaitRelease === true);
      const error = this.validateDeliveryPayload(from, message, target.topicFrames);
      if (error !== null) {
        throw new Error(error);
      }
      deliveries.push({ to: target.info.id, message });
    }
    return deliveries;
  }

  private list(socket: net.Socket, msg: UnknownRecord, currentId: string): void {
    if (typeof msg.requestId !== "string") {
      throw new Error("Invalid list message");
    }
    const requestId = msg.requestId;
    try {
      const session = this.sessions.get(currentId);
      if (!session) {
        throw new Error("Sender session not found");
      }
      const prepared = prepareTopicChange(session.info, msg.change, session.topicFrames);
      const nextInfo = prepared.info;
      const from = messageSender(nextInfo);
      const deliveries = this.planPublications(currentId, from, prepared.publication);
      const restore = prepared.restore;
      const infos = [...this.sessions.values()].map((entry) =>
        entry === session ? nextInfo : entry.info,
      );
      // Validate every frame before committing state or delivering publications.
      if (restore) {
        snapshotFrames(requestId, [nextInfo], true);
      }
      const frames = snapshotFrames(requestId, restore ? [] : infos, msg.stream === true);
      const last = frames.pop();
      if (!last) {
        throw new Error("Missing final snapshot frame");
      }
      session.info = nextInfo;
      const receipts: Array<SessionSnapshot["receipts"][number]> = [];
      for (const { to, message } of deliveries) {
        receipts.push({ to, ...this.sendToSession(currentId, to, from, message) });
      }
      for (const frame of frames) {
        writeMessage(socket, frame);
      }
      for (const receipt of receipts) {
        writeMessage(socket, {
          type: "sessions",
          requestId,
          sessions: [],
          receipts: [receipt],
          more: true,
        });
      }
      writeMessage(socket, last);
    } catch (error) {
      writeMessage(socket, {
        type: "sessions",
        requestId,
        sessions: [],
        error: errorMessage(error),
      });
    }
  }

  private send(socket: net.Socket, msg: UnknownRecord, currentId: string): void {
    const message = normalizeMessage(msg.message);
    if (typeof msg.to !== "string" || !message) {
      writeMessage(socket, {
        type: "delivery_failed",
        messageId: message?.id ?? "unknown",
        reason: "Invalid message format",
      });
      return;
    }
    const targets = this.findSessions(msg.to);
    const target = targets[0];
    if (targets.length === 1) {
      const fromSession = this.sessions.get(currentId);
      if (!fromSession) {
        writeMessage(socket, {
          type: "delivery_failed",
          messageId: message.id,
          reason: "Sender session not found",
        });
        return;
      }
      this.touchActivity(currentId, true);
      const receipt = this.sendToSession(
        currentId,
        target.info.id,
        messageSender(fromSession.info),
        message,
      );
      writeMessage(socket, deliveryAcknowledgement(receipt));
      return;
    }
    writeMessage(socket, {
      type: "delivery_failed",
      messageId: message.id,
      reason:
        targets.length > 1
          ? `Multiple sessions named "${msg.to}" are connected. Use the session ID instead.`
          : "Session not found",
    });
  }

  private presence(msg: UnknownRecord, currentId: string): void {
    const session = this.sessions.get(currentId);
    if (!session) {
      return;
    }
    const update: Record<string, unknown> = { ...session.info, lastSeen: Date.now() };
    for (const key of [
      "name",
      "status",
      "model",
      "pendingAsks",
      "acceptsAsks",
      "lastIntercomActivity",
      "subscriptions",
      "topics",
    ]) {
      if (msg[key] !== undefined) {
        update[key] = msg[key];
      }
    }
    const nextInfo = normalizeSessionInfo(update);
    if (!nextInfo) {
      throw new Error("Invalid presence update");
    }
    snapshotFrames(randomUUID(), [nextInfo], true);
    session.info = nextInfo;
  }

  private sendToSession(
    fromId: string,
    toId: string,
    from: SessionInfo,
    message: Message,
  ): SendResult {
    const target = this.sessions.get(toId);
    if (!target) {
      return {
        id: message.id,
        accepted: false,
        delivered: false,
        reason: "Recipient disconnected before delivery",
      };
    }
    if (shouldReplaceDelivery(message, target.info)) {
      return this.queueReplaceDelivery(fromId, toId, from, message);
    }
    const reason = this.deliverMessage(toId, from, message);
    return {
      id: message.id,
      accepted: reason === null,
      delivered: reason === null,
      ...(reason !== null ? { reason } : {}),
    };
  }

  /** Update liveness/intercom-activity timestamps for a connected session. */
  private touchActivity(sessionId: string, comms: boolean): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    const now = Date.now();
    session.info = {
      ...session.info,
      lastSeen: now,
      ...(comms ? { lastIntercomActivity: now } : {}),
    };
  }

  private replaceKey(fromId: string, toId: string, threadId: string): string {
    return `${fromId}\0${toId}\0${threadId}`;
  }

  private queueReplaceDelivery(
    fromId: string,
    toId: string,
    from: SessionInfo,
    message: Message,
  ): SendResult {
    const validationError = this.validateDeliveryPayload(
      from,
      message,
      this.sessions.get(toId)?.topicFrames === true,
    );
    if (validationError !== null) {
      return { id: message.id, accepted: false, delivered: false, reason: validationError };
    }
    const key = this.replaceKey(fromId, toId, message.threadId ?? "");
    const existing = this.pendingReplaceDeliveries.get(key);
    if (existing) {
      clearTimeout(existing.timer);
    }
    const timer = setTimeout(() => {
      this.pendingReplaceDeliveries.delete(key);
      this.deliverMessage(toId, from, message);
    }, REPLACE_DELIVERY_DELAY_MS);
    timer.unref();
    this.pendingReplaceDeliveries.set(key, { fromId, toId, message, timer });
    return {
      id: message.id,
      accepted: true,
      delivered: false,
      queued: true,
      reason: "Queued for replace-mode delivery",
    };
  }

  private clearPendingReplaceDeliveries(sessionId: string): void {
    for (const [key, pending] of this.pendingReplaceDeliveries) {
      if (
        pending.toId === sessionId ||
        (pending.fromId === sessionId && pending.message.expectsReply === true)
      ) {
        clearTimeout(pending.timer);
        this.pendingReplaceDeliveries.delete(key);
      }
    }
  }

  private validateDeliveryPayload(
    from: SessionInfo,
    message: Message,
    topicFrames: boolean,
  ): string | null {
    return (
      validateIntercomMessageSize({
        type: "message",
        from: messageSender(from),
        message: topicFrames ? compactTopicMessage(message) : message,
      })?.message ?? null
    );
  }

  private deliverMessage(toId: string, from: SessionInfo, message: Message): string | null {
    const target = this.sessions.get(toId);
    if (
      !target ||
      target.socket.destroyed ||
      target.socket.writableEnded ||
      !target.socket.writable
    ) {
      return "Recipient disconnected before delivery";
    }
    const validationError = this.validateDeliveryPayload(from, message, target.topicFrames);
    if (validationError !== null) {
      return validationError;
    }
    this.touchActivity(toId, true);
    try {
      writeMessage(target.socket, {
        type: "message",
        from: messageSender(from),
        message: target.topicFrames ? compactTopicMessage(message) : message,
      });
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : errorMessage(error);
    }
  }

  private findSessions(nameOrId: string): ConnectedSession[] {
    const byId = this.sessions.get(nameOrId);
    if (byId) {
      return [byId];
    }

    const lowerName = nameOrId.toLowerCase();
    return Array.from(this.sessions.values()).filter(
      (session) => session.info.name?.toLowerCase() === lowerName,
    );
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
    try {
      unlinkSync(this.socketPath);
    } catch {
      // The socket may already be gone if shutdown started after a disconnect.
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
