import { findPackageJSON } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type * as NativeTui from "@earendil-works/pi-tui";
import { requirePiPackageRoot } from "../runs/shared/pi-spawn.ts";

// Detached Node workers use the selected host's TUI, without extension-loader aliases.
const manifest = findPackageJSON(
  "@earendil-works/pi-tui",
  pathToFileURL(path.join(requirePiPackageRoot(), "dist/index.js")),
);
if (manifest === undefined || manifest === "") {
  throw new Error("Could not locate the selected Pi TUI package.");
}
const selectedTuiURL = new URL("./dist/utils.js", pathToFileURL(manifest)).href;
// The trusted selected TUI export implements this exact native string-transform contract.
// Jiti aliases literal TUI imports to its host, so this selected dependency URL is required.
// oxlint-disable-next-line typescript/no-unsafe-assignment
const tui: Pick<typeof NativeTui, "stripTerminalSequences"> = await import(selectedTuiURL);
export const { stripTerminalSequences } = tui;
