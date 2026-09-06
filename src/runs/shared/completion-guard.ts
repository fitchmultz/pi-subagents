import type { Message } from "@earendil-works/pi-ai";
import { createMutationCompletionTracker } from "./mutating-tool-guard.ts";

export type CompletionPolicy = "none" | "mutation-guard" | "acceptance-contract";

export function resolveCompletionPolicy(input: {
	completionGuardEnabled: boolean;
	usesAcceptanceContract: boolean;
}): CompletionPolicy {
	if (input.usesAcceptanceContract) return "acceptance-contract";
	return input.completionGuardEnabled ? "mutation-guard" : "none";
}

export function hasCompletedMutationToolCall(messages: Message[]): boolean {
	const mutations = createMutationCompletionTracker();
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type !== "toolCall") continue;
				const args = typeof part.arguments === "object" && part.arguments !== null && !Array.isArray(part.arguments)
					? part.arguments as Record<string, unknown>
					: {};
				mutations.recordToolStart({
					id: typeof part.id === "string" ? part.id : undefined,
					toolName: typeof part.name === "string" ? part.name : undefined,
					args,
				});
			}
			continue;
		}
		if (message.role !== "toolResult") continue;
		if (mutations.recordToolResult(message as { toolCallId?: unknown; toolName?: unknown; isError?: unknown })?.completedMutation) return true;
	}
	return false;
}
