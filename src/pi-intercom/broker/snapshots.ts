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
import { validateIntercomMessageSize } from "./framing.ts";

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

class TopicSnapshot {
  private readonly info: SessionInfo;
  private readonly topics: Map<string, TopicUpdate>;
  private readonly subscriptions: Map<string, TopicSubscription>;

  constructor(info: SessionInfo) {
    this.info = info;
    this.topics = new Map((info.topics ?? []).map((topic) => [topic.topic, topic]));
    this.subscriptions = new Map((info.subscriptions ?? []).map((entry) => [entry.topic, entry]));
  }

  apply(mutation: TopicMutation): TopicUpdate | undefined {
    switch (mutation.kind) {
      case "publication": {
        const previous = this.topics.get(mutation.topic.topic);
        const update = publicationUpdate(mutation.topic, previous, mutation.publish);
        if (mutation.publish || (previous?.revision ?? 0) < update.revision) {
          this.topics.set(update.topic, update);
        }
        if (mutation.publish) {
          return update;
        }
        return;
      }
      case "subscription":
        this.subscriptions.set(mutation.subscription.topic, mutation.subscription);
        return;
      case "unsubscribe":
        this.subscriptions.delete(mutation.topic);
        return;
    }
  }

  snapshot(publication?: TopicUpdate): SessionInfo {
    return {
      ...this.info,
      topics: [...this.topics.values()],
      subscriptions: [...this.subscriptions.values()],
      ...(publication ? { lastIntercomActivity: Date.now() } : {}),
    };
  }
}

/** Prepare a change without mutating the usable broker snapshot before frame validation. */
export function prepareTopicChange(
  info: SessionInfo,
  change: unknown,
  supported: boolean,
): {
  readonly info: SessionInfo;
  readonly publication?: TopicUpdate;
  readonly restore: boolean;
} {
  if (change === undefined) {
    return { info, restore: false };
  }
  if (!supported || !isRecord(change)) {
    throw new Error("Topic snapshots unavailable for this client");
  }
  const pending = new TopicSnapshot(info);
  const publication = pending.apply(topicMutation(change));
  return {
    info: pending.snapshot(publication),
    restore: change.action === "restore",
    ...(publication ? { publication } : {}),
  };
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
