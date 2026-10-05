import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  isTopicSubscription,
  isTopicUpdate,
  type Message,
  type SessionInfo,
  type TopicSubscription,
  type TopicUpdate,
} from "./types.ts";
import { isRecord, isUnknownArray } from "./validation.ts";
import { createTopicView } from "./ui/topic-view.ts";
interface TopicRecord {
  readonly from: Pick<SessionInfo, "id" | "name">;
  readonly update: TopicUpdate;
  readonly connected: boolean;
  readonly notifiedRevision?: number;
}
/** Snapshot-oriented consumer contract; the topic owner retains its map implementations. */
const TOPIC_ENTRY = "intercom-topic";
function isTopicRecord(value: unknown): value is TopicRecord {
  return (
    isRecord(value) &&
    isRecord(value.from) &&
    typeof value.from.id === "string" &&
    (value.from.name === undefined || typeof value.from.name === "string") &&
    isTopicUpdate(value.update) &&
    typeof value.connected === "boolean" &&
    (value.notifiedRevision === undefined || typeof value.notifiedRevision === "number")
  );
}
function quietUpdate(update: TopicUpdate, subscription: TopicSubscription): boolean {
  return (
    update.event === "update" || (update.event === "release" && subscription.awaitRelease !== true)
  );
}
function resourceText(record: TopicRecord): string {
  const { update, connected } = record;
  if (update.resource === undefined || update.resource === "") {
    return "";
  }
  return `Resource: ${update.resource} · declared ${update.ownership ?? "state unknown"}${!connected && update.ownership !== "released" ? "; disconnect is not release" : ""}\n`;
}
function recordText(record: TopicRecord): string {
  const { from, update, connected } = record;
  return `\n${update.topic} · ${from.name ?? from.id} · ${connected ? "connected" : "disconnected / unavailable"}\n${resourceText(record)}${new Date(update.updatedAt).toISOString()} · ${update.event}\n${update.text}`;
}
/** Owns latest quiet state, subscriptions and durable native audit entries. */
export class IntercomTopics {
  private readonly pi: ExtensionAPI;
  private readonly getContext: () => ExtensionContext | null;
  private readonly records = new Map<string, TopicRecord>();
  private readonly disconnectedOwners = new Set<string>();
  private render?: () => void;
  private readonly hydrate = new Set<string>();
  private readonly subscriptionState = new Map<string, TopicSubscription>();
  private readonly publicationState = new Map<string, TopicUpdate>();
  constructor(pi: ExtensionAPI, getContext: () => ExtensionContext | null) {
    this.pi = pi;
    this.getContext = getContext;
  }
  get subscriptions(): ReadonlyMap<string, TopicSubscription> {
    return this.subscriptionState;
  }
  get published(): ReadonlyMap<string, TopicUpdate> {
    return this.publicationState;
  }
  private save(data: Readonly<Record<string, unknown>>): void {
    const ctx = this.getContext();
    if (ctx) {
      this.pi.appendEntry(TOPIC_ENTRY, { sessionId: ctx.sessionManager.getSessionId(), ...data });
    }
  }
  private restore(data: unknown, sessionId: string): void {
    if (!isRecord(data) || data.sessionId !== sessionId) {
      return;
    }
    if (isUnknownArray(data.subscriptions) && data.subscriptions.every(isTopicSubscription)) {
      this.subscriptionState.clear();
      for (const subscription of data.subscriptions) {
        this.subscriptionState.set(subscription.topic, subscription);
      }
    }
    if (isTopicUpdate(data.published)) {
      this.publicationState.set(data.published.topic, data.published);
    }
    if (isTopicRecord(data.record)) {
      this.records.set(`${data.record.from.id}:${data.record.update.topic}`, {
        ...data.record,
        connected: false,
      });
    }
  }
  start(ctx: ExtensionContext): void {
    this.render = undefined;
    this.records.clear();
    this.disconnectedOwners.clear();
    this.hydrate.clear();
    this.subscriptionState.clear();
    this.publicationState.clear();
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === TOPIC_ENTRY) {
        this.restore(entry.data, ctx.sessionManager.getSessionId());
      }
    }
    for (const topic of this.subscriptionState.keys()) {
      this.hydrate.add(topic);
    }
  }
  subscribe(topic: string, awaitRelease?: boolean): void {
    this.subscriptionState.set(topic, {
      topic,
      ...(awaitRelease === true ? { awaitRelease } : {}),
    });
    this.hydrate.add(topic);
    this.save({ subscriptions: [...this.subscriptionState.values()] });
  }
  unsubscribe(topic: string): void {
    this.subscriptionState.delete(topic);
    this.save({ subscriptions: [...this.subscriptionState.values()] });
  }
  publish(update: TopicUpdate, from: Pick<SessionInfo, "id" | "name">): void {
    this.publicationState.set(update.topic, update);
    this.save({ published: update });
    this.record(from, update);
  }
  presence(): Required<Pick<SessionInfo, "subscriptions" | "topics">> {
    return {
      subscriptions: [...this.subscriptionState.values()],
      topics: [...this.publicationState.values()],
    };
  }
  private record(
    from: Pick<SessionInfo, "id" | "name">,
    update: TopicUpdate,
    connected = true,
  ): boolean {
    const key = `${from.id}:${update.topic}`;
    const previous = this.records.get(key);
    if (previous && previous.update.revision >= update.revision) {
      return false;
    }
    const record = {
      from: { id: from.id, name: from.name },
      update,
      connected: connected && !this.disconnectedOwners.has(from.id),
      notifiedRevision: previous?.notifiedRevision,
    };
    this.records.set(key, record);
    this.save({ record });
    this.render?.();
    return true;
  }
  receive(from: SessionInfo, message: Message): boolean {
    const update = message.topic;
    if (!update) {
      return false;
    }
    const subscription = this.subscriptionState.get(update.topic);
    if (!subscription) {
      return true;
    }
    const key = `${from.id}:${update.topic}`;
    if ((this.records.get(key)?.update.revision ?? 0) > update.revision) {
      return true;
    }
    this.record(from, update);
    if (quietUpdate(update, subscription)) {
      return true;
    }
    const record = this.records.get(key);
    if (!record || (record.notifiedRevision ?? 0) >= update.revision) {
      return true;
    }
    const notified = { ...record, notifiedRevision: update.revision };
    this.records.set(key, notified);
    this.save({ record: notified });
    return false;
  }
  private refreshPublication(session: SessionInfo, update: TopicUpdate): void {
    if (!this.subscriptionState.has(update.topic)) {
      return;
    }
    this.record(session, update);
    const key = `${session.id}:${update.topic}`;
    const record = this.records.get(key);
    if (
      record &&
      this.hydrate.has(update.topic) &&
      (record.notifiedRevision ?? 0) < update.revision
    ) {
      const notified = { ...record, notifiedRevision: update.revision };
      this.records.set(key, notified);
      this.save({ record: notified });
    }
  }
  refresh(sessions: readonly SessionInfo[]): void {
    for (const session of sessions) {
      this.disconnectedOwners.delete(session.id);
    }
    for (const [key, record] of this.records) {
      this.records.set(key, {
        ...record,
        connected: sessions.some((session) => session.id === record.from.id),
      });
    }
    for (const session of sessions) {
      for (const update of session.topics ?? []) {
        this.refreshPublication(session, update);
      }
    }
    this.hydrate.clear();
  }
  disconnected(id?: string): void {
    if (id !== undefined && id !== "") {
      this.disconnectedOwners.add(id);
    }
    for (const [key, record] of this.records) {
      if (id === undefined || id === "" || record.from.id === id) {
        this.records.set(key, { ...record, connected: false });
        this.disconnectedOwners.add(record.from.id);
      }
    }
    this.render?.();
  }
  inspect(topic?: string): string {
    const unfiltered = topic === undefined || topic === "";
    const subscriptions = [...this.subscriptionState.values()].filter(
      (item) => unfiltered || item.topic === topic,
    );
    const records = [...this.records.values()]
      .filter((record) => unfiltered || record.update.topic === topic)
      .sort((a, b) => b.update.updatedAt - a.update.updatedAt);
    const labels = subscriptions
      .map((item) => `${item.topic}${item.awaitRelease === true ? " (awaiting release)" : ""}`)
      .join(", ");
    return [
      "Intercom topics · latest self-contained state (not a work queue or exclusive lock)",
      `Subscriptions: ${labels === "" ? "none" : labels}`,
      ...records.map(recordText),
      ...(records.length === 0
        ? ["No current records. Subscribe to an exact topic or publish a self-contained update."]
        : []),
    ].join("\n");
  }
  async open(ctx: ExtensionContext, notice?: string): Promise<void> {
    await ctx.ui.custom<null>(
      (tui, _theme, _keys, done) => {
        let attached: (() => void) | undefined;
        return createTopicView({
          tui,
          done: () => {
            done(null);
          },
          inspect: () =>
            [notice, this.inspect()]
              .filter((value) => value !== undefined && value !== "")
              .join("\n\n"),
          attach: (render) => {
            if (render) {
              attached = render;
              this.render = render;
            } else if (this.render === attached) {
              this.render = undefined;
            }
          },
        });
      },
      { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left" } },
    );
  }
}
