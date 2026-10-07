import {
  type TUI,
  type TuiMouseEvent,
  Box,
  Container,
  Text,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { actionHints } from "../../tui/action-hints.ts";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { IntercomClient } from "../broker/client.ts";
import type { SessionInfo } from "../types.ts";

import { ComposePaste, printableInput, PASTE_RENDER_TAIL_CHARS } from "./compose-paste.ts";
import { errorMessage } from "../../shared/unknown.ts";

export interface ComposeResult {
  readonly sent: boolean;
  readonly messageId?: string;
  readonly text?: string;
  readonly expectsReply?: boolean;
}

export interface ComposeOptions {
  readonly keybindings: KeybindingsManager;
  readonly target: SessionInfo;
  readonly targetLabel: string;
  readonly client: { readonly send: IntercomClient["send"] };
  readonly done: (result: ComposeResult) => void;
}

export class ComposeOverlay extends Container {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly options: ComposeOptions;
  private readonly paste: ComposePaste;
  private inputBuffer: string = "";
  private mode: "send" | "ask" = "send";
  private completed = false;
  private sending: boolean = false;
  private error: string | null = null;

  constructor(tui: TUI, theme: Theme, options: ComposeOptions) {
    super();
    this.tui = tui;
    this.theme = theme;
    this.options = options;
    this.paste = new ComposePaste({
      flush: (text) => {
        if (this.completed) {
          return;
        }
        this.inputBuffer += text;
        this.error = null;
        this.tui.requestRender();
      },
      escape: (prefix) => {
        if (this.options.keybindings.matches(prefix, "tui.select.cancel")) {
          this.finish({ sent: false });
        }
      },
      render: () => this.tui.requestRender(),
    });
  }

  dispose(): void {
    this.completed = true;
    this.paste.dispose();
  }

  handleMouse(event: Readonly<TuiMouseEvent>): ReturnType<Container["handleMouse"]> {
    const width = Math.min(event.width, 72);
    if (this.sending || this.completed || this.paste.busy || event.x >= width) {
      return;
    }
    return super.handleMouse({ ...event, width });
  }

  private act(action: "close" | "mode" | "send"): void {
    if (this.sending || this.completed || this.paste.busy) {
      return;
    }
    if (action === "close") {
      this.finish({ sent: false });
    } else if (action === "mode") {
      this.mode = this.mode === "send" ? "ask" : "send";
      this.error = null;
    } else if (this.inputBuffer.trim().length > 0) {
      this.sendMessage().catch((error: unknown) => {
        if (this.completed) {
          return;
        }
        this.error = errorMessage(error);
        this.sending = false;
        this.tui.requestRender();
      });
    }
    this.tui.requestRender();
  }

  private finish(result: ComposeResult): void {
    if (this.completed) {
      return;
    }
    this.dispose();
    this.options.done(result);
  }

  handleInput(input: string): void {
    if (this.sending || this.completed || input.length === 0) {
      return;
    }
    const normalized = this.paste.consume(input);
    if (!normalized || normalized.text.length === 0) {
      return;
    }
    const { text: data, pasted } = normalized;

    if (!pasted && this.handleEditorKey(data)) {
      return;
    }
    const printable = printableInput(data);
    if (printable.length > 0) {
      this.inputBuffer += printable;
      this.error = null;
      this.tui.requestRender();
    }
  }

  private handleEditorKey(data: string): boolean {
    const keybindings = this.options.keybindings;
    if (keybindings.matches(data, "tui.select.cancel")) {
      this.act("close");
      return true;
    }
    if (data === "\t") {
      this.act("mode");
      return true;
    }
    if (keybindings.matches(data, "tui.select.confirm")) {
      this.act("send");
      return true;
    }
    if (data.startsWith("\x1b")) {
      return true;
    }
    if (keybindings.matches(data, "tui.editor.deleteCharBackward")) {
      const graphemes = Array.from(
        new Intl.Segmenter().segment(this.inputBuffer),
        (part) => part.segment,
      );
      this.inputBuffer = graphemes.slice(0, -1).join("");
      this.error = null;
      this.tui.requestRender();
      return true;
    }
    return false;
  }

  private async sendMessage(): Promise<void> {
    this.sending = true;
    this.error = null;
    this.tui.requestRender();

    try {
      const expectsReply = this.mode === "ask";
      const text = this.inputBuffer;
      const result = await this.options.client.send(this.options.target.id, {
        text,
        expectsReply,
      });
      if (this.completed) {
        return;
      }

      if (!result.accepted) {
        this.error =
          result.reason ?? "Message not delivered. Session may not exist or has disconnected.";
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
      if (this.completed) {
        return;
      }
      this.error = errorMessage(error);
      this.sending = false;
      this.tui.requestRender();
    }
  }

  private renderInputLines(row: (text?: string) => string, contentWidth: number): string[] {
    const pendingPaste = this.paste.preview;
    const rawLines = `${this.inputBuffer.slice(-PASTE_RENDER_TAIL_CHARS)}${pendingPaste}`.split(
      "\n",
    );
    const visibleLines = rawLines.slice(-8);
    return visibleLines.map((line, index) => {
      const isLast = index === visibleLines.length - 1;
      const prefix = index === 0 ? " > " : "   ";
      let visibleLine = line;
      if (isLast) {
        const graphemes = Array.from(new Intl.Segmenter().segment(line), (part) => part.segment);
        const budget = Math.max(1, contentWidth - prefix.length - 1);
        let used = 0;
        let start = graphemes.length;
        while (start > 0) {
          const width = visibleWidth(graphemes[start - 1] ?? "");
          if (used + width > budget) {
            break;
          }
          used += width;
          start--;
        }
        visibleLine = graphemes.slice(start).join("");
      }
      return row(`${prefix}${visibleLine}${isLast ? "█" : ""}`);
    });
  }

  render(width: number): string[] {
    this.clear();
    if (width < 3) {
      return [truncateToWidth("Intercom", width)];
    }
    const innerWidth = Math.min(width, 72);
    const contentWidth = Math.max(1, innerWidth - 2);
    const send = [
      this.options.keybindings.getKeys("tui.select.confirm").join("/"),
      this.mode === "ask" ? "Request reply" : "Send",
    ]
      .filter(Boolean)
      .join(": ");
    const mode = `Tab: ${this.mode === "ask" ? "Send mode" : "Request-reply mode"}`;
    const close = [this.options.keybindings.getKeys("tui.select.cancel").join("/"), "Close"]
      .filter(Boolean)
      .join(": ");
    let footer: Parameters<typeof actionHints>[0] = [
      { text: send, run: () => this.act("send") },
      " • ",
      { text: mode, run: () => this.act("mode") },
      " • ",
      { text: close, run: () => this.act("close") },
    ];
    if (this.sending) {
      footer = ["Sending…"];
    } else if (this.paste.busy) {
      footer = ["Pasting…"];
    }
    const border = (text: string) => this.theme.fg("accent", text);
    const row = (text = "") => {
      const clipped = truncateToWidth(text, contentWidth, "…", true);
      return `${border("│")}${clipped}${" ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)))}${border("│")}`;
    };

    const lines: string[] = [];
    lines.push(border(`╭${"─".repeat(contentWidth)}╮`));
    lines.push(
      row(
        this.theme.bold(
          ` ${this.mode === "ask" ? "Request reply" : "Send"} to: ${this.options.targetLabel}`,
        ),
      ),
    );
    lines.push(
      row(
        this.theme.fg(
          "dim",
          ` Native session cwd: ${this.options.target.cwd} • ${this.options.target.model}`,
        ),
      ),
    );
    lines.push(border(`├${"─".repeat(contentWidth)}┤`));
    lines.push(row());

    if (this.sending) {
      lines.push(row(this.theme.fg("dim", " Sending...")));
    } else if (this.error !== null) {
      lines.push(row(this.theme.fg("error", ` Error: ${this.error}`)));
      lines.push(row());
      lines.push(...this.renderInputLines(row, contentWidth));
    } else {
      lines.push(...this.renderInputLines(row, contentWidth));
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
