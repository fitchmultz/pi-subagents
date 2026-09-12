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
const { QUESTIONS_DIR, getRunMetadataDir, readQuestionContract, saveQuestionContract, questionProcessAlive } = await import(pathToFileURL(path.join(repo, "dist/runs/shared/supervisor-questions.js")).href);
const evidence = { nativeProviderRequests: 0, failures: [], checks: [], root, parentPid: process.pid, nodeVersion: process.version, sdkRoot };
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
	const liveReview = await invoke("agent_runs", { action: "review", id: slow.details.runId, decision: "accepted" });
	assert.equal(liveReview.isError, true);
	assert.match(JSON.stringify(liveReview.content), /still live/);
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
	const replacementCwd = path.join(cwd, "replacement");
	fs.mkdirSync(path.join(replacementCwd, "replacement"), { recursive: true });
	const answerParams = { action: "answer", id: questionId, questionId: pending.questionId, message: "Use the stable answer.", cwd: "replacement" };
	const beforeAnswer = calls().length;
	assert.equal(questionProcessAlive(pending), false, "the original question child must have exited before revival");
	const answered = await invoke("agent_runs", answerParams);
	await completed(answered.details.asyncId);
	const answerCalls = calls().slice(beforeAnswer);
	const answerContract = readQuestionContract(answered.details.asyncId, 0);
	check("saved question revival keeps actual model, off thinking, output and acceptance", () => {
		assert.equal(answerContract.launch.model, "openai-codex/gpt-6-astra");
		assert.equal(answerContract.launch.thinking, "off");
		assert.equal(answerContract.output, false);
		assert.deepEqual(answerContract.effectiveAcceptance, questionContract.effectiveAcceptance);
	});
	const beforeDuplicate = calls().length;
	const repeatedAnswer = await invoke("agent_runs", answerParams);
	assert.equal(calls().length, beforeDuplicate);
	assert.equal(repeatedAnswer.details.questions[0].delivery.runId, answered.details.asyncId);
	const answerContinuations = (await inspect(questionId)).details.run.continuations;
	evidence.questionContinuation = { questionId: pending.questionId, originalRunId: questionId, exitedChildPid: pending.pid, continuedRunId: answered.details.asyncId, sessionFile: pending.sessionFile, requestedCwd: replacementCwd, answerCalls, answerContinuations, beforeDuplicate, afterDuplicate: calls().length };
	check("exited question answer resolves relative cwd once and repeated answers do not launch again", () => {
		assert.equal(answerCalls.filter((call) => call.task.includes(`Supervisor answer to question ${pending.questionId}:`)).length, 1);
		assert.deepEqual(answerContinuations.map((run) => run.runId), [answered.details.asyncId]);
		assert.deepEqual([...new Set(answerCalls.map((call) => call.cwd))], [fs.realpathSync(replacementCwd)]);
		assert.equal(answerContract.launch.cwd, replacementCwd);
	});
	assert.equal(resolvedQuestions.filter((id) => id === pending.questionId).length, 2, "same-answer retries repeat the idempotent presence-resolution event");
	const conflictingAnswer = await invoke("agent_runs", { action: "answer", id: questionId, questionId: pending.questionId, message: "A conflicting answer." });
	assert.equal(conflictingAnswer.isError, true);
	assert.match(JSON.stringify(conflictingAnswer.content), /different saved answer/);
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
	saveQuestionContract(unknownId, 0, { result: undefined });
	const childEvidenceId = batch[3].details.runId;
	fs.rmSync(path.join(getRunMetadataDir(childEvidenceId), "foreground.json"));
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
	const fromChildEvidence = (await inspect(childEvidenceId)).details.run;
	assert.equal(fromChildEvidence.state, "completed", "a persisted child result remains authoritative without the aggregate file");
	assert.equal(fromChildEvidence.children[0].result.finalOutput, "FIRST_SESSION_TOKEN");
	assert.equal((await inspect(missingId)).details.run.children[0].missingSession, true);
	const missingSession = await invoke("agent_runs", { action: "continue", id: missingId, message: "Do not invent a missing session." });
	assert.equal(missingSession.isError, true);
	assert.match(JSON.stringify(missingSession.content), /unavailable/);
	const afterLoss = await invoke("agent_runs", { action: "continue", id: originalId, message: "RECALL_TOKEN after temp cleanup." });
	assert.equal((await completed(afterLoss.details.asyncId)).results[0].output, "RECALLED FIRST_SESSION_TOKEN");
	evidence.checks.push("more than 50 results, durable review/config/result, temp cleanup, and truthful missing/unconfirmed artifacts");
	await close();
	const other = newParent(path.join(root, "unrelated.jsonl"));
	await open(other);
	assert.equal((await invoke("agent_runs", { action: "list" })).details.runList.total, 0);
	const foreignInspection = await inspect(originalId);
	assert.equal(foreignInspection.isError, true);
	assert.match(JSON.stringify(foreignInspection.content), /not found/);
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
	const missingProfile = await invoke("agent_runs", { action: "continue", id: originalId, message: "Do not guess the old profile." });
	assert.equal(missingProfile.isError, true);
	assert.match(JSON.stringify(missingProfile.content), /predates saved launch/);
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
	evidence.questionContinuation.nativeAnswerMessages = sdk.SessionManager.open(pending.sessionFile).getEntries().filter((entry) => entry.type === "message" && entry.message.role === "user" && JSON.stringify(entry.message.content).includes(`Supervisor answer to question ${pending.questionId}:`)).length;
	assert.equal(evidence.questionContinuation.nativeAnswerMessages, 1, "the saved native conversation must contain exactly one delivered answer after the retry");
	evidence.coldParent = { parentFile, runs: coldRuns, total: (await invoke("agent_runs", { action: "list" })).details.runList.total };
}
async function runLegacyAsync() {
	const route = phase.slice("legacy-async-".length);
	const owner = sdk.SessionManager.create(cwd, path.join(root, "legacy-parent"));
	const child = sdk.SessionManager.create(cwd, path.join(root, "legacy-child"));
	const ownerFile = owner.getSessionFile(), sessionFile = child.getSessionFile(), runId = randomUUID();
	const output = `LEGACY_ASYNC_${route.toUpperCase()}`;
	const assistant = { role: "assistant", content: [{ type: "text", text: output }], provider: "openai", model: "gpt-6-astra", api: "openai-responses", stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() };
	owner.appendMessage({ role: "user", content: "Recover the saved background task.", timestamp: Date.now() });
	owner.appendMessage({ ...assistant, content: [{ type: "text", text: "Saved native parent before the update." }] });
	child.appendMessage({ role: "user", content: `Return ${output}`, timestamp: Date.now() });
	child.appendMessage(assistant);
	const { ASYNC_DIR, RESULTS_DIR } = await import(pathToFileURL(path.join(repo, "dist/shared/types.js")).href);
	const asyncDir = path.join(ASYNC_DIR, runId), oldResultPath = path.join(RESULTS_DIR, `${runId}.json`);
	fs.mkdirSync(asyncDir, { recursive: true });
	fs.mkdirSync(RESULTS_DIR, { recursive: true });
	const endedAt = Date.now(), startedAt = endedAt - 1000;
	const status = { runId, sessionId: ownerFile, mode: "single", state: "complete", cwd, startedAt, endedAt, lastUpdate: endedAt, currentStep: 0, chainStepCount: 1, sessionFile, steps: [{ agent: "probe", status: "complete", model: "openai/gpt-6-astra", sessionFile, startedAt, endedAt, exitCode: 0 }] };
	const result = { id: runId, sessionId: ownerFile, mode: "single", state: "complete", success: true, cwd, asyncDir, sessionFile, timestamp: endedAt, exitCode: 0, results: [{ agent: "probe", model: "openai/gpt-6-astra", sessionFile, success: true, exitCode: 0, output }] };
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(status));
	if (route !== "status-session") {
		fs.writeFileSync(path.join(asyncDir, "output-0.log"), output);
		fs.writeFileSync(oldResultPath, JSON.stringify(result));
	}
	if (route === "receipt-result") {
		const toolCallId = randomUUID();
		owner.appendMessage({ ...assistant, stopReason: "toolUse", content: [{ type: "toolCall", id: toolCallId, name: "subagent", arguments: { agent: "probe", task: `Return ${output}`, async: true, output: false } }] });
		owner.appendMessage({ role: "toolResult", toolCallId, toolName: "subagent", content: [{ type: "text", text: `Async: probe [${runId}]` }], details: { mode: "single", runId, results: [], asyncId: runId, asyncDir }, isError: false, timestamp: Date.now() });
	}
	fs.copyFileSync(ownerFile, path.join(root, "legacy-parent-before.jsonl"));
	const legacy = evidence.legacyAsync = { route, runId, ownerFile, ownerSessionId: owner.getSessionId(), childSessionId: child.getSessionId(), sessionFile, status, result: route === "status-session" ? null : result, nonOwners: [] };
	check("legacy fixture uses persisted native sessions and the .35 saved-file async identity without .36 metadata", () => {
		assert.equal(sdk.SessionManager.open(ownerFile).getSessionId(), owner.getSessionId());
		assert.notEqual(status.sessionId, owner.getSessionId());
		assert.equal(owner.getEntries().some((entry) => entry.type === "custom" && entry.customType === "subagent-run"), false);
		assert.equal(fs.existsSync(getRunMetadataDir(runId)), false);
	});
	const assertUnowned = async (file, label) => {
		await open(file);
		const total = (await invoke("agent_runs", { action: "list" })).details.runList.total;
		legacy.nonOwners.push({ label, file, sessionId: session.sessionManager.getSessionId(), total });
		assert.notEqual(session.sessionManager.getSessionId(), owner.getSessionId());
		assert.equal(total, 0, `${label} must not adopt the saved parent's async work`);
		await close();
	};
	await assertUnowned(newParent(path.join(root, "unrelated.jsonl")), "foreign parent");
	await assertUnowned(sdk.SessionManager.forkFrom(ownerFile, cwd, path.join(root, "legacy-forks")).getSessionFile(), "fork with legacy receipts");
	assert.equal(fs.existsSync(getRunMetadataDir(runId)), false, "non-owners must not migrate another parent's metadata");
	await open(ownerFile);
	legacy.beforeCleanup = await inspect(runId);
	legacy.durableBeforeCleanup = { status: fs.existsSync(path.join(getRunMetadataDir(runId), "status.json")), result: fs.existsSync(resultFile(runId)) };
	await close();
	fs.rmSync(runtimeDir, { recursive: true, force: true });
	legacy.tempRemoved = !fs.existsSync(runtimeDir);
	await open(ownerFile);
	try { legacy.afterCleanup = await inspect(runId); } catch (error) { legacy.afterCleanup = { error: error.message }; }
	check("owning native parent retains the original async handle, terminal result, and child session after temp removal", () => {
		const recovered = legacy.afterCleanup.details?.run;
		assert.ok(recovered, JSON.stringify(legacy.afterCleanup));
		assert.equal(recovered.state, "completed");
		assert.equal(recovered.runId, runId);
		assert.equal(recovered.ownerSessionId, owner.getSessionId());
		assert.equal(recovered.legacy, true);
		assert.equal(recovered.children[0].sessionFile, sessionFile);
		assert.equal(recovered.children[0].result.finalOutput, output);
		assert.equal(recovered.children[0].configuration, "legacy-partial");
		assert.deepEqual(legacy.durableBeforeCleanup, { status: true, result: true });
		assert.equal(JSON.parse(fs.readFileSync(resultFile(runId), "utf8")).results[0].output, output);
		assert.equal(sdk.SessionManager.open(sessionFile).getSessionId(), child.getSessionId());
		assert.equal(fs.existsSync(asyncDir), false);
		assert.equal(fs.existsSync(oldResultPath), false);
		assert.ok(session.sessionManager.getEntries().some((entry) => entry.type === "custom" && entry.customType === "subagent-run" && entry.data.runId === runId && entry.data.ownerSessionId === owner.getSessionId()));
	});
	await close();
	await assertUnowned(sdk.SessionManager.forkFrom(ownerFile, cwd, path.join(root, "owned-forks")).getSessionFile(), "fork with durable ownership entries");
	assert.equal(calls().length, 0, "legacy recovery must not launch child work");
}
async function runWorkflowOutcomes() {
	const { asyncStatusToSummary, listAsyncRuns } = await import(pathToFileURL(path.join(repo, "dist/runs/background/async-status.js")).href);
	acknowledgeResults = true;
	const notifications = [], completions = [];
	bus.on("subagent:result-intercom", (message) => notifications.push(message));
	bus.on("subagent:async-complete", (message) => completions.push(message));
	await open(parentFile);
	// The native slash bridge calls the same owning executor and retains its rich
	// error content/details without going through the registered tool hooks.
	const execute = (params) => new Promise((resolve) => {
		const requestId = randomUUID();
		const unsubscribe = bus.on("subagent:slash:response", (message) => {
			if (message.requestId !== requestId) return;
			unsubscribe(); resolve(message.result);
		});
		bus.emit("subagent:slash:request", { requestId, params });
	});
	const verify = (name, run) => {
		try { check(name, run); } catch (error) { evidence.failures.push(`${name}: ${error.stack ?? error}`); }
	};
	const response = (text, value) => `WORKFLOW_RESPONSE:${JSON.stringify({ text, ...(value === undefined ? {} : { value }) })}`;
	const producer = (items) => ({ agent: "probe", task: response("WORKFLOW_TARGETS", { items }), as: "targets", output: false, outputSchema: { type: "object" } });
	const fanout = {
		expand: { from: { output: "targets", path: "/items" }, key: "/path", maxItems: 1, onEmpty: "skip" },
		parallel: { agent: "probe", task: response("REVIEWED {item.path}", { ok: "{item.path}" }), output: false, outputSchema: { type: "object" } },
		collect: { as: "reviews" },
	};
	const rejectedCollection = { ...fanout, collect: { as: "reviews", outputSchema: { type: "object" } } };
	const consumer = { agent: "probe", task: `Use {outputs.reviews}\n${response("EMPTY_COLLECTION_CONSUMED")}`, output: false };
	const cases = [
		{ name: "collection-rejected", chain: [producer([{ path: "src/a.ts" }]), rejectedCollection], expected: ["WORKFLOW_TARGETS", "REVIEWED src/a.ts"], error: /Collected output validation failed/ },
		{ name: "empty-fanout", chain: [producer([]), fanout, consumer], expected: ["WORKFLOW_TARGETS", "EMPTY_COLLECTION_CONSUMED"] },
		{ name: "expansion-rejected", chain: [producer([{ path: "src/a.ts" }, { path: "src/b.ts" }]), fanout, consumer], expected: ["WORKFLOW_TARGETS"], error: /exceeding maxItems 1/ },
		{ name: "empty-collection-rejected", chain: [producer([]), rejectedCollection, consumer], expected: ["WORKFLOW_TARGETS"], error: /Collected output validation failed/ },
		{ name: "before-launch-rejected", chain: [{ agent: "probe", task: "Never start first", as: "duplicate", output: false }, { agent: "probe", task: "Never start second", as: "duplicate", output: false }], expected: [], error: /Duplicate chain output name/ },
	];
	evidence.workflows = [];
	for (const background of [false, true]) for (const scenario of cases) {
		const name = `${background ? "background" : "foreground"}-${scenario.name}`;
		const beforeCalls = calls().length;
		const result = await execute({ chain: scenario.chain, task: name, async: background, context: "fresh", artifacts: false });
		const id = result.details.runId;
		assert.ok(id, `${name}: native owning executor must return its run handle`);
		const terminal = result.details.asyncId ? await completed(id) : result.details;
		if (result.details.asyncId) await wait(() => completions.some((message) => message.runId === id), `${name} acknowledged completion`);
		const childCalls = calls().slice(beforeCalls);
		const emitted = notifications.filter((message) => message.runId === id);
		const receipt = { name, runId: id, result, terminal, childCalls, notifications: emitted, inspections: [] };
		evidence.workflows.push({ name, runId: id, calls: childCalls.length, notifications: emitted.map((message) => message.status) });
		verify(`${name}: only required child processes execute`, () => {
			assert.equal(childCalls.length, scenario.expected.length);
			if (!scenario.error) assert.match(childCalls[1].task, /Use \[\]/);
		});
		verify(`${name}: collection publication follows workflow validation`, () => {
			if (scenario.error) {
				assert.equal(terminal.outputs?.reviews, undefined);
				if (result.details.asyncId) assert.equal(terminal.success, false);
				else assert.equal(result.isError, true);
			} else {
				assert.deepEqual(terminal.outputs.reviews.structured, []);
				assert.equal(terminal.workflowGraph.nodes[1].status, "completed");
				assert.deepEqual(terminal.workflowGraph.nodes[1].children, []);
			}
		});
		verify(`${name}: acknowledged grouped delivery reports the workflow outcome and reason`, () => {
			assert.equal(emitted.length, scenario.expected.length ? 1 : 0);
			if (!emitted.length) return;
			const notification = emitted[0];
			assert.equal(notification.status, scenario.error ? "failed" : "completed");
			assert.deepEqual(notification.children.filter((child) => child.status === "completed").map((child) => child.summary), scenario.expected);
			if (scenario.error) assert.match(notification.message, scenario.error);
			if (!background) {
				assert.equal(result.details.intercomDelivery.delivered, true);
				assert.equal(result.details.intercomDelivery.status, notification.status);
				if (scenario.error) assert.match(result.content.map((part) => part.text).join("\n"), scenario.error);
			}
		});
		for (const checkpoint of ["before reload", "after reload", "after reopen"]) {
			if (checkpoint === "after reload") await session.reload();
			if (checkpoint === "after reopen") { await close(); await open(parentFile); }
			const inspection = await inspect(id);
			const run = inspection.details.run;
			const list = (await invoke("agent_runs", { action: "list", limit: 100 })).details.runs.find((entry) => entry.runId === id);
			receipt.inspections.push({ checkpoint, inspection, list });
			if (result.details.asyncId) verify(`${name}: saved async summaries survive ${checkpoint}`, () => {
				const asyncDir = result.details.asyncDir;
				const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf8"));
				const summary = asyncStatusToSummary(asyncDir, status);
				receipt.inspections.at(-1).asyncSummary = summary;
				assert.equal(summary.chainStepCount, scenario.chain.length);
				assert.equal(summary.steps.length, status.steps.length);
				assert.deepEqual(summary.parallelGroups, status.parallelGroups);
				assert.equal(summary.state, terminal.state);
				assert.deepEqual(listAsyncRuns(path.dirname(asyncDir), { sessionId: session.sessionFile }).find((entry) => entry.id === id), summary);
			});
			if (result.details.asyncId && !scenario.error) verify(`${name}: empty fanout retains logical progress ${checkpoint}`, () => {
				const text = inspection.content.map((part) => part.text).join("\n");
				const last = scenario.chain.length;
				assert.ok(text.includes(`Progress: step ${last}/${last}`), text);
				assert.ok(text.includes(`Step ${last}/${last}: probe complete`), text);
			});
			verify(`${name}: inspect/list outcome and attention ${checkpoint}`, () => {
				const expected = scenario.error ? "failed" : "completed";
				assert.equal(run.state, expected);
				assert.equal(inspection.details.managementControl.state, expected);
				assert.equal(list.state, expected);
				assert.deepEqual(run.attention, [scenario.error ? "failed" : "unreviewed"]);
				assert.deepEqual(list.attention, run.attention);
				assert.equal(run.review, undefined);
			});
			verify(`${name}: successful native child evidence is retained ${checkpoint}`, () => {
				const successful = run.children.filter((child) => child.state === "completed");
				assert.deepEqual(successful.map((child) => child.result.finalOutput), scenario.expected);
				assert.deepEqual(successful.map((child) => child.index), scenario.expected.map((_, index) => index));
				assert.deepEqual(successful.map((child) => child.sessionFile), childCalls.map((call) => call.sessionFile));
				for (const child of successful) {
					assert.equal(child.result.exitCode, 0);
					const messages = sdk.SessionManager.open(child.sessionFile).getEntries().filter((entry) => entry.type === "message").map((entry) => entry.message);
					assert.ok(messages.some((message) => message.role === "assistant" && message.content.some((part) => part.type === "text" && part.text === child.result.finalOutput)));
					if (child.result.structuredOutput !== undefined) assert.ok(messages.some((message) => message.role === "toolResult" && message.toolName === "structured_output" && message.isError === false));
				}
			});
			verify(`${name}: terminal views exclude unexpanded declared children ${checkpoint}`, () => {
				// Background failures also retain the runner's explicit diagnostic result.
				const expectedCount = background && result.details.asyncId ? terminal.results.length : scenario.expected.length;
				assert.equal(run.children.length, expectedCount);
				assert.ok(run.children.every((child) => child.state !== "unknown"));
				if (scenario.error && !background) assert.match(run.diagnosis, scenario.error);
			});
		}
		verify(`${name}: reload does not relaunch children or redeliver completion`, () => {
			assert.equal(calls().length, beforeCalls + childCalls.length);
			assert.equal(notifications.filter((message) => message.runId === id).length, emitted.length);
		});
		fs.writeFileSync(path.join(root, `${name}.json`), JSON.stringify(receipt, null, 2));
	}
	if (evidence.failures.length) process.exitCode = 1;
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
	else if (phase === "workflow-outcomes") await runWorkflowOutcomes();
	else if (phase.startsWith("legacy-async-")) await runLegacyAsync();
	else await runJourney();
	assert.equal(evidence.nativeProviderRequests, 0);
} catch (error) {
	evidence.failures.push(error.stack ?? String(error));
	process.exitCode = 1;
} finally {
	await close();
	fs.writeFileSync(path.join(root, coldParent ? "cold-evidence.json" : phase === "workflow-outcomes" ? "workflow-evidence.json" : phase.startsWith("legacy-async-") ? "legacy-evidence.json" : "evidence.json"), JSON.stringify(evidence, null, 2));
	console.log(JSON.stringify(evidence, null, 2));
}
