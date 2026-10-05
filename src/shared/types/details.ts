import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { HistoryFreshness, HistoryPage, HistorySearchPage } from "./history.ts";
import type { ReadonlyInput } from "./inputs.ts";
import type { ManagementControl, OwnedRunView } from "./owned-runs.ts";
import type {
  AgentProgress,
  ControlEvent,
  ProgressSummary,
  SubagentResultStatus,
  SubagentRunMode,
} from "./progress.ts";
import type { SupervisorQuestionView } from "./questions.ts";
import type { ArtifactPaths, SingleResult } from "./results.ts";
import type { UsageContribution } from "./usage.ts";
import type { ChainOutputMap, WorkflowGraphSnapshot } from "./workflow.ts";

/** Tool producer assembles details; nested published records retain their own readonly contracts. */
export interface Details {
  accounting?: { readonly state: "incomplete"; readonly error: string };
  mode: SubagentRunMode | "management";
  /** Receipt only on native tool result with matching top-level usage. */
  parentUsage?: { readonly contributions: readonly UsageContribution[] };
  runId?: string;
  context?: "fresh" | "fork";
  results: SingleResult[];
  controlEvents?: readonly ControlEvent[];
  asyncId?: string;
  asyncDir?: string;
  asyncPid?: number;
  shareUrl?: string;
  gistUrl?: string;
  shareError?: string;
  progress?: AgentProgress[];
  progressSummary?: ProgressSummary;
  intercomTargets?: readonly string[];
  managementControl?: ManagementControl;
  managementControls?: readonly ManagementControl[];
  questions?: readonly SupervisorQuestionView[];
  wait?: {
    readonly runId: string;
    readonly completionId?: string;
    readonly index?: number;
    readonly status: "completed" | "cancelled" | "yielded" | "awaiting_input" | "unavailable";
  };
  run?: OwnedRunView;
  runs?: readonly (Pick<
    OwnedRunView,
    | "runId"
    | "source"
    | "mode"
    | "cwd"
    | "task"
    | "state"
    | "updatedAt"
    | "attention"
    | "review"
    | "rootRunId"
    | "predecessorRunId"
    | "predecessorIndex"
  > & { readonly summary?: string; readonly continuations?: readonly string[] })[];
  runList?: {
    readonly total: number;
    readonly offset: number;
    readonly limit: number;
    readonly nextOffset?: number;
    readonly nextCursor?: string;
    readonly version: number;
    readonly freshness: HistoryFreshness;
  };
  history?: HistoryPage;
  historySearch?: HistorySearchPage;
  intercomDelivery?: {
    readonly delivered: boolean;
    readonly to: string;
    readonly status: SubagentResultStatus;
    readonly summary: string;
  };
  artifacts?: { readonly dir: string; readonly files: readonly ArtifactPaths[] };
  truncation?: {
    readonly truncated: boolean;
    readonly originalBytes?: number;
    readonly originalLines?: number;
    readonly artifactPath?: string;
  };
  chainAgents?: readonly string[];
  totalSteps?: number;
  currentStepIndex?: number;
  workflowGraph?: WorkflowGraphSnapshot;
  outputs?: ChainOutputMap;
}

export type SubagentExecutionResult = AgentToolResult<Details> & {
  /** Executor marker transferred through Pi's native tool_result hook. */
  isError?: boolean;
};

export type ReadonlyDetails = ReadonlyInput<Details>;
