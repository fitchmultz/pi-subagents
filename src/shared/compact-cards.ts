import {
  getMarkdownTheme,
  truncateToVisualLines,
  type ExtensionAPI,
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

function preview(
  content: Component,
  expanded: boolean | (() => boolean),
  theme: Theme,
  expandHint?: string,
): Component {
  if (expanded === true) {
    return content;
  }
  const isExpanded = typeof expanded === "function" ? expanded : () => expanded;
  let cache: { width: number; lines: readonly string[] } | undefined;
  return {
    render(width) {
      if (isExpanded()) {
        return content.render(width);
      }
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
          `… ${skippedCount} more lines${expandHint === undefined ? "" : ` · ${expandHint}`}`,
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
  context,
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
    // Pi injects keyHint so the hint shows the user's configured keys.
    context.keyHint("app.tools.expand", "to expand"),
  );

export function registerCompactMessages(pi: ExtensionAPI, types: readonly string[]): void {
  const expandedByMessage = new WeakMap<object, { global: boolean; expanded: boolean }>();
  for (const type of types) {
    pi.registerMessageRenderer(type, (message, options, theme) => {
      const { outputPad } = options;
      const compactView: unknown = Reflect.get(options, "compactView");
      const nativeClick = compactView !== undefined;
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
      const isExpanded = (): boolean => {
        if (nativeClick) {
          return options.expanded;
        }
        const saved = expandedByMessage.get(message);
        if (saved !== undefined) {
          if (saved.global === options.expanded) {
            return saved.expanded;
          }
          expandedByMessage.delete(message);
        }
        return options.expanded;
      };
      const body = preview(markdown, nativeClick ? options.expanded : isExpanded, theme);
      box.addChild(
        new (class extends Container {
          override render(width: number): readonly string[] {
            this.clear();
            const label = theme.fg("customMessageLabel", theme.bold(`[${type}]`));
            if (markdown.render(width).length <= 4) {
              this.addChild(new Text(label, 0, 0));
            } else {
              const expanded = isExpanded();
              const header = `${label} · ${options.keyHint("app.tools.expand", expanded ? "to collapse" : "to expand")}`;
              this.addChild(
                nativeClick
                  ? new Text(header, 0, 0)
                  : actionText(header, () => {
                      expandedByMessage.set(message, {
                        global: options.expanded,
                        expanded: !isExpanded(),
                      });
                      body.invalidate();
                    }),
              );
            }
            return super.render(width);
          }
        })(),
      );
      box.addChild(new Spacer(1));
      box.addChild(body);
      return box;
    });
  }
}
