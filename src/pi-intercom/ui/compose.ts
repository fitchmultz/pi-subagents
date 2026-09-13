import type { TUI, TuiMouseEvent } from "@earendil-works/pi-tui";
import { Box, Container, Text, sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { actionHints } from "../../tui/action-hints.ts";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { IntercomClient } from "../broker/client.ts";
import type { SessionInfo } from "../types.ts";

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const MAX_PASTE_CHARS = 1_000_000;
const INCOMPLETE_PASTE_IDLE_MS = 200;
const PASTE_RENDER_TAIL_CHARS = 8192;

export interface ComposeResult {
  sent: boolean;
  messageId?: string;
  text?: string;
  expectsReply?: boolean;
}

export class ComposeOverlay extends Container {
  private tui: TUI;
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private target: SessionInfo;
  private targetLabel: string;
  private client: IntercomClient;
  private done: (result: ComposeResult) => void;
  private inputBuffer: string = "";
  private mode: "send" | "ask" = "send";
  private completed = false;
  private sending: boolean = false;
  private error: string | null = null;
  private pasteBuffer: string | null = null;
  private pasteStartPrefix = "";
  private pasteIdleTimer: NodeJS.Timeout | null = null;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    target: SessionInfo,
    targetLabel: string,
    client: IntercomClient,
    done: (result: ComposeResult) => void,
  ) {
    super();
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.target = target;
    this.targetLabel = targetLabel;
    this.client = client;
    this.done = done;
  }

  dispose(): void {
    this.completed = true;
    if (this.pasteIdleTimer) clearTimeout(this.pasteIdleTimer);
    this.pasteIdleTimer = null;
  }

  handleMouse(event: TuiMouseEvent) {
    const width = Math.min(event.width, 72);
    if (this.sending || this.completed || this.pasteBuffer !== null || this.pasteStartPrefix || event.x >= width) return;
    return super.handleMouse({ ...event, width });
  }

  private act(action: "close" | "mode" | "send"): void {
    if (this.sending || this.completed || this.pasteBuffer !== null || this.pasteStartPrefix) return;
    if (action === "close") this.finish({ sent: false });
    else if (action === "mode") { this.mode = this.mode === "send" ? "ask" : "send"; this.error = null; }
    else if (this.inputBuffer.trim()) void this.sendMessage();
    this.tui.requestRender();
  }

  private finish(result: ComposeResult): void {
    if (this.completed) return;
    this.dispose();
    this.done(result);
  }

  private scheduleIncompletePasteFlush(): void {
    if (this.pasteIdleTimer) clearTimeout(this.pasteIdleTimer);
    this.pasteIdleTimer = setTimeout(() => {
      this.pasteIdleTimer = null;
      if (this.pasteBuffer === null || this.completed) return;
      const data = this.pasteBuffer.replace(/\r\n?/g, "\n");
      this.pasteBuffer = null;
      const printable = [...data].filter((character) => character >= " " || character === "\n" || character === "\t").join("");
      if (printable) this.inputBuffer += printable;
      this.error = null;
      this.tui.requestRender();
    }, INCOMPLETE_PASTE_IDLE_MS);
    this.pasteIdleTimer.unref?.();
  }

  handleInput(data: string): void {
    if (this.sending || this.completed || !data) return;

    let pasted = false;
    if (this.pasteBuffer !== null) {
      this.pasteBuffer += data;
      const end = this.pasteBuffer.indexOf(BRACKETED_PASTE_END);
      if (end === -1 && this.pasteBuffer.length <= MAX_PASTE_CHARS) {
        this.scheduleIncompletePasteFlush();
        this.tui.requestRender();
        return;
      }
      data = end === -1
        ? this.pasteBuffer
        : this.pasteBuffer.slice(0, end) + this.pasteBuffer.slice(end + BRACKETED_PASTE_END.length);
      this.pasteBuffer = null;
      if (this.pasteIdleTimer) clearTimeout(this.pasteIdleTimer);
      this.pasteIdleTimer = null;
      data = data.replace(/\r\n?/g, "\n");
      pasted = true;
    } else {
      if (this.pasteStartPrefix) {
        if (this.pasteIdleTimer) clearTimeout(this.pasteIdleTimer);
        this.pasteIdleTimer = null;
        data = this.pasteStartPrefix + data;
        this.pasteStartPrefix = "";
      }
      if (data !== BRACKETED_PASTE_START && BRACKETED_PASTE_START.startsWith(data)) {
        this.pasteStartPrefix = data;
        this.pasteIdleTimer = setTimeout(() => {
          this.pasteIdleTimer = null;
          const pendingPrefix = this.pasteStartPrefix;
          this.pasteStartPrefix = "";
          if (pendingPrefix === "\x1b" && this.keybindings.matches(pendingPrefix, "tui.select.cancel")) this.finish({ sent: false });
        }, INCOMPLETE_PASTE_IDLE_MS);
        this.pasteIdleTimer.unref?.();
        return;
      }
    }
    if (!pasted && data.startsWith(BRACKETED_PASTE_START)) {
      const body = data.slice(BRACKETED_PASTE_START.length);
      const end = body.indexOf(BRACKETED_PASTE_END);
      if (end === -1 && body.length <= MAX_PASTE_CHARS) {
        this.pasteBuffer = body;
        this.scheduleIncompletePasteFlush();
        this.tui.requestRender();
        return;
      }
      data = end === -1 ? body : body.slice(0, end) + body.slice(end + BRACKETED_PASTE_END.length);
      data = data.replace(/\r\n?/g, "\n");
      pasted = true;
    }
    if (!pasted && data.includes(BRACKETED_PASTE_END)) data = data.replaceAll(BRACKETED_PASTE_END, "");
    if (!data) return;

    if (!pasted && this.keybindings.matches(data, "tui.select.cancel")) {
      this.act("close");
      return;
    }

    if (!pasted && data === "\t") {
      this.act("mode");
      return;
    }

    if (!pasted && this.keybindings.matches(data, "tui.select.confirm")) {
      this.act("send");
      return;
    }

    if (!pasted && data.startsWith("\x1b")) {
      return;
    }

    if (!pasted && this.keybindings.matches(data, "tui.editor.deleteCharBackward")) {
      this.inputBuffer = [...this.inputBuffer].slice(0, -1).join("");
      this.error = null;
      this.tui.requestRender();
      return;
    }

    const printable = [...data].filter(c => c >= " " || c === "\n" || c === "\t").join("");
    if (printable) {
      this.inputBuffer += printable;
      this.error = null;
      this.tui.requestRender();
    }
  }

  private async sendMessage(): Promise<void> {
    this.sending = true;
    this.error = null;
    this.tui.requestRender();

    try {
      const expectsReply = this.mode === "ask";
      const text = this.inputBuffer;
      const result = await this.client.send(this.target.id, {
        text,
        expectsReply,
      });

      if (!result.accepted) {
        this.error = result.reason ?? "Message not delivered. Session may not exist or has disconnected.";
        this.sending = false;
        this.tui.requestRender();
        return;
      }

      this.finish({
        sent: true,
        messageId: result.id,
        text,
        expectsReply,
      });
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.sending = false;
      this.tui.requestRender();
    }
  }

  private renderInputLines(row: (text?: string) => string, lines: string[], contentWidth: number): void {
    const pendingPaste = this.pasteBuffer === null
      ? ""
      : [...this.pasteBuffer.slice(-PASTE_RENDER_TAIL_CHARS)].filter((character) => character >= " " || character === "\n" || character === "\t").join("");
    const rawLines = `${this.inputBuffer.slice(-PASTE_RENDER_TAIL_CHARS)}${pendingPaste}`.split("\n");
    const visibleLines = rawLines.slice(-8);
    visibleLines.forEach((line, index) => {
      const isLast = index === visibleLines.length - 1;
      const prefix = index === 0 ? " > " : "   ";
      if (isLast) {
        const graphemes = [...line];
        const budget = Math.max(1, contentWidth - prefix.length - 1);
        let used = 0;
        let start = graphemes.length;
        while (start > 0) {
          const width = visibleWidth(graphemes[start - 1]!);
          if (used + width > budget) break;
          used += width;
          start--;
        }
        line = graphemes.slice(start).join("");
      }
      lines.push(row(`${prefix}${line}${isLast ? "█" : ""}`));
    });
  }

  render(width: number): string[] {
    this.clear();
    if (width < 3) return [truncateToWidth("Intercom", width)];
    const innerWidth = Math.min(width, 72);
    const contentWidth = Math.max(1, innerWidth - 2);
    const send = [this.keybindings.getKeys("tui.select.confirm").join("/"), this.mode === "ask" ? "Request reply" : "Send"].filter(Boolean).join(": ");
    const mode = `Tab: ${this.mode === "ask" ? "Send mode" : "Request-reply mode"}`;
    const close = [this.keybindings.getKeys("tui.select.cancel").join("/"), "Close"].filter(Boolean).join(": ");
    const footer = this.sending ? ["Sending…"] : this.pasteBuffer !== null || this.pasteStartPrefix ? ["Pasting…"] : [
      { text: send, run: () => this.act("send") }, " • ", { text: mode, run: () => this.act("mode") }, " • ", { text: close, run: () => this.act("close") },
    ];
    const border = (text: string) => this.theme.fg("accent", text);
    const row = (text = "") => {
      const clipped = truncateToWidth(text, contentWidth, "…", true);
      return `${border("│")}${clipped}${" ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)))}${border("│")}`;
    };

    const lines: string[] = [];
    lines.push(border(`╭${"─".repeat(contentWidth)}╮`));
    lines.push(row(this.theme.bold(` ${this.mode === "ask" ? "Request reply" : "Send"} to: ${this.targetLabel}`)));
    lines.push(row(this.theme.fg("dim", ` Native session cwd: ${this.target.cwd} • ${this.target.model}`)));
    lines.push(border(`├${"─".repeat(contentWidth)}┤`));
    lines.push(row());

    if (this.sending) {
      lines.push(row(this.theme.fg("dim", " Sending...")));
    } else if (this.error) {
      lines.push(row(this.theme.fg("error", ` Error: ${this.error}`)));
      lines.push(row());
      this.renderInputLines(row, lines, contentWidth);
    } else {
      this.renderInputLines(row, lines, contentWidth);
    }

    lines.push(row());
    lines.push(border(`├${"─".repeat(contentWidth)}┤`));
    this.addChild(new Text(lines.join("\n"), 0, 0));
    const controls = new Box(1, 0, (line) => row(sliceByColumn(line, 1, contentWidth)));
    controls.addChild(actionHints([" ", ...footer], (text) => this.theme.fg("dim", text), "…"));
    this.addChild(controls);
    this.addChild(new Text(border(`╰${"─".repeat(contentWidth)}╯`), 0, 0));
    return super.render(innerWidth);
  }
}
