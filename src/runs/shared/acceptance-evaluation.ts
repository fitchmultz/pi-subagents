import { spawnSync } from "node:child_process";
import { isUnknownArray } from "../../shared/unknown.ts";
import type {
  AcceptanceEvidenceKind,
  AcceptanceLedger,
  AcceptanceProvenanceLevel,
  AcceptanceReport,
  AcceptanceRuntimeCheck,
  AcceptanceVerifyResult,
  ResolvedAcceptanceConfig,
  ResolvedAcceptanceGate,
} from "../../shared/types/acceptance.ts";
import {
  isAcceptanceReport,
  parseAcceptanceReport,
  validateAcceptanceReportShape,
} from "./acceptance-reports.ts";
import { runVerifyCommand } from "./acceptance-verification.ts";

const LEVEL_RANK: Readonly<Record<AcceptanceProvenanceLevel, number>> = {
  none: 0,
  attested: 1,
  checked: 2,
  verified: 3,
};
function isStringArray(value: unknown): boolean {
  return isUnknownArray(value) && value.every((item) => typeof item === "string");
}
function nonemptyStringArray(value: unknown): boolean {
  return isUnknownArray(value) && value.length > 0 && isStringArray(value);
}
function evidenceStatus(present: boolean, blocked: boolean): AcceptanceRuntimeCheck["status"] {
  if (present) {
    return "passed";
  }
  return blocked ? "blocked" : "failed";
}

type CriterionReport = NonNullable<AcceptanceReport["criteriaSatisfied"]>[number];
function criterionCheck(
  criterion: ResolvedAcceptanceGate,
  item: CriterionReport | undefined,
): AcceptanceRuntimeCheck {
  const id = `criterion:${criterion.id}`;
  if (!item) {
    return {
      id,
      status: "failed",
      message: `Required criterion '${criterion.id}' was not reported.`,
    };
  }
  if (item.status === "blocked") {
    return {
      id,
      status: "blocked",
      message: `Needs human action: ${item.humanAction ?? ""}. Evidence: ${item.evidence}`,
    };
  }
  if (item.status !== "satisfied") {
    return {
      id,
      status: "failed",
      message: `Required criterion '${criterion.id}' was reported as ${item.status}.`,
    };
  }
  return { id, status: "passed", message: `Required criterion '${criterion.id}' satisfied.` };
}

function checkCriteriaSatisfied(
  criteria: readonly ResolvedAcceptanceGate[],
  report: AcceptanceReport,
): AcceptanceRuntimeCheck[] {
  const reports = new Map(
    (report.criteriaSatisfied ?? [])
      .filter((item) => (item.id ?? "").length > 0)
      .map((item) => [item.id, item]),
  );
  return criteria
    .filter((item) => item.severity !== "recommended")
    .flatMap((criterion) => {
      const item = reports.get(criterion.id);
      const checks = [criterionCheck(criterion, item)];
      for (const kind of criterion.evidence) {
        const present = reportEvidencePresent(report, kind);
        checks.push({
          id: `criterion:${criterion.id}:evidence:${kind}`,
          status: evidenceStatus(present, item?.status === "blocked"),
          message: present
            ? `${kind} evidence present for '${criterion.id}'.`
            : `${kind} evidence missing for required criterion '${criterion.id}'.`,
        });
      }
      return checks;
    });
}

function reportEvidencePresent(report: AcceptanceReport, kind: AcceptanceEvidenceKind): boolean {
  switch (kind) {
    case "changed-files":
      return nonemptyStringArray(report.changedFiles);
    case "tests-added":
      return nonemptyStringArray(report.testsAddedOrUpdated);
    case "commands-run":
      return report.commandsRun?.some((command) => command.result !== "not-run") === true;
    case "validation-output":
      return nonemptyStringArray(report.validationOutput);
    case "residual-risks":
      return isStringArray(report.residualRisks);
    case "no-staged-files":
      return report.noStagedFiles === true;
    case "diff-summary":
      return (report.diffSummary ?? "").trim().length > 0;
    case "review-findings":
      return report.reviewFindings !== undefined;
    case "manual-notes":
      return (report.manualNotes ?? report.notes ?? "").trim().length > 0;
  }
}

