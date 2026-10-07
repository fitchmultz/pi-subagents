import type { AcceptanceLedger } from "./acceptance.ts";
import type { ActivityState, MaxOutputConfig } from "./config.ts";
import type { ReadonlyInput } from "./inputs.ts";
import type { AsyncParallelGroupStatus, NestedRouteInfo, NestedRunSummary } from "./nested.ts";
import type { SubagentRunMode } from "./progress.ts";
import type {
  AgentProcessExit,
  ArtifactPaths,
  ModelAttempt,
  ResourceLimitExceeded,
  SingleResult,
} from "./results.ts";
import type { TokenUsage, Usage } from "./usage.ts";
import type { ChainOutputMap, WorkflowGraphSnapshot } from "./workflow.ts";

export type AsyncResultTerminalState = "complete" | "failed" | "blocked" | "paused";

export interface AsyncResultChild extends Partial<
  Pick<
    SingleResult,
    | "task"
    | "finalOutput"
    | "initialOutput"
    | "outputMode"
    | "savedOutputPath"
    | "outputReference"
    | "outputSaveError"
    | "outputCleanup"
    | "toolCalls"
    | "progressSummary"
    | "truncation"
    | "skills"
    | "skillsWarning"
    | "accounting"
    | "nativeSessionId"
    | "terminalLeafId"
    | "terminalEntryId"
    | "auditPath"
    | "auditSaveError"
    | "fullOutputPath"
    | "initialOutputPath"
  >
> {
  usage?: Usage;
  timedOut?: boolean;
  agent?: string;
  agentProcessExit?: AgentProcessExit;
  exitCode?: number | null;
  output?: string;
  error?: string;
  success?: boolean;
  skipped?: boolean;
  sessionFile?: string;
  intercomTarget?: string;
  model?: string;
  attemptedModels?: readonly string[];
  modelAttempts?: readonly ModelAttempt[];
  artifactPaths?: Partial<ArtifactPaths>;
  truncated?: boolean;
  structuredOutput?: unknown;
  structuredOutputPath?: string;
  structuredOutputSchemaPath?: string;
  acceptance?: AcceptanceLedger;
  resourceLimitExceeded?: ResourceLimitExceeded;
  interrupted?: boolean;
  children?: unknown;
}

export interface AsyncResultFile {
  legacySource?: string;
  /** Saved legacy results remain readable until their v3 publication replaces them. */
  recordVersion?: 1 | 2 | 3;
  completionId?: string;
  maxOutput?: MaxOutputConfig;
  error?: string;
  runtimeVersion?: 2;
  timedOut?: boolean;
  id?: string;
  runId?: string;
  agent?: string;
  mode?: SubagentRunMode;
  success?: boolean;
  state?: string;
  summary?: string;
  results?: AsyncResultChild[];
  outputs?: ChainOutputMap;
  workflowGraph?: WorkflowGraphSnapshot;
  exitCode?: number;
  timestamp?: number;
  durationMs?: number;
  truncated?: boolean;
  artifactsDir?: string;
  cwd?: string;
  asyncDir?: string;
  sessionId?: string;
  sessionFile?: string;
  intercomTarget?: string;
  shareUrl?: string;
  gistUrl?: string;
  shareError?: string;
  taskIndex?: number;
  totalTasks?: number;
  nestedChildren?: unknown;
}

export interface AsyncStartedEvent {
  readonly id?: string;
  readonly asyncDir?: string;
  readonly pid?: number;
  readonly sessionId?: string;
  readonly mode?: SubagentRunMode;
  readonly agent?: string;
  readonly agents?: readonly string[];
  readonly chain?: readonly string[];
  readonly chainStepCount?: number;
  readonly parallelGroups?: readonly AsyncParallelGroupStatus[];
  readonly workflowGraph?: WorkflowGraphSnapshot;
  readonly nestedRoute?: NestedRouteInfo;
}

