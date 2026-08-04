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
}

export type MessageDelivery = "queue" | "steer" | "passive";
export type QueueMode = "stack" | "replace";

export interface Message {
  id: string;
  timestamp: number;
  replyTo?: string;
  expectsReply?: boolean;
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

  if (typeof attachment.name !== "string" || typeof attachment.content !== "string") {
    return false;
  }

  return attachment.language === undefined || typeof attachment.language === "string";
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

  if (typeof message.id !== "string" || typeof message.timestamp !== "number") {
    return false;
  }

  if (message.replyTo !== undefined && typeof message.replyTo !== "string") {
    return false;
  }

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

  if (message.threadId !== undefined && (typeof message.threadId !== "string" || message.threadId.trim() === "")) {
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
  if (typeof content.text !== "string") {
    return false;
  }

  return content.attachments === undefined
    || (Array.isArray(content.attachments) && content.attachments.every(isAttachment));
}

export function isSessionRegistration(value: unknown): value is Omit<SessionInfo, "id"> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const session = value as Record<string, unknown>;
  if (typeof session.cwd !== "string" || typeof session.model !== "string") return false;
  if (session.name !== undefined && typeof session.name !== "string") return false;
  if (session.projectId !== undefined && (typeof session.projectId !== "string" || !/^[a-f0-9]{64}$/.test(session.projectId))) return false;
  if (session.status !== undefined && typeof session.status !== "string") return false;
  if (session.lastSeen !== undefined && typeof session.lastSeen !== "number") return false;
  if (session.lastIntercomActivity !== undefined && typeof session.lastIntercomActivity !== "number") return false;
  if (session.pendingAsks !== undefined && typeof session.pendingAsks !== "number") return false;
  return session.acceptsAsks === undefined || typeof session.acceptsAsks === "boolean";
}

export type BrokerMessage =
  | { type: "registered"; sessionId: string }
  | { type: "sessions"; requestId: string; sessions: SessionInfo[] }
  | { type: "message"; from: SessionInfo; message: Message }
  | { type: "session_left"; sessionId: string }
  | { type: "delivered"; messageId: string }
  | { type: "delivery_queued"; messageId: string; reason: string }
  | { type: "delivery_failed"; messageId: string; reason: string };
