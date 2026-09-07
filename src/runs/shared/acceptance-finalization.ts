import { isDeepStrictEqual } from "node:util";
import type { Message } from "@earendil-works/pi-ai";
import { createStructuredOutputRuntime, readStructuredOutput, validateStructuredOutputValue, type StructuredOutputRuntime } from "./structured-output.ts";
import type {
	AcceptanceFinalizationTurn,
	AcceptanceLedger,
	ResolvedAcceptanceConfig,
} from "../../shared/types.ts";
import { acceptanceFailureMessage, evaluateAcceptance } from "./acceptance-evaluation.ts";
import { acceptanceSelfReviewConfig, formatEvidenceReportFieldMapping, shouldRunAcceptanceFinalization } from "./acceptance-contract.ts";
import type { AttemptOutcome } from "./model-fallback.ts";
import { isFailFastAbort } from "./parallel-utils.ts";
import { parseAcceptanceReport, stripAcceptanceReport } from "./acceptance-reports.ts";

export function createFinalizationReportRuntime(): StructuredOutputRuntime {
	return createStructuredOutputRuntime({
		type: "object", properties: { report: { type: "string", minLength: 1 } }, required: ["report"], additionalProperties: false,
	});
}

interface FinalizationReportSubmission {
	output: string;
	reportSubmissionError?: string;
	unconfirmedOutput?: string;
}

