import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { checkPidLiveness, reconcileAsyncRun } from "../../src/runs/background/stale-run-reconciler.ts";
import { RUNNER_ERROR_LOG_FILE } from "../../src/shared/types.ts";

function tempRoot(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeStatus(asyncDir: string, status: Record<string, unknown>): void {
	fs.mkdirSync(asyncDir, { recursive: true });
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(status, null, 2), "utf-8");
}

function errno(code: string): NodeJS.ErrnoException {
	const error = new Error(code) as NodeJS.ErrnoException;
	error.code = code;
	return error;
}

describe("async stale-run reconciliation", () => {
	it("classifies pid liveness without treating EPERM as dead", () => {
		assert.equal(checkPidLiveness(123, () => true), "alive");
		assert.equal(checkPidLiveness(123, () => { throw errno("ESRCH"); }), "dead");
		assert.equal(checkPidLiveness(123, () => { throw errno("EPERM"); }), "unknown");
		assert.equal(checkPidLiveness(123, () => { throw new Error("boom"); }), "unknown");
	});

	it("marks a running async run failed when the runner pid is dead and no result exists", () => {
		const root = tempRoot("pi-stale-run-");
		try {
			const asyncDir = path.join(root, "run-dead");
			const resultsDir = path.join(root, "results");
			writeStatus(asyncDir, {
				runId: "run-dead",
				sessionId: "session-current",
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: 1000,
				lastUpdate: 1000,
				currentStep: 0,
				steps: [{ agent: "scout", status: "running", startedAt: 1000 }],
			});
			const runnerStderr = `${"noisy bootstrap output\n".repeat(1000)}\u001b[31mCannot find module 'typebox/compile'\u001b[0m\n`;
			fs.writeFileSync(path.join(asyncDir, RUNNER_ERROR_LOG_FILE), runnerStderr, "utf-8");

			const result = reconcileAsyncRun(asyncDir, {
				resultsDir,
				kill: () => { throw errno("ESRCH"); },
				now: () => 2000,
			});

			assert.equal(result.repaired, true);
			assert.equal(result.status?.state, "failed");
			assert.match(result.message ?? "", /process 12345 exited or disappeared/);
			assert.match(result.message ?? "", /Runner stderr:\n\[runner stderr truncated to last 16384 bytes\]/);
			assert.match(result.message ?? "", /Cannot find module 'typebox\/compile'/);
			assert.doesNotMatch(result.message ?? "", /\u001b/);
			assert.ok((result.message?.length ?? Infinity) < runnerStderr.length);
			const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"));
			assert.equal(status.state, "failed");
			assert.equal(status.sessionId, "session-current");
			assert.equal(status.steps[0].status, "failed");
			assert.match(status.steps[0].error, /process 12345 exited or disappeared/);
			assert.match(status.steps[0].error, /Cannot find module 'typebox\/compile'/);
			const resultJson = JSON.parse(fs.readFileSync(path.join(resultsDir, "run-dead.json"), "utf-8"));
			assert.equal(resultJson.success, false);
			assert.equal(resultJson.sessionId, "session-current");
			assert.equal(resultJson.state, "failed");
			assert.equal(resultJson.exitCode, 1);
			assert.match(resultJson.summary, /process 12345 exited or disappeared/);
			assert.match(fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8"), /subagent\.run\.repaired_stale/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("marks a queued async run failed when the runner pid is dead and no result exists", () => {
		const root = tempRoot("pi-stale-queued-run-");
		try {
			const asyncDir = path.join(root, "run-queued-dead");
			const resultsDir = path.join(root, "results");
			writeStatus(asyncDir, {
				runId: "run-queued-dead",
				mode: "parallel",
				state: "queued",
				pid: 12345,
				startedAt: 1000,
				lastUpdate: 1000,
				steps: [{ agent: "worker", status: "queued", startedAt: 1000 }],
			});

			const result = reconcileAsyncRun(asyncDir, {
				resultsDir,
				kill: () => { throw errno("ESRCH"); },
				now: () => 2000,
			});

			assert.equal(result.repaired, true);
			assert.equal(result.status?.state, "failed");
			const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"));
			assert.equal(status.state, "failed");
			assert.equal(status.steps[0].status, "failed");
			assert.equal(JSON.parse(fs.readFileSync(path.join(resultsDir, "run-queued-dead.json"), "utf-8")).success, false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("repairs stale status with per-child result outcomes", () => {
		const root = tempRoot("pi-stale-mixed-result-");
		try {
			const asyncDir = path.join(root, "run-mixed");
			const resultsDir = path.join(root, "results");
			fs.mkdirSync(resultsDir, { recursive: true });
			writeStatus(asyncDir, {
				runId: "run-mixed",
				mode: "chain",
				state: "running",
				pid: 12345,
				startedAt: 1000,
				lastUpdate: 1000,
				steps: [
					{ agent: "scout", status: "running", startedAt: 1000 },
					{ agent: "worker", status: "running", startedAt: 1100 },
				],
			});
			const scoutSession = path.join(root, "scout.jsonl");
			const workerSession = path.join(root, "worker.jsonl");
			fs.writeFileSync(path.join(resultsDir, "run-mixed.json"), JSON.stringify({
				id: "run-mixed",
				success: false,
				state: "failed",
				results: [
					{ agent: "scout", success: true, sessionFile: scoutSession, model: "fast" },
					{ agent: "worker", success: false, error: "boom", sessionFile: workerSession, model: "careful" },
				],
			}, null, 2), "utf-8");

			const result = reconcileAsyncRun(asyncDir, {
				resultsDir,
				kill: () => { throw errno("ESRCH"); },
				now: () => 2000,
			});

			assert.equal(result.repaired, true);
			assert.equal(result.status?.state, "failed");
			assert.equal(result.status?.steps?.[0]?.status, "complete");
			assert.equal(result.status?.steps?.[0]?.exitCode, 0);
			assert.equal(result.status?.steps?.[0]?.model, "fast");
			assert.equal(result.status?.steps?.[0]?.sessionFile, scoutSession);
			assert.equal(result.status?.steps?.[1]?.status, "failed");
			assert.equal(result.status?.steps?.[1]?.exitCode, 1);
			assert.equal(result.status?.steps?.[1]?.error, "boom");
			assert.equal(result.status?.steps?.[1]?.model, "careful");
			assert.equal(result.status?.steps?.[1]?.sessionFile, workerSession);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps interrupted paused children paused when repairing from an existing paused result", () => {
		const root = tempRoot("pi-stale-paused-result-");
		try {
			const asyncDir = path.join(root, "run-paused");
			const resultsDir = path.join(root, "results");
			fs.mkdirSync(resultsDir, { recursive: true });
			writeStatus(asyncDir, {
				runId: "run-paused",
				mode: "parallel",
				state: "running",
				pid: 12345,
				startedAt: 1000,
				lastUpdate: 1000,
				currentTool: "read",
				currentToolStartedAt: 1500,
				currentPath: "large.pdf",
				steps: [
					{ agent: "scout", status: "running", startedAt: 1000, currentTool: "read", currentToolStartedAt: 1500, currentPath: "a.pdf" },
					{ agent: "worker", status: "running", startedAt: 1100, currentTool: "read", currentToolStartedAt: 1500, currentPath: "b.pdf" },
					{ agent: "reviewer", status: "running", startedAt: 1200, currentTool: "read", currentToolStartedAt: 1500, currentPath: "c.pdf" },
				],
			});
			fs.writeFileSync(path.join(resultsDir, "run-paused.json"), JSON.stringify({
				id: "run-paused",
				success: false,
				state: "paused",
				exitCode: 0,
				results: [
					{ agent: "scout", success: true },
					{ agent: "worker", success: false, interrupted: true },
					{ agent: "reviewer", success: false, error: "Resource limit exceeded" },
				],
			}, null, 2), "utf-8");

			const result = reconcileAsyncRun(asyncDir, {
				resultsDir,
				kill: () => { throw errno("ESRCH"); },
				now: () => 2000,
			});

			assert.equal(result.repaired, true);
			assert.equal(result.status?.state, "paused");
			assert.equal(result.status?.steps?.[0]?.status, "complete");
			assert.equal(result.status?.steps?.[1]?.status, "paused");
			assert.equal(result.status?.steps?.[1]?.exitCode, 0);
			assert.equal(result.status?.steps?.[2]?.status, "failed");
			assert.equal(result.status?.steps?.[2]?.exitCode, 1);
			assert.equal(result.status?.steps?.[2]?.error, "Resource limit exceeded");
			assert.equal(result.status?.currentTool, undefined);
			assert.equal(result.status?.currentPath, undefined);
			assert.equal(result.status?.steps?.some((step) => step.currentTool || step.currentPath), false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("preserves completed step output when writing a stale-run failure result", () => {
		const root = tempRoot("pi-stale-partial-output-");
		try {
			const asyncDir = path.join(root, "run-partial");
			const resultsDir = path.join(root, "results");
			writeStatus(asyncDir, {
				runId: "run-partial",
				mode: "parallel",
				state: "running",
				pid: 12345,
				startedAt: 1000,
				lastUpdate: 1000,
				steps: [
					{ agent: "scout", status: "complete", startedAt: 1000, endedAt: 1200, durationMs: 200, exitCode: 0 },
					{ agent: "worker", status: "running", startedAt: 1100 },
				],
			});
			fs.writeFileSync(path.join(asyncDir, "output-0.log"), "completed scout output\n", "utf-8");

			const result = reconcileAsyncRun(asyncDir, {
				resultsDir,
				kill: () => { throw errno("ESRCH"); },
				now: () => 2000,
			});

			assert.equal(result.repaired, true);
			assert.equal(result.status?.state, "failed");
			const resultJson = JSON.parse(fs.readFileSync(path.join(resultsDir, "run-partial.json"), "utf-8"));
			assert.equal(resultJson.results[0].success, true);
			assert.equal(resultJson.results[0].output, "completed scout output");
			assert.equal(resultJson.results[1].success, false);
			assert.match(resultJson.results[1].output, /exited or disappeared/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails a stale run when a live pid has not updated beyond the stale threshold", () => {
		const root = tempRoot("pi-stale-live-pid-");
		try {
			const asyncDir = path.join(root, "run-reused-pid");
			const resultsDir = path.join(root, "results");
			writeStatus(asyncDir, {
				runId: "run-reused-pid",
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: 1000,
				lastUpdate: 1000,
				steps: [{ agent: "worker", status: "running", startedAt: 1000 }],
			});

			const result = reconcileAsyncRun(asyncDir, {
				resultsDir,
				kill: () => true,
				now: () => 5000,
				staleAlivePidMs: 1000,
			});

			assert.equal(result.repaired, true);
			assert.equal(result.status?.state, "failed");
			assert.match(result.message ?? "", /live PID, but status has not updated/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("preserves an existing result instead of overwriting it with stale-run failure", () => {
		const root = tempRoot("pi-stale-existing-result-");
		try {
			const asyncDir = path.join(root, "run-result");
			const resultsDir = path.join(root, "results");
			fs.mkdirSync(resultsDir, { recursive: true });
			writeStatus(asyncDir, {
				runId: "run-result",
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: 1000,
				lastUpdate: 1000,
				steps: [{ agent: "worker", status: "running", startedAt: 1000 }],
			});
			const resultPath = path.join(resultsDir, "run-result.json");
			fs.writeFileSync(resultPath, JSON.stringify({ id: "run-result", success: true, state: "complete", summary: "already done" }, null, 2), "utf-8");

			const result = reconcileAsyncRun(asyncDir, {
				resultsDir,
				kill: () => { throw errno("ESRCH"); },
				now: () => 2000,
			});

			assert.equal(result.repaired, true);
			assert.equal(result.status?.state, "complete");
			assert.equal(JSON.parse(fs.readFileSync(resultPath, "utf-8")).summary, "already done");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
