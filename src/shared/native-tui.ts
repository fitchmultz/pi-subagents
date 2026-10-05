import { findPackageJSON } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { requirePiPackageRoot } from "../runs/shared/pi-spawn.ts";
import { importSelectedNative } from "./native-import.ts";

// Detached Node workers use the selected host's TUI, without extension-loader aliases.
const manifest = findPackageJSON(
  "@earendil-works/pi-tui",
  pathToFileURL(path.join(requirePiPackageRoot(), "dist/index.js")),
);
if (manifest === undefined || manifest === "") {
  throw new Error("Could not locate the selected Pi TUI package.");
}
const tui = await importSelectedNative(
  import.meta.url,
  "@earendil-works/pi-tui",
  new URL("./dist/utils.js", pathToFileURL(manifest)).href,
  () => import("@earendil-works/pi-tui"),
);
export const { stripTerminalSequences } = tui;
