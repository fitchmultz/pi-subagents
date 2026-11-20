import type { SendResult } from "./types.ts";
import type { IntercomToolParams, ToolResultLike } from "./runtime-types.ts";
import type { ChildContractAmendmentResult } from "../shared/child-contract.ts";
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
  return " (wakes idle recipients and steers active recipients at the next tool boundary)";
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
function runLabel(amended: ChildContractAmendmentResult): string {
  return amended.name === undefined ? amended.runId : `${amended.runId} (${amended.name})`;
}

function amendmentDetails(
  amended: ChildContractAmendmentResult,
): Readonly<Record<string, unknown>> {
  return {
    contractAmended: {
      runId: amended.runId,
      changedFields: amended.amendment.changedFields,
      contract: amended.amendment.contract,
      summary: amended.summary,
    },
  };
}

export function replySent(
  sender: string,
  replyTo: string,
  result: SendResult,
  amended?: ChildContractAmendmentResult,
): ToolResultLike {
  const queued = result.queued === true;
  const base = queued
    ? `Reply queued for ${sender} (${result.reason ?? "queued"})`
    : `Reply sent to ${sender}`;
  const suffix =
    amended === undefined
      ? ""
      : `\nDelegation contract amended for run ${runLabel(amended)}: ${amended.summary}`;
  return toolText(`${base}${suffix}`, {
    messageId: result.id,
    accepted: result.accepted,
    delivered: result.delivered,
    queued,
    replyTo,
    reasonCode: queued ? "message_queued" : "reply_sent",
    ...(amended !== undefined ? amendmentDetails(amended) : {}),
  });
}

export function replyDeliveryFailure(
  sender: string,
  replyTo: string,
  result: SendResult,
  amended?: ChildContractAmendmentResult,
): ToolResultLike {
  const suffix =
    amended === undefined
      ? ""
      : ` Delegation contract amendment was persisted for run ${runLabel(amended)}: ${amended.summary}.`;
  return toolError(
    `Reply to "${sender}" was not delivered: ${result.reason ?? "Session may not exist or has disconnected."}${suffix}`,
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
        replyTo,
        ...(amended !== undefined ? amendmentDetails(amended) : {}),
      },
    ),
  );
}
export function replyFailure(
  error: unknown,
  replyTo: string | undefined,
  progress: SendProgress,
  amended?: ChildContractAmendmentResult,
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
  const suffix =
    amended === undefined
      ? ""
      : ` Delegation contract amendment was persisted for run ${runLabel(amended)}: ${amended.summary}.`;
  return toolError(
    `Failed to reply: ${errorMessage(error)}${suffix}`,
    failureDetails(reason, actions, {
      error: true,
      ...((replyTo ?? "") !== "" ? { replyTo } : {}),
      ...sendErrorFacts(error, progress),
      ...(amended !== undefined ? amendmentDetails(amended) : {}),
    }),
  );
}
