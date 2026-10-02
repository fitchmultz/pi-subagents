import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { after, test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createEventBus, createMockPi, events, makeAgent, makeMinimalCtx } from "../support/helpers.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-delegation-"));
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
process.env.PI_SUBAGENT_TEMP_ROOT = path.join(root, "pi-subagents-runtime");
const { createSubagentExecutor } = await import("../../src/runs/foreground/subagent-executor.ts");
const { waitForOwnedRun } = await import("../../src/runs/foreground/wait-run.ts");
const { createCompletionDelivery } = await import("../../src/runs/background/completion-delivery.ts");
const { registerParentUsage } = await import("../../src/runs/shared/parent-usage.ts");
const { rememberOwnedRun, restoreOwnedRuns } = await import("../../src/runs/shared/run-records.ts");
const { getRunMetadataDir, createSupervisorQuestion, saveQuestionOwner, saveRunStatus, saveAsyncRunResult, saveQuestionContract } = await import("../../src/runs/shared/supervisor-questions.ts");
const { createNestedRoute, writeNestedEvent, readNestedControlRequests, writeNestedControlResult } = await import("../../src/runs/shared/nested-events.ts");
const { createResultWatcher } = await import("../../src/runs/background/result-watcher.ts");
const { INTERCOM_DETACH_REQUEST_EVENT, INTERCOM_DETACH_RESPONSE_EVENT, SUBAGENT_LIVE_INTERCOM_EVENT, SUBAGENT_LIVE_INTERCOM_DELIVERY_EVENT, RESULTS_DIR } = await import("../../src/shared/types.ts");
after(() => fs.rmSync(root, { recursive: true, force: true }));

async function until(check, message) {
	const deadline = Date.now() + 10_000;
	while (!check()) { assert.ok(Date.now() < deadline, message); await delay(20); }
}

function setup(t, config = {}, asyncByDefault = true) {
	const cwd = fs.mkdtempSync(path.join(root, "case-"));
	const manager = SessionManager.create(cwd, path.join(cwd, "parent"));
	manager.appendMessage(events.assistantMessage("Delegate a bounded task").message);
	const ctx = { ...makeMinimalCtx(cwd), sessionManager: manager,
		model: { provider: "fixture", id: "parent" },
		isIdle: () => true, hasPendingMessages: () => false,
	};
	const bus = createEventBus();
	const pi = { events: bus, getSessionName: () => "native-parent", appendEntry: (type, data) => {
		manager.appendCustomEntry(type, data);
	} };
	const state = { baseCwd: cwd, currentSessionId: null, ownedRuns: new Map(), foregroundRuns: new Map(), asyncJobs: new Map(),
		cleanupTimers: new Map(), completionSeen: new Map(), lastUiContext: ctx,
		persistOwnedRun: (run) => manager.appendCustomEntry("subagent-run", run), resultFileCoalescer: { schedule: () => false, clear() {} } };
	const executor = createSubagentExecutor({ pi, state, config, asyncByDefault, tempArtifactsDir: cwd,
		getSubagentSessionRoot: () => path.join(cwd, "children"), expandTilde: (value) => value,
		discoverAgents: () => ({ agents: [makeAgent("worker", { model: "fixture/child", completionGuard: false })] }),
	});
	const mock = createMockPi(); mock.install();
	t.after(async () => {
		for (const run of state.ownedRuns.values()) if (run.asyncDir && !fs.existsSync(path.join(getRunMetadataDir(run.runId), "result.json"))) {
			await executor.execute(randomUUID(), { action: "interrupt", id: run.runId }, undefined, undefined, ctx);
			await until(() => fs.existsSync(path.join(getRunMetadataDir(run.runId), "result.json")), "fixture child must exit before cleanup");
		}
		mock.uninstall();
	});
	return { cwd, manager, ctx, bus, pi, state, executor, mock,
		invoke: (id, params, signal?) => executor.execute(id, params, signal, undefined, ctx),
		wait: (id, index?, signal?, includeProgress?) => waitForOwnedRun({ id, index, signal, includeProgress, executionResult: true, ctx, deps: { pi, state, config } }),
	};
}


