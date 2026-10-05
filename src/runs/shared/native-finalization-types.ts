import type { AcceptanceLedger, ResolvedAcceptanceConfig } from "../../shared/types.ts";
import type { createFinalizationReportRuntime, readFinalizationReport } from "./acceptance.ts";
import type { StructuredOutputRuntime } from "./structured-output.ts";
import type { SingleOutputSnapshot, resolveSingleOutput } from "./single-output.ts";

export const FINALIZATION_EVENT = "subagent.finalization";
export interface NativeFinalizationConfig {
  readonly nonce: string;
  readonly acceptance: ResolvedAcceptanceConfig;
  readonly reportRuntime: ReturnType<typeof createFinalizationReportRuntime>;
  readonly publicOutput?: StructuredOutputRuntime;
  readonly outputPath?: string;
  readonly outputSnapshot?: SingleOutputSnapshot;
}
export interface NativeFinalizationEvent {
  readonly type: typeof FINALIZATION_EVENT;
  readonly nonce: string;
  readonly turn: number;
  readonly lastEntryId?: string;
  readonly messageCount: number;
  readonly at: number;
  submission: ReturnType<typeof readFinalizationReport> & { error?: string };
  readonly acceptance?: AcceptanceLedger;
  readonly resolvedOutput: ReturnType<typeof resolveSingleOutput>;
  readonly nextPrompt?: string;
}
