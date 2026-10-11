import { isRecord, isUnknownArray, recordAt } from "../../shared/unknown.ts";
import { Compile } from "../../shared/native-typebox.ts";
import { AcceptanceOverride } from "../../extension/schemas.ts";
import { formatAcceptanceReportExample } from "./acceptance-reports.ts";
import { DEFAULT_FINALIZATION_MAX_TURNS } from "./acceptance-defaults.ts";
import type {
  AcceptanceConfig,
  AcceptanceEvidenceKind,
  AcceptanceInput,
  AcceptanceProvenanceLevel,
  ResolvedAcceptanceConfig,
  ResolvedAcceptanceGate,
} from "../../shared/types.ts";

const MAX_FINALIZATION_TURNS = 10;

const VALID_EVIDENCE = new Set<AcceptanceEvidenceKind>([
  "changed-files",
  "tests-added",
  "commands-run",
  "validation-output",
  "residual-risks",
  "no-staged-files",
  "diff-summary",
  "review-findings",
  "manual-notes",
]);

const ACCEPTANCE_KEYS = new Set(Object.keys(recordAt(AcceptanceOverride, "properties") ?? {}));

const REMOVED_ACCEPTANCE_KEYS = new Set(["level", "finalization", "reason", "review"]);
const ACCEPTANCE_VALIDATOR = Compile(AcceptanceOverride);

const EVIDENCE_REPORT_FIELDS: Record<AcceptanceEvidenceKind, string> = {
  "changed-files": "changedFiles: array of changed file paths",
  "tests-added": "testsAddedOrUpdated: array of test files, suites, or cases added/updated",
  "commands-run":
    "commandsRun: array of commands with result passed/failed/not-run and a short summary",
  "validation-output": "validationOutput: array of relevant validation output summaries",
  "residual-risks": "residualRisks: array of remaining risks or blockers; use [] when none remain",
  "no-staged-files": "noStagedFiles: boolean",
  "diff-summary": "diffSummary: non-empty string summarizing changed behavior and important files",
  "review-findings":
    "reviewFindings: array of reviewer findings as strings or objects; use [] when no findings remain",
  "manual-notes": "manualNotes: string for manual notes or external evidence",
};

export function formatEvidenceReportFieldMapping(
  evidence: readonly AcceptanceEvidenceKind[],
): string[] {
  return evidence.map((kind) => `- ${kind} -> ${EVIDENCE_REPORT_FIELDS[kind]}`);
}

function hasArrayItems(value: unknown): boolean {
  return isUnknownArray(value) && value.length > 0;
}

function acceptanceErrorPath(pathLabel: string, instancePath: string): string {
  return instancePath
    .split("/")
    .slice(1)
    .reduce((result, part) => {
      const decoded = part.replaceAll("~1", "/").replaceAll("~0", "~");
      return /^\d+$/.test(decoded) ? `${result}[${decoded}]` : `${result}.${decoded}`;
    }, pathLabel);
}

function unsupportedAcceptanceFields(
  value: Readonly<Record<string, unknown>>,
  pathLabel: string,
): string[] {
  const errors: string[] = [];
  if (Object.hasOwn(value, "level")) {
    errors.push(
      `${pathLabel}.level is no longer supported; configure criteria, evidence, and verify directly.`,
    );
  }
  if (Object.hasOwn(value, "review")) {
    errors.push(
      `${pathLabel}.review is not supported; launch a separate parent-controlled reviewer after the worker completes.`,
    );
  }
  if (Object.hasOwn(value, "finalization")) {
    errors.push(
      `${pathLabel}.finalization is not supported; acceptance contracts always run the self-review loop.`,
    );
  }
  if (Object.hasOwn(value, "reason")) {
    errors.push(
      `${pathLabel}.reason is not supported because acceptance is disabled by omitting the field.`,
    );
  }
  for (const key of Object.keys(value)) {
    if (!ACCEPTANCE_KEYS.has(key) && !REMOVED_ACCEPTANCE_KEYS.has(key)) {
      errors.push(`${pathLabel}.${key} is not supported.`);
    }
  }

  return errors;
}

type SchemaError = ReturnType<typeof ACCEPTANCE_VALIDATOR.Errors>[number];

