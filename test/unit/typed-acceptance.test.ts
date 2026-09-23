import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { it } from "node:test";
import { fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { evaluateAcceptance, evaluateAcceptanceReport } from "../../src/runs/shared/acceptance-evaluation.ts";
import { formatAcceptancePrompt, resolveEffectiveAcceptance } from "../../src/runs/shared/acceptance-contract.ts";
import { createFinalizationReportRuntime, evaluateRunAcceptance, formatAcceptanceFinalizationPrompt, readFinalizationReport, resolveExecutionOutcome } from "../../src/runs/shared/acceptance-finalization.ts";
import { parseAcceptanceReport } from "../../src/runs/shared/acceptance-reports.ts";
import { createStructuredOutputRuntime, validateStructuredOutputValue } from "../../src/runs/shared/structured-output.ts";
import type { AcceptanceReport } from "../../src/shared/types.ts";
import { resolveJsonSchemaStrictSampling } from "@earendil-works/pi-ai/api/constrained-sampling";

const answer = "Result: /fixture/report.md\nIdentifier: task-42\nFindings and verification are complete.";
const report: AcceptanceReport = {
	criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "Fixture output and commands verified" }],
	diffSummary: "Verified fixture",
	reviewFindings: [{ summary: "Finding retained", custom: { lines: [1, 2] } }],
};
const value = { answer, report };
const acceptance = resolveEffectiveAcceptance({ explicit: { criteria: ["Deliver fixture"] } });
const resultMessage = (id = "current"): Message => ({ role: "toolResult", toolCallId: id, toolName: "structured_output", isError: false, content: [{ type: "text", text: "Captured" }], timestamp: Date.now() });
const submit = (payload: unknown = value, id = "current"): Message => fauxAssistantMessage(fauxToolCall("structured_output", { value: payload }, { id }), { stopReason: "toolUse" });


it("keeps timeout aborts distinct from cancellation", () => {
	const timeout = new Error("Configured child deadline elapsed");
	timeout.name = "TimeoutError";
	const outcome = resolveExecutionOutcome({ result: { exitCode: 0 }, signal: AbortSignal.abort(timeout) });
	assert.equal(outcome.exitCode, 124);
	assert.equal(outcome.timedOut, true);
	assert.equal(outcome.error, timeout.message);
	assert.equal(resolveExecutionOutcome({ result: { exitCode: 0 }, signal: AbortSignal.abort() }).error, "Subagent cancelled.");
});

it("shape-validates a typed blocker before evaluating it", async () => {
	const acceptance = resolveEffectiveAcceptance({ explicit: { criteria: ["Deliver fixture"] } });
	for (const humanAction of [undefined, null, "", " ", 42]) {
		const report = { criteriaSatisfied: [{ id: "criterion-1", status: "blocked", evidence: "Touch ID dialog is visible", humanAction }] };
		const ledger = await evaluateAcceptance({ acceptance, output: "", report, cwd: process.cwd() });
		assert.equal(ledger.status, "rejected", `humanAction ${JSON.stringify(humanAction)} must not be accepted`);
		assert.equal(ledger.childReport, undefined);
	}
});

it("rejects malformed typed evidence even when valid legacy prose is also present", () => {
	const output = `Legacy answer\n\`\`\`acceptance-report\n${JSON.stringify(report)}\n\`\`\``;
	for (const invalid of [null, {}, { notes: "no report fields" }, { changedFiles: "file.ts" }, { commandsRun: [{}] }, { reviewFindings: [{}] }, { reviewFindings: [{ severity: [] }] }, { criteriaSatisfied: [{ status: "satisfied", evidence: " \n " }] }]) {
		const ledger = evaluateAcceptanceReport({ acceptance, output, report: invalid });
		assert.equal(ledger.status, "rejected", JSON.stringify(invalid));
		assert.equal(ledger.childReport, undefined);
	}
});

