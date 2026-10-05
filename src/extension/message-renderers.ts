import {
  keyText,
  type ExtensionAPI,
  type ExtensionContext,
  type MessageRenderOptions,
} from "@earendil-works/pi-coding-agent";
import {
  Box,
  Container,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import { renderSubagentResult } from "../tui/render.ts";
import { withMouseExpansion } from "../tui/action-hints.ts";
import {
  getSlashRenderableSnapshot,
  resolveSlashMessageDetails,
  type SlashMessageDetails,
} from "../slash/slash-live-state.ts";
import type { SubagentNotifyDetails } from "../runs/background/notify.ts";
import { formatDuration, shortenPath } from "../shared/formatters.ts";
import { SLASH_RESULT_TYPE, type SubagentExecutionResult } from "../shared/types.ts";
import type { ReadonlyInput } from "../shared/types/inputs.ts";
import {
  formatSubagentControlNotice,
  SUBAGENT_CONTROL_MESSAGE_TYPE,
  type SubagentControlMessageDetails,
} from "./control-notices.ts";

type Theme = ExtensionContext["ui"]["theme"];
type RenderOptions = Readonly<MessageRenderOptions>;

function compactView(options: RenderOptions): boolean {
  return "compactView" in options && options.compactView === true && !options.expanded;
}

function resultBackground(
  result: ReadonlyInput<SubagentExecutionResult>,
): "toolPendingBg" | "toolErrorBg" | "toolSuccessBg" {
  if (
    result.details.progress?.some((entry) => entry.status === "running") === true ||
    result.details.results.some((entry) => entry.progress?.status === "running")
  ) {
    return "toolPendingBg";
  }
  return result.details.results.some(
    (entry) => entry.exitCode !== 0 && entry.progress?.status !== "running",
  )
    ? "toolErrorBg"
    : "toolSuccessBg";
}

function rebuildSlashResult(
  container: Container,
  result: ReadonlyInput<SubagentExecutionResult>,
  options: RenderOptions,
  theme: Theme,
): void {
  container.clear();
  if (compactView(options)) {
    container.addChild(renderSubagentResult(result, options, theme));
    return;
  }
  container.addChild(new Spacer(1));
  const background = resultBackground(result);
  const box = new Box(1, 1, (text: string) => theme.bg(background, text));
  box.addChild(renderSubagentResult(result, options, theme));
  container.addChild(box);
}

function compactLine(text: string, width: number, options: RenderOptions, theme: Theme): string {
  const key = keyText("app.tools.expand");
  const hint = key.length > 0 ? theme.fg("dim", ` · ${key}`) : "";
  const line = `${" ".repeat(options.outputPad)}${text.replace(/\s+/g, " ").trim()}`;
  return truncateToWidth(truncateToWidth(line, width - visibleWidth(hint)) + hint, width);
}

function createSlashResult(
  details: ReadonlyInput<SlashMessageDetails>,
  options: RenderOptions,
  theme: Theme,
): Container {
  const container = new Container();
  let lastVersion = -1;
  container.render = (width: number): string[] => {
    const snapshot = getSlashRenderableSnapshot(details);
    if (snapshot.version !== lastVersion) {
      lastVersion = snapshot.version;
      rebuildSlashResult(container, snapshot.result, options, theme);
    }
    if (compactView(options)) {
      const key = keyText("app.tools.expand");
      const hint = key.length > 0 ? theme.fg("dim", ` · ${key}`) : "";
      const [heading = ""] = Container.prototype.render.call(
        container,
        Math.max(1, width - options.outputPad - visibleWidth(hint)),
      );
      return [
        truncateToWidth(
          `${" ".repeat(options.outputPad)}${heading.replace(/\s+/g, " ").trimEnd()}${hint}`,
          width,
        ),
      ];
    }
    return Container.prototype.render.call(container, width);
  };
  return container;
}

function isNotifyStatus(status: string | undefined): status is SubagentNotifyDetails["status"] {
  return (
    status === "completed" || status === "failed" || status === "blocked" || status === "paused"
  );
}

function parseNotifyContent(content: string): SubagentNotifyDetails | undefined {
  const lines = content.split("\n");
  const match = (lines.at(0) ?? "").match(
    /^Background task (completed|failed|blocked|paused): \*\*(.+?)\*\*(?:\s+(\([^)]*\)))?$/,
  );
  if (!match) {
    return undefined;
  }
  const status = match.at(1);
  const agent = match.at(2);
  if (agent === undefined || !isNotifyStatus(status)) {
    return undefined;
  }
  const body = lines.slice(2);
  const sessionIndex = sessionLineIndex(body);
  const sessionLine = sessionIndex >= 0 ? body.at(sessionIndex) : undefined;
  const preview = (sessionIndex >= 0 ? body.slice(0, sessionIndex) : body).join("\n").trim();
  const taskInfo = match.at(3);
  return {
    agent,
    status,
    ...(taskInfo !== undefined && taskInfo.length > 0 ? { taskInfo } : {}),
    resultPreview: preview.length > 0 ? preview : "(no output)",
    ...sessionFields(sessionLine),
  };
}

