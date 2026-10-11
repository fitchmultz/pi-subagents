import type { Projection } from "../shared/journal-reader.ts";
import { safeText } from "./store.ts";
import { at, object, objects, string } from "./values.ts";

const metadata = new Set([
  "type",
  "id",
  "parentId",
  "timestamp",
  "version",
  "cwd",
  "provider",
  "model",
  "modelId",
  "thinkingLevel",
  "customType",
  "display",
  "summary",
  "content",
]);
const messageFields = new Set([
  "role",
  "content",
  "output",
  "summary",
  "toolCallId",
  "toolName",
  "isError",
  "timestamp",
  "model",
  "provider",
  "stopReason",
  "errorMessage",
  "customType",
  "display",
  "command",
  "exitCode",
  "cancelled",
]);
export const previewLimits = { depth: 64, nodes: 16_384, arrayLength: 4096, keyLength: 512 };
function contentProjection(keys: readonly (string | number)[], root: unknown): boolean | number {
  if (keys.length <= 3) {
    return 512;
  }
  if (keys[3] !== "arguments") {
    return keys.length === 4 &&
      ["type", "text", "thinking", "id", "name", "mimeType"].includes(String(keys[3]))
      ? 512
      : false;
  }
  if (keys.length === 4) {
    return true;
  }
  if (keys.length === 5) {
    return Object.keys(object(at(root, ["message", "content", Number(keys[2]), "arguments"])))
      .length < 32
      ? 512
      : false;
  }
  return keys.length === 6 && keys[5] === 0 ? 512 : false;
}
function messageProjection(keys: readonly (string | number)[], root: unknown): boolean | number {
  if (keys.length === 1) {
    return true;
  }
  if (!messageFields.has(String(keys[1]))) {
    return false;
  }
  if (keys[1] === "content") {
    return contentProjection(keys, root);
  }
  return keys.length === 2 ? 512 : false;
}
function detailsProjection(keys: readonly (string | number)[]): boolean | number {
  const selected =
    keys.length === 1 ||
    (keys.length === 2 && ["bodyText", "message"].includes(String(keys[1]))) ||
    (keys.length === 3 && keys[1] === "message" && keys[2] === "id");
  return selected ? 512 : false;
}
function rootContentProjection(keys: readonly (string | number)[]): boolean | number {
  const selected =
    keys.length <= 2 ||
    (keys.length === 3 && ["type", "text", "mimeType"].includes(String(keys[2])));
  return selected ? 512 : false;
}
export const previewProjection: Projection = (keys, root) => {
  if (keys.length === 0) {
    return true;
  }
  switch (keys[0]) {
    case "message":
      return messageProjection(keys, root);
    case "details":
      return detailsProjection(keys);
    case "content":
      return rootContentProjection(keys);
    default:
      return keys.length === 1 && metadata.has(String(keys[0])) ? 512 : false;
  }
};
export function candidate(keys: readonly (string | number)[]): boolean {
  switch (keys[0]) {
    case "summary":
      return keys.length === 1;
    case "details":
      return keys.length === 2 && keys[1] === "bodyText";
    case "content":
      return keys.length === 1 || (keys.length === 3 && keys[2] === "text");
    case "message":
      return messageCandidate(keys);
    default:
      return false;
  }
}
function messageCandidate(keys: readonly (string | number)[]): boolean {
  return (
    (keys.length === 2 && ["content", "output", "summary"].includes(String(keys[1]))) ||
    (keys[1] === "content" && keys.length === 4 && keys[3] === "text")
  );
}
function customAllowed(
  value: Readonly<Record<string, unknown>>,
  keys: readonly unknown[],
): boolean {
  if (value.display === false) {
    return false;
  }
  if (keys[0] === "details") {
    return value.customType === "subagent-human-message";
  }
  if (
    value.customType === "subagent-human-message" &&
    typeof object(value.details).bodyText === "string"
  ) {
    return false;
  }
  return (
    keys[0] === "content" &&
    (keys.length === 1 || object(at(value.content, [Number(keys[1])])).type === "text")
  );
}
export function allowed(value: Readonly<Record<string, unknown>>, field: string): boolean {
  const parsed: unknown = JSON.parse(field);
  if (!Array.isArray(parsed)) {
    return false;
  }
  const keys: readonly unknown[] = parsed;
  if (value.type === "custom_message") {
    return customAllowed(value, keys);
  }
  if (value.type === "compaction" || value.type === "branch_summary") {
    return keys.length === 1 && keys[0] === "summary";
  }
  return (
    value.type === "message" && keys[0] === "message" && messageAllowed(object(value.message), keys)
  );
}
function messageAllowed(
  message: Readonly<Record<string, unknown>>,
  keys: readonly unknown[],
): boolean {
  if (message.role === "compactionSummary" || message.role === "branchSummary") {
    return keys[1] === "summary";
  }
  if (message.role === "bashExecution") {
    return keys[1] === "output";
  }
  if (!["user", "assistant", "toolResult", "custom"].includes(string(message.role) ?? "")) {
    return false;
  }
  if (message.role === "custom" && message.display === false) {
    return false;
  }
  return (
    keys[1] === "content" &&
    (keys.length === 2 || object(at(message.content, [Number(keys[2])])).type === "text")
  );
}
export function compactEntry(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  let remaining = 4096;
  const clean = (input: unknown, key = ""): unknown => {
    if (typeof input === "string") {
      const identityField = [
        "id",
        "parentId",
        "type",
        "role",
        "toolCallId",
        "name",
        "toolName",
        "timestamp",
      ].includes(key);
      const text = safeText(input, identityField ? 512 : Math.min(512, remaining));
      remaining -= Math.min(remaining, text.length);
      return text;
    }
    if (Array.isArray(input)) {
      const items: readonly unknown[] = input;
      return items.slice(0, 32).map((item) => clean(item));
    }
    if (typeof input === "object" && input !== null) {
      return Object.fromEntries(
        Object.entries(input).map(([name, item]) => [name, clean(item, name)]),
      );
    }
    return input;
  };
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item, key)]));
}
export function visibleId(value: Readonly<Record<string, unknown>>, id: string): string | null {
  if (["custom_message", "compaction", "branch_summary"].includes(string(value.type) ?? "")) {
    return id;
  }
  if (value.type !== "message") {
    return null;
  }
  const message = object(value.message);
  if (["user", "toolResult", "bashExecution"].includes(string(message.role) ?? "")) {
    return id;
  }
  if (message.role !== "assistant") {
    return null;
  }
  const last = objects(message.content).findLastIndex(
    (part) =>
      part.type === "toolCall" ||
      (part.type === "text" && typeof part.text === "string" && part.text.length > 0) ||
      (part.type === "thinking" && typeof part.thinking === "string" && part.thinking.length > 0),
  );
  if (typeof message.errorMessage === "string" && message.errorMessage.length > 0) {
    return `${id}:error`;
  }
  return last < 0 ? null : `${id}:${last}`;
}
