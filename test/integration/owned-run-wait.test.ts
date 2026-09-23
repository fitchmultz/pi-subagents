import assert from "node:assert/strict";
import fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { findPackageJSON, syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createEventBus, createMockPi, createTempDir, events, makeAgent, makeMinimalCtx } from "../support/helpers.ts";
import { waitForOwnedRun } from "../../src/runs/foreground/wait-run.ts";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { createAsyncJobTracker } from "../../src/runs/background/async-job-tracker.ts";
import { ownedRunView, saveForegroundRun } from "../../src/runs/shared/run-records.ts";
import { interruptAsyncRun } from "../../src/runs/foreground/foreground-control.ts";
import { createNestedRoute } from "../../src/runs/shared/nested-events.ts";
import { createSupervisorQuestion, getRunMetadataDir, readQuestionState, recordQuestionDelivery, saveAsyncRunResult, saveRunStatus, saveQuestionContract, saveQuestionOwner } from "../../src/runs/shared/supervisor-questions.ts";
import { ASYNC_DIR, INTERCOM_DETACH_REQUEST_EVENT, POLL_INTERVAL_MS, type OwnedRun, type SubagentState } from "../../src/shared/types.ts";

async function until(check: () => boolean, reason: string) { const end = Date.now() + 10_000; while (!check()) { assert.ok(Date.now() < end, reason); await delay(20); } }
function setup(t, allowLaunch = false) {
	const cwd = createTempDir("wait-owned-"), runId = randomUUID(), sessionFile = path.join(cwd, "session.jsonl");
	fs.writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: randomUUID(), cwd, timestamp: new Date().toISOString() }) + "\n");
	const agent = makeAgent("worker", { model: "fixture/original", completionGuard: false });
	const run: OwnedRun = { runId, rootRunId: runId, ownerSessionId: "session-123", source: "foreground", mode: "single", cwd, task: "Original task", startedAt: 1, children: [{ agent: "worker", index: 0, sessionFile }] };
	const state = { baseCwd: cwd, currentSessionId: "session-123", ownedRuns: new Map([[runId, run]]), foregroundRuns: new Map(), asyncJobs: new Map(), cleanupTimers: new Map(), completionSeen: new Map(), lastUiContext: null } as SubagentState;
	saveForegroundRun({ ...run, results: [{ agent: "worker", task: run.task, exitCode: 0, sessionFile, finalOutput: "Previous result", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 } }] });
	saveQuestionOwner(runId, run.ownerSessionId);
	saveQuestionContract(runId, 0, { sessionFile, launch: { agent, systemPrompt: "Saved exact launch", skills: [], model: "fixture/original", modelCandidates: ["fixture/original"], cwd, context: "fresh", artifacts: false, output: false, outputMode: "inline", share: false } });
	const events = createEventBus(), pi = { events, getSessionName: () => "wait-parent" };
	const tracker = createAsyncJobTracker(pi, state, ASYNC_DIR);
	events.on("subagent:async-started", tracker.handleStarted);
	const deps = { pi, state, config: {}, asyncByDefault: true, tempArtifactsDir: cwd, getSubagentSessionRoot: () => cwd, expandTilde: (value) => value, discoverAgents: () => { if (allowLaunch) return { agents: [agent] }; throw new Error("Saved continuation must not rediscover current profiles"); } };
	const executor = createSubagentExecutor(deps);
	const mock = createMockPi(); mock.install();
	t.after(() => { if (state.poller) clearInterval(state.poller); for (const timer of state.cleanupTimers.values()) clearTimeout(timer); mock.uninstall(); });
	return { cwd, runId, state, events, mock, deps, invoke: (params, signal?, update?) => executor.execute(randomUUID(), params, signal, update, makeMinimalCtx(cwd)) };
}

