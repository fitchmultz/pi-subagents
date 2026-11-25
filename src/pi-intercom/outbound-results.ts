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

function outboundError(
  message: string,
  reasonCode: string,
  actions: readonly RecoveryAction[],
  details: Readonly<Record<string, unknown>>,
): ToolResultLike {
  const hint = actions
    .map(({ action, guidance }) => guidance ?? `Run \`intercom\` with \`action: "${action}"\`.`)
    .join(" ");
  return toolError(`${message}\n${hint}`, failureDetails(reasonCode, actions, details));
}

/** What `send`, `ask` and `reply` answer, for a local target and for one on another device. */
export function sendFailure(error: unknown, progress: SendProgress): ToolResultLike {
  const facts = sendErrorFacts(error, progress);
  return outboundError(
    `Failed to send: ${errorMessage(error)}`,
    recoveryCode(error, "send_failed"),
    [{ action: "list" }, { action: "send", guidance: sendRecoveryGuidance(facts, "message") }],
    { error: true, ...facts },
  );
}
export function deliveryFailure(to: string, result: SendResult): ToolResultLike {
  return outboundError(
    `Message to "${to}" was not delivered: ${result.reason ?? "Session may not exist or has disconnected."}`,
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
  );
}
export function sendHint(params: IntercomToolParams): string {
  if (params.replyTo !== undefined && params.replyTo !== "") {
    return "";
  }
  return " (wakes idle recipients and steers active recipients at the next tool boundary)";
}
export function askFailure(
  error: unknown,
  input: { readonly to: string; readonly questionId?: string; readonly progress: SendProgress },
): ToolResultLike {
  const { to, questionId, progress } = input;
  if (error instanceof WakeFailedError) {
    return outboundError(
      `The parked child could not be woken: ${error.message} Your ask is still queued and may arrive after a later wake. Check the recipient before sending it again.`,
      "wake_failed",
      [{ action: "list" }, { action: "status" }],
      {
        error: true,
        messageId: questionId,
        accepted: true,
        delivered: false,
        queued: true,
      },
    );
  }
  if (error instanceof AskDeliveryError) {
    const result = deliveryFailure(to, error.result);
    return { ...result, details: { ...result.details, error: true } };
  }
  const facts = sendErrorFacts(error, progress);
  return outboundError(
    `Failed: ${errorMessage(error)}`,
    recoveryCode(error, "ask_failed"),
    [
      { action: "status" },
      { action: "list" },
      { action: "send", guidance: sendRecoveryGuidance(facts, "ask") },
    ],
    {
      error: true,
      ...(questionId !== undefined && questionId !== "" ? { messageId: questionId } : {}),
      ...facts,
    },
  );
}
export function replySent(sender: string, replyTo: string, result: SendResult): ToolResultLike {
  const queued = result.queued === true;
  const base = queued
    ? `Reply queued for ${sender} (${result.reason ?? "queued"})`
    : `Reply sent to ${sender}`;
  return toolText(base, {
    messageId: result.id,
    accepted: result.accepted,
    delivered: result.delivered,
    queued,
    replyTo,
    reasonCode: queued ? "message_queued" : "reply_sent",
  });
}

export function replyDeliveryFailure(
  sender: string,
  replyTo: string,
  result: SendResult,
): ToolResultLike {
  return outboundError(
    `Reply to "${sender}" was not delivered: ${result.reason ?? "Session may not exist or has disconnected."}`,
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
      replyTo,
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
  return outboundError(`Failed to reply: ${errorMessage(error)}`, reason, actions, {
    error: true,
    ...((replyTo ?? "") !== "" ? { replyTo } : {}),
    ...sendErrorFacts(error, progress),
  });
}
