import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSanitizedAssistantError } from "./message-format.ts";
import {
  isLastMessageQuery,
  LAST_MESSAGE_PAGE_LIMIT,
  type LastMessageQuery,
  type LastMessageResult,
  type SessionInfo,
} from "./types.ts";
import { safeLabel } from "./validation.ts";

export type NativeHistory = Pick<ExtensionContext["sessionManager"], "getBranch">;
type BranchEntry = ReturnType<NativeHistory["getBranch"]>[number];

function completedResponse(
  entries: readonly BranchEntry[],
  entryId?: string,
): { readonly id: string; readonly text: string } | undefined {
  for (const entry of entries) {
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
  }
  return;
}

function latestTurnFailure(
  entries: readonly BranchEntry[],
  pinnedId?: string,
  afterId?: string,
): { readonly entryId: string; readonly error: string } | undefined {
  if (pinnedId !== undefined) {
    return;
  }
  const latest = entries.find(
    (entry) => entry.type === "message" && entry.message.role === "assistant",
  );
  if (!latest || latest.id === afterId || latest.type !== "message" || !safeLabel(latest.id)) {
    return;
  }
  const error = getSanitizedAssistantError(latest.message);
  return error === undefined ? undefined : { entryId: latest.id, error };
}
/** Reads finalized native history only; no model invocation or synthesized response. */
export function readLastMessage(
  manager: NativeHistory,
  session: SessionInfo,
  query: LastMessageQuery,
): LastMessageResult {
  const offset = query.offset ?? 0;
  const limit = query.limit ?? LAST_MESSAGE_PAGE_LIMIT;
  if (!isLastMessageQuery({ offset, limit })) {
    return {
      error: "Invalid last response page: offset must be non-negative and limit must be 1–16384.",
    };
  }
  const entries = manager.getBranch().toReversed();
  const response = completedResponse(entries, query.entryId);
  const latestTurnError = latestTurnFailure(entries, query.entryId, response?.id);
  const errorMeta = latestTurnError ? { latestTurnError } : {};
  if (!response) {
    return query.entryId !== undefined
      ? { error: "Requested completed assistant response is not on the active session branch." }
      : { session, entryId: null, text: "", offset: 0, totalLength: 0, ...errorMeta };
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
    ...errorMeta,
  };
}
