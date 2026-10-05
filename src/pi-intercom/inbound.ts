import { createHash } from "node:crypto";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { IntercomConfig } from "./config.ts";
import type { Lifecycle } from "./lifecycle.ts";
import type { Journal } from "./inbound-journal.ts";
import type { InboundDeliveryHandle } from "./inbound-delivery.ts";
import type { ReplyTracker } from "./reply-tracker.ts";
import type { ReplyWaitHandle } from "./reply-wait.ts";
import type { Connection } from "./connection.ts";
import type { TopicOwner } from "./topics.ts";
import type { ChildOrchestratorMetadata, InboundMessageEntry } from "./runtime-types.ts";
import type { Message, SessionInfo } from "./types.ts";
import { requestedDelivery, isBlockingSupervisorMessage } from "./inbound-record.ts";
import { formatAttachments } from "./message-format.ts";
import { getRunMetadataDir, readRunJson } from "../runs/shared/supervisor-questions.ts";

interface InboundOwners {
  readonly journal: Journal;
  readonly delivery: InboundDeliveryHandle;
  readonly replies: Readonly<ReplyTracker>;
  readonly wait: ReplyWaitHandle;
  readonly connection: Connection;
  readonly topics: TopicOwner;
  readonly child: ChildOrchestratorMetadata | null;
}
/** Validates origin and chooses admission; state/resources remain in their owners. */
export class IntercomInbound {
  private readonly lifecycle: Lifecycle;
  private readonly config: IntercomConfig;
  private readonly owners: InboundOwners;
  constructor(lifecycle: Lifecycle, config: IntercomConfig, owners: InboundOwners) {
    this.lifecycle = lifecycle;
    this.config = config;
    this.owners = owners;
  }
  private ownedHuman(from: SessionInfo, message: Message): boolean {
    const origin = message.human;
    const child = this.owners.child;
    if (!origin || !child || origin.runId !== child.runId || origin.index !== Number(child.index)) {
      return false;
    }
    const owner = readRunJson<{ readonly sessionId?: string }>(
      path.join(getRunMetadataDir(origin.runId), "question-owner.json"),
    );
    return (
      owner?.sessionId === origin.ownerSessionId &&
      from.id ===
        `pi-${createHash("sha256").update(origin.ownerSessionId).digest("hex").slice(0, 32)}`
    );
  }
  private normalize(from: SessionInfo, input: Message): Message {
    const message = input.topic
      ? {
          ...input,
          content: {
            ...input.content,
            text: `Topic ${input.topic.topic} · ${input.topic.event}\n${input.content.text}`,
          },
        }
      : input;
    return message.human && !this.ownedHuman(from, message)
      ? { ...message, human: undefined }
      : message;
  }
  private entry(from: SessionInfo, message: Message): InboundMessageEntry {
    const attachments = message.content.attachments;
    return {
      from,
      message,
      replyCommand:
        this.config.replyHint && message.expectsReply === true
          ? 'intercom({ action: "reply", message: "..." })'
          : undefined,
      bodyText: `${message.content.text}${attachments !== undefined && attachments.length > 0 ? formatAttachments(attachments) : ""}`,
    };
  }
  private queueAdmission(entry: InboundMessageEntry, ctx: ExtensionContext): boolean {
    const delivery = requestedDelivery(entry.message);
    if (this.owners.delivery.batching) {
      let flush: "auto" | "passive" | "steer" = "auto";
      if (delivery === "passive") {
        flush = "passive";
      }
      if (delivery === "steer") {
        flush = "steer";
      }
      this.owners.delivery.queue(entry, flush);
      return true;
    }
    if (delivery !== "queue" || entry.message.queueMode !== "replace") {
      return false;
    }
    if (!this.lifecycle.isIdle(ctx) && !ctx.hasUI) {
      this.owners.delivery.queue(entry, "steer", 1600);
    } else {
      this.owners.delivery.queue(entry, "auto");
    }
    return true;
  }
  private async busyNonInteractive(
    entry: InboundMessageEntry,
    ctx: ExtensionContext,
    generation: number,
  ): Promise<void> {
    if (entry.message.expectsReply !== true) {
      this.owners.delivery.send(entry, "steer", generation);
      return;
    }
    const active = this.owners.connection.active;
    if (entry.message.replyTo !== undefined || active?.isConnected() !== true) {
      return;
    }
    try {
      const result = await active.send(entry.from.id, {
        text: "This agent is running in non-interactive mode and cannot respond to intercom messages while it is working. It will continue its current task and exit when done.",
        replyTo: entry.message.id,
      });
      if (result.delivered && this.lifecycle.live(ctx, generation)) {
        this.owners.replies.markReplied(entry.message.id);
        this.lifecycle.markActivity();
        this.owners.connection.syncStatus();
      }
    } catch {
      /* Best-effort busy reply; the non-interactive task must continue either way. */
    }
  }
  private async prepareBusy(
    entry: InboundMessageEntry,
    ctx: ExtensionContext,
    generation: number,
  ): Promise<boolean> {
    if (!isBlockingSupervisorMessage(entry)) {
      return true;
    }
    const willDeliver = ctx.hasUI || requestedDelivery(entry.message) !== "auto";
    if (willDeliver) {
      this.owners.journal.remember(entry, "queued", "auto");
    }
    await this.owners.delivery.detach(entry);
    return (
      this.lifecycle.live(ctx, generation) !== null &&
      (!willDeliver || this.owners.journal.get(entry.message.id)?.stage === "queued")
    );
  }
  private async steerBusy(entry: InboundMessageEntry, generation: number): Promise<void> {
    this.owners.delivery.send(entry, "steer", generation);
    if (!isBlockingSupervisorMessage(entry)) {
      await this.owners.delivery.detach(entry, true);
    }
  }
  private async admit(
    entry: InboundMessageEntry,
    live: ExtensionContext,
    generation: number,
  ): Promise<void> {
    const active = this.lifecycle.live(live, generation);
    if (!active || this.queueAdmission(entry, active)) {
      return;
    }
    if (!this.lifecycle.isIdle(active)) {
      await this.busy(entry, active, generation);
      return;
    }
    if (this.lifecycle.live(live, generation)) {
      this.owners.delivery.send(
        entry,
        requestedDelivery(entry.message) === "passive" ? "passive" : "trigger",
        generation,
      );
    }
  }
  private async busy(
    entry: InboundMessageEntry,
    ctx: ExtensionContext,
    generation: number,
  ): Promise<void> {
    const delivery = requestedDelivery(entry.message);
    if (!(await this.prepareBusy(entry, ctx, generation))) {
      return;
    }
    if (delivery === "steer") {
      await this.steerBusy(entry, generation);
      return;
    }
    if (delivery === "queue" && entry.message.queueMode !== "replace") {
      this.owners.delivery.send(entry, "followUp", generation);
      return;
    }
    if (delivery === "passive") {
      this.owners.delivery.queue(entry, "passive");
      return;
    }
    if (!ctx.hasUI) {
      await this.busyNonInteractive(entry, ctx, generation);
      return;
    }
    this.owners.delivery.queue(entry, "auto");
  }
  async receive(ctx: ExtensionContext, from: SessionInfo, input: Message): Promise<void> {
    const generation = this.lifecycle.generation;
    const restore = this.owners.delivery.restoring;
    if (restore) {
      await restore;
    }
    const live = this.lifecycle.live(ctx, generation);
    if (!live || this.owners.topics.receive(from, input)) {
      return;
    }
    const message = this.normalize(from, input);
    if (
      this.owners.wait.receive(from, message, () => {
        this.lifecycle.markActivity();
        this.owners.connection.syncStatus();
      })
    ) {
      return;
    }
    this.owners.replies.recordIncomingMessage(from, message);
    this.lifecycle.markActivity();
    this.owners.connection.syncStatus();
    const entry = this.entry(from, message);
    if (this.owners.journal.discardObsolete(entry)) {
      return;
    }
    await this.admit(entry, live, generation);
  }
}
