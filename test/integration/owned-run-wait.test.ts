import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createEventBus, createMockPi, createTempDir, events, makeAgent, makeMinimalCtx } from "../support/helpers.ts";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { createAsyncJobTracker } from "../../src/runs/background/async-job-tracker.ts";
import { ownedRunView, saveForegroundRun } from "../../src/runs/shared/run-records.ts";
import { interruptAsyncRun } from "../../src/runs/foreground/foreground-control.ts";
import { createNestedRoute } from "../../src/runs/shared/nested-events.ts";
import { createSupervisorQuestion, getRunMetadataDir, readQuestionState, recordQuestionDelivery, saveQuestionContract, saveQuestionOwner } from "../../src/runs/shared/supervisor-questions.ts";
import { ASYNC_DIR, INTERCOM_DETACH_REQUEST_EVENT, type OwnedRun, type SubagentState } from "../../src/shared/types.ts";

async function until(check: () => boolean, reason: string) { const end = Date.now() + 10_000; while (!check()) { assert.ok(Date.now() < end, reason); await delay(20); } }
function setup(t, allowLaunch = false) {
	const cwd = createTempDir("wait-owned-"), runId = randomUUID(), sessionFile = path.join(cwd, "session.jsonl");
	fs.writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: randomUUID(), cwd, timestamp: new Date().toISOString() }) + "\n");
	const agent = makeAgent("worker", { model: "fixture/original", completionGuard: false });
	const run: OwnedRun = { runId, rootRunId: runId, ownerSessionId: "session-123", source: "foreground", mode: "single", cwd, task: "Original task", startedAt: 1, children: [{ agent: "worker", index: 0, sessionFile }] };
	const state = { baseCwd: cwd, currentSessionId: "session-123", ownedRuns: new Map([[runId, run]]), foregroundRuns: new Map(), foregroundControls: new Map(), asyncJobs: new Map(), cleanupTimers: new Map(), completionSeen: new Map(), lastForegroundControlId: null, lastUiContext: null } as SubagentState;
	saveForegroundRun({ ...run, results: [{ agent: "worker", task: run.task, exitCode: 0, sessionFile, finalOutput: "Previous result", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 } }] });
	saveQuestionOwner(runId, run.ownerSessionId);
	saveQuestionContract(runId, 0, { sessionFile, launch: { agent, systemPrompt: "Saved exact launch", skills: [], model: "fixture/original", modelCandidates: ["fixture/original"], cwd, context: "fresh", artifacts: false, output: false, outputMode: "inline", share: false } });
	const events = createEventBus(), pi = { events, getSessionName: () => "wait-parent" };
	const tracker = createAsyncJobTracker(pi, state, ASYNC_DIR);
	events.on("subagent:async-started", tracker.handleStarted);
	const executor = createSubagentExecutor({ pi, state, config: {}, asyncByDefault: true, tempArtifactsDir: cwd, getSubagentSessionRoot: () => cwd, expandTilde: (value) => value, discoverAgents: () => { if (allowLaunch) return { agents: [agent] }; throw new Error("Saved continuation must not rediscover current profiles"); } });
	const mock = createMockPi(); mock.install();
	t.after(() => { if (state.poller) clearInterval(state.poller); for (const timer of state.cleanupTimers.values()) clearTimeout(timer); mock.uninstall(); });
	return { cwd, runId, state, events, mock, invoke: (params, signal?, update?) => executor.execute(randomUUID(), params, signal, update, makeMinimalCtx(cwd)) };
}

test("continue async:false waits for the new saved-launch result, not the original completed handle", async (t) => {
	const f = setup(t);
	f.mock.onCall({ output: "ACTUAL-CONTINUATION-RESULT", delay: 250 });
	let returned = false;
	const pending = f.invoke({ action: "resume", id: f.runId, message: "Continue with saved choices", async: false }).then((result) => { returned = true; return result; });
	await delay(40); assert.equal(returned, false);
	const result = await pending;
	assert.equal(result.details.wait?.status, "completed", result.content[0]?.text);
	assert.notEqual(result.details.wait?.runId, f.runId);
	assert.match(result.content[0]!.text, /ACTUAL-CONTINUATION-RESULT/);
	assert.equal(result.details.run?.children[0]?.launch?.systemPrompt, "Saved exact launch");
	assert.equal(f.mock.callCount(), 1);
});

