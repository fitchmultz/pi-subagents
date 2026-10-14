import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
type ReadonlySessionManager = ExtensionContext["sessionManager"];
type BoundedOptions = TranscriptOptions & { readonly limit: number; readonly maxBytes: number };
import { isRecord, isUnknownArray } from "../shared/unknown.ts";
import { Fault, label, object } from "./bridge-protocol.ts";

export interface TranscriptOptions {
  readonly limit?: number;
  readonly maxBytes?: number;
  readonly cursor?: string;
}
export interface TranscriptRecord {
  readonly id: string;
  readonly timestamp: string;
  readonly role: string;
  readonly text: string;
  readonly truncated: boolean;
}
export interface TranscriptPage {
  readonly sessionId: string;
  readonly leafId: string | null;
  readonly records: readonly TranscriptRecord[];
  readonly bytes: number;
  readonly truncated: boolean;
  readonly cursor?: string;
  readonly scanLimitReached: boolean;
  readonly finalizedOnly: true;
  readonly streaming: "unavailable";
}
const SCAN_LIMIT = 1024;
export function transcriptOptions(value: unknown = {}): BoundedOptions {
  const input = object(value, ["limit", "maxBytes", "cursor"]);
  const limit = integer(input.limit, 50, 1, 100);
  const maxBytes = integer(input.maxBytes, 65536, 256, 131072);
  const cursor = input.cursor === undefined ? undefined : label(input.cursor, "cursor", 512);
  return { limit, maxBytes, cursor };
}
function integer(value: unknown, fallback: number, min: number, max: number): number {
  const result = value === undefined ? fallback : value;
  if (typeof result !== "number" || !Number.isInteger(result) || result < min || result > max) {
    throw new Fault(
      400,
      "invalid_input",
      `Transcript limit must be an integer from ${min} to ${max}.`,
    );
  }
  return result;
}
interface TextOutput {
  readonly text: string;
  readonly truncated: boolean;
}
function textualContent(content: unknown): TextOutput {
  if (typeof content === "string") {
    return { text: content, truncated: false };
  }
  if (!isUnknownArray(content)) {
    return { text: "", truncated: false };
  }
  const pieces: string[] = [];
  let remaining = 131073;
  let truncated = content.length > 4096;
  for (const part of content.slice(0, 4096)) {
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
      const text = part.text.slice(0, remaining);
      pieces.push(text);
      truncated ||= text.length < part.text.length;
      remaining -= text.length + 1;
    }
  }
  return { text: pieces.join("\n"), truncated };
}
function visible(entry: SessionEntry): (TextOutput & { readonly role: string }) | undefined {
  if (entry.type === "custom_message") {
    return entry.display ? { role: "custom", ...textualContent(entry.content) } : undefined;
  }
  if (entry.type !== "message") {
    return undefined;
  }
  const message = entry.message;
  if (message.role === "bashExecution") {
    return {
      role: "toolResult",
      text: message.output,
      truncated: nativeTruncation(message.truncated),
    };
  }
  if (!["user", "assistant", "toolResult", "custom"].includes(message.role)) {
    return undefined;
  }
  if (message.role === "custom" && !message.display) {
    return undefined;
  }
  return "content" in message
    ? { role: message.role, ...textualContent(message.content) }
    : undefined;
}
function nativeTruncation(value: unknown): boolean {
  // Older saved bash entries may predate the native boolean field.
  return value === true;
}
function boundedText(text: string, budget: number): string {
  // Slice before UTF-8 encoding to avoid copying arbitrarily large live tool output.
  const bytes = Buffer.from(text.slice(0, budget));
  if (bytes.length <= budget) {
    return bytes.toString();
  }
  let end = budget;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return bytes.subarray(0, end).toString();
}
function startId(
  manager: ReadonlySessionManager,
  leaf: string | null,
  cursor?: string,
): { readonly id: string | null; readonly scanned: number } {
  if (cursor === undefined) {
    return { id: leaf, scanned: 0 };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new Fault(400, "invalid_cursor", "Invalid transcript cursor.");
  }
  const data = object(raw, ["leaf", "before"]);
  if (data.leaf !== leaf) {
    throw new Fault(409, "branch_changed", "Active branch changed; request a new transcript page.");
  }
  const before = label(data.before, "cursor entry", 128);
  let id = leaf;
  for (let scanned = 0; id !== null && scanned < SCAN_LIMIT; scanned += 1) {
    if (id === before) {
      return { id, scanned };
    }
    id = manager.getEntry(id)?.parentId ?? null;
  }
  throw new Fault(400, "invalid_cursor", "Cursor is outside the bounded active branch.");
}
/** Finalized textual output on the selected branch; never builds full history/context. */
export function readLiveTranscript(
  manager: ReadonlySessionManager,
  input: TranscriptOptions = {},
): TranscriptPage {
  const options = transcriptOptions(input);
  const leaf = manager.getLeafId();
  const start = startId(manager, leaf, options.cursor);
  let id = start.id;
  let scanned = start.scanned;
  const records: TranscriptRecord[] = [];
  let bytes = 0;
  let textTruncated = false;
  while (id !== null && scanned < SCAN_LIMIT) {
    scanned += 1;
    const entry = manager.getEntry(id);
    if (!entry) {
      textTruncated = true;
      id = null;
      break;
    }
    const record = transcriptRecord(entry, options.maxBytes - bytes);
    if (record !== undefined) {
      records.push(record);
      bytes += Buffer.byteLength(record.text);
      textTruncated ||= record.truncated;
    }
    id = entry.parentId;
    if (records.length >= options.limit || bytes >= options.maxBytes) {
      break;
    }
  }
  return transcriptPage(manager, {
    leaf,
    records,
    bytes,
    textTruncated,
    id,
    scanLimitReached: scanned >= SCAN_LIMIT && id !== null,
  });
}
function transcriptRecord(entry: SessionEntry, budget: number): TranscriptRecord | undefined {
  const output = visible(entry);
  if (output === undefined || output.text.length === 0) {
    return undefined;
  }
  const text = boundedText(output.text, budget);
  return {
    id: entry.id,
    timestamp: entry.timestamp,
    role: output.role,
    text,
    truncated: text !== output.text || output.truncated,
  };
}
function transcriptPage(
  manager: ReadonlySessionManager,
  state: {
    readonly leaf: string | null;
    readonly records: TranscriptRecord[];
    readonly bytes: number;
    readonly textTruncated: boolean;
    readonly id: string | null;
    readonly scanLimitReached: boolean;
  },
): TranscriptPage {
  const { leaf, records, bytes, textTruncated, id, scanLimitReached } = state;
  return {
    sessionId: manager.getSessionId(),
    leafId: leaf,
    records: records.reverse(),
    bytes,
    truncated: id !== null || textTruncated,
    scanLimitReached,
    ...(id !== null && !scanLimitReached
      ? { cursor: Buffer.from(JSON.stringify({ leaf, before: id })).toString("base64url") }
      : {}),
    finalizedOnly: true,
    streaming: "unavailable",
  };
}
