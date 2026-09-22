import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AsyncStatus, OwnedRun, SubagentState } from "../../src/shared/types.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-durable-storage-"));
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
process.env.PI_SUBAGENT_TEMP_ROOT = path.join(root, "pi-subagents-runtime");
const { ASYNC_DIR, RESULTS_DIR } = await import("../../src/shared/types.ts");
const { getRunMetadataDir, saveQuestionContract, saveQuestionOwner } = await import("../../src/runs/shared/supervisor-questions.ts");
const { resolveAsyncRunLocation, resolveAsyncResumeTarget } = await import("../../src/runs/background/async-resume.ts");
const { resolveSubagentRunId } = await import("../../src/runs/background/run-id-resolver.ts");
const { listAsyncRuns } = await import("../../src/runs/background/async-status.ts");
const { inspectSubagentStatus } = await import("../../src/runs/background/run-status.ts");
const { reconcileAsyncRun, reconcileNestedAsyncDescendants } = await import("../../src/runs/background/stale-run-reconciler.ts");
const { createNestedRoute, writeNestedEvent, projectNestedEvents } = await import("../../src/runs/shared/nested-events.ts");
const { ownedRunView, ownedRunExecutionResult, restoreOwnedRuns } = await import("../../src/runs/shared/run-records.ts");
const { subagentCheckpointBlocker } = await import("../../src/runs/shared/checkpoint.ts");
const { createResultWatcher } = await import("../../src/runs/background/result-watcher.ts");
const { createEventBus } = await import("../support/helpers.ts");
after(() => fs.rmSync(root, { recursive: true, force: true }));

function write(file: string, value: object) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value));
}
function snapshot(dir: string): unknown {
	return fs.readdirSync(dir, { withFileTypes: true }).map((entry) => {
		const file = path.join(dir, entry.name);
		if (entry.isDirectory()) return [entry.name, snapshot(file)];
		const stat = fs.statSync(file, { bigint: true });
		return [entry.name, stat.ino, stat.mtimeNs, fs.readFileSync(file, "utf8")];
	});
}
function state(): SubagentState {
	return { baseCwd: root, currentSessionId: "parent-file", asyncJobs: new Map(), cleanupTimers: new Map(), lastUiContext: null, poller: null,
		completionSeen: new Map(), watcher: null, watcherRestartTimer: null, ownedRuns: new Map(),
		resultFileCoalescer: { schedule: () => false, clear() {} } };
}
function fixture(id: string) {
	const dir = getRunMetadataDir(id);
	const sessionFile = path.join(root, `${id}.jsonl`);
	fs.writeFileSync(sessionFile, "");
	const status = { runtimeVersion: 2, runId: id, mode: "single", state: "running", sessionId: "parent-file", cwd: root,
		pid: 2147483647, startedAt: 100, lastUpdate: 200, steps: [{ agent: "worker", status: "complete", sessionFile, exitCode: 0 }] } satisfies AsyncStatus & { runtimeVersion: 2 };
	write(path.join(dir, "status.json"), status);
	write(path.join(dir, "launch.json"), { runtimeVersion: 2, id, artifacts: false, share: false });
	saveQuestionOwner(id, "parent");
	const run: OwnedRun = { runId: id, rootRunId: id, ownerSessionId: "parent", source: "async", mode: "single", cwd: root,
		task: "Retain evidence", startedAt: 100, asyncDir: dir, children: [{ agent: "worker", index: 0, sessionFile }] };
	return { dir, sessionFile, status, run };
}
const dead = () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); };