for (const exit of ["cancel", "attention"] as const) test(`explicit wait ${exit} detaches only the waiter; re-wait collects the same child's result`, async (t) => {
	const f = setup(t);
	f.mock.onCall({ output: "CHILD-CONTINUED", delay: 600 });
	const started = await f.invoke({ action: "resume", id: f.runId, message: "Continue", async: true });
	const id = started.details.asyncId!, controller = new AbortController();
	const pending = f.invoke({ action: "wait", id }, controller.signal);
	await delay(50);
	if (exit === "cancel") controller.abort(); else f.events.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: randomUUID(), reason: "attention" });
	const detached = await pending;
	assert.equal(detached.details.wait?.status, exit === "cancel" ? "cancelled" : "yielded");
	assert.equal(fs.existsSync(path.join(started.details.asyncDir!, "control-request.json")), false, "attaching wait cannot stop the child");
	const done = await f.invoke({ action: "wait", id });
	assert.match(done.content[0]!.text, /CHILD-CONTINUED/);
	assert.equal(done.details.wait?.runId, id);
	assert.equal(f.mock.callCount(), 1);
});

test("cancelling only a newly launched async:false continuation requests runner cancellation", async (t) => {
	const f = setup(t), controller = new AbortController();
	f.mock.onCall({ output: "Too late", delay: 10_000 });
	const updates = [];
	const pending = f.invoke({ action: "resume", id: f.runId, message: "New work", async: false }, controller.signal, (result) => updates.push(result.content[0]?.text));
	await until(() => f.mock.callCount() > 0, "new child must start");
	const successor = [...f.state.ownedRuns!.values()].find((run) => run.runId !== f.runId)!;
	controller.abort();
	const receipt = await pending;
	assert.equal(receipt.details.wait?.status, "cancelled");
	assert.match(receipt.content[0]!.text, /newly launched/);
	assert.ok(updates.some((text) => /Cancelling requests cancellation of this newly launched run/.test(text)));
	assert.ok(updates.every((text) => !/leaves existing work alive/.test(text)));
	const finalFile = path.join(getRunMetadataDir(successor.runId), "result.json");
	await until(() => fs.existsSync(finalFile), "cancelled continuation must settle");
	const final = JSON.parse(fs.readFileSync(finalFile, "utf8"));
	assert.equal(final.success, false);
	assert.match(final.results[0].error, /cancelled/i);
	assert.equal(f.state.ownedRuns!.size, 2, "launch lineage survives cancellation");
});

for (const background of [false, true]) test(`${background ? "background" : "foreground"} indexed wait reads a finished child before its sibling; selected stop still runs queued siblings`, async (t) => {
	const f = setup(t, true);
	f.mock.onCall({ matchArgsIncludes: "FIRST_CHILD", output: "FIRST_SAVED_RESULT" });
	f.mock.onCall({ matchArgsIncludes: "HELD_CHILD", steps: [{ jsonl: [events.toolStart("bash", { command: "held child work" })] }, { delay: 10_000, jsonl: [events.assistantMessage("Should be stopped")] }] });
	f.mock.onCall({ matchArgsIncludes: "QUEUED_CHILD", output: "QUEUED_SIBLING_COMPLETED" });
	const pending = f.invoke({ tasks: ["FIRST_CHILD", "HELD_CHILD", "QUEUED_CHILD"].map((task) => ({ agent: "worker", task, output: false })), concurrency: 1, async: background, artifacts: false }, undefined, () => {});
	await until(() => f.state.ownedRuns!.size === 2, "new owned workflow");
	const run = [...f.state.ownedRuns!.values()].find((run) => run.runId !== f.runId)!;
	try {
		await until(() => ownedRunView(run, f.state).children[1]?.activity?.currentTool === "bash", "second child must be running");
		const first = await f.invoke({ action: "wait", id: run.runId, index: 0 }, AbortSignal.timeout(3_000));
		assert.equal(first.details.wait?.status, "completed");
		assert.match(first.content[0]!.text, /FIRST_SAVED_RESULT/);
		assert.equal(first.details.run?.state, "live", "index wait does not await unrelated siblings");
		assert.equal(f.mock.callCount(), 2, "third child is still queued");
		const stopped = await f.invoke({ action: "interrupt", id: run.runId, index: 1 });
		assert.equal(stopped.isError, undefined, stopped.content[0]?.text);
		assert.match(stopped.content[0]!.text, /child 1 only/);
		await pending;
		const completed = await f.invoke({ action: "wait", id: run.runId }, AbortSignal.timeout(5_000));
		assert.equal(completed.details.wait?.status, "completed");
		assert.deepEqual(completed.details.run?.children.map((child) => child.state), ["completed", "paused", "completed"]);
		assert.match(completed.content[0]!.text, /QUEUED_SIBLING_COMPLETED/);
		assert.equal(f.mock.callCount(), 3);
	} finally {
		await f.invoke({ action: "interrupt", id: run.runId });
		await pending;
	}
});

