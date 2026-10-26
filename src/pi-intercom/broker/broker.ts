import net from "net";
import { chmodSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { writeMessage, validateIntercomMessageSize } from "./framing.ts";
import { getBrokerRuntimeDir, prepareBrokerSocketPath } from "./paths.ts";
import { brokerPidRecord } from "./pid.ts";
import { assertBrokerCanStart } from "./spawn.ts";
import { LastMessageRelay } from "./last.ts";
import { canSeeSession, findSessions } from "./targets.ts";
import { acceptBrokerConnection, registeredSessionInfo } from "./server-connection.ts";
import { guardedDeliveryError } from "./guard.ts";
import {
  compactTopicMessage,
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
  TopicSnapshot,
  publicationMessage,
  deliveryAcknowledgement,
  shouldReplaceDelivery,
} from "./snapshots.ts";

const PID_PATH = join(getBrokerRuntimeDir(), "broker.pid");
const REPLACE_DELIVERY_DELAY_MS = 1500;

interface ConnectedSession {
  readonly socket: net.Socket;
  info: SessionInfo;
  topics: TopicSnapshot;
  readonly topicFrames: boolean;
  readonly lastMessages: boolean;
  readonly receiptReads: boolean;
}

interface PendingReplaceDelivery {
  readonly fromId: string;
  readonly toId: string;
  readonly message: Message;
  readonly timer: NodeJS.Timeout;
}

class IntercomBroker {
  private readonly sessions = new Map<string, ConnectedSession>();
  private readonly lastMessages = new LastMessageRelay(this.sessions);
  private readonly pendingReplaceDeliveries = new Map<string, PendingReplaceDelivery>();
  private readonly server: net.Server;
  private shutdownTimer: NodeJS.Timeout | null = null;
  private readonly socketPath: string;

  constructor() {
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
    acceptBrokerConnection(socket, this.handleMessage.bind(this), this.removeSession.bind(this));
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
      case "last_request":
        this.lastMessages.request(currentId, msg);
        break;
      case "last_response":
        this.lastMessages.respond(currentId, msg);
        break;
      case "presence":
        this.presence(msg, currentId);
        break;
      default:
        throw new Error(`Unknown client message type: ${msg.type}`);
    }
  }

  private register(socket: net.Socket, msg: UnknownRecord, setId: (id: string) => void): void {
    const info = registeredSessionInfo(msg, this.sessions);
    const id = info.id;
    snapshotFrames(randomUUID(), [info], true);
    const topicFrames = msg.topicFrames === true;
    this.sessions.set(id, {
      socket,
      info: messageSender(info),
      topics: new TopicSnapshot(info),
      topicFrames,
      lastMessages: msg.lastMessages === true,
      receiptReads: msg.receiptReads === 1,
    });
    setId(id);
    if (this.shutdownTimer) {
      clearTimeout(this.shutdownTimer);
      this.shutdownTimer = null;
    }
    writeMessage(socket, {
      type: "registered",
      sessionId: id,
      lastMessages: true,
      receiptReads: 1,
      ...(msg.guardedDelivery === 1 ? { guardedDelivery: 1 } : {}),
      ...(topicFrames ? { topicsSupported: true, topicFrames: true } : {}),
    });
  }

  private removeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    this.sessions.delete(sessionId);
    this.lastMessages.disconnected(sessionId);
    this.clearPendingReplaceDeliveries(sessionId);
    this.broadcast({ type: "session_left", sessionId }, session.info);
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
      const subscription = target.topics.subscription(publication.topic);
      if (target.info.id === fromId || !subscription || !canSeeSession(from, target.info)) {
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
      const prepared = session.topics.prepare(msg.change, session.topicFrames);
      const nextInfo = prepared.restore
        ? session.info
        : session.topics.snapshot(session.info, prepared);
      const from = messageSender(nextInfo);
      const deliveries = this.planPublications(currentId, from, prepared.publication);
      // Validate every frame before committing state or delivering publications.
      if (prepared.restore) {
        session.topics.validateRestore(session.info, prepared, requestId);
      }
      const infos = prepared.restore
        ? []
        : [...this.sessions.values()]
            .filter((entry) => canSeeSession(from, entry.info))
            .map((entry) => {
              if (entry === session) {
                return nextInfo;
              }
              return msg.stream === true ? entry.topics.snapshot(entry.info) : entry.info;
            });
      const frames = snapshotFrames(requestId, infos, msg.stream === true);
      const last = frames.pop();
      session.topics.commit(prepared);
      session.info = messageSender(nextInfo);
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
    const targets = findSessions(this.sessions, msg.to, currentId);
    const target = targets[0];
    if (targets.length === 1) {
      const guardError = guardedDeliveryError(this.sessions, msg.to, message);
      if (guardError !== null) {
        writeMessage(socket, {
          type: "delivery_failed",
          messageId: message.id,
          reason: guardError,
        });
        return;
      }
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
    const update: Record<string, unknown> = {
      ...session.topics.snapshot(session.info),
      lastSeen: Date.now(),
    };
    for (const key of [
      "name",
      "status",
      "model",
      "pendingAsks",
      "acceptsAsks",
      "lastIntercomActivity",
      "subscriptions",
      "topics",
      "applicationGuard",
    ]) {
      if (msg[key] !== undefined) {
        update[key] = msg[key];
      }
    }
    if (msg.applicationGuard === null) {
      delete update.applicationGuard;
    }
    const nextInfo = normalizeSessionInfo(update);
    if (!nextInfo) {
      throw new Error("Invalid presence update");
    }
    snapshotFrames(randomUUID(), [nextInfo], true);
    if (msg.topics !== undefined || msg.subscriptions !== undefined) {
      session.topics = new TopicSnapshot(nextInfo);
    }
    session.info = messageSender(nextInfo);
  }

  private sendToSession(
    fromId: string,
    toId: string,
    from: SessionInfo,
    message: Message,
  ): SendResult {
    const target = this.sessions.get(toId);
    if (target && shouldReplaceDelivery(message, target.info)) {
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
    const guardError = guardedDeliveryError(this.sessions, toId, message);
    if (guardError !== null) {
      return guardError;
    }
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

  private broadcast(msg: BrokerMessage, from: SessionInfo): void {
    for (const [id, session] of this.sessions) {
      if (id !== from.id && canSeeSession(session.info, from)) {
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

await assertBrokerCanStart();
new IntercomBroker().start();
