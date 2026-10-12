import { stripAcceptanceReport } from "../runs/shared/acceptance-reports.ts";
import type { AgentHistory, AgentHistoryItem } from "./history-display.ts";
import { readableText } from "./history-text.ts";
export { readableText } from "./history-text.ts";
export { indexedHistory } from "./indexed-history.ts";
export type { AgentHistory, AgentHistoryItem } from "./history-display.ts";

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