for (const outcome of ["completed", "cancelled", "yielded", "unavailable", "background"]) test(`owned-run liveness without a host reference: ${outcome}`, () => {
	const cwd = createTempDir("wait-liveness-");
	const child = spawnSync(process.execPath, [fileURLToPath(new URL("../fixtures/owned-run-wait-liveness.mjs", import.meta.url)), cwd, outcome], {
		encoding: "utf8", timeout: 10_000,
	});
	assert.equal(child.status, 0, child.stderr || child.error?.message || `Process exited before ${outcome} settled`);
	if (outcome !== "background") assert.equal(child.stdout.trim(), outcome);
});

test("removed wait action is rejected without starting or attaching to work", async (t) => {
	const f = setup(t);
	const result = await f.invoke({ action: "wait", id: f.runId });
	assert.equal(result.isError, true);
	assert.match(result.content[0]!.text, /Unknown action: wait/);
	assert.equal(result.details.wait, undefined);
	assert.equal(f.mock.callCount(), 0);
});

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

test("important steering releases a foreground continuation without stopping it or requiring reattachment", async (t) => {
	const f = setup(t);
	f.mock.onCall({ output: "CHILD-CONTINUED", delay: 600 });
	const pending = f.invoke({ action: "resume", id: f.runId, message: "Continue", async: false });
	await until(() => f.mock.callCount() > 0, "continuation must start");
	const run = [...f.state.ownedRuns!.values()].find((run) => run.runId !== f.runId)!;
	f.events.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: randomUUID(), reason: "attention" });
	const detached = await pending;
	assert.equal(detached.details.wait?.status, "yielded");
	assert.match(detached.content[0]!.text, /end the turn; completion will arrive automatically/);
	assert.doesNotMatch(detached.content[0]!.text, /use wait|reattach/);
	assert.equal(fs.existsSync(path.join(run.asyncDir!, "control-request.json")), false, "steering cannot stop the child");
	await until(() => fs.existsSync(path.join(getRunMetadataDir(run.runId), "result.json")), "continuation publishes its result after yielding");
	const done = await f.invoke({ action: "status", id: run.runId });
	assert.match(done.content[0]!.text, /CHILD-CONTINUED/);
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

