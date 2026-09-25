import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getRunMetadataDir } from "../../src/runs/shared/supervisor-questions.ts";
import { executeAsyncSingle } from "../../src/runs/background/async-execution.ts";
import { evaluateAcceptance, resolveEffectiveAcceptance } from "../../src/runs/shared/acceptance.ts";
import { ASYNC_DIR, RESULTS_DIR, TEMP_ROOT_DIR } from "../../src/shared/types.ts";
import { writeAsyncInterruptRequest } from "../../src/runs/foreground/foreground-control.ts";
import { createMockPi, createTempDir, events, makeAgent, removeTempDir } from "../support/helpers.ts";

async function waitForFile(file: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!fs.existsSync(file)) {
		assert.ok(Date.now() < deadline, `Timed out waiting for ${file}`);
		await delay(20);
	}
}

const report = '```acceptance-report\n{"manualNotes":"process lifecycle check"}\n```';

describe("process lifecycle regressions", { timeout: 60_000 }, () => {
	const mock = createMockPi();
	let cwd: string;
	const asyncIds: string[] = [];
	before(() => mock.install());
	after(() => mock.uninstall());
	beforeEach(() => { mock.reset(); cwd = createTempDir("process-lifecycle-"); });
	afterEach(() => {
		removeTempDir(cwd);
		for (const id of asyncIds.splice(0)) {
			removeTempDir(path.join(ASYNC_DIR, id));
			fs.rmSync(path.join(RESULTS_DIR, `${id}.json`), { force: true });
		}
	});

	for (const hookType of ["post-checkout", "setup", "rollback"] as const) {
		for (const stop of ["interrupt", "timeout"] as const) {
			if (hookType === "rollback" && stop === "timeout") continue;
			it(`${stop} stops a hanging ${hookType} hook and ${hookType === "rollback" ? "reports incomplete rollback" : "rolls back all worktrees"}`, async () => {
				const repo = path.join(cwd, "repo");
				fs.mkdirSync(repo);
				const git = (...args: string[]) => {
					const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
					assert.equal(result.status, 0, result.stderr);
					return result.stdout.trim();
				};
				git("init");
				git("config", "user.name", "Lifecycle Tests");
				git("config", "user.email", "tests@example.com");
				fs.writeFileSync(path.join(repo, "tracked"), "initial");
				git("add", ".");
				git("commit", "-m", "initial");
				const ready = path.join(cwd, "hook-ready.json");
				const hookPath = hookType === "post-checkout" ? path.join(repo, ".git", "hooks", "post-checkout") : path.join(cwd, "setup.cjs");
				fs.writeFileSync(hookPath, `#!${process.execPath}
const { spawn } = require("node:child_process");
if (process.cwd().endsWith("-0")) { console.log("{}"); process.exit(0); }
spawn(process.execPath, ["-e", ${JSON.stringify(`
process.on("SIGTERM", () => {});
require("node:fs").writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ hook: process.ppid, descendant: process.pid }));
setInterval(() => {}, 1000);
`)}], { stdio: "inherit" });
setInterval(() => {}, 1000);
`);
				fs.chmodSync(hookPath, 0o755);
				const rollbackPid = path.join(cwd, "rollback.pid");
				if (hookType === "rollback") {
					fs.writeFileSync(path.join(repo, ".git", "hooks", "reference-transaction"), `#!${process.execPath}
let input = "";
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
	if (require("node:fs").existsSync(${JSON.stringify(ready)}) && process.argv[2] === "prepared" && input.split(" ")[1] === "0".repeat(40)) {
		require("node:fs").writeFileSync(${JSON.stringify(rollbackPid)}, String(process.pid));
		setInterval(() => {}, 1000);
	}
});
`, { mode: 0o755 });
				}
				const id = `setup-${hookType}-${stop}-${process.pid}-${Date.now()}`;
				const asyncDir = path.join(cwd, "run");
				const resultPath = path.join(cwd, "result.json");
				const configPath = path.join(cwd, "config.json");
				fs.writeFileSync(configPath, JSON.stringify({
					id, cwd: repo, asyncDir, resultPath, placeholder: "{previous}",
					timeoutMs: stop === "timeout" ? 3000 : undefined,
					worktreeSetupHook: hookType === "post-checkout" ? undefined : hookPath,
					worktreeSetupHookTimeoutMs: hookType === "rollback" ? 1000 : 30_000,
					steps: [{ worktree: true, parallel: [makeAgent("worker"), makeAgent("worker")].map((agent) => ({ ...agent, agent: agent.name, task: "Must not start" })) }],
				}));
				const runner = spawn(process.execPath, [
					fileURLToPath(new URL("../../src/runs/background/subagent-runner.ts", import.meta.url)), configPath,
				], { stdio: ["ignore", "ignore", "pipe"] });
				const closed = once(runner, "close");
				let stderr = "";
				runner.stderr.setEncoding("utf8").on("data", (text) => { stderr += text; });
				try {
					await waitForFile(ready);
					if (stop === "interrupt") writeAsyncInterruptRequest(asyncDir, id);
					await waitForFile(resultPath);
					await closed;
					const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
					assert.equal(result.state, stop === "interrupt" ? "paused" : "failed", stderr);
					assert.equal(result.exitCode, stop === "interrupt" ? 0 : 124);
					assert.equal(result.timedOut === true, stop === "timeout");
					assert.equal(mock.callCount(), 0, "children must not start after stopped setup");
					const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf8"));
					assert.ok(status.steps.every((step: { status: string }) => step.status === (stop === "interrupt" ? "paused" : "failed")));
					if (hookType === "rollback") {
						assert.match(result.summary, /Worktree rollback incomplete/);
						assert.ok(git("branch", "--list", `pi-parallel-${id}-s0-1`).includes(`pi-parallel-${id}-s0-1`));
						assert.ok(result.summary.includes(`pi-parallel-${id}-s0-1`), "the normal paused summary must identify the remaining branch");
						assert.throws(() => process.kill(Number(fs.readFileSync(rollbackPid, "utf8")), 0), { code: "ESRCH" });
					} else assert.equal(git("branch", "--list", `pi-parallel-${id}-*`), "");
					for (const index of [0, 1]) {
						assert.equal(fs.existsSync(path.join(TEMP_ROOT_DIR, "worktrees", `pi-worktree-${id}-s0-${index}`)), hookType === "rollback" && index === 0);
					}
					const pids = JSON.parse(fs.readFileSync(ready, "utf8"));
					for (const pid of Object.values(pids) as number[]) {
						assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, `setup process ${pid} survived`);
					}
				} finally {
					if (fs.existsSync(rollbackPid)) {
						try { process.kill(Number(fs.readFileSync(rollbackPid, "utf8")), "SIGKILL"); } catch {}
					}
					if (fs.existsSync(ready)) {
						for (const pid of Object.values(JSON.parse(fs.readFileSync(ready, "utf8"))) as number[]) {
							try { process.kill(pid, "SIGKILL"); } catch {}
						}
					}
					if (runner.exitCode === null) runner.kill("SIGKILL");
					await closed;
					for (const index of [0, 1]) {
						spawnSync("git", ["-C", repo, "worktree", "remove", "--force", path.join(TEMP_ROOT_DIR, "worktrees", `pi-worktree-${id}-s0-${index}`)]);
					}
				}
			});
		}
	}

	for (const mode of ["background"] as const) {
		for (const prematureSettlement of [false, true]) {
			it(`${mode} waits for queued follow-up work${prematureSettlement ? " after renewed activity" : " after assistant stop"}`, async () => {
				mock.onCall({ steps: [
					{ jsonl: [events.assistantMessage("First answer"), { type: "agent_end", messages: [] }, ...(prematureSettlement ? [{ type: "agent_settled" }] : [])] },
					{ delay: 100, jsonl: [{ type: "agent_start" }, events.toolStart("bash", { command: "slow follow-up" })] },
					{ delay: 1500, jsonl: [events.toolEnd("bash"), events.assistantMessage("Follow-up completed"), { type: "agent_end", messages: [] }, { type: "agent_settled" }] },
				] });
				const agent = makeAgent("worker", { completionGuard: false });
				{
					const id = `lifecycle-${process.pid}-${Date.now()}`;
					asyncIds.push(id);
					executeAsyncSingle(id, { agent: "worker", task: "Follow up", agentConfig: agent, ctx: { pi: { events: { emit() {} } }, cwd, currentSessionId: "lifecycle" }, shareEnabled: false, maxSubagentDepth: 2 });
					const resultPath = path.join(RESULTS_DIR, `${id}.json`);
					await waitForFile(resultPath);
					const result = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
					assert.equal(result.success, true);
					assert.equal(result.results[0].output, "Follow-up completed");
				}
			});
		}
	}

	for (const mode of ["background"] as const) {
		it(`${mode} cancellation stops verification descendants after finalization`, async () => {
			const ready = path.join(cwd, "verify-ready");
			const late = path.join(cwd, "verify-late");
			const next = path.join(cwd, "next-command");
			const command = `printf ready > '${ready}'; (sleep 1; printf late > '${late}') & wait`;
			const acceptance = {
				maxFinalizationTurns: 1,
				verify: [{ id: "slow", command, timeoutMs: 10_000 }, { id: "next", command: `printf next > '${next}'` }],
			};
			mock.onCall({ nativeReport: { scenario: "single", initialReport: `Finished\n${report}`, report: `Reviewed\n${report}`, receiptPath: path.join(cwd, "native.json") } });
			{
				const id = `lifecycle-verify-${process.pid}-${Date.now()}`;
				asyncIds.push(id);
				executeAsyncSingle(id, { agent: "worker", task: "Inspect", acceptance, agentConfig: makeAgent("worker"), ctx: { pi: { events: { emit() {} } }, cwd, currentSessionId: "lifecycle" }, sessionFile: path.join(cwd, "session.jsonl"), shareEnabled: false, maxSubagentDepth: 2 });
				await waitForFile(ready);
				const status = JSON.parse(fs.readFileSync(path.join(getRunMetadataDir(id), "status.json"), "utf-8"));
				process.kill(status.pid, "SIGTERM");
				const resultPath = path.join(RESULTS_DIR, `${id}.json`);
				await waitForFile(resultPath);
				const result = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
				assert.equal(result.success, false);
				assert.equal(result.results[0].acceptance.status, "rejected");
			}
			await delay(1100);
			assert.equal(fs.existsSync(late), false, "verification descendant survived cancellation");
			assert.equal(fs.existsSync(next), false, "verification continued to the next command after cancellation");
			assert.equal(mock.callCount(), 1);
		});
	}

	for (const mode of ["background"] as const) {
		it(`${mode} cancellation kills owned descendants even after a final answer`, async () => {
			const pidFile = path.join(cwd, "descendant.pid");
			mock.onCall({ output: "Answer before cancellation", spawnSignalResistantDescendantPidFile: pidFile, keepAliveAfterFinalMessageMs: 10_000 });
			const id = `lifecycle-child-${process.pid}-${Date.now()}`;
			{
				asyncIds.push(id);
				executeAsyncSingle(id, { agent: "worker", task: "Inspect", agentConfig: makeAgent("worker"), ctx: { pi: { events: { emit() {} } }, cwd, currentSessionId: "lifecycle" }, shareEnabled: false, maxSubagentDepth: 2 });
			}
			await waitForFile(pidFile);
			const descendantPid = Number(fs.readFileSync(pidFile, "utf-8"));
			try {
				{
					const status = JSON.parse(fs.readFileSync(path.join(getRunMetadataDir(id!), "status.json"), "utf-8"));
					process.kill(status.pid, "SIGTERM");
					const resultPath = path.join(RESULTS_DIR, `${id}.json`);
					await waitForFile(resultPath);
					assert.equal(JSON.parse(fs.readFileSync(resultPath, "utf-8")).success, false);
				}
				const deadline = Date.now() + 3000;
				while (Date.now() < deadline) {
					try { process.kill(descendantPid, 0); } catch (error) {
						if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
						throw error;
					}
					await delay(20);
				}
				assert.fail(`Owned descendant ${descendantPid} survived cancellation`);
			} finally {
				try { process.kill(descendantPid, "SIGKILL"); } catch {}
			}
		});
	}

	it("background stop stays live until the resistant agent process actually exits", async () => {
		const id = `resistant-stop-${process.pid}-${Date.now()}`;
		asyncIds.push(id);
		mock.onCall({ ignoreSignals: true, steps: [{ jsonl: [events.toolStart("bash", { command: "controlled resistant agent" })] }, { delay: 10_000, jsonl: [events.assistantMessage("Too late")] }] });
		const started = executeAsyncSingle(id, { agent: "worker", task: "Inspect", agentConfig: makeAgent("worker"), ctx: { pi: { events: { emit() {} } }, cwd, currentSessionId: "lifecycle" }, shareEnabled: false, maxSubagentDepth: 2 });
		const statusFile = path.join(started.details.asyncDir!, "status.json");
		await waitForFile(statusFile);
		const deadline = Date.now() + 10_000;
		const status = () => JSON.parse(fs.readFileSync(statusFile, "utf8"));
		while (status().steps?.[0]?.currentTool !== "bash") { assert.ok(Date.now() < deadline); await delay(20); }
		const { writeAsyncInterruptRequest } = await import("../../src/runs/foreground/foreground-control.ts");
		writeAsyncInterruptRequest(started.details.asyncDir!, id);
		await delay(300);
		assert.equal(status().state, "running", "stop requested is not a terminal process receipt");
		assert.equal(status().steps[0].currentTool, "bash");
		assert.equal(status().steps[0].endedAt, undefined);
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		await waitForFile(resultPath);
		const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
		assert.equal(result.state, "paused");
		assert.equal(result.results[0].exitCode, 0);
		assert.equal(result.results[0].agentProcessExit.signal, "SIGKILL");
		assert.deepEqual(status().steps[0].agentProcessExit, result.results[0].agentProcessExit);
	});

	it("does not start verification commands when already cancelled", async () => {
		const marker = path.join(cwd, "unexpected-command");
		const acceptance = resolveEffectiveAcceptance({ explicit: { verify: [{ id: "cancelled", command: `touch '${marker}'`, allowFailure: true }] } });
		const ledger = await evaluateAcceptance({ acceptance, output: report, cwd, signal: AbortSignal.abort() });
		assert.equal(ledger.status, "rejected");
		assert.equal(ledger.verifyRuns.length, 0);
		assert.equal(fs.existsSync(marker), false);
	});

	it("keeps composed shell verification commands intact", async () => {
		const acceptance = resolveEffectiveAcceptance({ explicit: { verify: [{ id: "shell", command: "printf hello | tr a-z A-Z && printf ' world'" }] } });
		const ledger = await evaluateAcceptance({ acceptance, output: report, cwd });
		assert.equal(ledger.status, "verified");
		assert.equal(ledger.verifyRuns[0].stdout, "HELLO world");
	});

	it("verification timeout kills shell descendants instead of waiting for inherited pipes", async () => {
		const marker = path.join(cwd, "late-write");
		const acceptance = resolveEffectiveAcceptance({ explicit: { verify: [{ id: "timeout", command: `(sleep 1; printf late > '${marker}') & wait`, timeoutMs: 50 }] } });
		const started = Date.now();
		const ledger = await evaluateAcceptance({ acceptance, output: report, cwd });
		assert.equal(ledger.verifyRuns[0].status, "timed-out");
		assert.ok(Date.now() - started < 800, "verification waited for a descendant after its deadline");
		await delay(1100);
		assert.equal(fs.existsSync(marker), false);
	});
});
