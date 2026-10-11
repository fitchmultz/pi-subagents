import type {
  AcceptanceFinalizationTurn,
  AcceptanceLedger,
  AcceptanceReport,
  JsonSchemaObject,
  ResolvedAcceptanceConfig,
} from "../../shared/types.ts";
import { acceptanceFailureMessage, evaluateAcceptance } from "./acceptance-evaluation.ts";
import {
  acceptanceSelfReviewConfig,
  formatEvidenceReportFieldMapping,
  formatAcceptanceRequirements,
  shouldRunAcceptanceFinalization,
} from "./acceptance-contract.ts";
import type { ExecutionOutcome } from "./acceptance-outcome.ts";
export { resolveExecutionOutcome } from "./acceptance-outcome.ts";
import {
  formatAcceptanceReportExample,
  parseAcceptanceReport,
  stripAcceptanceReport,
} from "./acceptance-reports.ts";

import { reportAuditOutput, type FinalizationReportSubmission } from "./acceptance-submission.ts";
export {
  createFinalizationReportRuntime,
  readFinalizationReport,
  type FinalizationReportSubmission,
} from "./acceptance-submission.ts";

export function formatUnconfirmedFinalizationOutput(output: string): string {
  return `UNCONFIRMED task report — retained for audit only; finalization did not deliver a current complete report.\n\n${stripAcceptanceReport(output)}`;
}

export function resolveFinalizationOutput(rawOutput: string, previousOutput: string): string {
  const prose = stripAcceptanceReport(rawOutput);
  if (prose.trim().length > 0) {
    return prose;
  }
  const report = parseAcceptanceReport(rawOutput).report;
  const summary = report?.diffSummary?.trim() ?? "";
  if (summary.length > 0) {
    return summary;
  }
  const notes = report?.notes?.trim() ?? "";
  return notes.length > 0 ? notes : previousOutput;
}

interface RunAcceptanceInput {
  readonly acceptance: ResolvedAcceptanceConfig;
  readonly initial: ExecutionOutcome;
  readonly initialOutput: string;
  readonly initialReport?: AcceptanceReport;
  readonly initialAcceptance?: AcceptanceLedger;
  readonly sessionFile?: string;
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly nativeReport?: boolean;
  readonly outputSchema?: JsonSchemaObject;
  readonly recordedTurns?: number;
  readonly runTurn: (prompt: string, turn: number, sessionFile: string) => Promise<ReviewResult>;
}
type ReviewResult = FinalizationReportSubmission & {
  readonly error?: string;
  readonly acceptance?: AcceptanceLedger;
};

function skipSelfReview(input: RunAcceptanceInput, ledger: AcceptanceLedger): boolean {
  return (
    ledger.status === "blocked" ||
    !shouldRunAcceptanceFinalization(input.acceptance) ||
    input.initial.exitCode !== 0 ||
    (input.initial.error ?? "").length > 0 ||
    input.initial.interrupted === true ||
    (input.signal?.aborted === true && (input.recordedTurns ?? 0) === 0)
  );
}

/** Owns ordered continuation, cumulative audit evidence, and the authoritative current ledger. */
class AcceptanceReview {
  private readonly input: RunAcceptanceInput & { readonly sessionFile: string };
  private readonly initialLedger: AcceptanceLedger;
  private readonly selfReview: ResolvedAcceptanceConfig;
  private readonly turns: AcceptanceFinalizationTurn[] = [];
  private authoritativeLedger: AcceptanceLedger;
  private previousFailure: string | undefined;
  private auditOutput: string;

  constructor(
    input: RunAcceptanceInput & { readonly sessionFile: string },
    initialLedger: AcceptanceLedger,
    selfReview: ResolvedAcceptanceConfig,
  ) {
    this.input = input;
    this.initialLedger = initialLedger;
    this.selfReview = selfReview;
    this.authoritativeLedger = initialLedger;
    this.previousFailure = acceptanceFailureMessage(initialLedger);
    this.auditOutput = reportAuditOutput({
      output: input.initialOutput,
      report: input.initialReport,
    });
  }

