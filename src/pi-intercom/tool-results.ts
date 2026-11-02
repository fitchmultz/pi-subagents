import type { SendResult } from "./types.ts";
import type { ToolResultLike } from "./runtime-types.ts";
type RecoveryCode =
  | "ambiguous_target"
  | "reply_timeout"
  | "no_pending_reply"
  | "ambiguous_reply_target";
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
export class RecoveryError extends Error {
  readonly code: RecoveryCode;
  constructor(code: RecoveryCode, message: string) {
    super(message);
    this.code = code;
  }
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
  readonly details?: Readonly<Record<string, unknown>> | undefined;
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
export class WakeFailedError extends Error {}
export function throwIfToolError(result: ToolResultLike): ToolResultLike {
  if (result.isError !== true) {
    return result;
  }
  const text = firstTextContent(result);
  throw new ToolExecutionFailure(text === "" ? "Tool failed" : text, result.details);
}
