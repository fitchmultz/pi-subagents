import type { Message } from "@earendil-works/pi-ai";
import type { NativeUsageMetadata } from "./native-usage.ts";

/** Match each native ID once, keeping FIFO assignment for identical message identities. */
export function createMessageReferenceIndex<
  T extends { message?: Message; nativeEntryId?: string },
>() {
  type Queue = { items: T[]; offset: number };
  const byId = new Map<string, T>();
  const buckets = new Map<
    string,
    Map<number | undefined, { all: Queue; tools: Map<string, Queue> }>
  >();
  const matches = (item: T, message: NonNullable<NativeUsageMetadata["message"]>) =>
    item.message?.role === message.role &&
    item.message.timestamp === message.timestamp &&
    (!message.toolCallId ||
      (item.message.role === "toolResult" && item.message.toolCallId === message.toolCallId));
  return {
    add(item: T): void {
      if (!item.message) {
        return;
      }
      const { role, timestamp } = item.message;
      let timestamps = buckets.get(role);
      if (!timestamps) {
        buckets.set(role, (timestamps = new Map()));
      }
      let bucket = timestamps.get(timestamp);
      if (!bucket) {
        timestamps.set(timestamp, (bucket = { all: { items: [], offset: 0 }, tools: new Map() }));
      }
      bucket.all.items.push(item);
      if (item.message.role === "toolResult" && item.message.toolCallId) {
        let queue = bucket.tools.get(item.message.toolCallId);
        if (!queue) {
          bucket.tools.set(item.message.toolCallId, (queue = { items: [], offset: 0 }));
        }
        queue.items.push(item);
      }
    },
    reference(entry: NativeUsageMetadata): T | undefined {
      if (!entry.message) {
        return;
      }
      const existing = byId.get(entry.id);
      if (existing && matches(existing, entry.message)) {
        return existing;
      }
      const bucket = buckets.get(entry.message.role)?.get(entry.message.timestamp);
      const queue = entry.message.toolCallId
        ? bucket?.tools.get(entry.message.toolCallId)
        : bucket?.all;
      if (!queue) {
        return;
      }
      while (queue.offset < queue.items.length && queue.items[queue.offset]!.nativeEntryId) {
        queue.offset++;
      }
      const item = queue.items[queue.offset];
      if (item) {
        item.nativeEntryId = entry.id;
        byId.set(entry.id, item);
      }
      return item;
    },
  };
}

/** Streaming equivalent of the existing exit/status diagnostic expression. */
export class ExitCodeObservation {
  private tail = "";
  private collecting = false;
  private complete = false;
  value?: number;
  write(text: string): void {
    if (this.complete) {
      return;
    }
    if (this.collecting) {
      for (const character of text) {
        if (character < "0" || character > "9") {
          this.complete = true;
          return;
        }
        this.value = this.value! * 10 + Number(character);
      }
      return;
    }
    const normalized = (this.tail + text.replace(/\s+/g, " ")).replace(/ +/g, " ");
    const match = /exit(?:ed)? *(?:with *)?(?:code|status)? *[: ]? *(\d+)/i.exec(normalized);
    if (match) {
      this.value = Number(match[1]);
      this.collecting = match.index + match[0].length === normalized.length;
      this.complete = !this.collecting;
      this.tail = "";
    } else {
      this.tail = normalized.slice(-32);
    }
  }
}

function argumentPreview(
  arguments_: Record<string, unknown>,
): Record<string, string | boolean | number> {
  const result: Record<string, string | boolean | number> = {};
  for (const [key, value] of Object.entries(arguments_)) {
    if (typeof value === "string") {
      result[key] = value.slice(0, 2048);
    } else if (typeof value === "boolean" || typeof value === "number") {
      result[key] = value;
    }
  }
  return result;
}
/** Facts consumed by guards/reports; full bodies belong to native history or the audit. */
export function compactObservedMessage(message: Message): Message {
  const firstText = Array.isArray(message.content)
    ? message.content.find((part) => part.type === "text")
    : undefined;
  const observedExitCode =
    message.role === "toolResult" && firstText?.type === "text"
      ? ((message as Message & { observedExitCode?: number }).observedExitCode ??
        Number(
          firstText.text.match(/exit(?:ed)?\s*(?:with\s*)?(?:code|status)?\s*[:\s]?\s*(\d+)/i)?.[1],
        ))
      : undefined;
  const content = Array.isArray(message.content)
    ? message.content.map((part) => {
        if (part.type === "text") {
          const preview = part.text.slice(0, 4096);
          return {
            type: "text" as const,
            text: preview + (!preview.trim() && part.text.trim() ? "…" : ""),
          };
        }
        if (part.type === "toolCall") {
          return {
            ...part,
            arguments:
              part.name === "structured_output"
                ? part.arguments
                : argumentPreview(part.arguments ?? {}),
          };
        }
        if (part.type === "thinking") {
          return { type: "thinking" as const, thinking: "" };
        }
        return { type: "image" as const, data: "", mimeType: part.mimeType };
      })
    : typeof message.content === "string"
      ? message.content.slice(0, 4096)
      : [];
  if (message.role === "toolResult") {
    const details = message.details as { preview?: unknown; modifiedFiles?: unknown } | undefined;
    return {
      ...message,
      ...(observedExitCode !== undefined && !Number.isNaN(observedExitCode)
        ? { observedExitCode }
        : {}),
      content: content as typeof message.content,
      details: details
        ? {
            ...(typeof details.preview === "boolean" ? { preview: details.preview } : {}),
            ...(Array.isArray(details.modifiedFiles)
              ? {
                  modifiedFiles: details.modifiedFiles.filter(
                    (file): file is string => typeof file === "string",
                  ),
                }
              : {}),
          }
        : undefined,
    };
  }
  return { ...message, content } as Message;
}
