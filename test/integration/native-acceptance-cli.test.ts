import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { after, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createEventBus, createTempDir, makeAgent, removeTempDir } from "../support/helpers.ts";

const originalEnv = { ...process.env };
const sdkRoot = process.env.PI_INTERCOM_TEST_SDK ?? path.dirname(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const cli = fs.realpathSync(path.join(sdkRoot, "dist/bundle/cli.js"));
const root = fs.realpathSync(createTempDir("native-report-cli-"));
for (const name of ["h", "a", "t", "j", "c", "d", "x", "bin", "pi-subagents-r"]) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
fs.symlinkSync(cli, path.join(root, "bin/pi"));
fs.writeFileSync(path.join(root, "a/settings.json"), JSON.stringify({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 }, compaction: { enabled: false } }));
// Each test file has its own Node process; never inherit user resources, credentials, or parent routes.
process.env = {
	PATH: [path.join(root, "bin"), path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
	HOME: path.join(root, "h"), USERPROFILE: path.join(root, "h"),
	TMPDIR: path.join(root, "t"), TMP: path.join(root, "t"), TEMP: path.join(root, "t"),
	XDG_CONFIG_HOME: path.join(root, "c"), XDG_DATA_HOME: path.join(root, "d"), XDG_CACHE_HOME: path.join(root, "x"),
	PI_CODING_AGENT_DIR: path.join(root, "a"), PI_SUBAGENT_TEMP_ROOT: path.join(root, "pi-subagents-r"), JITI_FS_CACHE: path.join(root, "j"),
	PI_PACKAGE_DIR: sdkRoot, PI_INTERCOM_TEST_SDK: sdkRoot, PI_OWNERSHIP_TEST_PACKAGE_ROOT: sdkRoot, PI_CONTEXT_TEST_PACKAGE_ROOT: sdkRoot,
	CI: "1", TERM: "dumb", PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", NODE_DISABLE_COMPILE_CACHE: "1", NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT,
};
const outcomes: object[] = [];
after(() => {
	process.env = originalEnv;
	fs.writeFileSync(path.join(root, "summary.json"), JSON.stringify(outcomes, null, 2));
	if (originalEnv.PI_FINAL_REPORT_EVIDENCE_DIR) {
		fs.mkdirSync(originalEnv.PI_FINAL_REPORT_EVIDENCE_DIR, { recursive: true });
		fs.cpSync(root, path.join(originalEnv.PI_FINAL_REPORT_EVIDENCE_DIR, path.basename(root)), { recursive: true, filter: (source) => path.basename(source) !== "auth.json" });
	}
	removeTempDir(root);
});
const { runSync } = await import("../../src/runs/foreground/execution.ts");
const { executeAsyncSingle } = await import("../../src/runs/background/async-execution.ts");
const { ASYNC_DIR, RESULTS_DIR } = await import("../../src/shared/types.ts");
const { questionProcessAlive } = await import("../../src/runs/shared/supervisor-questions.ts");
const { parseAcceptanceReport } = await import("../../src/runs/shared/acceptance.ts");
const extension = fileURLToPath(new URL("../fixtures/native-acceptance-cli-extension.mjs", import.meta.url));
const handoff = "Current native CLI report\nResult: the fixture completed.";
const report = (text: string) => `${text}\n\n\`\`\`acceptance-report\n${JSON.stringify({
	criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "Native CLI fixture" }], residualRisks: [], diffSummary: text,
})}\n\`\`\``;
const fullReport = report(handoff);

async function waitFor(check: () => boolean, label: string) {
	const deadline = Date.now() + 20_000;
	while (!check()) { assert.ok(Date.now() < deadline, label); await delay(20); }
}

for (const background of [false, true]) for (const scenario of ["single", "retry", "linger", "process-exit", "final-error"]) {
	it(`${background ? "background" : "foreground"} bundled native CLI finalization: ${scenario}`, { timeout: 30_000 }, async () => {
		const name = `${background ? "bg" : "fg"}-${scenario}`;
		const cwd = path.join(root, name), id = `${path.basename(root)}-${name}`;
		fs.mkdirSync(cwd, { mode: 0o700 });
		process.env.PI_FINAL_REPORT_CLI_INPUT = path.join(cwd, "input.json");
		fs.writeFileSync(process.env.PI_FINAL_REPORT_CLI_INPUT, JSON.stringify({ scenario, report: fullReport, initialReport: report("Initial native CLI report") }));
		const agent = makeAgent("worker", { model: "report-cli-fixture/faux-1", extensions: [extension], output: false, maxExecutionTimeMs: 15_000 });
		const acceptance = { criteria: ["Deliver the current complete report"], maxFinalizationTurns: 1 };
		let result;
		if (background) {
			const started = executeAsyncSingle(id, { agent: "worker", task: "Complete the fixture", agentConfig: agent,
				ctx: { pi: { events: createEventBus() }, cwd, currentSessionId: id }, acceptance,
				artifactsDir: path.join(cwd, "artifacts"), sessionFile: path.join(cwd, "session.jsonl"), shareEnabled: false, maxSubagentDepth: 2, output: false });
			assert.ok(!started.isError, started.content[0]?.text);
			const resultPath = path.join(RESULTS_DIR, `${id}.json`);
			await waitFor(() => fs.existsSync(resultPath), "background result must arrive");
			result = JSON.parse(fs.readFileSync(resultPath, "utf8")).results[0];
			const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf8"));
			await waitFor(() => !questionProcessAlive({ pid: status.pid }), "owned background runner must exit");
		} else {
			result = await runSync(cwd, [agent], "worker", "Complete the fixture", { runId: id, acceptance,
				artifactsDir: path.join(cwd, "artifacts"), sessionFile: path.join(cwd, "session.jsonl"), persistOutputFile: false });
		}
		fs.writeFileSync(path.join(cwd, "result.json"), JSON.stringify(result, null, 2));
		const receipts = fs.readdirSync(cwd).filter((file) => /^(initial|final)-\d+\.json$/.test(file)).map((file) => JSON.parse(fs.readFileSync(path.join(cwd, file), "utf8")));
		const native = receipts.find((receipt) => receipt.finalizing);
		outcomes.push({ background, scenario, exitCode: result.exitCode, error: result.error, acceptance: result.acceptance?.status,
			providerCalls: native?.providerCalls, nativeExitCode: native?.exitCode, shutdownStarted: native?.shutdownStarted, shutdownFinished: native?.shutdownFinished });
		assert.equal(receipts.length, 2, "only the initial and finalization CLI processes run");
		for (const receipt of receipts) {
			assert.equal(receipt.cli, cli, "run the actual bundled native CLI, not the mock launcher");
			assert.equal(receipt.networkRequests, 0);
			assert.equal(questionProcessAlive({ pid: receipt.pid }), false, "owned native child must exit");
		}
		assert.equal(result.modelAttempts.length, 2);
		assert.equal(result.acceptance.finalization.turns.length, 1);
		assert.equal(native.providerCalls, ["retry", "final-error"].includes(scenario) ? 2 : 1);
		assert.ok(native.events.some((event) => event.type === "agent_settled"));
		assert.deepEqual(native.capture, { report: fullReport });
		const messages = native.events.filter((event) => event.type === "message_end").map((event) => event.message);
		const submission = messages.findLast((message) => message.role === "assistant" && message.stopReason === "toolUse");
		assert.equal(submission.content.length, 1);
		assert.equal(submission.content[0].name, "structured_output");
		assert.deepEqual(submission.content[0].arguments.value, native.capture);
		assert.ok(messages.some((message) => message.role === "toolResult" && message.toolName === "structured_output" && message.toolCallId === submission.content[0].id && message.isError === false));
		const latest = messages.findLast((message) => message.role === "assistant");
		assert.equal(native.shutdownStarted, true);
		assert.equal(native.shutdownFinished, scenario !== "linger");
		if (scenario !== "linger") assert.equal(native.exitCode, scenario === "process-exit" ? 7 : 0);
		if (scenario === "retry") {
			assert.equal(messages.find((message) => message.role === "assistant").errorMessage, "503 overloaded; native CLI fixture");
			if (background) {
				const events = fs.readFileSync(path.join(ASYNC_DIR, id, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
				assert.ok(events.some((event) => event.type === "auto_retry_end" && event.success === true));
			}
		}
		if (scenario === "process-exit" || scenario === "final-error") {
			assert.equal(latest.stopReason, scenario === "final-error" ? "error" : "toolUse");
			assert.equal(result.exitCode, scenario === "process-exit" ? 7 : 1);
			assert.match(result.error, scenario === "process-exit" ? /exited with code 7/ : /Fixture final provider failure/);
			assert.equal(result.acceptance.status, "rejected");
			assert.equal(result.acceptance.childReport, undefined);
			assert.equal(result.acceptance.unconfirmedOutput, fullReport);
		} else {
			assert.equal(latest, submission);
			assert.equal(result.exitCode, 0, result.error);
			assert.equal(result.error, undefined);
			assert.equal(result.acceptance.status, "checked");
			assert.deepEqual(result.acceptance.childReport, parseAcceptanceReport(fullReport).report);
			assert.equal(result.acceptance.finalization.turns[0].rawOutput, fullReport);
			assert.equal(result.finalOutput ?? result.output, handoff);
			assert.equal(fs.readFileSync(result.artifactPaths.outputPath, "utf8"), handoff);
		}
	});
}
