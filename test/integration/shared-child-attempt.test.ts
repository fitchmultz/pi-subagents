import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { findPackageJSON } from "node:module";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { resolveEffectiveAcceptance } from "../../src/runs/shared/acceptance.ts";
import { getRunMetadataDir } from "../../src/runs/shared/supervisor-questions.ts";
import { writeAsyncControlRequest } from "../../src/runs/background/async-control.ts";
import { createTempDir, removeTempDir } from "../support/helpers.ts";

const sdkRoot = process.env.PI_INTERCOM_TEST_SDK ?? path.dirname(findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url)!);
const repo = path.resolve(".");
const runtimeDir = path.join(repo, process.env.PI_DRIVER_TEST_DIST ? "dist" : "src", "runs/background");
const runtimeExtension = process.env.PI_DRIVER_TEST_DIST ? "js" : "ts";
const report = { criteriaSatisfied: [{ id: "deliver", status: "satisfied", evidence: "Native fixture completed" }], residualRisks: [], diffSummary: "Implemented fixture" };

async function run(scenario: string, options: { turns?: number; timeoutMs?: number; extendMs?: number; verify?: string; maxTokens?: number; maxExecutionTimeMs?: number; omitSessionFile?: boolean } = {}) {
	const root = createTempDir("driver-native-");
	const id = path.basename(root);
	const asyncDir = getRunMetadataDir(id);
	const input = path.join(root, "fixture.json"), receiptPath = path.join(root, "receipt.json");
	const resultPath = path.join(root, "result.json");
	const bin = path.join(root, "bin");
	fs.mkdirSync(bin);
	fs.writeFileSync(path.join(bin, "pi"), `#!/bin/sh\nexec '${process.execPath}' '${path.join(sdkRoot, "dist/cli.js")}' "$@"\n`, { mode: 0o755 });
	fs.writeFileSync(input, JSON.stringify({ scenario, receiptPath, report }));
	fs.mkdirSync(asyncDir, { recursive: true });
	const acceptance = resolveEffectiveAcceptance({ explicit: { criteria: [{ id: "deliver", must: "Deliver fixture" }], maxFinalizationTurns: options.turns ?? 1,
		...(options.verify ? { verify: [{ id: "check", command: options.verify }] } : {}) } });
	const configPath = path.join(asyncDir, "launch.json");
	fs.writeFileSync(configPath, JSON.stringify({ id, runtimeVersion: 2, timeoutMs: options.timeoutMs, cwd: root, asyncDir, resultPath,
		placeholder: "{previous}", resultMode: "single", steps: [{ agent: "worker", task: "Complete synthetic fixture", model: "driver-fixture/faux-1",
			inheritProjectContext: false, inheritSkills: false, tools: ["read"], extensions: [path.join(repo, "test/fixtures/native-child-attempt.mjs")],
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
		assert.ok(fs.existsSync(configPath), "v2 owner retains frozen launch");
		assert.equal(receipt?.networkRequests ?? 0, 0);
		return { result, receipt, status, output: fs.existsSync(path.join(root, "output.md")) ? fs.readFileSync(path.join(root, "output.md"), "utf8") : undefined };
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

for (const scenario of ["success", "public-output", "repair", "passive"] as const) test(`native child performs ${scenario} and mandatory review in one process`, async () => {
	const { result, receipt, output } = await run(scenario, { turns: scenario === "repair" ? 2 : 1, maxTokens: 30 });
	const child = result.results[0];
	assert.equal(result.success, true, JSON.stringify(child));
	assert.equal(receipt.calls, scenario === "repair" ? 3 : 2);
	assert.equal(child.acceptance.finalization.turns.length, receipt.calls - 1);
	assert.equal(output, "Reviewed answer");
	assert.equal(child.modelAttempts.length, receipt.calls);
	assert.deepEqual(child.modelAttempts.map((attempt) => attempt.usage.input), Array(receipt.calls).fill(11));
	const contributions = child.modelAttempts.flatMap((attempt) => attempt.usage.contributions);
	assert.equal(new Set(contributions.map((item) => item.id)).size, receipt.calls);
	assert.ok(contributions.every((item) => item.provider === "driver-fixture" && item.usage.reasoning === 4 && item.usage.cacheWrite1h === 2));
	if (scenario === "public-output") assert.deepEqual(child.structuredOutput, { items: ["public payload"] });
});

test("owner allocates a native session when acceptance has no preassigned file", async () => {
	const { result, receipt } = await run("success", { omitSessionFile: true });
	assert.equal(result.success, true, JSON.stringify(result));
	assert.equal(receipt.calls, 2);
	assert.match(result.results[0].sessionFile, /session-0\.jsonl$/);
});

test("native child stops at explicit blocked initial report without review or verification", async () => {
	const { result, receipt } = await run("blocked", { verify: "exit 7", turns: 3 });
	assert.equal(result.state, "blocked");
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
