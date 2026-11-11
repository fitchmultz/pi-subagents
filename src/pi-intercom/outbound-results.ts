import type { SendResult } from "./types.ts";
import type { IntercomToolParams, ToolResultLike } from "./runtime-types.ts";
import { errorMessage } from "./validation.ts";
import {
  failureDetails,
  recoveryCode,
  sendErrorFacts,
  sendRecoveryGuidance,
  WakeFailedError,
  AskDeliveryError,
  type RecoveryAction,
  type SendProgress,
} from "./tool-results.ts";
import { toolError, toolText } from "./tool-arguments.ts";

/** What `send`, `ask` and `reply` answer, for a local target and for one on another device. */
export function sendFailure(error: unknown, progress: SendProgress): ToolResultLike {
  const facts = sendErrorFacts(error, progress);
  return toolError(
    `Failed to send: ${errorMessage(error)}`,
    failureDetails(
      recoveryCode(error, "send_failed"),
      [
        { action: "list" },
        {
          action: "send",
          guidance: sendRecoveryGuidance(facts, "message"),
        },
      ],
      { error: true, ...facts },
    ),
  );
}
export function deliveryFailure(to: string, result: SendResult): ToolResultLike {
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
export function sendHint(params: IntercomToolParams): string {
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
    default:
      return " (defaults to steer; wakes idle recipients and steers active recipients after the current tool call)";
  }
}
export function busyAsk(to: string, result: SendResult): ToolResultLike {
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
export function askFailure(
  error: unknown,
  input: { readonly to: string; readonly questionId?: string; readonly progress: SendProgress },
): ToolResultLike {
  const { to, questionId, progress } = input;
  if (error instanceof WakeFailedError) {
    return toolError(
      `The parked child could not be woken: ${error.message} Your ask is still queued and may arrive after a later wake. Check the recipient before sending it again.`,
      failureDetails("wake_failed", [{ action: "list" }, { action: "status" }], {
        error: true,
        messageId: questionId,
        accepted: true,
        delivered: false,
        queued: true,
      }),
    );
  }
  if (error instanceof AskDeliveryError) {
    const result = deliveryFailure(to, error.result);
    return { ...result, details: { ...result.details, error: true } };
  }
  const facts = sendErrorFacts(error, progress);
  return toolError(
    `Failed: ${errorMessage(error)}`,
    failureDetails(
      recoveryCode(error, "ask_failed"),
      [
        { action: "status" },
        { action: "list" },
        {
          action: "send",
          guidance: sendRecoveryGuidance(facts, "ask"),
        },
      ],
      {
        error: true,
        ...(questionId !== undefined && questionId !== "" ? { messageId: questionId } : {}),
        ...facts,
      },
    ),
  );
}
export function replySent(sender: string, replyTo: string, result: SendResult): ToolResultLike {
  const queued = result.queued === true;
  return toolText(
    queued
      ? `Reply queued for ${sender} (${result.reason ?? "queued"})`
      : `Reply sent to ${sender}`,
    {
      messageId: result.id,
      accepted: result.accepted,
      delivered: result.delivered,
      queued,
      replyTo,
      reasonCode: queued ? "message_queued" : "reply_sent",
    },
  );
}
export function replyFailure(
  error: unknown,
  replyTo: string | undefined,
  progress: SendProgress,
): ToolResultLike {
  const reason = recoveryCode(error, "reply_failed");
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
    `Failed to reply: ${errorMessage(error)}`,
    failureDetails(reason, actions, {
      error: true,
      ...((replyTo ?? "") !== "" ? { replyTo } : {}),
      ...sendErrorFacts(error, progress),
    }),
  );
}
