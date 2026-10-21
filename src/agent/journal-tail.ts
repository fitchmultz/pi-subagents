import * as fs from "node:fs";

const READ_BYTES = 65536;
const LINE_BYTES = 32768;
const KEEP_LINES = 80;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function plainText(value: string, length = 512): string {
  // Journal content is untrusted terminal input, never terminal control sequences.
  return Array.from(value.slice(0, length))
    .map((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code < 32 || (code >= 127 && code <= 159) ? " " : char;
    })
    .join("");
}
function contentLines(content: unknown): string[] {
  if (typeof content === "string") {
    return [plainText(content)];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content.slice(0, 12).flatMap((block: unknown) => {
    if (!record(block)) {
      return [];
    }
    if (block.type === "text" && typeof block.text === "string") {
      return [plainText(block.text)];
    }
    if (block.type === "toolCall" && typeof block.name === "string") {
      return [`tool ${plainText(block.name, 80)} ${plainText(JSON.stringify(block.arguments))}`];
    }
    return block.type === "thinking"
      ? []
      : [`[${typeof block.type === "string" ? plainText(block.type, 40) : "non-text"} omitted]`];
  });
}
function activity(value: unknown): string[] {
  if (!record(value) || value.type !== "message" || !record(value.message)) {
    return [];
  }
  const message = value.message;
  if (message.role === "assistant") {
    const lines = contentLines(message.content).map((line) => `assistant: ${line}`);
    if (typeof message.errorMessage === "string") {
      lines.push(`assistant error: ${plainText(message.errorMessage)}`);
    }
    return lines;
  }
  if (message.role === "toolResult") {
    const label = message.isError === true ? "tool error" : "tool result";
    const name = typeof message.toolName === "string" ? plainText(message.toolName, 80) : "unknown";
    return [`${label} ${name}:`, ...contentLines(message.content)];
  }
  return [];
}

/** A lossy display tail; the native journal remains the complete source of truth. */
export class JournalTail {
  readonly lines: string[] = [];
  notice = "Waiting for published native activity.";
  private offset = 0;
  private partial: Buffer = Buffer.alloc(0);
  private dropping = false;
  private identity = "";
  private stamp = 0;
  private readonly file: string;
  private readonly sessionId: string;
  constructor(file: string, sessionId: string) {
    this.file = file;
    this.sessionId = sessionId;
  }
  private reset(size: number): void {
    this.lines.length = 0;
    this.offset = 0;
    this.partial = Buffer.alloc(0);
    this.dropping = false;
    if (size > READ_BYTES) {
      this.skip(size);
    }
  }
  private skip(size: number): void {
    this.offset = size - READ_BYTES;
    this.partial = Buffer.alloc(0);
    this.dropping = true;
    this.lines.push("[Earlier native activity omitted; full journal retained.]");
  }
  private header(fd: number): void {
    const head = Buffer.alloc(4096);
    const count = fs.readSync(fd, head, 0, head.length, 0);
    const lf = head.indexOf(10, 0);
    if (lf < 0 || lf >= count) {
      throw new Error("Native journal header is incomplete or too large.");
    }
    const value: unknown = JSON.parse(head.subarray(0, lf).toString("utf8"));
    if (!record(value) || value.type !== "session" || value.id !== this.sessionId) {
      throw new Error("Native journal identity does not match this child.");
    }
  }
  private line(line: Buffer): void {
    if (line.length > LINE_BYTES) {
      this.lines.push("[Large native entry omitted; read the full journal.]");
      return;
    }
    try {
      const value: unknown = JSON.parse(line.toString("utf8"));
      this.lines.push(...activity(value));
    } catch {
      this.lines.push("[Malformed published native entry omitted.]");
    }
  }
  private consume(chunk: Buffer): void {
    const bytes = Buffer.concat([this.partial, chunk]);
    let start = 0;
    let lf = bytes.indexOf(10);
    while (lf >= 0) {
      if (!this.dropping) {
        this.line(bytes.subarray(start, lf));
      }
      this.dropping = false;
      start = lf + 1;
      lf = bytes.indexOf(10, start);
    }
    this.partial = bytes.subarray(start);
    if (this.partial.length > LINE_BYTES) {
      this.partial = Buffer.alloc(0);
      this.dropping = true;
      this.lines.push("[Large native entry omitted; read the full journal.]");
    }
    this.lines.splice(0, Math.max(0, this.lines.length - KEEP_LINES));
    if (this.partial.length > 0) {
      this.notice = "Waiting for newline publication of the latest native entry.";
    }
  }
  private changed(stat: fs.Stats, identity: string): boolean {
    return (
      identity !== this.identity ||
      stat.size < this.offset ||
      (stat.size === this.offset && stat.mtimeMs !== this.stamp)
    );
  }
  private observe(fd: number, stat: fs.Stats): void {
    const identity = `${stat.dev}:${stat.ino}`;
    if (this.changed(stat, identity)) {
      this.reset(stat.size);
    } else if (stat.size - this.offset > READ_BYTES) {
      this.skip(stat.size);
    }
    this.identity = identity;
    this.stamp = stat.mtimeMs;
    const chunk = Buffer.alloc(Math.min(READ_BYTES, stat.size - this.offset));
    const count = fs.readSync(fd, chunk, 0, chunk.length, this.offset);
    this.offset += count;
    this.notice =
      this.offset > READ_BYTES ? "Recent journal tail only; full journal retained." : "";
    this.consume(chunk.subarray(0, count));
    if (this.lines.length === 0 && this.notice.length === 0) {
      this.notice = "Waiting for published native activity.";
    }
  }
  poll(): void {
    let fd: number | undefined;
    try {
      fd = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) {
        throw new Error("Native journal is not a regular file.");
      }
      this.header(fd);
      this.observe(fd, stat);
    } catch (error) {
      this.lines.length = 0;
      this.identity = "";
      this.notice = error instanceof Error ? plainText(error.message) : "Journal unavailable.";
    } finally {
      if (fd !== undefined) {
        fs.closeSync(fd);
      }
    }
  }
}
