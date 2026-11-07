import type { SendResult } from "./types.ts";
import type { ToolResultLike } from "./runtime-types.ts";
import { SendError } from "./broker/client-send.ts";

export type SendProgress =
  | { readonly kind: SendError["outcome"]["kind"] }
  | { readonly kind: "acknowledged"; readonly result: SendResult };
type SendErrorFacts =
  | { readonly deliveryUnknown: true; readonly messageId?: string }
  | {
      readonly deliveryUnknown: false;
      readonly messageId?: string;
      readonly accepted: false;
      readonly delivered: false;
    }
  | ({
      readonly deliveryUnknown: false;
      readonly messageId: string;
      readonly queued: boolean;
    } & Pick<SendResult, "accepted" | "delivered">);

export function sendErrorFacts(error: unknown, progress: SendProgress): SendErrorFacts {
  if (progress.kind === "acknowledged") {
    const { id, accepted, delivered, queued } = progress.result;
    return { deliveryUnknown: false, messageId: id, accepted, delivered, queued: queued === true };
  }
  const kind = error instanceof SendError ? error.outcome.kind : progress.kind;
  const identity = error instanceof SendError ? { messageId: error.outcome.messageId } : {};
  return kind === "not-sent"
    ? { ...identity, deliveryUnknown: false, accepted: false, delivered: false }
    : { ...identity, deliveryUnknown: true };
}
export function sendRecoveryGuidance(facts: SendErrorFacts, noun: "message" | "ask"): string {
  if (facts.deliveryUnknown) {
    return `Check the recipient before retrying; the original ${noun} may still arrive.`;
  }
  return facts.accepted
    ? `The original ${noun} was accepted. Check the recipient before sending it again.`
    : "Retry with an exact active recipient target.";
}

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