  private finish(status: "completed" | "blocked" | "failed"): AcceptanceLedger {
    return attachFinalizationToLedger({
      initialLedger: this.initialLedger,
      authoritativeLedger: this.authoritativeLedger,
      turns: this.turns,
      status,
      maxTurns: this.input.acceptance.finalization.maxTurns,
    });
  }

  private processFailure(
    result: ReviewResult,
    turn: number,
    prompt: string,
  ): AcceptanceLedger | undefined {
    if (result.error === undefined || result.error.length === 0) {
      return undefined;
    }
    this.turns.push({
      ...createFinalizationProcessFailureTurn({
        turn,
        prompt,
        rawOutput: result.output,
        message: result.error,
      }),
      ...(this.input.nativeReport === true ? { unconfirmedOutput: this.auditOutput } : {}),
    });
    const ledger = buildFinalizationProcessFailureLedger({
      initialLedger: this.initialLedger,
      turns: this.turns,
      maxTurns: this.input.acceptance.finalization.maxTurns,
      message: result.error,
    });
    return this.input.nativeReport === true
      ? {
          ...ledger,
          childReport: undefined,
          childReportParseError: result.reportSubmissionError,
          unconfirmedOutput: this.auditOutput,
        }
      : ledger;
  }

  private async evaluateTurn(result: ReviewResult): Promise<AcceptanceLedger> {
    const submissionError = result.reportSubmissionError;
    const rejectedSubmission = submissionError !== undefined && submissionError.length > 0;
    // Replay the native boundary's checks, not the workspace left by a later repair.
    let ledger =
      !rejectedSubmission && result.acceptance
        ? result.acceptance
        : await evaluateAcceptance({
            acceptance: this.selfReview,
            governing: this.input.acceptance,
            output: rejectedSubmission ? "" : result.output,
            report: rejectedSubmission ? undefined : result.report,
            cwd: this.input.cwd,
            signal: this.input.signal,
          });
    if (rejectedSubmission) {
      ledger = {
        ...ledger,
        childReportParseError: submissionError,
        runtimeChecks: [{ id: "finalization-report", status: "failed", message: submissionError }],
      };
    }
    if (this.input.nativeReport === true && (ledger.childReportParseError ?? "").length > 0) {
      ledger = { ...ledger, unconfirmedOutput: this.auditOutput };
    }
    return ledger;
  }

  private async completeReview(result: ReviewResult): Promise<AcceptanceLedger> {
    if (result.acceptance || this.selfReview !== this.input.acceptance) {
      this.authoritativeLedger = await evaluateAcceptance({
        acceptance: this.input.acceptance,
        output: result.output,
        report: result.report,
        cwd: this.input.cwd,
        signal: this.input.signal,
      });
    }
    return this.finish(this.input.signal?.aborted === true ? "failed" : "completed");
  }

  private runTurn(turn: number, prompt: string): Promise<ReviewResult> {
    if (this.input.signal?.aborted === true && turn > (this.input.recordedTurns ?? 0)) {
      return Promise.resolve({ output: "", error: "Acceptance finalization cancelled." });
    }
    return this.input.runTurn(prompt, turn, this.input.sessionFile);
  }

  private retainAudit(result: ReviewResult): void {
    const retained = result.unconfirmedOutput ?? reportAuditOutput(result);
    if (this.input.nativeReport === true && parseAcceptanceReport(retained).report) {
      this.auditOutput = retained;
    }
  }

