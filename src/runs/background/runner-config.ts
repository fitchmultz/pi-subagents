import type {
  ChildProjectTrustPolicy,
  MaxOutputConfig,
  NestedRouteInfo,
  ResolvedControlConfig,
  SubagentRunMode,
  WorkflowGraphSnapshot,
  RunnerStep,
} from "../../shared/types.ts";

/** Serialized launch data. JSON arrays encode omitted intercom targets as null. */
export interface SubagentRunConfig {
  readonly runtimeVersion?: 2;
  readonly timeoutMs?: number;
  readonly rootSessionId?: string;
  readonly id: string;
  readonly steps: readonly RunnerStep[];
  readonly chainDir?: string;
  readonly originalTask?: string;
  readonly resultPath: string;
  readonly cwd: string;
  readonly placeholder: string;
  readonly taskIndex?: number;
  readonly totalTasks?: number;
  readonly maxOutput?: MaxOutputConfig;
  readonly artifactsDir?: string;
  readonly share?: boolean;
  readonly sessionDir?: string;
  readonly asyncDir: string;
  readonly sessionId?: string | null;
  readonly piPackageRoot?: string;
  readonly worktreeSetupHook?: string;
  readonly worktreeSetupHookTimeoutMs?: number;
  readonly controlConfig?: ResolvedControlConfig;
  readonly controlIntercomTarget?: string;
  readonly childIntercomTargets?: readonly (string | null | undefined)[];
  readonly resultMode?: SubagentRunMode;
  readonly dynamicFanoutMaxItems?: number;
  readonly workflowGraph?: WorkflowGraphSnapshot;
  readonly nestedRoute?: NestedRouteInfo;
  readonly nestedSelf?: {
    readonly parentRunId: string;
    readonly parentStepIndex?: number;
    readonly depth: number;
    readonly path?: readonly {
      readonly runId: string;
      readonly stepIndex?: number;
      readonly agent?: string;
    }[];
  };
  readonly projectTrust?: ChildProjectTrustPolicy;
}
