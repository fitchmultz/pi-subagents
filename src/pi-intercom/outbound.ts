import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SendResult } from "./broker/client.ts";
import type { IntercomTransport } from "./transport.ts";
import { resolveConnectedTarget, resolvePeerHealth, type Connection } from "./connection.ts";
import type { IntercomConfig } from "./config.ts";
import type { Lifecycle } from "./lifecycle.ts";
import type { ReplyTracker } from "./reply-tracker.ts";
import type { ReplyWaitHandle } from "./reply-wait.ts";
import {
  RECIPIENT_TURN_FAILED_ATTACHMENT,
  type IntercomToolParams,
  type ToolResultLike,
} from "./runtime-types.ts";
import type { Message } from "./types.ts";
import { errorMessage } from "./validation.ts";
import { formatAttachments } from "./message-format.ts";
import {
  AskDeliveryError,
  failureDetails,
  replyFailureReason,
  type RecoveryAction,
} from "./tool-results.ts";
import { sendOptions, toolError, toolText } from "./tool-arguments.ts";

interface OutboundOwners {
  readonly pi: ExtensionAPI;
  readonly lifecycle: Lifecycle;
  readonly connection: Connection;
  readonly replies: Readonly<ReplyTracker>;
  readonly wait: ReplyWaitHandle;
}
export class IntercomOutbound {
  private readonly owners: OutboundOwners;
  private readonly config: IntercomConfig;
  constructor(owners: OutboundOwners, config: IntercomConfig) {
    this.owners = owners;
    this.config = config;
  }
  private recordSent(
    to: string,
    options: Readonly<Record<string, unknown>>,
    result: SendResult,
  ): void {
    this.owners.pi.appendEntry("intercom_sent", {
      to,
      message: options,
      messageId: result.id,
      timestamp: Date.now(),
    });
  }
  private markActivity(): void {
    this.owners.lifecycle.markActivity();
    this.owners.connection.syncStatus();
  }
  private deliveryFailure(to: string, result: SendResult): ToolResultLike {
    return toolError(
      `Message to "${to}" was not delivered: ${result.reason ?? "Session may not exist or has disconnected."}`,
      failureDetails(
        "delivery_failed",
        [
          { action: "list" },
          { action: "send", guidance: "Retry with an exact active recipient target." },
        ],
        {
          messageId: result.id,
          accepted: result.accepted,
          delivered: false,
          reason: result.reason,
        },
      ),
    );
  }
  private sendHint(params: IntercomToolParams): string {
    if (params.replyTo !== undefined && params.replyTo !== "") {
      return "";
    }
    switch (params.passive === true ? "passive" : params.delivery) {
      case "passive":
        return " (passive; recipient model was not woken)";
      case "steer":
        return " (steers active recipient after the current tool call)";
      case "queue":
        return " (intentionally deferred behind active recipient work)";
      case undefined:
        return " (defaults to steer; wakes idle recipients and steers active recipients after the current tool call)";
    }
  }
  private messageTarget(params: IntercomToolParams): string | undefined {
    if ((params.to ?? "") === "" || (params.message ?? "") === "") {
      return;
    }
    return params.to;
  }
  private async confirm(params: IntercomToolParams, ctx: ExtensionContext): Promise<boolean> {
    if ((params.replyTo ?? "") !== "" || !this.config.confirmSend || !ctx.hasUI) {
      return true;
    }
    const attachmentText = formatAttachments(params.attachments ?? []);
    return await ctx.ui.confirm(
      "Send Message",
      `Send to "${params.to ?? ""}":\n\n${params.message ?? ""}${attachmentText}`,
    );
  }
  private sent(to: string, params: IntercomToolParams, result: SendResult): ToolResultLike {
    this.owners.lifecycle.markActivity();
    this.recordSent(to, { ...sendOptions(params), passive: params.passive === true }, result);
    if ((params.replyTo ?? "") !== "") {
      this.owners.replies.markReplied(params.replyTo ?? "");
    }
    this.owners.connection.syncStatus();
    return toolText(
      result.queued === true
        ? `Message queued for ${to} (${result.reason ?? "queued"})`
        : `Message sent to ${to}${this.sendHint(params)}`,
      {
        messageId: result.id,
        accepted: result.accepted,
        delivered: result.delivered,
        queued: result.queued === true,
        reasonCode: result.queued === true ? "message_queued" : "message_accepted",
      },
    );
  }
  async send(
    active: IntercomTransport,
    params: IntercomToolParams,
    ctx: ExtensionContext,
  ): Promise<ToolResultLike> {
    const to = this.messageTarget(params);
    if (to === undefined) {
      return toolError("Missing 'to' or 'message' parameter");
    }
    try {
      const target = (await resolveConnectedTarget(active, to)) ?? to;
      if (target === active.sessionId) {
        return toolError("Cannot message the current session");
      }
      if (!(await this.confirm(params, ctx))) {
        return toolText("Message cancelled by user");
      }
      const options = { ...sendOptions(params), passive: params.passive === true };
      const result = await active.send(target, options);
      if (!result.accepted) {
        return this.deliveryFailure(to, result);
      }
      return this.sent(to, params, result);
    } catch (error) {
      const text = errorMessage(error);
      return toolError(
        `Failed to send: ${text}`,
        failureDetails(
          text.startsWith("Target ") ? "ambiguous_target" : "send_failed",
          [
            { action: "list" },
            { action: "send", guidance: "Retry with an exact active recipient target." },
          ],
          { error: true },
        ),
      );
    }
  }
  private busyAsk(to: string, result: SendResult): ToolResultLike {
    return toolText(
      `${result.delivered ? "Delivered" : "Queued"} ask to ${to}; peer is busy and not accepting blocking asks (peer_busy). Not waiting for a reply; delivery does not mean the question was consumed.`,
      {
        messageId: result.id,
        accepted: result.accepted,
        delivered: result.delivered,
        queued: result.queued === true,
        replied: false,
        reason: "peer_busy",
        reasonCode: "recipient_not_accepting_asks",
        nextActions: [
          {
            action: "send",
            guidance:
              "Use default-steered send for non-blocking live coordination; queue only when delay is intentional.",
          },
        ],
      },
    );
  }
  private askReply(to: string, reply: Message, questionId: string): ToolResultLike {
    const text = reply.content.text;
    this.owners.pi.appendEntry("intercom_received", {
      from: to,
      message: { text, attachments: reply.content.attachments },
      messageId: reply.id,
      timestamp: reply.timestamp,
    });
    if (
      reply.content.attachments?.some(
        (attachment) => attachment.name === RECIPIENT_TURN_FAILED_ATTACHMENT,
      ) === true
    ) {
      return toolError(
        text,
        failureDetails(
          "recipient_turn_failed",
          [
            { action: "status" },
            { action: "send", guidance: "Send recovery context after the recipient is healthy." },
          ],
          { error: true, recipientTurnFailed: true, messageId: reply.id, replyTo: questionId },
        ),
      );
    }
    const attachments = reply.content.attachments;
    return toolText(
      `**Reply from ${to}:**\n${text}${attachments !== undefined && attachments.length > 0 ? formatAttachments(attachments) : ""}`,
    );
  }
  private askFailure(error: unknown, to: string, questionId: string | undefined): ToolResultLike {
    if (error instanceof AskDeliveryError) {
      const result = this.deliveryFailure(to, error.result);
      return { ...result, details: { ...result.details, error: true } };
    }
    const text = errorMessage(error);
    let reason = "ask_failed";
    if (text.startsWith("No reply from")) {
      reason = "reply_timeout";
    } else if (text.startsWith("Target ")) {
      reason = "ambiguous_target";
    }
    return toolError(
      `Failed: ${text}`,
      failureDetails(
        reason,
        [
          { action: "status" },
          { action: "list" },
          {
            action: "send",
            guidance: "Check the recipient before retrying; the original ask may still be seen.",
          },
        ],
        {
          error: true,
          ...(questionId !== undefined && questionId !== "" ? { messageId: questionId } : {}),
        },
      ),
    );
  }
  private isCancelled(signal: AbortSignal | undefined): boolean {
    return signal?.aborted === true;
  }
  private cancelled(signal: AbortSignal | undefined): void {
    if (signal?.aborted === true) {
      throw new Error("Cancelled");
    }
  }
  private async sendBusy(
    active: IntercomTransport,
    request: {
      readonly target: string;
      readonly to: string;
      readonly questionId: string;
      readonly options: ReturnType<typeof sendOptions>;
      readonly record: (result: SendResult) => void;
    },
  ): Promise<ToolResultLike> {
    const result = await active.send(request.target, {
      ...request.options,
      messageId: request.questionId,
      expectsReply: true,
    });
    if (!result.accepted) {
      throw new AskDeliveryError(result);
    }
    this.markActivity();
    request.record(result);
    return this.busyAsk(request.to, result);
  }
  async ask(
    active: IntercomTransport,
    params: IntercomToolParams,
    signal: AbortSignal | undefined,
  ): Promise<ToolResultLike> {
    const to = this.messageTarget(params);
    if (to === undefined) {
      return toolError("Missing 'to' or 'message' parameter");
    }
    if (this.owners.wait.waiting) {
      return toolError("Already waiting for a reply");
    }
    if (this.isCancelled(signal)) {
      return toolError("Cancelled");
    }
    let questionId: string | undefined;
    try {
      const target = (await resolveConnectedTarget(active, to)) ?? to;
      this.cancelled(signal);
      if (target === active.sessionId) {
        return toolError("Cannot message the current session");
      }
      const health = await resolvePeerHealth(active, target);
      this.cancelled(signal);
      questionId = randomUUID();
      const options = sendOptions(params);
      const record = (result: SendResult) => {
        this.recordSent(to, options, result);
        this.owners.connection.syncStatus();
      };
      if (health?.acceptsAsks === false && options.delivery === undefined) {
        return await this.sendBusy(active, { target, to, questionId, options, record });
      }
      const reply = await this.owners.wait.transact(active, {
        to: target,
        questionId,
        options,
        signal,
        onSent: record,
      });
      return this.askReply(to, reply, questionId);
    } catch (error) {
      return this.askFailure(error, to, questionId);
    }
  }
  async reply(active: IntercomTransport, params: IntercomToolParams): Promise<ToolResultLike> {
    const { to, replyTo, attachments } = params;
    const body = params.message ?? "";
    if (body === "") {
      return toolError("Missing 'message' parameter");
    }
    try {
      const target = this.owners.replies.resolveReplyTarget({ to, replyTo });
      if (target.from.id === active.sessionId) {
        return toolError("Cannot message the current session");
      }
      const result = await active.send(target.from.id, {
        text: body,
        attachments,
        replyTo: target.message.id,
      });
      const sender = target.from.name ?? target.from.id;
      if (!result.accepted) {
        return toolError(
          `Reply to "${sender}" was not delivered: ${result.reason ?? "Session may not exist or has disconnected."}`,
          failureDetails(
            "delivery_failed",
            [
              { action: "pending" },
              {
                action: "send",
                guidance: "Send a new message if the original sender is no longer available.",
              },
            ],
            {
              messageId: result.id,
              accepted: result.accepted,
              delivered: false,
              queued: result.queued === true,
              reason: result.reason,
              replyTo: target.message.id,
            },
          ),
        );
      }
      this.owners.replies.markReplied(target.message.id);
      this.markActivity();
      this.recordSent(sender, { text: body, replyTo: target.message.id }, result);
      return toolText(`Reply sent to ${sender}`, {
        messageId: result.id,
        delivered: true,
        replyTo: target.message.id,
        reasonCode: "reply_sent",
      });
    } catch (error) {
      return this.replyFailure(error, replyTo);
    }
  }
  private replyFailure(error: unknown, replyTo: string | undefined): ToolResultLike {
    const text = errorMessage(error);
    const reason = replyFailureReason(text);
    const actions: readonly RecoveryAction[] =
      reason === "no_pending_reply"
        ? [
            { action: "pending" },
            {
              action: "send",
              guidance:
                "Use send with an explicit recipient when there is no inbound ask to reply to.",
            },
          ]
        : [{ action: "pending" }, { action: "list" }];
    return toolError(
      `Failed to reply: ${text}`,
      failureDetails(reason, actions, {
        error: true,
        ...((replyTo ?? "") !== "" ? { replyTo } : {}),
      }),
    );
  }
}