function ignoreCriterionAlternative(
  error: Readonly<Pick<SchemaError, "keyword" | "schemaPath" | "instancePath">>,
  criteria: unknown,
): boolean {
  const match = error.instancePath.match(/^\/criteria\/(\d+)$/);
  if (!match) {
    return false;
  }
  const criterion: unknown = isUnknownArray(criteria) ? criteria[Number(match[1])] : undefined;
  if (isRecord(criterion)) {
    return error.keyword === "anyOf" || error.schemaPath.includes("/anyOf/0");
  }
  if (typeof criterion === "string") {
    return error.keyword === "anyOf" || error.schemaPath.includes("/anyOf/1");
  }
  return error.keyword !== "anyOf";
}

function schemaTypeSuffix(expected: string, instancePath: string): string {
  if (/^\/stopRules\/\d+$/.test(instancePath)) {
    return "a non-empty string";
  }
  return expected === "array" || expected === "object" ? `an ${expected}` : `a ${expected}`;
}

interface SchemaErrorDetail {
  readonly keyword: string;
  readonly instancePath: string;
  readonly message: string;
  readonly params: unknown;
}
function schemaErrorProperties(params: unknown, key: string): string[] {
  if (!isRecord(params) || !isUnknownArray(params[key])) {
    return [];
  }
  return params[key].filter((property) => typeof property === "string");
}

function schemaErrorDetail(error: SchemaErrorDetail, pathLabel: string): string[] {
  const errorPath = acceptanceErrorPath(pathLabel, error.instancePath);
  if (error.instancePath.endsWith("/timeoutMs")) {
    return [`${errorPath} must be a positive integer.`];
  }
  if (error.instancePath === "/maxFinalizationTurns") {
    return [`${errorPath} must be an integer from 1 to ${MAX_FINALIZATION_TURNS}.`];
  }
  switch (error.keyword) {
    case "anyOf":
      return [`${errorPath} must be a string or object.`];
    case "required":
      return schemaErrorProperties(error.params, "requiredProperties").map(
        (property) => `${errorPath}.${property} is required.`,
      );
    case "additionalProperties":
      return schemaErrorProperties(error.params, "additionalProperties").map((property) =>
        error.instancePath.endsWith("/env")
          ? `${errorPath}.${property} must be a string.`
          : `${errorPath}.${property} is not supported.`,
      );
    case "enum":
      if (error.instancePath.includes("/evidence/")) {
        return [`${errorPath} is not a supported evidence kind.`];
      }
      if (error.instancePath.endsWith("/severity")) {
        return [`${errorPath} must be required or recommended.`];
      }
      return [`${errorPath} ${error.message}.`];
    case "type": {
      const type = recordAt(error, "params")?.type;
      const expected = typeof type === "string" ? type : "unknown";
      return [`${errorPath} must be ${schemaTypeSuffix(expected, error.instancePath)}.`];
    }
    default:
      return [`${errorPath} ${error.message}.`];
  }
}

function acceptanceSchemaErrors(
  value: Readonly<Record<string, unknown>>,
  pathLabel: string,
): string[] {
  const structuralValue = Object.fromEntries(
    Object.entries(value).filter(([key]) => ACCEPTANCE_KEYS.has(key)),
  );
  return ACCEPTANCE_VALIDATOR.Errors(structuralValue).flatMap((error) => {
    if (error.keyword === "minLength" || ignoreCriterionAlternative(error, value.criteria)) {
      return [];
    }
    return schemaErrorDetail(error, pathLabel);
  });
}

function emptyCriteriaFields(value: unknown, pathLabel: string): string[] {
  const errors: string[] = [];
  for (const [index, criterion] of isUnknownArray(value) ? value.entries() : []) {
    if (typeof criterion === "string" && criterion.trim().length === 0) {
      errors.push(`${pathLabel}.criteria[${index}] must not be empty.`);
    }
    if (isRecord(criterion)) {
      const item = criterion;
      if (typeof item.id === "string" && item.id.trim().length === 0) {
        errors.push(`${pathLabel}.criteria[${index}].id is required.`);
      }
      if (typeof item.must === "string" && item.must.trim().length === 0) {
        errors.push(`${pathLabel}.criteria[${index}].must is required.`);
      }
    }
  }
  return errors;
}