/** Mutable producer-side status projection. Readers consume ReadonlyAsyncStatus. */
export interface AsyncStatus {
  runtimeVersion?: 2;
  error?: string;
  timeoutAt?: number;
  timedOut?: boolean;
  runId: string;
  indexedControl?: boolean;
  controlRequestFiles?: boolean;
  sessionId?: string;
  mode: SubagentRunMode;
  state: "queued" | "running" | "complete" | "failed" | "blocked" | "paused";
  activityState?: ActivityState;
  lastActivityAt?: number;
  currentTool?: string;
  currentToolStartedAt?: number;
  currentPath?: string;
  turnCount?: number;
  toolCount?: number;
  startedAt: number;
  endedAt?: number;
  lastUpdate?: number;
  pid?: number;
  cwd?: string;
  currentStep?: number;
  chainStepCount?: number;
  parallelGroups?: readonly AsyncParallelGroupStatus[];
  workflowGraph?: WorkflowGraphSnapshot;
  steps?: Array<{
    agent: string;
    phase?: string;
    label?: string;
    outputName?: string;
    structured?: boolean;
    status:
      | "pending"
      | "running"
      | "complete"
      | "completed"
      | "failed"
      | "blocked"
      | "paused"
      | "timed-out";
    children?: readonly NestedRunSummary[];
    sessionFile?: string;
    activityState?: ActivityState;
    lastActivityAt?: number;
    currentTool?: string;
    currentToolArgs?: string;
    streamingText?: string;
    currentToolStartedAt?: number;
    currentPath?: string;
    recentTools?: readonly {
      readonly tool: string;
      readonly args: string;
      readonly endMs: number;
    }[];
    recentOutput?: readonly string[];
    turnCount?: number;
    toolCount?: number;
    startedAt?: number;
    endedAt?: number;
    durationMs?: number;
    exitCode?: number | null;
    agentProcessExit?: AgentProcessExit;
    tokens?: TokenUsage;
    skills?: readonly string[];
    model?: string;
    thinking?: string;
    modelStartedAt?: number;
    attemptedModels?: readonly string[];
    modelAttempts?: readonly ModelAttempt[];
    error?: string;
    structuredOutput?: unknown;
    structuredOutputPath?: string;
    structuredOutputSchemaPath?: string;
    acceptance?: AcceptanceLedger;
    resourceLimitExceeded?: ResourceLimitExceeded;
  }>;
  sessionDir?: string;
  outputFile?: string;
  totalTokens?: TokenUsage;
  sessionFile?: string;
  outputs?: ChainOutputMap;
}

export type AsyncJobStep = NonNullable<AsyncStatus["steps"]>[number] & { index?: number };

/** The async tracker owns the current job projection and its mutable step collection. */
export interface AsyncJobState {
  asyncId: string;
  asyncDir: string;
  status: "queued" | "running" | "complete" | "failed" | "blocked" | "paused";
  pid?: number;
  sessionId?: string;
  activityState?: ActivityState;
  lastActivityAt?: number;
  currentTool?: string;
  currentToolStartedAt?: number;
  currentPath?: string;
  turnCount?: number;
  toolCount?: number;
  mode?: SubagentRunMode;
  agents?: readonly string[];
  currentStep?: number;
  chainStepCount?: number;
  parallelGroups?: readonly AsyncParallelGroupStatus[];
  steps?: AsyncJobStep[];
  stepsTotal?: number;
  runningSteps?: number;
  completedSteps?: number;
  activeParallelGroup?: boolean;
  startedAt?: number;
  updatedAt?: number;
  totalTokens?: TokenUsage;
  sessionFile?: string;
  controlEventCursor?: number;
  controlEventIdentity?: string;
  controlEventSince?: number;
  nestedRoute?: NestedRouteInfo;
  nestedChildren?: readonly NestedRunSummary[];
}

export type ReadonlyAsyncResultChild = ReadonlyInput<AsyncResultChild>;
export type ReadonlyAsyncResultFile = ReadonlyInput<AsyncResultFile>;
export type ReadonlyAsyncStatus = ReadonlyInput<AsyncStatus>;
export type ReadonlyAsyncJobState = ReadonlyInput<AsyncJobState>;
