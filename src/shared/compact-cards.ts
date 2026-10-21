import {
  getMarkdownTheme,
  keyHint,
  truncateToVisualLines,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  Box,
  Markdown,
  Spacer,
  Text,
  truncateToWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { actionText } from "./tui-action.ts";

function preview(text: string, expanded: boolean, theme: Theme, showHint = true): Component {
  if (expanded) {
    return new Text(text, 0, 0);
  }
  let cache: { width: number; lines: string[] } | undefined;
  return {
    render(width) {
      if (cache?.width !== width) {
        const { visualLines, skippedCount } = truncateToVisualLines(text, 4, width, 0, "start");
        const hint = theme.fg(
          "dim",
          `… ${skippedCount} more lines${showHint ? ` · ${keyHint("app.tools.expand", "to expand")}` : ""}`,
        );
        cache = {
          width,
          lines: skippedCount > 0 ? [...visualLines, truncateToWidth(hint, width)] : visualLines,
        };
      }
      return cache.lines;
    },
    invalidate() {
      cache = undefined;
    },
  };
}

export const renderCompactResult: NonNullable<ToolDefinition["renderResult"]> = (
  result,
  { expanded },
  theme,
) =>
  preview(
    theme.fg(
      "toolOutput",
      result.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n"),
    ),
    expanded,
    theme,
  );

export function registerCompactMessages(pi: ExtensionAPI, types: readonly string[]): void {
  let ui: ExtensionContext["ui"] | undefined;
  pi.on("session_start", (_event, ctx) => {
    ui = ctx.mode === "tui" ? ctx.ui : undefined;
  });
  pi.on("session_shutdown", () => {
    ui = undefined;
  });
  for (const type of types) {
    pi.registerMessageRenderer(type, (message, { expanded, outputPad }, theme) => {
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("\n");
      const box = new Box(outputPad, 1, (line) => theme.bg("customMessageBg", line));
      box.addChild(
        actionText(
          `${theme.fg("customMessageLabel", theme.bold(`[${type}]`))} · ${keyHint("app.tools.expand", expanded ? "to collapse" : "to expand")}`,
          () => ui?.setToolsExpanded(!expanded),
        ),
      );
      box.addChild(new Spacer(1));
      box.addChild(
        expanded
          ? new Markdown(text, 0, 0, getMarkdownTheme(), {
              color: (line) => theme.fg("customMessageText", line),
            })
          : preview(theme.fg("customMessageText", text), false, theme, false),
      );
      return box;
    });
  }
}