function emptyVerificationFields(value: unknown, pathLabel: string): string[] {
  const errors: string[] = [];
  for (const [index, command] of isUnknownArray(value) ? value.entries() : []) {
    if (!isRecord(command)) {
      continue;
    }
    const item = command;
    if (typeof item.id === "string" && item.id.trim().length === 0) {
      errors.push(`${pathLabel}.verify[${index}].id is required.`);
    }
    if (typeof item.command === "string" && item.command.trim().length === 0) {
      errors.push(`${pathLabel}.verify[${index}].command is required.`);
    }
  }
  return errors;
}

function emptyStopRules(value: unknown, pathLabel: string): string[] {
  const errors: string[] = [];
  for (const [index, rule] of isUnknownArray(value) ? value.entries() : []) {
    if (typeof rule === "string" && rule.trim().length === 0) {
      errors.push(`${pathLabel}.stopRules[${index}] must be a non-empty string.`);
    }
  }

  return errors;
}

export function validateAcceptanceInput(input: unknown, pathLabel = "acceptance"): string[] {
  if (input === undefined) {
    return [];
  }
  if (input === false || typeof input === "string") {
    return [
      `${pathLabel} must be an object. Public acceptance levels and false disables are no longer supported.`,
    ];
  }
  if (!isRecord(input)) {
    return [`${pathLabel} must be an object.`];
  }
  const value = input;
  const errors = [
    ...unsupportedAcceptanceFields(value, pathLabel),
    ...acceptanceSchemaErrors(value, pathLabel),
    ...emptyCriteriaFields(value.criteria, pathLabel),
    ...emptyVerificationFields(value.verify, pathLabel),
    ...emptyStopRules(value.stopRules, pathLabel),
  ];
  if (
    !hasArrayItems(value.criteria) &&
    !hasArrayItems(value.evidence) &&
    !hasArrayItems(value.verify) &&
    !hasArrayItems(value.stopRules)
  ) {
    errors.push(
      `${pathLabel} must include at least one of criteria, evidence, verify, or stopRules.`,
    );
  }
  return [...new Set(errors)];
}

function normalizeCriteria(
  criteria: AcceptanceConfig["criteria"],
  evidence: readonly AcceptanceEvidenceKind[],
): ResolvedAcceptanceGate[] {
  return (criteria ?? [])
    .map((criterion, index) => {
      if (typeof criterion === "string") {
        return {
          id: `criterion-${index + 1}`,
          must: criterion,
          evidence,
          severity: "required" as const,
        };
      }
      return {
        id: criterion.id.trim(),
        must: criterion.must,
        evidence: criterion.evidence?.filter((item) => VALID_EVIDENCE.has(item)) ?? evidence,
        severity: criterion.severity ?? "required",
      };
    })
    .filter((criterion) => criterion.must.trim().length > 0);
}

function deriveAcceptanceLevel(config: AcceptanceConfig): AcceptanceProvenanceLevel {
  if ((config.verify?.length ?? 0) > 0) {
    return "verified";
  }
  return "checked";
}

export function resolveEffectiveAcceptance(input: {
  readonly explicit?: AcceptanceInput;
}): ResolvedAcceptanceConfig {
  if (input.explicit === undefined) {
    return {
      level: "none",
      explicit: false,
      inferredReason: ["acceptance not configured"],
      criteria: [],
      evidence: [],
      verify: [],
      stopRules: [],
      finalization: { mode: "none", maxTurns: 0 },
    };
  }

  const validationErrors = validateAcceptanceInput(input.explicit);
  if (validationErrors.length > 0) {
    throw new Error(validationErrors.join(" "));
  }
  const explicit = input.explicit;
  const evidence = [...new Set(explicit.evidence ?? [])];
  const criteria = normalizeCriteria(explicit.criteria, evidence);
  const verify = explicit.verify ?? [];
  const stopRules = explicit.stopRules ?? [];
  return {
    level: deriveAcceptanceLevel(explicit),
    explicit: true,
    inferredReason: ["explicit acceptance contract"],
    criteria,
    evidence,
    verify,
    stopRules,
    finalization: {
      mode: "self-review-loop",
      maxTurns: explicit.maxFinalizationTurns ?? DEFAULT_FINALIZATION_MAX_TURNS,
    },
  };
}

