import type { WritableDeep } from "type-fest";
import type { ActivityState } from "./config.ts";
import type { SubagentRunMode } from "./progress.ts";
import type { TokenUsage } from "./usage.ts";

export interface AsyncParallelGroupStatus {
  readonly start: number;
  readonly count: number;
  readonly stepIndex: number;
}

export type NestedRunState = "queued" | "running" | "complete" | "failed" | "blocked" | "paused";
export type NestedOwnerState = "live" | "gone" | "unknown";

export interface NestedRunAddress {
  readonly id: string;
  readonly parentRunId: string;
  readonly parentStepIndex?: number;
  readonly parentAgent?: string;
  readonly depth: number;
  readonly path: readonly {
    readonly runId: string;
    readonly stepIndex?: number;
    readonly agent?: string;
  }[];
}

export interface NestedStepSummary {
  readonly agent: string;
  readonly status:
    | "pending"
    | "running"
    | "complete"
    | "completed"
    | "failed"
    | "blocked"
    | "paused"
    | "timed-out";
  readonly sessionFile?: string;
  readonly activityState?: ActivityState;
  readonly lastActivityAt?: number;
  readonly currentTool?: string;
  readonly currentToolStartedAt?: number;
  readonly currentPath?: string;
  readonly turnCount?: number;
  readonly toolCount?: number;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly error?: string;
  readonly children?: readonly NestedRunSummary[];
}

export interface NestedRunSummary extends NestedRunAddress {
  readonly indexedControl?: boolean;
  readonly asyncDir?: string;
  readonly pid?: number;
  readonly sessionId?: string;
  readonly sessionFile?: string;
  readonly intercomTarget?: string;
  readonly ownerIntercomTarget?: string;
  readonly leafIntercomTarget?: string;
  readonly ownerState?: NestedOwnerState;
  readonly controlInbox?: string;
  readonly capabilityToken?: string;
  readonly mode?: SubagentRunMode;
  readonly state: NestedRunState;
  readonly agent?: string;
  readonly agents?: readonly string[];
  readonly currentStep?: number;
  readonly chainStepCount?: number;
  readonly parallelGroups?: readonly AsyncParallelGroupStatus[];
  readonly steps?: readonly NestedStepSummary[];
  readonly children?: readonly NestedRunSummary[];
  readonly activityState?: ActivityState;
  readonly lastActivityAt?: number;
  readonly currentTool?: string;
  readonly currentToolStartedAt?: number;
  readonly currentPath?: string;
  readonly turnCount?: number;
  readonly toolCount?: number;
  readonly totalTokens?: TokenUsage;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly lastUpdate?: number;
  readonly error?: string;
}

/** The nested-event reducer owns and updates the projected tree before publishing a summary. */
export type NestedRunProjection = WritableDeep<NestedRunSummary>;
export type NestedStepProjection = WritableDeep<NestedStepSummary>;

export interface NestedRouteInfo {
  readonly rootRunId: string;
  readonly eventSink: string;
  readonly controlInbox: string;
  readonly capabilityToken: string;
}

export type PublicNestedStepSummary = Pick<
  NestedStepSummary,
  | "agent"
  | "status"
  | "sessionFile"
  | "activityState"
  | "lastActivityAt"
  | "currentTool"
  | "currentToolStartedAt"
  | "currentPath"
  | "turnCount"
  | "toolCount"
  | "startedAt"
  | "endedAt"
  | "error"
> & { readonly children?: readonly PublicNestedRunSummary[] };

export type PublicNestedRunSummary = Pick<
  NestedRunSummary,
  | "id"
  | "parentRunId"
  | "parentStepIndex"
  | "parentAgent"
  | "depth"
  | "path"
  | "asyncDir"
  | "sessionId"
  | "sessionFile"
  | "intercomTarget"
  | "ownerIntercomTarget"
  | "leafIntercomTarget"
  | "ownerState"
  | "mode"
  | "state"
  | "agent"
  | "agents"
  | "currentStep"
  | "chainStepCount"
  | "parallelGroups"
  | "activityState"
  | "lastActivityAt"
  | "currentTool"
  | "currentToolStartedAt"
  | "currentPath"
  | "turnCount"
  | "toolCount"
  | "totalTokens"
  | "startedAt"
  | "endedAt"
  | "lastUpdate"
  | "error"
> & {
  readonly steps?: readonly PublicNestedStepSummary[];
  readonly children?: readonly PublicNestedRunSummary[];
};
