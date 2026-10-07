import {
  finiteNumber,
  isRecord,
  isUnknownArray,
  optionalBoolean,
  optionalFiniteNumber,
  optionalLabel,
  safeLabel,
  safeText,
} from "./validation.ts";

export interface SessionInfo {
  readonly id: string;
  readonly name?: string;
  readonly cwd: string;
  readonly model: string;
  /** Opaque same-repository/worktree identity used for ambient peer awareness. */
  readonly projectId?: string;
  readonly status?: string;
  readonly lastSeen?: number;
  readonly lastIntercomActivity?: number;
  readonly pendingAsks?: number;
  readonly acceptsAsks?: boolean;
  readonly subscriptions?: readonly TopicSubscription[];
  readonly topics?: readonly TopicUpdate[];
}

export interface TopicSubscription {
  readonly topic: string;
  readonly awaitRelease?: boolean;
}
export interface TopicUpdate {
  readonly topic: string;
  readonly text: string;
  readonly event: "update" | "blocker" | "decision" | "release";
  readonly resource?: string;
  readonly ownership?: "held" | "released";
  readonly revision: number;
  readonly updatedAt: number;
}

export function isTopicSubscription(value: unknown): value is TopicSubscription {
  return (
    isRecord(value) &&
    typeof value.topic === "string" &&
    safeLabel(value.topic.trim()) &&
    optionalBoolean(value.awaitRelease)
  );
}

function validTopicOwnership(item: Readonly<Record<string, unknown>>): boolean {
  if (!optionalLabel(item.resource)) {
    return false;
  }
  if (item.ownership === undefined) {
    return true;
  }
  return (
    typeof item.resource === "string" &&
    (item.ownership === "held" || (item.ownership === "released" && item.event === "release"))
  );
}

function validRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
export function isTopicUpdate(value: unknown): value is TopicUpdate {
  if (!isRecord(value) || typeof value.topic !== "string" || !safeLabel(value.topic.trim())) {
    return false;
  }
  return (
    safeText(value.text) &&
    typeof value.event === "string" &&
    ["update", "blocker", "decision", "release"].includes(value.event) &&
    finiteNumber(value.revision) &&
    validRevision(value.revision) &&
    finiteNumber(value.updatedAt) &&
    validTopicOwnership(value)
  );
}

export type MessageDelivery = "queue" | "steer" | "passive";
export type QueueMode = "stack" | "replace";
export interface HumanMessageOrigin {
  readonly ownerSessionId: string;
  readonly runId: string;
  readonly index: number;
}
export function isHumanMessageOrigin(value: unknown): value is HumanMessageOrigin {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.ownerSessionId === "string" &&
    /^[a-zA-Z0-9_-]+$/.test(value.ownerSessionId) &&
    typeof value.runId === "string" &&
    /^[a-zA-Z0-9_-]+$/.test(value.runId) &&
    finiteNumber(value.index) &&
    Number.isSafeInteger(value.index) &&
    value.index >= 0
  );
}

export interface Message {
  readonly id: string;
  readonly timestamp: number;
  readonly replyTo?: string;
  readonly expectsReply?: boolean;
  /** Recipients verify parent ownership before elevating human origin. */
  readonly human?: HumanMessageOrigin;
  readonly topic?: TopicUpdate;
  readonly delivery?: MessageDelivery;
  readonly queueMode?: QueueMode;
  readonly threadId?: string;
  readonly passive?: boolean;
  readonly content: {
    readonly text: string;
    readonly attachments?: readonly Attachment[];
  };
}
export interface Attachment {
  readonly type: "file" | "snippet" | "context";
  readonly name: string;
  readonly content: string;
  readonly language?: string;
}
export function isAttachment(value: unknown): value is Attachment {
  if (!isRecord(value)) {
    return false;
  }
  const validType = value.type === "file" || value.type === "snippet" || value.type === "context";
  return (
    validType && safeLabel(value.name) && safeText(value.content) && optionalLabel(value.language)
  );
}

function validMessageOrigin(message: Readonly<Record<string, unknown>>): boolean {
  if (message.human !== undefined && !isHumanMessageOrigin(message.human)) {
    return false;
  }
  if (message.topic === undefined) {
    return true;
  }
  return (
    isTopicUpdate(message.topic) &&
    message.human === undefined &&
    (message.expectsReply === undefined || message.expectsReply === false) &&
    message.replyTo === undefined
  );
}

function validDelivery(message: Readonly<Record<string, unknown>>): boolean {
  if (
    message.delivery !== undefined &&
    message.delivery !== "queue" &&
    message.delivery !== "steer" &&
    message.delivery !== "passive"
  ) {
    return false;
  }
  if (
    message.passive === true &&
    message.delivery !== undefined &&
    message.delivery !== "passive"
  ) {
    return false;
  }
  return !(
    (message.passive === true || message.delivery === "passive") &&
    message.expectsReply === true
  );
}

function validQueue(message: Readonly<Record<string, unknown>>): boolean {
  if (
    message.queueMode !== undefined &&
    message.queueMode !== "stack" &&
    message.queueMode !== "replace"
  ) {
    return false;
  }
  if (message.queueMode !== undefined && message.delivery !== "queue") {
    return false;
  }
  if (message.queueMode === "replace" && typeof message.threadId !== "string") {
    return false;
  }
  if (message.threadId === undefined) {
    return true;
  }
  return validThread(message);
}

