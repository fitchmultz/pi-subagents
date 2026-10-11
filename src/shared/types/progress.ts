import type { ActivityState, ControlEventType } from "./config.ts";
import type { ReadonlyInput } from "./inputs.ts";

export type SubagentResultStatus =
  | "completed"
  | "failed"
  | "blocked"
  | "paused"
  | "detached"
  | "timed-out";
export type SubagentRunMode = "single" | "parallel" | "chain";

export interface ControlEvent {
  readonly type: ControlEventType;
  readonly from?: ActivityState;
  readonly to: ActivityState;
  readonly ts: number;
  readonly agent: string;
  readonly index?: number;
  readonly runId: string;
  readonly message: string;
  readonly reason?: "idle" | "completion_guard" | "tool_failures";
  readonly turns?: number;
  readonly tokens?: number;
  readonly toolCount?: number;
  readonly currentTool?: string;
  readonly currentToolDurationMs?: number;
  readonly currentPath?: string;
  readonly elapsedMs?: number;
  readonly recentFailureSummary?: string;
  readonly supervisorQuestion?: {
    readonly questionId: string;
    readonly state: "awaiting_input" | "answer_pending";
    readonly answer?: string;
  };
}

/** Live progress owner: streaming and tool events update fields and bounded buffers in place. */
export interface AgentProgress {
  index: number;
  agent: string;
  status:
    | "pending"
    | "running"
    | "completed"
    | "complete"
    | "failed"
    | "blocked"
    | "paused"
    | "detached"
    | "timed-out";
  model?: string;
  thinking?: string;
  /** Display boundary: earlier native history belongs to a previous attempt. */
  modelStartedAt?: number;
  activityState?: ActivityState;
  task: string;
  skills?: readonly string[];
  lastActivityAt?: number;
  currentTool?: string;
  currentToolArgs?: string;
  currentToolStartedAt?: number;
  currentPath?: string;
  streamingText?: string;
  recentTools: Array<{ tool: string; args: string; endMs: number }>;
  recentOutput: string[];
  toolCount: number;
  turnCount?: number;
  tokens: number;
  durationMs: number;
  error?: string;
  failedTool?: string;
}

export type ReadonlyAgentProgress = ReadonlyInput<AgentProgress>;

export interface ToolCallSummary {
  readonly text: string;
  readonly expandedText: string;
}

export interface ProgressSummary extends Partial<
  Pick<
    ReadonlyAgentProgress,
    | "index"
    | "agent"
    | "status"
    | "activityState"
    | "task"
    | "skills"
    | "lastActivityAt"
    | "currentTool"
    | "currentToolArgs"
    | "currentToolStartedAt"
    | "currentPath"
    | "recentTools"
    | "recentOutput"
    | "turnCount"
    | "error"
    | "failedTool"
  >
> {
  readonly toolCount: number;
  readonly tokens: number;
  readonly durationMs: number;
}
