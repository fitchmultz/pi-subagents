import { stripTerminalSequences } from "@earendil-works/pi-tui";
export function readableText(value: unknown): string {
  if (typeof value === "string") {
    return stripTerminalSequences(value);
  }
  // JSON.stringify can return undefined for omitted native values despite its declared string result.
  const serialized: unknown = JSON.stringify(value, null, 2);
  return stripTerminalSequences(typeof serialized === "string" ? serialized : "");
}
export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function contentText(content: unknown): string {
  if (!Array.isArray(content)) {
    return readableText(content);
  }
  return content
    .map((part: unknown) => {
      if (!isRecord(part)) {
        return "";
      }
      if (part.type === "text") {
        return readableText(part.text);
      }
      if (part.type === "thinking") {
        return readableText(part.thinking);
      }
      return part.type === "image"
        ? `[Image: ${typeof part.mimeType === "string" ? part.mimeType : "image"}]`
        : "";
    })
    .filter(Boolean)
    .join("\n");
}
