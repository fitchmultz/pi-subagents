import * as fs from "node:fs";
import { NativeJournal, type NativeRecord } from "../shared/native-journal.ts";
import { nativeProjection } from "../shared/journal-projections.ts";
import type { Projection } from "../shared/json-projection.ts";
import { isRecord, recordAt, type UnknownRecord } from "../shared/unknown.ts";

export function plainText(value: string, length = 512): string {
  return Array.from(value.slice(0, length))
    .map((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code < 32 || (code >= 127 && code <= 159) ? " " : char;
    })
    .join("");
}
const PAGE_CHARS = 32 * 1024;
const callFields = new Set(["type", "id", "name"]);
const textFields = new Set(["text", "thinking"]);
const metadata: Projection = (keys, root) => {
  if (
    keys[0] === "message" &&
    keys[1] === "content" &&
    keys.length > 3 &&
    !callFields.has(String(keys[3]))
  ) {
    return false;
  }
  return nativeProjection(keys, root);
};
function contentIndex(keys: readonly (string | number)[]): number | undefined {
  if (keys[0] !== "message" || keys[1] !== "content") {
    return undefined;
  }
  if (keys.length === 2) {
    return -1;
  }
  return typeof keys[2] === "number" && textFields.has(String(keys[3])) ? keys[2] : undefined;
}
class TextPage {
  private chars = 0;
  private carry?: { index: number; text: string } | undefined;
  private readonly text = new Map<number, string>();
  private readonly start: number;
  constructor(page: number) {
    this.start = page * PAGE_CHARS;
  }
  add(index: number, chunk: string): void {
    const previous = this.carry;
    this.carry = undefined;
    if (previous && previous.index !== index) {
      this.take(previous.index, previous.text);
    }
    const text = previous?.index === index ? previous.text + chunk : chunk;
    const last = text.charCodeAt(text.length - 1);
    const pending = last >= 0xd800 && last <= 0xdbff;
    this.take(index, pending ? text.slice(0, -1) : text);
    if (pending) {
      this.carry = { index, text: text.slice(-1) };
    }
  }
  private take(index: number, text: string): void {
    const points = Array.from(text);
    const from = Math.max(0, this.start - this.chars);
    const to = Math.min(points.length, this.start + PAGE_CHARS - this.chars);
    if (to > from) {
      this.text.set(index, (this.text.get(index) ?? "") + points.slice(from, to).join(""));
    }
    this.chars += points.length;
  }
  finish(value: UnknownRecord, page: number): ConversationPage {
    if (this.carry) {
      this.take(this.carry.index, this.carry.text);
    }
    const message = { ...recordAt(value, "message") };
    if (typeof message.content === "string") {
      message.content = this.text.get(-1) ?? "";
    }
    if (Array.isArray(message.content)) {
      for (const [index, block] of (message.content as unknown[]).entries()) {
        if (isRecord(block) && typeof block.type === "string" && textFields.has(block.type)) {
          block[block.type] = this.text.get(index) ?? "";
        }
      }
    }
    return { message, page, pages: Math.max(1, Math.ceil(this.chars / PAGE_CHARS)) };
  }
}
export interface ConversationPage {
  message: UnknownRecord;
  page: number;
  pages: number;
}

/** Native indexing owns ancestry and publication; only requested message pages are hydrated. */
export class ConversationJournal {
  readonly native: NativeJournal;
  private branch?: { length: number; leaf: string | null | undefined; entries: NativeRecord[] };
  constructor(file: string, sessionId: string) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("Child journal is not a regular file.");
    }
    this.native = new NativeJournal(file, "live", true, {
      readBytes: 256 * 1024,
      select: metadata,
    });
    if (this.native.records[0]?.value.id !== sessionId) {
      throw new Error("Native journal identity does not match this child.");
    }
  }
  entries(requested?: string | null): NativeRecord[] {
    const leaf =
      typeof requested === "string" && !this.native.byId.has(requested) ? undefined : requested;
    if (this.branch?.length !== this.native.records.length || this.branch.leaf !== leaf) {
      this.branch = {
        length: this.native.records.length,
        leaf,
        entries: this.native.branch(leaf).filter((entry) => entry.value.type === "message"),
      };
    }
    return this.branch.entries;
  }
  async call(id: string, result: string, signal?: AbortSignal): Promise<UnknownRecord | undefined> {
    const contains = (entry: NativeRecord) => {
      const content = recordAt(entry.value, "message")?.content;
      return (
        Array.isArray(content) &&
        content.some(
          (part: unknown) => isRecord(part) && part.type === "toolCall" && part.id === id,
        )
      );
    };
    const entries = this.branch?.entries ?? [];
    const entry = entries
      .slice(
        0,
        entries.findIndex((item) => item.value.id === result),
      )
      .findLast(contains);
    const content = entry && (await this.page(entry, 0, { signal })).message.content;
    return Array.isArray(content)
      ? content.find(
          (part: unknown): part is UnknownRecord =>
            isRecord(part) && part.type === "toolCall" && part.id === id,
        )
      : undefined;
  }
  async page(
    entry: NativeRecord,
    page = 0,
    options: { signal?: AbortSignal | undefined; hideThinking?: boolean } = {},
  ): Promise<ConversationPage> {
    const text = new TextPage(page);
    const value = await this.native.project(
      entry,
      (keys, root) => {
        if (contentIndex(keys) !== undefined && keys.length > 2) {
          return 0;
        }
        return nativeProjection(keys, root);
      },
      (keys, chunk) => {
        const index = contentIndex(keys);
        if (index === undefined || (options.hideThinking === true && keys[3] === "thinking")) {
          return;
        }
        text.add(index, chunk);
      },
      options.signal,
    );
    return text.finish(value, page);
  }
}
