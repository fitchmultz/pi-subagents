import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { executeAsyncSingle } from "../../src/runs/background/async-execution.ts";
import { createStructuredOutputRuntime } from "../../src/runs/shared/structured-output.ts";
import { parseAcceptanceReport } from "../../src/runs/shared/acceptance.ts";
import { getRunMetadataDir, questionProcessAlive, readQuestionContract } from "../../src/runs/shared/supervisor-questions.ts";
import { ASYNC_DIR, RESULTS_DIR, getAsyncConfigPath } from "../../src/shared/types.ts";
import { createEventBus, createMockPi, createTempDir, makeAgent, removeTempDir } from "../support/helpers.ts";

const details = "Result path: /fixture/deliverable.md\nIdentifier: task-42\nFinding: all requested handoff details survive coordination.\nValidation: fixture checks passed.\nRisks: none.";
const handoff = `Full final task report\n${details}`;
const report = (prose = handoff, satisfied = true) => `${prose}\n\n\`\`\`acceptance-report\n${JSON.stringify({
	criteriaSatisfied: [{ id: "criterion-1", status: satisfied ? "satisfied" : "not-satisfied", evidence: "Native fixture state" }],
	changedFiles: ["fixture.ts"], residualRisks: satisfied ? [] : ["The new task requirement is blocked."], diffSummary: prose,
})}\n\`\`\``;
const fullReport = report();
const initialReport = report(`Initial task report\n${details}`);

async function waitFor(check: () => boolean, label: string) {
	const deadline = Date.now() + 20_000;
	while (!check()) {
		assert.ok(Date.now() < deadline, label);
		await delay(20);
	}
}

