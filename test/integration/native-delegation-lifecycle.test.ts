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
const { bindNativeInvocation, isNativeAsyncCall, nativeInvocationTarget, nativeInvocations } = await import("../../src/runs/shared/native-async.ts");
const { rememberOwnedRun, restoreOwnedRuns } = await import("../../src/runs/shared/run-records.ts");
const { getRunMetadataDir, createSupervisorQuestion, saveQuestionOwner, saveQuestionAnswer, recordQuestionDelivery, saveRunStatus, saveAsyncRunResult, saveQuestionContract } = await import("../../src/runs/shared/supervisor-questions.ts");
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
	const pending = new Set<string>();
	const ctx = { ...makeMinimalCtx(cwd), sessionManager: manager,
		model: { provider: "fixture", id: "parent", compat: { supportsAsyncTools: true } },
		getPendingToolCalls: () => [...pending].map((toolCallId) => ({ toolCallId, toolName: "delegate", state: "started" })),
	};
	const bus = createEventBus();
	const pi = { events: bus, getSessionName: () => "native-parent", appendEntry: (type, data) => {
		if (type === "subagent-invocation" && data.kind === "launch") assert.equal(fs.existsSync(path.join(getRunMetadataDir(data.runId), "launch.json")), false, "call identity must be journaled before launch");
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
	return { cwd, manager, pending, ctx, bus, pi, state, executor, mock,
		invoke: (id, params, signal?) => executor.execute(id, params, signal, undefined, ctx),
		legacyInvoke: async (id, params, signal?) => {
			const receipt = await executor.execute(id, { ...params, async: true }, undefined, undefined, ctx);
			// Seed an old unresolved call, then exercise only the production recovery path.
			bindNativeInvocation({ appendEntry: (type, data) => manager.appendCustomEntry(type, data) }, ctx, id,
				{ runId: receipt.details.asyncId, kind: "launch", includeProgress: params.includeProgress });
			return executor.resume(id, {}, signal, undefined, ctx);
		} };
}

test("native async requires both the host obligation and model route capability", (t) => {
	const f = setup(t);
	f.pending.add("call");
	assert.equal(isNativeAsyncCall(f.ctx, "call"), true);
	assert.equal(isNativeAsyncCall({ ...f.ctx, getPendingToolCalls: undefined }, "call"), false);
	assert.equal(isNativeAsyncCall({ ...f.ctx, model: { compat: {} } }, "call"), false);
	assert.equal(isNativeAsyncCall(f.ctx, "ordinary-receipt"), false);
});

for (const background of [undefined, true, false]) test(`native background launch returns a receipt before completion (${background === false ? "forced" : background})`, async (t) => {
	const f = setup(t, { forceTopLevelAsync: background === false }); f.pending.add("native-receipt");
	f.mock.onCall({ delay: 700, output: "APPENDED_COMPLETION" });
	const receipt = await f.invoke("native-receipt", { agent: "worker", task: "Do bounded work", async: background });
	const runId = receipt.details.asyncId;
	assert.ok(runId);
	assert.equal(receipt.details.wait, undefined);
	assert.deepEqual(nativeInvocations(f.ctx), [], "a receipt must not reserve completion for the original call");
	assert.equal(fs.existsSync(path.join(getRunMetadataDir(runId), "result.json")), false, "receipt precedes completion");
	const notices = [];
	const { default: registerNotify } = await import("../../src/runs/background/notify.ts");
	registerNotify({ ...f.pi, sendMessage: (message, options) => notices.push({ message, options }) });
	const watcher = createResultWatcher(f.pi, f.state, RESULTS_DIR, 60_000);
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

for (const action of ["resume", "answer"]) for (const background of [undefined, true]) test(`native ${action} returns its receipt without waiting (${background})`, async (t) => {
	const f = setup(t);
	f.mock.onCall({ delay: 900, output: "LATER_RESULT" });
	const launch = await f.invoke("launch", { agent: "worker", task: "Keep working" });
	const runId = launch.details.asyncId;
	await until(() => f.mock.callCount() === 1, "child starts");
	f.pending.add("control");
	f.bus.on(SUBAGENT_LIVE_INTERCOM_EVENT, (request) => {
		f.bus.emit(SUBAGENT_LIVE_INTERCOM_DELIVERY_EVENT, { requestId: request.requestId, delivered: true });
	});
	const question = action === "answer" ? createSupervisorQuestion({ runId, ownerTarget: "parent", agent: "worker", index: 0,
		childSessionId: "child", childTarget: "child", sessionFile: path.join(f.cwd, "child.jsonl"), cwd: f.cwd,
		pid: process.pid, reason: "need_decision", message: "Proceed?" }) : undefined;
	const receipt = await f.invoke("control", { action, id: runId, message: "Proceed", async: background, questionId: question?.questionId });
	assert.notEqual(receipt.isError, true);
	assert.equal(receipt.details.wait, undefined);
	assert.deepEqual(nativeInvocations(f.ctx), []);
	assert.equal(fs.existsSync(path.join(getRunMetadataDir(runId), "result.json")), false, "control returns while the child is still running");
	if (question) assert.equal(receipt.details.questions[0].answer.message, "Proceed");
	else assert.equal(receipt.details.managementControl.runId, runId);
});

for (const foreground of [false, undefined]) test(`native foreground delegation waits for the actual result (${foreground === false ? "explicit" : "configured"})`, async (t) => {
	const f = setup(t, {}, false); f.pending.add("native-launch");
	f.mock.onCall({ delay: 350, output: "ORIGINAL_CALL_RESULT" });
	let finished = false;
	const resultPromise = f.invoke("native-launch", { agent: "worker", task: "Do bounded work", async: foreground }).then((result) => { finished = true; return result; });
	await until(() => f.mock.callCount() === 1, "native child starts");
	assert.equal(finished, false, "a launch receipt cannot settle a native async call");
	const call = nativeInvocations(f.ctx)[0];
	assert.equal(call.toolCallId, "native-launch");
	assert.ok(f.state.ownedRuns.has(call.runId), "list can expose the run handle while the original call is pending");
	const result = await resultPromise;
	assert.equal(result.pending, undefined);
	assert.equal(result.details.wait.status, "completed");
	assert.equal(result.details.wait.runId, call.runId);
	assert.match(result.content[0].text, /ORIGINAL_CALL_RESULT/);
	assert.equal(f.mock.callCount(), 1);
});

test("abort detaches legacy native background work; recovery follows the durable binding without relaunch", async (t) => {
	const f = setup(t); f.pending.add("native-recovery");
	f.mock.onCall({ delay: 450, output: "AFTER_REATTACH" });
	const abort = new AbortController();
	const pending = f.legacyInvoke("native-recovery", { agent: "worker", task: "Keep running", includeProgress: true }, abort.signal);
	await until(() => f.mock.callCount() === 1, "native child starts");
	const call = nativeInvocations(f.ctx)[0];
	abort.abort();
	const detached = await pending;
	assert.equal(detached.pending, true);
	assert.equal(detached.usage, undefined);
	assert.equal(fs.existsSync(path.join(getRunMetadataDir(call.runId), "control-requests")), false, "background detach must not stop the owner");
	f.state.ownedRuns.clear();
	restoreOwnedRuns(f.state, f.ctx);
	const result = await f.executor.resume("native-recovery", {}, undefined, undefined, f.ctx);
	assert.equal(result.details.wait.status, "completed");
	assert.match(result.content[0].text, /AFTER_REATTACH/);
	assert.equal(result.details.progress?.[0]?.status, "complete", "native recovery must retain the original call's progress opt-in");
	assert.equal(result.details.progress?.[0]?.task, "Keep running");
	assert.equal(f.mock.callCount(), 1);
	assert.equal(await f.executor.resume("unbound-call", { agent: "worker", task: "Must not launch" }, undefined, undefined, f.ctx), undefined);
	assert.equal(f.mock.callCount(), 1);
});

test("Intercom attention keeps the original native result pending while the child runs", async (t) => {
	const f = setup(t); f.pending.add("native-steer");
	f.mock.onCall({ delay: 350, output: "AFTER_STEER" });
	let finished = false, accepted = false;
	const promise = f.legacyInvoke("native-steer", { agent: "worker", task: "Finish" }).then((result) => { finished = true; return result; });
	await until(() => f.mock.callCount() === 1, "native child starts");
	f.bus.on(INTERCOM_DETACH_RESPONSE_EVENT, (response) => { accepted = response.accepted; });
	f.bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "attention", reason: "attention" });
	await delay(20);
	assert.equal(accepted, true);
	assert.equal(finished, false, "attention is not a final native tool result");
	assert.match((await promise).content[0].text, /AFTER_STEER/);
});

for (const includeProgress of [true, undefined]) test(`native live continuation journals delivery and restores its own progress opt-in (${includeProgress})`, async (t) => {
	const f = setup(t);
	f.mock.onCall({ delay: 650, output: "LIVE_CONTINUATION_RESULT" });
	const receipt = await f.invoke("portable-launch", { agent: "worker", task: "Wait for guidance", includeProgress: !includeProgress });
	const runId = receipt.details.asyncId;
	await until(() => f.mock.callCount() === 1, "portable child starts");
	f.pending.add("native-continue");
	let deliveries = 0;
	f.bus.on(SUBAGENT_LIVE_INTERCOM_EVENT, (request) => {
		deliveries++;
		const saved = nativeInvocations(f.ctx).find((call) => call.toolCallId === "native-continue");
		assert.equal(saved.runId, runId);
		assert.equal(saved.accepted, undefined, "delivery intent precedes the effect");
		f.bus.emit(SUBAGENT_LIVE_INTERCOM_DELIVERY_EVENT, { requestId: request.requestId, delivered: true });
	});
	const result = await f.invoke("native-continue", { action: "resume", id: runId, message: "Use this guidance", includeProgress, async: false });
	assert.equal(result.details.wait.status, "completed");
	assert.match(result.content[0].text, /LIVE_CONTINUATION_RESULT/);
	assert.equal(result.details.progress?.[0]?.status, includeProgress ? "complete" : undefined, "the waiting continuation opts in independently of the original launch");
	const recovered = await f.executor.resume("native-continue", {}, undefined, undefined, f.ctx);
	assert.deepEqual(recovered.details.progress, result.details.progress);
	assert.equal(deliveries, 1);
	assert.equal(f.mock.callCount(), 1);
	bindNativeInvocation(f.pi, f.ctx, "unconfirmed-delivery", { runId, index: 0, kind: "delivery" });
	assert.equal(await f.executor.resume("unconfirmed-delivery", {}, undefined, undefined, f.ctx), undefined);
	assert.equal(deliveries, 1);
});

for (const selected of [undefined, 1]) test(`native nested continuation ${selected === undefined ? "whole-run" : "selected-child"} waits and recovers without adoption or redelivery`, async (t) => {
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
	f.pending.add(callId);
	let delivered = 0, bindingBeforeDelivery;
	const reply = setInterval(() => {
		const request = readNestedControlRequests(route)[0];
		if (!request || delivered) return;
		delivered++;
		bindingBeforeDelivery = nativeInvocations(f.ctx).find((call) => call.toolCallId === callId);
		writeNestedControlResult(route, { ts: Date.now(), requestId: request.requestId, targetRunId: runId, ok: true, message: "Guidance accepted" });
	}, 10);
	const abort = new AbortController();
	let settled = false;
	const pending = f.invoke(callId, { action: "resume", id: runId.slice(0, 12), async: false, ...(selected === undefined ? {} : { index: selected }), message: "Continue the authorized work" }, abort.signal).then((result) => { settled = true; return result; });
	t.after(async () => { clearInterval(reply); abort.abort(); await pending; });
	await until(() => delivered === 1, "nested owner receives guidance");
	await delay(120);
	assert.equal(settled, false, "accepted nested guidance must remain pending for the actual native result");
	assert.equal(bindingBeforeDelivery?.runId, runId);
	assert.equal(bindingBeforeDelivery?.accepted, undefined, "journal intent before delivery");
	assert.equal(nativeInvocations(f.ctx).find((call) => call.toolCallId === callId)?.accepted, true);
	assert.equal(readNestedControlRequests(route)[0]?.index, selected);
	abort.abort();
	assert.equal((await pending).pending, true);
	assert.equal(fs.existsSync(path.join(asyncDir, "control-requests")), false, "detaching a continuation never cancels the descendant");
	assert.deepEqual([...f.state.ownedRuns.keys()], [rootId]);
	assert.equal(f.state.asyncJobs.size, 0);
	let recovered = false;
	const recovery = f.executor.resume(callId, {}, undefined, undefined, f.ctx).then((result) => { recovered = true; return result; });
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
	assert.equal((await f.executor.resume(callId, {}, undefined, undefined, f.ctx))?.details.wait?.status, "completed");
	assert.equal(delivered, 1); assert.equal(f.mock.callCount(), 0);
	assert.deepEqual([...f.state.ownedRuns.keys()], [rootId]);
	f.state.ownedRuns.clear();
	assert.equal(await f.executor.resume(callId, {}, undefined, undefined, f.ctx), undefined, "an old binding cannot bypass current route authorization");
});

test("answer recovery uses immutable answer and revival evidence, with no extra delivery", (t) => {
	const f = setup(t), runId = randomUUID();
	saveQuestionOwner(runId, f.manager.getSessionId());
	const question = createSupervisorQuestion({ runId, ownerTarget: "parent", agent: "worker", index: 0,
		childSessionId: "child", childTarget: "child", sessionFile: path.join(f.cwd, "child.jsonl"), cwd: f.cwd,
		pid: process.pid, reason: "need_decision", message: "Which option?" });
	bindNativeInvocation(f.pi, f.ctx, "answer-call", { runId, index: 0, kind: "answer", questionId: question.questionId, answer: "Proceed" });
	const call = nativeInvocations(f.ctx)[0];
	assert.equal(nativeInvocationTarget(f.ctx, call), undefined);
	saveQuestionAnswer(question, "Proceed");
	assert.deepEqual(nativeInvocationTarget(f.ctx, call), { runId, index: 0 });
	const successor = randomUUID();
	recordQuestionDelivery(question, { kind: "revive", runId: successor, deliveredAt: Date.now() });
	assert.deepEqual(nativeInvocationTarget(f.ctx, call), { runId: successor, index: 0 });
	assert.throws(() => bindNativeInvocation(f.pi, f.ctx, "answer-call", { runId: successor, kind: "launch" }), /cannot be rebound/);
});

test("a detached native result owner suppresses ordinary completion notifications", async (t) => {
	const f = setup(t), runId = randomUUID(), dir = getRunMetadataDir(runId);
	bindNativeInvocation(f.pi, f.ctx, "pending-native", { runId, kind: "launch" });
	rememberOwnedRun(f.state, { runId, rootRunId: runId, ownerSessionId: f.manager.getSessionId(), source: "async", mode: "single", cwd: f.cwd,
		task: "Saved result", startedAt: 1, asyncDir: dir, children: [{ agent: "worker", index: 0 }] });
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify({ runtimeVersion: 2, id: runId, sessionId: f.manager.getSessionFile(), state: "complete", success: true, timestamp: 2,
		results: [{ agent: "worker", success: true, exitCode: 0, output: "Original call owns this result" }] }));
	f.state.currentSessionId = f.manager.getSessionFile();
	f.state.hasNativeResultOwner = (id) => nativeInvocations(f.ctx).some((call) => nativeInvocationTarget(f.ctx, call)?.runId === id);
	const completions = [];
	f.bus.on("subagent:async-complete", (event) => completions.push(event));
	const watcher = createResultWatcher(f.pi, f.state, RESULTS_DIR, 60_000);
	try {
		watcher.primeExistingResults();
		await until(() => completions.length > 0, "canonical result discovered after detach");
		assert.ok(completions.every((event) => event.suppressNotification));
		assert.equal(f.state.ownedRuns.get(runId).delivery, undefined);
		assert.equal(fs.existsSync(path.join(dir, "result.json")), true);
	} finally { watcher.stopResultWatcher(); }
});
