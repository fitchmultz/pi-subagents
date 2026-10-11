import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { OWNED_RUN_ENTRY } from "../runs/shared/run-records.ts";
import { ensureSafeTempPath } from "../shared/temp-root.ts";
import type { SubagentState } from "../shared/types.ts";

export function getSubagentSessionRoot(parentSessionFile: string | null): string {
  if (parentSessionFile !== null && parentSessionFile.length > 0) {
    return path.join(path.dirname(parentSessionFile), path.basename(parentSessionFile, ".jsonl"));
  }
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-session-"));
}

export function expandTilde(value: string): string {
  return value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

export function ensureAccessibleDir(dir: string): void {
  ensureSafeTempPath(dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK);
}

export function createRuntimeState(pi: ExtensionAPI): SubagentState {
  return {
    baseCwd: "",
    currentSessionId: null,
    asyncJobs: new Map(),
    foregroundRuns: new Map(),
    ownedRuns: new Map(),
    persistOwnedRun: (run) => {
      pi.appendEntry(OWNED_RUN_ENTRY, run);
    },
    cleanupTimers: new Map(),
    lastUiContext: null,
    poller: null,
    completionSeen: new Map(),
    watcher: null,
    watcherRestartTimer: null,
    resultFileCoalescer: {
      schedule: () => false,
      clear: () => {
        /* The async tracker installs a real coalescer when its watcher starts. */
      },
    },
  };
}
