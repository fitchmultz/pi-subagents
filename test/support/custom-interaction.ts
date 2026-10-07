import assert from "node:assert/strict";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { TuiMainScreen } from "@earendil-works/pi-tui";
import { createTestTerminal } from "./terminal.ts";
import { createPlainTheme } from "./ui.ts";

/** Drive the actual custom component; only its native done callback supplies a result. */
export function customInteraction(keys: readonly string[]): ExtensionUIContext["custom"] {
  return async (factory) =>
    new Promise((resolve, reject) => {
      const tui = new TuiMainScreen(createTestTerminal());
      const theme = createPlainTheme();
      Promise.resolve(factory(tui, theme, KeybindingsManager.create(), resolve))
        .then((component) => {
          assert.ok(
            typeof component.handleInput === "function",
            "the requested custom component must accept keyboard input",
          );
          for (const key of keys) {
            component.handleInput(key);
          }
          component.dispose?.();
        })
        .catch(reject);
    });
}
