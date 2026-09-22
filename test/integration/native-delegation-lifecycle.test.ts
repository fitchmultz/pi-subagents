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
const { getRunMetadataDir, createSupervisorQuestion, saveQuestionOwner, saveQuestionAnswer, recordQuestionDelivery } = await import("../../src/runs/shared/supervisor-questions.ts");
const { createResultWatcher } = await import("../../src/runs/background/result-watcher.ts");
const { INTERCOM_DETACH_REQUEST_EVENT, INTERCOM_DETACH_RESPONSE_EVENT, SUBAGENT_LIVE_INTERCOM_EVENT, SUBAGENT_LIVE_INTERCOM_DELIVERY_EVENT, RESULTS_DIR } = await import("../../src/shared/types.ts");
after(() => fs.rmSync(root, { recursive: true, force: true }));

async function until(check, message) {
	const deadline = Date.now() + 10_000;
	while (!check()) { assert.ok(Date.now() < deadline, message); await delay(20); }
}

function setup(t) {
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
	const state = { baseCwd: cwd, currentSessionId: null, ownedRuns: new Map(), foregroundRuns: new Map(), foregroundControls: new Map(), asyncJobs: new Map(),
		cleanupTimers: new Map(), completionSeen: new Map(), lastForegroundControlId: null, lastUiContext: ctx,
		persistOwnedRun: (run) => manager.appendCustomEntry("subagent-run", run), resultFileCoalescer: { schedule: () => false, clear() {} } };
	const executor = createSubagentExecutor({ pi, state, config: {}, asyncByDefault: true, tempArtifactsDir: cwd,
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
		invoke: (id, params, signal?) => executor.execute(id, params, signal, undefined, ctx) };
}

test("native async requires both the host obligation and model route capability", (t) => {
	const f = setup(t);
	f.pending.add("call");
	assert.equal(isNativeAsyncCall(f.ctx, "call"), true);
	assert.equal(isNativeAsyncCall({ ...f.ctx, getPendingToolCalls: undefined }, "call"), false);
	assert.equal(isNativeAsyncCall({ ...f.ctx, model: { compat: {} } }, "call"), false);
	assert.equal(isNativeAsyncCall(f.ctx, "ordinary-receipt"), false);
});

test("native background delegation returns the actual result on its original call", async (t) => {
	const f = setup(t); f.pending.add("native-launch");
	f.mock.onCall({ delay: 350, output: "ORIGINAL_CALL_RESULT" });
	let finished = false;
	const resultPromise = f.invoke("native-launch", { agent: "worker", task: "Do bounded work" }).then((result) => { finished = true; return result; });
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

test("abort detaches native background work; recovery follows the durable binding without relaunch", async (t) => {
	const f = setup(t); f.pending.add("native-recovery");
	f.mock.onCall({ delay: 450, output: "AFTER_REATTACH" });
	const abort = new AbortController();
	const pending = f.invoke("native-recovery", { agent: "worker", task: "Keep running" }, abort.signal);
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
	assert.equal(f.mock.callCount(), 1);
	assert.equal(await f.executor.resume("unbound-call", { agent: "worker", task: "Must not launch" }, undefined, undefined, f.ctx), undefined);
	assert.equal(f.mock.callCount(), 1);
});

test("Intercom attention keeps the original native result pending while the child runs", async (t) => {
	const f = setup(t); f.pending.add("native-steer");
	f.mock.onCall({ delay: 350, output: "AFTER_STEER" });
	let finished = false, accepted = false;
	const promise = f.invoke("native-steer", { agent: "worker", task: "Finish" }).then((result) => { finished = true; return result; });
	await until(() => f.mock.callCount() === 1, "native child starts");
	f.bus.on(INTERCOM_DETACH_RESPONSE_EVENT, (response) => { accepted = response.accepted; });
	f.bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "attention", reason: "attention" });
	await delay(20);
	assert.equal(accepted, true);
	assert.equal(finished, false, "attention is not a final native tool result");
	assert.match((await promise).content[0].text, /AFTER_STEER/);
});

test("native live continuation journals delivery before sending and never repeats it on recovery", async (t) => {
	const f = setup(t);
	f.mock.onCall({ delay: 650, output: "LIVE_CONTINUATION_RESULT" });
	const receipt = await f.invoke("portable-launch", { agent: "worker", task: "Wait for guidance" });
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
	const result = await f.invoke("native-continue", { action: "resume", id: runId, message: "Use this guidance" });
	assert.equal(result.details.wait.status, "completed");
	assert.match(result.content[0].text, /LIVE_CONTINUATION_RESULT/);
	await f.executor.resume("native-continue", {}, undefined, undefined, f.ctx);
	assert.equal(deliveries, 1);
	assert.equal(f.mock.callCount(), 1);
	bindNativeInvocation(f.pi, f.ctx, "unconfirmed-delivery", { runId, index: 0, kind: "delivery" });
	assert.equal(await f.executor.resume("unconfirmed-delivery", {}, undefined, undefined, f.ctx), undefined);
	assert.equal(deliveries, 1);
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
