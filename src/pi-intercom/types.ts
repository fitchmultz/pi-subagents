export interface SessionInfo {
  id: string;
  name?: string;
  cwd: string;
  model: string;
  /** Opaque same-repository/worktree identity used for ambient peer awareness. */
  projectId?: string;
  status?: string;
  /** Last time the broker observed any activity from this session (liveness). */
  lastSeen?: number;
  /** Last time this session exchanged an intercom message (send/receive). */
  lastIntercomActivity?: number;
  /** Number of inbound asks this session still owes a reply to. */
  pendingAsks?: number;
  /** Whether this session is currently willing/able to answer asks. */
  acceptsAsks?: boolean;
  subscriptions?: TopicSubscription[];
  topics?: TopicUpdate[];
}

export interface TopicSubscription { topic: string; awaitRelease?: boolean }
export interface TopicUpdate {
  topic: string;
  text: string;
  event: "update" | "blocker" | "decision" | "release";
  resource?: string;
  ownership?: "held" | "released";
  revision: number;
  updatedAt: number;
}

export function isTopicSubscription(value: unknown): value is TopicSubscription {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.topic === "string" && safeLabel(item.topic.trim()) && (item.awaitRelease === undefined || typeof item.awaitRelease === "boolean");
}
export function isTopicUpdate(value: unknown): value is TopicUpdate {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.topic === "string" && safeLabel(item.topic.trim()) && typeof item.text === "string" && safeText(item.text)
    && ["update", "blocker", "decision", "release"].includes(String(item.event))
    && typeof item.revision === "number" && Number.isSafeInteger(item.revision) && item.revision > 0
    && typeof item.updatedAt === "number" && Number.isFinite(item.updatedAt)
    && (item.ownership !== "released" || item.event === "release")
    && (item.resource === undefined || typeof item.resource === "string" && safeLabel(item.resource))
    && (item.ownership === undefined || typeof item.resource === "string" && (item.ownership === "held" || item.ownership === "released"));
}

export type MessageDelivery = "queue" | "steer" | "passive";
export type QueueMode = "stack" | "replace";

export interface HumanMessageOrigin {
  ownerSessionId: string;
  runId: string;
  index: number;
}

export function isHumanMessageOrigin(value: unknown): value is HumanMessageOrigin {
  if (!value || typeof value !== "object") return false;
  const origin = value as Record<string, unknown>;
  return typeof origin.ownerSessionId === "string" && /^[a-zA-Z0-9_-]+$/.test(origin.ownerSessionId)
    && typeof origin.runId === "string" && /^[a-zA-Z0-9_-]+$/.test(origin.runId)
    && typeof origin.index === "number" && Number.isSafeInteger(origin.index) && origin.index >= 0;
}

export interface Message {
  id: string;
  timestamp: number;
  replyTo?: string;
  expectsReply?: boolean;
  /** Only the owning parent's human UI sets this; recipients verify ownership before elevating it. */
  human?: HumanMessageOrigin;
  topic?: TopicUpdate;
  /** Active-recipient behavior. Omitted delivery defaults to steer unless expectsReply is true. */
  delivery?: MessageDelivery;
  /** For delivery="queue": stack normally, or replace older undelivered messages in the same thread. */
  queueMode?: QueueMode;
  /** Stable topic key for queueMode="replace". */
  threadId?: string;
  /** If true, render without waking the recipient model. Discouraged for agent-to-agent messages. */
  passive?: boolean;
  content: {
    text: string;
    attachments?: Attachment[];
  };
}

const UNSAFE_TEXT_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const UNSAFE_LABEL_CONTROLS = /[\u0000-\u001f\u007f-\u009f]/;

function safeText(value: string): boolean {
  return !UNSAFE_TEXT_CONTROLS.test(value);
}

function safeLabel(value: string): boolean {
  return value.length > 0 && !UNSAFE_LABEL_CONTROLS.test(value);
}

export interface Attachment {
  type: "file" | "snippet" | "context";
  name: string;
  content: string;
  language?: string;
}

export function isAttachment(value: unknown): value is Attachment {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const attachment = value as Record<string, unknown>;

  if (
    attachment.type !== "file"
    && attachment.type !== "snippet"
    && attachment.type !== "context"
  ) {
    return false;
  }

  if (typeof attachment.name !== "string" || !safeLabel(attachment.name) || typeof attachment.content !== "string" || !safeText(attachment.content)) return false;
  return attachment.language === undefined || (typeof attachment.language === "string" && safeLabel(attachment.language));
}

export function normalizeSessionInfo(value: unknown): SessionInfo | null {
  if (typeof value !== "object" || value === null || typeof (value as { id?: unknown }).id !== "string") return null;
  if (isSessionRegistration(value)) return value as SessionInfo;
  if (!("projectId" in value)) return null;
  const { projectId: _projectId, ...withoutProjectId } = value as Record<string, unknown>;
  return isSessionRegistration(withoutProjectId) ? withoutProjectId as unknown as SessionInfo : null;
}

