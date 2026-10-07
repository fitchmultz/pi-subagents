import type { AcceptanceLedger, ResolvedAcceptanceConfig } from "../../shared/types.ts";
import type {
  FinalizationReportRuntime,
  FinalizationReportSubmission,
} from "./acceptance-submission.ts";
import type { StructuredOutputRuntime } from "./structured-output.ts";
import type { SingleOutputSnapshot, SingleOutputResolution } from "./single-output.ts";

export const FINALIZATION_EVENT = "subagent.finalization";
export interface NativeFinalizationConfig {
  readonly nonce: string;
  readonly acceptance: ResolvedAcceptanceConfig;
  readonly reportRuntime: FinalizationReportRuntime;
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
  submission: FinalizationReportSubmission & { error?: string };
  readonly acceptance?: AcceptanceLedger;
  readonly resolvedOutput: SingleOutputResolution;
  readonly nextPrompt?: string;
}
