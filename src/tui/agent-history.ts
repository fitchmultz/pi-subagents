import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { stripAcceptanceReport } from "../runs/shared/acceptance-reports.ts";
import { displayHistory, type AgentHistory, type AgentHistoryItem } from "./history-display.ts";
import type { DisplayEntry } from "./history-record.ts";
import { readableText } from "./history-text.ts";
export { readableText } from "./history-text.ts";
export { indexedHistory } from "./indexed-history.ts";
export type { AgentHistory, AgentHistoryItem } from "./history-display.ts";

/** Read native entries, not a compacted model context: earlier messages remain inspectable. */
export function historyItems(entries: readonly SessionEntry[]): AgentHistory {
  const visible: DisplayEntry[] = [];
  for (const entry of entries) {
    if (
      entry.type === "message" ||
      entry.type === "custom_message" ||
      entry.type === "compaction" ||
      entry.type === "branch_summary"
    ) {
      visible.push(entry.type === "message" ? { ...entry, native: entry.message } : entry);
    }
  }
  return displayHistory(visible);
}
function finalMatch(history: AgentHistory, text: string): string | undefined {
  if (history.finalId !== undefined) {
    return history.finalId;
  }
  if (history.findFinalResult) {
    return history.findFinalResult(text);
  }
  return history.items.findLast(
    (item) =>
      item.kind === "assistant" &&
      (stripAcceptanceReport(item.text).trim() === text ||
        item.assistant?.content.some(
          (part) =>
            part.type === "text" && stripAcceptanceReport(readableText(part.text)).trim() === text,
        ) === true),
  )?.id;
}
/** Canonical run output is already validated; never decode arbitrary tool JSON to find an answer. */
export function withFinalResult(
  history: AgentHistory,
  output: string,
  runId: string,
  timestamp: number,
): AgentHistory {
  const text = readableText(output).trim();
  if (text.length === 0) {
    return history;
  }
  const matched = finalMatch(history, text);
  const existing = history.items.some((item) => item.id === matched) ? matched : undefined;
  const id = `result:${runId}`;
  let items: readonly AgentHistoryItem[] | undefined;
  return {
    get items() {
      items ??=
        existing !== undefined
          ? history.items.map((item) =>
              item.id === existing
                ? { ...item, assistant: undefined, previewAssistant: undefined, text }
                : item,
            )
          : [...history.items, { id, kind: "assistant", title: "Saved result", text, timestamp }];
      return items;
    },
    entryIds: existing !== undefined ? history.entryIds : [...history.entryIds, id],
    finalId: existing ?? id,
    findFinalResult:
      existing !== undefined
        ? history.findFinalResult
        : (value) => (value === text ? id : history.findFinalResult?.(value)),
    deliveredMessages:
      existing !== undefined
        ? history.deliveredMessages
        : history.deliveredMessages &&
          new Map([...history.deliveredMessages.keys()].map((messageId) => [messageId, true])),
    configuration: history.configuration,
    get unavailable() {
      return history.unavailable;
    },
  };
}
