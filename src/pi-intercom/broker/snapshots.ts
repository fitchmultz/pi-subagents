import { randomUUID } from "node:crypto";
import { isRecord, type UnknownRecord } from "../../shared/unknown.ts";
import {
  isTopicUpdate,
  isTopicSubscription,
  type SessionInfo,
  type TopicUpdate,
  type Message,
  type BrokerMessage,
  type TopicSubscription,
  type SendResult,
} from "../types.ts";
import {
  intercomMessageSizeBytes,
  MAX_FRAME_SIZE_BYTES,
  validateIntercomMessageSize,
} from "./framing.ts";

/** Direct messages and old clients receive identity, not potentially large topic state. */
export function messageSender(info: SessionInfo): SessionInfo {
  const { topics: _topics, subscriptions: _subscriptions, ...identity } = info;
  return identity;
}

function topicFrames(requestId: string, info: SessionInfo): BrokerMessage[] {
  const frames: BrokerMessage[] = [
    {
      type: "sessions",
      requestId,
      sessions: [
        {
          ...messageSender(info),
          ...(info.topics ? { topics: [] } : {}),
          ...(info.subscriptions ? { subscriptions: [] } : {}),
        },
      ],
      more: true,
    },
  ];
  for (const topic of info.topics ?? []) {
    frames.push({
      type: "sessions",
      requestId,
      sessions: [{ id: info.id, topics: [topic] }],
      more: true,
    });
  }
  for (const subscription of info.subscriptions ?? []) {
    frames.push({
      type: "sessions",
      requestId,
      sessions: [{ id: info.id, subscriptions: [subscription] }],
      more: true,
    });
  }
  return frames;
}

export function snapshotFrames(
  requestId: string,
  infos: readonly SessionInfo[],
  stream: boolean,
): BrokerMessage[] {
  // ponytail: one record per frame; pack records only if measured socket overhead warrants it.
  const frames: BrokerMessage[] = stream
    ? [
        ...infos.flatMap((info) => topicFrames(requestId, info)),
        { type: "sessions", requestId, sessions: [], more: false },
      ]
    : [{ type: "sessions", requestId, sessions: infos.map(messageSender) }];
  for (const frame of frames) {
    const error = validateIntercomMessageSize(frame);
    if (error) {
      throw error;
    }
  }
  return frames;
}

type TopicMutation =
  | { readonly kind: "publication"; readonly topic: TopicUpdate; readonly publish: boolean }
  | { readonly kind: "subscription"; readonly subscription: TopicSubscription }
  | { readonly kind: "unsubscribe"; readonly topic: string };

function validPublication(topic: unknown): TopicUpdate {
  if (!isTopicUpdate(topic) || topic.text.trim().length === 0) {
    throw new Error("Invalid topic publication");
  }
  if (
    topic.event === "release" &&
    ((topic.resource ?? "").length === 0 || topic.ownership !== "released")
  ) {
    throw new Error("Invalid topic publication");
  }
  return topic;
}

function topicMutation(change: UnknownRecord): TopicMutation {
  if (change.action === "publish") {
    return { kind: "publication", topic: validPublication(change.topic), publish: true };
  }
  if (change.action === "restore" && isTopicUpdate(change.topic)) {
    return { kind: "publication", topic: validPublication(change.topic), publish: false };
  }
  if (
    (change.action === "subscribe" || change.action === "restore") &&
    isTopicSubscription(change.subscription)
  ) {
    return { kind: "subscription", subscription: change.subscription };
  }
  if (change.action === "unsubscribe" && typeof change.topic === "string") {
    return { kind: "unsubscribe", topic: change.topic };
  }
  throw new Error("Invalid topic change");
}

function publicationUpdate(
  topic: TopicUpdate,
  previous: TopicUpdate | undefined,
  publish: boolean,
): TopicUpdate {
  const revision = publish
    ? Math.max(previous?.revision ?? 0, topic.revision - 1) + 1
    : topic.revision;
  if (!Number.isSafeInteger(revision) || revision <= 0) {
    throw new Error("Invalid topic revision");
  }
  return { ...topic, revision };
}