export function acceptanceInputFromResolved(
  acceptance: ResolvedAcceptanceConfig | undefined,
): AcceptanceInput | undefined {
  if (acceptance?.explicit !== true) {
    return undefined;
  }
  const maxTurns = acceptance.finalization.maxTurns;
  return {
    criteria: acceptance.criteria,
    evidence: acceptance.evidence,
    verify: acceptance.verify,
    stopRules: acceptance.stopRules,
    maxFinalizationTurns: maxTurns,
  };
}

export function shouldRunAcceptanceFinalization(acceptance: ResolvedAcceptanceConfig): boolean {
  return (
    acceptance.explicit &&
    acceptance.finalization.mode === "self-review-loop" &&
    acceptance.finalization.maxTurns > 0
  );
}

export function acceptanceSelfReviewConfig(
  acceptance: ResolvedAcceptanceConfig,
): ResolvedAcceptanceConfig {
  if (acceptance.verify.length === 0) {
    return acceptance;
  }
  return {
    ...acceptance,
    level: "checked",
    verify: [],
  };
}

export function formatAcceptanceRequirements(
  criteria: readonly ResolvedAcceptanceGate[],
  evidence: readonly AcceptanceEvidenceKind[],
  emptyCriteria: string,
): string[] {
  const criteriaLines =
    criteria.length > 0
      ? criteria.map(
          (criterion) =>
            `- ${criterion.id}: ${criterion.must}${criterion.evidence.length > 0 ? ` (evidence: ${criterion.evidence.join(", ")})` : ""}`,
        )
      : [emptyCriteria];
  return [
    "Criteria:",
    ...criteriaLines,
    "",
    `Required evidence: ${evidence.length > 0 ? evidence.join(", ") : "none explicitly requested"}`,
  ];
}

export function formatAcceptancePrompt(
  acceptance: ResolvedAcceptanceConfig,
  nativeReport = false,
): string {
  if (acceptance.level === "none") {
    return "";
  }
  const evidence = [
    ...new Set([
      ...acceptance.evidence,
      ...acceptance.criteria.flatMap((criterion) => criterion.evidence),
    ]),
  ];
  const lines = [
    "",
    "## Acceptance Contract",
    nativeReport
      ? "Completion is not accepted from prose alone. Finish the initial response with a sole structured_output tool call containing {value:{answer,report}}. answer is the complete standalone visible answer; report is a typed object, never JSON embedded in a string."
      : "Completion is not accepted from prose alone. End the initial response with a structured acceptance report.",
    "After the initial response, the runtime will continue this same session for a bounded self-review/repair loop before accepting the run.",
    "For an observed human-only boundary (such as Touch ID or an unavailable MFA code), report the affected criterion as blocked with concrete evidence and a nonempty humanAction stating the exact user action. Retain completed evidence. This leaves acceptance incomplete and stops finalization/verification until explicit Continue. Do not use blocked for ordinary errors, missing unrelated evidence, or work you can fix.",
    "",
    ...formatAcceptanceRequirements(
      acceptance.criteria,
      evidence,
      "- No explicit criteria were configured; satisfy the requested task and the required evidence/checks below.",
    ),
  ];
  if (evidence.length > 0) {
    lines.push(
      "",
      `Structured evidence must be present in the ${nativeReport ? "typed report object" : "`acceptance-report` JSON fields"}. Markdown sections in your visible answer do not satisfy required evidence by themselves. If you already described evidence in prose, copy or summarize it into the matching JSON field.`,
      "Evidence field mapping:",
      ...formatEvidenceReportFieldMapping(evidence),
    );
  }
  if (acceptance.verify.length > 0) {
    lines.push("", "Runtime verification commands configured by parent:");
    for (const command of acceptance.verify) {
      lines.push(`- ${command.id}: ${command.command}`);
    }
  }
  if (acceptance.stopRules.length > 0) {
    lines.push("", "Stop rules:", ...acceptance.stopRules.map((rule) => `- ${rule}`));
  }
  lines.push(
    "",
    nativeReport
      ? "Submit this shape through structured_output; do not emit a fenced acceptance-report:"
      : "Finish with a fenced JSON block tagged `acceptance-report` in this shape:",
    formatAcceptanceReportExample(nativeReport),
  );
  return lines.join("\n");
}
