import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { requirePiPackageRoot } from "../runs/shared/pi-spawn.ts";

// Detached Node runners do not get Pi's extension-loader package aliases.
const root = requirePiPackageRoot();
const sessionModule: Pick<typeof import("@earendil-works/pi-coding-agent"), "buildSessionContext" | "parseSessionEntries" | "migrateSessionEntries" | "SessionManager"> = await import(pathToFileURL(path.join(root, "dist/index.js")).href);
export const { buildSessionContext, parseSessionEntries, migrateSessionEntries, SessionManager } = sessionModule;
