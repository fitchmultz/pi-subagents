import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { requirePiPackageRoot } from "../runs/shared/pi-spawn.ts";
import { importSelectedNative } from "./native-import.ts";

// Detached Node runners do not get Pi's extension-loader package aliases.
const root = requirePiPackageRoot();
const sessionModule = await importSelectedNative(
  import.meta.url,
  "@earendil-works/pi-coding-agent",
  pathToFileURL(path.join(root, "dist/index.js")).href,
  () => import("@earendil-works/pi-coding-agent"),
);
export const { buildSessionContext, parseSessionEntries, migrateSessionEntries, SessionManager } =
  sessionModule;
