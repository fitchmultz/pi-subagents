import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";

interface WrappedText {
  readonly lines: readonly string[];
  readonly starts: readonly number[];
}
function wrapSegment(segment: string, width: number): WrappedText {
  const lines: string[] = [],
    starts: number[] = [];
  let start = 0,
    offset = 0,
    columns = 0;
  for (const char of segment) {
    const charWidth = visibleWidth(char);
    if (columns > 0 && columns + charWidth > width) {
      lines.push(segment.slice(start, offset));
      starts.push(start);
      start = offset;
      columns = 0;
    }
    offset += char.length;
    columns += charWidth;
  }
  lines.push(segment.slice(start));
  starts.push(start);
  return { lines, starts };
}
function wrapText(text: string, width: number): WrappedText {
  if (width <= 0) {
    return { lines: [text], starts: [0] };
  }
  const lines: string[] = [],
    starts: number[] = [];
  let offset = 0;
  for (const segment of text.split("\n")) {
    const wrapped = wrapSegment(segment, width);
    lines.push(...wrapped.lines);
    starts.push(...wrapped.starts.map((start) => start + offset));
    offset += segment.length + 1;
  }
  if (!text.endsWith("\n") && text.length > 0 && visibleWidth(lines.at(-1) ?? "") === width) {
    starts.push(text.length);
    lines.push("");
  }
  return { lines, starts };
}
function cursorPosition(
  cursor: number,
  starts: readonly number[],
): { readonly line: number; readonly col: number } {
  const line = Math.max(
    0,
    starts.findLastIndex((start) => cursor >= start),
  );
  return { line, col: cursor - (starts[line] ?? 0) };
}
function isWordChar(char: string): boolean {
  return /[A-Za-z0-9_]/.test(char);
}
function wordBackward(buffer: string, cursor: number): number {
  let position = cursor;
  while (position > 0 && !isWordChar(buffer[position - 1] ?? "")) {
    position--;
  }
  while (position > 0 && isWordChar(buffer[position - 1] ?? "")) {
    position--;
  }
  return position;
}
function wordForward(buffer: string, cursor: number): number {
  let position = cursor;
  while (position < buffer.length && isWordChar(buffer[position] ?? "")) {
    position++;
  }
  while (position < buffer.length && !isWordChar(buffer[position] ?? "")) {
    position++;
  }
  return position;
}
function insertText(data: string): string | undefined {
  const text =
    data
      .split("\x1b[200~")
      .join("")
      .split("\x1b[201~")
      .join("")
      .replace(/\r\n?/g, "\n")
      .split("\n")[0]
      ?.replace(/\t/g, "    ") ?? "";
  if (text.length === 0 || Array.from(text).some((char) => char.charCodeAt(0) < 32)) {
    return;
  }
  return text;
}
/** Owns the single-line draft and its viewport; the caller decides commit versus discard. */
export class ClarifyTextEditor {
  private buffer = "";
  private cursor = 0;
  private viewportOffset = 0;
  setText(text: string): void {
    this.buffer = text;
    this.cursor = 0;
    this.viewportOffset = 0;
  }
  getText(): string {
    return this.buffer;
  }
  handleInput(data: string, width: number): void {
    if (matchesKey(data, "return") || matchesKey(data, "tab")) {
      return;
    }
    if (this.moveCursor(data, width) || this.deleteText(data)) {
      return;
    }
    const text = insertText(data);
    if (text !== undefined) {
      this.buffer = this.buffer.slice(0, this.cursor) + text + this.buffer.slice(this.cursor);
      this.cursor += text.length;
    }
  }
  private moveCursor(data: string, width: number): boolean {
    if (matchesKey(data, "alt+left") || matchesKey(data, "ctrl+left")) {
      this.cursor = wordBackward(this.buffer, this.cursor);
      return true;
    }
    if (matchesKey(data, "alt+right") || matchesKey(data, "ctrl+right")) {
      this.cursor = wordForward(this.buffer, this.cursor);
      return true;
    }
    if (matchesKey(data, "left")) {
      this.cursor = Math.max(0, this.cursor - 1);
      return true;
    }
    if (matchesKey(data, "right")) {
      this.cursor = Math.min(this.buffer.length, this.cursor + 1);
      return true;
    }
    if (matchesKey(data, "ctrl+home")) {
      this.cursor = 0;
      return true;
    }
    if (matchesKey(data, "ctrl+end")) {
      this.cursor = this.buffer.length;
      return true;
    }
    return this.moveVisualCursor(data, width);
  }
  private moveVisualCursor(data: string, width: number): boolean {
    const { lines, starts } = wrapText(this.buffer, width);
    const position = cursorPosition(this.cursor, starts);
    if (matchesKey(data, "home")) {
      this.cursor = starts[position.line] ?? 0;
      return true;
    }
    if (matchesKey(data, "end")) {
      this.cursor = (starts[position.line] ?? 0) + (lines[position.line]?.length ?? 0);
      return true;
    }
    const delta = verticalDelta(data);
    if (delta === 0) {
      return false;
    }
    const line = Math.max(0, Math.min(lines.length - 1, position.line + delta));
    this.cursor = visualCursor(line, position.col, { lines, starts });
    return true;
  }
  private deleteText(data: string): boolean {
    if (matchesKey(data, "alt+backspace")) {
      const target = wordBackward(this.buffer, this.cursor);
      this.buffer = this.buffer.slice(0, target) + this.buffer.slice(this.cursor);
      this.cursor = target;
      return true;
    }
    if (matchesKey(data, "backspace")) {
      if (this.cursor > 0) {
        this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor);
        this.cursor--;
      }
      return true;
    }
    if (matchesKey(data, "delete")) {
      this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + 1);
      return true;
    }
    return false;
  }
  render(
    width: number,
    height: number,
  ): { readonly lines: readonly string[]; readonly scrollInfo: string } {
    const { lines, starts } = wrapText(this.buffer, width);
    const position = cursorPosition(this.cursor, starts);
    if (position.line < this.viewportOffset) {
      this.viewportOffset = position.line;
    }
    if (position.line >= this.viewportOffset + height) {
      this.viewportOffset = Math.max(0, position.line - height + 1);
    }
    const rendered = Array.from({ length: height }, (_, index) => {
      const line = this.viewportOffset + index;
      const text = lines[line] ?? "";
      if (line !== position.line) {
        return text;
      }
      return `${text.slice(0, position.col)}\x1b[7m${text[position.col] ?? " "}\x1b[27m${text.slice(position.col + 1)}`;
    });
    const below = lines.length - this.viewportOffset - height;
    const scrollInfo = `${this.viewportOffset > 0 ? "↑" : ""}${below > 0 ? `↓ ${below}+` : ""}`;
    return { lines: rendered, scrollInfo };
  }
}
function visualCursor(line: number, column: number, wrapped: WrappedText): number {
  return (wrapped.starts[line] ?? 0) + Math.min(column, wrapped.lines[line]?.length ?? 0);
}
function verticalDelta(data: string): number {
  if (matchesKey(data, "up")) {
    return -1;
  }
  if (matchesKey(data, "down")) {
    return 1;
  }
  if (matchesKey(data, "shift+up") || matchesKey(data, "pageUp")) {
    return -12;
  }
  if (matchesKey(data, "shift+down") || matchesKey(data, "pageDown")) {
    return 12;
  }
  return 0;
}
