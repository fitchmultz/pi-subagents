import { nativeProjection, type Projection } from "../../shared/journal-reader.ts";
import { isObject } from "./child-json.ts";

type JsonPath = readonly (string | number)[];
export function projectedMessage(root: unknown): Readonly<Record<string, unknown>> | undefined {
  return isObject(root) && isObject(root.message) ? root.message : undefined;
}
export function projectedPart(
  root: unknown,
  index: string | number | undefined,
): Readonly<Record<string, unknown>> | undefined {
  const message = projectedMessage(root);
  const content: unknown = message?.content;
  if (!Array.isArray(content)) {
    return;
  }
  const part: unknown = content.at(Number(index));
  return isObject(part) ? part : undefined;
}

function messageProjection(
  keys: JsonPath,
  root: Readonly<Record<string, unknown>> | undefined,
): boolean | number {
  if (
    keys.length > 1 &&
    ![
      "role",
      "timestamp",
      "provider",
      "model",
      "responseModel",
      "usage",
      "stopReason",
      "errorMessage",
      "toolCallId",
      "toolName",
      "isError",
      "content",
      "details",
      "customType",
      "display",
      "command",
      "output",
      "exitCode",
      "cancelled",
      "truncated",
      "fullOutputPath",
      "excludeFromContext",
      "summary",
      "fromId",
      "tokensBefore",
    ].includes(String(keys[1]))
  ) {
    return false;
  }
  if (["summary", "output"].includes(String(keys[1]))) {
    return 4096;
  }
  if (keys[1] === "details") {
    return keys.length === 2 || ["preview", "modifiedFiles"].includes(String(keys[2]))
      ? 4096
      : false;
  }
  return keys[1] === "content" ? messageContentProjection(keys, root) : true;
}
function messageContentProjection(
  keys: JsonPath,
  root: Readonly<Record<string, unknown>> | undefined,
): boolean | number {
  if (root?.type !== "message_end") {
    return false;
  }
  if (keys.length === 2) {
    return 4096;
  }
  return contentProjection(keys, root);
}

function contentProjection(
  keys: JsonPath,
  root: Readonly<Record<string, unknown>> | undefined,
): boolean | number {
  if (keys.length <= 3) {
    return true;
  }
  if (keys[3] === "thinking" || keys[3] === "data") {
    return false;
  }
  if (keys[3] === "text") {
    return projectedMessage(root)?.role === "assistant" ? true : 4096;
  }
  if (keys[3] === "arguments") {
    return projectedPart(root, keys[2])?.name === "structured_output"
      ? true
      : nativeProjection(keys, root);
  }
  return true;
}

export const liveProjection: Projection = (keys, root) => {
  if (keys.length === 0) {
    return true;
  }
  switch (keys[0]) {
    case "messages":
    case "toolResults":
      return false;
    case "entry":
      return keys.length === 1 ||
        [
          "id",
          "type",
          "parentId",
          "timestamp",
          "customType",
          "usage",
          "provider",
          "model",
        ].includes(String(keys[1]))
        ? 4096
        : false;
    case "assistantMessageEvent":
      return keys.length === 1 || ["type", "delta", "contentIndex"].includes(String(keys[1]))
        ? 8192
        : false;
    case "result":
      return root?.type === "result";
    case "message":
      return messageProjection(keys, root);
    default:
      return true;
  }
};

export function liveKeyLimit(keys: JsonPath): number {
  // Explicit tool/schema arguments must fit their consumers; lifecycle aggregates are skipped.
  return keys[0] === "args" || keys[0] === "structured_output" || keys.includes("arguments")
    ? Infinity
    : 4096;
}

export function claudeProjection(keys: JsonPath): boolean {
  return (
    keys.length === 0 ||
    [
      "type",
      "subtype",
      "is_error",
      "api_error_status",
      "result",
      "stop_reason",
      "session_id",
      "total_cost_usd",
      "usage",
      "modelUsage",
      "structured_output",
    ].includes(String(keys[0]))
  );
}
