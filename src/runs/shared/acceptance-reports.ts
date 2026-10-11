import { isRecord, isUnknownArray, errorMessage } from "../../shared/unknown.ts";
import type { AcceptanceReport, JsonSchemaObject } from "../../shared/types.ts";

// Open finding objects are intentional: native strict conversion must fall back,
// rather than discarding caller-defined review evidence.
export const ACCEPTANCE_REPORT_SCHEMA: JsonSchemaObject = {
  type: "object",
  properties: {
    criteriaSatisfied: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          status: {
            type: "string",
            enum: ["satisfied", "not-satisfied", "not-applicable", "blocked"],
          },
          evidence: { type: "string", pattern: "\\S" },
          humanAction: { type: "string" },
        },
        required: ["status", "evidence"],
        if: { properties: { status: { const: "blocked" } } },
        // JSON Schema's conditional vocabulary is noncallable data, not a Promise thenable.
        // oxlint-disable-next-line unicorn/no-thenable
        then: { required: ["humanAction"], properties: { humanAction: { pattern: "\\S" } } },
      },
    },
    changedFiles: { type: "array", items: { type: "string" } },
    testsAddedOrUpdated: { type: "array", items: { type: "string" } },
    commandsRun: {
      type: "array",
      items: {
        type: "object",
        properties: {
          command: { type: "string" },
          result: { type: "string", enum: ["passed", "failed", "not-run"] },
          summary: { type: "string" },
        },
        required: ["command", "result", "summary"],
      },
    },
    validationOutput: { type: "array", items: { type: "string" } },
    residualRisks: { type: "array", items: { type: "string" } },
    noStagedFiles: { type: "boolean" },
    diffSummary: { type: "string" },
    reviewFindings: {
      type: "array",
      items: {
        anyOf: [
          { type: "string" },
          { type: "object", minProperties: 1, additionalProperties: true },
        ],
      },
    },
    manualNotes: { type: "string" },
    notes: { type: "string" },
  },
};

export function formatAcceptanceReportExample(nativeReport = false): string {
  const report: AcceptanceReport = {
    criteriaSatisfied: [
      { id: "criterion-1", status: "satisfied", evidence: "specific proof from the final state" },
    ],
    changedFiles: [],
    testsAddedOrUpdated: [],
    commandsRun: [{ command: "command", result: "passed", summary: "short result" }],
    validationOutput: [],
    residualRisks: [],
    noStagedFiles: true,
    diffSummary: "concise summary of changed behavior and important files",
    reviewFindings: [],
    manualNotes: "manual notes or external evidence, if any",
    notes: "self-review summary and remaining work",
  };
  return `\`\`\`${nativeReport ? "json" : "acceptance-report"}\n${JSON.stringify(nativeReport ? { value: { answer: "Complete standalone final answer with all requested handoff details", report } } : report, null, 2)}\n\`\`\``;
}

export function parseAcceptanceReport(output: string): {
  report?: AcceptanceReport;
  error?: string;
} {
  const fenced = [...output.matchAll(/```acceptance-report\s*\n([\s\S]*?)```/gi)]
    .map((match) => match[1]?.trim())
    .filter((value) => typeof value === "string" && value.length > 0);
  const parseErrors: string[] = [];
  for (const body of fenced) {
    try {
      const parsed = JSON.parse(body) as unknown;
      const report =
        parsed !== null && typeof parsed === "object" && "acceptance" in parsed
          ? parsed.acceptance
          : parsed;
      const shapeError = validateAcceptanceReportShape(report);
      if (isAcceptanceReport(report)) {
        return { report };
      }
      parseErrors.push(
        `acceptance-report block is invalid: ${shapeError ?? "unrecognized report"}`,
      );
    } catch (error) {
      parseErrors.push(errorMessage(error));
    }
  }
  if (parseErrors.length > 0) {
    return { error: `Failed to parse acceptance-report: ${parseErrors.join("; ")}` };
  }
  return { error: "Structured acceptance report not found." };
}