export function readFinalizationReport(messages: Message[], runtime: StructuredOutputRuntime): FinalizationReportSubmission {
	const captured = readStructuredOutput(runtime);
	const report = (captured.value as { report: string } | undefined)?.report;
	// Older submissions are audit evidence only, never the current output below.
	const successfulIds = new Set(messages.flatMap((message) => message.role === "toolResult" && message.toolName === "structured_output" && message.isError === false ? [message.toolCallId] : []));
	let unconfirmedOutput = report && parseAcceptanceReport(report).report ? report : undefined;
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const call of message.content) {
			if (call.type !== "toolCall" || call.name !== "structured_output" || !successfulIds.has(call.id)) continue;
			const value = call.arguments.value;
			if (validateStructuredOutputValue(runtime.schema, value).status === "valid" && parseAcceptanceReport(value.report).report) unconfirmedOutput = value.report;
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
	const calls = last.content.filter((part) => part.type === "toolCall");
	if (calls.length !== 1 || calls[0]!.name !== "structured_output") return rejected("the latest assistant turn must submit structured_output as its only tool call.");
	const call = calls[0]!;
	const result = messages.slice(index + 1).findLast((message) => message.role === "toolResult" && message.toolCallId === call.id);
	if (result?.role !== "toolResult" || result.toolName !== "structured_output" || result.isError !== false) return rejected("the latest structured_output call has no matching successful result.");
	if (captured.error) return rejected(captured.error);
	if (!isDeepStrictEqual(captured.value, call.arguments.value)) return rejected("the capture does not match the latest submission.");
	return { output: report!, unconfirmedOutput };
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
	sessionFile?: string;
	cwd: string;
	signal?: AbortSignal;
	nativeReport?: boolean;
	runTurn: (prompt: string, turn: number, sessionFile: string) => Promise<FinalizationReportSubmission & { error?: string }>;
}): Promise<AcceptanceLedger> {
	const review = shouldRunAcceptanceFinalization(input.acceptance);
	const selfReview = review ? acceptanceSelfReviewConfig(input.acceptance) : input.acceptance;
	const initialLedger = await evaluateAcceptance({ acceptance: selfReview, governing: input.acceptance, output: input.initialOutput, cwd: input.cwd, signal: input.signal });
	if (!review || input.initial.exitCode !== 0 || input.initial.error || input.initial.interrupted || input.signal?.aborted) return initialLedger;

	const maxTurns = input.acceptance.finalization.maxTurns;
	const turns: AcceptanceFinalizationTurn[] = [];
	if (!input.sessionFile) {
		const message = "Acceptance finalization requires a session file for same-session continuation.";
		turns.push(createFinalizationProcessFailureTurn({ turn: 1, prompt: "", message }));
		return buildFinalizationProcessFailureLedger({ initialLedger, turns, maxTurns, message });
	}
	let previousFailure = acceptanceFailureMessage(initialLedger);
	let authoritativeLedger = initialLedger;
	let auditOutput = input.initialOutput;
	for (let turn = 1; turn <= maxTurns; turn++) {
		const prompt = formatAcceptanceFinalizationPrompt({ acceptance: input.acceptance, initialOutput: input.initialOutput, initialLedger, turn, maxTurns, previousFailure, nativeReport: input.nativeReport });
		const result = input.signal?.aborted
			? { output: "", error: "Acceptance finalization cancelled." }
			: await input.runTurn(prompt, turn, input.sessionFile);
		const retained = result.unconfirmedOutput ?? result.output;
		if (input.nativeReport && parseAcceptanceReport(retained).report) auditOutput = retained;
		if (result.error) {
			turns.push({ ...createFinalizationProcessFailureTurn({ turn, prompt, rawOutput: result.output, message: result.error }),
				...(input.nativeReport ? { unconfirmedOutput: auditOutput } : {}) });
			const ledger = buildFinalizationProcessFailureLedger({ initialLedger, turns, maxTurns, message: result.error });
			return input.nativeReport ? { ...ledger, childReport: undefined, childReportParseError: result.reportSubmissionError, unconfirmedOutput: auditOutput } : ledger;
		}
		authoritativeLedger = await evaluateAcceptance({ acceptance: selfReview, governing: input.acceptance, output: result.reportSubmissionError ? "" : result.output, cwd: input.cwd, signal: input.signal });
		if (result.reportSubmissionError) {
			authoritativeLedger.childReportParseError = result.reportSubmissionError;
			authoritativeLedger.runtimeChecks = [{ id: "finalization-report", status: "failed", message: result.reportSubmissionError }];
		}
		if (input.nativeReport && authoritativeLedger.childReportParseError) authoritativeLedger.unconfirmedOutput = auditOutput;
		turns.push(createFinalizationTurn({ turn, prompt, rawOutput: result.output, ledger: authoritativeLedger }));
		const failure = acceptanceFailureMessage(authoritativeLedger);
		if (!failure && !input.signal?.aborted) {
			if (selfReview !== input.acceptance) authoritativeLedger = await evaluateAcceptance({ acceptance: input.acceptance, output: result.output, cwd: input.cwd, signal: input.signal });
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
}): string {
	const evidence = [...new Set([...input.acceptance.evidence, ...input.acceptance.criteria.flatMap((criterion) => criterion.evidence)])];
	const lines = [
		"## Acceptance Finalization",
		"You are continuing the same subagent session. Before this run can be accepted, compare the current work to the acceptance contract and the evidence below.",
		`This is finalization turn ${input.turn} of ${input.maxTurns}. The run will be rejected if the contract is still not satisfied after turn ${input.maxTurns}.`,
		"",
		"If a criterion is incomplete and fixable in this session, keep working now before returning the final report.",
		"If a criterion cannot be satisfied in this session, report it as not-satisfied, explain the blocker in residualRisks, and say what input would unblock progress.",
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
			"Structured evidence must be present in the final `acceptance-report` JSON fields. Markdown sections in the visible answer do not satisfy required evidence by themselves. If the previous visible output already included the evidence, copy or summarize it into the matching JSON field.",
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
		input.nativeReport
			? "Now do the self-check. Your final action must be a sole `structured_output` tool call with {\"value\":{\"report\":\"...\"}}. The report string must contain the complete standalone final answer with the current result and every requested handoff detail (including paths, identifiers, findings, and evidence), repairs or remaining blockers, and end with exactly one fenced JSON block tagged `acceptance-report`. This report replaces the initial answer; do not replace useful details with only a statement that you rechecked them. If additional messages prompt more activity after submission, resubmit the complete current report as your final action; a prose-only reply does not finalize the task."
			: "Now do the self-check. Return a standalone final answer with the current result and every requested handoff detail (including paths, identifiers, findings, and evidence). This answer replaces the initial answer; do not replace useful details with only a statement that you rechecked them. Include repairs or remaining blockers, then finish with exactly one fenced JSON block tagged `acceptance-report`.",
		"```acceptance-report",
		JSON.stringify({
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
			notes: "final self-review summary",
		}, null, 2),
		"```",
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
	status: "completed" | "failed";
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
