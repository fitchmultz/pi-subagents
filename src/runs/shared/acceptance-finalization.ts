import { isDeepStrictEqual } from "node:util";
import type { Message } from "@earendil-works/pi-ai";
import { createStructuredOutputRuntime, readStructuredOutput, validateStructuredOutputValue, type StructuredOutputRuntime } from "./structured-output.ts";
import type {
	AcceptanceFinalizationTurn,
	AcceptanceLedger,
	AcceptanceReport,
	JsonSchemaObject,
	ResolvedAcceptanceConfig,
} from "../../shared/types.ts";
import { acceptanceFailureMessage, evaluateAcceptance } from "./acceptance-evaluation.ts";
import { acceptanceSelfReviewConfig, formatEvidenceReportFieldMapping, shouldRunAcceptanceFinalization } from "./acceptance-contract.ts";
import type { AttemptOutcome } from "./model-fallback.ts";
import { isFailFastAbort } from "./parallel-utils.ts";
import { ACCEPTANCE_REPORT_SCHEMA, formatAcceptanceReportExample, parseAcceptanceReport, stripAcceptanceReport, validateAcceptanceReportShape } from "./acceptance-reports.ts";

type FinalizationReportRuntime = StructuredOutputRuntime & { publicOutputSchema?: JsonSchemaObject };

export function createFinalizationReportRuntime(publicOutputSchema?: JsonSchemaObject): FinalizationReportRuntime {
	const runtime = createStructuredOutputRuntime({
		type: "object", properties: {
			// A schema resource keeps root-local references (including recursive "#") scoped to the public answer.
			answer: publicOutputSchema ? { $id: "urn:pi-subagents:public-output", ...publicOutputSchema }
				: { type: "string", pattern: "\\S", description: "Complete standalone final answer, including every requested handoff detail." },
			report: ACCEPTANCE_REPORT_SCHEMA,
		}, required: ["answer", "report"], additionalProperties: false,
	});
	return { ...runtime, publicOutputSchema };
}

export interface FinalizationReportSubmission {
	output: string;
	structuredOutput?: unknown;
	report?: AcceptanceReport;
	reportSubmissionError?: string;
	unconfirmedOutput?: string;
}

function readReportValue(value: unknown, publicOutputSchema?: JsonSchemaObject): (FinalizationReportSubmission & { report: AcceptanceReport }) | undefined {
	if (!value || typeof value !== "object") return;
	// Stored legacy runtimes retain their original string schema.
	if (!publicOutputSchema && "report" in value && typeof value.report === "string") {
		const parsed = parseAcceptanceReport(value.report);
		if (parsed.report) return { output: value.report, report: parsed.report };
	}
	if (!("answer" in value) || !("report" in value)) return;
	if (validateAcceptanceReportShape(value.report)) return;
	if (publicOutputSchema) {
		if (validateStructuredOutputValue(publicOutputSchema, value.answer).status === "invalid") return;
		return { output: JSON.stringify(value.answer), structuredOutput: value.answer, report: value.report as AcceptanceReport };
	}
	if (typeof value.answer !== "string" || !value.answer.trim()) return;
	return { output: value.answer, report: value.report as AcceptanceReport };
}

function reportAuditOutput(submission: { output: string; report?: AcceptanceReport }): string {
	return submission.report && !parseAcceptanceReport(submission.output).report
		? `${submission.output}\n\n\`\`\`acceptance-report\n${JSON.stringify(submission.report)}\n\`\`\`` : submission.output;
}

