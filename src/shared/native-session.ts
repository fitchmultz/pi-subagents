import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveInstalledPiPackageRoot, resolvePiPackageRoot } from "../runs/shared/pi-spawn.ts";

// Detached Node runners do not get Pi's extension-loader package aliases.
const root = process.env.PI_PACKAGE_DIR || resolvePiPackageRoot() || resolveInstalledPiPackageRoot();
if (!root) throw new Error("Could not locate Pi session APIs; Pi must be installed and available on PATH.");
const sessionModule: Pick<typeof import("@earendil-works/pi-coding-agent"), "buildSessionContext" | "parseSessionEntries"> = await import(pathToFileURL(path.join(root, "dist/core/session-manager.js")).href);
export const { buildSessionContext, parseSessionEntries } = sessionModule;
