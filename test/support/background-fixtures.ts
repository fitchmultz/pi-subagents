import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ReadonlyDeep } from "type-fest";
import { dirname } from "node:path";
import {
  readAsyncResultFile,
  type ParsedAsyncResultFile,
} from "../../src/runs/background/async-result-file.ts";
import { readStatus } from "../../src/shared/utils.ts";
import type {
  AsyncJobState,
  AsyncStatus,
  AsyncResultChild,
  ForegroundResumeRun,
  OwnedRun,
  SubagentState,
} from "../../src/shared/types.ts";
import { assertDefined } from "./assertions.ts";

type BackgroundFixtureState = SubagentState & {
  ownedRuns: Map<string, OwnedRun>;
  foregroundRuns: Map<string, ForegroundResumeRun>;
};

/** Complete extension-owned state without claiming a native receipt or persisted run. */
export function createSubagentState(cwd: string): BackgroundFixtureState {
  const state: BackgroundFixtureState = {
    baseCwd: cwd,
    currentSessionId: null,
    asyncJobs: new Map(),
    ownedRuns: new Map(),
    foregroundRuns: new Map(),
    cleanupTimers: new Map(),
    lastUiContext: null,
    poller: null,
    completionSeen: new Map(),
    watcher: null,
    watcherRestartTimer: null,
    resultFileCoalescer: {
      schedule: () => false,
      clear: () => {
        // This fixture starts no coalesced result reads.
      },
    },
  };
  return state;
}

/** Observe the published status through its filesystem owner, failing on absence. */
export function readStatusFile(file: string): AsyncStatus {
  const status = readStatus(dirname(file));
  assertDefined(status);
  return status;
}

/** These execution suites require the actual runner's per-child result publication. */
export function readResult(file: string): ParsedAsyncResultFile & { results: AsyncResultChild[] } {
  const result = readAsyncResultFile(file);
  assertDefined(result.results);
  return { ...result, results: result.results };
}

export function toolText(content: ReadonlyDeep<readonly (TextContent | ImageContent)[]>): string {
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export function asyncJob(
  job: ReadonlyDeep<AsyncJobState> | undefined,
): ReadonlyDeep<AsyncJobState> {
  assertDefined(job);
  return job;
}

export function ownedRun(run: ReadonlyDeep<OwnedRun> | undefined): ReadonlyDeep<OwnedRun> {
  assertDefined(run);
  return run;
}