for (const background of [undefined, true, false]) test(`background launch returns a receipt before completion (${background === false ? "forced" : background})`, async (t) => {
	const f = setup(t, { forceTopLevelAsync: background === false });
	f.mock.onCall({ delay: 700, output: "APPENDED_COMPLETION" });
	const receipt = await f.invoke("native-receipt", { agent: "worker", task: "Do bounded work", async: background });
	const runId = receipt.details.asyncId;
	assert.ok(runId);
	assert.equal(receipt.details.wait, undefined);
	assert.equal(fs.existsSync(path.join(getRunMetadataDir(runId), "result.json")), false, "receipt precedes completion");
	const notices = [];
	const { default: registerNotify } = await import("../../src/runs/background/notify.ts");
	registerNotify({ ...f.pi, sendMessage: (message, options) => notices.push({ message, options }) });
	const watcher = createResultWatcher(f.pi, f.state, RESULTS_DIR);
	t.after(() => watcher.stopResultWatcher());
	await until(() => fs.existsSync(path.join(getRunMetadataDir(runId), "result.json")), "child completes independently");
	watcher.primeExistingResults();
	await until(() => notices.length === 1, "completion appends a wake-up message");
	assert.equal(notices[0].message.customType, "subagent-notify");
	assert.match(notices[0].message.content, /APPENDED_COMPLETION/);
	assert.equal(notices[0].options.triggerTurn, true);
	watcher.primeExistingResults();
	await delay(100);
	assert.equal(notices.length, 1);
});

for (const action of ["resume", "answer"]) for (const background of [undefined, true]) test(`${action} returns its receipt without waiting (${background})`, async (t) => {
	const f = setup(t);
	f.mock.onCall({ delay: 900, output: "LATER_RESULT" });
	const launch = await f.invoke("launch", { agent: "worker", task: "Keep working" });
	const runId = launch.details.asyncId;
	await until(() => f.mock.callCount() === 1, "child starts");
	f.bus.on(SUBAGENT_LIVE_INTERCOM_EVENT, (request) => {
		f.bus.emit(SUBAGENT_LIVE_INTERCOM_DELIVERY_EVENT, { requestId: request.requestId, delivered: true });
	});
	const question = action === "answer" ? createSupervisorQuestion({ runId, ownerTarget: "parent", agent: "worker", index: 0,
		childSessionId: "child", childTarget: "child", sessionFile: path.join(f.cwd, "child.jsonl"), cwd: f.cwd,
		pid: process.pid, reason: "need_decision", message: "Proceed?" }) : undefined;
	const receipt = await f.invoke("control", { action, id: runId, message: "Proceed", async: background, questionId: question?.questionId });
	assert.notEqual(receipt.isError, true);
	assert.equal(receipt.details.wait, undefined);
	assert.equal(fs.existsSync(path.join(getRunMetadataDir(runId), "result.json")), false, "control returns while the child is still running");
	if (question) assert.equal(receipt.details.questions[0].answer.message, "Proceed");
	else assert.equal(receipt.details.managementControl.runId, runId);
});

for (const foreground of [false, undefined]) test(`foreground delegation waits for the actual result (${foreground === false ? "explicit" : "configured"})`, async (t) => {
	const f = setup(t, {}, false);
	f.mock.onCall({ delay: 350, output: "ORIGINAL_CALL_RESULT" });
	let finished = false;
	const resultPromise = f.invoke("native-launch", { agent: "worker", task: "Do bounded work", async: foreground }).then((result) => { finished = true; return result; });
	await until(() => f.mock.callCount() === 1, "native child starts");
	assert.equal(finished, false, "a launch receipt cannot settle a foreground call");
	const runId = [...f.state.ownedRuns.keys()][0];
	assert.ok(runId, "list exposes the durable handle while the foreground call waits");
	const result = await resultPromise;
	assert.equal(result.details.wait.status, "completed");
	assert.equal(result.details.wait.runId, runId);
	assert.match(result.content[0].text, /ORIGINAL_CALL_RESULT/);
	assert.equal(f.mock.callCount(), 1);
});

test("aborting an existing wait preserves the child; restoring owned work does not relaunch", async (t) => {
	const f = setup(t);
	f.mock.onCall({ delay: 450, output: "AFTER_REATTACH" });
	const receipt = await f.invoke("launch", { agent: "worker", task: "Keep running" });
	const runId = receipt.details.asyncId;
	await until(() => f.mock.callCount() === 1, "child starts");
	const abort = new AbortController();
	const waiting = f.wait(runId, undefined, abort.signal);
	abort.abort();
	assert.equal((await waiting).details.wait.status, "cancelled");
	assert.equal(fs.existsSync(path.join(getRunMetadataDir(runId), "control-requests")), false);
	f.state.ownedRuns.clear(); restoreOwnedRuns(f.state, f.ctx);
	const result = await f.wait(runId, undefined, undefined, true);
	assert.equal(result.details.wait.status, "completed");
	assert.match(result.content[0].text, /AFTER_REATTACH/);
	assert.equal(result.details.progress?.[0]?.task, "Keep running");
	assert.equal(f.mock.callCount(), 1);
});

