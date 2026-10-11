import { keyText, type MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { withMouseExpansion } from "./action-hints.ts";
import { short, type Quote } from "./view-model.ts";
import { hasText } from "./text-values.ts";
export interface DirectionDetails {
  readonly label: string;
  readonly text: string;
  readonly quote?: Readonly<Quote>;
}
export function directionRenderer(): MessageRenderer<DirectionDetails> {
  return withMouseExpansion<DirectionDetails>((message, options, theme) => {
    const details = message.details;
    if (!details) {
      return;
    }
    return {
      render(width) {
        const key = keyText("app.tools.expand");
        const quote = details.quote
          ? `\n\nReplying to ${details.quote.title}:\n${details.quote.text}`
          : "";
        const expanded = `User → ${details.label}\n${details.text}${quote}`;
        const compact = theme.fg(
          "dim",
          `User → ${details.label}: ${short(details.text, 100)} · sent directly${hasText(key) ? ` · ${key}` : ""}`,
        );
        return new Text(options.expanded ? expanded : compact, 0, 0).render(width);
      },
      invalidate() {
        /* The message renderer creates themed text on every render. */
      },
    };
  });
}
