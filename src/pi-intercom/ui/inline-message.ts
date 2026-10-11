import {
  type Component,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { keyText, type Theme } from "@earendil-works/pi-coding-agent";
import type { SessionInfo, Message } from "../types.ts";

export interface InlineMessageOptions {
  readonly from: SessionInfo;
  readonly message: Message;
  readonly replyCommand?: string;
  readonly bodyText?: string;
  readonly expanded?: boolean;
}

export class InlineMessageComponent implements Component {
  private cachedWidth?: number;
  private cachedLines?: string[];
  private readonly expanded: boolean;

  private readonly theme: Theme;
  private readonly options: InlineMessageOptions;

  constructor(theme: Theme, options: InlineMessageOptions) {
    this.theme = theme;
    this.options = options;
    this.expanded = options.expanded ?? true;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  private row(line: string, width: number): string {
    const text = truncateToWidth(line, width, "");
    return this.theme.fg(
      "accent",
      `│${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}│`,
    );
  }

  private bodyLines(width: number): string[] {
    const body =
      (this.options.bodyText ?? "").length > 0
        ? (this.options.bodyText ?? "")
        : this.options.message.content.text;
    // Grouped results start with run, mode, status and child counts after the title.
    const lines = this.expanded ? wrapTextWithAnsi(body, width) : body.split("\n").slice(2, 6);
    if (!this.expanded) {
      lines.push(this.theme.fg("dim", `${keyText("app.tools.expand")} full response`));
    }
    return lines;
  }

  private replyHint(width: number): string[] {
    const command = this.options.replyCommand ?? "";
    if (command.length === 0) {
      return [];
    }
    return ["", ...wrapTextWithAnsi(this.theme.fg("dim", ` ↩ To reply: ${command}`), width)];
  }

  private footerLines(width: number): string[] {
    const lines = this.replyHint(width);
    const { bodyText, message } = this.options;
    const attachments = message.content.attachments ?? [];
    if (attachments.length > 0 && (bodyText ?? "").length === 0) {
      lines.push("");
      for (const attachment of attachments) {
        lines.push(this.theme.fg("dim", ` 📎 ${attachment.name}`));
      }
    }
    const replyTo = message.replyTo ?? "";
    if (replyTo.length > 0 && message.expectsReply !== true) {
      lines.push("", this.theme.fg("dim", ` ↳ Reply to ${replyTo.slice(0, 8)}`));
    }
    return lines;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }
    const { from } = this.options;
    const senderName = (from.name ?? "").length > 0 ? (from.name ?? "") : from.id.slice(0, 8);
    let lines: string[];
    if (width < 3) {
      lines = [truncateToWidth(`From ${senderName}`, width)];
    } else {
      const bodyWidth = Math.max(1, width - 2);
      const header = truncateToWidth(
        ` 📨 From: ${senderName} (Native session cwd: ${from.cwd}) `,
        bodyWidth,
        "",
      );
      const padding = Math.max(0, bodyWidth - visibleWidth(header));
      lines = [this.theme.fg("accent", `╭${header}${"─".repeat(padding)}╮`)];
      for (const line of [...this.bodyLines(bodyWidth), ...this.footerLines(bodyWidth)]) {
        lines.push(this.row(line, bodyWidth));
      }
      lines.push(this.theme.fg("accent", `╰${"─".repeat(bodyWidth)}╯`));
    }
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }
}
