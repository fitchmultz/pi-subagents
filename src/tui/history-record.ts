import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  JsonObject,
  JsonValue,
  ToolCall,
  ToolResultMessage,
  TextContent,
  ThinkingContent,
} from "@earendil-works/pi-ai";
import { Type, Check } from "../shared/native-typebox.ts";
import { isRecord } from "./history-text.ts";

/** A native message handle, not an indexed partial observation. */
export type HistoryNativeMessage = AgentMessage;
export interface HistoryAssistantPreview {
  readonly role: "assistant";
  readonly content: readonly (TextContent | ThinkingContent | ToolCall)[];
  readonly provider?: string;
  readonly model?: string;
  readonly stopReason?: string;
  readonly errorMessage?: string;
}
export type DisplayEntry = { readonly id: string; readonly timestamp: string } & (
  | {
      readonly type: "message";
      readonly message:
        | HistoryNativeMessage
        | HistoryAssistantPreview
        | { readonly role: "user"; readonly content: unknown };
      readonly native?: HistoryNativeMessage;
    }
  | {
      readonly type: "custom_message";
      readonly customType: string;
      readonly content: unknown;
      readonly details?: unknown;
    }
  | { readonly type: "compaction" | "branch_summary"; readonly summary: string }
);
const text = Type.Object({
  type: Type.Literal("text"),
  text: Type.String(),
  textSignature: Type.Optional(Type.String()),
});
const thinking = Type.Object({
  type: Type.Literal("thinking"),
  thinking: Type.String(),
  thinkingSignature: Type.Optional(Type.String()),
  redacted: Type.Optional(Type.Boolean()),
});
const image = Type.Object({
  type: Type.Literal("image"),
  data: Type.String(),
  mimeType: Type.String(),
});
const cost = Type.Object({
  input: Type.Number(),
  output: Type.Number(),
  cacheRead: Type.Number(),
  cacheWrite: Type.Number(),
  total: Type.Number(),
});
const usage = Type.Object({
  input: Type.Number(),
  output: Type.Number(),
  cacheRead: Type.Number(),
  cacheWrite: Type.Number(),
  totalTokens: Type.Number(),
  cost,
  cacheWrite1h: Type.Optional(Type.Number()),
  reasoning: Type.Optional(Type.Number()),
});
const assistantFields = Type.Object({
  role: Type.Literal("assistant"),
  api: Type.String(),
  provider: Type.String(),
  model: Type.String(),
  timestamp: Type.Number(),
  usage,
  stopReason: Type.Union(
    ["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"].map((value) =>
      Type.Literal(value),
    ),
  ),
  errorMessage: Type.Optional(Type.String()),
});