it("v2 discovery, inspection and restore are pure and never infer group success from completed children", () => {
	const { dir, status, run } = fixture("v2-unconfirmed");
	saveQuestionContract(run.runId, 0, { result: { agent: "worker", task: run.task, exitCode: 0,
		usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 }, finalOutput: "Child evidence" } });
	const before = snapshot(dir);
	const local = state();
	const reconciled = reconcileAsyncRun(dir, { kill: dead });
	assert.equal(reconciled.repaired, false);
	assert.equal(reconciled.status?.state, "failed");
	assert.equal(reconciled.status?.steps?.[0]?.status, "complete");
	assert.match(reconciled.message!, /Completion is unconfirmed/);
	assert.equal(ownedRunView(run, local).state, "unknown");
	assert.equal(ownedRunView(run, local).children[0]?.result?.finalOutput, "Child evidence");
	assert.equal(inspectSubagentStatus({ id: run.runId }, { kill: dead }).details.managementControl?.state, "failed");
	assert.ok(listAsyncRuns(ASYNC_DIR, { kill: dead }).some((entry) => entry.id === run.runId));
	const ctx = { cwd: root, sessionManager: { getSessionId: () => "parent", getSessionFile: () => "parent-file", getEntries: () => [], getHeader: () => ({}) } } as unknown as ExtensionContext;
	restoreOwnedRuns(local, ctx, { strict: true });
	assert.equal(local.ownedRuns?.get(run.runId)?.asyncDir, dir);
	assert.equal(local.ownedRuns?.get(run.runId)?.legacy, false);
	assert.deepEqual(snapshot(dir), before);
	assert.equal(fs.existsSync(path.join(dir, "result.json")), false);
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8")), status);
	fs.unlinkSync(path.join(dir, "status.json"));
	assert.equal(ownedRunView(run, local).state, "unknown", "a retained v2 launch still requires a final result when status is unavailable");
});