it("does only structural checks at the native boundary, leaving Git and verification to the owner", async () => {
	const config = resolveEffectiveAcceptance({ explicit: { criteria: ["Deliver fixture"], evidence: ["no-staged-files"], verify: [{ id: "owned", command: "exit 7" }] } });
	const claimed = { ...report, noStagedFiles: true };
	const ledger = evaluateAcceptanceReport({ acceptance: config, output: answer, report: claimed });
	assert.equal(ledger.status, "checked");
	assert.deepEqual(ledger.verifyRuns, []);
	assert.equal(ledger.runtimeChecks.some((check) => check.id === "no-staged-files"), false);
	const verified = await evaluateAcceptance({ acceptance: config, output: answer, report: claimed, cwd: process.cwd() });
	assert.equal(verified.status, "rejected");
	assert.equal(verified.verifyRuns[0]?.exitCode, 7);
});

it("accepts a typed report and complete visible answer from the current successful call", () => {
	const runtime = createFinalizationReportRuntime();
	const messages = [submit(), resultMessage()];
	try {
		fs.writeFileSync(runtime.outputPath, JSON.stringify(value));
		const result = readFinalizationReport(messages, runtime);
		assert.equal(result.reportSubmissionError, undefined);
		assert.equal(result.output, value.answer);
		assert.deepEqual(result.report, value.report);
	} finally {
		fs.rmSync(path.dirname(runtime.schemaPath), { recursive: true, force: true });
	}
});

it("validates the current public answer with its original recursive schema scope", () => {
	const schema = { type: "object", properties: { name: { type: "string" }, next: { $ref: "#" } }, required: ["name"], additionalProperties: false };
	const runtime = createFinalizationReportRuntime(schema);
	const repaired = { name: "A", next: { name: "B" } };
	try {
		assert.equal(validateStructuredOutputValue(schema, repaired).status, "valid");
		const current = { answer: repaired, report };
		assert.equal(validateStructuredOutputValue(runtime.schema, current).status, "valid");
		fs.writeFileSync(runtime.outputPath, JSON.stringify(current));
		const submission = readFinalizationReport([submit(current), resultMessage()], runtime);
		assert.deepEqual(submission.structuredOutput, repaired);
		assert.deepEqual(JSON.parse(submission.output), repaired);
		assert.deepEqual(submission.report, report);
		assert.equal(readFinalizationReport([submit(current), resultMessage(), fauxAssistantMessage("Acknowledged")], runtime).structuredOutput, undefined);
		for (const invalid of [JSON.stringify(repaired), { name: "A", next: { name: 42 } }, undefined]) {
			const bad = { answer: invalid, report };
			fs.writeFileSync(runtime.outputPath, JSON.stringify(bad));
			assert.ok(readFinalizationReport([submit(bad), resultMessage()], runtime).reportSubmissionError);
			assert.ok(readFinalizationReport([fauxAssistantMessage("Result")], runtime, { structuredResult: true }).reportSubmissionError);
		}
	} finally {
		fs.rmSync(path.dirname(runtime.schemaPath), { recursive: true, force: true });
	}
});

it("invalidates old reports on later assistant activity but accepts passive context and explicit resubmission", () => {
	const runtime = createFinalizationReportRuntime();
	try {
		fs.writeFileSync(runtime.outputPath, JSON.stringify(value));
		const messages = [submit(), resultMessage()];
		const passive: Message = { role: "user", content: "Passive context without another assistant turn", timestamp: Date.now() };
		assert.equal(readFinalizationReport([...messages, passive], runtime).output, answer);
		const stale = readFinalizationReport([...messages, fauxAssistantMessage("Coordination acknowledged")], runtime);
		assert.equal(stale.report, undefined);
		assert.equal(stale.output, "");
		assert.match(stale.reportSubmissionError!, /only tool call/);
		assert.match(stale.unconfirmedOutput!, /Identifier: task-42/);
		assert.deepEqual(parseAcceptanceReport(stale.unconfirmedOutput!).report, report);
		assert.equal(readFinalizationReport(messages, runtime, { messageOffset: messages.length }).report, undefined);
		assert.equal(readFinalizationReport([...messages, passive, submit(value, "resubmitted"), resultMessage("resubmitted")], runtime, { messageOffset: messages.length }).output, answer);
	} finally {
		fs.rmSync(path.dirname(runtime.schemaPath), { recursive: true, force: true });
	}
});