function isJson(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every((part: unknown) => isJson(part));
  }
  return isJsonObject(value);
}
function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value) && Object.values(value).every(isJson);
}
export function toolCall(value: unknown): ToolCall | undefined {
  if (
    !isRecord(value) ||
    value.type !== "toolCall" ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    !isJsonObject(value.arguments)
  ) {
    return;
  }
  return {
    type: "toolCall",
    id: value.id,
    name: value.name,
    arguments: { ...value.arguments },
    thoughtSignature:
      typeof value.thoughtSignature === "string" ? value.thoughtSignature : undefined,
    namespace: typeof value.namespace === "string" ? value.namespace : undefined,
  };
}
function assistant(value: Readonly<Record<string, unknown>>): AssistantMessage | undefined {
  const rawContent = value.content;
  if (!Check(assistantFields, value) || !Array.isArray(rawContent)) {
    return;
  }
  const content: AssistantMessage["content"] = [];
  for (const part of rawContent) {
    if (Check(text, part)) {
      content.push({ ...part });
    } else if (Check(thinking, part)) {
      content.push({ ...part });
    } else {
      const call = toolCall(part);
      if (!call) {
        return;
      }
      content.push(call);
    }
  }
  const stopReason = value.stopReason;
  if (!isStopReason(stopReason)) {
    return;
  }
  return {
    role: "assistant",
    api: value.api,
    provider: value.provider,
    model: value.model,
    timestamp: value.timestamp,
    usage: { ...value.usage, cost: { ...value.usage.cost } },
    stopReason,
    content,
    errorMessage: value.errorMessage,
  };
}
function isStopReason(value: string): value is AssistantMessage["stopReason"] {
  return (
    value === "pending" ||
    value === "stop" ||
    value === "length" ||
    value === "toolUse" ||
    value === "error" ||
    value === "aborted" ||
    value === "deferred"
  );
}
function toolResult(value: Readonly<Record<string, unknown>>): ToolResultMessage | undefined {
  if (
    typeof value.toolCallId !== "string" ||
    typeof value.toolName !== "string" ||
    typeof value.isError !== "boolean" ||
    typeof value.timestamp !== "number" ||
    !Array.isArray(value.content)
  ) {
    return;
  }
  const content: ToolResultMessage["content"] = [];
  for (const part of value.content) {
    if (Check(text, part)) {
      content.push({ ...part });
    } else if (Check(image, part)) {
      content.push({ ...part });
    } else {
      return;
    }
  }
  if (value.details !== undefined && !isJson(value.details)) {
    return;
  }
  return {
    role: "toolResult",
    toolCallId: value.toolCallId,
    toolName: value.toolName,
    isError: value.isError,
    timestamp: value.timestamp,
    content,
    details: value.details,
  };
}
function assistantPreview(
  value: Readonly<Record<string, unknown>>,
): HistoryAssistantPreview | undefined {
  if (!Array.isArray(value.content)) {
    return;
  }
  const content: Array<TextContent | ThinkingContent | ToolCall> = [];
  for (const part of value.content) {
    if (Check(text, part) || Check(thinking, part)) {
      content.push({ ...part });
    } else {
      const call = toolCall(part);
      if (call) {
        content.push(call);
      }
    }
  }
  return {
    role: "assistant",
    content,
    model: typeof value.model === "string" ? value.model : undefined,
    provider: typeof value.provider === "string" ? value.provider : undefined,
    stopReason: typeof value.stopReason === "string" ? value.stopReason : undefined,
    errorMessage: typeof value.errorMessage === "string" ? value.errorMessage : undefined,
  };
}
function observedMessage(
  value: unknown,
): Extract<DisplayEntry, { type: "message" }>["message"] | undefined {
  if (!isRecord(value)) {
    return;
  }
  if (value.role === "assistant") {
    return assistant(value) ?? assistantPreview(value);
  }
  if (value.role === "toolResult") {
    return toolResult(value);
  }
  if (value.role === "user") {
    return { role: "user", content: value.content };
  }
  if (
    value.role === "bashExecution" &&
    typeof value.command === "string" &&
    typeof value.output === "string"
  ) {
    return {
      role: "bashExecution",
      command: value.command,
      output: value.output,
      exitCode: typeof value.exitCode === "number" ? value.exitCode : undefined,
      cancelled: value.cancelled === true,
      truncated: value.truncated === true,
      timestamp: typeof value.timestamp === "number" ? value.timestamp : 0,
    };
  }
  return;
}

/** Validate only display facts; an indexed observation is never invented owner/session metadata. */
export function displayEntry(value: unknown): DisplayEntry | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.timestamp !== "string") {
    return;
  }
  const base = { id: value.id, timestamp: value.timestamp };
  if (value.type === "message") {
    const message = observedMessage(value.message);
    const native =
      isRecord(value.message) && value.message.role === "assistant"
        ? assistant(value.message)
        : undefined;
    return message ? { ...base, type: "message", message, native } : undefined;
  }
  if (value.type === "custom_message" && typeof value.customType === "string") {
    return {
      ...base,
      type: "custom_message",
      customType: value.customType,
      content: value.content,
      details: value.details,
    };
  }
  if (
    (value.type === "compaction" || value.type === "branch_summary") &&
    typeof value.summary === "string"
  ) {
    return { ...base, type: value.type, summary: value.summary };
  }
  return;
}
