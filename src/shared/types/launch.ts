import type { ResolvedAcceptanceConfig } from "./acceptance.ts";
import type {
  AgentConfig,
  ChildProjectTrustPolicy,
  JsonSchemaObject,
  MaxOutputConfig,
  OutputMode,
  ResolvedControlConfig,
} from "./config.ts";

/** Persisted launch snapshot. Resume consumers must not modify the original launch. */
export interface SavedLaunchConfig {
  readonly agent: AgentConfig;
  readonly model?: string;
  readonly thinking?: string;
  /** Timestamp of the native model entry captured with this frozen launch. */
  readonly modelRecordedAt?: number;
  readonly modelCandidates: readonly string[];
  readonly artifacts: boolean;
  readonly artifactsDir?: string;
  readonly share: boolean;
  readonly systemPrompt: string;
  readonly skills: readonly string[];
  readonly cwd: string;
  readonly context: "fresh" | "fork";
  readonly output: string | false;
  /** Proven generated output filename; absent on legacy snapshots. */
  readonly generatedOutputFilename?: string;
  readonly outputMode: OutputMode;
  readonly outputSchema?: JsonSchemaObject;
  readonly effectiveAcceptance?: ResolvedAcceptanceConfig;
  readonly maxOutput?: MaxOutputConfig;
  readonly maxSubagentDepth?: number;
  readonly maxExecutionTimeMs?: number;
  readonly maxTokens?: number;
  readonly controlConfig?: ResolvedControlConfig;
  readonly projectTrust?: ChildProjectTrustPolicy;
  readonly projectTrusted?: boolean;
}