  private async performTurn(turn: number): Promise<AcceptanceLedger | undefined> {
    const prompt = formatAcceptanceFinalizationPrompt({
      acceptance: this.input.acceptance,
      initialOutput: this.input.initialOutput,
      initialLedger: this.initialLedger,
      turn,
      maxTurns: this.input.acceptance.finalization.maxTurns,
      previousFailure: this.previousFailure,
      nativeReport: this.input.nativeReport,
      outputSchema: this.input.outputSchema,
    });
    const result = await this.runTurn(turn, prompt);
    this.retainAudit(result);
    const processFailure = this.processFailure(result, turn, prompt);
    if (processFailure) {
      return processFailure;
    }
    this.authoritativeLedger = await this.evaluateTurn(result);
    this.turns.push(
      createFinalizationTurn({
        turn,
        prompt,
        rawOutput: result.output,
        ledger: this.authoritativeLedger,
      }),
    );
    if (this.authoritativeLedger.status === "blocked") {
      return this.finish("blocked");
    }
    const failure = acceptanceFailureMessage(this.authoritativeLedger);
    if (failure === undefined && this.input.signal?.aborted !== true) {
      return this.completeReview(result);
    }
    if (this.input.signal?.aborted === true) {
      return this.finish("failed");
    }
    this.previousFailure = failure;
    return undefined;
  }

  async run(): Promise<AcceptanceLedger> {
    for (let turn = 1; turn <= this.input.acceptance.finalization.maxTurns; turn++) {
      // Each repair resumes the same session and consumes the preceding turn's authoritative outcome.
      // oxlint-disable-next-line no-await-in-loop
      const finished = await this.performTurn(turn);
      if (finished) {
        return finished;
      }
    }
    return this.finish("failed");
  }
}

export async function evaluateRunAcceptance(input: RunAcceptanceInput): Promise<AcceptanceLedger> {
  const review = shouldRunAcceptanceFinalization(input.acceptance);
  const selfReview = review ? acceptanceSelfReviewConfig(input.acceptance) : input.acceptance;
  const initialLedger =
    input.initialAcceptance ??
    (await evaluateAcceptance({
      acceptance: selfReview,
      governing: input.acceptance,
      output: input.initialOutput,
      report: input.initialReport,
      cwd: input.cwd,
      signal: input.signal,
    }));
  if (skipSelfReview(input, initialLedger)) {
    return initialLedger;
  }
  if (input.sessionFile === undefined || input.sessionFile.length === 0) {
    const message =
      "Acceptance finalization requires a session file for same-session continuation.";
    const turns = [createFinalizationProcessFailureTurn({ turn: 1, prompt: "", message })];
    return buildFinalizationProcessFailureLedger({
      initialLedger,
      turns,
      maxTurns: input.acceptance.finalization.maxTurns,
      message,
    });
  }
  return new AcceptanceReview(
    { ...input, sessionFile: input.sessionFile },
    initialLedger,
    selfReview,
  ).run();
}

const INITIAL_OUTPUT_LIMIT = 8_000;

function truncateForPrompt(value: string): string {
  const trimmed = stripAcceptanceReport(value).trim();
  if (trimmed.length <= INITIAL_OUTPUT_LIMIT) {
    return trimmed.length > 0
      ? trimmed
      : "(initial output was empty after removing acceptance-report)";
  }
  return `${trimmed.slice(0, INITIAL_OUTPUT_LIMIT)}\n...[truncated]`;
}

function formatReportForPrompt(ledger: AcceptanceLedger): string {
  if (ledger.childReport) {
    return JSON.stringify(ledger.childReport, null, 2);
  }
  return `Missing or malformed acceptance report: ${ledger.childReportParseError ?? "no parse detail"}`;
}

function initialReviewEvidence(
  output: string,
  ledger: AcceptanceLedger,
  previousFailure: string | undefined,
): string[] {
  const lines = [
    "",
    "Initial visible output:",
    truncateForPrompt(output),
    "",
    "Initial acceptance report:",
    formatReportForPrompt(ledger),
  ];
  if (previousFailure !== undefined && previousFailure.length > 0) {
    lines.push("", "Previous finalization failure to address:", previousFailure);
  }
  return lines;
}

