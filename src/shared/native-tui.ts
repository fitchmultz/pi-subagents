import { createRequire } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { requirePiPackageRoot } from "../runs/shared/pi-spawn.ts";

// Detached Node workers use the selected host's TUI, without extension-loader aliases.
const require = createRequire(path.join(requirePiPackageRoot(), "dist/index.js"));
const tui: Pick<typeof import("@earendil-works/pi-tui"), "stripTerminalSequences"> = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")).href);
export const { stripTerminalSequences } = tui;
