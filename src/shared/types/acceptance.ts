/** Acceptance configuration and recorded evidence, independent of execution and verification code. */
export type AcceptanceProvenanceLevel = "none" | "attested" | "checked" | "verified";

export type AcceptanceEvidenceKind =
  | "changed-files"
  | "tests-added"
  | "commands-run"
  | "validation-output"
  | "residual-risks"
  | "no-staged-files"
  | "diff-summary"
  | "review-findings"
  | "manual-notes";

export interface AcceptanceGate {
  readonly id: string;
  readonly must: string;
  readonly evidence?: readonly AcceptanceEvidenceKind[];
  readonly severity?: "required" | "recommended";
}

export interface AcceptanceVerifyCommand {
  readonly id: string;
  readonly command: string;
  readonly timeoutMs?: number;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly allowFailure?: boolean;
}

export interface AcceptanceConfig {
  readonly criteria?: readonly (string | AcceptanceGate)[];
  readonly evidence?: readonly AcceptanceEvidenceKind[];
  readonly verify?: readonly AcceptanceVerifyCommand[];
  readonly stopRules?: readonly string[];
  readonly maxFinalizationTurns?: number;
}

export type AcceptanceInput = AcceptanceConfig;

export interface ResolvedAcceptanceGate extends AcceptanceGate {
  readonly id: string;
  readonly must: string;
  readonly evidence: readonly AcceptanceEvidenceKind[];
  readonly severity: "required" | "recommended";
}

export interface ResolvedAcceptanceConfig {
  readonly level: AcceptanceProvenanceLevel;
  readonly explicit: boolean;
  readonly inferredReason: readonly string[];
  readonly criteria: readonly ResolvedAcceptanceGate[];
  readonly evidence: readonly AcceptanceEvidenceKind[];
  readonly verify: readonly AcceptanceVerifyCommand[];
  readonly stopRules: readonly string[];
  readonly finalization: {
    readonly mode: "none" | "self-review-loop";
    readonly maxTurns: number;
  };
}

export interface AcceptanceReport {
  readonly criteriaSatisfied?: readonly {
    readonly id?: string;
    readonly status: "satisfied" | "not-satisfied" | "not-applicable" | "blocked";
    readonly evidence: string;
    readonly humanAction?: string;
  }[];
  readonly changedFiles?: readonly string[];
  readonly testsAddedOrUpdated?: readonly string[];
  readonly commandsRun?: readonly {
    readonly command: string;
    readonly result: "passed" | "failed" | "not-run";
    readonly summary: string;
  }[];
  readonly validationOutput?: readonly string[];
  readonly residualRisks?: readonly string[];
  readonly noStagedFiles?: boolean;
  readonly diffSummary?: string;
  readonly reviewFindings?: readonly (string | Readonly<Record<string, unknown>>)[];
  readonly manualNotes?: string;
  readonly notes?: string;
}

export type AcceptanceRuntimeCheckStatus = "passed" | "failed" | "blocked" | "not-applicable";

export interface AcceptanceRuntimeCheck {
  readonly id: string;
  readonly status: AcceptanceRuntimeCheckStatus;
  readonly message: string;
}

export interface AcceptanceVerifyResult {
  readonly id: string;
  readonly command: string;
  readonly cwd?: string;
  readonly exitCode: number | null;
  readonly status: "passed" | "failed" | "timed-out" | "allowed-failure";
  readonly stdout?: string;
  readonly stderr?: string;
  readonly durationMs: number;
}

export type AcceptanceLedgerStatus =
  | "not-required"
  | "claimed"
  | "attested"
  | "checked"
  | "verified"
  | "accepted"
  | "blocked"
  | "rejected";

export interface AcceptanceFinalizationTurn {
  readonly turn: number;
  readonly prompt: string;
  readonly status: AcceptanceLedgerStatus;
  readonly rawOutput?: string;
  readonly unconfirmedOutput?: string;
  readonly report?: AcceptanceReport;
  readonly parseError?: string;
  readonly runtimeChecks: readonly AcceptanceRuntimeCheck[];
  readonly verifyRuns: readonly AcceptanceVerifyResult[];
  readonly failureMessage?: string;
}

export interface AcceptanceFinalizationLedger {
  readonly mode: "self-review-loop";
  readonly status: "not-run" | "completed" | "blocked" | "failed";
  readonly maxTurns: number;
  readonly turns: readonly AcceptanceFinalizationTurn[];
}

export interface AcceptanceLedger {
  readonly status: AcceptanceLedgerStatus;
  readonly explicit: boolean;
  readonly effectiveAcceptance: ResolvedAcceptanceConfig;
  readonly inferredReason: readonly string[];
  readonly criteria: readonly ResolvedAcceptanceGate[];
  readonly childReport?: AcceptanceReport;
  readonly childReportParseError?: string;
  readonly initialChildReport?: AcceptanceReport;
  readonly initialChildReportParseError?: string;
  /** Prior full report retained as audit evidence, never as current acceptance. */
  readonly unconfirmedOutput?: string;
  readonly runtimeChecks: readonly AcceptanceRuntimeCheck[];
  readonly verifyRuns: readonly AcceptanceVerifyResult[];
  readonly finalization?: AcceptanceFinalizationLedger;
}
