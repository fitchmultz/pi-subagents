import type {
  AgentProcessExit,
  ChildMessageHeader,
  ObservedMessage,
  ReadonlyInput,
  ResourceLimitExceeded,
  Usage,
  UsageAccumulator,
} from "../../shared/types.ts";
import type { StructuredOutputRuntime } from "./structured-output.ts";
import type { ClaudeCodeInvocation } from "./claude-types.ts";
import type { NativeFinalizationConfig, NativeFinalizationEvent } from "./native-finalization.ts";
import type { MutationToolResult } from "./mutating-tool-guard.ts";
import type { updateStreamingText } from "./streaming-text.ts";

interface ChildEventFields {
  readonly assistantMessageEvent?: Parameters<
    typeof updateStreamingText
  >[1]["assistantMessageEvent"];
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly args?: Readonly<Record<string, unknown>>;
  readonly isError?: boolean;
}

export type ChildEvent = ChildEventFields &
  (
    | { readonly type: "message_end"; readonly message?: ObservedMessage }
    | { readonly type: "message_start" | "message_update"; readonly message?: ChildMessageHeader }
    | { readonly type?: string; readonly message?: never }
  );

export interface NativeAttemptSegment {
  event: NativeFinalizationEvent;
  messages: ObservedMessage[];
  usage: Usage;
  durationMs: number;
  execution?: Pick<
    ChildAttemptResult,
    "exitCode" | "error" | "interrupted" | "timedOut" | "resourceLimitExceeded" | "terminalFailure"
  >;
}

export interface ChildAttemptResult {
  accounting?: { state: "complete" | "incomplete"; error?: string };
  nativeSessionId?: string;
  terminalLeafId?: string | null;
  terminalEntryId?: string;
  effectiveConfiguration?: { model?: string; thinking?: string; modelRecordedAt?: number };
  attemptBaseline?: string[];
  auditPath?: string;
  auditSaveError?: string;
  auditRecords?: Array<{ kind: string; messageNumber?: number; offset: number; length: number }>;
  nativeReferences?: Array<{ messageNumber?: number; entryId: string }>;
  messageCount?: number;
  finalization?: NativeAttemptSegment[];
  stderr: string;
  agentProcessExit?: AgentProcessExit;
  exitCode: number;
  messages: ObservedMessage[];
  usage: UsageAccumulator;
  model?: string;
  error?: string;
  finalOutput: string;
  interrupted?: boolean;
  timedOut?: boolean;
  terminalFailure?: boolean;
  observedCompletedMutation: boolean;
  resourceLimitExceeded?: ResourceLimitExceeded;
  durationMs: number;
}

export interface ChildAttemptControl {
  readonly pid?: number;
  readonly stopping: boolean;
  readonly stop: (outcome: Pick<ChildAttemptResult, "error" | "timedOut" | "interrupted">) => void;
}

export interface ChildAttemptOptions {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly agent: string;
  readonly model?: string;
  readonly maxSubagentDepth?: number;
  readonly maxExecutionTimeMs?: number;
  readonly maxTokens?: number;
  readonly claudeCodeInvocation?: ClaudeCodeInvocation;
  readonly sessionFile?: string;
  readonly auditPath?: string;
  readonly structuredOutput?: StructuredOutputRuntime;
  readonly reportRuntime?: StructuredOutputRuntime;
  readonly nativeFinalization?: NativeFinalizationConfig;
  readonly signal?: AbortSignal;
  readonly interruptSignal?: AbortSignal;
  readonly onStart?: (
    control: ChildAttemptControl,
    result: ReadonlyInput<ChildAttemptResult>,
  ) => void;
  readonly onEvent?: (
    event: ChildEvent,
    result: ReadonlyInput<ChildAttemptResult>,
    mutation?: ReadonlyInput<MutationToolResult>,
  ) => void;
  readonly onFailure?: (result: ReadonlyInput<ChildAttemptResult>) => void;
  readonly onOutput?: (text: string) => void;
  readonly onRawLine?: (stream: "stdout" | "stderr", line: string) => void;
  readonly onStderr?: (text: string) => void;
}

export interface ChildObservation {
  readonly start: number;
  readonly end: number;
  readonly kind: string;
  readonly number?: number;
  readonly message?: ObservedMessage;
  readonly nativeEntryId?: string;
}
