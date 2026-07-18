import { Compile } from "typebox/compile";
import { AcceptanceOverride } from "../../extension/schemas.ts";
import type {
	AcceptanceConfig,
	AcceptanceEvidenceKind,
	AcceptanceInput,
	AcceptanceProvenanceLevel,
	ResolvedAcceptanceConfig,
	ResolvedAcceptanceGate,
} from "../../shared/types.ts";

const DEFAULT_FINALIZATION_MAX_TURNS = 3;
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

const ACCEPTANCE_KEYS = new Set(Object.keys((AcceptanceOverride as unknown as { properties: Record<string, unknown> }).properties));

const REMOVED_ACCEPTANCE_KEYS = new Set(["level", "finalization", "reason", "review"]);
const ACCEPTANCE_VALIDATOR = Compile(AcceptanceOverride);

const EVIDENCE_REPORT_FIELDS: Record<AcceptanceEvidenceKind, string> = {
	"changed-files": "changedFiles: array of changed file paths",
	"tests-added": "testsAddedOrUpdated: array of test files, suites, or cases added/updated",
	"commands-run": "commandsRun: array of commands with result passed/failed/not-run and a short summary",
	"validation-output": "validationOutput: array of relevant validation output summaries",
	"residual-risks": "residualRisks: array of remaining risks or blockers; use [] when none remain",
	"no-staged-files": "noStagedFiles: boolean",
	"diff-summary": "diffSummary: non-empty string summarizing changed behavior and important files",
	"review-findings": "reviewFindings: array of reviewer findings as strings or objects; use [] when no findings remain",
	"manual-notes": "manualNotes: string for manual notes or external evidence",
};

export function formatEvidenceReportFieldMapping(evidence: AcceptanceEvidenceKind[]): string[] {
	return evidence.map((kind) => `- ${kind} -> ${EVIDENCE_REPORT_FIELDS[kind]}`);
}

function hasArrayItems(value: unknown): boolean {
	return Array.isArray(value) && value.length > 0;
}

function acceptanceErrorPath(pathLabel: string, instancePath: string): string {
	return instancePath.split("/").slice(1).reduce((result, part) => {
		const decoded = part.replaceAll("~1", "/").replaceAll("~0", "~");
		return /^\d+$/.test(decoded) ? `${result}[${decoded}]` : `${result}.${decoded}`;
	}, pathLabel);
}

