import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Check } from "typebox/value";
import { createEventBus, createMockPi, createTempDir, makeMinimalCtx, removeTempDir } from "../support/helpers.ts";
import type { OwnedRun, SavedLaunchConfig, SubagentState } from "../../src/shared/types.ts";

const root = createTempDir("feedback-ux-");
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
process.env.PI_SUBAGENT_TEMP_ROOT = path.join(root, "pi-subagents-runtime");
const { AgentRunsParams, SubagentParams, AcceptanceOverride } = await import("../../src/extension/schemas.ts");
const { createSubagentExecutor, normalizeSubagentParamsLike } = await import("../../src/runs/foreground/subagent-executor.ts");
const { ownedRunList, resolveOwnedRun, saveForegroundRun } = await import("../../src/runs/shared/run-records.ts");
const questions = await import("../../src/runs/shared/supervisor-questions.ts");
const { buildControlEvent, formatControlNoticeMessage } = await import("../../src/runs/shared/subagent-control.ts");
const { resolveEffectiveAcceptance } = await import("../../src/runs/shared/acceptance.ts");
const { foregroundStatusResult } = await import("../../src/runs/foreground/foreground-control.ts");
const { formatAsyncStartedMessage } = await import("../../src/runs/background/async-execution.ts");
after(() => removeTempDir(root));

function setup(id: string) {
	const sessionFile = path.join(root, `${id}.jsonl`);
	fs.writeFileSync(sessionFile, "");
	const run: OwnedRun = { runId: id, rootRunId: id, ownerSessionId: "session-123", source: "foreground", mode: "single", cwd: root,
		task: `Task lead ${"long original task\n".repeat(150)}TASK-END`, startedAt: 1, children: [{ agent: "worker", index: 0, sessionFile }] };
	const launch: SavedLaunchConfig = { agent: { name: "worker", description: "Fixture", source: "project", filePath: "/fixture/worker.md", systemPrompt: "PRIVATE-PROMPT-END", systemPromptMode: "replace", inheritProjectContext: true, inheritSkills: false },
		systemPrompt: "PRIVATE-PROMPT-END", skills: [], model: "fixture/original", modelCandidates: ["fixture/original"], cwd: root, context: "fresh", output: false, outputMode: "inline", artifacts: true, share: false };
	questions.saveQuestionOwner(id, run.ownerSessionId);
	questions.saveQuestionContract(id, 0, { sessionFile, launch });
	const state: SubagentState = { baseCwd: root, currentSessionId: run.ownerSessionId, ownedRuns: new Map([[id, run]]), asyncJobs: new Map(), foregroundRuns: new Map(), foregroundControls: new Map(), lastForegroundControlId: null,
		cleanupTimers: new Map(), lastUiContext: null, poller: null, completionSeen: new Map(), watcher: null, watcherRestartTimer: null, resultFileCoalescer: { schedule: () => false, clear() {} } };
	const events = createEventBus();
	const emitted: string[] = [];
	for (const event of ["subagent:live-intercom", "subagent:result-intercom", "subagent:async-started"]) events.on(event, () => emitted.push(event));
	const executor = createSubagentExecutor({ pi: { events, getSessionName: () => "parent" }, state, config: {}, asyncByDefault: false, tempArtifactsDir: root, getSubagentSessionRoot: () => root, expandTilde: (value) => value, discoverAgents: () => ({ agents: [] }) });
	const child = { agent: "worker", task: run.task, exitCode: 0, finalOutput: "Short worker result", sessionFile, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 } };
	saveForegroundRun({ ...run, results: [child] });
	return { run, launch, state, emitted, executor, sessionFile, child, execute: (params: Record<string, unknown>) => executor.execute("fixture", normalizeSubagentParamsLike(params), undefined, undefined, makeMinimalCtx(root)) };
}

