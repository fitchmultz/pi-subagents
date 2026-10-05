import type { FSWatcher } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AsyncJobState } from "./async.ts";
import type { HistoryIndexHandle } from "./history.ts";
import type { ForegroundResumeRun, OwnedRun, TrackedOwnedRun } from "./owned-runs.ts";

/** Session lifecycle owner. Only owner boundaries may update maps, timers, handles and projections. */
export interface SubagentState {
  baseCwd: string;
  currentSessionId: string | null;
  asyncJobs: Map<string, AsyncJobState>;
  waitingRuns?: Map<string, number>;
  isRunResultConsumed?: (runId: string) => boolean;
  foregroundRuns?: Map<string, ForegroundResumeRun>;
  ownedRuns?: Map<string, TrackedOwnedRun>;
  historyIndex?: HistoryIndexHandle;
  historyReady?: Promise<void>;
  historyClosing?: Promise<void>;
  persistOwnedRun?: (run: OwnedRun) => void;
  onRunsChanged?: () => void;
  cleanupTimers: Map<string, ReturnType<typeof setTimeout>>;
  lastUiContext: ExtensionContext | null;
  poller: NodeJS.Timeout | null;
  completionSeen: Map<string, number>;
  watcher: FSWatcher | null;
  watcherRestartTimer: ReturnType<typeof setTimeout> | null;
  resultFileCoalescer: {
    readonly schedule: (file: string, delayMs?: number) => boolean;
    readonly clear: () => void;
  };
}