export function isMessage(value: unknown): value is Message {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const message = value as Record<string, unknown>;

  if (typeof message.id !== "string" || !safeLabel(message.id) || typeof message.timestamp !== "number" || !Number.isFinite(message.timestamp)) {
    return false;
  }

  if (message.replyTo !== undefined && (typeof message.replyTo !== "string" || !safeLabel(message.replyTo))) {
    return false;
  }

  if (message.human !== undefined && !isHumanMessageOrigin(message.human)) return false;
  if (message.topic !== undefined && (!isTopicUpdate(message.topic) || message.human !== undefined || message.expectsReply || message.replyTo)) return false;

  if (message.expectsReply !== undefined && typeof message.expectsReply !== "boolean") {
    return false;
  }

  if (message.passive !== undefined && typeof message.passive !== "boolean") {
    return false;
  }

  if (
    message.delivery !== undefined
    && message.delivery !== "queue"
    && message.delivery !== "steer"
    && message.delivery !== "passive"
  ) {
    return false;
  }

  if (
    message.queueMode !== undefined
    && message.queueMode !== "stack"
    && message.queueMode !== "replace"
  ) {
    return false;
  }

  if (message.threadId !== undefined && (typeof message.threadId !== "string" || !safeLabel(message.threadId.trim()))) {
    return false;
  }

  if (message.passive === true && message.delivery !== undefined && message.delivery !== "passive") {
    return false;
  }

  if ((message.passive === true || message.delivery === "passive") && message.expectsReply === true) {
    return false;
  }

  if (message.queueMode !== undefined && message.delivery !== "queue") {
    return false;
  }

  if (message.queueMode === "replace" && typeof message.threadId !== "string") {
    return false;
  }

  if (message.threadId !== undefined && message.queueMode !== "replace") {
    return false;
  }

  if (typeof message.content !== "object" || message.content === null) {
    return false;
  }

  const content = message.content as Record<string, unknown>;
  if (typeof content.text !== "string" || !safeText(content.text)) {
    return false;
  }

  return content.attachments === undefined
    || (Array.isArray(content.attachments) && content.attachments.every(isAttachment));
}

export function isSessionRegistration(value: unknown): value is Omit<SessionInfo, "id"> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const session = value as Record<string, unknown>;
  if (typeof session.cwd !== "string" || !safeLabel(session.cwd) || typeof session.model !== "string" || !safeLabel(session.model)) return false;
  if (session.name !== undefined && (typeof session.name !== "string" || !safeLabel(session.name))) return false;
  if (session.projectId !== undefined && (typeof session.projectId !== "string" || !/^[a-f0-9]{64}$/.test(session.projectId))) return false;
  if (session.status !== undefined && (typeof session.status !== "string" || !safeLabel(session.status))) return false;
  if (session.lastSeen !== undefined && (typeof session.lastSeen !== "number" || !Number.isFinite(session.lastSeen))) return false;
  if (session.lastIntercomActivity !== undefined && (typeof session.lastIntercomActivity !== "number" || !Number.isFinite(session.lastIntercomActivity))) return false;
  if (session.pendingAsks !== undefined && (typeof session.pendingAsks !== "number" || !Number.isInteger(session.pendingAsks) || session.pendingAsks < 0)) return false;
  if (session.subscriptions !== undefined && (!Array.isArray(session.subscriptions) || !session.subscriptions.every(isTopicSubscription))) return false;
  if (session.topics !== undefined && (!Array.isArray(session.topics) || !session.topics.every(isTopicUpdate))) return false;
  return session.acceptsAsks === undefined || typeof session.acceptsAsks === "boolean";
}

export interface SendResult {
  id: string;
  accepted: boolean;
  delivered: boolean;
  queued?: boolean;
  reason?: string;
}

export type TopicChange =
  | { action: "publish" | "restore"; topic: TopicUpdate }
  | { action: "subscribe" | "restore"; subscription: TopicSubscription }
  | { action: "unsubscribe"; topic: string };
export interface SessionSnapshot {
  sessions: SessionInfo[];
  receipts: Array<SendResult & { to: string }>;
}

/** Topic text and the standard coalescing key need only one copy on the wire. */
export function compactTopicMessage(message: Message) {
  if (!message.topic) return message;
  return { ...message,
    topic: message.topic.text === message.content.text ? { ...message.topic, text: undefined } : message.topic,
    threadId: message.queueMode === "replace" && message.threadId === `topic:${message.topic.topic}` ? undefined : message.threadId,
  };
}

export function normalizeMessage(value: unknown): Message | null {
  if (isMessage(value)) return value;
  if (!value || typeof value !== "object") return null;
  const message = value as Partial<Message>;
  if (!message.topic || typeof message.topic !== "object" || !message.content) return null;
  const restored = { ...message, topic: { ...message.topic, text: message.topic.text === undefined ? message.content.text : message.topic.text },
    ...(message.queueMode === "replace" && message.threadId === undefined ? { threadId: `topic:${message.topic.topic}` } : {}) };
  return isMessage(restored) ? restored : null;
}

export type BrokerMessage =
  | { type: "registered"; sessionId: string; topicsSupported?: true; topicFrames?: true }
  | { type: "sessions"; requestId: string; sessions: Array<Partial<SessionInfo> & Pick<SessionInfo, "id">>; more?: boolean; receipts?: SessionSnapshot["receipts"]; error?: string }
  | { type: "message"; from: SessionInfo; message: Message | ReturnType<typeof compactTopicMessage> }
  | { type: "session_left"; sessionId: string }
  | { type: "delivered"; messageId: string }
  | { type: "delivery_queued"; messageId: string; reason: string }
  | { type: "delivery_failed"; messageId: string; reason: string };