test("feedback inspect is compact by default, full is opt-in, and questions/errors/paths remain actionable", async () => {
	const fixture = setup("inspect-compact");
	const artifactPaths = { outputPath: path.join(root, "missing-output.md"), metadataPath: path.join(root, "missing-meta.json") };
	const effectiveAcceptance = resolveEffectiveAcceptance({ explicit: { criteria: ["Retain evidence"] } })!;
	saveForegroundRun({ ...fixture.run, results: [{ ...fixture.child, exitCode: 1, error: "Exact failure retained", artifactPaths,
		acceptance: { status: "rejected", explicit: true, effectiveAcceptance, criteria: effectiveAcceptance.criteria, runtimeChecks: [], verifyRuns: [] } }] });
	const question = questions.createSupervisorQuestion({ runId: fixture.run.runId, ownerTarget: "parent", agent: "worker", index: 0, childSessionId: "child", childTarget: "child", sessionFile: fixture.sessionFile, cwd: root, pid: 99999999, reason: "need_decision", message: "Choose the branch before continuing." });
	const compact = await fixture.execute({ action: "status", id: fixture.run.runId });
	const text = compact.content.map((part) => part.text).join("\n");
	assert.doesNotMatch(text, /TASK-END|PRIVATE-PROMPT-END/);
	for (const value of ["Task lead", "Launch cwd:", "Exact failure retained", "validation: rejected", `${artifactPaths.outputPath} (missing)`, `${artifactPaths.metadataPath} (missing)`, fixture.sessionFile, question.questionId, "Choose the branch", 'agent_runs({ action: "answer"', "full: true"]) assert.ok(text.includes(value), value);
	assert.equal(compact.details.run?.task, fixture.run.task);
	assert.deepEqual(compact.details.run?.children[0]?.launch, fixture.launch);
	assert.equal(compact.details.questions?.[0]?.questionId, question.questionId);
	const full = await fixture.execute({ action: "status", id: fixture.run.runId, full: true });
	assert.ok(full.content.some((part) => part.text.includes(fixture.run.task)));
	assert.ok(full.content.some((part) => part.text.includes("PRIVATE-PROMPT-END")));
	assert.deepEqual(full.details.run, compact.details.run, "compact presentation must not erase stored details");
});

test("feedback review returns only a saved parent-decision receipt and never relays the note", async () => {
	const fixture = setup("review-receipt");
	const note = `IMPORTANT-REVIEW-NOTE ${"do not replay ".repeat(100)}`;
	const result = await fixture.execute({ action: "review", id: fixture.run.runId, decision: "needs_changes", message: note });
	const text = result.content.map((part) => part.text).join("\n");
	assert.ok(text.length < 450, "review is a receipt, not a second inspect");
	assert.match(text, /Saved parent review.*needs_changes/);
	assert.match(text, /parent-only.*not sent/);
	assert.match(text, /continue\/nudge/);
	assert.doesNotMatch(text, /TASK-END|PRIVATE-PROMPT-END|IMPORTANT-REVIEW-NOTE/);
	assert.equal(fixture.state.ownedRuns?.get(fixture.run.runId)?.review?.message, note);
	assert.equal(result.details.run?.state, "completed");
	assert.deepEqual(fixture.emitted, []);
});

test("feedback explicit continuation never replays a saved parent review as new child instructions", async () => {
	const { RESULTS_DIR } = await import("../../src/shared/types.ts");
	const fixture = setup("review-no-relay");
	const mock = createMockPi();
	mock.install();
	try {
		await fixture.execute({ action: "review", id: fixture.run.runId, decision: "needs_changes", message: "PARENT-ONLY-REVIEW-NOTE" });
		mock.onCall({ output: "Follow-up finished" });
		const result = await fixture.execute({ action: "resume", id: fixture.run.runId, message: "ONLY-NEW-ACTIONABLE-INSTRUCTION" });
		assert.ok(!result.isError, result.content[0]?.text);
		const deadline = Date.now() + 10000;
		while (!fs.existsSync(path.join(RESULTS_DIR, `${result.details.asyncId}.json`))) { assert.ok(Date.now() < deadline); await sleep(10); }
		const status = JSON.parse(fs.readFileSync(path.join(result.details.asyncDir!, "status.json"), "utf8"));
		while (questions.questionProcessAlive({ pid: status.pid })) { assert.ok(Date.now() < deadline); await sleep(10); }
		const calls = fs.readdirSync(mock.dir).filter((name) => name.startsWith("call-"));
		assert.equal(calls.length, 1);
		const call = JSON.parse(fs.readFileSync(path.join(mock.dir, calls[0]!), "utf8"));
		assert.ok(call.expandedArgs.join("\n").includes("ONLY-NEW-ACTIONABLE-INSTRUCTION"));
		assert.ok(!call.expandedArgs.join("\n").includes("PARENT-ONLY-REVIEW-NOTE"));
		assert.equal(fixture.state.ownedRuns!.get(fixture.run.runId)!.review?.decision, "needs_changes");
		assert.equal(fixture.state.ownedRuns!.get(result.details.asyncId!)!.review, undefined);
	} finally { mock.uninstall(); }
});

