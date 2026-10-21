import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { IntercomLifecycle } from "./lifecycle.ts";
import type { InboundJournal } from "./inbound-journal.ts";
import type { ReplyTracker } from "./reply-tracker.ts";
import type {
  InboundDelivery,
  InboundMessageEntry,
  PendingInboundMessage,
} from "./runtime-types.ts";
import { requestedDelivery } from "./inbound-record.ts";
import { isRecord } from "./validation.ts";
import { runCooperatively } from "../shared/cooperative.ts";

type Lifecycle = Readonly<Pick<IntercomLifecycle, "generation" | "isIdle" | "live" | "toolCount">>;
type Journal = Readonly<
  Pick<
    InboundJournal,
    | "freshRuntime"
    | "get"
    | "markNative"
    | "owns"
    | "queued"
    | "reconcileConsumed"
    | "reload"
    | "remember"
    | "reset"
    | "restore"
    | "size"
    | "unconsumed"
  >
>;
type Replies = Readonly<Pick<ReplyTracker, "queueTurnContext" | "reset">>;

interface DeliveryHooks {
  readonly replies: Replies;
  readonly syncStatus: () => void;
}
/** Owns cooperative inbound batches, restoration and the flush timer. */
export class InboundDeliveryOwner {
  private timer: NodeJS.Timeout | null = null;
  private restoreTask: Promise<void> | undefined;
  private batchTask: Promise<void> | undefined;
  private detachTask: Promise<boolean> | undefined;
  private readonly pi: ExtensionAPI;
  private readonly lifecycle: Lifecycle;
  private readonly journal: Journal;
  private readonly hooks: DeliveryHooks;
  constructor(pi: ExtensionAPI, lifecycle: Lifecycle, journal: Journal, hooks: DeliveryHooks) {
    this.pi = pi;
    this.lifecycle = lifecycle;
    this.journal = journal;
    this.hooks = hooks;
  }
  get restoring(): Promise<void> | undefined {
    return this.restoreTask;
  }
  get batching(): boolean {
    return this.batchTask !== undefined;
  }
  clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
  async drain(): Promise<void> {
    this.clearTimer();
    await Promise.allSettled([this.restoreTask, this.batchTask, this.detachTask]);
    this.clearTimer();
  }
  reset(): void {
    this.restoreTask = undefined;
    this.batchTask = undefined;
    this.clearTimer();
  }
  async start(ctx: ExtensionContext, reason: string, generation: number): Promise<void> {
    this.journal.reset();
    this.hooks.replies.reset();
    const task = Promise.resolve().then(() => this.restore(ctx, generation));
    this.restoreTask = task;
    await task;
    if (!this.lifecycle.live(ctx, generation)) {
      return;
    }
    if (this.restoreTask === task) {
      this.restoreTask = undefined;
    }
    if (reason === "reload") {
      this.journal.reload();
    }
    if (reason !== "reload" && !ctx.signal && !ctx.hasPendingMessages()) {
      this.journal.freshRuntime();
    }
    if (this.journal.queued().length > 0) {
      this.schedule();
    }
  }
  private async restore(ctx: ExtensionContext, generation: number): Promise<void> {
    await runCooperatively(this.journal.restore(ctx, generation));
    if (!this.lifecycle.live(ctx, generation)) {
      return;
    }
    this.journal.reconcileConsumed(ctx);
  }
  schedule(delayMs = 200): void {
    if (!this.lifecycle.live()) {
      return;
    }
    const generation = this.lifecycle.generation;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush(generation)?.catch((error: unknown) => {
        console.error("Intercom inbound delivery failed:", error);
      });
    }, delayMs);
    this.timer.unref();
  }
  queue(
    entry: InboundMessageEntry,
    flushDelivery: PendingInboundMessage["flushDelivery"] = "auto",
    delayMs = 200,
  ): void {
    if (!this.journal.owns(entry)) {
      return;
    }
    this.journal.remember(entry, "queued", flushDelivery);
    this.hooks.syncStatus();
    this.schedule(delayMs);
  }
  private runBatch(deliver: () => Promise<void>, generation: number): Promise<void> {
    if (this.batchTask) {
      return this.batchTask;
    }
    // Native appends emit subscribers synchronously; publish ownership first.
    const task = Promise.resolve().then(deliver);
    this.batchTask = task;
    const finish = () => {
      if (this.batchTask !== task) {
        return;
      }
      this.batchTask = undefined;
      if (
        this.lifecycle.generation === generation &&
        this.lifecycle.live() &&
        this.journal.queued().length > 0
      ) {
        this.schedule(0);
      }
    };
    task.then(finish, finish).catch((error: unknown) => {
      console.error("Intercom inbound cleanup failed:", error);
    });
    return task;
  }
  private triggerIndex(entries: readonly PendingInboundMessage[]): number {
    const canTrigger = (entry: PendingInboundMessage) =>
      entry.flushDelivery !== "passive" && requestedDelivery(entry.message) !== "passive";
    return entries.findLastIndex(canTrigger);
  }
  private *sendTriggerLast(
    entries: readonly PendingInboundMessage[],
    generation: number,
  ): Generator<void, void> {
    const passives = entries.filter((entry) => entry.flushDelivery === "passive");
    const rest = entries.filter((entry) => entry.flushDelivery !== "passive");
    yield* this.sendPassives(passives, generation);
    if (!this.live(generation)) {
      return;
    }
    const index = this.triggerIndex(rest);
    const trigger = index === -1 ? undefined : rest.splice(index, 1)[0];
    const replyTarget = entries.find((entry) => entry.message.expectsReply === true) ?? trigger;
    if (replyTarget && this.journal.get(replyTarget.message.id) === replyTarget) {
      this.hooks.replies.queueTurnContext({ ...replyTarget, receivedAt: Date.now() });
    }
    for (const entry of rest) {
      if (!this.live(generation)) {
        return;
      }
      this.send(
        entry,
        requestedDelivery(entry.message) === "queue" ? "followUp" : "steer",
        generation,
      );
      yield;
    }
    if (trigger) {
      this.send(trigger, "trigger", generation);
    }
  }
  private *sendPassives(
    entries: readonly PendingInboundMessage[],
    generation: number,
  ): Generator<void, void> {
    for (const entry of entries) {
      if (!this.live(generation)) {
        return;
      }
      this.send(entry, "passive", generation);
      yield;
    }
  }
  private live(generation: number): boolean {
    return this.lifecycle.generation === generation && this.lifecycle.live() !== null;
  }
  private *sendSteers(
    entries: readonly PendingInboundMessage[],
    generation: number,
    onDetach: (task: Promise<boolean>) => void,
  ): Generator<void, void> {
    for (const entry of entries) {
      if (!this.live(generation)) {
        return;
      }
      if (!this.journal.owns(entry)) {
        continue;
      }
      this.send(entry, "steer", generation);
      if (requestedDelivery(entry.message) === "steer") {
        onDetach(this.detach(entry, entry.message.expectsReply !== true));
      }
      yield;
    }
  }
  flush(generation = this.lifecycle.generation): Promise<void> | undefined {
    if (this.batchTask) {
      return this.batchTask;
    }
    const entries = this.journal.queued();
    const ctx = this.lifecycle.live();
    if (entries.length === 0 || !ctx || !this.live(generation)) {
      return;
    }
    if (this.lifecycle.isIdle(ctx)) {
      return this.runBatch(
        () => runCooperatively(this.sendTriggerLast(entries, generation)),
        generation,
      );
    }
    const steers = entries.filter(
      (entry) =>
        entry.flushDelivery === "steer" &&
        (requestedDelivery(entry.message) === "steer" ||
          (!ctx.hasUI && this.lifecycle.toolCount === 0)),
    );
    if (steers.length === 0) {
      this.schedule(500);
      return;
    }
    return this.runBatch(async () => {
      const detachments: Promise<boolean>[] = [];
      await runCooperatively(
        this.sendSteers(steers, generation, (task) => {
          detachments.push(task);
        }),
      );
      await Promise.all(detachments);
    }, generation);
  }
  private messageOptions(delivery: InboundDelivery): {
    readonly triggerTurn?: boolean;
    readonly deliverAs?: "steer" | "followUp";
  } {
    if (delivery === "trigger") {
      return { triggerTurn: true };
    }
    if (delivery === "followUp" || delivery === "steer") {
      return { deliverAs: delivery };
    }
    return { triggerTurn: false };
  }
  send(
    entry: InboundMessageEntry,
    delivery: InboundDelivery,
    generation = this.lifecycle.generation,
  ): void {
    if (!this.live(generation)) {
      return;
    }
    if (!this.journal.owns(entry)) {
      return;
    }
    this.trackNative(entry, delivery);
    this.pi.sendMessage(this.nativeMessage(entry), this.messageOptions(delivery));
    const ctx = this.lifecycle.live();
    if (delivery === "passive" && ctx) {
      this.journal.reconcileConsumed(ctx);
    }
  }
  private trackNative(entry: InboundMessageEntry, delivery: InboundDelivery): void {
    this.journal.remember(entry, "native", delivery === "passive" ? "passive" : "auto");
    if (delivery === "steer" || delivery === "followUp") {
      this.journal.markNative(entry.message.id);
    }
    if (delivery !== "passive") {
      this.hooks.replies.queueTurnContext({
        from: entry.from,
        message: entry.message,
        receivedAt: Date.now(),
      });
    }
  }
  private nativeMessage(entry: InboundMessageEntry): Parameters<ExtensionAPI["sendMessage"]>[0] {
    const sender =
      entry.from.name === undefined || entry.from.name === ""
        ? entry.from.id.slice(0, 8)
        : entry.from.name;
    const command = entry.replyCommand ?? "";
    const reply = command === "" ? "" : `\n\nTo reply, use the intercom tool: ${command}`;
    return {
      customType: "intercom_message",
      content: `**📨 From ${sender}** (Native session cwd: ${entry.from.cwd})${reply}\n\n${entry.bodyText}`,
      display: true,
      details: { ...entry, bodyText: entry.bodyText },
    };
  }
  async detach(entry: InboundMessageEntry, attention = false): Promise<boolean> {
    if (!attention && entry.message.expectsReply !== true) {
      return false;
    }
    if (!attention) {
      this.detachTask ??= this.requestDetach(false).finally(() => {
        this.detachTask = undefined;
      });
      return this.detachTask;
    }
    return this.requestDetach(true);
  }
  private async requestDetach(attention: boolean): Promise<boolean> {
    const requestId = randomUUID();
    return await new Promise((resolve) => {
      let settled = false;

      const finish = (accepted: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(accepted);
      };
      const timer = setTimeout(() => finish(false), 500);
      timer.unref();
      const unsubscribe = this.pi.events.on("pi-intercom:detach-response", (payload: unknown) => {
        if (isRecord(payload) && payload.requestId === requestId) {
          finish(payload.accepted === true);
        }
      });
      try {
        this.pi.events.emit("pi-intercom:detach-request", {
          requestId,
          ...(attention ? { reason: "attention" } : {}),
        });
        // Owned waits answer ordinary attention synchronously; an unanswered probe completes now.
        if (attention) {
          finish(false);
        }
      } catch {
        finish(false);
      }
    });
  }
  async redeliver(ctx: ExtensionContext, generation: number): Promise<void> {
    if (this.batchTask) {
      await this.batchTask;
    }
    if (!this.lifecycle.live(ctx, generation)) {
      return;
    }
    this.journal.reconcileConsumed(ctx);
    if (this.journal.size === 0 || ctx.hasPendingMessages()) {
      return;
    }
    await this.runBatch(
      () => runCooperatively(this.sendTriggerLast(this.journal.unconsumed(), generation)),
      generation,
    );
  }
}