function checkNoStagedFiles(cwd: string): AcceptanceRuntimeCheck {
  const result = spawnSync("git", ["status", "--short"], { cwd, encoding: "utf-8" });
  if (result.status !== 0) {
    return {
      id: "no-staged-files",
      status: "not-applicable",
      message: "git status unavailable; no staged-files check skipped",
    };
  }
  const staged = result.stdout
    .split(/\r?\n/)
    .filter((line) => line.length >= 2 && line[0] !== " " && line[0] !== "?");
  return staged.length === 0
    ? { id: "no-staged-files", status: "passed", message: "No staged files detected." }
    : {
        id: "no-staged-files",
        status: "failed",
        message: `Staged files present: ${staged.join(", ")}`,
      };
}

function unconfiguredBlockedChecks(report: AcceptanceReport): AcceptanceRuntimeCheck[] {
  return (report.criteriaSatisfied ?? [])
    .filter((item) => item.status === "blocked")
    .map((item) => ({
      id: `criterion:${item.id ?? "human-action"}`,
      status: "blocked",
      message: `Needs human action: ${item.humanAction ?? ""}. Evidence: ${item.evidence}`,
    }));
}

function runStructuralChecks(
  acceptance: ResolvedAcceptanceConfig,
  report: AcceptanceReport,
): AcceptanceRuntimeCheck[] {
  const checks = checkCriteriaSatisfied(acceptance.criteria, report);
  if (acceptance.criteria.length === 0) {
    checks.push(...unconfiguredBlockedChecks(report));
  }
  const blockedCriteria = new Set(
    (report.criteriaSatisfied ?? [])
      .filter((criterion) => criterion.status === "blocked")
      .map((criterion) => criterion.id),
  );
  const blockedEvidence = new Set(
    acceptance.criteria
      .filter((criterion) => blockedCriteria.has(criterion.id))
      .flatMap((criterion) => criterion.evidence),
  );
  for (const kind of acceptance.evidence) {
    const present = reportEvidencePresent(report, kind);
    const deferred =
      blockedEvidence.has(kind) || (acceptance.criteria.length === 0 && blockedCriteria.size > 0);
    checks.push({
      id: `evidence:${kind}`,
      status: evidenceStatus(present, deferred),
      message: present
        ? `${kind} evidence present.`
        : `${kind} evidence missing from child report.`,
    });
  }
  return checks;
}

interface ReportEvaluationInput {
  readonly acceptance: ResolvedAcceptanceConfig;
  readonly governing?: ResolvedAcceptanceConfig;
  readonly output: string;
  readonly report?: unknown;
}
function readReport(input: ReportEvaluationInput): { report?: AcceptanceReport; error?: string } {
  if (input.report === undefined) {
    return parseAcceptanceReport(input.output);
  }
  if (isAcceptanceReport(input.report)) {
    return { report: input.report };
  }
  return {
    error: `Acceptance report is invalid: ${validateAcceptanceReportShape(input.report) ?? "unrecognized report"}`,
  };
}
function requiresStructuralChecks(
  acceptance: ResolvedAcceptanceConfig,
  report: AcceptanceReport,
): boolean {
  return (
    LEVEL_RANK[acceptance.level] >= LEVEL_RANK.checked ||
    report.criteriaSatisfied?.some((item) => item.status === "blocked") === true
  );
}
function structuralStatus(checks: readonly AcceptanceRuntimeCheck[]): AcceptanceLedger["status"] {
  if (checks.some((check) => check.status === "failed")) {
    return "rejected";
  }
  return checks.some((check) => check.status === "blocked") ? "blocked" : "checked";
}