it("requires a sole successful report call, a later matching result, and the exact current capture", () => {
	const runtime = createFinalizationReportRuntime();
	try {
		fs.writeFileSync(runtime.outputPath, JSON.stringify(value));
		const call = fauxToolCall("structured_output", { value }, { id: "current" });
		const invalid: Message[][] = [
			[submit()],
			[resultMessage(), submit()],
			[submit(), resultMessage("other")],
			[submit(), { ...resultMessage(), toolName: "other" } as Message],
			[submit(), { ...resultMessage(), isError: true } as Message],
			[fauxAssistantMessage([call, fauxToolCall("read", {})], { stopReason: "toolUse" }), resultMessage()],
			[fauxAssistantMessage([call, { ...call, id: "second" }], { stopReason: "toolUse" }), resultMessage()],
			[fauxAssistantMessage(call, { stopReason: "error", errorMessage: "provider failed" }), resultMessage()],
			[fauxAssistantMessage(call, { stopReason: "aborted" }), resultMessage()],
			[fauxAssistantMessage(call, { stopReason: "length" }), resultMessage()],
		];
		for (const messages of invalid) assert.ok(readFinalizationReport(messages, runtime).reportSubmissionError);
		const withText = fauxAssistantMessage([{ type: "text", text: "Complete answer follows" }, { type: "thinking", thinking: "Review completed" }, call], { stopReason: "toolUse" });
		assert.equal(readFinalizationReport([withText, resultMessage()], runtime).output, answer);
		fs.writeFileSync(runtime.outputPath, JSON.stringify({ ...value, answer: "Different capture" }));
		assert.match(readFinalizationReport([submit(), resultMessage()], runtime).reportSubmissionError!, /does not match/);
		fs.rmSync(runtime.outputPath);
		const missing = readFinalizationReport([submit(), resultMessage()], runtime);
		assert.match(missing.reportSubmissionError!, /Missing structured_output/);
		assert.match(missing.unconfirmedOutput!, /Identifier: task-42/);
	} finally {
		fs.rmSync(path.dirname(runtime.schemaPath), { recursive: true, force: true });
	}
});

it("postvalidates blocked reports, whitespace answers and arbitrary finding objects", () => {
	const runtime = createFinalizationReportRuntime();
	try {
		for (const invalid of [
			{ ...value, answer: " \n " },
			{ ...value, report: { criteriaSatisfied: [{ status: "blocked", evidence: "Touch ID" }] } },
			{ ...value, report: { criteriaSatisfied: [{ status: "blocked", evidence: " ", humanAction: "Complete Touch ID" }] } },
			{ ...value, report: { reviewFindings: [{ severity: [] }] } },
		]) {
			fs.writeFileSync(runtime.outputPath, JSON.stringify(invalid));
			assert.ok(readFinalizationReport([submit(invalid), resultMessage()], runtime).reportSubmissionError);
		}
		const blocked = { ...value, report: { criteriaSatisfied: [{ id: "criterion-1", status: "blocked", evidence: "Touch ID dialog is visible", humanAction: "Complete Touch ID on this Mac" }] } };
		fs.writeFileSync(runtime.outputPath, JSON.stringify(blocked));
		const submission = readFinalizationReport([submit(blocked), resultMessage()], runtime);
		assert.equal(evaluateAcceptanceReport({ acceptance, output: submission.output, report: submission.report }).status, "blocked");
	} finally {
		fs.rmSync(path.dirname(runtime.schemaPath), { recursive: true, force: true });
	}
});

it("retains fenced legacy reports and stored legacy report-runtime schemas", () => {
	const output = `Legacy answer\n\`\`\`acceptance-report\n${JSON.stringify(report)}\n\`\`\``;
	const runtime = createStructuredOutputRuntime({ type: "object", properties: { report: { type: "string" } }, required: ["report"], additionalProperties: false });
	try {
		const legacy = { report: output };
		fs.writeFileSync(runtime.outputPath, JSON.stringify(legacy));
		const submission = readFinalizationReport([submit(legacy), resultMessage()], runtime);
		assert.equal(submission.output, output);
		assert.deepEqual(submission.report, report);
		assert.equal(evaluateAcceptanceReport({ acceptance, output }).status, "checked");
	} finally {
		fs.rmSync(path.dirname(runtime.schemaPath), { recursive: true, force: true });
	}
});

