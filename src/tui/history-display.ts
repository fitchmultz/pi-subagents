import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { DisplayEntry, HistoryAssistantPreview } from "./history-record.ts";
import { hasText } from "./text-values.ts";
import { readableText, contentText, isRecord } from "./history-text.ts";
import { stripAcceptanceReport } from "../runs/shared/acceptance-reports.ts";
import { extractToolArgsPreview } from "../shared/utils.ts";

/** Fixed native SDK default payload, retained as a mutable native rendering handle. */
export type RecordedToolResult = ToolResultMessage;
export interface AgentHistoryItem {
  readonly id: string;
  readonly entryIds?: readonly string[];
  readonly kind: "user" | "assistant" | "thinking" | "tool" | "result" | "change" | "notice";
  readonly title: string;
  readonly text: string;
  readonly details?: string;
  readonly diff?: string;
  readonly assistant?: AssistantMessage;
  readonly previewAssistant?: HistoryAssistantPreview;
  readonly model?: string;
  readonly call?: ToolCall;
  readonly result?: RecordedToolResult;
  readonly messageId?: string;
  readonly timestamp: number;
  readonly load?: () => Promise<AgentHistoryItem>;
}
export interface AgentHistory {
  readonly items: readonly AgentHistoryItem[];
  readonly entryIds: readonly string[];
  readonly finalId?: string;
  readonly findFinalResult?: (text: string) => string | undefined;
  readonly deliveredMessages?: Readonly<ReadonlyMap<string, boolean>>;
  readonly configuration?: {
    readonly model?: string;
    readonly thinking?: string;
    readonly modelRecordedAt?: number;
  };
  readonly unavailable?: string;
}
function resultDisplay(
  result: RecordedToolResult,
  call?: ToolCall,
): Pick<AgentHistoryItem, "text" | "diff" | "details"> {
  const details: unknown = result.details;
  return {
    text: contentText(result.content),
    diff:
      isRecord(details) && typeof details.diff === "string"
        ? readableText(details.diff)
        : undefined,
    details: readableText({ ...(call ? { call } : {}), result }),
  };
}
function lazyItem(
  facts: Omit<AgentHistoryItem, "text" | "title">,
  format: () => Pick<AgentHistoryItem, "text" | "title" | "details" | "diff">,
  resultReader?: () => RecordedToolResult | undefined,
): AgentHistoryItem {
  let display: ReturnType<typeof format> | undefined;
  const get = () => {
    display ??= format();
    return display;
  };
  return {
    ...facts,
    get result() {
      return resultReader?.() ?? facts.result;
    },
    get title() {
      return get().title;
    },
    get text() {
      return get().text;
    },
    get details() {
      return get().details;
    },
    get diff() {
      return get().diff;
    },
  };
}

