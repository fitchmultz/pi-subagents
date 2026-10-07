import type {
  ObservedContent,
  ObservedMessage,
  ObservedUsage,
} from "../../shared/types/messages.ts";
import { isRecord as isObject } from "../../shared/unknown.ts";

export function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "string") {
    throw new SyntaxError(`Invalid ${label}`);
  }
  return value;
}

export function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "number") {
    throw new SyntaxError(`Invalid ${label}`);
  }
  return value;
}

export function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "boolean") {
    throw new SyntaxError(`Invalid ${label}`);
  }
  return value;
}

export function requiredString(value: unknown, label: string): string {
  const text = optionalString(value, label);
  if (text === undefined) {
    throw new SyntaxError(`Missing ${label}`);
  }
  return text;
}

function isObservedUsage(value: unknown): value is ObservedUsage {
  if (!isObject(value)) {
    return false;
  }
  for (const key of [
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "totalTokens",
    "reasoning",
    "cacheWrite1h",
  ]) {
    optionalNumber(value[key], `usage.${key}`);
  }
  if (value.cost !== undefined) {
    if (!isObject(value.cost)) {
      return false;
    }
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"]) {
      optionalNumber(value.cost[key], `cost.${key}`);
    }
  }
  return true;
}
export function observedUsage(value: unknown): ObservedUsage | undefined {
  if (value === undefined) {
    return;
  }
  if (!isObservedUsage(value)) {
    throw new SyntaxError("Invalid native usage");
  }
  return value;
}

function observedContent(value: unknown): ObservedContent {
  if (!isObject(value)) {
    throw new SyntaxError("Invalid native message content");
  }
  switch (value.type) {
    case "text":
      return {
        ...value,
        type: "text",
        text: requiredString(value.text, "content.text"),
        textSignature: optionalString(value.textSignature, "textSignature"),
      };
    case "thinking":
      return {
        ...value,
        type: "thinking",
        thinking: optionalString(value.thinking, "content.thinking") ?? "",
        thinkingSignature: optionalString(value.thinkingSignature, "thinkingSignature"),
      };
    case "image":
      return {
        ...value,
        type: "image",
        data: optionalString(value.data, "image.data") ?? "",
        mimeType: requiredString(value.mimeType, "image.mimeType"),
      };
    case "toolCall":
      if (!isObject(value.arguments)) {
        throw new SyntaxError("Invalid tool call arguments");
      }
      return {
        ...value,
        type: "toolCall",
        id: requiredString(value.id, "toolCall.id"),
        name: requiredString(value.name, "toolCall.name"),
        arguments: value.arguments,
      };
    default:
      throw new SyntaxError("Unsupported native message content");
  }
}

function contentArray(value: unknown): ObservedContent[] {
  if (!Array.isArray(value)) {
    throw new SyntaxError("Invalid native message content array");
  }
  return value.map((part: unknown) => observedContent(part));
}

function assistant(value: Readonly<Record<string, unknown>>): ObservedMessage {
  return {
    ...value,
    role: "assistant",
    content: contentArray(value.content),
    timestamp: optionalNumber(value.timestamp, "timestamp"),
    api: optionalString(value.api, "api"),
    provider: optionalString(value.provider, "provider"),
    model: optionalString(value.model, "model"),
    responseModel: optionalString(value.responseModel, "responseModel"),
    responseId: optionalString(value.responseId, "responseId"),
    usage: observedUsage(value.usage),
    stopReason: optionalString(value.stopReason, "stopReason"),
    errorMessage: optionalString(value.errorMessage, "errorMessage"),
  };
}

function otherMessage(
  value: Readonly<Record<string, unknown>>,
  timestamp: number | undefined,
): ObservedMessage {
  switch (value.role) {
    case "custom":
      return {
        ...value,
        role: "custom",
        timestamp,
        customType: requiredString(value.customType, "customType"),
        content: typeof value.content === "string" ? value.content : contentArray(value.content),
        display: optionalBoolean(value.display, "display"),
      };
    case "bashExecution":
      return {
        ...value,
        role: "bashExecution",
        timestamp,
        command: requiredString(value.command, "command"),
        output: requiredString(value.output, "output"),
        exitCode: optionalNumber(value.exitCode, "exitCode"),
        cancelled: optionalBoolean(value.cancelled, "cancelled"),
        truncated: optionalBoolean(value.truncated, "truncated"),
        fullOutputPath: optionalString(value.fullOutputPath, "fullOutputPath"),
        excludeFromContext: optionalBoolean(value.excludeFromContext, "excludeFromContext"),
      };
    case "branchSummary":
      return {
        ...value,
        role: "branchSummary",
        timestamp,
        summary: requiredString(value.summary, "summary"),
        fromId: value.fromId === null ? null : requiredString(value.fromId, "fromId"),
      };
    case "compactionSummary": {
      const tokensBefore = optionalNumber(value.tokensBefore, "tokensBefore");
      if (tokensBefore === undefined) {
        throw new SyntaxError("Missing tokensBefore");
      }
      return {
        ...value,
        role: "compactionSummary",
        timestamp,
        summary: requiredString(value.summary, "summary"),
        tokensBefore,
      };
    }
    default:
      throw new SyntaxError("Unsupported native message role");
  }
}

export function observedMessage(value: unknown): ObservedMessage {
  if (!isObject(value)) {
    throw new SyntaxError("Invalid native message");
  }
  if (value.role === "assistant") {
    return assistant(value);
  }
  const timestamp = optionalNumber(value.timestamp, "timestamp");
  if (value.role === "toolResult") {
    if (value.isError !== undefined && typeof value.isError !== "boolean") {
      throw new SyntaxError("Invalid tool result isError");
    }
    return {
      ...value,
      role: "toolResult",
      content: contentArray(value.content),
      timestamp,
      toolCallId: requiredString(value.toolCallId, "toolCallId"),
      toolName: requiredString(value.toolName, "toolName"),
      isError: value.isError,
      observedExitCode: optionalNumber(value.observedExitCode, "observedExitCode"),
      usage: observedUsage(value.usage),
    };
  }
  if (value.role === "user" || value.role === "system") {
    return {
      ...value,
      role: value.role,
      timestamp,
      content: typeof value.content === "string" ? value.content : contentArray(value.content),
    };
  }
  return otherMessage(value, timestamp);
}