it("v2 final results survive temporary cleanup and supply full execution results and resume targets", () => {
	const { dir, sessionFile, run } = fixture("v2-resumable");
	write(path.join(dir, "result.json"), { runtimeVersion: 2, id: run.runId, mode: "single", success: true, state: "complete", timestamp: 300,
		summary: "Worktree changes retained", outputs: { report: { path: "report.md" } },
		results: [{ agent: "worker", success: true, exitCode: 0, output: "Full child report", sessionFile,
			usage: { input: 13, output: 21, cacheRead: 0, cacheWrite: 0, cost: 0.75, turns: 2 },
			artifactPaths: { inputPath: "input", outputPath: "output", metadataPath: "metadata" },
			modelAttempts: [{ model: "provider/model", success: true, exitCode: 0, usage: { input: 3, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.25, turns: 1 } }] }] });
	// A stale legacy copy cannot supersede the v2 owner.
	write(path.join(ASYNC_DIR, run.runId, "status.json"), { ...JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8")), runtimeVersion: undefined, state: "failed" });
	assert.equal(resolveAsyncRunLocation({ id: run.runId }, ASYNC_DIR, RESULTS_DIR).asyncDir, dir);
	fs.rmSync(ASYNC_DIR, { recursive: true, force: true });
	const before = snapshot(dir);
	assert.equal(resolveSubagentRunId("v2-resum")?.kind, "async");
	assert.equal(resolveAsyncRunLocation({ dir }, ASYNC_DIR, RESULTS_DIR).resultPath, path.join(dir, "result.json"));
	assert.equal(resolveAsyncResumeTarget({ id: "v2-resum" }, { kill: dead }).sessionFile, sessionFile);
	assert.equal(resolveAsyncResumeTarget({ id: run.runId }, { kill: dead }).kind, "revive");
	const execution = ownedRunExecutionResult(run, state());
	assert.equal(execution.isError, undefined);
	assert.equal(execution.details.results[0]?.finalOutput, "Full child report");
	assert.equal(execution.details.results[0]?.usage.cost, 0.75, "direct native usage takes precedence over legacy attempt aggregation");
	assert.equal(execution.details.results[0]?.artifactPaths?.metadataPath, "metadata");
	assert.deepEqual(execution.details.outputs, { report: { path: "report.md" } });
	assert.match(execution.content[0]!.text!, /Worktree changes retained/);
	assert.deepEqual(snapshot(dir), before);
});

it("checkpoint guard follows durable process and completion evidence without a live host map", () => {
	const { dir, status, run } = fixture("checkpoint-owner");
	const local = state(); local.ownedRuns!.set(run.runId, run);
	write(path.join(dir, "status.json"), { ...status, state: "running", pid: process.pid, steps: [{ agent: "worker", status: "running" }] });
	assert.match(subagentCheckpointBlocker(local, "parent")!, /process is live/);
	write(path.join(dir, "status.json"), { ...status, state: "complete", pid: process.pid });
	assert.match(subagentCheckpointBlocker(local, "parent")!, /process is live/, "a terminal label does not prove process exit");
	write(path.join(dir, "status.json"), { ...status, state: "complete" });
	assert.match(subagentCheckpointBlocker(local, "parent")!, /completion is unconfirmed/, "an exited owner still needs its durable result");
	write(path.join(dir, "result.json"), { runtimeVersion: 2, id: run.runId, state: "complete", timestamp: 300, results: [{ agent: "worker", success: true, exitCode: 0, output: "Done" }] });
	assert.equal(subagentCheckpointBlocker(local, "parent"), undefined);
});

it("active legacy runs remain in their original directory and keep partial configuration", () => {
	const id = "legacy-draining";
	const sessionFile = path.join(root, "legacy.jsonl");
	fs.writeFileSync(sessionFile, "");
	write(path.join(ASYNC_DIR, id, "status.json"), { runId: id, mode: "single", state: "running", pid: process.pid,
		sessionId: "parent-file", startedAt: Date.now(), lastUpdate: Date.now(), steps: [{ agent: "worker", status: "running", sessionFile }] });
	const before = snapshot(path.join(ASYNC_DIR, id));
	const local = state();
	const ctx = { cwd: root, sessionManager: { getSessionId: () => "parent", getSessionFile: () => "parent-file", getEntries: () => [], getHeader: () => ({}) } } as unknown as ExtensionContext;
	restoreOwnedRuns(local, ctx, { strict: true });
	const run = local.ownedRuns!.get(id)!;
	assert.equal(run.asyncDir, path.join(ASYNC_DIR, id));
	assert.equal(resolveAsyncResumeTarget({ id }).kind, "live");
	assert.equal(ownedRunView(run, local).children[0]?.configuration, "legacy-partial");
	assert.equal(fs.existsSync(path.join(getRunMetadataDir(id), "status.json")), false);
	assert.deepEqual(snapshot(path.join(ASYNC_DIR, id)), before);
});

it("the watcher consumes only notifications and reconnects to an undelivered durable result", async () => {
	const { dir, run } = fixture("v2-watcher");
	const result = { runtimeVersion: 2, id: run.runId, sessionId: "parent-file", success: true, state: "complete", timestamp: 300, results: [{ agent: "worker", success: true, output: "Canonical full result" }] };
	const file = path.join(dir, "result.json");
	write(file, result);
	write(path.join(RESULTS_DIR, `${run.runId}.json`), { runtimeVersion: 2, id: run.runId, sessionId: "parent-file" });
	const before = fs.readFileSync(file, "utf8");
	const local = state();
	local.ownedRuns!.set(run.runId, run);
	const events = createEventBus();
	const delivered: unknown[] = [];
	events.on("subagent:async-complete", (data) => { delivered.push(data); run.delivery = { notifiedAt: Date.now(), intercomDelivered: false }; });
	let watcher = createResultWatcher({ events }, local, RESULTS_DIR, 60_000);
	try {
		watcher.primeExistingResults();
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(delivered.length, 1);
		assert.equal((delivered[0] as typeof result).results[0]?.output, "Canonical full result");
		assert.equal(fs.existsSync(path.join(RESULTS_DIR, `${run.runId}.json`)), false);
		assert.equal(fs.readFileSync(file, "utf8"), before);
		watcher.stopResultWatcher();
		local.completionSeen.clear();
		watcher = createResultWatcher({ events }, local, RESULTS_DIR, 60_000);
		watcher.primeExistingResults();
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(delivered.length, 1, "a persisted parent receipt survives watcher restart");
		delete run.delivery;
		watcher.primeExistingResults();
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(delivered.length, 2, "missing transient notification does not lose a committed result");
		assert.equal(fs.readFileSync(file, "utf8"), before);
	} finally { watcher.stopResultWatcher(); }
});

it("waiting tools retain delivery ownership until they settle or detach", async () => {
	const { dir, run } = fixture("v2-waiter");
	write(path.join(dir, "result.json"), { runtimeVersion: 2, id: run.runId, sessionId: "parent-file", success: true, state: "complete", timestamp: 400, results: [{ agent: "worker", success: true, output: "Waiting tool result" }] });
	const notification = path.join(RESULTS_DIR, `${run.runId}.json`);
	write(notification, { runtimeVersion: 2, id: run.runId, sessionId: "parent-file" });
	let consumed = false;
	const local = Object.assign(state(), { waitingRuns: new Map([[run.runId, 1]]), isRunResultConsumed: () => consumed });
	local.ownedRuns!.set(run.runId, run);
	const events = createEventBus();
	const delivered: Array<{ suppressNotification?: boolean }> = [];
	events.on("subagent:async-complete", (data) => delivered.push(data as { suppressNotification?: boolean }));
	const watcher = createResultWatcher({ events }, local, RESULTS_DIR, 60_000);
	try {
		watcher.primeExistingResults();
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.ok(delivered.length > 0);
		assert.ok(delivered.every((entry) => entry.suppressNotification));
		assert.equal(fs.existsSync(notification), true);
		assert.equal(local.completionSeen.size, 0);
		assert.equal(run.delivery, undefined);
		local.waitingRuns.clear();
		watcher.primeExistingResults();
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(delivered.filter((entry) => !entry.suppressNotification).length, 1);
		assert.equal(fs.existsSync(notification), false);
		assert.equal(fs.existsSync(path.join(dir, "result.json")), true);
		consumed = true;
		local.completionSeen.clear();
		write(notification, { runtimeVersion: 2, id: run.runId, sessionId: "parent-file" });
		watcher.primeExistingResults();
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(delivered.filter((entry) => !entry.suppressNotification).length, 1, "native consumption prevents a second notification");
		assert.equal(fs.existsSync(notification), false);
		assert.equal(fs.existsSync(path.join(dir, "result.json")), true);
	} finally { watcher.stopResultWatcher(); }
});

it("nested v2 owner loss is projected without publishing a competing completion event", () => {
	const route = createNestedRoute("nested-owner");
	const dir = path.join(process.env.PI_SUBAGENT_TEMP_ROOT!, "nested-subagent-runs", route.rootRunId, "nested-v2");
	write(path.join(dir, "status.json"), { runtimeVersion: 2, runId: "nested-v2", mode: "single", state: "running", pid: 2147483647, startedAt: 100, lastUpdate: 200, steps: [{ agent: "worker", status: "running" }] });
	writeNestedEvent(route, { type: "subagent.nested.started", ts: 100, parentRunId: route.rootRunId,
		child: { id: "nested-v2", parentRunId: route.rootRunId, depth: 1, path: [], asyncDir: dir, state: "running", agent: "worker" } });
	projectNestedEvents(route);
	const before = snapshot(process.env.PI_SUBAGENT_TEMP_ROOT!);
	const projected = reconcileNestedAsyncDescendants(route, { kill: dead });
	assert.deepEqual(snapshot(process.env.PI_SUBAGENT_TEMP_ROOT!), before);
	assert.equal(projected[0]?.state, "failed");
	assert.match(projected[0]?.error ?? "", /Completion is unconfirmed/);
});

it("owner loss cannot start another copy of a child that is still alive", () => {
	const { run, sessionFile } = fixture("v2-live-child");
	saveQuestionContract(run.runId, 0, { pid: process.pid, sessionFile });
	assert.equal(resolveAsyncResumeTarget({ id: run.runId }, { kill: (pid) => pid === process.pid ? true : dead() }).kind, "live");
});