function finalizationInstructions(nativeReport: boolean, schema?: JsonSchemaObject): string[] {
  if (schema) {
    const action = nativeReport
      ? "Your final action must be a sole `structured_output` tool call with {value:{answer,report}}."
      : "Return the schema-constrained JSON object {answer,report}.";
    return [
      `${action} answer must be the complete current public payload matching outputSchema below, including all repairs; do not embed it in a prose string. report is the private typed acceptance object. This submission replaces the initial payload. If more activity follows submission, resubmit the complete current answer and report.\noutputSchema: ${JSON.stringify(schema)}`,
    ];
  }
  const action = nativeReport
    ? "Now do the self-check. Your final action must be a sole `structured_output` tool call with {value:{answer,report}}. answer must contain the complete standalone final answer with the current result and every requested handoff detail (including paths, identifiers, findings, and evidence), repairs or remaining blockers. report is a typed object matching the schema, never JSON embedded in a string. This answer replaces the initial answer; do not replace useful details with only a statement that you rechecked them. If additional messages prompt more activity after submission, resubmit the complete current answer and report as your final action; a prose-only reply does not finalize the task."
    : "Now do the self-check. Return a standalone final answer with the current result and every requested handoff detail (including paths, identifiers, findings, and evidence). This answer replaces the initial answer; do not replace useful details with only a statement that you rechecked them. Include repairs or remaining blockers, then finish with exactly one fenced JSON block tagged `acceptance-report`.";
  return [action, formatAcceptanceReportExample(nativeReport)];
}

export function formatAcceptanceFinalizationPrompt(input: {
  readonly acceptance: ResolvedAcceptanceConfig;
  readonly initialOutput: string;
  readonly initialLedger: AcceptanceLedger;
  readonly turn: number;
  readonly maxTurns: number;
  readonly previousFailure?: string;
  readonly nativeReport?: boolean;
  readonly outputSchema?: JsonSchemaObject;
}): string {
  const evidence = [
    ...new Set([
      ...input.acceptance.evidence,
      ...input.acceptance.criteria.flatMap((criterion) => criterion.evidence),
    ]),
  ];
  const lines = [
    "## Acceptance Finalization",
    "You are continuing the same subagent session. Before this run can be accepted, compare the current work to the acceptance contract and the evidence below.",
    `This is finalization turn ${input.turn} of ${input.maxTurns}. The run will be rejected if the contract is still not satisfied after turn ${input.maxTurns}.`,
    "",
    "If a criterion is incomplete and fixable in this session, keep working now before returning the final report.",
    "Only an observed human-only boundary, such as Touch ID or an unavailable MFA code, may use criterion status blocked with concrete evidence and a nonempty humanAction describing the exact action needed. Preserve completed criteria/evidence; blocked acceptance is incomplete and stops further review and verification until explicit Continue. Ordinary errors, missing evidence, or fixable work remain not-satisfied, not blocked; explain the blocker in residualRisks.",
    "Do not claim a criterion is satisfied unless the current work has concrete evidence from files, commands, validation output, or other inspectable artifacts.",
    "Report cumulative evidence for the whole delegated task, not just this finalization turn. Retain still-valid changed files, tests, commands, and other evidence from the initial report; correct or remove evidence only when the final state invalidates it. No new edits during review does not mean changedFiles is empty.",
    "",
    "## Acceptance Contract",
    ...formatAcceptanceRequirements(
      input.acceptance.criteria,
      evidence,
      "- No explicit criteria were configured; satisfy the requested task and required evidence/checks.",
    ),
  ];
  if (evidence.length > 0) {
    lines.push(
      "",
      `Structured evidence must be present in the ${input.nativeReport === true || input.outputSchema ? "typed report object" : "final `acceptance-report` JSON fields"}. Markdown sections in the visible answer do not satisfy required evidence by themselves. If the previous visible output already included the evidence, copy or summarize it into the matching JSON field.`,
      "Evidence field mapping:",
      ...formatEvidenceReportFieldMapping(evidence),
    );
  }
  if (input.acceptance.verify.length > 0) {
    lines.push(
      "",
      "Runtime verification commands that must pass:",
      ...input.acceptance.verify.map((command) => `- ${command.id}: ${command.command}`),
    );
  }
  if (input.acceptance.stopRules.length > 0) {
    lines.push(
      "",
      "Stop rules are hard constraints while deciding whether to continue, stop as blocked, or report success:",
      ...input.acceptance.stopRules.map((rule) => `- ${rule}`),
    );
  }
  lines.push(
    ...initialReviewEvidence(input.initialOutput, input.initialLedger, input.previousFailure),
    "",
    ...finalizationInstructions(input.nativeReport === true, input.outputSchema),
  );
  return lines.join("\n");
}

