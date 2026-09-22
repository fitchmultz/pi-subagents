import type {
	AcceptanceReport,
	JsonSchemaObject,
} from "../../shared/types.ts";

// Open finding objects are intentional: native strict conversion must fall back,
// rather than discarding caller-defined review evidence.
export const ACCEPTANCE_REPORT_SCHEMA: JsonSchemaObject = {
	type: "object",
	properties: {
		criteriaSatisfied: { type: "array", items: {
			type: "object", properties: {
				id: { type: "string" },
				status: { type: "string", enum: ["satisfied", "not-satisfied", "not-applicable", "blocked"] },
				evidence: { type: "string", pattern: "\\S" },
				humanAction: { type: "string" },
			}, required: ["status", "evidence"],
			if: { properties: { status: { const: "blocked" } } }, then: { required: ["humanAction"], properties: { humanAction: { pattern: "\\S" } } },
		} },
		changedFiles: { type: "array", items: { type: "string" } },
		testsAddedOrUpdated: { type: "array", items: { type: "string" } },
		commandsRun: { type: "array", items: {
			type: "object", properties: {
				command: { type: "string" }, result: { type: "string", enum: ["passed", "failed", "not-run"] }, summary: { type: "string" },
			}, required: ["command", "result", "summary"],
		} },
		validationOutput: { type: "array", items: { type: "string" } },
		residualRisks: { type: "array", items: { type: "string" } },
		noStagedFiles: { type: "boolean" },
		diffSummary: { type: "string" },
		reviewFindings: { type: "array", items: { anyOf: [{ type: "string" }, { type: "object", minProperties: 1, additionalProperties: true }] } },
		manualNotes: { type: "string" },
		notes: { type: "string" },
	},
};

export function formatAcceptanceReportExample(nativeReport = false): string {
	const report: AcceptanceReport = {
		criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "specific proof from the final state" }],
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

export function parseAcceptanceReport(output: string): { report?: AcceptanceReport; error?: string } {
	const fenced = [...output.matchAll(/```acceptance-report\s*\n([\s\S]*?)```/gi)]
		.map((match) => match[1]?.trim())
		.filter((value): value is string => Boolean(value));
	const parseErrors: string[] = [];
	for (const body of fenced) {
		try {
			const parsed = JSON.parse(body) as unknown;
			const report = (parsed && typeof parsed === "object" && "acceptance" in parsed)
				? (parsed as { acceptance?: unknown }).acceptance
				: parsed;
			const shapeError = validateAcceptanceReportShape(report);
			if (!shapeError) return { report: report as AcceptanceReport };
			parseErrors.push(`acceptance-report block is invalid: ${shapeError}`);
		} catch (error) {
			parseErrors.push(error instanceof Error ? error.message : String(error));
		}
	}
	if (parseErrors.length > 0) return { error: `Failed to parse acceptance-report: ${parseErrors.join("; ")}` };
	return { error: "Structured acceptance report not found." };
}

export function stripAcceptanceReport(output: string): string {
	return output
		.replace(/\n?```acceptance-report\s*\n[\s\S]*?```\s*$/i, "")
		.trimEnd();
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isCriterionReport(value: unknown): value is NonNullable<AcceptanceReport["criteriaSatisfied"]>[number] {
	if (!isPlainObject(value)) return false;
	const criterion = value as { id?: unknown; status?: unknown; evidence?: unknown; humanAction?: unknown };
	if (criterion.id !== undefined && typeof criterion.id !== "string") return false;
	if (criterion.status !== "satisfied" && criterion.status !== "not-satisfied" && criterion.status !== "not-applicable" && criterion.status !== "blocked") return false;
	if (criterion.status === "blocked" && (typeof criterion.humanAction !== "string" || !criterion.humanAction.trim())) return false;
	return typeof criterion.evidence === "string" && criterion.evidence.trim().length > 0;
}

function isCommandReport(value: unknown): value is NonNullable<AcceptanceReport["commandsRun"]>[number] {
	if (!isPlainObject(value)) return false;
	const command = value as { command?: unknown; result?: unknown; summary?: unknown };
	return typeof command.command === "string"
		&& (command.result === "passed" || command.result === "failed" || command.result === "not-run")
		&& typeof command.summary === "string";
}

function isReviewFinding(value: unknown): value is NonNullable<AcceptanceReport["reviewFindings"]>[number] {
	if (typeof value === "string") return true;
	if (!isPlainObject(value)) return false;
	const values = Object.values(value);
	return values.length > 0 && values.some((item) => typeof item === "string" && item.trim().length > 0);
}

export function validateAcceptanceReportShape(value: unknown): string | undefined {
	if (!isPlainObject(value)) return "acceptance report must be a JSON object";
	const report = value as {
		criteriaSatisfied?: unknown;
		changedFiles?: unknown;
		testsAddedOrUpdated?: unknown;
		commandsRun?: unknown;
		validationOutput?: unknown;
		residualRisks?: unknown;
		noStagedFiles?: unknown;
		diffSummary?: unknown;
		reviewFindings?: unknown;
		manualNotes?: unknown;
		notes?: unknown;
	};
	if (report.criteriaSatisfied !== undefined && (!Array.isArray(report.criteriaSatisfied) || !report.criteriaSatisfied.every(isCriterionReport))) return "criteriaSatisfied must be an array of {id?, status, evidence} objects";
	if (report.changedFiles !== undefined && !isStringArray(report.changedFiles)) return "changedFiles must be an array of strings";
	if (report.testsAddedOrUpdated !== undefined && !isStringArray(report.testsAddedOrUpdated)) return "testsAddedOrUpdated must be an array of strings";
	if (report.commandsRun !== undefined && (!Array.isArray(report.commandsRun) || !report.commandsRun.every(isCommandReport))) return "commandsRun must be an array of {command, result, summary} objects with result passed, failed, or not-run";
	if (report.validationOutput !== undefined && !isStringArray(report.validationOutput)) return "validationOutput must be an array of strings";
	if (report.residualRisks !== undefined && !isStringArray(report.residualRisks)) return "residualRisks must be an array of strings";
	if (report.noStagedFiles !== undefined && typeof report.noStagedFiles !== "boolean") return "noStagedFiles must be a boolean";
	if (report.diffSummary !== undefined && typeof report.diffSummary !== "string") return "diffSummary must be a string";
	if (report.reviewFindings !== undefined && (!Array.isArray(report.reviewFindings) || !report.reviewFindings.every(isReviewFinding))) return "reviewFindings must be an array of strings or non-empty objects with at least one string value";
	if (report.manualNotes !== undefined && typeof report.manualNotes !== "string") return "manualNotes must be a string";
	if (report.notes !== undefined && typeof report.notes !== "string") return "notes must be a string";
	const hasReportField = report.criteriaSatisfied !== undefined
		|| report.changedFiles !== undefined
		|| report.testsAddedOrUpdated !== undefined
		|| report.commandsRun !== undefined
		|| report.validationOutput !== undefined
		|| report.residualRisks !== undefined
		|| report.noStagedFiles !== undefined
		|| report.diffSummary !== undefined
		|| report.manualNotes !== undefined
		|| report.reviewFindings !== undefined;
	return hasReportField ? undefined : "acceptance report must include at least one report field";
}

