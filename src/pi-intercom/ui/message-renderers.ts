import {
  keyText,
  type ExtensionAPI,
  type Theme,
  type MessageRenderOptions,
} from "@earendil-works/pi-coding-agent";
import {
  MouseRegion,
  Text,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { InlineMessageComponent } from "./inline-message.ts";
import { isMessage, isSessionRegistration, type Message, type SessionInfo } from "../types.ts";
import { isRecord, isUnknownArray } from "../validation.ts";
interface MessageDetails {
  readonly from: SessionInfo;
  readonly message: Message;
  readonly replyCommand?: string;
  readonly bodyText?: string;
  readonly subagentCompletion?: { readonly status: string; readonly runId: string };
}
function completion(value: unknown): MessageDetails["subagentCompletion"] {
  return isRecord(value) && typeof value.status === "string" && typeof value.runId === "string"
    ? { status: value.status, runId: value.runId }
    : undefined;
}
function messageDetails(value: unknown): MessageDetails | undefined {
  if (
    !isRecord(value) ||
    !isRecord(value.from) ||
    typeof value.from.id !== "string" ||
    !isMessage(value.message)
  ) {
    return;
  }
  const id = value.from.id;
  if (!isSessionRegistration(value.from)) {
    return;
  }
  return {
    from: { ...value.from, id },
    message: value.message,
    replyCommand: typeof value.replyCommand === "string" ? value.replyCommand : undefined,
    bodyText: typeof value.bodyText === "string" ? value.bodyText : undefined,
    subagentCompletion: completion(value.subagentCompletion),
  };
}
function contentText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!isUnknownArray(value)) {
    return "";
  }
  return value
    .filter(isRecord)
    .filter((item) => item.type === "text")
    .map((item) => (typeof item.text === "string" ? item.text : ""))
    .join("\n");
}
function attention(details: MessageDetails): boolean {
  return (
    details.from.id === "subagent-control" ||
    details.from.status === "needs_attention" ||
    details.message.expectsReply === true ||
    (details.replyCommand !== undefined && details.replyCommand !== "")
  );
}
function preview(details: MessageDetails): string {
  const sender =
    details.from.name === undefined || details.from.name === ""
      ? details.from.id.slice(0, 8)
      : details.from.name;
  const body =
    details.bodyText === undefined || details.bodyText === ""
      ? details.message.content.text
      : details.bodyText;
  let summary: string;
  if (details.subagentCompletion) {
    summary = `${details.subagentCompletion.status} [${details.subagentCompletion.runId.slice(0, 8)}]`;
  } else if (details.from.id === "subagent-result") {
    summary = body.split("\n").slice(2, 6).join(" · ");
  } else {
    summary = body.split("\n").find((line) => line.trim() !== "") ?? "(no text)";
  }
  return `${sender}: ${summary}`.replace(/\s+/g, " ").trim();
}
class CompactMessage implements Component {
  private width: number | undefined;
  private key: string | undefined;
  private lines: string[] | undefined;
  private readonly theme: Theme;
  private readonly text: string;
  private readonly outputPad: number;
  constructor(theme: Theme, text: string, outputPad: number) {
    this.theme = theme;
    this.text = text;
    this.outputPad = outputPad;
  }
  render(width: number): string[] {
    const key = keyText("app.tools.expand");
    if (this.lines && this.width === width && this.key === key) {
      return this.lines;
    }
    const hint = key !== "" ? this.theme.fg("dim", ` · ${key}`) : "";
    const text = `${" ".repeat(this.outputPad)}${this.theme.fg("accent", "📨 ")}${this.theme.fg("muted", this.text)}`;
    this.width = width;
    this.key = key;
    this.lines = [truncateToWidth(truncateToWidth(text, width - visibleWidth(hint)) + hint, width)];
    return this.lines;
  }
  invalidate(): void {
    this.lines = undefined;
  }
}
function renderContent(
  details: MessageDetails,
  options: Readonly<MessageRenderOptions>,
  theme: Theme,
  expanded: boolean,
): Component {
  const compact = "compactView" in options && options.compactView === true;
  if (compact && !expanded && !attention(details)) {
    return new CompactMessage(theme, preview(details), options.outputPad);
  }
  return new InlineMessageComponent(theme, {
    from: details.from,
    message: details.message,
    replyCommand: details.replyCommand,
    bodyText: details.bodyText,
    expanded: expanded || details.from.id !== "subagent-result" || attention(details),
  });
}
interface Expansion {
  readonly expanded: boolean;
  readonly globalExpanded: boolean;
}
export function registerMessageRenderers(pi: ExtensionAPI): void {
  pi.registerMessageRenderer("subagent-human-message", (message, _options, theme) => {
    const details = isRecord(message.details) ? message.details : undefined;
    const body =
      typeof details?.bodyText === "string" ? details.bodyText : contentText(message.content);
    return new Text(`${theme.fg("accent", theme.bold("User → this agent"))}\n${body}`, 0, 0);
  });
  const expansion = new WeakMap<object, Expansion>();
  pi.registerMessageRenderer("intercom_message", (message, options, theme) => {
    const details = messageDetails(message.details);
    if (!details) {
      return;
    }
    const compact = "compactView" in options && options.compactView === true;
    if (attention(details) || (!compact && details.from.id !== "subagent-result")) {
      return renderContent(details, options, theme, options.expanded);
    }
    let state = expansion.get(message);
    if (!state || state.globalExpanded !== options.expanded) {
      state = { expanded: options.expanded, globalExpanded: options.expanded };
      expansion.set(message, state);
    }
    let expanded = state.expanded;
    let component = renderContent(details, options, theme, expanded);
    return new MouseRegion(
      {
        render: (width) => component.render(width),
        invalidate: () => {
          component.invalidate();
        },
      },
      (event) => {
        if (event.type !== "click" || event.button !== "left") {
          return;
        }
        expanded = !expanded;
        expansion.set(message, { expanded, globalExpanded: options.expanded });
        component = renderContent(details, options, theme, expanded);
        return { handled: true };
      },
    );
  });
}
