import { isMessage, isSessionRegistration, type Message } from "./types.ts";
import type {
  InboundCheckpoint,
  InboundMessageEntry,
  PendingInboundMessage,
  SubagentCompletion,
  RequestedDelivery,
} from "./runtime-types.ts";
import { isRecord, isUnknownArray } from "./validation.ts";
export function requestedDelivery(message: Message): RequestedDelivery {
  if (message.passive === true || message.delivery === "passive") {
    return "passive";
  }
  return message.delivery ?? (message.expectsReply === true ? "auto" : "steer");
}
export function isReplaceableProgress(message: Message): boolean {
  return (
    message.delivery === "queue" &&
    message.queueMode === "replace" &&
    (message.threadId ?? "") !== "" &&
    message.expectsReply !== true &&
    message.replyTo === undefined
  );
}
export function needsIntercom(entry: Pick<InboundMessageEntry, "from" | "message">): boolean {
  return (
    entry.message.human === undefined &&
    requestedDelivery(entry.message) !== "passive" &&
    entry.from.id !== "subagent-result" &&
    entry.from.id !== "subagent-control"
  );
}
export function isBlockingSupervisorMessage(entry: InboundMessageEntry): boolean {
  if (entry.message.expectsReply !== true) {
    return false;
  }
  const text = entry.bodyText.trimStart();
  return (
    text.startsWith("Subagent needs a supervisor decision.") ||
    text.startsWith("Subagent requests a structured supervisor interview.")
  );
}
export function isCompletedChild(value: unknown): value is SubagentCompletion["children"][number] {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.agent === "string" &&
    typeof value.index === "number" &&
    Number.isSafeInteger(value.index) &&
    value.index >= 0 &&
    typeof value.intercomTarget === "string" &&
    value.intercomTarget.length > 0 &&
    typeof value.status === "string" &&
    ["completed", "failed", "blocked", "paused", "timed-out", "detached"].includes(value.status)
  );
}
function isCompletion(
  value: unknown,
): value is SubagentCompletion & { readonly ownerSessionId: string } {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.runId === "string" &&
    typeof value.status === "string" &&
    typeof value.ownerSessionId === "string" &&
    (value.completionId === undefined || typeof value.completionId === "string") &&
    isUnknownArray(value.children) &&
    value.children.every(isCompletedChild)
  );
}
export function isInboundEntry(value: unknown): value is InboundMessageEntry {
  if (!isRecord(value) || !isRecord(value.from) || typeof value.from.id !== "string") {
    return false;
  }
  return (
    isSessionRegistration(value.from) &&
    isMessage(value.message) &&
    typeof value.bodyText === "string" &&
    (value.replyCommand === undefined || typeof value.replyCommand === "string") &&
    (value.subagentCompletion === undefined || isCompletion(value.subagentCompletion))
  );
}
function isPendingInbound(value: unknown): value is PendingInboundMessage {
  if (!isRecord(value)) {
    return false;
  }
  const stage = value.stage === "queued" || value.stage === "native";
  const flush =
    value.flushDelivery === "auto" ||
    value.flushDelivery === "passive" ||
    value.flushDelivery === "steer";
  return stage && flush && typeof value.receivedAt === "number" && isInboundEntry(value);
}
export function isInboundCheckpoint(
  value: unknown,
): value is InboundCheckpoint & { readonly sessionId: string } {
  if (!isRecord(value) || typeof value.sessionId !== "string") {
    return false;
  }
  if ("entry" in value) {
    return isPendingInbound(value.entry);
  }
  return (
    typeof value.messageId === "string" &&
    (value.stage === "queued" ||
      value.stage === "native" ||
      value.stage === "discarded" ||
      value.stage === "reply-retired")
  );
}
