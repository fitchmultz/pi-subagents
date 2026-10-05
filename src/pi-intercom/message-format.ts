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
function metadataField(text: string, pattern: Readonly<RegExp>): string | undefined {
  return text.match(pattern)?.[1]?.trim();
}
function namedPreview(label: string, value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : `${label}=${value}`;
}
export function pendingAskPreview(message: Message): string {
  const text = message.content.text;
  const normalized = text.replace(/\s+/g, " ").trim();
  if (
    !text.startsWith("Subagent needs a supervisor decision.") &&
    !text.startsWith("Subagent requests a structured supervisor interview.")
  ) {
    return previewText(normalized, 180) ?? normalized;
  }
  const run = metadataField(text, /^Run:\s*(.+)$/m);
  const agent = metadataField(text, /^Agent:\s*(.+)$/m);
  const target = metadataField(text, /^Child intercom target:\s*(.+)$/m);
  const body = text
    .split(/\n\s*\n/)
    .slice(1)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return [
    text.startsWith("Subagent requests")
      ? "structured supervisor interview"
      : "supervisor decision",
    namedPreview("run", run),
    namedPreview("agent", agent),
    namedPreview("target", target),
    namedPreview("question", previewText(body, 180)),
  ]
    .filter((part) => part !== undefined)
    .join(" · ");
}
