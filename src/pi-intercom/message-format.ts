import type { Attachment, Message } from "./types.ts";
import { isRecord } from "./validation.ts";

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
export function previewText(value: unknown, maxLength = 72): string | undefined {
  if (typeof value !== "string") {
    return;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized === "") {
    return;
  }
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}
export function pendingAskPreview(message: Message): string {
  return previewText(message.content.text, 180) ?? message.content.text;
}
