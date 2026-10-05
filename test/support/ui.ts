import type { MessageRenderer, Theme } from "@earendil-works/pi-coding-agent";
import { getThemeByName } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { assertDefined } from "./assertions.ts";

// Fixed native renderer input, including its opaque payload; not an immutable
// application-owned message or an allowance for arbitrary CustomMessage<T>.
export type NativeCustomMessage = Parameters<MessageRenderer>[0];

/** A fresh native theme; direct rendering assertions omit terminal color escapes. */
export function createPlainTheme(): Theme {
  const theme = getThemeByName("dark");
  assertDefined(theme);
  theme.fg = (_name, text) => text;
  theme.bold = (text) => text;
  return theme;
}
