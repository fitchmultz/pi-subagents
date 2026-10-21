import type { Projection } from "./json-projection.ts";
import { isUnknownArray, recordAt, type UnknownRecord } from "./unknown.ts";

const entryFields = new Set([
  "type",
  "id",
  "parentId",
  "timestamp",
  "version",
  "cwd",
  "parentSession",
  "checkpoint",
  "provider",
  "model",
  "modelId",
  "thinkingLevel",
  "customType",
  "usage",
  "firstKeptEntryId",
  "fromId",
]);
const messageFields = new Set([
  "role",
  "provider",
  "model",
  "responseModel",
  "thinkingLevel",
  "usage",
  "stopReason",
  "errorMessage",
  "timestamp",
  "toolCallId",
  "toolName",
  "isError",
  "content",
  "command",
  "output",
  "exitCode",
  "cancelled",
]);
function argumentCount(root: UnknownRecord | undefined, index: number): number {
  const content = recordAt(root, "message")?.content;
  const part = isUnknownArray(content) ? content[index] : undefined;
  return Object.keys(recordAt(part, "arguments") ?? {}).length;
}
function contentProjection(
  path: readonly (string | number)[],
  root?: UnknownRecord,
): boolean | number {
  if (path.length <= 3) {
    return 2048;
  }
  if (path[3] !== "arguments") {
    return ["type", "id", "name", "text", "thinking", "mimeType"].includes(String(path[3]))
      ? 2048
      : false;
  }
  if (path.length === 4) {
    return true;
  }
  if (path.length === 5) {
    return argumentCount(root, Number(path[2])) < 32 ? 2048 : false;
  }
  return path.length === 6 && path[5] === 0 ? 2048 : false;
}
/** Metadata/previews, never unrelated custom data, image bytes or raw tool details. */
function messageProjection(
  path: readonly (string | number)[],
  root?: UnknownRecord,
): boolean | number {
  if (path.length === 1) {
    return true;
  }
  if (!messageFields.has(String(path[1]))) {
    return false;
  }
  if (path[1] === "content") {
    return contentProjection(path, root);
  }
  return path[1] === "usage" ? true : 4096;
}
export const nativeProjection: Projection = (path, root) => {
  if (path.length === 0) {
    return true;
  }
  if (path[0] === "message") {
    return messageProjection(path, root);
  }
  if (path[0] === "summary" || path[0] === "content") {
    return 2048;
  }
  if (path[0] === "details") {
    return path.length === 1 || ["bodyText", "message", "from"].includes(String(path[1]))
      ? 2048
      : false;
  }
  return entryFields.has(String(path[0])) ? 4096 : false;
};