export function validateAcceptanceInput(input: unknown, pathLabel = "acceptance"): string[] {
	if (input === undefined) return [];
	if (input === false || typeof input === "string") {
		return [`${pathLabel} must be an object. Public acceptance levels and false disables are no longer supported.`];
	}
	if (!input || typeof input !== "object" || Array.isArray(input)) return [`${pathLabel} must be an object.`];

	const value = input as Record<string, unknown>;
	const errors: string[] = [];
	if (Object.hasOwn(value, "level")) errors.push(`${pathLabel}.level is no longer supported; configure criteria, evidence, and verify directly.`);
	if (Object.hasOwn(value, "review")) errors.push(`${pathLabel}.review is not supported; launch a separate parent-controlled reviewer after the worker completes.`);
	if (Object.hasOwn(value, "finalization")) errors.push(`${pathLabel}.finalization is not supported; acceptance contracts always run the self-review loop.`);
	if (Object.hasOwn(value, "reason")) errors.push(`${pathLabel}.reason is not supported because acceptance is disabled by omitting the field.`);
	for (const key of Object.keys(value)) {
		if (!ACCEPTANCE_KEYS.has(key) && !REMOVED_ACCEPTANCE_KEYS.has(key)) errors.push(`${pathLabel}.${key} is not supported.`);
	}

	const structuralValue = Object.fromEntries(Object.entries(value).filter(([key]) => ACCEPTANCE_KEYS.has(key)));
	const schemaErrors = [...ACCEPTANCE_VALIDATOR.Errors(structuralValue)];
	for (const error of schemaErrors) {
		const criterionMatch = error.instancePath.match(/^\/criteria\/(\d+)$/);
		if (criterionMatch) {
			const criterion = Array.isArray(value.criteria) ? value.criteria[Number(criterionMatch[1])] : undefined;
			if (criterion && typeof criterion === "object" && !Array.isArray(criterion)) {
				if (error.keyword === "anyOf" || error.schemaPath.includes("/anyOf/0")) continue;
			} else if (typeof criterion === "string") {
				if (error.keyword === "anyOf" || error.schemaPath.includes("/anyOf/1")) continue;
			} else if (error.keyword !== "anyOf") {
				continue;
			}
		}
		if (error.keyword === "minLength") continue;
		const errorPath = acceptanceErrorPath(pathLabel, error.instancePath);
		if (error.keyword === "anyOf" && criterionMatch) {
			errors.push(`${errorPath} must be a string or object.`);
		} else if (error.keyword === "required") {
			for (const property of error.params.requiredProperties as string[]) errors.push(`${errorPath}.${property} is required.`);
		} else if (error.keyword === "enum" && error.instancePath.includes("/evidence/")) {
			errors.push(`${errorPath} is not a supported evidence kind.`);
		} else if (error.keyword === "enum" && error.instancePath.endsWith("/severity")) {
			errors.push(`${errorPath} must be required or recommended.`);
		} else if (error.instancePath.endsWith("/timeoutMs")) {
			errors.push(`${errorPath} must be a positive integer.`);
		} else if (error.instancePath === "/maxFinalizationTurns") {
			errors.push(`${errorPath} must be an integer from 1 to ${MAX_FINALIZATION_TURNS}.`);
		} else if (error.keyword === "additionalProperties") {
			for (const property of error.params.additionalProperties as string[]) {
				errors.push(error.instancePath.endsWith("/env") ? `${errorPath}.${property} must be a string.` : `${errorPath}.${property} is not supported.`);
			}
		} else if (error.keyword === "type") {
			const expected = String(error.params.type);
			const suffix = error.instancePath.match(/^\/stopRules\/\d+$/) ? "a non-empty string" : expected === "array" || expected === "object" ? `an ${expected}` : `a ${expected}`;
			errors.push(`${errorPath} must be ${suffix}.`);
		} else {
			errors.push(`${errorPath} ${error.message}.`);
		}
	}

	for (const [index, criterion] of Array.isArray(value.criteria) ? value.criteria.entries() : []) {
		if (typeof criterion === "string" && !criterion.trim()) errors.push(`${pathLabel}.criteria[${index}] must not be empty.`);
		if (criterion && typeof criterion === "object" && !Array.isArray(criterion)) {
			const item = criterion as Record<string, unknown>;
			if (typeof item.id === "string" && !item.id.trim()) errors.push(`${pathLabel}.criteria[${index}].id is required.`);
			if (typeof item.must === "string" && !item.must.trim()) errors.push(`${pathLabel}.criteria[${index}].must is required.`);
		}
	}
	for (const [index, command] of Array.isArray(value.verify) ? value.verify.entries() : []) {
		if (!command || typeof command !== "object" || Array.isArray(command)) continue;
		const item = command as Record<string, unknown>;
		if (typeof item.id === "string" && !item.id.trim()) errors.push(`${pathLabel}.verify[${index}].id is required.`);
		if (typeof item.command === "string" && !item.command.trim()) errors.push(`${pathLabel}.verify[${index}].command is required.`);
	}
	for (const [index, rule] of Array.isArray(value.stopRules) ? value.stopRules.entries() : []) {
		if (typeof rule === "string" && !rule.trim()) errors.push(`${pathLabel}.stopRules[${index}] must be a non-empty string.`);
	}

	if (!hasArrayItems(value.criteria) && !hasArrayItems(value.evidence) && !hasArrayItems(value.verify) && !hasArrayItems(value.stopRules)) {
		errors.push(`${pathLabel} must include at least one of criteria, evidence, verify, or stopRules.`);
	}
	return [...new Set(errors)];
}

