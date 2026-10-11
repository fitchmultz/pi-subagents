import { formatToolCall } from "./formatters.ts";
import type {
  DisplayItem,
  ErrorInfo,
  ObservedMessage,
  ReadonlySingleResult,
  SingleResult,
  ToolCallSummary,
} from "./types.ts";

type AssistantObservation = Extract<ObservedMessage, { role: "assistant" }>;
type ToolObservation = Extract<ObservedMessage, { role: "toolResult" }>;
function assistantText(message: AssistantObservation): string {
  if (
    (message.errorMessage !== undefined && message.errorMessage.length > 0) ||
    message.stopReason === "error"
  ) {
    return "";
  }
  for (let j = message.content.length - 1; j >= 0; j--) {
    const part = message.content[j];
    if (part.type === "text" && part.text.trim().length > 0) {
      return part.text;
    }
  }
  return "";
}
/** Last non-error assistant text, accepting honest incomplete native observations. */
export function getFinalOutput(messages: readonly ObservedMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "assistant") {
      const text = assistantText(message);
      if (text !== "") {
        return text;
      }
    }
  }
  return "";
}
export function getSingleResultOutput(
  result: Readonly<Pick<SingleResult, "finalOutput" | "messages">>,
): string {
  return result.finalOutput ?? getFinalOutput(result.messages ?? []);
}
export function formatResourceLimitExceeded(input: {
  readonly agent: string;
  readonly kind: "maxExecutionTimeMs" | "maxTokens";
  readonly limit: number;
  readonly observed?: number;
}): string {
  if (input.kind === "maxExecutionTimeMs") {
    return `Resource limit exceeded for ${input.agent}: maxExecutionTimeMs ${input.limit}ms.`;
  }
  return `Resource limit exceeded for ${input.agent}: maxTokens ${input.limit}${input.observed !== undefined ? ` (observed ${input.observed})` : ""}.`;
}
function assistantItems(message: AssistantObservation): DisplayItem[] {
  return message.content.flatMap((part): DisplayItem[] => {
    if (part.type === "text") {
      return [{ type: "text", text: part.text }];
    }
    return part.type === "toolCall"
      ? [{ type: "tool", name: part.name, args: part.arguments }]
      : [];
  });
}
export function getDisplayItems(messages: readonly ObservedMessage[] | undefined): DisplayItem[] {
  return (messages ?? []).flatMap((message) =>
    message.role === "assistant" ? assistantItems(message) : [],
  );
}
function extractToolCallSummaries(
  messages: readonly ObservedMessage[] | undefined,
): ToolCallSummary[] {
  return (messages ?? []).flatMap((message) => {
    if (message.role !== "assistant") {
      return [];
    }
    return message.content.flatMap((part) =>
      part.type === "toolCall"
        ? [
            {
              text: formatToolCall(part.name, part.arguments),
              expandedText: formatToolCall(part.name, part.arguments, true),
            },
          ]
        : [],
    );
  });
}
export function compactForegroundResult(result: ReadonlySingleResult): ReadonlySingleResult {
  if (result.progress?.status === "running") {
    return result;
  }
  const toolCalls =
    result.toolCalls !== undefined && result.toolCalls.length > 0
      ? result.toolCalls
      : extractToolCallSummaries(result.messages);
  return {
    ...result,
    messages: undefined,
    progress: undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}
function lastAssistantText(messages: readonly ObservedMessage[]): number {
  return messages.findLastIndex(
    (message) =>
      message.role === "assistant" &&
      message.content.some((part) => part.type === "text" && part.text.trim().length > 0),
  );
}
function toolExitCode(message: ToolObservation, text: string | undefined): number | undefined {
  const match = text?.match(/exit(?:ed)?\s*(?:with\s*)?(?:code|status)?\s*[:\s]?\s*(\d+)/i);
  return message.observedExitCode ?? (match ? parseInt(match[1], 10) : undefined);
}
function toolError(message: ToolObservation): ErrorInfo | undefined {
  const text = message.content.find((part) => part.type === "text")?.text;
  const code = toolExitCode(message, text);
  if (message.isError === true) {
    return {
      hasError: true,
      exitCode: code ?? 1,
      errorType: message.toolName !== "" ? message.toolName : "tool",
      details: text?.slice(0, 200),
    };
  }
  if (message.toolName === "bash" && text !== undefined && code !== undefined && code !== 0) {
    return { hasError: true, exitCode: code, errorType: "bash", details: text.slice(0, 200) };
  }
  return undefined;
}
/** Errors superseded by later assistant success do not fail the result. */
export function detectSubagentError(messages: readonly ObservedMessage[]): ErrorInfo {
  const start = lastAssistantText(messages) + 1;
  for (let i = messages.length - 1; i >= start; i--) {
    const message = messages[i];
    if (message.role === "toolResult") {
      const error = toolError(message);
      if (error) {
        return error;
      }
    }
  }
  return { hasError: false };
}