export function createFinalizationTurn(input: {
  readonly turn: number;
  readonly prompt: string;
  readonly rawOutput: string;
  readonly ledger: AcceptanceLedger;
}): AcceptanceFinalizationTurn {
  const failureMessage = acceptanceFailureMessage(input.ledger);
  return {
    turn: input.turn,
    prompt: input.prompt,
    status: input.ledger.status,
    rawOutput: input.rawOutput,
    ...(input.ledger.unconfirmedOutput !== undefined
      ? { unconfirmedOutput: input.ledger.unconfirmedOutput }
      : {}),
    ...(input.ledger.childReport ? { report: input.ledger.childReport } : {}),
    ...(input.ledger.childReportParseError !== undefined &&
    input.ledger.childReportParseError.length > 0
      ? { parseError: input.ledger.childReportParseError }
      : {}),
    runtimeChecks: input.ledger.runtimeChecks,
    verifyRuns: input.ledger.verifyRuns,
    ...(failureMessage !== undefined && failureMessage.length > 0 ? { failureMessage } : {}),
  };
}

export function createFinalizationProcessFailureTurn(input: {
  readonly turn: number;
  readonly prompt: string;
  readonly rawOutput?: string;
  readonly message: string;
}): AcceptanceFinalizationTurn {
  return {
    turn: input.turn,
    prompt: input.prompt,
    status: "rejected",
    ...(input.rawOutput !== undefined && input.rawOutput.length > 0
      ? { rawOutput: input.rawOutput }
      : {}),
    runtimeChecks: [{ id: "finalization-process", status: "failed", message: input.message }],
    verifyRuns: [],
    failureMessage: `Acceptance rejected: ${input.message}`,
  };
}

export function attachFinalizationToLedger(input: {
  readonly initialLedger: AcceptanceLedger;
  readonly authoritativeLedger: AcceptanceLedger;
  readonly turns: readonly AcceptanceFinalizationTurn[];
  readonly status: "completed" | "blocked" | "failed";
  readonly maxTurns: number;
}): AcceptanceLedger {
  return {
    ...input.authoritativeLedger,
    ...(input.initialLedger.childReport
      ? { initialChildReport: input.initialLedger.childReport }
      : {}),
    ...(input.initialLedger.childReportParseError !== undefined &&
    input.initialLedger.childReportParseError.length > 0
      ? { initialChildReportParseError: input.initialLedger.childReportParseError }
      : {}),
    finalization: {
      mode: "self-review-loop",
      status: input.status,
      maxTurns: input.maxTurns,
      turns: input.turns,
    },
  };
}

export function buildFinalizationProcessFailureLedger(input: {
  readonly initialLedger: AcceptanceLedger;
  readonly turns: readonly AcceptanceFinalizationTurn[];
  readonly maxTurns: number;
  readonly message: string;
}): AcceptanceLedger {
  return attachFinalizationToLedger({
    initialLedger: input.initialLedger,
    authoritativeLedger: {
      ...input.initialLedger,
      status: "rejected",
      runtimeChecks: [
        ...input.initialLedger.runtimeChecks,
        { id: "finalization-process", status: "failed", message: input.message },
      ],
    },
    turns: input.turns,
    status: "failed",
    maxTurns: input.maxTurns,
  });
}
