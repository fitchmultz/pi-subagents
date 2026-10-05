import { stripTerminalSequences } from "@earendil-works/pi-tui";
export function readableText(value: unknown): string {
  return stripTerminalSequences(
    typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? ""),
  );
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