/** Pass the current attempt's messages, or its starting offset in a shared native session. */
export function readFinalizationReport(messages: Message[], runtime: FinalizationReportRuntime, options: { messageOffset?: number; structuredResult?: boolean } = {}): FinalizationReportSubmission {
	messages = messages.slice(options.messageOffset ?? 0);
	const captured = readStructuredOutput(runtime);
	const submitted = readReportValue(captured.value, runtime.publicOutputSchema);
	// Older submissions are audit evidence only, never the current output below.
	const successfulIds = new Set(messages.flatMap((message) => message.role === "toolResult" && message.toolName === "structured_output" && message.isError === false ? [message.toolCallId] : []));
	let unconfirmedOutput = submitted && reportAuditOutput(submitted);
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const call of message.content) {
			if (call.type !== "toolCall" || call.name !== "structured_output" || !successfulIds.has(call.id)) continue;
			const value = call.arguments.value;
			const previous = readReportValue(value, runtime.publicOutputSchema);
			if (previous && validateStructuredOutputValue(runtime.schema, value).status === "valid") unconfirmedOutput = reportAuditOutput(previous);
		}
	}
	const rejected = (reason: string): FinalizationReportSubmission => ({
		output: "", reportSubmissionError: `No current finalization report: ${reason}`, unconfirmedOutput,
	});
	const index = messages.findLastIndex((message) => message.role === "assistant");
	const last = messages[index];
	if (last?.role !== "assistant" || last.errorMessage || !["stop", "toolUse"].includes(last.stopReason) || !Array.isArray(last.content)) {
		return rejected("the latest assistant turn did not finish successfully.");
	}
	// Claude Code returns its schema-constrained payload in the terminal result event, not a Pi tool call.
	if (options.structuredResult) {
		if (captured.error) return rejected(captured.error);
		return submitted ? { ...submitted, unconfirmedOutput } : rejected("the submission must contain a complete answer and a valid acceptance report.");
	}
	const calls = last.content.filter((part) => part.type === "toolCall");
	if (calls.length !== 1 || calls[0]!.name !== "structured_output") return rejected("the latest assistant turn must submit structured_output as its only tool call.");
	const call = calls[0]!;
	const result = messages.slice(index + 1).findLast((message) => message.role === "toolResult" && message.toolCallId === call.id);
	if (result?.role !== "toolResult" || result.toolName !== "structured_output" || result.isError !== false) return rejected("the latest structured_output call has no matching successful result.");
	if (captured.error) return rejected(captured.error);
	if (!isDeepStrictEqual(captured.value, call.arguments.value)) return rejected("the capture does not match the latest submission.");
	if (!submitted) return rejected("the submission must contain a complete answer and a valid acceptance report.");
	return { ...submitted, unconfirmedOutput };
}

export function formatUnconfirmedFinalizationOutput(output: string): string {
	return `UNCONFIRMED task report — retained for audit only; finalization did not deliver a current complete report.\n\n${stripAcceptanceReport(output)}`;
}

export function resolveFinalizationOutput(rawOutput: string, previousOutput: string): string {
	const prose = stripAcceptanceReport(rawOutput);
	if (prose.trim()) return prose;
	const report = parseAcceptanceReport(rawOutput).report;
	return report?.diffSummary?.trim() || report?.notes?.trim() || previousOutput;
}

type ExecutionOutcome = Pick<AttemptOutcome, "exitCode" | "error" | "interrupted" | "timedOut" | "resourceLimitExceeded">;

export function resolveExecutionOutcome(input: {
	result: ExecutionOutcome;
	acceptance?: AcceptanceLedger;
	signal?: AbortSignal;
	interruptSignal?: AbortSignal;
}): ExecutionOutcome {
	const { result } = input;
	if (input.signal?.aborted && input.signal.reason instanceof Error && input.signal.reason.name === "TimeoutError") {
		return { ...result, exitCode: 124, timedOut: true, interrupted: false, error: input.signal.reason.message || "Subagent timed out." };
	}
	if (input.signal?.aborted) return { ...result, exitCode: 1, interrupted: false, error: "Subagent cancelled." };
	if (isFailFastAbort(input.interruptSignal)) return { ...result, exitCode: -1, interrupted: false, error: "Interrupted due to fail-fast" };
	if (result.timedOut || result.resourceLimitExceeded) return { ...result, exitCode: result.timedOut ? 124 : 1, interrupted: result.interrupted === undefined ? undefined : false };
	if (input.interruptSignal?.aborted || result.interrupted) return { ...result, exitCode: 0, interrupted: true, error: undefined };
	const failure = input.acceptance?.explicit ? acceptanceFailureMessage(input.acceptance) : undefined;
	if (failure && result.exitCode === 0) return { ...result, exitCode: 1, error: result.error ? `${result.error}\n${failure}` : failure };
	return result;
}

