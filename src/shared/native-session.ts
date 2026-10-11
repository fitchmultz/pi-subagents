import { requirePiPackageRoot } from "../runs/shared/pi-spawn.ts";
import { loadNativeSession } from "./native-session-loader.ts";

// Detached Node runners do not get Pi's extension-loader package aliases.
export const { buildSessionContext, parseSessionEntries, migrateSessionEntries, SessionManager } =
  await loadNativeSession(requirePiPackageRoot());
