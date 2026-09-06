import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
const [root, repo, sdkRoot, phase = "journey"] = process.argv.slice(2);
const coldParent = phase === "cold-parent";
const cwd = path.join(root, "project"), agentDir = path.join(root, "agent"), runtimeDir = path.join(root, "pi-subagents-runtime"), callsDir = path.join(root, "calls");
for (const dir of [cwd, agentDir, callsDir, path.join(cwd, ".pi/agents"), path.join(root, "bin"), path.join(cwd, ".pi/skills/saved-skill")]) fs.mkdirSync(dir, { recursive: true });
Object.assign(process.env, { HOME: root, TMPDIR: root, PI_CODING_AGENT_DIR: agentDir, PI_SUBAGENT_TEMP_ROOT: runtimeDir, PI_OFFLINE: "1", OWNERSHIP_SDK_ROOT: sdkRoot, OWNERSHIP_PROBE_DIR: callsDir, OWNERSHIP_REPO: repo });
fs.writeFileSync(path.join(root, "bin/pi"), `#!/bin/sh\nexec "${process.execPath}" "${path.join(repo, "test/fixtures/native-ownership-cli.mjs")}" "$@"\n`, { mode: 0o755 });
process.env.PATH = `${path.join(root, "bin")}${path.delimiter}${process.env.PATH}`;
const sdk = await import(pathToFileURL(path.join(sdkRoot, "dist/index.js")).href);
const { QUESTIONS_DIR, getRunMetadataDir, readQuestionContract } = await import(pathToFileURL(path.join(repo, "dist/runs/shared/supervisor-questions.js")).href);
const evidence = { nativeProviderRequests: 0, failures: [], checks: [], root, parentPid: process.pid };
const check = (name, run) => { run(); evidence.checks.push(name); };
const profilePath = path.join(cwd, ".pi/agents/probe.md");
const skillPath = path.join(cwd, ".pi/skills/saved-skill/SKILL.md");
const writeProfile = (changed = false) => {
	fs.writeFileSync(profilePath, `---\nname: probe\ndescription: Native ownership probe\nmodel: openai/gpt-6-astra\nthinking: ${changed ? "low" : "off"}\ntools: ${changed ? "read" : "read, bash"}\nextensions:\ninheritProjectContext: ${changed}\ninheritSkills: false\nskills: saved-skill\n---\n${changed ? "CHANGED_PROFILE" : "ORIGINAL_PROFILE"}\n`);
	fs.writeFileSync(skillPath, `---\nname: saved-skill\ndescription: Selected context for a native probe\n---\n${changed ? "SKILL_AFTER" : "SKILL_BEFORE"}\n`);
};
if (!coldParent) writeProfile();
function newParent(file, id = randomUUID()) {
	fs.writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id, cwd, timestamp: new Date().toISOString() })}\n`);
	return file;
}
const parentFile = path.join(root, "parent.jsonl");
if (!coldParent) newParent(parentFile);
const calls = () => fs.readdirSync(callsDir).filter((file) => file.startsWith("call-")).sort().map((file) => JSON.parse(fs.readFileSync(path.join(callsDir, file), "utf8")));
const wait = async (predicate, label) => {
	const deadline = Date.now() + 20_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`Timeout: ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
};
let acknowledgeResults = coldParent;
let nudgeDeliveries = 0;
const resolvedQuestions = [];
const bus = sdk.createEventBus();
bus.on("subagent:result-intercom", (message) => { if (acknowledgeResults) bus.emit("subagent:result-intercom-delivery", { requestId: message.requestId, delivered: true }); });
bus.on("subagent:live-intercom", (message) => { nudgeDeliveries++; bus.emit("subagent:live-intercom-delivery", { requestId: message.requestId, delivered: true }); });
bus.on("subagent:supervisor-question-resolved", (message) => resolvedQuestions.push(message.questionId));
let session;
async function open(file) {
	const settingsManager = sdk.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
	settingsManager.setProjectTrusted(true);
	const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, eventBus: bus, additionalExtensionPaths: [path.join(repo, "dist/extension/index.js")], extensionFactories: [(pi) => { pi.on("before_provider_request", () => { evidence.nativeProviderRequests++; throw new Error("This test must not invoke a provider."); }); }] });
	await loader.reload();
	const modelRuntime = await sdk.ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json") });
	({ session } = await sdk.createAgentSession({ cwd, agentDir, settingsManager, resourceLoader: loader, sessionManager: sdk.SessionManager.open(file), modelRuntime }));
	await session.bindExtensions({ mode: "json" });
}
async function close() {
	if (!session) return;
	await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	session.dispose(); session = undefined;
}
const invoke = async (name, args) => {
	const tool = session.agent.state.tools.find((entry) => entry.name === name);
	assert.ok(tool, `Missing ${name}`);
	return tool.execute(randomUUID(), args, new AbortController().signal);
};
const inspect = (id) => invoke("agent_runs", { action: "inspect", id });
const resultFile = (id) => path.join(getRunMetadataDir(id), "result.json");
async function completed(id) {
	await wait(() => fs.existsSync(resultFile(id)), `durable result ${id}`);
	return JSON.parse(fs.readFileSync(resultFile(id), "utf8"));
}
function runSnapshot(run) {
	return {
		runId: run.runId, source: run.source, state: run.state, review: run.review,
		rootRunId: run.rootRunId, predecessorRunId: run.predecessorRunId ?? null, continuations: run.continuations,
		sessionFile: run.children[0].sessionFile, launch: run.children[0].launch,
		output: run.children[0].result.finalOutput, acceptance: run.children[0].result.acceptance,
	};
}
async function runJourney() {
	await open(parentFile);
	const first = await invoke("delegate", { agent: "probe", task: "Return FIRST_SESSION_TOKEN", async: false, context: "fresh", output: false, model: "openai-codex/gpt-6-astra:high" });
	const originalId = first.details.runId;
	evidence.originalId = originalId;
	const originalReceipt = { role: "toolResult", toolCallId: "legacy-probe", toolName: "delegate", content: first.content, details: first.details, isError: false, timestamp: Date.now() };
	session.sessionManager.appendMessage(originalReceipt);
	acknowledgeResults = true;
	const originalInspection = await inspect(originalId);
	assert.equal(originalInspection.details.managementControl.state, "completed");
	const beforeReload = calls().length;
	writeProfile(true);
	await session.reload();
	const reloadedOriginal = (await inspect(originalId)).details.run;
	const original = originalInspection.details.run;
	check("effective provider, thinking, profile and result are inspectable", () => {
		assert.equal(original.state, "completed");
		assert.equal(original.children[0].launch.model, "openai-codex/gpt-6-astra");
		assert.equal(original.children[0].launch.thinking, "high");
		assert.equal(original.children[0].launch.agent.filePath, profilePath);
		assert.equal(original.children[0].result.finalOutput, "FIRST_SESSION_TOKEN");
	});
	check("actual SDK reload keeps original foreground handle", () => {
		assert.equal(reloadedOriginal.runId, originalId);
		assert.equal(reloadedOriginal.state, "completed");
		assert.equal(reloadedOriginal.children[0].result.finalOutput, "FIRST_SESSION_TOKEN");
	});
	const continued = await invoke("agent_runs", { action: "continue", id: originalId, message: "RECALL_TOKEN from the saved conversation." });
	const continuedId = continued.details.asyncId;
	assert.equal((await completed(continuedId)).results[0].output, "RECALLED FIRST_SESSION_TOKEN");
	const continuedCall = calls()[beforeReload];
	check("changed profile and selected skill defaults do not alter continuation", () => {
		assert.equal(continuedCall.modelArg, "openai-codex/gpt-6-astra:high");
		assert.equal(continuedCall.tools, "read,bash");
		assert.equal(continuedCall.noExtensions, true);
		assert.equal(continuedCall.noContextFiles, true);
		assert.ok(continuedCall.prompt.includes("ORIGINAL_PROFILE"));
		assert.ok(continuedCall.prompt.includes("SKILL_BEFORE"));
		assert.ok(!continuedCall.prompt.includes("CHANGED_PROFILE"));
		assert.ok(!continuedCall.prompt.includes("SKILL_AFTER"));
		assert.equal(continuedCall.sessionFile, original.children[0].sessionFile);
		assert.ok(continuedCall.previousMessages >= 2);
	});
	await close(); await open(parentFile);
	assert.equal((await inspect(originalId)).details.run.state, "completed");
	assert.equal((await inspect(continuedId)).details.run.state, "completed");
	evidence.checks.push("fresh native SDK session restores foreground and background original handles");
	const overridden = await invoke("agent_runs", { action: "continue", id: continuedId, message: "Return an explicit override result.", model: "openai/gpt-6-astra:low" });
	await completed(overridden.details.asyncId);
	assert.equal(calls().at(-1).modelArg, "openai/gpt-6-astra:low");
	const lineage = (await inspect(originalId)).details.run;
	check("original handle exposes stable root, predecessor, and continuation history", () => {
		assert.equal(lineage.rootRunId, originalId);
		assert.ok(lineage.continuations.some((next) => next.runId === continuedId && next.predecessorRunId === originalId));
		assert.ok(lineage.continuations.some((next) => next.runId === overridden.details.asyncId && next.predecessorRunId === continuedId));
	});
	const activeContinuation = await invoke("agent_runs", { action: "continue", id: originalId, message: "WAIT_GATE:release_lineage" });
	await wait(() => calls().some((call) => call.task.includes("WAIT_GATE:release_lineage")), "active continuation");
	const beforeReroute = calls().length;
	await invoke("agent_runs", { action: "continue", id: originalId, message: "Keep the existing continuation." });
	assert.equal(calls().length, beforeReroute, "an original handle must not duplicate a live continuation of the same session");
	fs.writeFileSync(path.join(callsDir, "release_lineage"), "release");
	await completed(activeContinuation.details.asyncId);
	evidence.checks.push("original handles route follow-ups to an already-live continuation without duplicate processes");
	const slow = await invoke("delegate", { agent: "probe", task: "WAIT_GATE:release_background", async: true, output: false });
	await wait(() => calls().some((call) => call.task.includes("WAIT_GATE:release_background")), "running background child");
	await session.reload();
	assert.equal((await inspect(slow.details.runId)).details.run.state, "live");
	const liveCallCount = calls().length;
	await assert.rejects(() => invoke("agent_runs", { action: "review", id: slow.details.runId, decision: "accepted" }), /still live/);
	const liveFollowUp = await invoke("agent_runs", { action: "continue", id: slow.details.runId, message: "Keep doing the active task.", model: "openai/gpt-6-astra:low" });
	assert.match(JSON.stringify(liveFollowUp.content), /No launch settings were changed/);
	assert.equal(calls().length, liveCallCount);
	await invoke("agent_runs", { action: "stop", id: slow.details.runId });
	assert.equal((await completed(slow.details.runId)).state, "paused");
	evidence.checks.push("running background survives reload; continue steers instead of spawning; stop remains paused");
	await invoke("load_subagent", {});
	const launchGroup = await invoke("subagent", { tasks: [
		{ agent: "probe", task: "Return FIRST_SESSION_TOKEN before the sibling finishes.", output: false, model: "openai-codex/gpt-6-astra:high", acceptance: { criteria: ["Return the requested token"], evidence: ["manual-notes"], maxFinalizationTurns: 1 } },
		{ agent: "probe", task: "WAIT_GATE:release_launch_sibling", output: false, model: "openai/gpt-6-astra:off" },
	], concurrency: 2, async: true });
	const launchGroupId = launchGroup.details.runId;
	const launchStatusFile = path.join(getRunMetadataDir(launchGroupId), "status.json");
	await wait(() => fs.existsSync(launchStatusFile) && JSON.parse(fs.readFileSync(launchStatusFile, "utf8")).steps[0].status === "complete", "first parallel child including acceptance finalization");
	const beforeContinuation = (await inspect(launchGroupId)).details.run;
	assert.deepEqual(beforeContinuation.children.map((child) => child.state), ["completed", "live"]);
	const launchSession = beforeContinuation.children[0].sessionFile;
	const initialLaunchCalls = calls().filter((call) => call.sessionFile === launchSession);
	assert.equal(initialLaunchCalls.length, 2, "the initial child completes its same-session acceptance turn before continuation");
	assert.ok(initialLaunchCalls.every((call) => call.modelArg === "openai-codex/gpt-6-astra:high"));
	assert.equal(JSON.parse(fs.readFileSync(launchStatusFile, "utf8")).steps[0].acceptance.finalization.status, "completed");
	const nativeInitial = sdk.SessionManager.open(launchSession).buildSessionContext();
	assert.deepEqual(nativeInitial.model, { provider: "openai-codex", modelId: "gpt-6-astra" });
	assert.equal(nativeInitial.thinkingLevel, "high");
	const launchContinuation = await invoke("agent_runs", { action: "continue", id: launchGroupId, index: 0, message: "RECALL_TOKEN with an explicit model override.", model: "openai/gpt-6-astra:low" });
	const launchContinuationId = launchContinuation.details.asyncId;
	const launchContinuationResult = await completed(launchContinuationId);
	assert.equal(launchContinuationResult.success, true);
	assert.equal(launchContinuationResult.results[0].sessionFile, launchSession);
	assert.equal(launchContinuationResult.results[0].acceptance.finalization.status, "completed");
	const continuationCalls = calls().filter((call) => call.sessionFile === launchSession).slice(initialLaunchCalls.length);
	assert.equal(continuationCalls.length, 2);
	assert.ok(continuationCalls.every((call) => call.modelArg === "openai/gpt-6-astra:low" && call.previousMessages >= 4));
	const nativeContinued = sdk.SessionManager.open(launchSession).buildSessionContext();
	assert.deepEqual(nativeContinued.model, { provider: "openai", modelId: "gpt-6-astra" });
	assert.equal(nativeContinued.thinkingLevel, "low");
	assert.equal((await inspect(launchGroupId)).details.run.children[1].state, "live");
	assert.equal(fs.existsSync(resultFile(launchGroupId)), false, "the sibling still holds the original workflow open");
	fs.writeFileSync(path.join(callsDir, "release_launch_sibling"), "release");
	assert.equal((await completed(launchGroupId)).success, true);
	const launchSnapshots = [];
	for (const afterReload of [false, true]) {
		if (afterReload) await session.reload();
		for (const id of [launchGroupId, launchContinuationId]) {
			const run = (await inspect(id)).details.run;
			const child = run.children[0];
			launchSnapshots.push({ afterReload, runId: id, state: run.state, sessionFile: child.sessionFile, model: child.launch.model, thinking: child.launch.thinking });
		}
	}
	evidence.childLaunchSnapshots = { originalRunId: launchGroupId, continuationRunId: launchContinuationId, initialCalls: initialLaunchCalls.length, continuationCalls: continuationCalls.length, snapshots: launchSnapshots };
	check("completed background child keeps its own model/thinking after a same-session override finishes before its sibling, including finalization and SDK reload", () => {
		for (const snapshot of launchSnapshots) {
			assert.equal(snapshot.state, "completed");
			assert.equal(snapshot.sessionFile, launchSession);
			assert.equal(snapshot.model, snapshot.runId === launchGroupId ? "openai-codex/gpt-6-astra" : "openai/gpt-6-astra", "original launch must not inherit the later continuation model");
			assert.equal(snapshot.thinking, snapshot.runId === launchGroupId ? "high" : "low", "original launch must not inherit the later continuation thinking");
		}
	});
	await invoke("load_subagent", {});
	const mixed = await invoke("subagent", { chain: [{ agent: "probe", task: "Complete the first step", output: false }, { agent: "probe", task: "WAIT_GATE:chain_pause", output: false }], async: true });
	await wait(() => calls().some((call) => call.task.includes("WAIT_GATE:chain_pause")), "chain second step");
	await invoke("agent_runs", { action: "stop", id: mixed.details.runId });
	await completed(mixed.details.runId);
	const mixedView = (await inspect(mixed.details.runId)).details.run;
	assert.equal(mixedView.state, "paused");
	assert.deepEqual(mixedView.children.map((child) => child.state), ["completed", "paused"]);
	evidence.checks.push("paused background chains preserve earlier successful child outcomes");
	const foregroundWait = invoke("subagent", { agent: "probe", task: "WAIT_GATE:foreground_pause", async: false, output: false, timeoutMs: 10_000 });
	await wait(() => calls().some((call) => call.task.includes("WAIT_GATE:foreground_pause")), "foreground child checkpoint");
	const foregroundId = session.sessionManager.getEntries().findLast((entry) => entry.type === "custom" && entry.customType === "subagent-run" && entry.data.task === "WAIT_GATE:foreground_pause").data.runId;
	const foregroundLive = await inspect(foregroundId);
	assert.equal(foregroundLive.details.run.state, "live");
	assert.ok(foregroundLive.details.managementControl.capabilities.includes("extend"), "owned inspection preserves the live timeout control");
	await invoke("agent_runs", { action: "stop", id: foregroundId });
	await foregroundWait;
	await session.reload();
	assert.equal((await inspect(foregroundId)).details.run.state, "paused");
	const foregroundResume = await invoke("agent_runs", { action: "continue", id: foregroundId, message: "Finish the interrupted task." });
	await completed(foregroundResume.details.asyncId);
	assert.ok(calls().at(-1).previousMessages >= 2);
	evidence.checks.push("native foreground interruption remains paused across reload and continues the saved child; extend control is retained while live");
	await invoke("load_subagent", {});
	const acceptance = { criteria: ["Return the requested token"], evidence: ["manual-notes"], maxFinalizationTurns: 1 };
	const questionRun = await invoke("subagent", { agent: "probe", task: "CREATE_QUESTION", async: false, output: false, model: "openai-codex/gpt-6-astra:off", acceptance });
	const questionId = questionRun.details.runId;
	const questionContract = readQuestionContract(questionId, 0);
	await session.reload();
	const questions = await invoke("agent_runs", { action: "questions", id: questionId });
	const pending = questions.details.questions.find((question) => question.state === "awaiting_input");
	assert.ok(pending);
	const withQuestion = await invoke("agent_runs", { action: "list", limit: 2 });
	assert.equal(withQuestion.details.runs[0].runId, questionId);
	fs.rmSync(runtimeDir, { recursive: true, force: true });
	await session.reload();
	const answered = await invoke("agent_runs", { action: "answer", id: questionId, questionId: pending.questionId, message: "Use the stable answer." });
	await completed(answered.details.asyncId);
	const answerContract = readQuestionContract(answered.details.asyncId, 0);
	check("saved question revival keeps actual model, off thinking, output and acceptance", () => {
		assert.equal(answerContract.launch.model, "openai-codex/gpt-6-astra");
		assert.equal(answerContract.launch.thinking, "off");
		assert.equal(answerContract.output, false);
		assert.deepEqual(answerContract.effectiveAcceptance, questionContract.effectiveAcceptance);
	});
	const beforeDuplicate = calls().length;
	await invoke("agent_runs", { action: "answer", id: questionId, questionId: pending.questionId, message: "Use the stable answer." });
	assert.equal(calls().length, beforeDuplicate);
	assert.equal(resolvedQuestions.filter((id) => id === pending.questionId).length, 2, "same-answer retries repeat the idempotent presence-resolution event");
	await assert.rejects(() => invoke("agent_runs", { action: "answer", id: questionId, questionId: pending.questionId, message: "A conflicting answer." }), /different saved answer/);
	assert.equal(resolvedQuestions.filter((id) => id === pending.questionId).length, 2, "failed durable writes must not emit resolution");
	const cancelledRun = await invoke("delegate", { agent: "probe", task: "CREATE_QUESTION", async: false, output: false });
	const cancelledQuestion = (await invoke("agent_runs", { action: "questions", id: cancelledRun.details.runId })).details.questions[0];
	await invoke("agent_runs", { action: "stop", id: cancelledRun.details.runId });
	assert.ok(resolvedQuestions.includes(cancelledQuestion.questionId));
	assert.equal((await invoke("agent_runs", { action: "questions", id: cancelledRun.details.runId })).details.questions[0].state, "cancelled");
	evidence.checks.push("answer/retry/cancel emit question-resolution only after durable writes; conflicts emit nothing");
	try { await invoke("delegate", { agent: "probe", task: "PERMANENT_FAILURE", async: false, output: false }); } catch {}
	const batch = [];
	for (let index = 0; index < 52; index += 4) batch.push(...await Promise.all(Array.from({ length: 4 }, (_, child) => invoke("delegate", { agent: "probe", task: `History result ${index + child}`, async: false, output: false }))));
	assert.equal((await inspect(originalId)).details.run.state, "completed");
	let failedId;
	const listed = await invoke("agent_runs", { action: "list", limit: 100 });
	failedId = listed.details.runs.find((run) => run.state === "failed")?.runId;
	assert.ok(failedId);
	const onePage = await invoke("agent_runs", { action: "list", limit: 1 });
	assert.ok(onePage.details.runs[0].attention.length);
	assert.ok(!onePage.details.runs[0].attention.includes("unreviewed"), "an older failure or paused run precedes newer unreviewed completions");
	const secondPage = await invoke("agent_runs", { action: "list", limit: 1, offset: onePage.details.runList.nextOffset });
	assert.notEqual(onePage.details.runs[0].runId, secondPage.details.runs[0].runId);
	assert.ok(listed.details.runs.some((run) => run.attention.includes("unreviewed")));
	const beforePassive = calls().length, nudgesBefore = nudgeDeliveries;
	await invoke("agent_runs", { action: "review", id: originalId, decision: "accepted", message: "Parent checked the handoff." });
	await invoke("agent_runs", { action: "review", id: failedId, decision: "needs_changes", message: "Keep the failure separate." });
	await invoke("agent_runs", { action: "nudge", id: originalId, message: "Late nudge must not restart." });
	await inspect(originalId);
	assert.equal(calls().length, beforePassive);
	assert.equal(nudgeDeliveries, nudgesBefore);
	assert.equal((await inspect(failedId)).details.run.state, "failed");
	const unknownId = batch[0].details.runId;
	fs.rmSync(path.join(getRunMetadataDir(unknownId), "foreground.json"));
	const unknownOwnership = session.sessionManager.getEntries().findLast((entry) => entry.type === "custom" && entry.customType === "subagent-run" && entry.data.runId === unknownId).data;
	session.sessionManager.appendCustomEntry("subagent-run", { ...unknownOwnership, children: [] });
	const missingId = batch[1].details.runId;
	fs.rmSync((await inspect(missingId)).details.run.children[0].sessionFile);
	await close();
	fs.rmSync(runtimeDir, { recursive: true, force: true });
	await open(parentFile);
	const afterCleanup = await invoke("agent_runs", { action: "list", limit: 3 });
	evidence.ownedRunCount = afterCleanup.details.runList.total;
	assert.ok(evidence.ownedRunCount > 50);
	const recovered = (await inspect(originalId)).details.run;
	assert.equal(recovered.review.decision, "accepted");
	assert.equal((await inspect(failedId)).details.run.review.decision, "needs_changes");
	assert.equal(recovered.state, "completed");
	assert.equal(recovered.children[0].result.finalOutput, "FIRST_SESSION_TOKEN");
	assert.equal((await inspect(continuedId)).details.run.children[0].result.finalOutput, "RECALLED FIRST_SESSION_TOKEN");
	assert.equal((await inspect(unknownId)).details.run.state, "unknown");
	assert.equal((await inspect(missingId)).details.run.children[0].missingSession, true);
	await assert.rejects(() => invoke("agent_runs", { action: "continue", id: missingId, message: "Do not invent a missing session." }), /unavailable/);
	const afterLoss = await invoke("agent_runs", { action: "continue", id: originalId, message: "RECALL_TOKEN after temp cleanup." });
	assert.equal((await completed(afterLoss.details.asyncId)).results[0].output, "RECALLED FIRST_SESSION_TOKEN");
	evidence.checks.push("more than 50 results, durable review/config/result, temp cleanup, and truthful missing/unconfirmed artifacts");
	await close();
	const other = newParent(path.join(root, "unrelated.jsonl"));
	await open(other);
	assert.equal((await invoke("agent_runs", { action: "list" })).details.runList.total, 0);
	await assert.rejects(() => inspect(originalId), /not found/);
	assert.equal((await inspect(afterLoss.details.asyncId)).details.managementControl.state, "completed");
	assert.equal((await invoke("agent_runs", { action: "list" })).details.runList.total, 0, "explicit legacy inspection must not adopt the run");
	await close();
	const fork = sdk.SessionManager.forkFrom(parentFile, cwd, path.join(root, "forks"));
	await open(fork.getSessionFile());
	assert.equal((await invoke("agent_runs", { action: "list" })).details.runList.total, 0);
	await close();
	evidence.checks.push("unrelated and forked parent sessions do not adopt owned runs");
	// Reconstruct a pre-update saved parent from its actual header and original tool receipt.
	const header = JSON.parse(fs.readFileSync(parentFile, "utf8").split("\n")[0]);
	const legacyFile = path.join(root, "legacy-parent.jsonl");
	fs.writeFileSync(legacyFile, `${JSON.stringify(header)}\n`);
	const legacy = sdk.SessionManager.open(legacyFile);
	legacy.appendMessage(originalReceipt);
	const stripped = batch[2];
	assert.equal(stripped.details.results[0].finalOutput, undefined, "use the actual compact intercom receipt");
	legacy.appendMessage({ role: "toolResult", toolCallId: "legacy-stripped", toolName: "delegate", content: stripped.content, details: stripped.details, isError: false, timestamp: Date.now() });
	fs.rmSync(path.join(QUESTIONS_DIR, stripped.details.runId), { recursive: true, force: true });
	fs.rmSync(path.join(QUESTIONS_DIR, originalId), { recursive: true, force: true });
	await open(legacyFile);
	assert.equal((await inspect(originalId)).details.run.state, "completed");
	assert.equal((await inspect(stripped.details.runId)).details.run.children[0].result.finalOutput, "FIRST_SESSION_TOKEN", "recover an output-stripped receipt from its native child session");
	const beforeLegacy = calls().length;
	await assert.rejects(() => invoke("agent_runs", { action: "continue", id: originalId, message: "Do not guess the old profile." }), /predates saved launch/);
	assert.equal(calls().length, beforeLegacy);
	const explicitlyRecovered = await invoke("agent_runs", { action: "continue", id: originalId, agent: "probe", message: "RECALL_TOKEN with explicitly selected profile." });
	await completed(explicitlyRecovered.details.asyncId);
	assert.ok(calls().at(-1).modelArg.startsWith("openai-codex/gpt-6-astra"));
	evidence.checks.push("pre-update native receipt recovers handle/result/session; missing profile needs explicit override rather than silent substitution");
	await close(); await open(parentFile);
	// The legacy case deleted the first run's metadata; these earlier handles are untouched.
	const coldRuns = [];
	for (const [id, decision] of [[questionId, "accepted"], [answered.details.asyncId, "needs_changes"]]) {
		const reviewed = await invoke("agent_runs", { action: "review", id, decision });
		coldRuns.push(runSnapshot(reviewed.details.run));
	}
	evidence.coldParent = { parentFile, runs: coldRuns, total: (await invoke("agent_runs", { action: "list" })).details.runList.total };
}
async function runColdParent() {
	const prior = JSON.parse(fs.readFileSync(path.join(root, "evidence.json"), "utf8"));
	assert.notEqual(process.pid, prior.parentPid, "cold recovery must run in a new parent OS process");
	assert.equal(parentFile, prior.coldParent.parentFile);
	await open(parentFile);
	const before = calls().length;
	for (const expected of prior.coldParent.runs) assert.deepEqual(runSnapshot((await inspect(expected.runId)).details.run), expected);
	assert.equal((await invoke("agent_runs", { action: "list" })).details.runList.total, prior.coldParent.total);
	assert.equal(calls().length, before, "cold inspection must not launch a child");
	evidence.checks.push("new parent OS process restores original foreground/background handles, results, review, configuration and lineage from the same saved directories");
	const [foreground, background] = prior.coldParent.runs;
	const previousEntryCount = sdk.SessionManager.open(background.sessionFile).getEntries().length;
	const continued = await invoke("agent_runs", { action: "continue", id: background.runId, message: "RECALL_TOKEN after a cold parent process restart." });
	const result = await completed(continued.details.asyncId);
	assert.equal(result.success, true);
	const newEntries = sdk.SessionManager.open(background.sessionFile).getEntries().slice(previousEntryCount);
	assert.ok(newEntries.some((entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.content.some((part) => part.type === "text" && part.text.startsWith("RECALLED FIRST_SESSION_TOKEN"))), "cold continuation must recall the original conversation before acceptance finalization");
	const call = calls().at(-1);
	assert.equal(call.sessionFile, background.sessionFile);
	assert.equal(call.modelArg, "openai-codex/gpt-6-astra:off");
	assert.ok(call.previousMessages >= 4);
	const continuation = (await inspect(continued.details.asyncId)).details.run;
	assert.equal(continuation.rootRunId, foreground.runId);
	assert.equal(continuation.predecessorRunId, background.runId);
	assert.equal(continuation.review, undefined);
	assert.deepEqual(continuation.children[0].launch.effectiveAcceptance, background.launch.effectiveAcceptance);
	assert.ok((await inspect(foreground.runId)).details.run.continuations.some((next) => next.runId === continuation.runId && next.predecessorRunId === background.runId));
	evidence.coldParent = { originalPid: prior.parentPid, parentFile, foregroundId: foreground.runId, backgroundId: background.runId, continuedId: continuation.runId };
	evidence.checks.push("cold-process continuation reuses the saved child conversation, provider/thinking and acceptance, with a new review outcome and linked lineage");
}
try {
	if (coldParent) await runColdParent();
	else await runJourney();
	assert.equal(evidence.nativeProviderRequests, 0);
} catch (error) {
	evidence.failures.push(error.stack ?? String(error));
	process.exitCode = 1;
} finally {
	await close();
	fs.writeFileSync(path.join(root, coldParent ? "cold-evidence.json" : "evidence.json"), JSON.stringify(evidence, null, 2));
	console.log(JSON.stringify(evidence, null, 2));
}
