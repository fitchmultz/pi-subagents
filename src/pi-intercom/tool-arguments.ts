import type { IntercomToolParams, ToolResultLike } from "./runtime-types.ts";
import { failureDetails } from "./tool-results.ts";
export function toolError(
  text: string,
  details: Readonly<Record<string, unknown>> = { error: true },
): ToolResultLike {
  return { content: [{ type: "text", text }], isError: true, details };
}
export function toolText(
  text: string,
  details: Readonly<Record<string, unknown>> = {},
): ToolResultLike {
  return { content: [{ type: "text", text }], isError: false, details };
}
function deliveryError(params: IntercomToolParams): ToolResultLike | undefined {
  const { action, delivery, passive } = params;
  if (passive !== undefined && action !== "send") {
    return toolError("'passive' is only valid for action='send'");
  }
  if (delivery === "passive" && action !== "send") {
    return toolError(
      "delivery='passive' is only valid for action='send'. Passive delivery is for human-visible breadcrumbs and is discouraged for agent-to-agent coordination; normal send defaults to steer. Use ask with delivery='steer' only when the sender must stay alive and cannot safely continue without the reply.",
    );
  }
  const actionError = deliveryActionError(params);
  if (actionError) {
    return actionError;
  }
  if (passive === true && delivery !== undefined && delivery !== "passive") {
    return toolError("'passive' cannot be combined with a non-passive delivery mode");
  }
  return;
}
function deliveryActionError(params: IntercomToolParams): ToolResultLike | undefined {
  const { action, delivery, queueMode, threadId } = params;
  if (
    (delivery !== undefined || queueMode !== undefined || threadId !== undefined) &&
    action !== "send" &&
    action !== "ask"
  ) {
    const queue = queueMode !== undefined || delivery === "queue" || threadId !== undefined;
    return toolError(
      "'delivery', 'queueMode', and 'threadId' are only valid for action='send' or action='ask'",
      failureDetails(
        queue ? "invalid_queue_arguments" : "invalid_delivery_arguments",
        [{ action: "send", guidance: "Use delivery options only with send or ask." }],
        { error: true },
      ),
    );
  }
  return;
}
function queueError(params: IntercomToolParams): ToolResultLike | undefined {
  const { threadId, queueMode } = params;
  if (threadId !== undefined && queueMode !== "replace") {
    return toolError(
      "'threadId' is only valid with queueMode='replace'",
      failureDetails(
        "invalid_queue_arguments",
        [
          {
            action: "send",
            guidance: "Use threadId only with delivery='queue' and queueMode='replace'.",
          },
        ],
        { error: true },
      ),
    );
  }
  if (queueMode === "replace" && (threadId === undefined || threadId.trim() === "")) {
    return toolError(
      "queueMode='replace' requires a non-empty threadId",
      failureDetails(
        "invalid_queue_arguments",
        [
          {
            action: "send",
            guidance: "Provide a non-empty threadId with delivery='queue' and queueMode='replace'.",
          },
        ],
        { error: true },
      ),
    );
  }
  const delivery = params.passive === true ? "passive" : params.delivery;
  if (queueMode !== undefined && delivery !== "queue") {
    return toolError(
      "'queueMode' is only valid with delivery='queue'. Use queue only for intentionally deferred work; otherwise omit queueMode and use default-steered send for live agent coordination. Avoid passive for agent-to-agent coordination.",
      failureDetails(
        "invalid_queue_arguments",
        [{ action: "send", guidance: "Set delivery='queue', or omit queueMode and threadId." }],
        { error: true },
      ),
    );
  }
  return;
}
export function validateIntercomArguments(params: IntercomToolParams): ToolResultLike | undefined {
  if (params.scope !== undefined && params.action !== "list" && params.action !== "status") {
    return toolError("'scope' is only valid for action='list' or action='status'");
  }
  return deliveryError(params) ?? queueError(params);
}
export function sendOptions(params: IntercomToolParams): {
  readonly text: string;
  readonly attachments: IntercomToolParams["attachments"];
  readonly replyTo: string | undefined;
  readonly delivery: IntercomToolParams["delivery"];
  readonly queueMode: IntercomToolParams["queueMode"];
  readonly threadId: string | undefined;
} {
  return {
    text: params.message ?? "",
    attachments: params.attachments,
    replyTo: params.replyTo,
    delivery: params.passive === true ? "passive" : params.delivery,
    queueMode: params.queueMode,
    threadId: params.threadId?.trim(),
  };
}
