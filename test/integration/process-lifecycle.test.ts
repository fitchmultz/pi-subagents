import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { executeAsyncSingle } from "../../src/runs/background/async-execution.ts";
import { evaluateAcceptance, resolveEffectiveAcceptance } from "../../src/runs/shared/acceptance.ts";
import { ASYNC_DIR, RESULTS_DIR, INTERCOM_DETACH_REQUEST_EVENT } from "../../src/shared/types.ts";
import { createEventBus, createMockPi, createTempDir, events, makeAgent, removeTempDir } from "../support/helpers.ts";

async function waitForFile(file: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!fs.existsSync(file)) {
		assert.ok(Date.now() < deadline, `Timed out waiting for ${file}`);
		await delay(20);
	}
}

const report = '```acceptance-report\n{"manualNotes":"process lifecycle check"}\n```';

describe("process lifecycle regressions", { timeout: 40_000 }, () => {
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

	for (const mode of ["foreground", "background"] as const) {
		for (const prematureSettlement of [false, true]) {
			it(`${mode} waits for queued follow-up work${prematureSettlement ? " after renewed activity" : " after assistant stop"}`, async () => {
				mock.onCall({ steps: [
					{ jsonl: [events.assistantMessage("First answer"), { type: "agent_end", messages: [] }, ...(prematureSettlement ? [{ type: "agent_settled" }] : [])] },
					{ delay: 100, jsonl: [{ type: "agent_start" }, events.toolStart("bash", { command: "slow follow-up" })] },
					{ delay: 1500, jsonl: [events.toolEnd("bash"), events.assistantMessage("Follow-up completed"), { type: "agent_end", messages: [] }, { type: "agent_settled" }] },
				] });
				const agent = makeAgent("worker", { completionGuard: false });
				if (mode === "foreground") {
					const result = await runSync(cwd, [agent], "worker", "Follow up", { cwd });
					assert.equal(result.exitCode, 0);
					assert.equal(result.finalOutput, "Follow-up completed");
					assert.equal(result.progress?.currentTool, undefined);
				} else {
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

	for (const args of [{ action: "status" }, { action: "ask", to: "supervisor" }]) {
		it(`abort after completed intercom ${args.action} cancels rather than detaching`, async () => {
			mock.onCall({ steps: [
				{ jsonl: [events.toolStart("intercom", args), events.toolEnd("intercom")] },
				{ delay: 700, jsonl: [events.assistantMessage("Continued after cancellation")] },
			] });
			const controller = new AbortController();
			const bus = createEventBus();
			let sawTool = false;
			let onDetachedComplete!: (value: unknown) => void;
			const completed = new Promise((resolve) => { onDetachedComplete = resolve; });
			const result = await runSync(cwd, [makeAgent("worker")], "worker", "Inspect", {
				cwd, signal: controller.signal, allowIntercomDetach: true, intercomEvents: bus,
				onDetachedComplete: (value) => onDetachedComplete(value),
				onUpdate: (update) => {
					if (update.details?.progress?.[0]?.currentTool === "intercom") sawTool = true;
					else if (sawTool && !controller.signal.aborted) {
						bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "stale-ask" });
						controller.abort();
					}
				},
			});
			if (result.detached) await completed; // Let the broken baseline child finish before test cleanup.
			assert.equal(result.detached, undefined);
			assert.notEqual(result.exitCode, 0);
			assert.equal(mock.callCount(), 1);
		});
	}

	it("explicit abort during a live blocking ask does not detach without a handoff event", async () => {
		const controller = new AbortController();
		mock.onCall({ steps: [
			{ jsonl: [events.assistantMessage("First answer"), events.toolStart("contact_supervisor", { reason: "need_decision" })] },
			{ delay: 1500, jsonl: [events.assistantMessage("Too late")] },
		] });
		let complete!: (value: unknown) => void;
		const detachedCompletion = new Promise((resolve) => { complete = resolve; });
		const result = await runSync(cwd, [makeAgent("worker")], "worker", "Inspect", {
			signal: controller.signal, allowIntercomDetach: true,
			onDetachedComplete: (value) => complete(value),
			onUpdate: (update) => {
				if (update.details?.progress?.[0]?.currentTool === "contact_supervisor") controller.abort();
			},
		});
		if (result.detached) await detachedCompletion;
		assert.equal(result.detached, undefined);
		assert.notEqual(result.exitCode, 0);
		assert.equal(mock.callCount(), 1);
	});

	for (const mode of ["foreground", "background"] as const) {
		it(`${mode} cancellation stops verification descendants after finalization`, async () => {
			const ready = path.join(cwd, "verify-ready");
			const late = path.join(cwd, "verify-late");
			const next = path.join(cwd, "next-command");
			const command = `printf ready > '${ready}'; (sleep 1; printf late > '${late}') & wait`;
			const acceptance = {
				maxFinalizationTurns: 1,
				verify: [{ id: "slow", command, timeoutMs: 10_000 }, { id: "next", command: `printf next > '${next}'` }],
			};
			mock.onCall({ output: `Finished\n${report}` });
			if (mode === "foreground") {
				const controller = new AbortController();
				const running = runSync(cwd, [makeAgent("worker")], "worker", "Inspect", { cwd, signal: controller.signal, acceptance, sessionFile: path.join(cwd, "session.jsonl") });
				await waitForFile(ready);
				controller.abort();
				const result = await running;
				assert.notEqual(result.exitCode, 0);
				assert.equal(result.acceptance?.status, "rejected");
			} else {
				const id = `lifecycle-verify-${process.pid}-${Date.now()}`;
				asyncIds.push(id);
				executeAsyncSingle(id, { agent: "worker", task: "Inspect", acceptance, agentConfig: makeAgent("worker"), ctx: { pi: { events: { emit() {} } }, cwd, currentSessionId: "lifecycle" }, sessionFile: path.join(cwd, "session.jsonl"), shareEnabled: false, maxSubagentDepth: 2 });
				await waitForFile(ready);
				const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8"));
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
			assert.equal(mock.callCount(), 2);
		});
	}

	for (const mode of ["foreground", "background"] as const) {
		it(`${mode} cancellation kills owned descendants even after a final answer`, async () => {
			const pidFile = path.join(cwd, "descendant.pid");
			mock.onCall({ output: "Answer before cancellation", spawnSignalResistantDescendantPidFile: pidFile, keepAliveAfterFinalMessageMs: 10_000 });
			const controller = new AbortController();
			let running: ReturnType<typeof runSync> | undefined;
			let id: string | undefined;
			if (mode === "foreground") {
				running = runSync(cwd, [makeAgent("worker")], "worker", "Inspect", { cwd, signal: controller.signal });
			} else {
				id = `lifecycle-child-${process.pid}-${Date.now()}`;
				asyncIds.push(id);
				executeAsyncSingle(id, { agent: "worker", task: "Inspect", agentConfig: makeAgent("worker"), ctx: { pi: { events: { emit() {} } }, cwd, currentSessionId: "lifecycle" }, shareEnabled: false, maxSubagentDepth: 2 });
			}
			await waitForFile(pidFile);
			const descendantPid = Number(fs.readFileSync(pidFile, "utf-8"));
			try {
				if (running) {
					controller.abort();
					assert.notEqual((await running).exitCode, 0);
				} else {
					const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id!, "status.json"), "utf-8"));
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
