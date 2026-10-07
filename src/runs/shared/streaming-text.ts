import type { ReadonlyInput } from "../../shared/types.ts";

type TextEvent = {
  readonly type?: string;
  readonly message?: { readonly role: string };
  readonly assistantMessageEvent?: {
    readonly type: string;
    readonly delta?: string;
    readonly contentIndex?: number;
  };
};

function applyTextDelta(
  current: string | undefined,
  update: ReadonlyInput<TextEvent["assistantMessageEvent"]>,
): string | undefined {
  if (update?.type === "text_start") {
    return current !== undefined && current.length > 0 ? `${current}\n\n` : "";
  }
  if (update?.type === "text_delta" && update.delta !== undefined) {
    return ((current ?? "") + update.delta).slice(-8192);
  }
  return current;
}

/** Native JSON stdout sends text deltas, not cumulative message/partial snapshots. */
export function updateStreamingText(
  current: string | undefined,
  event: ReadonlyInput<TextEvent>,
): string | undefined {
  if (event.type === "agent_start") {
    return;
  }
  if (event.message?.role === "assistant") {
    if (event.type === "message_end") {
      return;
    }
    if (event.type === "message_start") {
      return "";
    }
  }
  return event.type === "message_update"
    ? applyTextDelta(current, event.assistantMessageEvent)
    : current;
}