for (const background of [false, true]) test(`${background ? "background" : "foreground"} status reads a finished child before its sibling; selected stop still runs queued siblings`, async (t) => {
	const f = setup(t, true);
	f.mock.onCall({ matchArgsIncludes: "FIRST_CHILD", output: "FIRST_SAVED_RESULT" });
	f.mock.onCall({ matchArgsIncludes: "HELD_CHILD", steps: [{ jsonl: [events.toolStart("bash", { command: "held child work" })] }, { delay: 10_000, jsonl: [events.assistantMessage("Should be stopped")] }] });
	f.mock.onCall({ matchArgsIncludes: "QUEUED_CHILD", output: "QUEUED_SIBLING_COMPLETED" });
	const pending = f.invoke({ tasks: ["FIRST_CHILD", "HELD_CHILD", "QUEUED_CHILD"].map((task) => ({ agent: "worker", task, output: false })), concurrency: 1, async: background, artifacts: false }, undefined, () => {});
	await until(() => f.state.ownedRuns!.size === 2, "new owned workflow");
	const run = [...f.state.ownedRuns!.values()].find((run) => run.runId !== f.runId)!;
	try {
		await until(() => ownedRunView(run, f.state).children[1]?.activity?.currentTool === "bash", "second child must be running");
		const first = await f.invoke({ action: "status", id: run.runId });
		assert.match(first.content[0]!.text, /FIRST_SAVED_RESULT/);
		assert.equal(first.details.run?.state, "live", "inspection does not await unrelated siblings");
		assert.equal(f.mock.callCount(), 2, "third child is still queued");
		const stopped = await f.invoke({ action: "interrupt", id: run.runId, index: 1 });
		assert.equal(stopped.isError, undefined, stopped.content[0]?.text);
		assert.match(stopped.content[0]!.text, /child 1 only/);
		await pending;
		if (background) await until(() => fs.existsSync(path.join(getRunMetadataDir(run.runId), "result.json")), "workflow publishes its result");
		const completed = await f.invoke({ action: "status", id: run.runId });
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
	const sdkRoot = process.env.PI_INTERCOM_TEST_SDK ?? path.dirname(findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url)!);
	const bin = path.join(f.cwd, "native-bin"), input = path.join(f.cwd, "native-blocked.json"), receipt = path.join(f.cwd, "native-receipt.json");
	fs.mkdirSync(bin);
	fs.writeFileSync(path.join(bin, "pi"), `#!/bin/sh\nexec '${process.execPath}' '${path.join(sdkRoot, "dist/cli.js")}' "$@"\n`, { mode: 0o755 });
	fs.writeFileSync(input, JSON.stringify({ scenario: "blocked", receiptPath: receipt, report: { criteriaSatisfied: [{ id: "deliver", status: "satisfied", evidence: "fixture" }] } }));
	const runtimeEnv = { ...nestedEnv, PATH: `${bin}${path.delimiter}${process.env.PATH}`, PI_DRIVER_FIXTURE: input, PI_INTERCOM_TEST_SDK: sdkRoot };
	const saved = Object.fromEntries(Object.keys(runtimeEnv).map((key) => [key, process.env[key]]));
	Object.assign(process.env, runtimeEnv);
	f.deps.discoverAgents = () => ({ agents: [makeAgent("worker", { model: "driver-fixture/faux-1", completionGuard: false,
		extensions: [fileURLToPath(new URL("../fixtures/native-child-attempt.mjs", import.meta.url))] })] });
	try {
		f.events.on("subagent:result-intercom", (payload) => f.events.emit("subagent:result-intercom-delivery", { requestId: payload.requestId, delivered: true }));
		const task = { agent: "worker", task: "Verify authenticated flow", output: false, acceptance: { criteria: [{ id: "deliver", must: "Verify sign-in" }] } };
		const result = await f.invoke({ ...(mode === "single" ? task : { chain: [task, { agent: "worker", task: "Dependent step must not run", output: false }] }), async: false, artifacts: false });
		assert.equal(result.isError, undefined);
		const terminal = fs.readdirSync(route.eventSink).map((file) => JSON.parse(fs.readFileSync(path.join(route.eventSink, file), "utf8"))).filter((event) => event.type === "subagent.nested.completed" && event.child?.id === result.details.runId);
		assert.equal(terminal.length, 1);
		assert.equal(terminal[0].child.state, "blocked");
		assert.equal(terminal[0].child.steps[0].status, "blocked");
		assert.match(terminal[0].child.steps[0].error, /Complete Touch ID/);
		assert.match(terminal[0].child.error, /Complete Touch ID/);
		const native = JSON.parse(fs.readFileSync(receipt, "utf8"));
		assert.equal(native.calls, 1, "human-only blocker must not enter finalization");
		assert.equal(native.networkRequests, 0);
	} finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});

for (const tracked of [false, true]) test(`${tracked ? "tracked" : "restored"} owner Stop cancels an exited child's durable question without stopping its live sibling`, async (t) => {
	const f = setup(t), id = randomUUID(), exited = spawnSync(process.execPath, ["-e", ""]);
	assert.equal(exited.status, 0);
	saveQuestionOwner(id, "session-123");
	const question = createSupervisorQuestion({ runId: id, ownerTarget: "parent", agent: "worker", index: 0, childSessionId: "exited", childTarget: "child-a", sessionFile: path.join(f.cwd, "exited.jsonl"), cwd: f.cwd, pid: exited.pid, reason: "need_decision", message: "Should A proceed?" });
	const asyncDir = getRunMetadataDir(id);
	const status = { runtimeVersion: 2, runId: id, mode: "parallel", state: "running", pid: process.pid, startedAt: 1, indexedControl: false, controlRequestFiles: true, steps: [{ agent: "worker", status: "failed" }, { agent: "worker", status: "running" }] };
	saveRunStatus(id, status);
	f.state.ownedRuns!.set(id, { ...f.state.ownedRuns!.get(f.runId)!, runId: id, rootRunId: id, source: "async", mode: "parallel", asyncDir, children: status.steps.map((step, index) => ({ agent: step.agent, index })) });
	if (tracked) f.state.asyncJobs.set(id, { asyncId: id, asyncDir, status: "running" });
	assert.equal((await f.invoke({ action: "interrupt", id, index: 0 })).isError, true, "an unrelated unsupported-control error is retained");
	assert.equal(readQuestionState(question).state, "awaiting_input");
	saveRunStatus(id, { ...status, indexedControl: true });
	const result = await f.invoke({ action: "interrupt", id, index: 0 });
	assert.equal(result.isError, undefined, result.content[0]?.text);
	assert.equal(readQuestionState(question).state, "cancelled");
	assert.equal(fs.existsSync(path.join(asyncDir, "control-requests")), false, "no sibling control request was sent");
});

