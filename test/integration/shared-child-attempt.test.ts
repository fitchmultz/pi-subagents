import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { findPackageJSON } from "node:module";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { resolveEffectiveAcceptance } from "../../src/runs/shared/acceptance.ts";
import { getRunMetadataDir } from "../../src/runs/shared/supervisor-questions.ts";
import { writeAsyncControlRequest } from "../../src/runs/background/async-control.ts";
import { createMockPi, createTempDir, events, removeTempDir } from "../support/helpers.ts";
import { runChildAttempt } from "../../src/runs/shared/child-attempt.ts";

const sdkRoot = process.env.PI_INTERCOM_TEST_SDK ?? path.dirname(findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url)!);
const repo = path.resolve(".");
const runtimeDir = path.join(repo, process.env.PI_DRIVER_TEST_DIST ? "dist" : "src", "runs/background");
const runtimeExtension = process.env.PI_DRIVER_TEST_DIST ? "js" : "ts";
const report = { criteriaSatisfied: [{ id: "deliver", status: "satisfied", evidence: "Native fixture completed" }], residualRisks: [], diffSummary: "Implemented fixture" };

async function run(scenario: string, options: { turns?: number; timeoutMs?: number; extendMs?: number; verify?: string; maxTokens?: number; maxExecutionTimeMs?: number; omitSessionFile?: boolean;
	staged?: boolean; withoutAcceptance?: boolean; fallback?: boolean; legacy?: boolean; startupExit?: { code: number; once?: boolean; stderr?: string; model?: string } } = {}) {
	const root = createTempDir("driver-native-");
	const id = path.basename(root);
	const asyncDir = getRunMetadataDir(id);
	const input = path.join(root, "fixture.json"), receiptPath = path.join(root, "receipt.json");
	const resultPath = path.join(root, "result.json");
	const bin = path.join(root, "bin");
	fs.mkdirSync(bin);
	fs.mkdirSync(path.join(root, "agent"));
	fs.writeFileSync(path.join(root, "agent/settings.json"), JSON.stringify({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 }, compaction: { enabled: false } }));
	fs.writeFileSync(path.join(bin, "pi"), `#!/bin/sh\necho $$ >> '${root}/pids'\nexec '${process.execPath}' '${path.join(sdkRoot, "dist/cli.js")}' "$@"\n`, { mode: 0o755 });
	if (options.staged) {
		execFileSync("git", ["init", "-q"], { cwd: root });
		fs.writeFileSync(path.join(root, "staged.txt"), "staged fixture\n");
		execFileSync("git", ["add", "staged.txt"], { cwd: root });
	}
	fs.writeFileSync(input, JSON.stringify({ scenario, receiptPath, report: { ...report, ...(options.staged ? { noStagedFiles: true } : {}) }, startupExit: options.startupExit }));
	fs.mkdirSync(asyncDir, { recursive: true });
	const acceptance = resolveEffectiveAcceptance({ explicit: options.withoutAcceptance ? undefined : { criteria: [{ id: "deliver", must: "Deliver fixture" }], maxFinalizationTurns: options.turns ?? 1,
		...(options.staged ? { evidence: ["no-staged-files"] } : {}),
		...(options.verify ? { verify: [{ id: "check", command: options.verify }] } : {}) } });
	const configPath = path.join(asyncDir, "launch.json");
	fs.writeFileSync(configPath, JSON.stringify({ id, runtimeVersion: options.legacy ? undefined : 2, timeoutMs: options.timeoutMs, cwd: root, asyncDir, resultPath,
		placeholder: "{previous}", resultMode: "single", steps: [{ agent: "worker", task: "Complete synthetic fixture", model: "driver-fixture/faux-1",
			modelCandidates: options.fallback ? ["driver-fixture/faux-1", "driver-fixture/faux-2"] : undefined,
			inheritProjectContext: false, inheritSkills: false, tools: options.staged ? ["read", "bash"] : ["read"], extensions: [path.join(repo, "test/fixtures/native-child-attempt.mjs")],
			sessionFile: options.omitSessionFile ? undefined : path.join(root, "session.jsonl"), outputPath: path.join(root, "output.md"), effectiveAcceptance: acceptance,
			maxTokens: options.maxTokens, maxExecutionTimeMs: options.maxExecutionTimeMs,
			...(scenario === "public-output" ? { structuredOutputSchema: { type: "object", properties: { items: { type: "array", items: { type: "string" } } }, required: ["items"] } } : {}),
		}] }));
	const env = { ...process.env, PI_INTERCOM_TEST_SDK: sdkRoot, PI_PACKAGE_DIR: sdkRoot, PI_CODING_AGENT_DIR: path.join(root, "agent"),
		PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_DRIVER_FIXTURE: input, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` };
	for (const key of Object.keys(env)) if (key.startsWith("PI_SUBAGENT_") && key !== "PI_SUBAGENT_TEMP_ROOT") delete env[key];
	const proc = spawn(process.execPath, [path.join(runtimeDir, `subagent-runner-launcher.${runtimeExtension}`), path.join(runtimeDir, `subagent-runner.${runtimeExtension}`), configPath], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
	let log = "";
	proc.stdout.on("data", (chunk) => { log += chunk; });
	proc.stderr.on("data", (chunk) => { log += chunk; });
	const watchdog = setTimeout(() => proc.kill("SIGTERM"), 20_000);
	try {
		if (options.extendMs) {
			const deadline = Date.now() + 15_000;
			while (!fs.existsSync(receiptPath)) { assert.ok(Date.now() < deadline, log); await delay(10); }
			writeAsyncControlRequest(asyncDir, id, "extend", undefined, options.extendMs);
		}
		const [code] = await once(proc, "close");
		assert.equal(code, 0, log);
		assert.ok(fs.existsSync(resultPath), log);
		const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
		const receipt = fs.existsSync(receiptPath) ? JSON.parse(fs.readFileSync(receiptPath, "utf8")) : undefined;
		const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf8"));
		if (!options.legacy) assert.ok(fs.existsSync(configPath), "v2 owner retains frozen launch");
		assert.equal(receipt?.networkRequests ?? 0, 0);
		const pids = fs.readFileSync(path.join(root, "pids"), "utf8").trim().split("\n").map(Number);
		return { result, receipt, status, pids, output: fs.existsSync(path.join(root, "output.md")) ? fs.readFileSync(path.join(root, "output.md"), "utf8") : undefined };
	} finally {
		clearTimeout(watchdog);
		if (proc.exitCode === null) proc.kill("SIGTERM");
		if (process.env.PI_DRIVER_EVIDENCE_DIR) {
			fs.mkdirSync(process.env.PI_DRIVER_EVIDENCE_DIR, { recursive: true });
			fs.cpSync(root, path.join(process.env.PI_DRIVER_EVIDENCE_DIR, id), { recursive: true });
			fs.cpSync(asyncDir, path.join(process.env.PI_DRIVER_EVIDENCE_DIR, `${id}-owner`), { recursive: true });
			fs.writeFileSync(path.join(process.env.PI_DRIVER_EVIDENCE_DIR, `${id}.log`), log);
		}
		removeTempDir(root); removeTempDir(asyncDir);
	}
}

for (const withoutAcceptance of [true, false]) test(`native pre-boundary exit 143 retries with acceptance ${!withoutAcceptance}`, async () => {
	const { result, receipt, pids } = await run("success", { withoutAcceptance, startupExit: { code: 143, once: true } });
	assert.equal(result.success, true, JSON.stringify(result));
	assert.equal(pids.length, 2);
	assert.equal(new Set(pids).size, 2);
	assert.equal(receipt.pid, pids[1]);
	assert.equal(result.results[0].modelAttempts[0].exitCode, 143);
	assert.match(result.results[0].modelAttempts[0].error, /143/);
	assert.ok(result.results[0].modelAttempts.every((attempt) => attempt.model === "driver-fixture/faux-1"));
});

test("native pre-boundary transport failure retains its exit after the retry budget", async () => {
	const { result, pids } = await run("success", { startupExit: { code: 143 } });
	assert.equal(result.success, false);
	assert.equal(pids.length, 2);
	assert.deepEqual(result.results[0].modelAttempts.map((attempt) => attempt.exitCode), [143, 143]);
	assert.equal(result.results[0].exitCode, 143);
	assert.doesNotMatch(result.results[0].error, /boundary did not return/);
});

test("native pre-boundary transport failure reaches the configured fallback after one retry", async () => {
	const { result, receipt, pids } = await run("success", { fallback: true, startupExit: { code: 143, model: "faux-1" } });
	const child = result.results[0];
	assert.equal(result.success, true, JSON.stringify(child));
	assert.equal(pids.length, 3);
	assert.equal(new Set(pids).size, 3);
	assert.equal(receipt.pid, pids[2]);
	assert.equal(child.model, "driver-fixture/faux-2");
	assert.deepEqual(child.attemptedModels, ["driver-fixture/faux-1", "driver-fixture/faux-1", "driver-fixture/faux-2"]);
	assert.deepEqual(child.modelAttempts.map((attempt) => attempt.exitCode), [143, 143, 0, 0]);
	assert.equal(child.acceptance.finalization.turns.length, 1);
});

test("native pre-boundary ordinary failure preserves diagnostics without a retry", async () => {
	const { result, pids } = await run("success", { fallback: true, startupExit: { code: 7, stderr: "Fixture startup failed" } });
	assert.equal(result.success, false);
	assert.equal(pids.length, 1);
	assert.equal(result.results[0].exitCode, 7);
	assert.match(result.results[0].error, /Fixture startup failed/);
});

test("native apparent success without a required self-review boundary is rejected", async () => {
	const { result, pids } = await run("success", { fallback: true, startupExit: { code: 0 } });
	assert.equal(result.success, false);
	assert.equal(pids.length, 1);
	assert.equal(result.results[0].exitCode, 1);
	assert.match(result.results[0].error, /Native self-review boundary did not return a result/);
});

test("native no-staged-files rejection repairs in one process and retains both review outcomes", async () => {
	const { result, receipt, pids, output } = await run("staged-repair", { staged: true, turns: 2,
		verify: 'test -z "$PI_SUBAGENT_FINALIZATION_CONFIG" && test -z "$(git diff --cached --name-only)" && echo owner-check' });
	const child = result.results[0];
	assert.equal(pids.length, 1, JSON.stringify({ pids, child }));
	assert.equal(result.success, true, JSON.stringify(child));
	assert.equal(receipt.pid, pids[0]);
	assert.equal(receipt.calls, 4);
	assert.equal(receipt.sawStagedFailure, true);
	assert.equal(output, "Repaired answer");
	assert.equal(child.finalOutput, "Repaired answer");
	assert.deepEqual(child.acceptance.finalization.turns.map((turn) => turn.status), ["rejected", "checked"]);
	assert.match(child.acceptance.finalization.turns[0].failureMessage, /Staged files present:.*staged\.txt/);
	assert.equal(child.acceptance.runtimeChecks.find((check) => check.id === "no-staged-files").status, "passed");
	assert.equal(child.acceptance.verifyRuns.length, 1);
	assert.equal(child.acceptance.verifyRuns[0].stdout, "owner-check");
});

test("native no-staged-files rejection exhausts its review cap without another process", async () => {
	const { result, receipt, pids } = await run("success", { staged: true, turns: 2 });
	assert.equal(pids.length, 1);
	assert.equal(result.success, false);
	assert.equal(receipt.calls, 3);
	assert.deepEqual(result.results[0].acceptance.finalization.turns.map((turn) => turn.status), ["rejected", "rejected"]);
	assert.match(result.results[0].error, /Staged files present:.*staged\.txt/);
});

test("owner rechecks the index after native no-staged-files repair and shutdown", async () => {
	const { result, receipt, pids } = await run("staged-repair-restage", { staged: true, turns: 2 });
	assert.equal(pids.length, 1);
	assert.equal(receipt.calls, 4);
	assert.equal(result.success, false);
	assert.deepEqual(result.results[0].acceptance.finalization.turns.map((turn) => turn.status), ["rejected", "checked"]);
	assert.match(result.results[0].error, /Staged files present:.*staged\.txt/);
});

for (const scenario of ["success", "public-output", "repair", "passive"] as const) test(`native child performs ${scenario} and mandatory review in one process`, async () => {
	const { result, receipt, output } = await run(scenario, { turns: scenario === "repair" ? 2 : 1, maxTokens: 30 });
	const child = result.results[0];
	assert.equal(result.success, true, JSON.stringify(child));
	assert.equal(receipt.calls, scenario === "repair" ? 3 : 2);
	assert.equal(child.acceptance.finalization.turns.length, receipt.calls - 1);
	assert.equal(output, scenario === "public-output" ? '{"items":["reviewed payload"]}' : "Reviewed answer");
	assert.equal(child.modelAttempts.length, receipt.calls);
	assert.deepEqual(receipt.sampling[1], { type: "json_schema", strict: "prefer" });
	assert.deepEqual(child.modelAttempts.map((attempt) => attempt.usage.input), Array(receipt.calls).fill(11));
	const contributions = child.modelAttempts.flatMap((attempt) => attempt.usage.contributions);
	assert.equal(new Set(contributions.map((item) => item.id)).size, receipt.calls);
	assert.ok(contributions.every((item) => item.provider === "driver-fixture" && item.usage.reasoning === 4 && item.usage.cacheWrite1h === 2));
	if (scenario === "public-output") {
		assert.deepEqual(child.structuredOutput, { items: ["reviewed payload"] });
		assert.deepEqual(receipt.sampling[0], { type: "json_schema", strict: "prefer" });
	}
});

test("legacy Pi review publishes its current schema-validated payload across process continuation", async () => {
	const { result, pids, output } = await run("public-output", { legacy: true });
	assert.equal(result.success, true, JSON.stringify(result));
	assert.equal(pids.length, 2);
	assert.deepEqual(result.results[0].structuredOutput, { items: ["reviewed payload"] });
	assert.equal(output, '{"items":["reviewed payload"]}');
});

for (const scenario of ["retry", "linger", "resubmit", "missing-then-repair"]) test(`native owner preserves ${scenario} through same-process review`, async () => {
	const { result, receipt } = await run(scenario, { turns: scenario === "missing-then-repair" ? 2 : 1 });
	const child = result.results[0];
	assert.equal(result.success, true, JSON.stringify(child));
	assert.equal(child.agentProcessExit.pid, receipt.pid);
	assert.equal(child.acceptance.status, "checked");
	assert.equal(child.finalOutput, "Reviewed answer");
	assert.equal(child.acceptance.finalization.turns.length, scenario === "missing-then-repair" ? 2 : 1);
	assert.equal(receipt.calls, scenario === "linger" ? 2 : 3);
	assert.equal(receipt.shutdownStarted, true);
	assert.equal(receipt.shutdownFinished, scenario !== "linger");
	if (scenario === "retry") {
		assert.deepEqual(receipt.errors, ["503 overloaded; native fixture"]);
		assert.equal(child.modelAttempts.length, 2, "native transport retry remains inside the same review attempt");
		assert.equal(child.modelAttempts[1].usage.turns, 2);
	}
	if (scenario === "missing-then-repair") assert.deepEqual(child.acceptance.finalization.turns.map((turn) => turn.status), ["rejected", "checked"]);
});

test("native post-submission provider failure remains authoritative", async () => {
	const { result, receipt } = await run("final-error");
	assert.equal(result.success, false);
	assert.equal(receipt.calls, 3);
	assert.match(result.results[0].error, /Fixture final provider failure/);
	assert.equal(result.results[0].acceptance.childReport, undefined);
	assert.match(result.results[0].acceptance.unconfirmedOutput, /Reviewed answer/);
});

test("per-attempt time allowance resets between initial work and review in one native process", async () => {
	// Two 4.5s attempts exceed 8s together, while each leaves room for cold native startup.
	const { result, receipt } = await run("per-attempt-time", { maxExecutionTimeMs: 8000 });
	assert.equal(result.success, true, JSON.stringify(result));
	assert.equal(receipt.calls, 2);
	assert.equal(result.results[0].agentProcessExit.pid, receipt.pid);
	assert.ok(result.results[0].progressSummary.durationMs > 8000);
	assert.equal(result.results[0].resourceLimitExceeded, undefined);
});

test("nested tool usage is accounted without tightening the assistant-only token limit", async (t) => {
	const mock = createMockPi();
	mock.install();
	t.after(() => mock.uninstall());
	mock.onCall({ jsonl: [
		{ type: "message_end", message: { role: "toolResult", toolName: "nested", toolCallId: "nested-call", isError: false,
			content: [{ type: "text", text: "Nested work finished" }],
			usage: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1000, cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 } } } },
		events.assistantMessage("Finished"),
	] });
	const result = await runChildAttempt({ args: ["--mode", "json", "-p", "Task: nested fixture"], cwd: repo, agent: "fixture", maxTokens: 200 });
	assert.equal(result.exitCode, 0, result.error);
	assert.equal(result.resourceLimitExceeded, undefined);
	assert.equal(result.usage.input, 1100);
	assert.equal(result.usage.output, 50);
	assert.equal(result.usage.contributions?.length, 2);
});

test("owner allocates a native session when acceptance has no preassigned file", async () => {
	const { result, receipt } = await run("success", { omitSessionFile: true });
	assert.equal(result.success, true, JSON.stringify(result));
	assert.equal(receipt.calls, 2);
	assert.match(result.results[0].sessionFile, /session-0\.jsonl$/);
});

test("native child stops at explicit blocked initial report without review or verification", async () => {
	const { result, receipt, pids } = await run("blocked", { verify: "exit 7", turns: 3 });
	assert.equal(result.state, "blocked");
	assert.equal(pids.length, 1);
	assert.equal(receipt.calls, 1);
	assert.deepEqual(result.results[0].acceptance.verifyRuns, []);
});

test("native child rejects missing current report at the configured cap", async () => {
	const { result, receipt } = await run("stale");
	assert.equal(result.success, false);
	assert.equal(result.results[0].acceptance.finalization.turns.length, 1);
	assert.match(result.results[0].acceptance.childReportParseError, /No current finalization report/);
	assert.equal(receipt.calls, 2);
});

test("native review rejects an older valid report after later assistant activity", async () => {
	const { result, receipt } = await run("stale-after-report");
	assert.equal(result.success, false);
	assert.equal(result.results[0].acceptance.finalization.turns.length, 1);
	assert.equal(result.results[0].acceptance.childReport, undefined);
	assert.match(result.results[0].acceptance.unconfirmedOutput, /Reviewed answer/);
	assert.equal(receipt.calls, 3, "queued work stays inside one review attempt");
});

test("owner verification failure and process failure override a valid native report", async () => {
	const verified = await run("success", { verify: "exit 7" });
	assert.equal(verified.result.success, false);
	assert.equal(verified.result.results[0].acceptance.verifyRuns[0].exitCode, 7);
	const exited = await run("process-error");
	assert.equal(exited.result.success, false);
	assert.equal(exited.result.results[0].agentProcessExit.code, 7);
});

test("owner deadline stops native verification and publishes timeout", async () => {
	const { result, status } = await run("success", { timeoutMs: 3000, verify: "sleep 10" });
	assert.equal(result.success, false);
	assert.equal(result.exitCode, 124);
	assert.equal(result.timedOut, true);
	assert.equal(status.timedOut, true);
	assert.equal(result.results[0].exitCode, 124);
});

test("durable extend control moves the owner's deadline", async () => {
	const { result, status, receipt } = await run("slow", { timeoutMs: 2500, extendMs: 4000 });
	assert.equal(result.success, true, JSON.stringify(result));
	assert.equal(status.timedOut, undefined);
	assert.equal(receipt.calls, 2);
	assert.ok(status.timeoutAt - status.startedAt >= 6500);
});
