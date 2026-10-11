import * as fs from "node:fs";
import type {
  SubagentState,
  SubagentLiveIntercomHealth,
  AsyncStatus,
  NestedRunSummary,
} from "../../shared/types.ts";
import type { ReadonlyInput } from "../../shared/types/inputs.ts";
import type { NestedRunResolutionScope } from "../shared/nested-events.ts";

export type RunStatusState = ReadonlyInput<
  Pick<SubagentState, "ownedRuns" | "asyncJobs" | "currentSessionId">
>;
export const ASYNC_COMPLETION_REMINDER =
  "Completion will be delivered automatically. If you are only waiting, end your turn instead of polling status again.";
export interface RunStatusParams {
  readonly action?: "status";
  readonly id?: string;
  readonly runId?: string;
  readonly dir?: string;
  readonly full?: boolean;
}
export interface RunStatusDeps {
  readonly asyncDirRoot?: string;
  readonly resultsDir?: string;
  readonly kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
  readonly now?: () => number;
  readonly state?: RunStatusState;
  readonly nested?: ReadonlyInput<NestedRunResolutionScope>;
  readonly intercomHealth?: ReadonlyMap<string, ReadonlyInput<SubagentLiveIntercomHealth>>;
  readonly includeRunHeader?: boolean;
}
export function hasExistingSessionFile(value: unknown): value is string {
  return typeof value === "string" && fs.existsSync(value);
}
export function normalizedState(
  state: AsyncStatus["state"] | NestedRunSummary["state"],
): "live" | "completed" | "paused" | "blocked" | "failed" | "unknown" {
  if (state === "running" || state === "queued") {
    return "live";
  }
  if (state === "complete") {
    return "completed";
  }
  return state;
}