it("keeps mandatory self-review defaults, cumulative typed evidence and verification timing", async () => {
	const config = resolveEffectiveAcceptance({ explicit: { criteria: ["Deliver fixture"], verify: [{ id: "failure", command: "exit 7" }], maxFinalizationTurns: 3 } });
	let calls = 0;
	const ledger = await evaluateRunAcceptance({ acceptance: config, initial: { exitCode: 0 }, initialOutput: answer, initialReport: report, nativeReport: true, sessionFile: "fixture.jsonl", cwd: process.cwd(), runTurn: async () => {
		calls++;
		return { output: answer, report };
	} });
	assert.equal(acceptance.finalization.maxTurns, 3);
	assert.equal(calls, 1, "runtime verification failure does not consume additional self-review turns");
	assert.equal(ledger.status, "rejected");
	assert.equal(ledger.verifyRuns[0]?.exitCode, 7);
	assert.deepEqual(ledger.initialChildReport, report);
	assert.deepEqual(ledger.childReport?.reviewFindings, report.reviewFindings);
	assert.equal(ledger.finalization?.turns[0]?.rawOutput, answer);
});

it("uses remaining review budget for missing submissions, and stops immediately for human blockers", async () => {
	let calls = 0;
	const run = (initialReport: AcceptanceReport) => evaluateRunAcceptance({ acceptance, initial: { exitCode: 0 }, initialOutput: answer, initialReport, nativeReport: true, sessionFile: "fixture.jsonl", cwd: process.cwd(), runTurn: async () => {
		calls++;
		return calls === 1 ? { output: "", reportSubmissionError: "No current submission" } : { output: answer, report };
	} });
	const repaired = await run(report);
	assert.equal(calls, 2);
	assert.equal(repaired.status, "checked");
	assert.deepEqual(repaired.finalization?.turns.map((turn) => turn.status), ["rejected", "checked"]);
	assert.match(repaired.finalization?.turns[0]?.unconfirmedOutput ?? "", /Identifier: task-42/);
	calls = 0;
	const blocked = await run({ ...report, criteriaSatisfied: [{ id: "criterion-1", status: "blocked", evidence: "Touch ID dialog visible", humanAction: "Complete Touch ID" }] });
	assert.equal(calls, 0);
	assert.equal(blocked.status, "blocked");
	assert.deepEqual(blocked.verifyRuns, []);
});

it("prompts native typed submissions without removing the external fenced path", () => {
	const initialLedger = evaluateAcceptanceReport({ acceptance, output: answer, report });
	const native = formatAcceptancePrompt(acceptance, true);
	const review = formatAcceptanceFinalizationPrompt({ acceptance, initialOutput: answer, initialLedger, turn: 1, maxTurns: 3, nativeReport: true });
	for (const prompt of [native, review]) {
		assert.match(prompt, /answer/);
		assert.match(prompt, /typed object/);
		assert.match(prompt, /"report": \{/);
		assert.doesNotMatch(prompt, /```acceptance-report/);
	}
	assert.match(formatAcceptancePrompt(acceptance), /```acceptance-report/);
});

it("native strict preference preserves arbitrary findings and output schemas by falling back", () => {
	const runtime = createFinalizationReportRuntime();
	try {
		const tool = { name: "structured_output", description: "Fixture", parameters: { type: "object", properties: { value: runtime.schema }, required: ["value"], additionalProperties: false }, constrainedSampling: { type: "json_schema", strict: "prefer" } } as const;
		assert.equal(resolveJsonSchemaStrictSampling(tool, true), undefined);
		assert.equal(validateStructuredOutputValue(runtime.schema, value).status, "valid");
		const custom = { type: "object", properties: { env: { type: "object", additionalProperties: { type: "string" } } }, required: ["env"], allOf: [{ if: { required: ["mode"] }, then: { required: ["extra"] } }] };
		assert.equal(resolveJsonSchemaStrictSampling({ ...tool, parameters: custom }, true), undefined);
		assert.equal(validateStructuredOutputValue(custom, { env: { MODE: "fixture" } }).status, "valid");
		assert.equal(validateStructuredOutputValue(custom, { env: { MODE: 42 } }).status, "invalid");
		const closed = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };
		assert.equal(resolveJsonSchemaStrictSampling({ ...tool, parameters: closed }, true), true);
		assert.equal(resolveJsonSchemaStrictSampling({ ...tool, parameters: closed }, false), undefined);
	} finally {
		fs.rmSync(path.dirname(runtime.schemaPath), { recursive: true, force: true });
	}
});