function sessionLineIndex(lines: readonly string[]): number {
  for (let index = lines.length - 1; index >= 1; index--) {
    const previous = lines.at(index - 1);
    const line = lines.at(index);
    if (
      previous?.trim() === "" &&
      line !== undefined &&
      /^(Session|Session file|Session share error):\s+/.test(line)
    ) {
      return index;
    }
  }
  return -1;
}

function sessionFields(
  line: string | undefined,
): Pick<SubagentNotifyDetails, "sessionLabel" | "sessionValue"> {
  if (line === undefined || line.length === 0) {
    return {};
  }
  const separator = line.indexOf(":");
  const sessionLabel = line.slice(0, separator).toLowerCase();
  const sessionValue = line.slice(separator + 1).trim();
  return sessionLabel.length > 0 && sessionValue.length > 0 ? { sessionLabel, sessionValue } : {};
}

function notifyHeading(details: ReadonlyInput<SubagentNotifyDetails>, theme: Theme): string {
  let icon = theme.fg("error", "✗");
  if (details.status === "completed") {
    icon = theme.fg("success", "✓");
  } else if (details.status === "paused" || details.status === "blocked") {
    icon = theme.fg("warning", "■");
  }
  const parts: string[] = [];
  if (details.taskInfo !== undefined && details.taskInfo.length > 0) {
    parts.push(details.taskInfo);
  }
  if (details.durationMs !== undefined) {
    parts.push(formatDuration(details.durationMs));
  }
  const title = `${icon} ${theme.bold(details.agent)} ${theme.fg("dim", details.status)}`;
  return parts.length > 0
    ? `${title} ${theme.fg("dim", "·")} ${parts.map((part) => theme.fg("dim", part)).join(` ${theme.fg("dim", "·")} `)}`
    : title;
}

function compactPreview(text: string, options: RenderOptions, theme: Theme): Component {
  return {
    render: (width) => [compactLine(text, width, options, theme)],
    invalidate() {
      /* Render calculates the current layout on every call. */
    },
  };
}

function notifyBody(
  details: ReadonlyInput<SubagentNotifyDetails>,
  options: RenderOptions,
  theme: Theme,
): string {
  let text = notifyHeading(details, theme);
  const trimmed = details.resultPreview.trim();
  const previewLines = options.expanded
    ? trimmed.split("\n").filter((line) => line.trim().length > 0)
    : trimmed.split("\n", 1).filter((line) => line.trim().length > 0);
  for (const line of previewLines.length > 0 ? previewLines : ["(no output)"]) {
    text += `\n  ${theme.fg("dim", `⎿  ${line}`)}`;
  }
  const key = keyText("app.tools.expand");
  if (!options.expanded && key.length > 0) {
    text += `\n  ${theme.fg("dim", `${key} full notification`)}`;
  }
  if (
    details.sessionLabel !== undefined &&
    details.sessionLabel.length > 0 &&
    details.sessionValue !== undefined &&
    details.sessionValue.length > 0
  ) {
    text += `\n  ${theme.fg("muted", `${details.sessionLabel}: ${shortenPath(details.sessionValue)}`)}`;
  }
  return text;
}

