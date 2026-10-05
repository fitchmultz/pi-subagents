import type {
  AssistantMessage,
  JsonObject,
  JsonValue,
  Message,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@earendil-works/pi-ai";
import type { ReadonlyInput } from "../../src/shared/types/inputs.ts";

/** Complete native messages for tests that exercise transcript consumers. */
export function assistant(
  content: readonly (TextContent | ThinkingContent | ToolCall)[],
): AssistantMessage {
  return {
    role: "assistant",
    content: [...content],
    api: "openai-completions",
    provider: "fixture",
    model: "fixture",
    timestamp: 0,
    stopReason: "stop",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

export function toolCall(name: string, args: ReadonlyInput<JsonObject> = {}, id = ""): Message {
  // Empty IDs intentionally exercise the legacy FIFO fallback rather than ID matching.
  return assistant([{ type: "toolCall", id, name, arguments: { ...args } }]);
}

export function toolResult(
  textValue: string,
  isError = false,
  toolCallId = "",
  toolName = "",
  details?: ReadonlyInput<JsonValue>,
): Message {
  return {
    role: "toolResult",
    content: [{ type: "text", text: textValue }],
    isError,
    toolCallId,
    toolName,
    timestamp: 0,
    ...(details === undefined ? {} : { details }),
  };
}
