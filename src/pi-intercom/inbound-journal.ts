import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { isContextRequest, type IntercomLifecycle } from "./lifecycle.ts";
import type { ReplyTracker } from "./reply-tracker.ts";
import {
  INBOUND_CHECKPOINT_TYPE,
  type InboundCheckpoint,
  type InboundMessageEntry,
  type PendingInboundMessage,
} from "./runtime-types.ts";
import {
  checkpointMessageId,
  isInboundCheckpoint,
  publicationMetadata,
  requestedDelivery,
} from "./inbound-record.ts";
import {
  isReceiptQuery,
  type NativeReceipt,
  type ReceiptQuery,
  type ReceiptResult,
} from "./types.ts";
import { inboundIdFromCustomMessage } from "./message-format.ts";
import { isRecord } from "./validation.ts";

/** Owns durable delivery stages, receipts and completion tombstones. */
type Lifecycle = Readonly<Pick<IntercomLifecycle, "currentSessionId" | "live">>;
type Replies = Readonly<
  Pick<ReplyTracker, "expireSender" | "listPending" | "markReplied" | "recordIncomingMessage">
>;

export class InboundJournal {
  private readonly pending = new Map<string, PendingInboundMessage>();
  private readonly native = new Set<string>();
  private readonly consumed = new Set<string>();
  private reconciledLeaf: string | null = null;
  private readonly pi: ExtensionAPI;
  private readonly lifecycle: Lifecycle;
  private readonly replies: Replies;
  constructor(pi: ExtensionAPI, lifecycle: Lifecycle, replies: Replies) {
    this.pi = pi;
    this.lifecycle = lifecycle;
    this.replies = replies;
    pi.events.on("pi-intercom:provenance-query", (request) => {
      if (!isContextRequest(request)) {
        return;
      }
      request.respond(
        request.version === 1 && isReceiptQuery(request)
          ? this.receipt(request)
          : { error: "publication_unavailable" },
      );
    });
  }
  receipt(query: ReceiptQuery): ReceiptResult {
    const ctx = this.lifecycle.live();
    if (!ctx || ctx.sessionManager.getSessionId() !== query.rootSessionId) {
      return { error: "publication_unavailable" };
    }
    let receipt: NativeReceipt | undefined;
    for (const item of ctx.sessionManager.getEntries()) {
      receipt = this.receiptEntry(receipt, query, item);
    }
    return receipt ? { receipt } : { error: "receipt_not_found" };
  }
  private receiptEntry(
    receipt: NativeReceipt | undefined,
    query: ReceiptQuery,
    item: SessionEntry,
  ): NativeReceipt | undefined {
    if (
      item.type === "custom" &&
      item.customType === INBOUND_CHECKPOINT_TYPE &&
      checkpointMessageId(item.data) === query.messageId &&
      isInboundCheckpoint(item.data) &&
      item.data.sessionId === query.rootSessionId
    ) {
      return this.receiptCheckpoint(receipt, query, item.id, item.data);
    }
    return receipt && inboundIdFromCustomMessage(item) === query.messageId
      ? { ...receipt, placementEntryId: item.id }
      : receipt;
  }
  private receiptCheckpoint(
    receipt: NativeReceipt | undefined,
    query: ReceiptQuery,
    entryId: string,
    data: InboundCheckpoint,
  ): NativeReceipt | undefined {
    if ("entry" in data) {
      if (receipt) {
        return receipt;
      }
      const { from, message, stage, receivedAt } = data.entry;
      return {
        version: 1,
        rootSessionId: query.rootSessionId,
        messageId: query.messageId,
        sender: {
          peerId: from.id,
          rootSessionId: from.rootSessionId,
          incarnation: from.incarnation,
        },
        textSha256: createHash("sha256").update(message.content.text, "utf8").digest("hex"),
        delivery: requestedDelivery(message),
        ...publicationMetadata(message),
        checkpointEntryId: entryId,
        receivedAt,
        queued: stage === "queued",
        nativeHandoff: stage === "native",
        placementEntryId: null,
        discarded: false,
      };
    }
    if (!receipt) {
      return receipt;
    }
    return {
      ...receipt,
      queued: receipt.queued || data.stage === "queued",
      nativeHandoff: receipt.nativeHandoff || data.stage === "native",
      discarded: receipt.discarded || data.stage === "discarded",
    };
  }
  peerLeft(id: string): void {
    for (const pending of this.replies.listPending()) {
      if (pending.from.id === id && this.pending.get(pending.message.id)?.stage !== "queued") {
        this.retire(pending.message.id);
      }
    }
    this.replies.expireSender(id);
    for (const pending of this.queued()) {
      if (pending.from.id === id && pending.message.expectsReply === true) {
        this.consume(pending.message.id);
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
  owns(entry: InboundMessageEntry): boolean {
    const id = entry.message.id;
    return "stage" in entry
      ? this.pending.get(id) === entry
      : !this.pending.has(id) && !this.consumed.has(id);
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
          this.consume(pending.message.id);
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
  private restoreCheckpoint(data: unknown): void {
    if (!isInboundCheckpoint(data) || data.sessionId !== this.lifecycle.currentSessionId) {
      return;
    }
    if ("entry" in data) {
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
      this.consume(data.messageId);
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
    if (
      item.customType === "intercom_received" &&
      isRecord(item.data) &&
      typeof item.data.messageId === "string"
    ) {
      this.consume(item.data.messageId);
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
  }
  private isRelevant(entry: SessionEntry): boolean {
    return (
      (entry.type === "custom_message" &&
        ["intercom_message", "subagent-human-message"].includes(entry.customType)) ||
      (entry.type === "custom" &&
        [INBOUND_CHECKPOINT_TYPE, "intercom_sent", "intercom_received"].includes(entry.customType))
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