for (const mode of ["single", "chain"] as const) test(`a nested foreground ${mode} human blocker remains blocked after acknowledged Intercom delivery`, async (t) => {
	const f = setup(t, true), route = createNestedRoute(randomUUID());
	const nestedEnv = { PI_SUBAGENT_PARENT_ROOT_RUN_ID: route.rootRunId, PI_SUBAGENT_PARENT_RUN_ID: route.rootRunId, PI_SUBAGENT_PARENT_CHILD_INDEX: "0", PI_SUBAGENT_PARENT_DEPTH: "1", PI_SUBAGENT_PARENT_EVENT_SINK: route.eventSink, PI_SUBAGENT_PARENT_CONTROL_INBOX: route.controlInbox, PI_SUBAGENT_PARENT_CAPABILITY_TOKEN: route.capabilityToken };
	const saved = Object.fromEntries(Object.keys(nestedEnv).map((key) => [key, process.env[key]]));
	Object.assign(process.env, nestedEnv);
	try {
		f.mock.onCall({ output: '```acceptance-report\n{"criteriaSatisfied":[{"id":"criterion-1","status":"blocked","evidence":"Touch ID prompt is visible","humanAction":"Complete Touch ID"}]}\n```' });
		f.events.on("subagent:result-intercom", (payload) => f.events.emit("subagent:result-intercom-delivery", { requestId: payload.requestId, delivered: true }));
		const task = { agent: "worker", task: "Verify authenticated flow", output: false, acceptance: { criteria: ["Verify sign-in"] } };
		const result = await f.invoke({ ...(mode === "single" ? task : { chain: [task, { agent: "worker", task: "Dependent step must not run", output: false }] }), async: false, artifacts: false });
		assert.equal(result.isError, undefined);
		const terminal = fs.readdirSync(route.eventSink).map((file) => JSON.parse(fs.readFileSync(path.join(route.eventSink, file), "utf8"))).filter((event) => event.type === "subagent.nested.completed" && event.child?.id === result.details.runId);
		assert.equal(terminal.length, 1);
		assert.equal(terminal[0].child.state, "blocked");
		assert.equal(terminal[0].child.steps[0].status, "blocked");
		assert.match(terminal[0].child.steps[0].error, /Complete Touch ID/);
		assert.match(terminal[0].child.error, /Complete Touch ID/);
		assert.equal(f.mock.callCount(), 1, "human-only blocker must not enter finalization");
	} finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});

for (const background of [false, true]) test(`${background ? "background" : "foreground"} Stop cancels an exited child's durable question without stopping its live sibling`, async (t) => {
	const f = setup(t), id = randomUUID(), exited = spawnSync(process.execPath, ["-e", ""]);
	assert.equal(exited.status, 0);
	saveQuestionOwner(id, "session-123");
	const question = createSupervisorQuestion({ runId: id, ownerTarget: "parent", agent: "worker", index: 0, childSessionId: "exited", childTarget: "child-a", sessionFile: path.join(f.cwd, "exited.jsonl"), cwd: f.cwd, pid: exited.pid, reason: "need_decision", message: "Should A proceed?" });
	let siblingStops = 0, controlPath;
	if (background) {
		const asyncDir = path.join(f.cwd, "question-group"); fs.mkdirSync(asyncDir);
		const status = { runId: id, mode: "parallel", state: "running", startedAt: 1, indexedControl: false, steps: [{ agent: "worker", status: "failed" }, { agent: "worker", status: "running" }] };
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(status));
		f.state.asyncJobs.set(id, { asyncId: id, asyncDir, status: "running" }); controlPath = path.join(asyncDir, "control-request.json");
		assert.equal((await f.invoke({ action: "interrupt", id, index: 0 })).isError, true, "an unrelated unsupported-control error is retained");
		assert.equal(readQuestionState(question).state, "awaiting_input");
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ ...status, indexedControl: true }));
	} else f.state.foregroundControls.set(id, { runId: id, mode: "parallel", startedAt: 1, updatedAt: 1, currentAgent: "worker", currentIndex: 1, interrupt: () => { siblingStops++; return true; }, activeChildren: new Map([[1, { agent: "worker", interrupt: () => { siblingStops++; return true; } }]]) });
	const result = await f.invoke({ action: "interrupt", id, index: 0 });
	assert.equal(result.isError, undefined, result.content[0]?.text);
	assert.equal(readQuestionState(question).state, "cancelled");
	assert.equal(siblingStops, 0);
	if (controlPath) assert.equal(fs.existsSync(controlPath), false, "no sibling control request was sent");
});

