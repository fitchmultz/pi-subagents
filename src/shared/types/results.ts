import type { AcceptanceLedger } from "./acceptance.ts";
import type { OutputMode } from "./config.ts";
import type { ReadonlyInput } from "./inputs.ts";
import type { ObservedMessage } from "./messages.ts";
import type { AgentProgress, ControlEvent, ProgressSummary, ToolCallSummary } from "./progress.ts";
import type { Usage } from "./usage.ts";

export interface SavedOutputReference {
  readonly path: string;
  readonly bytes: number;
  readonly lines: number;
  readonly message: string;
}

export interface TruncationResult {
  readonly text: string;
  readonly truncated: boolean;
  readonly originalBytes?: number;
  readonly originalLines?: number;
  readonly artifactPath?: string;
}

export interface ModelAttempt {
  readonly accounting?: { readonly state: "complete" | "incomplete"; readonly error?: string };
  readonly model: string;
  readonly success: boolean;
  readonly exitCode?: number | null;
  readonly error?: string;
  readonly usage?: Usage;
}

export interface ResourceLimitExceeded {
  readonly kind: "maxExecutionTimeMs" | "maxTokens";
  readonly limit: number;
  readonly observed?: number;
  readonly message: string;
}

export interface AgentProcessExit {
  readonly pid?: number;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly at: number;
}

export interface ArtifactPaths {
  readonly inputPath: string;
  readonly outputPath: string;
  readonly metadataPath: string;
}

/** Execution owns the result while collecting output, accounting and acceptance evidence. */
export interface SingleResult {
  accounting?: { readonly state: "complete" | "incomplete"; readonly error?: string };
  nativeSessionId?: string;
  terminalLeafId?: string | null;
  terminalEntryId?: string;
  auditPath?: string;
  fullOutputPath?: string;
  initialOutputPath?: string;
  auditSaveError?: string;
  agent: string;
  agentProcessExit?: AgentProcessExit;
  task: string;
  exitCode: number;
  detached?: boolean;
  detachedReason?: string;
  interrupted?: boolean;
  timedOut?: boolean;
  resourceLimitExceeded?: ResourceLimitExceeded;
  messages?: readonly ObservedMessage[];
  usage: Usage;
  model?: string;
  attemptedModels?: readonly string[];
  modelAttempts?: readonly ModelAttempt[];
  controlEvents?: readonly ControlEvent[];
  error?: string;
  sessionFile?: string;
  skills?: readonly string[];
  skillsWarning?: string;
  progress?: AgentProgress;
  progressSummary?: ProgressSummary;
  toolCalls?: readonly ToolCallSummary[];
  artifactPaths?: ArtifactPaths;
  truncation?: TruncationResult;
  finalOutput?: string;
  initialOutput?: string;
  outputMode?: OutputMode;
  savedOutputPath?: string;
  outputReference?: SavedOutputReference;
  outputSaveError?: string;
  outputCleanup?: {
    readonly path: string;
    readonly action: "deleted" | "already-missing" | "skipped";
    readonly reason?: string;
    readonly error?: string;
  };
  structuredOutput?: unknown;
  structuredOutputPath?: string;
  structuredOutputSchemaPath?: string;
  acceptance?: AcceptanceLedger;
}

export type ReadonlySingleResult = ReadonlyInput<SingleResult>;

export type DisplayItem =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool";
      readonly name: string;
      readonly args: Readonly<Record<string, unknown>>;
    };

export interface ErrorInfo {
  readonly hasError: boolean;
  readonly exitCode?: number;
  readonly errorType?: string;
  readonly details?: string;
}
