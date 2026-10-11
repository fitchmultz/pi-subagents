import type {
  HistoryIndexHandle,
  HistoryEntry,
  HistoryPage,
  HistoryPageInput,
} from "../shared/types.ts";
import { displayHistory, type AgentHistory, type AgentHistoryItem } from "./history-display.ts";
import { displayEntry, type DisplayEntry } from "./history-record.ts";
import { isRecord } from "./history-text.ts";

function inBoundary(entry: HistoryEntry, page: HistoryPage, input: HistoryPageInput): boolean {
  return (
    (page.terminalSequence === undefined || entry.sequence <= page.terminalSequence) &&
    (input.endedAt === undefined || (entry.timestamp ?? Infinity) <= input.endedAt)
  );
}
function toolPairs(entry: HistoryEntry): Array<{ toolCallId: string; kind: "call" | "result" }> {
  const message = entry.entry.message;
  if (!isRecord(message)) {
    return [];
  }
  if (message.role === "toolResult" && typeof message.toolCallId === "string") {
    return [{ toolCallId: message.toolCallId, kind: "call" }];
  }
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return [];
  }
  return message.content.flatMap((part: unknown) =>
    isRecord(part) && part.type === "toolCall" && typeof part.id === "string"
      ? [{ toolCallId: part.id, kind: "result" as const }]
      : [],
  );
}
async function pairedEntries(
  index: HistoryIndexHandle,
  input: HistoryPageInput,
  page: HistoryPage,
): Promise<Map<string, HistoryEntry>> {
  const entries = new Map(page.entries.map((entry) => [entry.id, entry]));
  const tools = new Map<string, { call?: HistoryEntry; result?: HistoryEntry }>();
  for (const entry of page.entries) {
    for (const pair of toolPairs(entry)) {
      tools.set(pair.toolCallId, {
        ...tools.get(pair.toolCallId),
        [pair.kind === "call" ? "result" : "call"]: entry,
      });
    }
  }
  for (const entry of page.entries) {
    for (const pair of toolPairs(entry)) {
      let paired: HistoryEntry | null | undefined = tools.get(pair.toolCallId)?.[pair.kind];
      if (!paired) {
        // Pair page-local tools in reading order; requests share the bounded history process.
        // oxlint-disable-next-line no-await-in-loop
        paired = await index.entry({
          runId: input.runId,
          index: input.index,
          ...pair,
          terminalEntryId: input.terminalEntryId,
          endedAt: input.endedAt,
          signal: input.signal,
        });
      }
      if (paired && inBoundary(paired, page, input)) {
        entries.set(paired.id, paired);
      }
    }
  }
  return entries;
}
async function fullItem(
  index: HistoryIndexHandle,
  input: HistoryPageInput,
  entries: Readonly<ReadonlyMap<string, HistoryEntry>>,
  item: AgentHistoryItem,
): Promise<AgentHistoryItem> {
  const ids = new Set((item.entryIds ?? [item.id]).map((id) => id.split(":")[0] ?? "")),
    full: DisplayEntry[] = [];
  for (const id of ids) {
    const entry = entries.get(id);
    if (!entry) {
      throw new Error("Selected native entry is unavailable; retry history.");
    }
    // Keep selected call/result records ordered and the process memory bound to one record at a time.
    // oxlint-disable-next-line no-await-in-loop
    const record = await index.record({
      runId: input.runId,
      index: input.index,
      ref: entry.ref,
      terminalEntryId: input.terminalEntryId,
      endedAt: input.endedAt,
      signal: input.signal,
    });
    const observed = record && displayEntry({ ...record, id }, "full");
    if (!observed) {
      throw new Error("Selected native entry is unavailable; retry history.");
    }
    full.push(observed);
  }
  const detail = displayHistory(full).items.find((candidate) => candidate.id === item.id);
  if (!detail) {
    throw new Error("Selected native entry is unavailable; retry history.");
  }
  return detail;
}
/** A page retains bounded previews; selected records are revalidated by the process. */
export async function indexedHistory(
  index: HistoryIndexHandle,
  input: HistoryPageInput,
): Promise<{ history: AgentHistory; page: HistoryPage }> {
  const page = await index.historyPage(input);
  if (
    input.terminalEntryId !== undefined &&
    input.terminalEntryId.length > 0 &&
    page.terminalSequence === undefined
  ) {
    throw new Error("Saved terminal entry is unavailable; retry history.");
  }
  const entries = await pairedEntries(index, input, page);
  const observed = [...entries.values()]
    .sort((a, b) => a.sequence - b.sequence)
    .flatMap((entry) => displayEntry(entry.entry, "preview") ?? []);
  const history = displayHistory(observed),
    visible = new Set(page.entries.map((entry) => entry.id));
  const items = history.items
    .filter((item) =>
      (item.entryIds ?? [item.id]).some((id) => visible.has(id.split(":")[0] ?? "")),
    )
    .map((item) => detailLoader(item, () => fullItem(index, input, entries, item)));
  return {
    history: {
      ...history,
      items,
      entryIds: history.entryIds.filter((id) => visible.has(id.split(":")[0] ?? "")),
      unavailable: page.unavailable,
      configuration: page.configuration,
      deliveredMessages: new Map(page.deliveredMessages),
      finalId: page.finalResultId,
    },
    page,
  };
}

function detailLoader(
  item: AgentHistoryItem,
  load: () => Promise<AgentHistoryItem>,
): AgentHistoryItem {
  return { ...item, load };
}