function renderNotify(
  content: string,
  details: ReadonlyInput<SubagentNotifyDetails> | undefined,
  options: RenderOptions,
  theme: Theme,
): Component {
  if (!details) {
    const preview = content.split("\n").find((line) => line.trim().length > 0) ?? "(no output)";
    return compactView(options) ? compactPreview(preview, options, theme) : new Text(content, 0, 0);
  }
  if (compactView(options)) {
    const preview = details.resultPreview.trim().split("\n", 1).at(0) ?? "";
    return compactPreview(
      `${notifyHeading(details, theme)} · ${theme.fg("dim", preview.length > 0 ? preview : "(no output)")}`,
      options,
      theme,
    );
  }
  const text = notifyBody(details, options, theme);
  return options.expanded
    ? new Text(text, 0, 0)
    : {
        render: (width) => text.split("\n").map((line) => truncateToWidth(line, width)),
        invalidate() {
          /* Width-dependent rendering has no cached layout. */
        },
      };
}

class ControlNoticeComponent implements Component {
  private readonly details: ReadonlyInput<SubagentControlMessageDetails>;
  private readonly theme: Theme;

  constructor(details: ReadonlyInput<SubagentControlMessageDetails>, theme: Theme) {
    this.details = details;
    this.theme = theme;
  }

  invalidate(): void {
    /* Rendering is computed from immutable notice data. */
  }

  render(width: number): string[] {
    const eventLabel = this.details.event.type.replaceAll("_", " ");
    if (width < 3) {
      return [truncateToWidth(`Subagent ${eventLabel}`, width)];
    }
    const bodyWidth = Math.max(1, width - 2);
    const header = truncateToWidth(
      ` ⚠ Subagent ${eventLabel}: ${this.details.event.agent} `,
      bodyWidth,
      "",
    );
    const lines = [
      this.theme.fg(
        "accent",
        `╭${header}${"─".repeat(Math.max(0, bodyWidth - visibleWidth(header)))}╮`,
      ),
    ];
    for (const line of wrapTextWithAnsi(formatSubagentControlNotice(this.details), bodyWidth)) {
      const text = truncateToWidth(line, bodyWidth, "");
      lines.push(
        this.theme.fg(
          "accent",
          `│${text}${" ".repeat(Math.max(0, bodyWidth - visibleWidth(text)))}│`,
        ),
      );
    }
    lines.push(this.theme.fg("accent", `╰${"─".repeat(bodyWidth)}╯`));
    return lines;
  }
}

export function registerMessageRenderers(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<SlashMessageDetails>(
    SLASH_RESULT_TYPE,
    withMouseExpansion((message, options, theme) => {
      const details = resolveSlashMessageDetails(message.details);
      if (details) {
        return createSlashResult(details, options, theme);
      }
      return;
    }),
  );
  pi.registerMessageRenderer<SubagentNotifyDetails | undefined>(
    "subagent-notify",
    withMouseExpansion((message, options, theme) => {
      const content = typeof message.content === "string" ? message.content : "";
      return renderNotify(content, message.details ?? parseNotifyContent(content), options, theme);
    }),
  );
  pi.registerMessageRenderer<Partial<SubagentControlMessageDetails> | undefined>(
    SUBAGENT_CONTROL_MESSAGE_TYPE,
    (message, _options, theme) => {
      const details = message.details;
      if (!details?.event) {
        return;
      }
      const notice = { ...details, event: details.event };
      const content = typeof message.content === "string" ? message.content : undefined;
      return new ControlNoticeComponent(
        { ...notice, noticeText: formatSubagentControlNotice(notice, content) },
        theme,
      );
    },
  );
}