class SnapshotRecords<T extends { readonly topic: string }> {
  private readonly records = new Map<string, { readonly value: T; readonly bytes: number }>();
  private largest = 0;
  private initial: readonly T[] | undefined;
  private present: boolean;

  constructor(values: readonly T[] | undefined) {
    this.initial = values;
    this.present = values !== undefined;
    for (const value of values ?? []) {
      this.set(value, intercomMessageSizeBytes(value));
    }
  }

  get(topic: string, first = false): T | undefined {
    if (first && this.initial !== undefined) {
      return this.initial.find((record) => record.topic === topic);
    }
    return this.records.get(topic)?.value;
  }

  maximumAfter(topic?: string, bytes = 0): number {
    const previous = topic === undefined ? undefined : this.records.get(topic);
    if (previous?.bytes !== this.largest || bytes >= this.largest) {
      return Math.max(this.largest, bytes);
    }
    // ponytail: shrinking the largest record scans cached sizes; index sizes if churn warrants it.
    let largest = bytes;
    for (const [key, record] of this.records) {
      if (key !== topic) {
        largest = Math.max(largest, record.bytes);
      }
    }
    return largest;
  }

  set(value: T, bytes: number): void {
    this.largest = this.maximumAfter(value.topic, bytes);
    this.records.set(value.topic, { value, bytes });
  }

  delete(topic: string): void {
    this.largest = this.maximumAfter(topic);
    this.records.delete(topic);
  }

  accept(): void {
    this.initial = undefined;
    this.present = true;
  }

  valuesAfter(topic?: string, value?: T, changed = false): readonly T[] | undefined {
    if (!changed) {
      if (this.initial !== undefined) {
        return this.initial;
      }
      if (!this.present) {
        return;
      }
    }
    const values: T[] = [];
    for (const [key, record] of this.records) {
      const next = key === topic ? value : record.value;
      if (next !== undefined) {
        values.push(next);
      }
    }
    if (value !== undefined && !this.records.has(value.topic)) {
      values.push(value);
    }
    return values;
  }
}

interface PreparedTopicChange {
  readonly topic?: TopicUpdate;
  readonly subscription?: TopicSubscription;
  readonly unsubscribe?: string;
  readonly publication?: TopicUpdate;
  readonly restore: boolean;
  readonly changed: boolean;
  readonly bytes: number;
}

const UNCHANGED: PreparedTopicChange = { restore: false, changed: false, bytes: 0 };

/** Keep committed records indexed; restores validate only new bytes and cached envelope maxima. */
export class TopicSnapshot {
  private readonly topics: SnapshotRecords<TopicUpdate>;
  private readonly subscriptions: SnapshotRecords<TopicSubscription>;

  constructor(info: SessionInfo) {
    this.topics = new SnapshotRecords(info.topics);
    this.subscriptions = new SnapshotRecords(info.subscriptions);
  }

  subscription(topic: string): TopicSubscription | undefined {
    return this.subscriptions.get(topic, true);
  }

  prepare(change: unknown, supported: boolean): PreparedTopicChange {
    if (change === undefined) {
      return UNCHANGED;
    }
    if (!supported || !isRecord(change)) {
      throw new Error("Topic snapshots unavailable for this client");
    }
    const mutation = topicMutation(change);
    const base = { restore: change.action === "restore", changed: true, bytes: 0 };
    switch (mutation.kind) {
      case "publication":
        return this.preparePublication(mutation, base);
      case "subscription":
        return {
          ...base,
          subscription: mutation.subscription,
          bytes: intercomMessageSizeBytes(mutation.subscription),
        };
      case "unsubscribe":
        return { ...base, unsubscribe: mutation.topic };
    }
  }

