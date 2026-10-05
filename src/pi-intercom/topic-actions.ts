import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { IntercomTransport } from "./transport.ts";
import type { Connection } from "./connection.ts";
import type { Lifecycle } from "./lifecycle.ts";
import type { TopicOwner } from "./topics.ts";
import {
  TOPICS_UNAVAILABLE,
  type IntercomToolParams,
  type ToolResultLike,
} from "./runtime-types.ts";
import {
  isTopicSubscription,
  isTopicUpdate,
  type SessionInfo,
  type SessionSnapshot,
  type TopicChange,
  type TopicUpdate,
} from "./types.ts";
import { toolError, toolText } from "./tool-arguments.ts";
interface TopicOwners {
  readonly pi: ExtensionAPI;
  readonly lifecycle: Lifecycle;
  readonly connection: Connection;
  readonly topics: TopicOwner;
}
function syncMatches(own: SessionInfo | undefined, topics: TopicOwner): boolean {
  if (!own) {
    return false;
  }
  const published = new Map(own.topics?.map((update) => [update.topic, update]));
  const subscribed = new Map(own.subscriptions?.map((entry) => [entry.topic, entry]));
  return (
    published.size === topics.presence().topics.length &&
    subscribed.size === topics.presence().subscriptions.length &&
    topics
      .presence()
      .topics.every(
        (update) => JSON.stringify(published.get(update.topic)) === JSON.stringify(update),
      ) &&
    topics
      .presence()
      .subscriptions.every(
        (entry) =>
          subscribed.has(entry.topic) &&
          Boolean(subscribed.get(entry.topic)?.awaitRelease) === Boolean(entry.awaitRelease),
      )
  );
}
function releaseReady(update: TopicUpdate): boolean {
  return (
    update.event !== "release" ||
    ((update.resource ?? "") !== "" && update.ownership === "released")
  );
}
export class IntercomTopicActions {
  private readonly owners: TopicOwners;
  constructor(owners: TopicOwners) {
    this.owners = owners;
  }
  private change(params: IntercomToolParams, topic: string): TopicChange | undefined {
    switch (params.action) {
      case "subscribe":
        return {
          action: "subscribe",
          subscription: { topic, ...(params.awaitRelease === true ? { awaitRelease: true } : {}) },
        };
      case "unsubscribe":
        return { action: "unsubscribe", topic };
      case "publish":
        return this.publication(params, topic);
      case "topics":
      case "list":
      case "send":
      case "ask":
      case "reply":
      case "pending":
      case "status":
        return;
    }
  }
  private publication(params: IntercomToolParams, topic: string): TopicChange {
    const event = params.event ?? (params.ownership === "released" ? "release" : "update");
    const text = params.message ?? "";
    const previous = this.owners.topics.presence().topics.find((saved) => saved.topic === topic);
    const candidate: unknown = {
      topic,
      text,
      event,
      resource: params.resource,
      ownership: params.ownership,
      revision: (previous?.revision ?? 0) + 1,
      updatedAt: Date.now(),
    };
    if (text.trim() === "" || !isTopicUpdate(candidate) || !releaseReady(candidate)) {
      throw new Error(
        "Publish requires self-contained message text; ownership needs resource, and release needs ownership:'released'.",
      );
    }
    return { action: "publish", topic: candidate };
  }
  private commit(
    params: IntercomToolParams,
    topic: string,
    active: IntercomTransport,
    snapshot: SessionSnapshot,
  ): void {
    switch (params.action) {
      case "subscribe":
        this.owners.topics.subscribe(topic, params.awaitRelease);
        break;
      case "unsubscribe":
        this.owners.topics.unsubscribe(topic);
        break;
      case "publish": {
        const update = snapshot.sessions
          .find((session) => session.id === active.sessionId)
          ?.topics?.find((entry) => entry.topic === topic);
        const id = active.sessionId;
        if (!update || id === null) {
          throw new Error(
            "Broker did not confirm the topic publication; prior saved state is unchanged.",
          );
        }
        this.owners.topics.publish(update, { id, name: this.owners.pi.getSessionName() });
        break;
      }
      case "topics":
      case "list":
      case "send":
      case "ask":
      case "reply":
      case "pending":
      case "status":
        break;
    }
    this.owners.topics.refresh(snapshot.sessions);
  }
  private validate(
    params: IntercomToolParams,
    active: IntercomTransport,
  ): ToolResultLike | undefined {
    if (!active.supportsTopics) {
      this.owners.topics.disconnected();
      return toolError(
        `${TOPICS_UNAVAILABLE}${params.action === "topics" ? `\n\nLast saved records:\n${this.owners.topics.inspect(params.topic)}` : ""}`,
        { topicsSupported: false },
      );
    }
    const topic = params.topic?.trim();
    if (
      topic !== undefined &&
      topic !== "" &&
      !isTopicSubscription({ topic, awaitRelease: params.awaitRelease })
    ) {
      return toolError("Topic must be a plain nonempty label; awaitRelease must be boolean.", {});
    }
    if (params.action !== "topics" && (topic === undefined || topic === "")) {
      return toolError(`${params.action} requires an exact topic.`, {});
    }
    return;
  }
  private reconcile(snapshot: SessionSnapshot, active: IntercomTransport): void {
    if (
      this.owners.connection.topicSyncError === undefined ||
      this.owners.connection.topicSyncError === ""
    ) {
      return;
    }
    const own = snapshot.sessions.find((session) => session.id === active.sessionId);
    if (syncMatches(own, this.owners.topics)) {
      this.owners.connection.clearTopicSyncError();
    } else if (active.sessionId !== null) {
      this.owners.topics.disconnected(active.sessionId);
    }
  }
  private result(params: IntercomToolParams, snapshot: SessionSnapshot): ToolResultLike {
    const topic = params.topic?.trim();
    if (params.action === "publish") {
      const receipts = snapshot.receipts;
      return toolText(
        `Current state saved for ${topic ?? ""}. ${receipts.filter((receipt) => receipt.accepted).length}/${receipts.length} subscribed deliveries accepted; this does not confirm reading or action. Routine updates stay outside conversation context.`,
        { topic, receipts },
      );
    }
    const failure = this.owners.connection.topicSyncError;
    const warning =
      failure !== undefined && failure !== ""
        ? `Some saved topic state could not be restored: ${failure}\nOrdinary messaging remains available. Correct the saved publication or subscription.\n\n`
        : "";
    const operation =
      params.action === "topics"
        ? ""
        : `${params.action === "subscribe" ? "Subscribed to" : "Unsubscribed from"} ${topic ?? ""}.\n`;
    return toolText(`${warning}${operation}${this.owners.topics.inspect(topic)}`, { topic });
  }
  async execute(
    active: IntercomTransport,
    params: IntercomToolParams,
    ctx: ExtensionContext,
  ): Promise<ToolResultLike> {
    const invalid = this.validate(params, active);
    if (invalid) {
      return invalid;
    }
    const generation = this.owners.lifecycle.generation;
    const topic = params.topic?.trim() ?? "";
    let change: TopicChange | undefined;
    try {
      change = this.change(params, topic);
    } catch (error) {
      if (error instanceof Error) {
        return toolError(error.message, {});
      }
      throw error;
    }
    const commit = (snapshot: SessionSnapshot) => {
      if (!this.owners.lifecycle.live(ctx, generation)) {
        throw new Error("Session changed; no topic state saved in this session.");
      }
      this.commit(params, topic, active, snapshot);
    };
    const snapshot = change
      ? await active.updateTopics(change, commit)
      : { sessions: await active.listSessions(), receipts: [] };
    if (!this.owners.lifecycle.live(ctx, generation)) {
      return toolError("Session changed; no topic state saved in this session.", {});
    }
    if (!change) {
      this.owners.topics.refresh(snapshot.sessions);
    }
    this.reconcile(snapshot, active);
    return this.result(params, snapshot);
  }
}
