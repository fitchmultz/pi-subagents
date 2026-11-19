import type { Theme } from "@earendil-works/pi-coding-agent";
import { TruncatedText, type Container } from "@earendil-works/pi-tui";
import { actionText } from "../shared/tui-action.ts";
import type { ObserverRow } from "./observe-chrome.ts";

export interface WidgetSnapshot {
  readonly status: string;
  readonly rows: readonly ObserverRow[];
  readonly more: number;
  readonly error: string;
}

/** Builds the above-editor active-agent strip into `content` from one presentation snapshot. */
export function populateStrip(
  content: Container,
  theme: Theme,
  shown: WidgetSnapshot,
  open: (id: string) => void,
): void {
  content.clear();
  content.addChild(actionText(theme.fg("accent", shown.status), () => open("")));
  for (const row of shown.rows) {
    const glyph = row.live && row.paused === undefined ? "●" : "○";
    const color = row.live && row.paused === undefined ? "accent" : "warning";
    const detail = row.paused ?? row.activity ?? row.status;
    content.addChild(
      actionText(`${theme.fg(color, glyph)} ${theme.bold(row.name)} · ${detail}`, () =>
        open(row.id),
      ),
    );
  }
  if (shown.more > 0) {
    content.addChild(actionText(theme.fg("dim", `+${shown.more} more · /agents`), () => open("")));
  }
  if (shown.error.length > 0) {
    content.addChild(new TruncatedText(theme.fg("warning", shown.error), 0, 0));
  }
}
