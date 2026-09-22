import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { waitForOwnedRun } from "../../src/runs/foreground/wait-run.ts";
import { createAsyncJobTracker } from "../../src/runs/background/async-job-tracker.ts";
import { getRunMetadataDir } from "../../src/runs/shared/supervisor-questions.ts";
import { INTERCOM_DETACH_REQUEST_EVENT } from "../../src/shared/types.ts";
import { createEventBus, makeMinimalCtx } from "../support/helpers.ts";

const [cwd, outcome] = process.argv.slice(2);
const runId = randomUUID(), ownerSessionId = "session-123", asyncDir = path.join(cwd, runId);
fs.mkdirSync(asyncDir);
// An early terminal status is not durable completion. A live producer still owes its result.
fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ runId, mode: "single", state: "complete", startedAt: 1, pid: process.pid, steps: [{ agent: "worker", status: "complete" }] }));
const run = { runId, rootRunId: runId, ownerSessionId, source: "async", mode: "single", cwd, task: "liveness", startedAt: 1, asyncDir, pid: process.pid, children: [{ agent: "worker", index: 0 }] };
const state = { currentSessionId: ownerSessionId, ownedRuns: new Map([[runId, run]]), foregroundRuns: new Map(), asyncJobs: new Map(), cleanupTimers: new Map() };
const pi = { events: createEventBus() };
const tracker = createAsyncJobTracker(pi, state, cwd);
tracker.ensurePoller();

if (outcome === "background") {
	// Passive tracking must not hold the host open when no foreground call is waiting.
	process.exitCode = 0;
} else {
	const controller = new AbortController();
	// This producer intentionally supplies no event-loop reference. The foreground
	// operation owns liveness, not a test timeout, mock child, TUI, or node:test itself.
	setTimeout(() => {
		if (outcome === "cancelled") controller.abort();
		else if (outcome === "yielded") pi.events.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: randomUUID(), reason: "attention" });
		else if (outcome === "unavailable") state.currentSessionId = "replacement-session";
		else {
			fs.mkdirSync(getRunMetadataDir(runId), { recursive: true });
			fs.writeFileSync(path.join(getRunMetadataDir(runId), "result.json"), JSON.stringify({ id: runId, mode: "single", success: true, state: "complete", results: [{ agent: "worker", output: "DURABLE-RESULT", exitCode: 0, success: true }] }));
		}
	}, 160).unref();
	process.exitCode = 1; // Natural exit before resolution must fail, not silently pass.
	waitForOwnedRun({ id: runId, deps: { pi, state }, ctx: makeMinimalCtx(cwd), signal: controller.signal }).then((result) => {
		assert.equal(result.details.wait.status, outcome);
		if (outcome === "completed") assert.match(result.content[0].text, /DURABLE-RESULT/);
		assert.equal(fs.existsSync(path.join(asyncDir, "control-request.json")), false, "ending this wait must not stop existing work");
		process.exitCode = 0;
		console.log(outcome);
	});
}
// No forced exit or timer cleanup: natural process exit also proves that settling
// the foreground wait releases its reference while the background poller stays unref'ed.
