import type { ChildProjectTrustPolicy, JsonSchemaObject } from "../../shared/types.ts";
import type { NestedPathEntry } from "./nested-path.ts";

export interface BuildPiArgsInput {
  readonly baseArgs: readonly string[];
  readonly task: string;
  readonly sessionEnabled: boolean;
  readonly sessionDir?: string;
  readonly sessionFile?: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly systemPromptMode?: "append" | "replace";
  readonly inheritProjectContext: boolean;
  readonly inheritSkills: boolean;
  readonly tools?: readonly string[];
  readonly allowSubagents?: boolean;
  readonly extensions?: readonly string[];
  readonly systemPrompt?: string | null;
  readonly mcpDirectTools?: readonly string[];
  /** Actual child spawn cwd; a new --session file inherits this directory natively. */
  readonly cwd?: string;
  readonly intercomSessionName?: string;
  readonly orchestratorIntercomTarget?: string;
  readonly rootSessionId?: string;
  readonly runId?: string;
  readonly childAgentName?: string;
  readonly childIndex?: number;
  readonly parentEventSink?: string;
  readonly parentControlInbox?: string;
  readonly parentRootRunId?: string;
  readonly parentRunId?: string;
  readonly parentChildIndex?: number;
  readonly parentDepth?: number;
  readonly parentPath?: readonly NestedPathEntry[];
  readonly parentCapabilityToken?: string;
  readonly structuredOutput?: {
    readonly schema: JsonSchemaObject;
    readonly schemaPath: string;
    readonly outputPath: string;
  };
  readonly projectTrust?: ChildProjectTrustPolicy;
}

export interface BuildPiArgsResult {
  args: string[];
  env: Record<string, string | undefined>;
  tempDir?: string;
}
