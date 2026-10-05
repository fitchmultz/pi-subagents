import type { WritableDeep } from "type-fest";
import type { ResolvedAcceptanceConfig } from "./acceptance.ts";
import type { ReadonlyInput } from "./inputs.ts";
import type { SavedLaunchConfig } from "./launch.ts";
import type { ReadonlyAgentProgress, SubagentResultStatus, SubagentRunMode } from "./progress.ts";
import type { ArtifactPaths, ReadonlySingleResult } from "./results.ts";

export type ManagementRunState = "live" | "completed" | "paused" | "blocked" | "failed" | "unknown";
export type ManagementAction = "status" | "nudge" | "resume" | "interrupt" | "extend" | "review";

export interface ParentRunReview {
  readonly decision: "accepted" | "needs_changes";
  readonly message?: string;
  readonly reviewedAt: number;
}

/** Persisted ownership record; mutation belongs to the live tracker, not readers of this snapshot. */
export interface OwnedRun {
  readonly recoveryError?: string;
  readonly runId: string;
  readonly ownerSessionId: string;
  readonly source: "foreground" | "async";
  readonly mode: SubagentRunMode;
  readonly cwd: string;
  readonly task: string;
  readonly startedAt: number;
  readonly rootRunId: string;
  readonly predecessorRunId?: string;
  readonly predecessorIndex?: number;
  readonly asyncDir?: string;
  readonly pid?: number;
  readonly children: readonly {
    readonly agent: string;
    readonly index: number;
    readonly workflowNodeId?: string;
    readonly task?: string;
    readonly label?: string;
    readonly sessionFile?: string;
  }[];
  readonly review?: ParentRunReview;
  readonly completion?: {
    readonly id: string;
    readonly state: "pending" | "queued" | "dropped" | "journaled";
    readonly channel?: "notification" | "intercom";
    readonly queuedAt?: number;
    readonly entryId?: string;
  };
  readonly accounting?: {
    readonly state: "pending" | "complete" | "incomplete";
    readonly error?: string;
  };
  readonly delivery?: {
    readonly notifiedAt: number;
    readonly intercomDelivered: boolean;
    readonly completionId?: string;
    readonly entryId?: string;
  };
  readonly legacy?: boolean;
  readonly error?: string;
}

/** Mutable tracker ownership is deliberately separate from persisted run inputs. */
export type TrackedOwnedRun = WritableDeep<OwnedRun>;

export interface OwnedRunView extends OwnedRun {
  readonly state: ManagementRunState;
  readonly updatedAt: number;
  readonly attention: readonly string[];
  readonly children: readonly (OwnedRun["children"][number] & {
    readonly state: ManagementRunState;
    readonly result?: Omit<ReadonlySingleResult, "artifactPaths"> & {
      readonly artifactPaths?: Partial<ArtifactPaths>;
    };
    readonly launch?: SavedLaunchConfig;
    readonly configuration: "saved" | "legacy-partial";
    readonly missingSession?: boolean;
    readonly identityUnavailable?: boolean;
    readonly modelSelection?: Pick<ReadonlyAgentProgress, "model" | "thinking" | "modelStartedAt">;
    readonly activity?: Partial<
      Pick<
        ReadonlyAgentProgress,
        | "status"
        | "currentTool"
        | "currentToolArgs"
        | "currentPath"
        | "recentOutput"
        | "lastActivityAt"
        | "streamingText"
      >
    >;
  })[];
  readonly continuations: readonly {
    readonly runId: string;
    readonly predecessorRunId: string;
    readonly predecessorIndex?: number;
  }[];
  readonly resultPath?: string;
  readonly canInterrupt: boolean;
  readonly diagnosis?: string;
}

export interface ManagementControl {
  readonly state: ManagementRunState;
  readonly runId: string;
  readonly capabilities: readonly ManagementAction[];
  readonly nextActions: readonly {
    readonly action: ManagementAction;
    readonly runId: string;
    readonly index?: number;
    readonly intercomTarget?: string;
  }[];
  readonly unavailableActions?: Readonly<Partial<Record<ManagementAction, string>>>;
  readonly revivedFromRunId?: string;
  readonly pendingReplyContextValid?: boolean;
}

/** Live continuation owner, retained after foreground detachment. */
export interface ForegroundResumeChild {
  agent: string;
  index: number;
  sessionFile?: string;
  status: SubagentResultStatus;
  summary?: string;
  artifactPath?: string;
  effectiveAcceptance?: ResolvedAcceptanceConfig;
  result?: ReadonlySingleResult;
}

export interface ForegroundResumeRun {
  runId: string;
  mode: SubagentRunMode;
  cwd: string;
  updatedAt: number;
  error?: string;
  /** Logical work left after detachment, independent of child success. */
  pausedReason?: string;
  children: ForegroundResumeChild[];
}

export type ReadonlyForegroundResumeRun = ReadonlyInput<ForegroundResumeRun>;

export interface TimeoutExtensionResult {
  readonly ok: boolean;
  readonly timeoutAt?: number;
  readonly message: string;
}

export type TimeoutExtensionCallback = (additionalMs: number) => TimeoutExtensionResult;