test("feedback completion and compact receipts expose existing result/acceptance metadata without inventing disabled artifacts", async () => {
	const { maybeBuildForegroundIntercomReceipt } = await import("../../src/runs/foreground/foreground-control.ts");
	const { createResultWatcher } = await import("../../src/runs/background/result-watcher.ts");
	const { formatSubagentResultReceipt } = await import("../../src/intercom/result-intercom.ts");
	const fixture = setup("metadata-pointer");
	const artifactPaths = { outputPath: path.join(root, "short-output.md"), metadataPath: path.join(root, "acceptance-meta.json") };
	fs.writeFileSync(artifactPaths.outputPath, "Short summary");
	fs.writeFileSync(artifactPaths.metadataPath, JSON.stringify({ acceptance: { status: "passed", childReport: { changedFiles: ["proof.ts"] } } }));
	const bus = createEventBus();
	const deliveries: import("../../src/shared/types.ts").SubagentResultIntercomPayload[] = [];
	bus.on("subagent:result-intercom", (raw) => {
		const payload = raw as import("../../src/shared/types.ts").SubagentResultIntercomPayload;
		deliveries.push(payload);
		bus.emit("subagent:result-intercom-delivery", { requestId: payload.requestId, delivered: true });
	});
	const foreground = await maybeBuildForegroundIntercomReceipt({ pi: { events: bus }, intercomBridge: { orchestratorTarget: "parent", instruction: "" }, runId: fixture.run.runId, mode: "single", details: { mode: "single", results: [{ ...fixture.child, artifactPaths }] } });
	assert.ok(foreground?.text.includes(artifactPaths.metadataPath));
	assert.ok(deliveries[0]?.message.includes(artifactPaths.metadataPath));
	assert.ok(deliveries[0]?.resultPath?.endsWith("foreground.json"));
	assert.ok(fs.existsSync(deliveries[0]!.resultPath!));
	assert.ok(foreground?.text.includes(deliveries[0]!.resultPath!));
	const resultsDir = path.join(root, "metadata-results");
	fs.mkdirSync(resultsDir);
	const runId = "metadata-async";
	const data = { id: runId, sessionId: fixture.run.ownerSessionId, mode: "single", state: "complete", success: true, timestamp: Date.now(), intercomTarget: "parent", results: [{ agent: "worker", success: true, exitCode: 0, output: "Short summary", artifactPaths }] };
	questions.saveAsyncRunResult(runId, data);
	fs.writeFileSync(path.join(resultsDir, `${runId}.json`), JSON.stringify(data));
	const completed = Promise.withResolvers<void>();
	bus.on("subagent:async-complete", () => completed.resolve());
	const watcher = createResultWatcher({ events: bus }, fixture.state, resultsDir, 60000);
	try {
		watcher.primeExistingResults();
		await completed.promise;
		const payload = deliveries[1]!;
		assert.equal(payload.children[0]?.metadataPath, artifactPaths.metadataPath);
		assert.ok(payload.message.includes(artifactPaths.metadataPath));
		assert.ok(payload.resultPath?.endsWith("result.json") && fs.existsSync(payload.resultPath));
		assert.ok(formatSubagentResultReceipt({ mode: "single", runId, payload }).includes(artifactPaths.metadataPath));
	} finally { watcher.stopResultWatcher(); }
	const disabled = await maybeBuildForegroundIntercomReceipt({ pi: { events: bus }, intercomBridge: { orchestratorTarget: "parent", instruction: "" }, runId: fixture.run.runId, mode: "single", details: { mode: "single", results: [fixture.child] } });
	assert.equal(deliveries[2]?.children[0]?.metadataPath, undefined);
	assert.doesNotMatch(disabled!.text, /Result metadata \(/);
	assert.doesNotMatch(deliveries[2]!.message, /Result metadata \(/);
});

test("feedback public and advanced schemas expose full inspection and explain unchanged acceptance/review policies", () => {
	assert.equal(Check(AgentRunsParams, { action: "inspect", id: "run", full: true }), true);
	assert.equal(Check(AgentRunsParams, { action: "nudge", id: "run", message: "go", full: true }), false);
	assert.equal(Check(AgentRunsParams, { action: "extend", id: "run" }), false);
	assert.equal(Check(SubagentParams, { action: "status", runId: "run", full: true }), true);
	assert.equal(Check(SubagentParams, { action: "status", full: true }), false);
	assert.equal(normalizeSubagentParamsLike({ action: "status", full: true }).full, true);
	assert.match(AgentRunsParams.properties.message.description, /parent-only.*not sent/);
	assert.match(SubagentParams.properties.message.description, /not sent/);
	assert.match(AcceptanceOverride.description, /entire Git index.*pre-existing staged/);
	assert.match(AcceptanceOverride.description, /never to a live child's acceptance/);
});

test("feedback live runs precede 31 unreviewed results while history and explicit continuation links remain intact", () => {
	const fixture = setup("list-live");
	fixture.state.foregroundControls.set(fixture.run.runId, { runId: fixture.run.runId, mode: "single", startedAt: 1, updatedAt: 1, currentAgent: "worker", currentIndex: 0 });
	fs.rmSync(path.join(questions.getRunMetadataDir(fixture.run.runId), "foreground.json"));
	for (let i = 0; i < 31; i++) {
		const run = { ...fixture.run, runId: `finished-${i}`, rootRunId: `finished-${i}`, startedAt: i + 10 };
		fixture.state.ownedRuns!.set(run.runId, run);
		saveForegroundRun({ ...run, results: [fixture.child] });
	}
	const successor = { ...fixture.run, predecessorRunId: "finished-0", predecessorIndex: 0, rootRunId: "finished-0" };
	fixture.state.ownedRuns!.set(successor.runId, successor);
	const list = ownedRunList(fixture.state, { limit: 2 });
	assert.equal(list.details.runs?.[0]?.runId, fixture.run.runId);
	assert.match(list.content[0]!.text, /from finished-0:0/);
	const all = [];
	let predecessorText = "";
	for (let offset = 0; offset < 32; offset += 5) {
		const page = ownedRunList(fixture.state, { offset, limit: 5 });
		assert.equal(page.details.runList?.total, 32);
		all.push(...page.details.runs!.map((run) => run.runId));
		predecessorText += page.content[0]!.text;
	}
	assert.equal(new Set(all).size, 32);
	assert.match(predecessorText, /continued as list-live \(separate results\/reviews\)/);
	assert.equal(resolveOwnedRun(fixture.state, "finished-0")?.review, undefined);
	assert.equal(resolveOwnedRun(fixture.state, "finished-30")?.runId, "finished-30");
});

for (const childSafe of [false, true]) test(`feedback ${childSafe ? "child-safe" : "parent"} controls only advertise callable tool/action pairs`, () => {
	const failedTool = formatControlNoticeMessage(buildControlEvent({ runId: "failed-tool", agent: "worker", to: "needs_attention", reason: "tool_failures", message: "Repeated edit failures", currentTool: "edit" }), "worker", childSafe);
	assert.match(failedTool, /Repeated edit failures/);
	assert.doesNotMatch(failedTool, /Inspect command progress|still active|long-running tool/, "a completed failed tool is not an active long tool");
	const control = { runId: "live-control", mode: "single" as const, startedAt: 1, updatedAt: 1, currentAgent: "worker", currentIndex: 0,
		timeoutAt: Date.now() + 60000, extendTimeout: () => ({ ok: true, message: "extended" }) };
	const text = [foregroundStatusResult(control, undefined, true, childSafe).content[0]!.text, formatAsyncStartedMessage("Started", childSafe), formatControlNoticeMessage(buildControlEvent({ runId: control.runId, agent: "worker", to: "needs_attention" }), "worker", childSafe)].join("\n");
	if (childSafe) {
		assert.match(text, /subagent\(\{ action: "status"/);
		assert.match(text, /subagent\(\{ action: "interrupt"/);
		assert.doesNotMatch(text, /agent_runs|load_subagent/);
	} else {
		assert.match(text, /agent_runs\(\{ action: "inspect"/);
		assert.match(text, /agent_runs\(\{ action: "stop"/);
		assert.match(text, /agent_runs\(\{ action: "nudge"/);
		assert.match(text, /load_subagent\(\{\}\), then subagent\(\{ action: "extend"/);
		assert.doesNotMatch(text, /subagent\(\{ action: "(?:status|nudge|resume|interrupt)"|agent_runs\(\{ action: "extend"/);
	}
});

test("feedback child-safe launch and completion hints do not depend on a live nested route", async () => {
	const { buildSubagentResultIntercomPayload } = await import("../../src/intercom/result-intercom.ts");
	const { formatDetachedIntercomGuidance } = await import("../../src/runs/shared/intercom-detach.ts");
	const keys = ["PI_SUBAGENT_CHILD", "PI_SUBAGENT_FANOUT_CHILD", "PI_SUBAGENT_PARENT_EVENT_SINK", "PI_SUBAGENT_PARENT_ROOT_RUN_ID", "PI_SUBAGENT_PARENT_CAPABILITY_TOKEN"];
	const previous = keys.map((key) => process.env[key]);
	process.env.PI_SUBAGENT_CHILD = "1";
	process.env.PI_SUBAGENT_FANOUT_CHILD = "1";
	for (const key of keys.slice(2)) delete process.env[key];
	try {
		const fixture = setup("child-safe-hints");
		const text = [formatAsyncStartedMessage("Started"),
			buildSubagentResultIntercomPayload({ to: "parent", runId: fixture.run.runId, asyncId: fixture.run.runId, mode: "single", source: "async", children: [{ agent: "worker", status: "completed", summary: "Done", sessionPath: fixture.sessionFile }] }).message,
			formatDetachedIntercomGuidance({ headline: "Waiting", runId: fixture.run.runId, result: fixture.child, childIndex: 0 }),
		].join("\n");
		assert.match(text, /subagent\(\{ action: "status"/);
		assert.match(text, /subagent\(\{ action: "resume"/);
		assert.doesNotMatch(text, /agent_runs|load_subagent/);
	} finally { keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; }); }
});

test("feedback durable wait requires the exact run/child/session/process and retains undelivered answers", () => {
	const fixture = setup("wait-identity");
	const input = { runId: fixture.run.runId, agent: "worker", index: 0, sessionFile: fixture.sessionFile, pid: process.pid };
	const event = () => buildControlEvent({ ...input, to: "needs_attention", ts: 700000, lastActivityAt: 99999, currentTool: "contact_supervisor", currentToolDurationMs: 600001, supervisorQuestion: questions.pendingSupervisorQuestion(input) });
	assert.equal(event().supervisorQuestion, undefined, "tool name alone proves no durable wait");
	const question = questions.createSupervisorQuestion({ ...input, ownerTarget: "parent", childSessionId: "child", childTarget: "child", cwd: root, reason: "need_decision", message: "Choose one." });
	for (const mismatch of [{ runId: "different" }, { agent: "other" }, { index: 1 }, { sessionFile: `${fixture.sessionFile}.other` }, { pid: process.pid + 1 }]) assert.equal(questions.pendingSupervisorQuestion({ ...input, ...mismatch }), undefined);
	const waiting = formatControlNoticeMessage(event());
	assert.match(waiting, /Waiting for supervisor input/);
	assert.ok(waiting.includes(question.questionId));
	assert.match(waiting, /agent_runs\(\{ action: "answer"/);
	assert.doesNotMatch(waiting, /waiting for user|What are you blocked on/i);
	questions.saveQuestionAnswer(question, "Saved \"exact\" answer");
	const pending = formatControlNoticeMessage(event());
	assert.match(pending, /delivery unconfirmed/);
	assert.ok(pending.includes(JSON.stringify('Saved "exact" answer')));
	questions.recordQuestionDelivery(question, { kind: "live", runId: input.runId, deliveredAt: Date.now() });
	assert.equal(event().supervisorQuestion, undefined);
	assert.match(formatControlNoticeMessage(event()), /contact_supervisor still active for 600s; no observed output\/events for 600s/);
});
