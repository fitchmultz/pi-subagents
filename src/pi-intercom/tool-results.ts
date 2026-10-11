import type { SendResult } from "./types.ts";
import type { ToolResultLike } from "./runtime-types.ts";
export interface RecoveryAction {
  readonly action: "list" | "pending" | "send" | "status";
  readonly guidance?: string;
}
export function failureDetails(
  reasonCode: string,
  nextActions: readonly RecoveryAction[],
  details: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return { ...details, reasonCode, nextActions };
}
export function replyFailureReason(
  message: string,
): "no_pending_reply" | "ambiguous_reply_target" | "reply_failed" {
  if (message.startsWith("No active intercom context") || message.startsWith("No pending ask")) {
    return "no_pending_reply";
  }
  if (message.startsWith("Multiple pending asks") || message.includes("too short")) {
    return "ambiguous_reply_target";
  }
  return "reply_failed";
}
export function firstTextContent(result: {
  readonly content?: readonly { readonly type: string; readonly text?: string }[];
}): string {
  return (
    result.content
      ?.find((item) => item.type === "text" && typeof item.text === "string")
      ?.text?.replace(/\*\*/g, "") ?? ""
  );
}
export class ToolExecutionFailure extends Error {
  readonly details?: Readonly<Record<string, unknown>>;
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.details = details;
  }
}
export class AskDeliveryError extends Error {
  readonly result: SendResult;
  constructor(result: SendResult) {
    super(result.reason ?? "Session may not exist or has disconnected.");
    this.result = result;
  }
}
export function throwIfToolError(result: ToolResultLike): ToolResultLike {
  if (result.isError !== true) {
    return result;
  }
  const text = firstTextContent(result);
  throw new ToolExecutionFailure(text === "" ? "Tool failed" : text, result.details);
}
