import type { Attachment, Message } from "./types.ts";
import { isRecord, MAX_TURN_ERROR_LENGTH } from "./validation.ts";

export function formatAttachments(attachments: readonly Attachment[]): string {
  return attachments
    .map((att) =>
      att.language !== undefined && att.language !== ""
        ? `\n\n---\n📎 ${att.name}\n~~~${att.language}\n${att.content}\n~~~`
        : `\n\n---\n📎 ${att.name}\n${att.content}`,
    )
    .join("");
}
export function inboundIdFromCustomMessage(message: unknown): string | undefined {
  if (
    !isRecord(message) ||
    (message.customType !== "intercom_message" && message.customType !== "subagent-human-message")
  ) {
    return;
  }
  if (!isRecord(message.details) || !isRecord(message.details.message)) {
    return;
  }
  return typeof message.details.message.id === "string" ? message.details.message.id : undefined;
}
export function getAssistantErrorMessage(message: unknown): string | null {
  if (!isRecord(message) || message.role !== "assistant" || message.stopReason !== "error") {
    return null;
  }
  const error = typeof message.errorMessage === "string" ? message.errorMessage.trim() : "";
  return error === "" ? "assistant turn failed" : error;
}
export function getSanitizedAssistantError(message: unknown): string | undefined {
  const error = getAssistantErrorMessage(message);
  return error === null
    ? undefined
    : (previewText(error, MAX_TURN_ERROR_LENGTH) ?? "assistant turn failed");
}
export function previewText(value: unknown, maxLength = 72): string | undefined {
  if (typeof value !== "string") {
    return;
  }
  const normalized = value.replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, " ").trim();
  if (normalized === "") {
    return;
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  const head = normalized.slice(0, maxLength - 1);
  return `${head.isWellFormed() ? head : head.slice(0, -1)}…`;
}
export function pendingAskPreview(message: Message): string {
  return previewText(message.content.text, 180) ?? message.content.text;
}
