import type {
	AcceptanceReport,
} from "../../shared/types.ts";

function extractBalancedJson(text: string, start: number): string | undefined {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const char = text[i]!;
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === "\"") inString = false;
			continue;
		}
		if (char === "\"") {
			inString = true;
			continue;
		}
		if (char === "{") depth++;
		if (char === "}") {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return undefined;
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
	const markerIndex = output.search(/ACCEPTANCE_REPORT\s*:/i);
	if (markerIndex !== -1) {
		const jsonStart = output.indexOf("{", markerIndex);
		if (jsonStart !== -1) {
			const json = extractBalancedJson(output, jsonStart);
			if (json) {
				try {
					const parsed = JSON.parse(json) as unknown;
					const shapeError = validateAcceptanceReportShape(parsed);
					if (!shapeError) return { report: parsed as AcceptanceReport };
					return { error: `ACCEPTANCE_REPORT is invalid: ${shapeError}` };
				} catch (error) {
					return { error: error instanceof Error ? error.message : String(error) };
				}
			}
		}
	}
	return { error: "Structured acceptance report not found." };
}

export function stripAcceptanceReport(output: string): string {
	return output
		.replace(/\n?```acceptance-report\s*\n[\s\S]*?```\s*$/i, "")
		.replace(/\n?ACCEPTANCE_REPORT\s*:\s*\{[\s\S]*\}\s*$/i, "")
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
	const criterion = value as { id?: unknown; status?: unknown; evidence?: unknown };
	if (criterion.id !== undefined && typeof criterion.id !== "string") return false;
	if (criterion.status !== "satisfied" && criterion.status !== "not-satisfied" && criterion.status !== "not-applicable") return false;
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

function validateAcceptanceReportShape(value: unknown): string | undefined {
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