  private preparePublication(
    mutation: Extract<TopicMutation, { readonly kind: "publication" }>,
    base: PreparedTopicChange,
  ): PreparedTopicChange {
    const previous = this.topics.get(mutation.topic.topic);
    const update = publicationUpdate(mutation.topic, previous, mutation.publish);
    if (!mutation.publish && (previous?.revision ?? 0) >= update.revision) {
      return base;
    }
    return {
      ...base,
      topic: update,
      bytes: intercomMessageSizeBytes(update),
      ...(mutation.publish ? { publication: update } : {}),
    };
  }

  snapshot(info: SessionInfo, prepared = UNCHANGED): SessionInfo {
    const topics = this.topics.valuesAfter(prepared.topic?.topic, prepared.topic, prepared.changed);
    const subscriptions = this.subscriptions.valuesAfter(
      prepared.subscription?.topic ?? prepared.unsubscribe,
      prepared.subscription,
      prepared.changed,
    );
    return {
      ...info,
      ...(topics !== undefined ? { topics } : {}),
      ...(subscriptions !== undefined ? { subscriptions } : {}),
      ...(prepared.publication ? { lastIntercomActivity: Date.now() } : {}),
    };
  }

  validateRestore(info: SessionInfo, prepared: PreparedTopicChange, requestId: string): void {
    snapshotFrames(requestId, [{ ...info, topics: [], subscriptions: [] }], true);
    const topicBytes = this.topics.maximumAfter(
      prepared.topic?.topic,
      prepared.topic ? prepared.bytes : 0,
    );
    const subscriptionBytes = this.subscriptions.maximumAfter(
      prepared.subscription?.topic,
      prepared.subscription ? prepared.bytes : 0,
    );
    for (const [field, bytes] of [
      ["topics", topicBytes],
      ["subscriptions", subscriptionBytes],
    ] as const) {
      const size =
        intercomMessageSizeBytes({
          type: "sessions",
          requestId,
          sessions: [{ id: info.id, [field]: [] }],
          more: true,
        }) + bytes;
      if (size > MAX_FRAME_SIZE_BYTES) {
        throw new Error(`Intercom message too large (${size} bytes; max ${MAX_FRAME_SIZE_BYTES})`);
      }
    }
  }

  commit(prepared: PreparedTopicChange): void {
    if (prepared.changed) {
      this.topics.accept();
      this.subscriptions.accept();
    }
    if (prepared.topic) {
      this.topics.set(prepared.topic, prepared.bytes);
    } else if (prepared.subscription) {
      this.subscriptions.set(prepared.subscription, prepared.bytes);
    } else if (prepared.unsubscribe !== undefined) {
      this.subscriptions.delete(prepared.unsubscribe);
    }
  }
}

export function deliveryAcknowledgement(receipt: SendResult): BrokerMessage {
  if (!receipt.accepted) {
    return {
      type: "delivery_failed",
      messageId: receipt.id,
      reason: receipt.reason ?? "Delivery failed",
    };
  }
  if (receipt.queued === true) {
    return {
      type: "delivery_queued",
      messageId: receipt.id,
      reason: receipt.reason ?? "Queued for replace-mode delivery",
    };
  }
  return { type: "delivered", messageId: receipt.id };
}

export function shouldReplaceDelivery(message: Message, info: SessionInfo): boolean {
  if (
    message.delivery !== "queue" ||
    message.queueMode !== "replace" ||
    (message.threadId ?? "").length === 0
  ) {
    return false;
  }
  const status = info.status ?? "";
  return (
    message.expectsReply === true ||
    ((status === "idle" || status.startsWith("idle ")) && info.acceptsAsks !== false)
  );
}

export function publicationMessage(publication: TopicUpdate, awaitRelease: boolean): Message {
  const urgent =
    publication.event === "blocker" ||
    publication.event === "decision" ||
    (publication.event === "release" && awaitRelease);
  return {
    id: randomUUID(),
    timestamp: Date.now(),
    topic: publication,
    content: { text: publication.text },
    delivery: urgent ? "steer" : "queue",
    ...(urgent ? {} : { queueMode: "replace", threadId: `topic:${publication.topic}` }),
  };
}
