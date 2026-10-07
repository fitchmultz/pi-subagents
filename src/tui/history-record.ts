import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  ToolCall,
  ToolResultMessage,
  TextContent,
  ThinkingContent,
} from "@earendil-works/pi-ai";
import { Type, Check } from "../shared/native-typebox.ts";
import { isRecord } from "./history-text.ts";
import { isJson, isJsonObject } from "./history-json.ts";
import {
  assistantMetadata,
  nativeUsage,
  nativeNestedCalls,
  usageSchema,
} from "./history-metadata.ts";

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
const assistantFields = Type.Object({
  role: Type.Literal("assistant"),
  api: Type.String(),
  provider: Type.String(),
  model: Type.String(),
  timestamp: Type.Number(),
  usage: usageSchema,
  stopReason: Type.Union(
    ["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"].map((value) =>
      Type.Literal(value),
    ),
  ),
  errorMessage: Type.Optional(Type.String()),
});

type RecordMode = "preview" | "full";
const toolCallFields = Type.Object({
  type: Type.Literal("toolCall"),
  id: Type.String(),
  name: Type.String(),
  arguments: Type.Unknown(),
  thoughtSignature: Type.Optional(Type.String()),
  namespace: Type.Optional(Type.String()),
});
export function toolCall(value: unknown): ToolCall | undefined {
  if (!Check(toolCallFields, value) || !isJsonObject(value.arguments)) {
    return;
  }
  return {
    type: "toolCall",
    id: value.id,
    name: value.name,
    arguments: { ...value.arguments },
    ...("thoughtSignature" in value ? { thoughtSignature: value.thoughtSignature } : {}),
    ...("namespace" in value ? { namespace: value.namespace } : {}),
  };
}
function assistant(value: Readonly<Record<string, unknown>>): AssistantMessage | undefined {
  const rawContent = value.content,
    metadata = assistantMetadata(value);
  if (!metadata || !Check(assistantFields, value) || !Array.isArray(rawContent)) {
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
    ...metadata,
    role: "assistant",
    api: value.api,
    provider: value.provider,
    model: value.model,
    timestamp: value.timestamp,
    usage: { ...value.usage, cost: { ...value.usage.cost } },
    stopReason,
    content,
    ...("errorMessage" in value ? { errorMessage: value.errorMessage } : {}),
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
function toolMetadata(
  value: Readonly<Record<string, unknown>>,
): Pick<ToolResultMessage, "usage" | "nestedCalls"> | undefined {
  const usage = nativeUsage(value.usage),
    nestedCalls = nativeNestedCalls(value.nestedCalls);
  if ((value.usage !== undefined && !usage) || (value.nestedCalls !== undefined && !nestedCalls)) {
    return;
  }
  return {
    ...("usage" in value ? { usage } : {}),
    ...("nestedCalls" in value ? { nestedCalls } : {}),
  };
}
const toolResultFields = Type.Object({
  toolCallId: Type.String(),
  toolName: Type.String(),
  isError: Type.Boolean(),
  timestamp: Type.Number(),
});
function toolResultContent(
  value: unknown,
  mode: RecordMode,
): ToolResultMessage["content"] | undefined {
  if (!Array.isArray(value)) {
    return;
  }
  const content: ToolResultMessage["content"] = [];
  for (const part of value) {
    if (Check(text, part) || Check(image, part)) {
      content.push({ ...part });
    } else if (
      mode === "preview" &&
      isRecord(part) &&
      part.type === "image" &&
      part.data === undefined &&
      typeof part.mimeType === "string"
    ) {
      // Indexed previews omit image bytes; only preview cards may use this display adapter.
      content.push({ type: "image", data: "", mimeType: part.mimeType });
    } else {
      return;
    }
  }
  return content;
}
function toolResult(
  value: Readonly<Record<string, unknown>>,
  mode: RecordMode,
): ToolResultMessage | undefined {
  const content = toolResultContent(value.content, mode),
    details = value.details;
  const metadata = toolMetadata(value);
  if (!metadata) {
    return;
  }
  if (!Check(toolResultFields, value)) {
    return;
  }
  if (!content || (details !== undefined && !isJson(details))) {
    return;
  }
  return {
    ...metadata,
    role: "toolResult",
    toolCallId: value.toolCallId,
    toolName: value.toolName,
    isError: value.isError,
    timestamp: value.timestamp,
    content,
    ...("details" in value ? { details } : {}),
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
function bashMessage(
  value: Readonly<Record<string, unknown>>,
): Extract<HistoryNativeMessage, { role: "bashExecution" }> | undefined {
  if (typeof value.command !== "string" || typeof value.output !== "string") {
    return;
  }
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
function observedMessage(
  value: unknown,
  mode: RecordMode,
): Pick<Extract<DisplayEntry, { type: "message" }>, "message" | "native"> | undefined {
  if (!isRecord(value)) {
    return;
  }
  switch (value.role) {
    case "assistant": {
      const native = assistant(value);
      const message = native ?? (mode === "preview" ? assistantPreview(value) : undefined);
      return message ? { message, ...(native ? { native } : {}) } : undefined;
    }
    case "toolResult": {
      const message = toolResult(value, mode);
      return message ? { message } : undefined;
    }
    case "user":
      return { message: { role: "user", content: value.content } };
    case "bashExecution": {
      const message = bashMessage(value);
      return message ? { message } : undefined;
    }
    default:
      return;
  }
}
function messageEntry(
  value: Readonly<Record<string, unknown>>,
  base: { readonly id: string; readonly timestamp: string },
  mode: RecordMode,
): DisplayEntry | undefined {
  const observed = observedMessage(value.message, mode);
  return observed ? { ...base, type: "message", ...observed } : undefined;
}
/** Validate only display facts; an indexed observation is never invented owner/session metadata. */
export function displayEntry(value: unknown, mode: RecordMode): DisplayEntry | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.timestamp !== "string") {
    return;
  }
  const base = { id: value.id, timestamp: value.timestamp };
  if (value.type === "message") {
    return messageEntry(value, base, mode);
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
