import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LastMessageQuery, LastMessageResult, SessionInfo } from "./types.ts";

export type NativeHistory = Pick<ExtensionContext["sessionManager"], "getLeafId" | "getEntry">;
function validPage(offset: number, limit: number): boolean {
  return (
    Number.isSafeInteger(offset) &&
    offset >= 0 &&
    Number.isSafeInteger(limit) &&
    limit >= 1 &&
    limit <= 16384
  );
}
function completedResponse(
  manager: NativeHistory,
  entryId?: string,
): { readonly id: string; readonly text: string } | undefined {
  let id = manager.getLeafId();
  while (id !== null) {
    const entry = manager.getEntry(id);
    if (!entry) {
      throw new Error("Native session history is unavailable.");
    }
    if (
      entry.type === "message" &&
      entry.message.role === "assistant" &&
      (entry.message.stopReason === "stop" || entry.message.stopReason === "length") &&
      (entryId === undefined || entry.id === entryId)
    ) {
      return {
        id: entry.id,
        text: entry.message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n"),
      };
    }
    id = entry.parentId;
  }
  return;
}
/** Reads finalized native history only; no model invocation or synthesized response. */
export function readLastMessage(
  manager: NativeHistory,
  session: SessionInfo,
  query: LastMessageQuery,
): LastMessageResult {
  const offset = query.offset ?? 0;
  const limit = query.limit ?? 16384;
  if (!validPage(offset, limit)) {
    return {
      error: "Invalid last response page: offset must be non-negative and limit must be 1–16384.",
    };
  }
  const response = completedResponse(manager, query.entryId);
  if (!response) {
    return query.entryId !== undefined
      ? { error: "Requested completed assistant response is not on the active session branch." }
      : { session, entryId: null, text: "", offset: 0, totalLength: 0 };
  }
  if (offset > response.text.length) {
    return { error: "Last response offset exceeds its length." };
  }
  const end = Math.min(response.text.length, offset + limit);
  return {
    session,
    entryId: response.id,
    text: response.text.slice(offset, end),
    offset,
    totalLength: response.text.length,
    ...(end < response.text.length ? { nextOffset: end } : {}),
  };
}
