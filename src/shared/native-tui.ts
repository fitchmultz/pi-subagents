import { findPackageJSON } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { requirePiPackageRoot } from "../runs/shared/pi-spawn.ts";

// Detached Node workers use the selected host's TUI, without extension-loader aliases.
const manifest = findPackageJSON(
  "@earendil-works/pi-tui",
  pathToFileURL(path.join(requirePiPackageRoot(), "dist/index.js")),
);
if (!manifest) {
  throw new Error("Could not locate the selected Pi TUI package.");
}
const tui: Pick<typeof import("@earendil-works/pi-tui"), "stripTerminalSequences"> = await import(
  new URL("./dist/utils.js", pathToFileURL(manifest)).href
);
export const { stripTerminalSequences } = tui;
