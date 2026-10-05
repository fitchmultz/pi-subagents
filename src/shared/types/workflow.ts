import type {
  AcceptanceInput,
  AcceptanceLedgerStatus,
  ResolvedAcceptanceConfig,
} from "./acceptance.ts";
import type { JsonSchemaObject, OutputMode } from "./config.ts";
import type { SavedLaunchConfig } from "./launch.ts";

export interface ResolvedStepBehavior {
  readonly output: string | false;
  readonly outputMode: OutputMode;
  readonly reads: readonly string[] | false;
  readonly progress: boolean;
  readonly skills: readonly string[] | false;
  readonly model?: string;
}

export type StepOverrides = Partial<ResolvedStepBehavior>;

export interface SequentialStep {
  readonly agent: string;
  readonly task?: string;
  readonly phase?: string;
  readonly label?: string;
  readonly as?: string;
  readonly outputSchema?: JsonSchemaObject;
  readonly cwd?: string;
  readonly output?: string | false;
  readonly outputMode?: OutputMode;
  readonly outputFromAgentDefault?: boolean;
  readonly reads?: readonly string[] | false;
  readonly progress?: boolean;
  readonly skill?: string | readonly string[] | false;
  readonly model?: string;
  readonly acceptance?: AcceptanceInput;
}

export interface ParallelTaskItem extends SequentialStep {
  readonly count?: number;
}

export interface DynamicExpandSpec {
  readonly from: { readonly output: string; readonly path: string };
  readonly item?: string;
  readonly key?: string;
  readonly maxItems?: number;
  readonly onEmpty?: "skip" | "fail";
}

export type DynamicParallelTemplate = Omit<ParallelTaskItem, "as" | "count">;

export interface DynamicCollectSpec {
  readonly as: string;
  readonly outputSchema?: JsonSchemaObject;
}

export interface DynamicParallelStep {
  readonly expand: DynamicExpandSpec;
  readonly parallel: DynamicParallelTemplate;
  readonly collect: DynamicCollectSpec;
  readonly concurrency?: number;
  readonly failFast?: boolean;
  readonly phase?: string;
  readonly label?: string;
}

export interface ParallelStep {
  readonly parallel: readonly ParallelTaskItem[];
  readonly concurrency?: number;
  readonly failFast?: boolean;
  readonly worktree?: boolean;
  readonly cwd?: string;
}

export type ChainStep = SequentialStep | ParallelStep | DynamicParallelStep;

export interface RunnerSubagentStep {
  readonly agent: string;
  readonly task: string;
  readonly phase?: string;
  readonly label?: string;
  readonly outputName?: string;
  readonly structured?: boolean;
  readonly cwd?: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly modelCandidates?: readonly string[];
  readonly tools?: readonly string[];
  readonly allowSubagents?: boolean;
  readonly extensions?: readonly string[];
  readonly mcpDirectTools?: readonly string[];
  readonly completionGuard?: boolean;
  readonly systemPrompt?: string | null;
  readonly systemPromptMode?: "append" | "replace";
  readonly inheritProjectContext: boolean;
  readonly inheritSkills: boolean;
  readonly skills?: readonly string[];
  readonly outputPath?: string;
  readonly output?: string | false;
  readonly outputMode?: OutputMode;
  readonly outputPathFromAgentDefault?: boolean;
  readonly sessionFile?: string;
  readonly maxSubagentDepth?: number;
  readonly maxExecutionTimeMs?: number;
  readonly maxTokens?: number;
  readonly structuredOutput?: {
    readonly schema: JsonSchemaObject;
    readonly schemaPath: string;
    readonly outputPath: string;
  };
  readonly structuredOutputSchema?: JsonSchemaObject;
  readonly effectiveAcceptance?: ResolvedAcceptanceConfig;
  readonly launch?: SavedLaunchConfig;
}

export interface ParallelStepGroup {
  readonly parallel: readonly RunnerSubagentStep[];
  readonly cwd?: string;
  readonly concurrency?: number;
  readonly failFast?: boolean;
  readonly worktree?: boolean;
}

export interface DynamicRunnerGroup {
  readonly expand: DynamicExpandSpec;
  readonly parallel: RunnerSubagentStep;
  readonly collect: DynamicCollectSpec;
  readonly concurrency?: number;
  readonly failFast?: boolean;
  readonly phase?: string;
  readonly label?: string;
  readonly sessionFiles?: readonly (string | undefined)[];
}

export type RunnerStep = RunnerSubagentStep | ParallelStepGroup | DynamicRunnerGroup;

export interface ChainOutputMapEntry {
  readonly text: string;
  readonly structured?: unknown;
  readonly agent: string;
  readonly stepIndex: number;
}

export type ChainOutputMap = Readonly<Record<string, ChainOutputMapEntry>>;

export type WorkflowNodeStatus =
  | "pending"
  | "running"
  | "completed"
  | "complete"
  | "failed"
  | "blocked"
  | "paused"
  | "detached"
  | "timed-out";

export interface WorkflowGraphNode {
  readonly id: string;
  readonly kind: "step" | "parallel-group" | "dynamic-parallel-group" | "agent";
  readonly agent?: string;
  readonly phase?: string;
  readonly label: string;
  readonly status: WorkflowNodeStatus;
  readonly flatIndex?: number;
  readonly stepIndex?: number;
  readonly children?: readonly WorkflowGraphNode[];
  readonly dynamic?: {
    readonly sourceOutput: string;
    readonly sourcePath: string;
    readonly itemName: string;
    readonly maxItems?: number;
    readonly collectAs?: string;
  };
  readonly itemKey?: string;
  readonly outputName?: string;
  readonly structured?: boolean;
  readonly acceptanceStatus?: AcceptanceLedgerStatus;
  readonly error?: string;
}

export interface WorkflowGraphSnapshot {
  readonly runId: string;
  readonly mode: "chain" | "parallel" | "single";
  readonly phases: readonly { readonly title: string; readonly nodeIds: readonly string[] }[];
  readonly nodes: readonly WorkflowGraphNode[];
  readonly currentNodeId?: string;
}
