import type {
  ArtifactPaths,
  AsyncResultChild,
  ChildProjectTrustPolicy,
  MaxOutputConfig,
  NestedRouteInfo,
  ResolvedControlConfig,
  SubagentRunMode,
  WorkflowGraphSnapshot,
} from "../../shared/types.ts";
import type { ChildEvent } from "../shared/child-attempt.ts";
import type { MutationToolResult } from "../shared/mutating-tool-guard.ts";
import type { RunnerStep } from "../shared/parallel-utils.ts";

export interface SubagentRunConfig {
  runtimeVersion?: 2;
  timeoutMs?: number;
  rootSessionId?: string;
  id: string;
  steps: RunnerStep[];
  chainDir?: string;
  originalTask?: string;
  resultPath: string;
  cwd: string;
  placeholder: string;
  taskIndex?: number;
  totalTasks?: number;
  maxOutput?: MaxOutputConfig;
  artifactsDir?: string;
  share?: boolean;
  sessionDir?: string;
  asyncDir: string;
  sessionId?: string | null;
  piPackageRoot?: string;
  worktreeSetupHook?: string;
  worktreeSetupHookTimeoutMs?: number;
  controlConfig?: ResolvedControlConfig;
  controlIntercomTarget?: string;
  childIntercomTargets?: Array<string | undefined>;
  resultMode?: SubagentRunMode;
  dynamicFanoutMaxItems?: number;
  workflowGraph?: WorkflowGraphSnapshot;
  nestedRoute?: NestedRouteInfo;
  nestedSelf?: {
    parentRunId: string;
    parentStepIndex?: number;
    depth: number;
    path?: Array<{ runId: string; stepIndex?: number; agent?: string }>;
  };
  projectTrust?: ChildProjectTrustPolicy;
}

export interface RunSingleStepResult extends AsyncResultChild {
  agent: string;
  output: string;
  exitCode: number;
  artifactPaths?: ArtifactPaths;
  completionGuardTriggered?: boolean;
}

export interface SingleStepContext {
  readonly nativeFinalization?: boolean;
  readonly worktreePath?: string;
  readonly rootSessionId?: string;
  readonly cwd: string;
  readonly sessionEnabled: boolean;
  readonly sessionDir?: string;
  readonly artifactsDir?: string;
  readonly id: string;
  readonly flatIndex: number;
  readonly flatStepCount: number;
  readonly outputFile: string;
  readonly registerInterrupt?: (interrupt: (() => void) | undefined) => void;
  readonly signal?: AbortSignal;
  readonly interruptSignal?: AbortSignal;
  readonly childIntercomTarget?: string;
  readonly orchestratorIntercomTarget?: string;
  readonly nestedRoute?: NestedRouteInfo;
  readonly projectTrust?: ChildProjectTrustPolicy;
  readonly onAttemptStart?: (attempt: Readonly<{ model?: string; thinking?: string }>) => void;
  readonly onChildEvent?: (event: ChildEvent, mutation?: MutationToolResult) => void;
}

export interface StepResult extends AsyncResultChild {
  agent: string;
  output: string;
  success: boolean;
  artifactPaths?: ArtifactPaths;
}