test("Intercom attention releases the foreground wait without stopping existing work", async (t) => {
	const f = setup(t);
	f.mock.onCall({ delay: 350, output: "AFTER_STEER" });
	const receipt = await f.invoke("launch", { agent: "worker", task: "Finish" });
	await until(() => f.mock.callCount() === 1, "child starts");
	const waiting = f.wait(receipt.details.asyncId);
	let accepted = false;
	f.bus.on(INTERCOM_DETACH_RESPONSE_EVENT, (response) => { accepted = response.accepted; });
	f.bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "attention", reason: "attention" });
	assert.equal(accepted, true);
	assert.equal((await waiting).details.wait.status, "yielded");
	assert.match((await f.wait(receipt.details.asyncId)).content[0].text, /AFTER_STEER/);
});

for (const includeProgress of [true, undefined]) test(`live continuation waits and restores its own progress opt-in (${includeProgress})`, async (t) => {
	const f = setup(t);
	f.mock.onCall({ delay: 650, output: "LIVE_CONTINUATION_RESULT" });
	const receipt = await f.invoke("portable-launch", { agent: "worker", task: "Wait for guidance", includeProgress: !includeProgress });
	const runId = receipt.details.asyncId;
	await until(() => f.mock.callCount() === 1, "portable child starts");
	let deliveries = 0;
	f.bus.on(SUBAGENT_LIVE_INTERCOM_EVENT, (request) => {
		deliveries++;
		f.bus.emit(SUBAGENT_LIVE_INTERCOM_DELIVERY_EVENT, { requestId: request.requestId, delivered: true });
	});
	const result = await f.invoke("native-continue", { action: "resume", id: runId, message: "Use this guidance", includeProgress, async: false });
	assert.equal(result.details.wait.status, "completed");
	assert.match(result.content[0].text, /LIVE_CONTINUATION_RESULT/);
	assert.equal(result.details.progress?.[0]?.status, includeProgress ? "complete" : undefined, "the waiting continuation opts in independently of the original launch");
	const recovered = await f.wait(runId, undefined, undefined, includeProgress);
	assert.deepEqual(recovered.details.progress, result.details.progress);
	assert.equal(deliveries, 1);
	assert.equal(f.mock.callCount(), 1);
	assert.equal(deliveries, 1);
});

