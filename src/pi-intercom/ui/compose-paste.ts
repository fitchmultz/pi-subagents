const START = "\x1b[200~";
const END = "\x1b[201~";
const MAX_PASTE_CHARS = 1_000_000;
const IDLE_MS = 200;
export const PASTE_RENDER_TAIL_CHARS = 8192;

export function printableInput(text: string): string {
  return Array.from(text)
    .filter((character) => character >= " " || character === "\n" || character === "\t")
    .join("");
}

interface PasteHandlers {
  readonly flush: (text: string) => void;
  readonly escape: (prefix: string) => void;
  readonly render: () => void;
}

/** Owns split bracketed-paste prefixes, bounded buffering and the idle fallback timer. */
export class ComposePaste {
  private buffer: string | null = null;
  private prefix = "";
  private timer: NodeJS.Timeout | null = null;

  private readonly handlers: PasteHandlers;

  constructor(handlers: PasteHandlers) {
    this.handlers = handlers;
  }

  dispose(): void {
    this.clearTimer();
  }
  get busy(): boolean {
    return this.buffer !== null || this.prefix.length > 0;
  }
  get preview(): string {
    return printableInput(this.buffer?.slice(-PASTE_RENDER_TAIL_CHARS) ?? "");
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = null;
  }

  private waitForBody(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.buffer === null) {
        return;
      }
      const text = printableInput(this.buffer.replace(/\r\n?/g, "\n"));
      this.buffer = null;
      this.handlers.flush(text);
    }, IDLE_MS);
    this.timer.unref();
    this.handlers.render();
  }

  private waitForPrefix(text: string): void {
    this.prefix = text;
    this.timer = setTimeout(() => {
      this.timer = null;
      const prefix = this.prefix;
      this.prefix = "";
      if (prefix === "\x1b") {
        this.handlers.escape(prefix);
      }
    }, IDLE_MS);
    this.timer.unref();
  }

  private consumeBody(body: string): string | undefined {
    const end = body.indexOf(END);
    if (end === -1 && body.length <= MAX_PASTE_CHARS) {
      this.buffer = body;
      this.waitForBody();
      return;
    }
    this.buffer = null;
    this.clearTimer();
    const text = end === -1 ? body : body.slice(0, end) + body.slice(end + END.length);
    return text.replace(/\r\n?/g, "\n");
  }

  consume(input: string): { readonly text: string; readonly pasted: boolean } | undefined {
    if (this.buffer !== null) {
      const text = this.consumeBody(this.buffer + input);
      return text === undefined ? undefined : { text, pasted: true };
    }
    const text = this.prefix + input;
    if (this.prefix.length > 0) {
      this.clearTimer();
      this.prefix = "";
    }
    if (text !== START && START.startsWith(text)) {
      this.waitForPrefix(text);
      return;
    }
    if (text.startsWith(START)) {
      const body = this.consumeBody(text.slice(START.length));
      return body === undefined ? undefined : { text: body, pasted: true };
    }
    return { text: text.replaceAll(END, ""), pasted: false };
  }
}
