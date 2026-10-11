/** Configuration data is caller-owned. Resolution constructs new values rather than mutating inputs. */
import type { AcceptanceInput } from "./acceptance.ts";

export interface MaxOutputConfig {
  readonly bytes?: number;
  readonly lines?: number;
}

export type OutputMode = "inline" | "file-only";
export type JsonSchemaObject = Readonly<Record<string, unknown>>;
export type ChildProjectTrustPolicy = "inherit" | "approve" | "no-approve";
export type ActivityState = "needs_attention";
export type ControlEventType = "needs_attention";
export type ControlNotificationChannel = "event" | "async" | "intercom";

export interface ControlConfig {
  readonly enabled?: boolean;
  readonly needsAttentionAfterMs?: number;
  readonly failedToolAttemptsBeforeAttention?: number;
  readonly notifyOn?: readonly ControlEventType[];
  readonly notifyChannels?: readonly ControlNotificationChannel[];
}

export interface ResolvedControlConfig {
  readonly enabled: boolean;
  readonly needsAttentionAfterMs: number;
  readonly failedToolAttemptsBeforeAttention: number;
  readonly notifyOn: readonly ControlEventType[];
  readonly notifyChannels: readonly ControlNotificationChannel[];
}

export interface ProjectTrustConfig {
  readonly childRuns?: ChildProjectTrustPolicy;
}

interface TopLevelParallelConfig {
  readonly maxTasks?: number;
  readonly concurrency?: number;
}

interface ExtensionChainConfig {
  readonly dynamicFanout?: { readonly maxItems?: number };
}

export interface ExtensionConfig {
  /** Start authorized children with everyday tools; false restores the full subagent-only surface. */
  readonly compactChildTools?: boolean;
  readonly asyncByDefault?: boolean;
  readonly forceTopLevelAsync?: boolean;
  readonly defaultSessionDir?: string;
  readonly maxSubagentDepth?: number;
  readonly control?: ControlConfig;
  readonly parallel?: TopLevelParallelConfig;
  readonly chain?: ExtensionChainConfig;
  readonly worktreeSetupHook?: string;
  readonly worktreeSetupHookTimeoutMs?: number;
  readonly projectTrust?: ChildProjectTrustPolicy | ProjectTrustConfig;
}

export type AgentScope = "user" | "project" | "both";
export type AgentSource = "builtin" | "package" | "user" | "project";
export type SystemPromptMode = "append" | "replace";
export type AgentDefaultContext = "fresh" | "fork";

export interface AgentConfig {
  readonly name: string;
  readonly localName?: string;
  readonly packageName?: string;
  readonly description: string;
  readonly tools?: readonly string[];
  readonly mcpDirectTools?: readonly string[];
  readonly allowSubagents?: boolean;
  readonly model?: string;
  readonly fallbackModels?: readonly string[];
  readonly thinking?: string;
  readonly systemPromptMode: SystemPromptMode;
  readonly inheritProjectContext: boolean;
  readonly inheritSkills: boolean;
  readonly defaultContext?: AgentDefaultContext;
  readonly systemPrompt: string;
  readonly source: AgentSource;
  readonly filePath: string;
  readonly skills?: readonly string[];
  readonly extensions?: readonly string[];
  readonly output?: string;
  readonly defaultReads?: readonly string[];
  readonly defaultProgress?: boolean;
  readonly interactive?: boolean;
  readonly maxSubagentDepth?: number;
  readonly maxExecutionTimeMs?: number;
  readonly maxTokens?: number;
  readonly completionGuard?: boolean;
  readonly disabled?: boolean;
  readonly extraFields?: Readonly<Record<string, string>>;
}

export interface ChainStepConfig {
  readonly agent?: string;
  readonly task?: string;
  readonly phase?: string;
  readonly label?: string;
  readonly as?: string;
  readonly outputSchema?: string | JsonSchemaObject;
  readonly output?: string | false;
  readonly outputMode?: OutputMode;
  readonly reads?: readonly string[] | false;
  readonly model?: string;
  readonly skills?: readonly string[] | false;
  readonly progress?: boolean;
  readonly parallel?: unknown;
  readonly expand?: unknown;
  readonly collect?: unknown;
  readonly concurrency?: number;
  readonly failFast?: boolean;
  readonly worktree?: boolean;
  readonly acceptance?: AcceptanceInput;
}

export interface ChainConfig {
  readonly name: string;
  readonly localName?: string;
  readonly packageName?: string;
  readonly description: string;
  readonly source: AgentSource;
  readonly filePath: string;
  readonly steps: readonly ChainStepConfig[];
  readonly extraFields?: Readonly<Record<string, string>>;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ThinkingLevelMap = Readonly<Partial<Record<ThinkingLevel, string | null>>>;

export interface ModelInfo {
  readonly provider: string;
  readonly id: string;
  readonly fullId: string;
  readonly reasoning?: boolean;
  readonly thinkingLevelMap?: ThinkingLevelMap;
}
