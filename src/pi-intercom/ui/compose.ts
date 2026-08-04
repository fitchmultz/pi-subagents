import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { IntercomClient } from "../broker/client.ts";
import type { SessionInfo } from "../types.ts";

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

export interface ComposeResult {
  sent: boolean;
  messageId?: string;
  text?: string;
  expectsReply?: boolean;
}

export class ComposeOverlay implements Component {
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

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    target: SessionInfo,
    targetLabel: string,
    client: IntercomClient,
    done: (result: ComposeResult) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.target = target;
    this.targetLabel = targetLabel;
    this.client = client;
    this.done = done;
  }

  invalidate(): void {}

  private finish(result: ComposeResult): void {
    if (this.completed) return;
    this.completed = true;
    this.done(result);
  }

  handleInput(data: string): void {
    if (this.sending || this.completed) return;

    const pasted = data.startsWith(BRACKETED_PASTE_START) && data.endsWith(BRACKETED_PASTE_END);
    if (pasted) {
      data = data.slice(BRACKETED_PASTE_START.length, -BRACKETED_PASTE_END.length).replace(/\r\n?/g, "\n");
    } else if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.finish({ sent: false });
      return;
    }
    if (!data) return;

    if (!pasted && data === "\t") {
      this.mode = this.mode === "send" ? "ask" : "send";
      this.tui.requestRender();
      return;
    }

    if (!pasted && data.startsWith("\x1b")) {
      return;
    }

    if (!pasted && this.keybindings.matches(data, "tui.select.confirm")) {
      if (this.inputBuffer.length > 0) {
        void this.sendMessage();
      }
      return;
    }

    if (!pasted && this.keybindings.matches(data, "tui.editor.deleteCharBackward")) {
      this.inputBuffer = [...this.inputBuffer].slice(0, -1).join("");
      this.tui.requestRender();
      return;
    }

    const printable = [...data].filter(c => c >= " " || c === "\n" || c === "\t").join("");
    if (printable) {
      this.inputBuffer += printable;
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

  private renderInputLines(row: (text?: string) => string, lines: string[]): void {
    const rawLines = this.inputBuffer.split("\n");
    const visibleLines = rawLines.slice(-8);
    visibleLines.forEach((line, index) => {
      const isLast = index === visibleLines.length - 1;
      lines.push(row(`${index === 0 ? " > " : "   "}${line}${isLast ? "█" : ""}`));
    });
  }

  render(width: number): string[] {
    if (width < 3) return [truncateToWidth("Intercom", width)];
    const innerWidth = Math.min(width, 72);
    const contentWidth = Math.max(1, innerWidth - 2);
    const footer = `${this.keybindings.getKeys("tui.select.confirm").join("/")}: ${this.mode === "ask" ? "Request reply" : "Send"} • Tab: ${this.mode === "ask" ? "Send mode" : "Request-reply mode"} • ${this.keybindings.getKeys("tui.select.cancel").join("/")}: Close`;
    const border = (text: string) => this.theme.fg("accent", text);
    const row = (text = "") => {
      const clipped = truncateToWidth(text, contentWidth, "", true);
      return `${border("│")}${clipped}${" ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)))}${border("│")}`;
    };

    const lines: string[] = [];
    lines.push(border(`╭${"─".repeat(contentWidth)}╮`));
    lines.push(row(this.theme.bold(` ${this.mode === "ask" ? "Request reply" : "Send"} to: ${this.targetLabel}`)));
    lines.push(row(this.theme.fg("dim", ` ${this.target.cwd} • ${this.target.model}`)));
    lines.push(border(`├${"─".repeat(contentWidth)}┤`));
    lines.push(row());

    if (this.sending) {
      lines.push(row(this.theme.fg("dim", " Sending...")));
    } else if (this.error) {
      lines.push(row(this.theme.fg("error", ` Error: ${this.error}`)));
      lines.push(row());
      this.renderInputLines(row, lines);
    } else {
      this.renderInputLines(row, lines);
    }

    lines.push(row());
    lines.push(border(`├${"─".repeat(contentWidth)}┤`));
    lines.push(row(this.theme.fg("dim", ` ${footer}`)));
    lines.push(border(`╰${"─".repeat(contentWidth)}╯`));

    return lines;
  }
}