function normalizeCriteria(criteria: AcceptanceConfig["criteria"], evidence: AcceptanceEvidenceKind[]): ResolvedAcceptanceGate[] {
	return (criteria ?? []).map((criterion, index) => {
		if (typeof criterion === "string") {
			return { id: `criterion-${index + 1}`, must: criterion, evidence, severity: "required" as const };
		}
		return {
			id: criterion.id.trim(),
			must: criterion.must,
			evidence: criterion.evidence?.filter((item) => VALID_EVIDENCE.has(item)) ?? evidence,
			severity: criterion.severity ?? "required",
		};
	}).filter((criterion) => criterion.must.trim());
}

function deriveAcceptanceLevel(config: AcceptanceConfig): AcceptanceProvenanceLevel {
	if ((config.verify?.length ?? 0) > 0) return "verified";
	return "checked";
}

export function resolveEffectiveAcceptance(input: { explicit?: AcceptanceInput }): ResolvedAcceptanceConfig {
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
	if (validationErrors.length > 0) throw new Error(validationErrors.join(" "));
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
		finalization: { mode: "self-review-loop", maxTurns: explicit.maxFinalizationTurns ?? DEFAULT_FINALIZATION_MAX_TURNS },
	};
}

export function acceptanceInputFromResolved(acceptance: ResolvedAcceptanceConfig | undefined): AcceptanceInput | undefined {
	if (!acceptance?.explicit) return undefined;
	const maxTurns = acceptance.finalization?.maxTurns;
	return {
		criteria: acceptance.criteria,
		evidence: acceptance.evidence,
		verify: acceptance.verify,
		stopRules: acceptance.stopRules,
		...(maxTurns !== undefined ? { maxFinalizationTurns: maxTurns } : {}),
	};
}

export function shouldRunAcceptanceFinalization(acceptance: ResolvedAcceptanceConfig): boolean {
	return acceptance.explicit && acceptance.finalization.mode === "self-review-loop" && acceptance.finalization.maxTurns > 0;
}

export function acceptanceSelfReviewConfig(acceptance: ResolvedAcceptanceConfig): ResolvedAcceptanceConfig {
	if (acceptance.verify.length === 0) return acceptance;
	return {
		...acceptance,
		level: "checked",
		verify: [],
	};
}

export function formatAcceptancePrompt(acceptance: ResolvedAcceptanceConfig): string {
	if (acceptance.level === "none") return "";
	const lines = [
		"",
		"## Acceptance Contract",
		"Completion is not accepted from prose alone. End the initial response with a structured acceptance report.",
		"After the initial response, the runtime will continue this same session for a bounded self-review/repair loop before accepting the run.",
		"",
		"Criteria:",
		...(acceptance.criteria.length ? acceptance.criteria.map((criterion) => `- ${criterion.id}: ${criterion.must}`) : ["- No explicit criteria were configured; satisfy the requested task and the required evidence/checks below."]),
		"",
		`Required evidence: ${acceptance.evidence.join(", ") || "none explicitly requested"}`,
	];
	if (acceptance.evidence.length > 0) {
		lines.push(
			"",
			"Structured evidence must be present in the `acceptance-report` JSON fields. Markdown sections in your visible answer do not satisfy required evidence by themselves. If you already described evidence in prose, copy or summarize it into the matching JSON field.",
			"Evidence field mapping:",
			...formatEvidenceReportFieldMapping(acceptance.evidence),
		);
	}
	if (acceptance.verify.length > 0) {
		lines.push("", "Runtime verification commands configured by parent:");
		for (const command of acceptance.verify) lines.push(`- ${command.id}: ${command.command}`);
	}
	if (acceptance.stopRules.length > 0) {
		lines.push("", "Stop rules:", ...acceptance.stopRules.map((rule) => `- ${rule}`));
	}
	lines.push(
		"",
		"Finish with a fenced JSON block tagged `acceptance-report` in this shape:",
		"```acceptance-report",
		JSON.stringify({
			criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "specific proof" }],
			changedFiles: [],
			testsAddedOrUpdated: [],
			commandsRun: [{ command: "command", result: "passed", summary: "short result" }],
			validationOutput: [],
			residualRisks: [],
			noStagedFiles: true,
			diffSummary: "concise summary of changed behavior and important files",
			reviewFindings: [],
			manualNotes: "manual notes or external evidence, if any",
			notes: "anything else the parent should know",
		}, null, 2),
		"```",
	);
	return lines.join("\n");
}
