import type { ObservedMessage, ObservedContent } from "../../shared/types/messages.ts";
import type { NativeUsageMetadata } from "./native-usage.ts";

type Referenceable = { readonly message?: ObservedMessage; readonly nativeEntryId?: string };
export interface MessageReferenceIndex<T> {
  readonly add: (item: Readonly<T>) => void;
  readonly reference: (entry: NativeUsageMetadata) => Readonly<T> | undefined;
  readonly entryId: (item: Readonly<T>) => string | undefined;
}

type Queue<T> = { items: Readonly<T>[]; offset: number };
type Bucket<T> = { all: Queue<T>; tools: Map<string, Queue<T>> };

/** FIFO message matching; native identity belongs to the index, not its input observations. */
class ReferenceIndex<T extends Referenceable> implements MessageReferenceIndex<T> {
  private readonly byId = new Map<string, Readonly<T>>();
  private readonly ids = new WeakMap<Readonly<T>, string>();
  private readonly buckets = new Map<string, Map<number | undefined, Bucket<T>>>();

  private bucketFor(item: Readonly<T>): Bucket<T> | undefined {
    if (!item.message) {
      return;
    }
    const { role, timestamp } = item.message;
    let timestamps = this.buckets.get(role);
    if (!timestamps) {
      timestamps = new Map();
      this.buckets.set(role, timestamps);
    }
    let bucket = timestamps.get(timestamp);
    if (!bucket) {
      bucket = { all: { items: [], offset: 0 }, tools: new Map() };
      timestamps.set(timestamp, bucket);
    }
    return bucket;
  }
  add(item: Readonly<T>): void {
    const bucket = this.bucketFor(item);
    if (!bucket) {
      return;
    }
    bucket.all.items.push(item);
    if (item.nativeEntryId !== undefined) {
      this.ids.set(item, item.nativeEntryId);
      this.byId.set(item.nativeEntryId, item);
    }
    if (item.message?.role === "toolResult" && item.message.toolCallId.length > 0) {
      let queue = bucket.tools.get(item.message.toolCallId);
      if (!queue) {
        queue = { items: [], offset: 0 };
        bucket.tools.set(item.message.toolCallId, queue);
      }
      queue.items.push(item);
    }
  }
  reference(entry: NativeUsageMetadata): Readonly<T> | undefined {
    if (!entry.message) {
      return;
    }
    const existing = this.byId.get(entry.id);
    if (existing && matches(existing.message, entry.message)) {
      return existing;
    }
    const item = this.nextItem(entry.message);
    if (item) {
      this.ids.set(item, entry.id);
      this.byId.set(entry.id, item);
    }
    return item;
  }
  private referenceQueue(
    message: NonNullable<NativeUsageMetadata["message"]>,
  ): Queue<T> | undefined {
    const bucket = this.buckets.get(message.role)?.get(message.timestamp);
    return message.toolCallId !== undefined && message.toolCallId.length > 0
      ? bucket?.tools.get(message.toolCallId)
      : bucket?.all;
  }
  private nextItem(message: NonNullable<NativeUsageMetadata["message"]>): Readonly<T> | undefined {
    const queue = this.referenceQueue(message);
    if (!queue) {
      return;
    }
    while (queue.offset < queue.items.length) {
      const candidate = queue.items.at(queue.offset);
      if (!candidate || !this.ids.has(candidate)) {
        break;
      }
      queue.offset++;
    }
    return queue.items.at(queue.offset);
  }
  entryId(item: Readonly<T>): string | undefined {
    return this.ids.get(item);
  }
}

export function createMessageReferenceIndex<T extends Referenceable>(): MessageReferenceIndex<T> {
  return new ReferenceIndex<T>();
}

function matches(
  message: ObservedMessage | undefined,
  reference: NonNullable<NativeUsageMetadata["message"]>,
): boolean {
  return (
    message?.role === reference.role &&
    message.timestamp === reference.timestamp &&
    (reference.toolCallId === undefined ||
      reference.toolCallId.length === 0 ||
      (message.role === "toolResult" && message.toolCallId === reference.toolCallId))
  );
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
      this.collectDigits(text);
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
  private collectDigits(text: string): void {
    for (const character of text) {
      if (character < "0" || character > "9") {
        this.complete = true;
        return;
      }
      this.value = (this.value ?? 0) * 10 + Number(character);
    }
  }
}

function argumentPreview(
  arguments_: Readonly<Record<string, unknown>>,
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

function compactContent(part: ObservedContent): ObservedContent {
  switch (part.type) {
    case "text": {
      const preview = part.text.slice(0, 4096);
      return {
        type: "text",
        text: preview + (preview.trim().length === 0 && part.text.trim().length > 0 ? "…" : ""),
      };
    }
    case "toolCall":
      return {
        ...part,
        arguments:
          part.name === "structured_output" ? part.arguments : argumentPreview(part.arguments),
      };
    case "thinking":
      return { type: "thinking", thinking: "" };
    case "image":
      return { type: "image", data: "", mimeType: part.mimeType };
  }
}

function compactDetails(details: unknown): unknown {
  if (typeof details !== "object" || details === null) {
    return;
  }
  const preview = "preview" in details ? details.preview : undefined;
  const modifiedFiles = "modifiedFiles" in details ? details.modifiedFiles : undefined;
  return {
    ...(typeof preview === "boolean" ? { preview } : {}),
    ...(Array.isArray(modifiedFiles)
      ? {
          modifiedFiles: modifiedFiles.filter(
            (file: unknown): file is string => typeof file === "string",
          ),
        }
      : {}),
  };
}

/** Guards/reports consume compact facts; full bodies belong to native history or audit. */
export function compactObservedMessage(message: ObservedMessage): ObservedMessage {
  if (message.content === undefined) {
    return message;
  }
  if (typeof message.content === "string") {
    return { ...message, content: message.content.slice(0, 4096) };
  }
  const content = message.content.map(compactContent);
  if (message.role !== "toolResult") {
    return { ...message, content };
  }
  const firstText = message.content.find((part) => part.type === "text");
  const exitCode =
    message.observedExitCode ??
    Number(
      firstText?.text.match(/exit(?:ed)?\s*(?:with\s*)?(?:code|status)?\s*[:\s]?\s*(\d+)/i)?.[1],
    );
  return {
    ...message,
    ...(Number.isNaN(exitCode) ? {} : { observedExitCode: exitCode }),
    content,
    details: compactDetails(message.details),
  };
}
