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

type MessageState =
  | {
      readonly kind: "queued";
      readonly entry: PendingInboundMessage & { readonly stage: "queued" };
    }
  | {
      readonly kind: "handoff" | "queue-owned";
      readonly entry: PendingInboundMessage & { readonly stage: "native" };
    }
  | { readonly kind: "retired" };

export class InboundJournal {
  private readonly messages = new Map<string, MessageState>();
  private pendingCount = 0;
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
      if (pending.from.id === id && this.get(pending.message.id)?.stage !== "queued") {
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
    return this.pendingCount;
  }
  entries(): readonly PendingInboundMessage[] {
    return [...this.messages.values()].flatMap((state) =>
      state.kind === "retired" ? [] : [state.entry],
    );
  }
  queued(): readonly PendingInboundMessage[] {
    return this.entries().filter((entry) => entry.stage === "queued");
  }
  get(id: string): PendingInboundMessage | undefined {
    const state = this.messages.get(id);
    return state?.kind === "retired" ? undefined : state?.entry;
  }
  owns(entry: InboundMessageEntry): boolean {
    const id = entry.message.id;
    return "stage" in entry ? this.get(id) === entry : !this.messages.has(id);
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
  private transition(id: string, next: MessageState): void {
    const previous = this.messages.get(id);
    if (previous !== undefined && previous.kind !== "retired") {
      this.pendingCount--;
    }
    if (next.kind !== "retired") {
      this.pendingCount++;
    }
    this.messages.set(id, next);
  }
  consume(id: string): void {
    this.transition(id, { kind: "retired" });
  }
  clearNative(): void {
    for (const [id, state] of this.messages) {
      if (state.kind === "queue-owned") {
        this.transition(id, { kind: "handoff", entry: state.entry });
      }
    }
  }
  reset(): void {
    this.messages.clear();
    this.pendingCount = 0;
    this.reconciledLeaf = null;
  }
  keep(entry: PendingInboundMessage): void {
    if (
      entry.stage === "queued" &&
      entry.message.queueMode === "replace" &&
      entry.message.threadId !== undefined &&
      entry.message.threadId !== ""
    ) {
      for (const pending of this.queued()) {
        if (
          pending.stage === "queued" &&
          pending.from.id === entry.from.id &&
          pending.message.threadId === entry.message.threadId
        ) {
          this.supersede(pending.message.id);
        }
      }
    }
    this.store(entry);
  }
  private store(entry: PendingInboundMessage): void {
    if (entry.stage === "queued") {
      this.transition(entry.message.id, {
        kind: "queued",
        entry: { ...entry, stage: "queued" },
      });
      return;
    }
    this.transition(entry.message.id, {
      kind: this.messages.get(entry.message.id)?.kind === "queue-owned" ? "queue-owned" : "handoff",
      entry: { ...entry, stage: "native" },
    });
  }
  private supersede(id: string): void {
    this.consume(id);
    this.replies.markReplied(id);
  }
  setStage(entry: PendingInboundMessage, stage: PendingInboundMessage["stage"]): void {
    if (entry.stage === stage) {
      return;
    }
    this.store({ ...entry, stage });
    this.checkpoint({ messageId: entry.message.id, stage });
  }
  remember(
    entry: InboundMessageEntry,
    stage: PendingInboundMessage["stage"],
    flushDelivery: PendingInboundMessage["flushDelivery"],
  ): void {
    const pending = this.get(entry.message.id);
    if (pending) {
      this.setStage(pending, stage);
      return;
    }
    const saved = { ...entry, stage, flushDelivery, receivedAt: Date.now() };
    this.keep(saved);
    this.checkpoint({ entry: saved });
  }
  markNative(id: string): void {
    const state = this.messages.get(id);
    if (state?.kind === "handoff") {
      this.transition(id, { kind: "queue-owned", entry: state.entry });
    }
  }
  reload(): void {
    for (const entry of this.entries()) {
      if (entry.stage === "native") {
        this.markNative(entry.message.id);
      }
    }
  }
  freshRuntime(): void {
    for (const entry of this.entries()) {
      this.setStage(entry, "queued");
    }
  }
  unconsumed(): readonly PendingInboundMessage[] {
    return [...this.messages.values()].flatMap((state) =>
      state.kind === "handoff" ? [state.entry] : [],
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
      if (this.messages.get(data.entry.message.id)?.kind !== "retired") {
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
    const pending = this.get(data.messageId);
    if (pending) {
      this.store({ ...pending, stage: data.stage });
    }
  }
  private restoreEntry(item: SessionEntry): void {
    if (item.type === "custom_message") {
      const id = inboundIdFromCustomMessage(item);
      if (id !== undefined) {
        this.consume(id);
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
    for (const [id, state] of this.messages) {
      if (state.kind === "retired") {
        this.messages.delete(id);
      }
    }
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
    if (this.size > 0) {
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
          this.consume(id);
        }
      }
    }
    this.reconciledLeaf = leaf;
  }
}
