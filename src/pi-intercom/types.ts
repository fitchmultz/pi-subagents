import {
  finiteNumber,
  isRecord,
  isUnknownArray,
  nonNegativeInteger,
  optionalBoolean,
  optionalFiniteNumber,
  optionalLabel,
  safeLabel,
  safeText,
} from "./validation.ts";

export type WakeResult =
  | { readonly status: "requested" }
  | { readonly status: "failed"; readonly reason: string };

export interface SessionInfo {
  readonly id: string;
  readonly name?: string | undefined;
  readonly cwd: string;
  readonly model: string;
  /** Opaque same-repository/worktree identity used for ambient peer awareness. */
  readonly projectId?: string | undefined;
  readonly rootSessionId?: string | undefined;
  readonly parentSessionId?: string | undefined;
  readonly incarnation?: string | undefined;
  readonly guardedDelivery?: 1 | undefined;
  readonly applicationGuard?: string | undefined;
  readonly status?: string | undefined;
  readonly lastSeen?: number | undefined;
  readonly lastIntercomActivity?: number | undefined;
  readonly pendingAsks?: number | undefined;
  readonly acceptsAsks?: boolean | undefined;
  readonly subscriptions?: readonly TopicSubscription[] | undefined;
  readonly topics?: readonly TopicUpdate[] | undefined;
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
export interface ContextTarget {
  readonly rootSessionId: string;
  readonly peerId: string;
  readonly incarnation: string;
}
export interface DeliveryGuard extends ContextTarget {
  readonly applicationGuard: string;
}
export interface PublicationReplyHint {
  readonly tool: string;
  readonly commandId: string;
  readonly commandFingerprint?: string | undefined;
}
export type SendOptions = Omit<Message, "id" | "timestamp" | "content"> &
  Message["content"] & { readonly messageId?: string | undefined };
export function isContextTarget(value: unknown): value is ContextTarget {
  return (
    isRecord(value) &&
    ["rootSessionId", "peerId", "incarnation"].every((key) => safeLabel(value[key]))
  );
}
export function isDeliveryGuard(value: unknown): value is DeliveryGuard {
  return isContextTarget(value) && "applicationGuard" in value && safeLabel(value.applicationGuard);
}
export function isPublicationReplyHint(value: unknown): value is PublicationReplyHint {
  return (
    isRecord(value) &&
    typeof value.tool === "string" &&
    /^[a-zA-Z_][a-zA-Z0-9_]{0,79}$/.test(value.tool) &&
    typeof value.commandId === "string" &&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.commandId) &&
    (value.commandFingerprint === undefined ||
      (typeof value.commandFingerprint === "string" &&
        /^[a-f0-9]{64}$/.test(value.commandFingerprint)))
  );
}
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
  readonly replyTo?: string | undefined;
  readonly expectsReply?: boolean | undefined;
  /** Recipients verify parent ownership before elevating human origin. */
  readonly human?: HumanMessageOrigin | undefined;
  readonly topic?: TopicUpdate | undefined;
  readonly delivery?: MessageDelivery | undefined;
  readonly queueMode?: QueueMode | undefined;
  readonly threadId?: string | undefined;
  readonly passive?: boolean | undefined;
  readonly guard?: DeliveryGuard | undefined;
  readonly replyHint?: PublicationReplyHint | undefined;
  readonly content: {
    readonly text: string;
    readonly attachments?: readonly Attachment[] | undefined;
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
  if (!validMessageGuard(message)) {
    return false;
  }
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

function validMessageGuard(message: Readonly<Record<string, unknown>>): boolean {
  if (message.guard === undefined) {
    return message.replyHint === undefined;
  }
  return (
    isDeliveryGuard(message.guard) &&
    message.expectsReply === false &&
    message.replyTo === undefined &&
    message.human === undefined &&
    message.topic === undefined &&
    (message.replyHint === undefined || isPublicationReplyHint(message.replyHint))
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

function validSessionLineage(value: Readonly<Record<string, unknown>>): boolean {
  return (
    ["rootSessionId", "parentSessionId", "incarnation", "applicationGuard"].every((key) =>
      optionalLabel(value[key]),
    ) &&
    (value.guardedDelivery === undefined ||
      (value.guardedDelivery === 1 &&
        safeLabel(value.incarnation) &&
        safeLabel(value.rootSessionId))) &&
    (value.parentSessionId === undefined || value.rootSessionId === value.parentSessionId)
  );
}

function validSessionProject(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && /^[a-f0-9]{64}$/.test(value));
}

export function isSessionRegistration(value: unknown): value is Omit<SessionInfo, "id"> {
  if (!isRecord(value) || !safeLabel(value.cwd) || !safeLabel(value.model)) {
    return false;
  }
  return (
    optionalLabel(value.name) &&
    optionalLabel(value.status) &&
    validSessionLineage(value) &&
    validSessionProject(value.projectId) &&
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
  readonly topic?: (Omit<TopicUpdate, "text"> & { readonly text?: string | undefined }) | undefined;
};
/** Topic text and the standard coalescing key need only one copy on the wire. */
export function compactTopicMessage(message: Message): CompactTopicMessage {
  if (!message.topic) {
    return message;
  }
  const { threadId, ...rest } = message;
  const dropThreadId =
    message.queueMode === "replace" && threadId === `topic:${message.topic.topic}`;
  return {
    ...rest,
    topic:
      message.topic.text === message.content.text ? withoutTopicText(message.topic) : message.topic,
    ...(dropThreadId || threadId === undefined ? {} : { threadId }),
  };
}

function withoutTopicText(
  topic: TopicUpdate,
): Omit<TopicUpdate, "text"> & { readonly text?: string | undefined } {
  const { text: _duplicate, ...rest } = topic;
  return rest;
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

export interface LastMessageQuery {
  readonly entryId?: string | undefined;
  readonly offset?: number | undefined;
  readonly limit?: number | undefined;
}

export const LAST_MESSAGE_PAGE_LIMIT = 16384;
function optionalEntryId(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && value.length > 0);
}
export function isLastMessageQuery(value: unknown): value is LastMessageQuery {
  return (
    isRecord(value) &&
    value.messageId === undefined &&
    optionalEntryId(value.entryId) &&
    (value.offset === undefined || nonNegativeInteger(value.offset)) &&
    (value.limit === undefined ||
      (nonNegativeInteger(value.limit) &&
        value.limit > 0 &&
        value.limit <= LAST_MESSAGE_PAGE_LIMIT))
  );
}

export type LastMessageResult =
  | {
      readonly session: SessionInfo;
      readonly entryId: string | null;
      readonly text: string;
      readonly offset: number;
      readonly totalLength: number;
      readonly nextOffset?: number;
    }
  | { readonly error: string };

export interface ReceiptQuery {
  readonly rootSessionId: string;
  readonly messageId: string;
}
export function isReceiptQuery(value: unknown): value is ReceiptQuery {
  return isRecord(value) && [value.rootSessionId, value.messageId].every(safeLabel);
}
export interface NativeReceipt extends ReceiptQuery {
  readonly version: 1;
  readonly sender: {
    readonly peerId: string;
    readonly rootSessionId?: string | undefined;
    readonly incarnation?: string | undefined;
  };
  readonly textSha256: string;
  readonly delivery: MessageDelivery;
  readonly guard?: DeliveryGuard | undefined;
  readonly replyHint?: PublicationReplyHint | undefined;
  readonly checkpointEntryId: string;
  readonly receivedAt: number;
  /** Historical observations, not a promise that an input is still queued. */
  readonly queued: boolean;
  readonly nativeHandoff: boolean;
  readonly placementEntryId: string | null;
  readonly discarded: boolean;
}
export type ReceiptResult = { readonly receipt: NativeReceipt } | { readonly error: string };

export type BrokerMessage =
  | {
      readonly type: "registered";
      readonly sessionId: string;
      readonly topicsSupported?: true;
      readonly topicFrames?: true;
      readonly lastMessages?: true;
      readonly receiptReads?: 1;
      readonly guardedDelivery?: 1;
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
  | {
      readonly type: "last_request";
      readonly requestId: string;
      readonly from: SessionInfo;
      readonly query: LastMessageQuery | ReceiptQuery;
    }
  | {
      readonly type: "last_response";
      readonly requestId: string;
      readonly result: LastMessageResult | ReceiptResult;
    }
  | { readonly type: "session_left"; readonly sessionId: string }
  | { readonly type: "delivered"; readonly messageId: string }
  | { readonly type: "delivery_queued"; readonly messageId: string; readonly reason: string }
  | { readonly type: "delivery_failed"; readonly messageId: string; readonly reason: string };