export function stripAcceptanceReport(output: string): string {
  return output.replace(/\n?```acceptance-report\s*\n[\s\S]*?```\s*$/i, "").trimEnd();
}

function isStringArray(value: unknown): boolean {
  return isUnknownArray(value) && value.every((item) => typeof item === "string");
}

function isCriterionReport(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const criterion = value;
  if (criterion.id !== undefined && typeof criterion.id !== "string") {
    return false;
  }
  if (
    typeof criterion.status !== "string" ||
    !["satisfied", "not-satisfied", "not-applicable", "blocked"].includes(criterion.status)
  ) {
    return false;
  }
  if (
    criterion.status === "blocked" &&
    (typeof criterion.humanAction !== "string" || criterion.humanAction.trim().length === 0)
  ) {
    return false;
  }
  return typeof criterion.evidence === "string" && criterion.evidence.trim().length > 0;
}

function isCommandReport(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const command = value;
  return (
    typeof command.command === "string" &&
    (command.result === "passed" || command.result === "failed" || command.result === "not-run") &&
    typeof command.summary === "string"
  );
}

function isReviewFinding(value: unknown): boolean {
  if (typeof value === "string") {
    return true;
  }
  if (!isRecord(value)) {
    return false;
  }
  const values = Object.values(value);
  return values.some((item) => typeof item === "string" && item.trim().length > 0);
}

export function isAcceptanceReport(value: unknown): value is AcceptanceReport {
  return validateAcceptanceReportShape(value) === undefined;
}

interface ReportField {
  readonly key: keyof AcceptanceReport;
  readonly valid: (value: unknown) => boolean;
  readonly error: string;
}

function everyArrayItem(value: unknown, valid: (item: unknown) => boolean): boolean {
  return isUnknownArray(value) && value.every(valid);
}

const REPORT_FIELDS: readonly ReportField[] = [
  {
    key: "criteriaSatisfied",
    valid: (value) => everyArrayItem(value, isCriterionReport),
    error: "criteriaSatisfied must be an array of {id?, status, evidence} objects",
  },
  { key: "changedFiles", valid: isStringArray, error: "changedFiles must be an array of strings" },
  {
    key: "testsAddedOrUpdated",
    valid: isStringArray,
    error: "testsAddedOrUpdated must be an array of strings",
  },
  {
    key: "commandsRun",
    valid: (value) => everyArrayItem(value, isCommandReport),
    error:
      "commandsRun must be an array of {command, result, summary} objects with result passed, failed, or not-run",
  },
  {
    key: "validationOutput",
    valid: isStringArray,
    error: "validationOutput must be an array of strings",
  },
  {
    key: "residualRisks",
    valid: isStringArray,
    error: "residualRisks must be an array of strings",
  },
  {
    key: "noStagedFiles",
    valid: (value) => typeof value === "boolean",
    error: "noStagedFiles must be a boolean",
  },
  {
    key: "diffSummary",
    valid: (value) => typeof value === "string",
    error: "diffSummary must be a string",
  },
  {
    key: "reviewFindings",
    valid: (value) => everyArrayItem(value, isReviewFinding),
    error:
      "reviewFindings must be an array of strings or non-empty objects with at least one string value",
  },
  {
    key: "manualNotes",
    valid: (value) => typeof value === "string",
    error: "manualNotes must be a string",
  },
  { key: "notes", valid: (value) => typeof value === "string", error: "notes must be a string" },
];

export function validateAcceptanceReportShape(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return "acceptance report must be a JSON object";
  }
  for (const field of REPORT_FIELDS) {
    const entry = value[field.key];
    if (entry !== undefined && !field.valid(entry)) {
      return field.error;
    }
  }
  const hasReportField = REPORT_FIELDS.some(
    (field) => field.key !== "notes" && value[field.key] !== undefined,
  );
  return hasReportField ? undefined : "acceptance report must include at least one report field";
}
