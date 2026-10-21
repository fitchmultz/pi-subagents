import { isMessage, isSessionRegistration, type Message, type MessageDelivery } from "./types.ts";
import type {
  InboundCheckpoint,
  InboundMessageEntry,
  PendingInboundMessage,
} from "./runtime-types.ts";
import { finiteNumber, isRecord } from "./validation.ts";
export function requestedDelivery(message: Message): MessageDelivery {
  if (message.passive === true || message.delivery === "passive") {
    return "passive";
  }
  return message.delivery ?? "steer";
}
function isLocalJournalMessage(value: unknown): value is Message {
  if (!isRecord(value) || !isRecord(value.content)) {
    return false;
  }
  // Local result/control messages keep arbitrary output text, unlike broker trust-boundary input.
  // localEntry writes only these required fields; reject malformed optional protocol metadata.
  return (
    typeof value.id === "string" &&
    finiteNumber(value.timestamp) &&
    typeof value.content.text === "string" &&
    value.content.attachments === undefined &&
    [
      "replyTo",
      "expectsReply",
      "human",
      "topic",
      "delivery",
      "queueMode",
      "threadId",
      "passive",
    ].every((key) => value[key] === undefined)
  );
}
function isJournalMessage(value: unknown, sender: string): value is Message {
  return sender === "subagent-result" || sender === "subagent-control"
    ? isLocalJournalMessage(value)
    : isMessage(value);
}
export function isInboundEntry(value: unknown): value is InboundMessageEntry {
  if (!isRecord(value) || !isRecord(value.from) || typeof value.from.id !== "string") {
    return false;
  }
  const sender = value.from.id;
  return (
    isSessionRegistration(value.from) &&
    isJournalMessage(value.message, sender) &&
    typeof value.bodyText === "string" &&
    (value.replyCommand === undefined || typeof value.replyCommand === "string")
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