test("answer async:false derives the answered question's child index rather than waiting on a sibling", async (t) => {
	const f = setup(t), id = randomUUID(), run = { ...f.state.ownedRuns!.get(f.runId)!, runId: id, rootRunId: id, mode: "parallel", children: [{ agent: "worker", index: 0 }, { agent: "worker", index: 1 }] };
	f.state.ownedRuns!.set(id, run);
	run.source = "async"; run.asyncDir = getRunMetadataDir(id);
	saveRunStatus(id, { runtimeVersion: 2, runId: id, mode: "parallel", state: "running", pid: process.pid, startedAt: Date.now(), steps: run.children.map((child) => ({ agent: child.agent, status: "running" })) });
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

for (const terminalState of ["complete", "failed"] as const) test(`waiting returns the durable ${terminalState} workflow result when no children materialized`, async (t) => {
	const f = setup(t), id = randomUUID();
	const run = { ...f.state.ownedRuns!.get(f.runId)!, runId: id, rootRunId: id, source: "async" as const, mode: "chain" as const, asyncDir: getRunMetadataDir(id), children: [] };
	f.state.ownedRuns!.set(id, run);
	saveAsyncRunResult(id, { runtimeVersion: 2, id, state: terminalState, timestamp: Date.now(), results: [],
		...(terminalState === "failed" ? { error: "Collection schema rejected the empty group" } : { summary: "Empty fanout completed" }) });
	const result = await waitForOwnedRun({ id, deps: f.deps, ctx: makeMinimalCtx(f.cwd), executionResult: true });
	assert.equal(result.details.wait?.status, "completed");
	assert.equal(result.isError, terminalState === "failed" ? true : undefined);
	assert.deepEqual(result.details.results, []);
	assert.match(result.content[0]!.text, terminalState === "failed" ? /Collection schema rejected/ : /Empty fanout completed/);
	const child = await waitForOwnedRun({ id, index: 0, deps: f.deps, ctx: makeMinimalCtx(f.cwd) });
	assert.equal(child.details.wait?.status, "unavailable", "an explicit nonexistent child is never fabricated");
});

test("foreground result collection requires durable publication, not an early terminal status", async (t) => {
	const f = setup(t), id = randomUUID(), asyncDir = path.join(f.cwd, "write-gap");
	fs.mkdirSync(asyncDir);
	const original = f.state.ownedRuns!.get(f.runId)!;
	f.state.ownedRuns!.set(id, { ...original, runId: id, rootRunId: id, source: "async", asyncDir, pid: process.pid });
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ runId: id, mode: "single", state: "complete", startedAt: 1, pid: process.pid, steps: [{ agent: "worker", status: "complete" }] }));
	let returned = false;
	const pending = waitForOwnedRun({ id, deps: f.deps, ctx: makeMinimalCtx(f.cwd) }).then((result) => { returned = true; return result; });
	await delay(160); assert.equal(returned, false);
	fs.mkdirSync(getRunMetadataDir(id), { recursive: true });
	fs.writeFileSync(path.join(getRunMetadataDir(id), "result.json"), JSON.stringify({ id, mode: "single", success: true, state: "complete", results: [{ agent: "worker", output: "DURABLE-AFTER-GAP", exitCode: 0, success: true }] }));
	assert.match((await pending).content[0]!.text, /DURABLE-AFTER-GAP/);
});