for (const background of [false, true]) describe(`${background ? "background" : "foreground"} native acceptance report boundary`, () => {
	const mock = createMockPi();
	let cwd: string, id: string;
	const receipts: string[] = [];
	before(() => mock.install());
	after(() => mock.uninstall());
	beforeEach(() => {
		cwd = createTempDir("report-boundary-");
		id = path.basename(cwd);
		receipts.length = 0;
		mock.reset();
	});
	afterEach(() => {
		removeTempDir(cwd);
		removeTempDir(getRunMetadataDir(id));
		removeTempDir(path.join(ASYNC_DIR, id));
		fs.rmSync(path.join(RESULTS_DIR, `${id}.json`), { force: true });
		fs.rmSync(getAsyncConfigPath(id), { force: true });
	});

	async function run(scenario: string, options: {
		maxTurns?: number; retry?: string; laterReport?: string; outputMode?: "inline" | "file-only"; generated?: boolean;
		publicSchema?: boolean; verify?: boolean; handoff?: string; initialHandoff?: string;
	} = {}) {
		const outputPath = options.outputMode ? path.join(cwd, "requested.md") : undefined;
		const schema = { type: "object", properties: { items: { type: "array", items: { type: "string" } } }, required: ["items"] };
		const structured = options.publicSchema && !background ? createStructuredOutputRuntime(schema, cwd) : undefined;
		mock.onCall({ output: initialReport, delay: options.initialHandoff ? 300 : undefined,
			...(options.publicSchema ? { structuredOutput: { items: ["original payload"] } } : {}) });
		for (const name of [scenario, ...(options.retry ? [options.retry] : [])]) {
			const receiptPath = path.join(cwd, `native-${receipts.length}.json`);
			receipts.push(receiptPath);
			mock.onCall({ nativeReport: { scenario: name, report: fullReport, laterReport: options.laterReport,
				receiptPath, handoffPath: outputPath, handoff: options.handoff } });
		}
		const agent = makeAgent("worker", { model: "report-fixture/faux-1", tools: ["fixture_work"], extensions: [],
			...(options.generated ? { output: "requested.md" } : {}) });
		const acceptance = { criteria: ["Deliver the current full task report"], maxFinalizationTurns: options.maxTurns ?? 1,
			...(options.verify ? { verify: [{ id: "owned-check", command: "node -e \"process.exit(7)\"" }] } : {}) };
		const signal = new AbortController();
		let pending;
		if (background) {
			const started = executeAsyncSingle(id, { agent: "worker", task: "Produce the complete handoff", agentConfig: agent,
				ctx: { pi: { events: createEventBus() }, cwd, currentSessionId: id }, acceptance,
				artifactsDir: path.join(cwd, "artifacts"), sessionFile: path.join(cwd, "session.jsonl"), shareEnabled: false, maxSubagentDepth: 2,
				output: options.generated ? undefined : outputPath, outputMode: options.outputMode, outputSchema: options.publicSchema ? schema : undefined });
			assert.ok(!started.isError, started.content[0]?.text);
			pending = (async () => {
				const resultPath = path.join(RESULTS_DIR, `${id}.json`);
				await waitFor(() => fs.existsSync(resultPath), "background final result must arrive");
				const result = JSON.parse(fs.readFileSync(resultPath, "utf8")).results[0];
				const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf8"));
				await waitFor(() => !questionProcessAlive({ pid: status.pid }), "owned background runner must exit");
				assert.deepEqual(status.steps[0].acceptance, result.acceptance);
				return result;
			})();
		} else {
			pending = runSync(cwd, [agent], "worker", "Produce the complete handoff", { runId: id, acceptance, signal: signal.signal,
				artifactsDir: path.join(cwd, "artifacts"), sessionFile: path.join(cwd, "session.jsonl"), outputPath, outputMode: options.outputMode,
				persistOutputFile: !options.generated, outputPathFromAgentDefault: options.generated, structuredOutput: structured });
		}
		if (options.initialHandoff) {
			await waitFor(() => mock.callCount() > 0, "initial child must start before its handoff is written");
			fs.writeFileSync(outputPath!, options.initialHandoff);
		}
		if (scenario === "cancel") {
			await waitFor(() => fs.existsSync(receipts[0]!) && JSON.parse(fs.readFileSync(receipts[0]!, "utf8")).waiting === true, "native queued response must be running before cancellation");
			if (background) process.kill(JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf8")).pid, "SIGTERM");
			else signal.abort();
		}
		const result = await pending;
		const native = receipts.filter((file) => fs.existsSync(file)).map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
		for (const receipt of native) {
			assert.deepEqual(receipt.extensionErrors, []);
			assert.equal(receipt.networkRequests, 0);
		}
		const metadata = JSON.parse(fs.readFileSync(result.artifactPaths.metadataPath, "utf8"));
		assert.deepEqual(metadata.acceptance, JSON.parse(JSON.stringify(result.acceptance)));
		assert.equal(metadata.exitCode, result.exitCode);
		if (process.env.PI_FINAL_REPORT_EVIDENCE_DIR) {
			fs.mkdirSync(process.env.PI_FINAL_REPORT_EVIDENCE_DIR, { recursive: true });
			fs.writeFileSync(path.join(process.env.PI_FINAL_REPORT_EVIDENCE_DIR, `${background ? "bg" : "fg"}-${id}.json`), JSON.stringify({ scenario, options, result, native, metadata }, null, 2));
		}
		const savedOutput = readQuestionContract(id, 0)?.launch?.output;
		return { result, native, outputPath: typeof savedOutput === "string" ? savedOutput : outputPath, artifact: fs.readFileSync(result.artifactPaths.outputPath, "utf8") };
	}

	it("uses the current explicit resubmission after queued coordination without an extra pass", async () => {
		const { result, native, artifact } = await run("resubmit");
		assert.equal(result.exitCode, 0, result.error);
		assert.equal(result.acceptance.status, "checked");
		assert.deepEqual(result.acceptance.childReport, parseAcceptanceReport(fullReport).report);
		assert.equal(result.acceptance.finalization.turns[0].rawOutput, fullReport);
		assert.equal(result.acceptance.finalization.turns.length, 1);
		assert.equal(result.finalOutput ?? result.output, handoff);
		assert.equal(artifact, handoff);
		assert.equal(native[0].providerCalls, 2);
		const latest = native[0].messages.findLast((message) => message.role === "assistant");
		assert.deepEqual(latest.content[0].arguments.value, { report: fullReport });
		assert.ok(native[0].messages.some((message) => message.role === "toolResult" && message.toolCallId === latest.content[0].id && message.isError === false));
		assert.equal(mock.callCount(), 2);
	});

	for (const outputMode of ["inline", "file-only"] as const) it(`saves the current complete report with ${outputMode} output`, async () => {
		const { result, artifact, outputPath } = await run("resubmit", { outputMode });
		assert.equal(result.exitCode, 0, result.error);
		assert.equal(artifact, handoff);
		assert.equal(fs.readFileSync(outputPath!, "utf8"), handoff);
		if (outputMode === "file-only") {
			assert.match(result.finalOutput ?? result.output, /Output saved to:/);
			assert.doesNotMatch(result.finalOutput ?? result.output, /Finding:/);
		}
	});

	it("preserves child-written handoff precedence", async () => {
		const childHandoff = "Child-written detailed handoff with independent findings.\n";
		const { result, artifact, outputPath } = await run("child-file", { outputMode: "file-only", handoff: childHandoff });
		assert.equal(result.exitCode, 0, result.error);
		assert.equal(result.acceptance.finalization.turns[0].rawOutput, fullReport);
		assert.equal(artifact, childHandoff.trimEnd());
		assert.equal(fs.readFileSync(outputPath!, "utf8"), childHandoff);
	});

	it("preserves an existing child-written handoff as unconfirmed when delivery fails", async () => {
		const initialHandoff = "Detailed child-written handoff that must not be replaced by coordination.\n";
		const { result, artifact, outputPath } = await run("plain", { outputMode: "file-only", initialHandoff });
		assert.equal(result.exitCode, 1);
		assert.match(artifact, /^UNCONFIRMED task report/);
		assert.ok(artifact.includes(initialHandoff.trimEnd()));
		assert.equal(result.acceptance.unconfirmedOutput, fullReport);
		assert.equal(fs.readFileSync(outputPath!, "utf8"), initialHandoff);
	});

	it("still consumes generated inline output after capturing the final report", async () => {
		const { result, artifact, outputPath } = await run("resubmit", { outputMode: "inline", generated: true });
		assert.equal(result.exitCode, 0, result.error);
		assert.equal(artifact, handoff);
		if (background) assert.match(result.output, /Output file consumed:/);
		else assert.equal(result.outputCleanup.action, "deleted");
		assert.equal(fs.existsSync(outputPath!), false);
	});

	for (const scenario of ["plain", "follow-up", "failed-work", "user-failed-work", "different-work", "malformed-work", "malformed-submission", "invalid-submission", "invalid-tool-submission", "mixed", "unsubmitted", "missing-result", "missing-capture", "wrong-result-id", "invalid-capture", "capture-mismatch"]) {
		it(`rejects ${scenario} at the existing cap and retains unconfirmed audit evidence`, async () => {
			const { result, artifact } = await run(scenario, { laterReport: scenario === "capture-mismatch" ? report(`${handoff}\nUnmatched capture`) : undefined });
			assert.equal(result.exitCode, 1);
			assert.equal(result.acceptance.status, "rejected");
			assert.equal(result.acceptance.childReport, undefined);
			assert.equal(result.acceptance.finalization.status, "failed");
			assert.equal(result.acceptance.finalization.turns.length, 1);
			assert.equal(result.acceptance.runtimeChecks[0].id, scenario === "malformed-submission" ? "attestation" : "finalization-report");
			assert.match(result.acceptance.unconfirmedOutput, /Identifier: task-42/);
			if (["plain", "follow-up", "failed-work", "user-failed-work", "different-work", "malformed-work", "malformed-submission", "invalid-submission", "invalid-tool-submission", "mixed", "missing-result"].includes(scenario)) assert.equal(result.acceptance.unconfirmedOutput, fullReport);
			assert.match(artifact, /^UNCONFIRMED task report/);
			assert.match(artifact, /Identifier: task-42/);
			assert.doesNotMatch(artifact, /Coordination acknowledged/);
			assert.equal(result.modelAttempts[1].error, undefined, "missing delivery is not a process error");
			assert.equal(mock.callCount(), 2, "no hidden report-refresh pass at the cap");
		});
	}

	it("uses remaining finalization budget to recover missing report delivery", async () => {
		const { result, native, artifact } = await run("plain", { maxTurns: 2, retry: "single" });
		assert.equal(result.exitCode, 0, result.error);
		assert.equal(result.acceptance.status, "checked");
		assert.deepEqual(result.acceptance.finalization.turns.map((turn) => turn.status), ["rejected", "checked"]);
		assert.equal(result.acceptance.finalization.turns[0].unconfirmedOutput, fullReport);
		assert.equal(result.acceptance.unconfirmedOutput, undefined);
		assert.equal(artifact, handoff);
		assert.deepEqual(native.map((receipt) => receipt.providerCalls), [2, 1]);
		assert.equal(result.modelAttempts.reduce((sum, attempt) => sum + attempt.usage.turns, 0), 4);
		assert.equal(mock.callCount(), 3);
	});

	it("can repair a failed tool and explicitly submit a new current report", async () => {
		const { result, native, artifact } = await run("repair");
		assert.equal(result.exitCode, 0, result.error);
		assert.equal(result.acceptance.status, "checked");
		assert.equal(result.acceptance.finalization.turns[0].rawOutput, fullReport);
		assert.equal(native[0].providerCalls, 4);
		assert.equal(native[0].events.filter((event) => event.type === "tool_execution_end" && event.isError).length, 1);
		assert.equal(artifact, handoff);
	});

	it("uses a fresh not-satisfied report instead of earlier success", async () => {
		const current = report(`Current task blocked\n${details}`, false);
		const { result, artifact } = await run("not-satisfied", { laterReport: current });
		assert.equal(result.exitCode, 1);
		assert.equal(result.acceptance.childReport.criteriaSatisfied[0].status, "not-satisfied");
		assert.equal(result.acceptance.finalization.turns[0].rawOutput, current);
		assert.equal(artifact, `Current task blocked\n${details}`);
		assert.equal(result.acceptance.unconfirmedOutput, undefined);
	});

	it("does not invalidate a submission for passive context without a new model turn", async () => {
		const { result, native, artifact } = await run("passive");
		assert.equal(result.exitCode, 0, result.error);
		assert.equal(artifact, handoff);
		assert.equal(native[0].providerCalls, 1);
		assert.equal(native[0].messages.at(-1).role, "custom");
		assert.equal(result.acceptance.finalization.turns[0].rawOutput, fullReport);
	});

	for (const scenario of ["error", "native-abort", "cancel"]) it(`keeps ${scenario} authoritative after a submitted report`, async () => {
		const { result, artifact } = await run(scenario, { maxTurns: 2, retry: "single" });
		assert.notEqual(result.exitCode, 0);
		assert.equal(result.acceptance.status, "rejected");
		assert.equal(result.acceptance.childReport, undefined);
		assert.equal(result.acceptance.unconfirmedOutput, fullReport);
		assert.equal(result.acceptance.finalization.turns.length, 1);
		assert.match(artifact, /^UNCONFIRMED task report/);
		assert.equal(mock.callCount(), 2);
	});

	it("keeps configured verification failure authoritative", async () => {
		const { result, artifact } = await run("resubmit", { maxTurns: 2, verify: true, retry: "single" });
		assert.equal(result.exitCode, 1);
		assert.equal(result.acceptance.status, "rejected");
		assert.equal(result.acceptance.verifyRuns[0].exitCode, 7);
		assert.equal(result.acceptance.finalization.turns.length, 1);
		assert.equal(artifact, handoff);
		assert.equal(mock.callCount(), 2);
	});

	it("keeps the initial public structured payload separate from the private report capture", async () => {
		const { result, native } = await run("resubmit", { publicSchema: true });
		assert.equal(result.exitCode, 0, result.error);
		assert.deepEqual(result.structuredOutput, { items: ["original payload"] });
		assert.deepEqual(JSON.parse(fs.readFileSync(result.structuredOutputPath, "utf8")), result.structuredOutput);
		assert.ok(JSON.parse(fs.readFileSync(result.structuredOutputSchemaPath, "utf8")).properties.items);
		assert.deepEqual(native[0].capture, { report: fullReport });
		assert.deepEqual(native[0].schema.required, ["report"]);
	});
});
