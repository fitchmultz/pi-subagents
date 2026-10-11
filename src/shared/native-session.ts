import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type * as NativeSession from "@earendil-works/pi-coding-agent";
import { requirePiPackageRoot } from "../runs/shared/pi-spawn.ts";

// Detached Node runners do not get Pi's extension-loader package aliases.
const selectedSessionURL = pathToFileURL(path.join(requirePiPackageRoot(), "dist/index.js")).href;
// The trusted selected Pi package supplies this exact SDK declaration contract.
// A computed URL is required: Jiti rewrites literal SDK imports to its own host graph.
// oxlint-disable-next-line typescript/no-unsafe-assignment
const sessionModule: typeof NativeSession = await import(selectedSessionURL);
export const { buildSessionContext, parseSessionEntries, migrateSessionEntries, SessionManager } =
  sessionModule;