for (const selected of [undefined, 1]) test(`nested continuation ${selected === undefined ? "whole-run" : "selected-child"} waits and recovers without adoption or redelivery`, async (t) => {
	const f = setup(t), rootId = randomUUID(), runId = randomUUID(), callId = `native-nested-${selected ?? "all"}`;
	const childOwner = SessionManager.create(f.cwd, path.join(f.cwd, "child-owner"));
	const route = createNestedRoute(rootId), asyncDir = getRunMetadataDir(runId), mode = selected === undefined ? "single" : "parallel";
	rememberOwnedRun(f.state, { runId: rootId, rootRunId: rootId, ownerSessionId: f.manager.getSessionId(), source: "async", mode: "single", cwd: f.cwd, task: "Outer assignment", startedAt: Date.now(), children: [] });
	saveQuestionOwner(runId, childOwner.getSessionId());
	const steps = Array.from({ length: selected === undefined ? 1 : 2 }, (_, index) => ({ agent: "worker", status: "running", sessionFile: path.join(f.cwd, `nested-${index}.jsonl`) }));
	for (const [index, step] of steps.entries()) saveQuestionContract(runId, index, { task: `Nested assignment ${index}`, sessionFile: step.sessionFile });
	saveRunStatus(runId, { runtimeVersion: 2, runId, mode, state: "running", pid: process.pid, cwd: f.cwd, startedAt: Date.now(), indexedControl: true, controlRequestFiles: true, steps });
	fs.writeFileSync(path.join(asyncDir, "launch.json"), JSON.stringify({ runtimeVersion: 2, nestedRoute: route, nestedSelf: { parentRunId: rootId } }));
	writeNestedEvent(route, { type: "subagent.nested.started", ts: Date.now(), parentRunId: rootId, parentStepIndex: 0,
		child: { id: runId, parentRunId: rootId, parentStepIndex: 0, depth: 1, path: [{ runId: rootId, stepIndex: 0 }], state: "running", mode, agent: "worker", ownerState: "live", asyncDir, indexedControl: true } });
	let delivered = 0;
	const reply = setInterval(() => {
		const request = readNestedControlRequests(route)[0];
		if (!request || delivered) return;
		delivered++;
		writeNestedControlResult(route, { ts: Date.now(), requestId: request.requestId, targetRunId: runId, ok: true, message: "Guidance accepted" });
	}, 10);
	const abort = new AbortController();
	let settled = false;
	const pending = f.invoke(callId, { action: "resume", id: runId.slice(0, 12), async: false, ...(selected === undefined ? {} : { index: selected }), message: "Continue the authorized work" }, abort.signal).then((result) => { settled = true; return result; });
	t.after(async () => { clearInterval(reply); abort.abort(); await pending; });
	await until(() => delivered === 1, "nested owner receives guidance");
	await delay(120);
	assert.equal(settled, false, "accepted nested guidance must remain pending for the actual saved result");
	assert.equal(readNestedControlRequests(route)[0]?.index, selected);
	abort.abort();
	assert.equal((await pending).details.wait.status, "cancelled");
	assert.equal(fs.existsSync(path.join(asyncDir, "control-requests")), false, "cancelling a continuation wait never cancels the descendant");
	assert.deepEqual([...f.state.ownedRuns.keys()], [rootId]);
	assert.equal(f.state.asyncJobs.size, 0);
	let recovered = false;
	const recovery = f.wait(runId, selected).then((result) => { recovered = true; return result; });
	await delay(30); assert.equal(recovered, false, "recovery waits on saved work rather than returning another receipt");
	const childResult = { agent: "worker", task: `Nested assignment ${selected ?? 0}`, exitCode: 0, finalOutput: "NESTED_NATIVE_RESULT", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 } };
	if (selected === undefined) saveAsyncRunResult(runId, { runtimeVersion: 2, id: runId, state: "complete", success: true, timestamp: Date.now(), results: [{ ...childResult, success: true }] });
	else saveQuestionContract(runId, selected, { result: childResult });
	const result = await recovery;
	assert.equal(result?.details.wait?.status, "completed");
	assert.match(result!.content[0].text, /NESTED_NATIVE_RESULT/);
	assert.equal(result!.details.run.ownerSessionId, childOwner.getSessionId(), "read-only projection retains the actual direct parent");
	assert.equal(result!.details.wait.index, selected);
	assert.equal(result!.details.results.length, 1);
	assert.equal((await f.wait(runId, selected))?.details.wait?.status, "completed");
	assert.equal(delivered, 1); assert.equal(f.mock.callCount(), 0);
	assert.deepEqual([...f.state.ownedRuns.keys()], [rootId]);
	f.state.ownedRuns.clear();
	assert.equal((await f.wait(runId, selected)).isError, true, "saved work cannot bypass current route authorization");
});


test("obsolete saved native-call metadata cannot suppress durable completion notifications", async (t) => {
	const f = setup(t), runId = randomUUID(), dir = getRunMetadataDir(runId);
	f.manager.appendCustomEntry("subagent-invocation", { toolCallId: "pending-native", ownerSessionId: f.manager.getSessionId(), runId, kind: "launch" });
	rememberOwnedRun(f.state, { runId, rootRunId: runId, ownerSessionId: f.manager.getSessionId(), source: "async", mode: "single", cwd: f.cwd,
		task: "Saved result", startedAt: 1, asyncDir: dir, children: [{ agent: "worker", index: 0 }] });
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify({ runtimeVersion: 2, id: runId, sessionId: f.manager.getSessionFile(), state: "complete", success: true, timestamp: 2,
		results: [{ agent: "worker", success: true, exitCode: 0, output: "Original call owns this result" }] }));
	f.state.currentSessionId = f.manager.getSessionFile();
	const completions = [];
	f.bus.on("subagent:async-complete", (event) => completions.push(event));
	const pi = { ...f.pi, on() {}, sendMessage() {} };
	const completion = createCompletionDelivery(pi, f.state, registerParentUsage(pi));
	try {
		completion.start();
		await until(() => completions.length > 0, "canonical result discovered despite obsolete pending-call metadata");
		assert.ok(completions.every((event) => !event.suppressNotification));
		assert.equal(fs.existsSync(path.join(dir, "result.json")), true);
	} finally { completion.stop(); }
});
