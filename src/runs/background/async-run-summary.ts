import type {
  ActivityState,
  AsyncJobStep,
  AsyncParallelGroupStatus,
  NestedRunSummary,
  SubagentRunMode,
  TokenUsage,
} from "../../shared/types.ts";

export interface AsyncRunStepSummary {
  readonly index: number;
  readonly sessionFile?: string;
  readonly agent: string;
  readonly label?: string;
  readonly phase?: string;
  readonly outputName?: string;
  readonly structured?: boolean;
  readonly status: AsyncJobStep["status"];
  readonly activityState?: ActivityState;
  readonly lastActivityAt?: number;
  readonly currentTool?: string;
  readonly currentToolArgs?: string;
  readonly currentToolStartedAt?: number;
  readonly currentPath?: string;
  readonly recentTools?: readonly {
    readonly tool: string;
    readonly args: string;
    readonly endMs: number;
  }[];
  readonly recentOutput?: readonly string[];
  readonly turnCount?: number;
  readonly toolCount?: number;
  readonly durationMs?: number;
  readonly tokens?: TokenUsage;
  readonly skills?: readonly string[];
  readonly model?: string;
  readonly thinking?: string;
  readonly attemptedModels?: readonly string[];
  readonly error?: string;
  children?: NestedRunSummary[];
}

export interface AsyncRunSummary {
  readonly id: string;
  readonly asyncDir: string;
  readonly pid?: number;
  readonly sessionId?: string;
  readonly state: "queued" | "running" | "complete" | "failed" | "blocked" | "paused";
  readonly activityState?: ActivityState;
  readonly lastActivityAt?: number;
  readonly currentTool?: string;
  readonly currentToolStartedAt?: number;
  readonly currentPath?: string;
  readonly turnCount?: number;
  readonly toolCount?: number;
  readonly mode: SubagentRunMode;
  readonly cwd?: string;
  readonly startedAt: number;
  readonly lastUpdate?: number;
  readonly endedAt?: number;
  readonly currentStep?: number;
  readonly chainStepCount?: number;
  readonly parallelGroups?: AsyncParallelGroupStatus[];
  readonly steps: AsyncRunStepSummary[];
  readonly sessionDir?: string;
  readonly outputFile?: string;
  readonly totalTokens?: TokenUsage;
  readonly sessionFile?: string;
  readonly nestedChildren?: NestedRunSummary[];
  readonly nestedWarnings?: readonly string[];
}
