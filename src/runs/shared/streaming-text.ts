import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

type TextEvent = {
	type?: string;
	message?: { role: string };
	assistantMessageEvent?: Extract<JsonAgentSessionEvent, { type: "message_update" }>["assistantMessageEvent"];
};

/** Native JSON stdout sends text deltas, not cumulative message/partial snapshots. */
export function updateStreamingText(current: string | undefined, event: TextEvent): string | undefined {
	if (event.type === "agent_start" || event.type === "message_end" && event.message?.role === "assistant") return undefined;
	if (event.type === "message_start" && event.message?.role === "assistant") return "";
	if (event.type !== "message_update") return current;
	const update = event.assistantMessageEvent;
	if (update?.type === "text_start") return current ? `${current}\n\n` : "";
	if (update?.type === "text_delta") return (current ?? "") + update.delta;
	return current;
}