export async function evaluateRunAcceptance(input: {
	acceptance: ResolvedAcceptanceConfig;
	initial: ExecutionOutcome;
	initialOutput: string;
	initialReport?: AcceptanceReport;
	initialAcceptance?: AcceptanceLedger;
	sessionFile?: string;
	cwd: string;
	signal?: AbortSignal;
	nativeReport?: boolean;
	outputSchema?: JsonSchemaObject;
	recordedTurns?: number;
	runTurn: (prompt: string, turn: number, sessionFile: string) => Promise<FinalizationReportSubmission & { error?: string; acceptance?: AcceptanceLedger }>;
}): Promise<AcceptanceLedger> {
	const review = shouldRunAcceptanceFinalization(input.acceptance);
	const selfReview = review ? acceptanceSelfReviewConfig(input.acceptance) : input.acceptance;
	const initialLedger = input.initialAcceptance ?? await evaluateAcceptance({ acceptance: selfReview, governing: input.acceptance, output: input.initialOutput, report: input.initialReport, cwd: input.cwd, signal: input.signal });
	if (initialLedger.status === "blocked" || !review || input.initial.exitCode !== 0 || input.initial.error || input.initial.interrupted || (input.signal?.aborted && !input.recordedTurns)) return initialLedger;

	const maxTurns = input.acceptance.finalization.maxTurns;
	const turns: AcceptanceFinalizationTurn[] = [];
	if (!input.sessionFile) {
		const message = "Acceptance finalization requires a session file for same-session continuation.";
		turns.push(createFinalizationProcessFailureTurn({ turn: 1, prompt: "", message }));
		return buildFinalizationProcessFailureLedger({ initialLedger, turns, maxTurns, message });
	}
	let previousFailure = acceptanceFailureMessage(initialLedger);
	let authoritativeLedger = initialLedger;
	let auditOutput = reportAuditOutput({ output: input.initialOutput, report: input.initialReport });
	for (let turn = 1; turn <= maxTurns; turn++) {
		const prompt = formatAcceptanceFinalizationPrompt({ acceptance: input.acceptance, initialOutput: input.initialOutput, initialLedger, turn, maxTurns, previousFailure, nativeReport: input.nativeReport, outputSchema: input.outputSchema });
		const result = input.signal?.aborted && turn > (input.recordedTurns ?? 0)
			? { output: "", error: "Acceptance finalization cancelled." }
			: await input.runTurn(prompt, turn, input.sessionFile);
		const retained = result.unconfirmedOutput ?? reportAuditOutput(result);
		if (input.nativeReport && parseAcceptanceReport(retained).report) auditOutput = retained;
		if (result.error) {
			turns.push({ ...createFinalizationProcessFailureTurn({ turn, prompt, rawOutput: result.output, message: result.error }),
				...(input.nativeReport ? { unconfirmedOutput: auditOutput } : {}) });
			const ledger = buildFinalizationProcessFailureLedger({ initialLedger, turns, maxTurns, message: result.error });
			return input.nativeReport ? { ...ledger, childReport: undefined, childReportParseError: result.reportSubmissionError, unconfirmedOutput: auditOutput } : ledger;
		}
		// Replay each native boundary's checks, not the workspace left by a later repair.
		authoritativeLedger = !result.reportSubmissionError && result.acceptance
			? result.acceptance
			: await evaluateAcceptance({ acceptance: selfReview, governing: input.acceptance, output: result.reportSubmissionError ? "" : result.output, report: result.reportSubmissionError ? undefined : result.report, cwd: input.cwd, signal: input.signal });
		if (result.reportSubmissionError) {
			authoritativeLedger.childReportParseError = result.reportSubmissionError;
			authoritativeLedger.runtimeChecks = [{ id: "finalization-report", status: "failed", message: result.reportSubmissionError }];
		}
		if (input.nativeReport && authoritativeLedger.childReportParseError) authoritativeLedger.unconfirmedOutput = auditOutput;
		turns.push(createFinalizationTurn({ turn, prompt, rawOutput: result.output, ledger: authoritativeLedger }));
		if (authoritativeLedger.status === "blocked") return attachFinalizationToLedger({ initialLedger, authoritativeLedger, turns, status: "blocked", maxTurns });
		const failure = acceptanceFailureMessage(authoritativeLedger);
		if (!failure && !input.signal?.aborted) {
			if (result.acceptance || selfReview !== input.acceptance) authoritativeLedger = await evaluateAcceptance({ acceptance: input.acceptance, output: result.output, report: result.report, cwd: input.cwd, signal: input.signal });
			return attachFinalizationToLedger({ initialLedger, authoritativeLedger, turns, status: input.signal?.aborted ? "failed" : "completed", maxTurns });
		}
		if (input.signal?.aborted) break;
		previousFailure = failure;
	}
	return attachFinalizationToLedger({ initialLedger, authoritativeLedger, turns, status: "failed", maxTurns });
}