function validThread(message: Readonly<Record<string, unknown>>): boolean {
  return (
    typeof message.threadId === "string" &&
    safeLabel(message.threadId.trim()) &&
    message.queueMode === "replace"
  );
}

function validContent(value: unknown): boolean {
  if (!isRecord(value) || !safeText(value.text)) {
    return false;
  }
  return (
    value.attachments === undefined ||
    (isUnknownArray(value.attachments) && value.attachments.every(isAttachment))
  );
}

export function isMessage(value: unknown): value is Message {
  if (!isRecord(value) || !safeLabel(value.id) || !finiteNumber(value.timestamp)) {
    return false;
  }
  return (
    optionalLabel(value.replyTo) &&
    optionalBoolean(value.expectsReply) &&
    optionalBoolean(value.passive) &&
    validMessageOrigin(value) &&
    validDelivery(value) &&
    validQueue(value) &&
    validContent(value.content)
  );
}

function validSessionHealth(session: Readonly<Record<string, unknown>>): boolean {
  if (
    !optionalFiniteNumber(session.lastSeen) ||
    !optionalFiniteNumber(session.lastIntercomActivity) ||
    !optionalBoolean(session.acceptsAsks)
  ) {
    return false;
  }
  return (
    session.pendingAsks === undefined ||
    (finiteNumber(session.pendingAsks) &&
      Number.isInteger(session.pendingAsks) &&
      session.pendingAsks >= 0)
  );
}

function validSessionTopics(session: Readonly<Record<string, unknown>>): boolean {
  return (
    (session.subscriptions === undefined ||
      (isUnknownArray(session.subscriptions) &&
        session.subscriptions.every(isTopicSubscription))) &&
    (session.topics === undefined ||
      (isUnknownArray(session.topics) && session.topics.every(isTopicUpdate)))
  );
}

export function isSessionRegistration(value: unknown): value is Omit<SessionInfo, "id"> {
  if (!isRecord(value) || !safeLabel(value.cwd) || !safeLabel(value.model)) {
    return false;
  }
  const validProject =
    value.projectId === undefined ||
    (typeof value.projectId === "string" && /^[a-f0-9]{64}$/.test(value.projectId));
  return (
    optionalLabel(value.name) &&
    optionalLabel(value.status) &&
    validProject &&
    validSessionHealth(value) &&
    validSessionTopics(value)
  );
}

export function normalizeSessionInfo(value: unknown): SessionInfo | null {
  if (!isRecord(value) || typeof value.id !== "string") {
    return null;
  }
  const id = value.id;
  if (isSessionRegistration(value)) {
    return { ...value, id };
  }
  if (!("projectId" in value)) {
    return null;
  }
  const { projectId: _projectId, ...withoutProjectId } = value;
  return isSessionRegistration(withoutProjectId) ? { ...withoutProjectId, id } : null;
}

export interface SendResult {
  readonly id: string;
  readonly accepted: boolean;
  readonly delivered: boolean;
  readonly queued?: boolean;
  readonly reason?: string;
}
export type TopicChange =
  | { readonly action: "publish" | "restore"; readonly topic: TopicUpdate }
  | { readonly action: "subscribe" | "restore"; readonly subscription: TopicSubscription }
  | { readonly action: "unsubscribe"; readonly topic: string };
export interface SessionSnapshot {
  readonly sessions: readonly SessionInfo[];
  readonly receipts: readonly (SendResult & { readonly to: string })[];
}

type CompactTopicMessage = Omit<Message, "topic"> & {
  readonly topic?: Omit<TopicUpdate, "text"> & { readonly text?: string };
};
/** Topic text and the standard coalescing key need only one copy on the wire. */
export function compactTopicMessage(message: Message): CompactTopicMessage {
  if (!message.topic) {
    return message;
  }
  return {
    ...message,
    topic:
      message.topic.text === message.content.text
        ? { ...message.topic, text: undefined }
        : message.topic,
    threadId:
      message.queueMode === "replace" && message.threadId === `topic:${message.topic.topic}`
        ? undefined
        : message.threadId,
  };
}

export function normalizeMessage(value: unknown): Message | null {
  if (isMessage(value)) {
    return value;
  }
  if (
    !isRecord(value) ||
    !isRecord(value.topic) ||
    !isRecord(value.content) ||
    typeof value.topic.topic !== "string"
  ) {
    return null;
  }
  const restored = {
    ...value,
    topic: {
      ...value.topic,
      text: value.topic.text === undefined ? value.content.text : value.topic.text,
    },
    ...(value.queueMode === "replace" && value.threadId === undefined
      ? { threadId: `topic:${value.topic.topic}` }
      : {}),
  };
  return isMessage(restored) ? restored : null;
}

export type BrokerMessage =
  | {
      readonly type: "registered";
      readonly sessionId: string;
      readonly topicsSupported?: true;
      readonly topicFrames?: true;
    }
  | {
      readonly type: "sessions";
      readonly requestId: string;
      readonly sessions: readonly (Partial<SessionInfo> & Pick<SessionInfo, "id">)[];
      readonly more?: boolean;
      readonly receipts?: SessionSnapshot["receipts"];
      readonly error?: string;
    }
  | {
      readonly type: "message";
      readonly from: SessionInfo;
      readonly message: Message | CompactTopicMessage;
    }
  | { readonly type: "session_left"; readonly sessionId: string }
  | { readonly type: "delivered"; readonly messageId: string }
  | { readonly type: "delivery_queued"; readonly messageId: string; readonly reason: string }
  | { readonly type: "delivery_failed"; readonly messageId: string; readonly reason: string };
