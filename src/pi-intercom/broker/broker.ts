import net from "net";
import { chmodSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { getPiAgentDir } from "../agent-dir.ts";
import { writeMessage, createMessageReader, validateIntercomMessageSize } from "./framing.ts";
import { prepareBrokerSocketPath } from "./paths.ts";
import { compactTopicMessage, isSessionRegistration, isTopicSubscription, isTopicUpdate, normalizeMessage, normalizeSessionInfo } from "../types.ts";
import type { SessionInfo, Message, BrokerMessage, SendResult, SessionSnapshot, TopicUpdate } from "../types.ts";

const INTERCOM_DIR = join(getPiAgentDir(), "intercom");
const PID_PATH = join(INTERCOM_DIR, "broker.pid");

const REPLACE_DELIVERY_DELAY_MS = 1500;

interface ConnectedSession {
  socket: net.Socket;
  info: SessionInfo;
  topicFrames: boolean;
}

function messageSender(info: SessionInfo): SessionInfo {
  const { topics: _topics, subscriptions: _subscriptions, ...identity } = info;
  return identity;
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
        const now = Date.now();
        const info: SessionInfo = {
          ...clientMessage.session,
          id,
          lastSeen: clientMessage.session.lastSeen ?? now,
        };
        this.snapshotFrames(randomUUID(), [info], true);
        const topicFrames = clientMessage.topicFrames === true;
        this.sessions.set(id, { socket, info, topicFrames });
        setId(id);

        if (this.shutdownTimer) {
          clearTimeout(this.shutdownTimer);
          this.shutdownTimer = null;
        }

        writeMessage(socket, { type: "registered", sessionId: id, ...(topicFrames ? { topicsSupported: true, topicFrames: true } : {}) });
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

        const requestId = clientMessage.requestId;
        try {
          const session = currentId && this.sessions.get(currentId);
          if (!session) throw new Error("Sender session not found");
          let nextInfo = session.info;
          let publication: TopicUpdate | undefined;
          const change = clientMessage.change as { action?: unknown; topic?: unknown; subscription?: unknown } | undefined;
          if (change !== undefined) {
            if (!session.topicFrames || !change || typeof change !== "object") throw new Error("Topic snapshots unavailable for this client");
            const topics = new Map((session.info.topics ?? []).map((topic) => [topic.topic, topic]));
            const subscriptions = new Map((session.info.subscriptions ?? []).map((entry) => [entry.topic, entry]));
            if ((change.action === "publish" || change.action === "restore") && isTopicUpdate(change.topic)) {
              if (!change.topic.text.trim() || (change.topic.event === "release" && (!change.topic.resource || change.topic.ownership !== "released"))) throw new Error("Invalid topic publication");
              const update = { ...change.topic, ...(change.action === "publish" ? { revision: Math.max(topics.get(change.topic.topic)?.revision ?? 0, change.topic.revision - 1) + 1 } : {}) };
              if (!isTopicUpdate(update)) throw new Error("Invalid topic revision");
              if (change.action === "publish" || (topics.get(update.topic)?.revision ?? 0) < update.revision) topics.set(update.topic, update);
              if (change.action === "publish") publication = update;
            } else if ((change.action === "subscribe" || change.action === "restore") && isTopicSubscription(change.subscription)) {
              subscriptions.set(change.subscription.topic, change.subscription);
            } else if (change.action === "unsubscribe" && typeof change.topic === "string") {
              subscriptions.delete(change.topic);
            } else throw new Error("Invalid topic change");
            nextInfo = { ...session.info, topics: [...topics.values()], subscriptions: [...subscriptions.values()] };
          }
          if (publication) nextInfo = { ...nextInfo, lastIntercomActivity: Date.now() };
          const from = messageSender(nextInfo);
          const deliveries: Array<{ to: string; message: Message }> = [];
          if (publication) {
            for (const target of this.sessions.values()) {
              const subscription = target.info.subscriptions?.find((entry) => entry.topic === publication!.topic);
              if (target.info.id === currentId || !subscription) continue;
              const urgent = publication.event === "blocker" || publication.event === "decision" || publication.event === "release" && subscription.awaitRelease;
              const message: Message = { id: randomUUID(), timestamp: Date.now(), topic: publication, content: { text: publication.text },
                delivery: urgent ? "steer" : "queue", ...(urgent ? {} : { queueMode: "replace", threadId: `topic:${publication.topic}` }) };
              const error = this.validateDeliveryPayload(from, message, target.topicFrames);
              if (error) throw new Error(error);
              deliveries.push({ to: target.info.id, message });
            }
          }
          const infos = [...this.sessions.values()].map((entry) => entry === session ? nextInfo : entry.info);
          // Validate every required frame before replacing the broker's usable state.
          if (change?.action === "restore") this.snapshotFrames(requestId, [nextInfo], true);
          const frames = this.snapshotFrames(requestId, change?.action === "restore" ? [] : infos, clientMessage.stream === true);
          session.info = nextInfo;
          const receipts: SessionSnapshot["receipts"] = deliveries.map(({ to, message }) => ({ to, ...this.sendToSession(currentId!, to, from, message) }));
          const last = frames.pop()!;
          for (const frame of frames) writeMessage(socket, frame);
          for (const receipt of receipts) writeMessage(socket, { type: "sessions", requestId, sessions: [], receipts: [receipt], more: true });
          writeMessage(socket, last);
        } catch (error) {
          writeMessage(socket, { type: "sessions", requestId, sessions: [], error: error instanceof Error ? error.message : String(error) });
        }
        break;
      }

      case "send": {
        const message = normalizeMessage(clientMessage.message);
        const messageId = message?.id ?? "unknown";

        if (typeof clientMessage.to !== "string" || !message) {
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
          const receipt = this.sendToSession(currentId, targets[0].info.id, messageSender(fromSession.info), message);
          writeMessage(socket, { type: receipt.accepted ? receipt.queued ? "delivery_queued" : "delivered" : "delivery_failed", messageId: message.id, ...(receipt.reason ? { reason: receipt.reason } : {}) });
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
            ...(clientMessage.subscriptions !== undefined ? { subscriptions: clientMessage.subscriptions } : {}),
            ...(clientMessage.topics !== undefined ? { topics: clientMessage.topics } : {}),
            lastSeen: Date.now(),
          });
          if (!nextInfo) throw new Error("Invalid presence update");
          this.snapshotFrames(randomUUID(), [nextInfo], true);
          session.info = nextInfo;
        }
        break;
      }

      default:
        throw new Error(`Unknown client message type: ${clientMessage.type}`);
    }
  }

  private snapshotFrames(requestId: string, infos: SessionInfo[], stream: boolean): BrokerMessage[] {
    // Older clients have no topic UI or multipart reader; keep their original identity-only list.
    if (!stream) {
      const frame: BrokerMessage = { type: "sessions", requestId, sessions: infos.map(messageSender) };
      const error = validateIntercomMessageSize(frame);
      if (error) throw error;
      return [frame];
    }
    // ponytail: one record per frame; pack records only if measured socket overhead warrants it.
    const frames: BrokerMessage[] = [];
    for (const info of infos) {
      frames.push({ type: "sessions", requestId, sessions: [{ ...messageSender(info), ...(info.topics ? { topics: [] } : {}), ...(info.subscriptions ? { subscriptions: [] } : {}) }], more: true });
      for (const topic of info.topics ?? []) frames.push({ type: "sessions", requestId, sessions: [{ id: info.id, topics: [topic] }], more: true });
      for (const subscription of info.subscriptions ?? []) frames.push({ type: "sessions", requestId, sessions: [{ id: info.id, subscriptions: [subscription] }], more: true });
    }
    frames.push({ type: "sessions", requestId, sessions: [], more: false });
    for (const frame of frames) {
      const error = validateIntercomMessageSize(frame);
      if (error) throw error;
    }
    return frames;
  }

  private sendToSession(fromId: string, toId: string, from: SessionInfo, message: Message): SendResult {
    const target = this.sessions.get(toId);
    if (!target) return { id: message.id, accepted: false, delivered: false, reason: "Recipient disconnected before delivery" };
    const status = target.info.status ?? "";
    const idle = status === "idle" || status.startsWith("idle ");
    if (message.delivery === "queue" && message.queueMode === "replace" && message.threadId && (message.expectsReply || idle && target.info.acceptsAsks !== false)) return this.queueReplaceDelivery(fromId, toId, from, message);
    const reason = this.deliverMessage(toId, from, message);
    return { id: message.id, accepted: !reason, delivered: !reason, ...(reason ? { reason } : {}) };
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

  private queueReplaceDelivery(fromId: string, toId: string, from: SessionInfo, message: Message): SendResult {
    const validationError = this.validateDeliveryPayload(from, message, this.sessions.get(toId)?.topicFrames === true);
    if (validationError) {
      return { id: message.id, accepted: false, delivered: false, reason: validationError };
    }
    const key = this.replaceKey(fromId, toId, message.threadId ?? "");
    const existing = this.pendingReplaceDeliveries.get(key);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      this.pendingReplaceDeliveries.delete(key);
      this.deliverMessage(toId, from, message);
    }, REPLACE_DELIVERY_DELAY_MS);
    timer.unref?.();
    this.pendingReplaceDeliveries.set(key, { from, fromId, toId, message, timer });
    return { id: message.id, accepted: true, delivered: false, queued: true, reason: "Queued for replace-mode delivery" };
  }

  private clearPendingReplaceDeliveries(sessionId: string): void {
    for (const [key, pending] of this.pendingReplaceDeliveries) {
      if (pending.toId === sessionId || (pending.fromId === sessionId && pending.message.expectsReply)) {
        clearTimeout(pending.timer);
        this.pendingReplaceDeliveries.delete(key);
      }
    }
  }

  private validateDeliveryPayload(from: SessionInfo, message: Message, topicFrames: boolean): string | null {
    return validateIntercomMessageSize({ type: "message", from: messageSender(from), message: topicFrames ? compactTopicMessage(message) : message })?.message ?? null;
  }

  private deliverMessage(toId: string, from: SessionInfo, message: Message): string | null {
    const target = this.sessions.get(toId);
    if (!target || target.socket.destroyed || target.socket.writableEnded || !target.socket.writable) {
      return "Recipient disconnected before delivery";
    }
    const validationError = this.validateDeliveryPayload(from, message, target.topicFrames);
    if (validationError) return validationError;
    this.touchActivity(toId, true);
    try {
      writeMessage(target.socket, {
        type: "message",
        from: messageSender(from),
        message: target.topicFrames ? compactTopicMessage(message) : message,
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