const INITIAL_OUTPUT_LIMIT = 8_000;

function truncateForPrompt(value: string): string {
	const trimmed = stripAcceptanceReport(value).trim();
	if (trimmed.length <= INITIAL_OUTPUT_LIMIT) return trimmed || "(initial output was empty after removing acceptance-report)";
	return `${trimmed.slice(0, INITIAL_OUTPUT_LIMIT)}\n...[truncated]`;
}

function formatReportForPrompt(ledger: AcceptanceLedger): string {
	if (ledger.childReport) return JSON.stringify(ledger.childReport, null, 2);
	return `Missing or malformed acceptance report: ${ledger.childReportParseError ?? "no parse detail"}`;
}

export function formatAcceptanceFinalizationPrompt(input: {
	acceptance: ResolvedAcceptanceConfig;
	initialOutput: string;
	initialLedger: AcceptanceLedger;
	turn: number;
	maxTurns: number;
	previousFailure?: string;
	nativeReport?: boolean;
	outputSchema?: JsonSchemaObject;
}): string {
	const evidence = [...new Set([...input.acceptance.evidence, ...input.acceptance.criteria.flatMap((criterion) => criterion.evidence)])];
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
		"Criteria:",
		...(input.acceptance.criteria.length ? input.acceptance.criteria.map((criterion) => `- ${criterion.id}: ${criterion.must}${criterion.evidence.length ? ` (evidence: ${criterion.evidence.join(", ")})` : ""}`) : ["- No explicit criteria were configured; satisfy the requested task and required evidence/checks."]),
		"",
		`Required evidence: ${evidence.join(", ") || "none explicitly requested"}`,
	];
	if (evidence.length > 0) {
		lines.push(
			"",
			`Structured evidence must be present in the ${input.nativeReport || input.outputSchema ? "typed report object" : "final `acceptance-report` JSON fields"}. Markdown sections in the visible answer do not satisfy required evidence by themselves. If the previous visible output already included the evidence, copy or summarize it into the matching JSON field.`,
			"Evidence field mapping:",
			...formatEvidenceReportFieldMapping(evidence),
		);
	}
	if (input.acceptance.verify.length > 0) {
		lines.push("", "Runtime verification commands that must pass:", ...input.acceptance.verify.map((command) => `- ${command.id}: ${command.command}`));
	}
	if (input.acceptance.stopRules.length > 0) {
		lines.push("", "Stop rules are hard constraints while deciding whether to continue, stop as blocked, or report success:", ...input.acceptance.stopRules.map((rule) => `- ${rule}`));
	}
	lines.push(
		"",
		"Initial visible output:",
		truncateForPrompt(input.initialOutput),
		"",
		"Initial acceptance report:",
		formatReportForPrompt(input.initialLedger),
	);
	if (input.previousFailure) {
		lines.push("", "Previous finalization failure to address:", input.previousFailure);
	}
	lines.push(
		"",
		input.outputSchema
			? `${input.nativeReport ? "Your final action must be a sole `structured_output` tool call with {value:{answer,report}}." : "Return the schema-constrained JSON object {answer,report}."} answer must be the complete current public payload matching outputSchema below, including all repairs; do not embed it in a prose string. report is the private typed acceptance object. This submission replaces the initial payload. If more activity follows submission, resubmit the complete current answer and report.\noutputSchema: ${JSON.stringify(input.outputSchema)}`
			: input.nativeReport
			? "Now do the self-check. Your final action must be a sole `structured_output` tool call with {value:{answer,report}}. answer must contain the complete standalone final answer with the current result and every requested handoff detail (including paths, identifiers, findings, and evidence), repairs or remaining blockers. report is a typed object matching the schema, never JSON embedded in a string. This answer replaces the initial answer; do not replace useful details with only a statement that you rechecked them. If additional messages prompt more activity after submission, resubmit the complete current answer and report as your final action; a prose-only reply does not finalize the task."
			: "Now do the self-check. Return a standalone final answer with the current result and every requested handoff detail (including paths, identifiers, findings, and evidence). This answer replaces the initial answer; do not replace useful details with only a statement that you rechecked them. Include repairs or remaining blockers, then finish with exactly one fenced JSON block tagged `acceptance-report`.",
		...(input.outputSchema ? [] : [formatAcceptanceReportExample(input.nativeReport)]),
	);
	return lines.join("\n");
}

