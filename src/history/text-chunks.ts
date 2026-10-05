import { HistoryIndexError } from "./types.ts";
import { candidate } from "./preview.ts";
import type { HistoryStore } from "./store.ts";

interface TextToken {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}
interface TextWindow {
  readonly field: string;
  readonly start: number;
  readonly end: number;
  readonly text: string;
}
/** Streaming ECMA-48 removal, retaining original UTF-16 positions without buffering control payloads. */
class TerminalText {
  private state: "text" | "escape" | "intermediate" | "csi" | "string" | "stringEscape" = "text";
  private escape(char: string): void {
    if (char === "[") {
      this.state = "csi";
    } else if ("]PX^_".includes(char)) {
      this.state = "string";
    } else {
      this.state = char >= " " && char <= "/" ? "intermediate" : "text";
    }
  }
  private control(char: string): void {
    if (this.state === "escape") {
      this.escape(char);
    } else if (this.state === "intermediate") {
      if (char >= "0" && char <= "~") {
        this.state = "text";
      }
    } else if (this.state === "csi") {
      if (char >= "@" && char <= "~") {
        this.state = "text";
      }
    } else {
      this.stringControl(char);
    }
  }
  private stringControl(char: string): void {
    if (char === "\x07" || char === "\x9c" || (this.state === "stringEscape" && char === "\\")) {
      this.state = "text";
    } else {
      this.state = char === "\x1b" ? "stringEscape" : "string";
    }
  }
  write(text: string, visible: (text: string, start: number) => void): void {
    let position = 0;
    while (position < text.length) {
      if (this.state !== "text") {
        this.control(text.charAt(position++));
        continue;
      }
      // ECMA-48 introducers intentionally identify terminal controls before lexical indexing.
      // oxlint-disable-next-line no-control-regex
      const next = text.slice(position).search(/[\x1b\x90\x98\x9b\x9d-\x9f]/);
      if (next < 0) {
        visible(text.slice(position), position);
        return;
      }
      visible(text.slice(position, position + next), position);
      position += next;
      const control = text.charAt(position++);
      if (control === "\x1b") {
        this.state = "escape";
      } else {
        this.state = control === "\x9b" ? "csi" : "string";
      }
    }
  }
}
/** Owns one lexical stream and its overlap; no caller can mutate its token buffer. */
class FieldText {
  private word = "";
  private wordStart = 0;
  private received = 0;
  private tokens: TextToken[] = [];
  private length = 0;
  private readonly terminal = new TerminalText();
  private readonly field: string;
  private readonly emit: (window: TextWindow) => void;
  constructor(field: string, emit: (window: TextWindow) => void) {
    this.field = field;
    this.emit = emit;
  }
  private window(final = false): void {
    const first = this.tokens.at(0);
    const last = this.tokens.at(-1);
    if (!first || !last) {
      return;
    }
    this.emit({
      field: this.field,
      start: first.start,
      end: last.end,
      text: this.tokens.map((token) => token.text).join(" "),
    });
    this.tokens = final ? [] : this.tokens.slice(-12);
    this.length = this.tokens.reduce((length, token) => length + token.text.length + 1, 0);
  }
  private token(end: number): void {
    if (this.word.length === 0) {
      return;
    }
    this.tokens.push({ text: this.word, start: this.wordStart, end });
    this.length += this.word.length + 1;
    this.word = "";
    if (this.tokens.length >= 256 || (this.length >= 8192 && this.tokens.length > 12)) {
      this.window();
    }
  }
  write(text: string): void {
    this.terminal.write(text, (visible, offset) => {
      for (const part of visible.matchAll(/[\p{L}\p{N}\p{M}]+|[^\p{L}\p{N}\p{M}]+/gu)) {
        const start = this.received + offset + part.index;
        if (!/^[\p{L}\p{N}\p{M}]/u.test(part[0])) {
          this.token(start);
          continue;
        }
        if (this.word.length === 0) {
          this.wordStart = start;
        }
        this.word += part[0];
        if (this.word.length > 65_536) {
          throw new HistoryIndexError(
            "RECORD_COMPLEXITY",
            "Record contains a lexical token exceeding the 64 KiB indexing budget.",
          );
        }
      }
    });
    this.received += text.length;
  }
  finish(): void {
    this.token(this.received);
    this.window(true);
  }
}
/** Token windows overlap 12 tokens, including phrases across arbitrarily long whitespace. */
export class TextChunks {
  private readonly fields = new Map<string, FieldText>();
  private staged: TextWindow[] = [];
  write(keys: readonly (string | number)[], text: string): void {
    if (!candidate(keys)) {
      return;
    }
    const field = JSON.stringify(keys);
    let buffer = this.fields.get(field);
    if (!buffer) {
      if (this.fields.size >= 4096) {
        throw new HistoryIndexError(
          "RECORD_COMPLEXITY",
          "Record exceeds the 4096 visible text-field indexing budget.",
        );
      }
      buffer = new FieldText(field, (window) => {
        this.staged.push(window);
      });
      this.fields.set(field, buffer);
    }
    buffer.write(text);
  }
  flush(store: Readonly<HistoryStore>, finish = false): void {
    if (finish) {
      for (const buffer of this.fields.values()) {
        buffer.finish();
      }
      this.fields.clear();
    }
    if (this.staged.length > 0) {
      const insert = store.db.prepare("INSERT INTO pending_text VALUES (?,?,?,?)");
      for (const item of this.staged) {
        insert.run(item.field, item.start, item.end, item.text);
      }
      this.staged = [];
    }
  }
}
