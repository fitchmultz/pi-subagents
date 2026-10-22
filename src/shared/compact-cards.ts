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
  Container,
  Markdown,
  Spacer,
  Text,
  truncateToWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { actionText } from "./tui-action.ts";

function preview(content: Component, expanded: boolean, theme: Theme, showHint = true): Component {
  if (expanded) {
    return content;
  }
  let cache: { width: number; lines: string[] } | undefined;
  return {
    render(width) {
      if (cache?.width !== width) {
        const { visualLines, skippedCount } = truncateToVisualLines(
          content.render(width).join("\n"),
          4,
          width,
          0,
          "start",
        );
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
      content.invalidate();
    },
  };
}

export const renderCompactResult: NonNullable<ToolDefinition["renderResult"]> = (
  result,
  { expanded },
  theme,
) =>
  preview(
    new Text(
      theme.fg(
        "toolOutput",
        result.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n"),
      ),
      0,
      0,
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
      const markdown = new Markdown(text, 0, 0, getMarkdownTheme(), {
        color: (line) => theme.fg("customMessageText", line),
      });
      box.addChild(
        new (class extends Container {
          override render(width: number): string[] {
            this.clear();
            const label = theme.fg("customMessageLabel", theme.bold(`[${type}]`));
            this.addChild(
              markdown.render(width).length > 4
                ? actionText(
                    `${label} · ${keyHint("app.tools.expand", expanded ? "to collapse" : "to expand")}`,
                    () => ui?.setToolsExpanded(!expanded),
                  )
                : new Text(label, 0, 0),
            );
            return super.render(width);
          }
        })(),
      );
      box.addChild(new Spacer(1));
      box.addChild(preview(markdown, expanded, theme, false));
      return box;
    });
  }
}