/** The builder owns pairing; public cards expose getters, not mutable shared snapshots. */
class NativeHistoryBuilder {
  readonly items: AgentHistoryItem[] = [];
  readonly entryIds: string[] = [];
  private readonly calls = new Map<string, { result?: RecordedToolResult; entryIds: string[] }>();
  append(item: AgentHistoryItem): void {
    this.items.push(item);
    this.entryIds.push(item.id);
  }
  add(entry: DisplayEntry): void {
    const base = { id: entry.id, timestamp: Date.parse(entry.timestamp) };
    switch (entry.type) {
      case "custom_message": {
        const details: unknown = entry.details,
          human = entry.customType === "subagent-human-message";
        const body = isRecord(details) ? details.bodyText : undefined;
        const from = isRecord(details) && isRecord(details.from) ? details.from.name : undefined;
        const message =
          isRecord(details) && isRecord(details.message) ? details.message.id : undefined;
        this.append(
          lazyItem(
            {
              ...base,
              kind: human ? "user" : "notice",
              messageId: human && typeof message === "string" ? message : undefined,
            },
            () => ({
              title: human
                ? "User · delivered to conversation"
                : typeof from === "string" && from.length > 0
                  ? `From ${from}`
                  : entry.customType,
              text: contentText(body ?? entry.content),
            }),
          ),
        );
        break;
      }
      case "compaction":
        this.append(
          lazyItem({ ...base, kind: "notice" }, () => ({
            title: "Context summary · earlier history retained above",
            text: readableText(entry.summary),
          })),
        );
        break;
      case "branch_summary":
        this.append(
          lazyItem({ ...base, kind: "notice" }, () => ({
            title: "Branch summary",
            text: readableText(entry.summary),
          })),
        );
        break;
      case "message":
        this.message(entry);
        break;
    }
  }
  private message(entry: Extract<DisplayEntry, { type: "message" }>): void {
    const message = entry.message,
      base = { id: entry.id, timestamp: Date.parse(entry.timestamp) };
    switch (message.role) {
      case "assistant":
        this.assistant(
          entry.id,
          base.timestamp,
          message,
          entry.native?.role === "assistant" ? entry.native : undefined,
        );
        break;
      case "user":
        this.append(
          lazyItem({ ...base, kind: "user" }, () => ({
            title: "User / assignment",
            text: contentText(message.content),
          })),
        );
        break;
      case "toolResult": {
        const pair = this.calls.get(message.toolCallId);
        if (pair) {
          pair.result = message;
          pair.entryIds.push(entry.id);
          this.entryIds.push(entry.id);
        } else {
          this.append(
            lazyItem({ ...base, result: message, kind: "result" }, () => ({
              title: `${message.toolName} · call not recorded`,
              ...resultDisplay(message),
            })),
          );
        }
        break;
      }
      case "bashExecution":
        this.append(
          lazyItem({ ...base, kind: "tool" }, () => ({
            title: `Shell: ${readableText(message.command)}`,
            text: `${readableText(message.output)}\n${typeof message.exitCode === "number" ? `Shell exit code: ${message.exitCode}` : "Shell exit code not recorded"}${message.cancelled ? " · cancelled" : ""}`,
            details: readableText({
              command: message.command,
              exitCode: message.exitCode,
              cancelled: message.cancelled,
            }),
          })),
        );
        break;
      case "custom":
      case "branchSummary":
      case "compactionSummary":
      case "system":
        break;
    }
  }
  private assistant(
    entryId: string,
    timestamp: number,
    message: AssistantMessage | HistoryAssistantPreview,
    native?: AssistantMessage,
  ): void {
    const model = hasText(message.model)
      ? hasText(message.provider)
        ? `${message.provider}/${message.model}`
        : message.model
      : undefined;
    const ids = message.content.flatMap((part, index) =>
      (part.type === "text" && part.text.length > 0) ||
      (part.type === "thinking" && part.thinking.length > 0)
        ? [`${entryId}:${index}`]
        : [],
    );
    const first = ids[0];
    if (first !== undefined) {
      this.items.push(
        lazyItem(
          {
            id: first,
            timestamp,
            entryIds: ids,
            kind: message.content.some((part) => part.type === "text" && part.text.length > 0)
              ? "assistant"
              : "thinking",
            assistant: native,
            previewAssistant: native ? undefined : message,
            model,
          },
          () => ({ title: "Agent", text: contentText(message.content) }),
        ),
      );
    }
    for (const [index, part] of message.content.entries()) {
      const id = `${entryId}:${index}`;
      if (part.type === "toolCall") {
        this.tool(id, timestamp, part, model);
      } else if (ids.includes(id)) {
        this.entryIds.push(id);
      }
    }
    if (message.errorMessage !== undefined && message.errorMessage.length > 0) {
      const id = `${entryId}:error`;
      if (
        ids.length > 0 &&
        !message.content.some((part) => part.type === "toolCall") &&
        ["error", "aborted"].includes(message.stopReason ?? "")
      ) {
        ids.push(id);
        this.entryIds.push(id);
      } else {
        this.append(
          lazyItem({ id, timestamp, kind: "notice", model }, () => ({
            title: "Agent error",
            text: readableText(message.errorMessage),
          })),
        );
      }
    }
  }
  private tool(id: string, timestamp: number, call: ToolCall, model?: string): void {
    const pair: { result?: RecordedToolResult; entryIds: string[] } = { entryIds: [id] };
    const display = () => ({
      title:
        `${call.name} ${extractToolArgsPreview(call.arguments)}`.trim() +
        (pair.result
          ? ` · ${pair.result.isError ? "failed" : "result recorded"}`
          : " · result not recorded"),
      ...(pair.result
        ? resultDisplay(pair.result, call)
        : {
            text: readableText(call.arguments),
            details: `${readableText(call)}\n\nCommand result not recorded; exit is unconfirmed. An agent pause or exit does not prove that a command or its descendants exited.`,
          }),
    });
    this.append(
      lazyItem(
        { id, timestamp, entryIds: pair.entryIds, kind: "tool", call, model },
        display,
        () => pair.result,
      ),
    );
    this.calls.set(call.id, pair);
  }
}
export function displayHistory(entries: readonly DisplayEntry[]): AgentHistory {
  const builder = new NativeHistoryBuilder();
  for (const entry of entries) {
    builder.add(entry);
  }
  let finalResults: Map<string, string> | undefined;
  return {
    items: builder.items,
    entryIds: builder.entryIds,
    findFinalResult(text) {
      if (!finalResults) {
        finalResults = new Map();
        for (const item of builder.items.filter((item) => item.kind === "assistant")) {
          finalResults.set(stripAcceptanceReport(item.text).trim(), item.id);
          for (const part of item.assistant?.content ?? []) {
            if (part.type === "text") {
              finalResults.set(stripAcceptanceReport(readableText(part.text)).trim(), item.id);
            }
          }
        }
      }
      return finalResults.get(text);
    },
  };
}
