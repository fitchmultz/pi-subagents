import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { IntercomConfig } from "./config.ts";
import type { IntercomLifecycle } from "./lifecycle.ts";
import type { InboundDeliveryOwner } from "./inbound-delivery.ts";
import type { InboundJournal } from "./inbound-journal.ts";
import type { ReplyTracker } from "./reply-tracker.ts";
import type { ReplyWait } from "./reply-wait.ts";
import type { IntercomConnection } from "./connection.ts";
import type { InboundMessageEntry } from "./runtime-types.ts";
import type { Message, SessionInfo } from "./types.ts";
import { requestedDelivery } from "./inbound-record.ts";
import { formatAttachments } from "./message-format.ts";

type Lifecycle = Readonly<
  Pick<IntercomLifecycle, "generation" | "isIdle" | "live" | "markActivity">
>;
type InboundDeliveryHandle = Readonly<
  Pick<InboundDeliveryOwner, "batching" | "queue" | "restoring" | "send">
>;
type ReplyWaitHandle = Readonly<Pick<ReplyWait, "receive">>;
type Connection = Readonly<Pick<IntercomConnection, "syncStatus">>;
type Replies = Readonly<Pick<ReplyTracker, "recordIncomingMessage">>;

interface InboundOwners {
  readonly delivery: InboundDeliveryHandle;
  readonly journal: Readonly<Pick<InboundJournal, "consume" | "owns">>;
  readonly replies: Replies;
  readonly wait: ReplyWaitHandle;
  readonly connection: Connection;
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
      this.busy(entry, generation);
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
  private busy(entry: InboundMessageEntry, generation: number): void {
    const delivery = requestedDelivery(entry.message);
    if (delivery === "steer") {
      this.owners.delivery.send(entry, "steer", generation);
      return;
    }
    if (delivery === "queue") {
      this.owners.delivery.send(entry, "followUp", generation);
      return;
    }
    this.owners.delivery.queue(entry, "passive");
  }
  async receive(ctx: ExtensionContext, from: SessionInfo, input: Message): Promise<void> {
    const generation = this.lifecycle.generation;
    const restore = this.owners.delivery.restoring;
    if (restore) {
      await restore;
    }
    const live = this.lifecycle.live(ctx, generation);
    if (!live) {
      return;
    }
    // Peer metadata never grants user authority.
    const message = input.human ? { ...input, human: undefined } : input;
    const entry = this.entry(from, message);
    if (!this.owners.journal.owns(entry)) {
      return;
    }
    if (
      this.owners.wait.receive(from, message, () => {
        this.owners.journal.consume(message.id);
        this.lifecycle.markActivity();
        this.owners.connection.syncStatus();
      })
    ) {
      return;
    }
    this.owners.replies.recordIncomingMessage(from, message);
    this.lifecycle.markActivity();
    this.owners.connection.syncStatus();
    await this.admit(entry, live, generation);
  }
}