test("answer async:false derives the answered question's child index rather than waiting on a sibling", async (t) => {
	const f = setup(t), id = randomUUID(), run = { ...f.state.ownedRuns!.get(f.runId)!, runId: id, rootRunId: id, mode: "parallel", children: [{ agent: "worker", index: 0 }, { agent: "worker", index: 1 }] };
	f.state.ownedRuns!.set(id, run);
	f.state.foregroundControls.set(id, { runId: id, mode: "parallel", startedAt: 1, updatedAt: 1, currentAgent: "worker", currentIndex: 0, activeChildren: new Map([[0, { agent: "worker" }], [1, { agent: "worker" }]]) });
	saveQuestionOwner(id, "session-123");
	const questions = run.children.map((child) => createSupervisorQuestion({ runId: id, ownerTarget: "parent", agent: child.agent, index: child.index, childSessionId: `child-${child.index}`, childTarget: `child-${child.index}`, sessionFile: path.join(f.cwd, `${child.index}.jsonl`), cwd: f.cwd, pid: process.pid, reason: "need_decision", message: `Choose for ${child.index}` }));
	const pending = f.invoke({ action: "answer", id, questionId: questions[0].questionId, message: "Proceed A", async: false }, AbortSignal.timeout(2_000));
	await delay(20);
	recordQuestionDelivery(questions[0], { kind: "live", runId: id, deliveredAt: Date.now() });
	saveQuestionContract(id, 0, { result: { agent: "worker", task: "A", exitCode: 0, finalOutput: "A_AFTER_ANSWER", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 } } });
	const result = await pending;
	assert.equal(result.details.wait?.index, 0);
	assert.equal(result.details.wait?.status, "completed");
	assert.match(result.content[0]!.text, /A_AFTER_ANSWER/);
	assert.equal(readQuestionState(questions[1]).state, "awaiting_input");
});

test("an older multi-child runner cannot receive an index it would ignore", (t) => {
	const f = setup(t), id = randomUUID(), asyncDir = path.join(f.cwd, "old-runner");
	fs.mkdirSync(asyncDir);
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ runId: id, mode: "parallel", state: "running", startedAt: 1, pid: process.pid, steps: [{ agent: "worker", status: "running" }, { agent: "worker", status: "running" }] }));
	f.state.asyncJobs.set(id, { asyncId: id, asyncDir, status: "running" });
	const result = interruptAsyncRun(f.state, id, 0);
	assert.equal(result?.isError, true);
	assert.match(result!.content[0]!.text, /older runner.*selected-child stop/);
	assert.equal(fs.existsSync(path.join(asyncDir, "control-request.json")), false);
});

test("terminal status before durable publication cannot masquerade as a final wait result", async (t) => {
	const f = setup(t), id = randomUUID(), asyncDir = path.join(f.cwd, "write-gap");
	fs.mkdirSync(asyncDir);
	const original = f.state.ownedRuns!.get(f.runId)!;
	f.state.ownedRuns!.set(id, { ...original, runId: id, rootRunId: id, source: "async", asyncDir, pid: process.pid });
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ runId: id, mode: "single", state: "complete", startedAt: 1, pid: process.pid, steps: [{ agent: "worker", status: "complete" }] }));
	let returned = false;
	const pending = f.invoke({ action: "wait", id }).then((result) => { returned = true; return result; });
	await delay(160); assert.equal(returned, false);
	fs.mkdirSync(getRunMetadataDir(id), { recursive: true });
	fs.writeFileSync(path.join(getRunMetadataDir(id), "result.json"), JSON.stringify({ id, mode: "single", success: true, state: "complete", results: [{ agent: "worker", output: "DURABLE-AFTER-GAP", exitCode: 0, success: true }] }));
	assert.match((await pending).content[0]!.text, /DURABLE-AFTER-GAP/);
});
