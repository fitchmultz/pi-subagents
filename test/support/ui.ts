import type { Theme } from "@earendil-works/pi-coding-agent";
import type { CustomMessage } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/messages.js";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { getThemeByName } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { importSelectedNative } from "../../src/shared/native-import.ts";
import { assertDefined } from "./assertions.ts";

// Use the TUI package owned by the imported SDK, whether nested or hoisted.
const nativeTui = await importSelectedNative(
  import.meta.url,
  "@earendil-works/pi-tui",
  pathToFileURL(
    createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")).resolve(
      "@earendil-works/pi-tui",
    ),
  ).href,
  () => import("@earendil-works/pi-tui"),
);
export const { setKeybindings } = nativeTui;

// Fixed native renderer input, including its opaque payload; not an immutable
// application-owned message or an allowance for arbitrary CustomMessage<T>.
export type NativeCustomMessage = CustomMessage;

/** A fresh native theme; direct rendering assertions omit terminal color escapes. */
export function createPlainTheme(): Theme {
  const theme = getThemeByName("dark");
  assertDefined(theme);
  theme.fg = (_name, text) => text;
  theme.bold = (text) => text;
  return theme;
}