test("waiting polls one fresh view without reading transcripts or enumerating unrelated questions", async (t) => {
	const f = setup(t), id = randomUUID(), original = f.state.ownedRuns!.get(f.runId)!;
	const sessionFile = original.children[0]!.sessionFile!;
	fs.appendFileSync(sessionFile, JSON.stringify({ type: "model_change", id: "model", parentId: null, provider: "fixture", modelId: "recorded", timestamp: new Date().toISOString() }) + "\n");
	const run = { ...original, runId: id, rootRunId: id, source: "async" as const, asyncDir: getRunMetadataDir(id), pid: process.pid };
	f.state.ownedRuns!.set(id, run);
	saveQuestionOwner(id, run.ownerSessionId);
	saveQuestionContract(id, 0, JSON.parse(fs.readFileSync(path.join(getRunMetadataDir(f.runId), "contracts/0.json"), "utf8")));
	const status = { runtimeVersion: 2 as const, runId: id, mode: "single" as const, state: "running" as const, pid: process.pid, startedAt: Date.now(),
		steps: [{ agent: "worker", status: "running" as const, sessionFile, model: "fixture/original" }] };
	saveRunStatus(id, status);
	let tick: () => void = () => { throw new Error("Wait timer was not registered"); };
	t.mock.method(globalThis, "setInterval", (callback, interval) => { assert.equal(interval, POLL_INTERVAL_MS); tick = callback; return {} as NodeJS.Timeout; });
	t.mock.method(globalThis, "clearInterval", () => {});
	const readFile = fs.readFileSync, readdir = fs.readdirSync;
	let transcriptReads = 0, contractReads = 0, globalListings = 0;
	t.mock.method(fs, "readFileSync", function(file, ...args) {
		if (String(file) === sessionFile) transcriptReads++;
		if (String(file) === path.join(run.asyncDir, "contracts/0.json")) contractReads++;
		return readFile.call(this, file, ...args);
	});
	t.mock.method(fs, "readdirSync", function(file, ...args) {
		if (String(file) === path.dirname(run.asyncDir) || String(file).endsWith("/supervisor-questions")) globalListings++;
		return readdir.call(this, file, ...args);
	});
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	const controller = new AbortController(), updates = [];
	t.after(() => controller.abort());
	const pending = waitForOwnedRun({ id, deps: f.deps, ctx: makeMinimalCtx(f.cwd), signal: controller.signal, onUpdate: (result) => updates.push(result) });
	tick();
	saveRunStatus(id, { ...status, steps: [{ ...status.steps[0]!, model: "fixture/fallback" }] });
	tick();
	assert.equal(contractReads, 3, "initial check and two ticks each project the run once");
	assert.equal(transcriptReads, 0, "polling needs saved status, not native conversation configuration");
	assert.equal(globalListings, 0, "an exact run never enumerates unrelated question directories");
	assert.equal(updates.length, 2, "unchanged updates stay quiet and changed activity remains fresh");
	assert.equal(updates[1].details.progress[0].model, "fixture/fallback");
	createSupervisorQuestion({ runId: id, ownerTarget: "parent", agent: "worker", index: 0, childSessionId: "child", childTarget: "child", sessionFile, cwd: f.cwd, pid: process.pid, reason: "need_decision", message: "Choose now" });
	tick();
	const result = await pending;
	assert.equal(result.details.wait?.status, "awaiting_input");
	assert.equal(result.details.questions[0].message, "Choose now");
	assert.equal(result.details.run?.children[0]?.launch?.model, "fixture/recorded", "returned inspection still projects current native configuration");
	assert.equal(f.mock.callCount(), 0, "polling never launches work");
});
