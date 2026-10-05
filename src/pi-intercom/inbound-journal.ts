import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Lifecycle } from "./lifecycle.ts";
import { isDurableSupervisorQuestion, type ReplyTracker } from "./reply-tracker.ts";
import {
  INBOUND_CHECKPOINT_TYPE,
  type InboundCheckpoint,
  type InboundMessageEntry,
  type PendingInboundMessage,
  type SubagentCompletion,
} from "./runtime-types.ts";
import {
  isInboundCheckpoint,
  isInboundEntry,
  needsIntercom,
  isReplaceableProgress,
} from "./inbound-record.ts";
import { inboundIdFromCustomMessage } from "./message-format.ts";
import { isRecord } from "./validation.ts";
import { activateTools } from "../shared/lazy-tools.ts";

/** Owns durable delivery stages, receipts and completion tombstones. */
export class InboundJournal {
  private readonly pending = new Map<string, PendingInboundMessage>();
  private readonly native = new Set<string>();
  private readonly consumed = new Set<string>();
  private readonly completed = new Map<string, SubagentCompletion["children"][number]>();
  private reconciledLeaf: string | null = null;
  private readonly pi: ExtensionAPI;
  private readonly lifecycle: Lifecycle;
  private readonly replies: Readonly<ReplyTracker>;
  constructor(pi: ExtensionAPI, lifecycle: Lifecycle, replies: Readonly<ReplyTracker>) {
    this.pi = pi;
    this.lifecycle = lifecycle;
    this.replies = replies;
  }
  peerLeft(id: string): void {
    for (const pending of this.replies.listPending()) {
      if (
        pending.from.id === id &&
        !isDurableSupervisorQuestion(pending.message) &&
        this.pending.get(pending.message.id)?.stage !== "queued"
      ) {
        this.retire(pending.message.id);
      }
    }
    this.replies.expireSender(id);
    for (const pending of this.queued()) {
      if (
        pending.from.id === id &&
        pending.message.expectsReply === true &&
        !isDurableSupervisorQuestion(pending.message)
      ) {
        this.pending.delete(pending.message.id);
        this.checkpoint({ messageId: pending.message.id, stage: "discarded" });
      }
    }
  }
  get size(): number {
    return this.pending.size;
  }
  entries(): readonly PendingInboundMessage[] {
    return [...this.pending.values()];
  }
  queued(): readonly PendingInboundMessage[] {
    return this.entries().filter((entry) => entry.stage === "queued");
  }
  get(id: string): PendingInboundMessage | undefined {
    return this.pending.get(id);
  }
  hasSeen(id: string): boolean {
    return this.consumed.has(id) || this.pending.has(id);
  }
  owns(entry: InboundMessageEntry): boolean {
    return !("stage" in entry) || this.pending.get(entry.message.id) === entry;
  }
  checkpoint(update: InboundCheckpoint): void {
    const sessionId = this.lifecycle.currentSessionId;
    if (sessionId !== null) {
      this.pi.appendEntry(INBOUND_CHECKPOINT_TYPE, { sessionId, ...update });
    }
  }
  retire(id: string, stage: "reply-retired" | "discarded" = "reply-retired"): void {
    this.replies.markReplied(id);
    this.checkpoint({ messageId: id, stage });
  }
  remove(id: string): boolean {
    return this.pending.delete(id);
  }
  consume(id: string): void {
    this.consumed.add(id);
    this.pending.delete(id);
    this.native.delete(id);
  }
  clearNative(): void {
    this.native.clear();
  }
  reset(): void {
    this.pending.clear();
    this.native.clear();
    this.consumed.clear();
    this.completed.clear();
    this.reconciledLeaf = null;
  }
  keep(entry: PendingInboundMessage): void {
    if (
      entry.stage === "queued" &&
      entry.message.queueMode === "replace" &&
      entry.message.threadId !== undefined &&
      entry.message.threadId !== ""
    ) {
      for (const pending of this.pending.values()) {
        if (
          pending.stage === "queued" &&
          pending.from.id === entry.from.id &&
          pending.message.threadId === entry.message.threadId
        ) {
          this.pending.delete(pending.message.id);
          this.replies.markReplied(pending.message.id);
        }
      }
    }
    this.pending.set(entry.message.id, entry);
  }
  setStage(entry: PendingInboundMessage, stage: PendingInboundMessage["stage"]): void {
    if (entry.stage === stage) {
      return;
    }
    this.pending.set(entry.message.id, { ...entry, stage });
    this.checkpoint({ messageId: entry.message.id, stage });
  }
  remember(
    entry: InboundMessageEntry,
    stage: PendingInboundMessage["stage"],
    flushDelivery: PendingInboundMessage["flushDelivery"],
  ): void {
    const pending = this.pending.get(entry.message.id);
    if (pending) {
      this.setStage(pending, stage);
      return;
    }
    const saved = { ...entry, stage, flushDelivery, receivedAt: Date.now() };
    this.keep(saved);
    this.checkpoint({ entry: saved });
  }
  markNative(id: string): void {
    this.native.add(id);
  }
  reload(): void {
    for (const entry of this.pending.values()) {
      if (entry.stage === "native") {
        this.native.add(entry.message.id);
      }
    }
  }
  freshRuntime(): void {
    for (const entry of this.entries()) {
      this.setStage(entry, "queued");
    }
  }
  unconsumed(): readonly PendingInboundMessage[] {
    return this.entries().filter(
      (entry) => entry.stage === "native" && !this.native.has(entry.message.id),
    );
  }
  rememberCompletion(entry: InboundMessageEntry): void {
    const completion = entry.subagentCompletion;
    if (
      entry.from.id !== "subagent-result" ||
      !completion ||
      completion.ownerSessionId !== this.lifecycle.currentSessionId
    ) {
      return;
    }
    for (const child of completion.children) {
      const thread = `subagent-progress:${completion.runId}:${child.agent}:${child.index}`;
      if (child.status === "detached") {
        this.completed.delete(thread);
      } else {
        this.completed.set(thread, child);
      }
    }
    for (const pending of this.queued()) {
      this.discardObsolete(pending);
    }
  }
  discardObsolete(entry: InboundMessageEntry): boolean {
    const message = entry.message;
    if (!isReplaceableProgress(message)) {
      return false;
    }
    const child = this.completed.get(message.threadId ?? "");
    if (
      !child ||
      (entry.from.id !== child.intercomTarget && entry.from.name !== child.intercomTarget)
    ) {
      return false;
    }
    if (!this.pending.has(message.id)) {
      this.remember(entry, "queued", "auto");
    }
    this.pending.delete(message.id);
    this.replies.markReplied(message.id);
    this.checkpoint({ messageId: message.id, stage: "discarded" });
    return true;
  }
  reconcileTools(): void {
    if (this.entries().some(needsIntercom) || this.replies.listPending().some(needsIntercom)) {
      activateTools(this.pi, ["intercom"]);
    }
  }
  private restoreCheckpoint(data: unknown): void {
    if (!isInboundCheckpoint(data) || data.sessionId !== this.lifecycle.currentSessionId) {
      return;
    }
    if ("entry" in data) {
      this.rememberCompletion(data.entry);
      this.replies.recordIncomingMessage(
        data.entry.from,
        data.entry.message,
        data.entry.receivedAt,
      );
      if (!this.consumed.has(data.entry.message.id)) {
        this.keep({ ...data.entry });
      }
      return;
    }
    if (data.stage === "reply-retired") {
      this.replies.markReplied(data.messageId);
      return;
    }
    if (data.stage === "discarded") {
      this.pending.delete(data.messageId);
      this.replies.markReplied(data.messageId);
      return;
    }
    const pending = this.pending.get(data.messageId);
    if (pending) {
      this.pending.set(data.messageId, { ...pending, stage: data.stage });
    }
  }
  private restoreEntry(item: SessionEntry): void {
    if (item.type === "custom_message") {
      if (isInboundEntry(item.details)) {
        this.rememberCompletion(item.details);
      }
      const id = inboundIdFromCustomMessage(item);
      if (id !== undefined) {
        this.consumed.add(id);
        this.pending.delete(id);
      }
      return;
    }
    if (item.type !== "custom") {
      return;
    }
    if (item.customType === INBOUND_CHECKPOINT_TYPE) {
      this.restoreCheckpoint(item.data);
      return;
    }
    if (item.customType === "intercom_sent") {
      this.restoreSent(item.data);
    }
  }
  private restoreSent(data: unknown): void {
    if (
      isRecord(data) &&
      isRecord(data.message) &&
      typeof data.message.replyTo === "string" &&
      data.message.replyTo !== ""
    ) {
      this.replies.markReplied(data.message.replyTo);
    }
  }
  *restore(ctx: ExtensionContext, generation: number): Generator<void, void> {
    this.consumed.clear();
    this.completed.clear();
    const leaf = ctx.sessionManager.getLeafId();
    for (const metadata of ctx.sessionManager.getEntries()) {
      yield;
      if (!this.lifecycle.live(ctx, generation)) {
        return;
      }
      if (!this.isRelevant(metadata)) {
        continue;
      }
      this.restoreEntry(ctx.sessionManager.getEntry(metadata.id) ?? metadata);
    }
    if (!this.lifecycle.live(ctx, generation)) {
      return;
    }
    this.reconciledLeaf = leaf;
    for (const entry of this.pending.values()) {
      this.discardObsolete(entry);
    }
  }
  private isRelevant(entry: SessionEntry): boolean {
    return (
      (entry.type === "custom_message" &&
        ["intercom_message", "subagent-human-message"].includes(entry.customType)) ||
      (entry.type === "custom" &&
        [INBOUND_CHECKPOINT_TYPE, "intercom_sent"].includes(entry.customType))
    );
  }
  private recentEntries(ctx: ExtensionContext, fullScan: boolean): readonly SessionEntry[] {
    if (fullScan) {
      return ctx.sessionManager.getEntries();
    }
    const entries: SessionEntry[] = [];
    let id = ctx.sessionManager.getLeafId();
    while (id !== this.reconciledLeaf) {
      const entry = id === null ? undefined : ctx.sessionManager.getEntry(id);
      if (!entry) {
        return ctx.sessionManager.getEntries();
      }
      entries.push(entry);
      id = entry.parentId;
    }
    return entries;
  }
  reconcileConsumed(ctx: ExtensionContext, fullScan = false): void {
    const leaf = ctx.sessionManager.getLeafId();
    if (this.pending.size > 0) {
      for (const metadata of this.recentEntries(ctx, fullScan)) {
        if (
          metadata.type !== "custom_message" ||
          !["intercom_message", "subagent-human-message"].includes(metadata.customType)
        ) {
          continue;
        }
        const entry = ctx.sessionManager.getEntry(metadata.id) ?? metadata;
        const id = inboundIdFromCustomMessage(entry);
        if (id !== undefined) {
          this.consumed.add(id);
        }
      }
      for (const id of this.pending.keys()) {
        if (this.consumed.has(id)) {
          this.pending.delete(id);
          this.native.delete(id);
        }
      }
    }
    this.reconciledLeaf = leaf;
  }
}
export type Journal = Readonly<InboundJournal>;
