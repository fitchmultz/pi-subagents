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
	runTurn: (prompt: string, turn: number, sessionFile: string) => Promise<{ output: string; error?: string }>;
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
	for (let turn = 1; turn <= maxTurns; turn++) {
		const prompt = formatAcceptanceFinalizationPrompt({ acceptance: input.acceptance, initialOutput: input.initialOutput, initialLedger, turn, maxTurns, previousFailure });
		const result = input.signal?.aborted
			? { output: "", error: "Acceptance finalization cancelled." }
			: await input.runTurn(prompt, turn, input.sessionFile);
		if (result.error) {
			turns.push(createFinalizationProcessFailureTurn({ turn, prompt, rawOutput: result.output, message: result.error }));
			return buildFinalizationProcessFailureLedger({ initialLedger, turns, maxTurns, message: result.error });
		}
		authoritativeLedger = await evaluateAcceptance({ acceptance: selfReview, governing: input.acceptance, output: result.output, cwd: input.cwd, signal: input.signal });
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
		"Now do the self-check. Return a standalone final answer with the current result and every requested handoff detail (including paths, identifiers, findings, and evidence). This answer replaces the initial answer; do not replace useful details with only a statement that you rechecked them. Include repairs or remaining blockers, then finish with exactly one fenced JSON block tagged `acceptance-report`.",
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
