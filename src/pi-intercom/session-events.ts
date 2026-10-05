import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Lifecycle } from "./lifecycle.ts";
import type { Connection } from "./connection.ts";
import type { InboundDeliveryHandle } from "./inbound-delivery.ts";
import type { Journal } from "./inbound-journal.ts";
import { isDurableSupervisorQuestion, type ReplyTracker } from "./reply-tracker.ts";
import type { ReplyWaitHandle } from "./reply-wait.ts";
import type { TopicOwner } from "./topics.ts";
import type { SubagentEventBridges } from "./subagent-events.ts";
import type { IntercomSupervisor } from "./supervisor.ts";
import type { PeerAwareness } from "./peer-awareness.ts";
import { RECIPIENT_TURN_FAILED_ATTACHMENT } from "./runtime-types.ts";
import { getAssistantErrorMessage, inboundIdFromCustomMessage } from "./message-format.ts";
import { restoreLazyTools } from "../shared/lazy-tools.ts";
interface SessionOwners {
  readonly lifecycle: Lifecycle;
  readonly connection: Connection;
  readonly delivery: InboundDeliveryHandle;
  readonly journal: Journal;
  readonly replies: Readonly<ReplyTracker>;
  readonly wait: ReplyWaitHandle;
  readonly topics: TopicOwner;
  readonly bridges: Readonly<SubagentEventBridges>;
  readonly supervisor: Readonly<IntercomSupervisor> | null;
  readonly awareness: Readonly<PeerAwareness> | null;
}
/** Native phase ordering is centralized here; each resource is cleaned by its owner. */
export class IntercomSessionEvents {
  private readonly pi: ExtensionAPI;
  private readonly owners: SessionOwners;
  constructor(pi: ExtensionAPI, owners: SessionOwners) {
    this.pi = pi;
    this.owners = owners;
  }
  private async start(reason: string, ctx: ExtensionContext): Promise<void> {
    const { lifecycle, bridges, awareness, connection, topics, delivery } = this.owners;
    bridges.start();
    const generation = lifecycle.start(ctx);
    awareness?.reset();
    connection.clearTimers();
    topics.start(ctx);
    if (reason !== "reload") {
      restoreLazyTools(this.pi, ctx, "load_intercom", ["intercom"]);
    }
    await delivery.start(ctx, reason, generation);
    if (lifecycle.live(ctx, generation)) {
      connection.start(ctx, generation);
    }
  }
  private async shutdown(): Promise<void> {
    const { bridges, connection, delivery, wait, lifecycle, replies, journal, supervisor } =
      this.owners;
    bridges.stop();
    connection.clearTimers();
    delivery.clearTimer();
    wait.reject(new Error("Session shutting down"));
    // Reload keeps the outgoing runner valid until native handoff completes.
    await delivery.drain();
    lifecycle.invalidate();
    await Promise.allSettled([connection.shutdown(), bridges.drain(), supervisor?.drain()]);
    delivery.reset();
    replies.reset();
    journal.reset();
    lifecycle.clear();
  }
  private consumeMessage(message: unknown): void {
    const id = inboundIdFromCustomMessage(message);
    if (id !== undefined && id !== "") {
      this.owners.journal.consume(id);
    }
  }
  private async messageEnd(message: unknown): Promise<void> {
    const { journal, connection, replies } = this.owners;
    this.consumeMessage(message);
    const client = connection.active;
    const context = replies.currentTurn();
    const error = getAssistantErrorMessage(message);
    if (
      client?.isConnected() !== true ||
      !context ||
      context.message.expectsReply !== true ||
      error === null ||
      error === ""
    ) {
      return;
    }
    try {
      const result = await client.send(context.from.id, {
        text: `Recipient turn failed: ${error}`,
        replyTo: context.message.id,
        attachments: [{ type: "context", name: RECIPIENT_TURN_FAILED_ATTACHMENT, content: error }],
      });
      if (result.delivered && !isDurableSupervisorQuestion(context.message)) {
        journal.retire(context.message.id);
      }
    } catch {
      /* Best-effort propagation; the recipient's local error remains visible. */
    }
  }
  private registerSessionBoundaries(): void {
    const { lifecycle, connection, journal, awareness } = this.owners;
    this.pi.on("session_start", async (event, ctx) => {
      await this.start(event.reason, ctx);
    });
    this.pi.on("session_shutdown", async () => {
      await this.shutdown();
    });
    this.pi.on("session_info_changed", (_event, ctx) => {
      const id = lifecycle.currentSessionId;
      if (lifecycle.live(ctx) && id !== null) {
        connection.syncIdentity(id);
      }
    });
    this.pi.on("session_tree", (_event, ctx) => {
      if (lifecycle.live(ctx)) {
        journal.reconcileConsumed(ctx, true);
      }
      journal.reconcileTools();
    });
    this.pi.on("session_compact", () => {
      journal.reconcileTools();
    });
    this.pi.on("before_agent_start", async (event, ctx) => {
      await awareness?.beforeStart(event, ctx);
    });
    this.pi.on("model_select", (event, ctx) => {
      if (!lifecycle.live(ctx)) {
        return;
      }
      lifecycle.selectModel(event.model.id);
      connection.active?.updatePresence({
        ...lifecycle.identity(ctx.sessionManager.getSessionId()),
        model: event.model.id,
        status: lifecycle.status(),
      });
    });
  }
  private registerTurns(): void {
    const { lifecycle, connection, replies, journal, delivery } = this.owners;
    this.pi.on("turn_start", (_event, ctx) => {
      if (!lifecycle.live(ctx)) {
        return;
      }
      connection.syncIdentity(ctx.sessionManager.getSessionId());
      replies.beginTurn();
    });
    this.pi.on("turn_end", (event) => {
      if (!lifecycle.live()) {
        return;
      }
      // Pi exposes the next batch, not every custom queued item. Empty proves all cleared.
      // ponytail: selective queue removal is unobservable; upgrade to a complete native snapshot if added.
      if (event.context.pendingMessages.length === 0) {
        journal.clearNative();
      }
      replies.endTurn();
      delivery.schedule(0);
    });
    this.pi.on("message_end", async (event) => {
      await this.messageEnd(event.message);
    });
    this.pi.on("agent_start", () => {
      if (!lifecycle.live()) {
        return;
      }
      lifecycle.agentStart();
      connection.syncStatus();
      return delivery.flush();
    });
    this.pi.on("agent_settled", async (_event, ctx) => {
      if (!lifecycle.live(ctx) || ctx.signal) {
        return;
      }
      const generation = lifecycle.generation;
      lifecycle.agentSettled();
      replies.endAgent();
      connection.syncStatus();
      await delivery.redeliver(ctx, generation);
      if (lifecycle.live(ctx, generation)) {
        delivery.schedule(0);
      }
    });
  }
  register(): void {
    this.registerSessionBoundaries();
    this.registerTurns();
    const { lifecycle, connection, delivery } = this.owners;
    this.pi.on("tool_execution_start", (event) => {
      if (!lifecycle.live()) {
        return;
      }
      lifecycle.toolStart(event.toolCallId, event.toolName);
      connection.syncStatus();
    });
    this.pi.on("tool_execution_end", (event) => {
      if (!lifecycle.live()) {
        return;
      }
      lifecycle.toolEnd(event.toolCallId);
      connection.syncStatus();
      return delivery.flush();
    });
  }
}
