import type { ObservedMessage } from "../../shared/types/messages.ts";
import { createMutationCompletionTracker } from "./mutating-tool-guard.ts";

export type CompletionPolicy = "none" | "mutation-guard" | "acceptance-contract";

export function resolveCompletionPolicy(input: {
  readonly completionGuardEnabled: boolean;
  readonly usesAcceptanceContract: boolean;
}): CompletionPolicy {
  if (input.usesAcceptanceContract) {
    return "acceptance-contract";
  }
  return input.completionGuardEnabled ? "mutation-guard" : "none";
}

function recordAssistantCalls(
  message: Extract<ObservedMessage, { role: "assistant" }>,
  tracker: ReturnType<typeof createMutationCompletionTracker>,
): void {
  for (const part of message.content) {
    if (part.type === "toolCall") {
      tracker.recordToolStart({
        id: part.id,
        toolName: part.name,
        args: part.arguments,
      });
    }
  }
}

export function hasCompletedMutationToolCall(messages: readonly ObservedMessage[]): boolean {
  const tracker = createMutationCompletionTracker();
  for (const message of messages) {
    if (message.role === "assistant") {
      recordAssistantCalls(message, tracker);
    } else if (
      message.role === "toolResult" &&
      tracker.recordToolResult(message)?.completedMutation === true
    ) {
      return true;
    }
  }
  return false;
}