export function createFinalizationTurn(input: {
	turn: number;
	prompt: string;
	rawOutput: string;
	ledger: AcceptanceLedger;
}): AcceptanceFinalizationTurn {
	const failureMessage = acceptanceFailureMessage(input.ledger);
	return {
		turn: input.turn,
		prompt: input.prompt,
		status: input.ledger.status,
		rawOutput: input.rawOutput,
		...(input.ledger.unconfirmedOutput !== undefined ? { unconfirmedOutput: input.ledger.unconfirmedOutput } : {}),
		...(input.ledger.childReport ? { report: input.ledger.childReport } : {}),
		...(input.ledger.childReportParseError ? { parseError: input.ledger.childReportParseError } : {}),
		runtimeChecks: input.ledger.runtimeChecks,
		verifyRuns: input.ledger.verifyRuns,
		...(failureMessage ? { failureMessage } : {}),
	};
}

export function createFinalizationProcessFailureTurn(input: {
	turn: number;
	prompt: string;
	rawOutput?: string;
	message: string;
}): AcceptanceFinalizationTurn {
	return {
		turn: input.turn,
		prompt: input.prompt,
		status: "rejected",
		...(input.rawOutput ? { rawOutput: input.rawOutput } : {}),
		runtimeChecks: [{ id: "finalization-process", status: "failed", message: input.message }],
		verifyRuns: [],
		failureMessage: `Acceptance rejected: ${input.message}`,
	};
}

export function attachFinalizationToLedger(input: {
	initialLedger: AcceptanceLedger;
	authoritativeLedger: AcceptanceLedger;
	turns: AcceptanceFinalizationTurn[];
	status: "completed" | "blocked" | "failed";
	maxTurns: number;
}): AcceptanceLedger {
	return {
		...input.authoritativeLedger,
		...(input.initialLedger.childReport ? { initialChildReport: input.initialLedger.childReport } : {}),
		...(input.initialLedger.childReportParseError ? { initialChildReportParseError: input.initialLedger.childReportParseError } : {}),
		finalization: {
			mode: "self-review-loop",
			status: input.status,
			maxTurns: input.maxTurns,
			turns: input.turns,
		},
	};
}

export function buildFinalizationProcessFailureLedger(input: {
	initialLedger: AcceptanceLedger;
	turns: AcceptanceFinalizationTurn[];
	maxTurns: number;
	message: string;
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