/** Structural evidence only. The run owner must still perform runtime checks before acceptance. */
export function evaluateAcceptanceReport(input: ReportEvaluationInput): AcceptanceLedger {
  const { acceptance } = input;
  const ledger: AcceptanceLedger = {
    status: acceptance.level === "none" ? "not-required" : "claimed",
    explicit: acceptance.explicit,
    effectiveAcceptance: input.governing ?? acceptance,
    inferredReason: acceptance.inferredReason,
    criteria: acceptance.criteria,
    runtimeChecks: [],
    verifyRuns: [],
  };
  if (acceptance.level === "none") {
    return ledger;
  }
  const parsed = readReport(input);
  if (!parsed.report) {
    return {
      ...ledger,
      childReportParseError: parsed.error,
      runtimeChecks: [
        {
          id: "attestation",
          status: "failed",
          message: parsed.error ?? "Structured acceptance report missing.",
        },
      ],
      status: "rejected",
    };
  }
  if (!requiresStructuralChecks(acceptance, parsed.report)) {
    return { ...ledger, childReport: parsed.report, status: "attested" };
  }
  const runtimeChecks = runStructuralChecks(acceptance, parsed.report);
  return {
    ...ledger,
    childReport: parsed.report,
    runtimeChecks,
    status: structuralStatus(runtimeChecks),
  };
}

function requiresStagedCheck(
  acceptance: ResolvedAcceptanceConfig,
  report: AcceptanceReport,
): boolean {
  return (
    requiresStructuralChecks(acceptance, report) &&
    (acceptance.evidence.includes("no-staged-files") ||
      acceptance.criteria.some((criterion) => criterion.evidence.includes("no-staged-files")))
  );
}
function cancelledVerification(ledger: AcceptanceLedger): AcceptanceLedger {
  return {
    ...ledger,
    runtimeChecks: [
      ...ledger.runtimeChecks,
      { id: "cancelled", status: "failed", message: "Acceptance verification cancelled." },
    ],
    status: "rejected",
  };
}

function canRunVerification(
  ledger: AcceptanceLedger,
  acceptance: ResolvedAcceptanceConfig,
): boolean {
  return (
    ledger.status !== "rejected" && ledger.status !== "blocked" && acceptance.verify.length > 0
  );
}

export async function evaluateAcceptance(
  input: ReportEvaluationInput & { readonly cwd: string; readonly signal?: AbortSignal },
): Promise<AcceptanceLedger> {
  const { acceptance } = input;
  let ledger = evaluateAcceptanceReport(input);
  if (!ledger.childReport) {
    return ledger;
  }
  if (requiresStagedCheck(acceptance, ledger.childReport)) {
    const check = checkNoStagedFiles(input.cwd);
    ledger = {
      ...ledger,
      runtimeChecks: [...ledger.runtimeChecks, check],
      status: check.status === "failed" ? "rejected" : ledger.status,
    };
  }
  if (!canRunVerification(ledger, acceptance)) {
    return ledger;
  }
  const verifyRuns: AcceptanceVerifyResult[] = [];
  for (const command of acceptance.verify) {
    if (input.signal?.aborted === true) {
      return cancelledVerification({ ...ledger, verifyRuns });
    }
    // Verification commands are ordered and can depend on prior commands' effects.
    // oxlint-disable-next-line no-await-in-loop
    verifyRuns.push(await runVerifyCommand(command, input.cwd, input.signal));
  }
  const failed = verifyRuns.some((run) => run.status === "failed" || run.status === "timed-out");
  return { ...ledger, verifyRuns, status: failed ? "rejected" : "verified" };
}

export function acceptanceHumanAction(ledger: AcceptanceLedger | undefined): string | undefined {
  if (ledger?.status !== "blocked") {
    return undefined;
  }
  return ledger.childReport?.criteriaSatisfied
    ?.filter((criterion) => criterion.status === "blocked")
    .map(
      (criterion) =>
        `${criterion.id ?? "Criterion"}: ${criterion.humanAction ?? ""}\nEvidence: ${criterion.evidence}`,
    )
    .join("\n");
}

export function acceptanceFailureMessage(ledger: AcceptanceLedger): string | undefined {
  if (ledger.status !== "rejected") {
    return undefined;
  }
  const failedCheck = ledger.runtimeChecks.find((check) => check.status === "failed");
  if (failedCheck) {
    return `Acceptance rejected: ${failedCheck.message}`;
  }
  const failedVerify = ledger.verifyRuns.find(
    (run) => run.status === "failed" || run.status === "timed-out",
  );
  if (failedVerify) {
    return `Acceptance verification '${failedVerify.id}' ${failedVerify.status}.`;
  }
  return "Acceptance rejected.";
}
