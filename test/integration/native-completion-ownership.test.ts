import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { findPackageJSON } from "node:module";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { after, test } from "node:test";
import { Type } from "typebox";

const root = fs.mkdtempSync(path.join(tmpdir(), "native-completion-ownership-"));
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
process.env.PI_SUBAGENT_TEMP_ROOT = path.join(root, "pi-subagents-runtime");
process.env.PI_OFFLINE = "1";
after(() => fs.rmSync(root, { recursive: true, force: true }));
const sdkRoot = process.env.PI_INTERCOM_TEST_SDK ?? path.dirname(findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url)!);
const sdkEntry = pathToFileURL(path.join(sdkRoot, "dist/index.js"));
const sdk = await import(sdkEntry.href);
const aiRoot = path.dirname(findPackageJSON("@earendil-works/pi-ai", sdkEntry)!);
const ai = await import(pathToFileURL(path.join(aiRoot, "dist/index.js")).href);
const { bindNativeInvocation } = await import("../../src/runs/shared/native-async.ts");
const { getRunMetadataDir, saveQuestionOwner, saveRunStatus, saveAsyncRunResult, createSupervisorQuestion, saveQuestionAnswer, recordQuestionDelivery } = await import("../../src/runs/shared/supervisor-questions.ts");
const { RESULTS_DIR } = await import("../../src/shared/types.ts");
const { default: registerRoot } = await import("../../src/extension/index.ts");
const { default: registerChild } = await import("../../src/extension/fanout-child.ts");

for (const childSafe of [false, true]) for (const drop of [false, true]) test(`${childSafe ? "child-safe" : "root"} queued completion ${drop ? "retries once after being dropped" : "survives streaming beyond the TTL"}`, async (t) => {
	const previousChild = process.env.PI_SUBAGENT_CHILD, previousFanout = process.env.PI_SUBAGENT_FANOUT_CHILD;
	process.env.PI_SUBAGENT_CHILD = childSafe ? "1" : "0";
	process.env.PI_SUBAGENT_FANOUT_CHILD = childSafe ? "1" : "0";
	t.after(() => {
		if (previousChild === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = previousChild;
		if (previousFanout === undefined) delete process.env.PI_SUBAGENT_FANOUT_CHILD; else process.env.PI_SUBAGENT_FANOUT_CHILD = previousFanout;
	});
	const cwd = fs.mkdtempSync(path.join(root, "queued-"));
	const manager = sdk.SessionManager.create(cwd, path.join(cwd, "sessions"));
	manager.appendMessage(ai.fauxAssistantMessage("Delegate bounded work"));
	const runId = randomUUID(), asyncDir = getRunMetadataDir(runId);
	manager.appendCustomEntry("subagent-run", { runId, rootRunId: runId, ownerSessionId: manager.getSessionId(), source: "async", mode: "single",
		cwd, task: "Bounded work", startedAt: Date.now(), asyncDir, children: [{ agent: "worker", index: 0 }] });
	saveQuestionOwner(runId, manager.getSessionId());
	const sent = [], errors = [];
	let release, ctx;
	const settingsManager = sdk.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: { enabled: false } });
	const loader = new sdk.DefaultResourceLoader({ cwd, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager,
		noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
		extensionFactories: [(pi) => {
			const send = pi.sendMessage.bind(pi);
			pi.sendMessage = (message, options) => {
				if (message.customType === "subagent-notify") sent.push(message);
				send(message, options);
			};
			(childSafe ? registerChild : registerRoot)(pi);
			pi.on("session_start", (_event, context) => { ctx = context; });
			pi.registerTool({ name: "hold_turn", label: "Hold", description: "Hold this fixture turn", parameters: Type.Object({}),
				async execute(_id, _params, signal) {
					await new Promise<void>((resolve) => { release = resolve; signal?.addEventListener("abort", () => resolve(), { once: true }); });
					return { content: [{ type: "text", text: "Released" }], details: {} };
				},
			});
		}],
	});
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const faux = ai.fauxProvider({ provider: "queued-completion-fixture", tokensPerSecond: 1000000 });
	faux.setResponses([ai.fauxAssistantMessage(ai.fauxToolCall("hold_turn", {}, { id: "hold" }), { stopReason: "toolUse" }),
		ai.fauxAssistantMessage("Finished held turn"), ai.fauxAssistantMessage("Completion received")]);
	const modelRuntime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	modelRuntime.registerNativeProvider(faux.provider);
	const { session } = await sdk.createAgentSession({ cwd, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager, resourceLoader: loader,
		sessionManager: manager, modelRuntime, model: faux.getModel() });
	const until = async (check, reason) => {
		const deadline = performance.now() + 5000;
		while (!check()) { assert.ok(performance.now() < deadline, reason); await delay(10); }
	};
	const notices = () => manager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "subagent-notify");
	const delivered = () => manager.getEntries().some((entry) => entry.type === "custom" && entry.customType === "subagent-run" && entry.data.runId === runId && entry.data.delivery);
	let prompt;
	try {
		await session.bindExtensions({ mode: "json", onError: (error) => errors.push(error) });
		prompt = session.prompt("Hold the parent turn while its child completes");
		await until(() => release, "native parent tool starts");
		assert.equal(ctx.isIdle(), false);
		saveRunStatus(runId, { runtimeVersion: 2, runId, mode: "single", sessionId: manager.getSessionFile(), state: "complete",
			startedAt: Date.now(), lastUpdate: Date.now(), cwd, steps: [{ agent: "worker", status: "complete" }] });
		saveAsyncRunResult(runId, { runtimeVersion: 2, id: runId, mode: "single", sessionId: manager.getSessionFile(), state: "complete",
			success: true, timestamp: Date.now(), summary: "QUEUED_RESULT", results: [{ agent: "worker", success: true, exitCode: 0, output: "QUEUED_RESULT" }] });
		t.mock.timers.tick(3000);
		await until(() => sent.length === 1, "completion reaches the real host queue");
		assert.equal(notices().length, 0);
		assert.equal(delivered(), false, "queued is not durably delivered");
		assert.equal(session.agent.hasQueuedMessages(), true);
		if (drop) {
			session.clearQueue();
			assert.equal(session.agent.hasQueuedMessages(), false, "the real host dropped the queued wake-up");
		} else {
			for (let scan = 0; scan < 2; scan++) {
				t.mock.timers.tick(11 * 60_000);
				await delay(50);
				assert.equal(sent.length, 1, "streaming past TTL must not queue another wake-up");
			}
		}
		release();
		await prompt;
		await session.waitForIdle();
		assert.equal(ctx.isIdle(), true);
		if (drop) {
			assert.equal(notices().length, 0);
			t.mock.timers.tick(3000);
			await until(() => sent.length === 2 && notices().length === 1, "idle owner receives one retry without waiting for the TTL");
			await session.waitForIdle();
		}
		t.mock.timers.tick(3000);
		await until(delivered, "journal reconciliation records delivery");
		t.mock.timers.tick(11 * 60_000);
		await delay(50);
		assert.equal(sent.length, drop ? 2 : 1);
		assert.equal(notices().length, 1);
		assert.deepEqual(errors, []);
	} finally {
		release?.();
		await session.abort();
		await prompt?.catch(() => {});
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	}
});

for (const scenario of [
	{ name: "background launch receipt", kind: "launch", index: undefined, finished: true, receipt: true, suppress: false },
	{ name: "completed child answer", kind: "answer", index: 1, finished: true, suppress: false },
	{ name: "completed child follow-up", kind: "delivery", index: 1, finished: true, suppress: false },
	{ name: "pending child follow-up", kind: "delivery", index: 1, finished: false, suppress: false },
	{ name: "detached whole-run launch", kind: "launch", index: undefined, finished: false, suppress: true },
	{ name: "detached single-child follow-up", kind: "delivery", index: 0, mode: "single", finished: false, suppress: true },
	{ name: "failed whole-run call", kind: "launch", index: undefined, finished: true, failed: true, suppress: false },
	{ name: "consumed whole-run call", kind: "launch", index: undefined, finished: true, suppress: true },
	{ name: "persisted notice before owner/accounting save", kind: "launch", index: undefined, finished: true, receipt: true, published: true, suppress: false },
] as const) test(`registered extension routes completion after ${scenario.name}, including session reopen`, async () => {
	const cwd = fs.mkdtempSync(path.join(root, "case-"));
	const manager = sdk.SessionManager.create(cwd, path.join(cwd, "sessions"));
	manager.appendMessage(ai.fauxAssistantMessage("Delegate work"));
	const runId = randomUUID(), asyncDir = getRunMetadataDir(runId), sessionId = manager.getSessionId();
	const mode = "mode" in scenario ? scenario.mode : "parallel";
	const children = Array.from({ length: mode === "single" ? 1 : 2 }, (_, index) => ({ agent: "worker", index }));
	manager.appendCustomEntry("subagent-run", { runId, rootRunId: runId, ownerSessionId: sessionId, source: "async", mode, cwd, task: "Bounded work", startedAt: Date.now(), asyncDir, children });
	saveQuestionOwner(runId, sessionId);
	let questionId: string | undefined;
	if (scenario.kind === "answer") {
		const question = createSupervisorQuestion({ runId, ownerTarget: "parent", agent: "worker", index: scenario.index,
			childSessionId: "child", childTarget: "child", sessionFile: path.join(cwd, "child.jsonl"), cwd,
			pid: process.pid, reason: "need_decision", message: "Use this approach?" });
		saveQuestionAnswer(question, "Yes");
		recordQuestionDelivery(question, { kind: "live", runId, deliveredAt: Date.now() });
		questionId = question.questionId;
	}
	const callId = "native-call";
	if (scenario.finished) manager.appendMessage(ai.fauxAssistantMessage(
		ai.fauxToolCall("agent_runs", { action: scenario.kind === "answer" ? "answer" : "resume", id: runId, index: scenario.index }, { id: callId }),
		{ stopReason: "toolUse" }));
	if (!("receipt" in scenario)) bindNativeInvocation({ appendEntry: (type, data) => manager.appendCustomEntry(type, data) }, { sessionManager: manager }, callId,
		{ runId, index: scenario.index, kind: scenario.kind, accepted: true, ...(questionId ? { questionId, answer: "Yes" } : {}) });
	if (scenario.finished) manager.appendMessage({ role: "toolResult", toolName: "agent_runs", toolCallId: callId,
		content: [{ type: "text", text: "Call finished" }], timestamp: Date.now(), isError: "failed" in scenario,
		details: "receipt" in scenario ? { mode: "single", results: [], asyncId: runId } : "failed" in scenario ? {} : { mode: "management", results: [], wait: { runId, index: scenario.index, status: "completed" } } });
	manager.appendMessage(ai.fauxAssistantMessage("Waiting for completion"));
	const final = { runtimeVersion: 2, id: runId, mode, sessionId: manager.getSessionFile(), state: "complete", success: true, timestamp: Date.now(),
		results: children.map(({ agent, index }) => ({ agent, success: true, exitCode: 0, output: `CHILD_${index}_RESULT` })) };
	saveRunStatus(runId, { runId, runtimeVersion: 2, mode, sessionId: manager.getSessionFile(), state: "complete", startedAt: Date.now(), lastUpdate: Date.now(), cwd, steps: children.map(({ agent }) => ({ agent, status: "complete" })) });
	const saved = saveAsyncRunResult(runId, final);
	if ("published" in scenario) {
		const broken = path.join(cwd, "broken-child.jsonl");
		fs.writeFileSync(broken, '{"type":"session","id":"child","version":3}\nmalformed billing record\n');
		saved.results![0] = { ...saved.results![0], sessionFile: broken, terminalEntryId: "missing", accounting: { state: "incomplete", error: "fixture billing unavailable" } };
		const { saveQuestionContract } = await import("../../src/runs/shared/supervisor-questions.ts");
		saveQuestionContract(runId, 0, { sessionFile: broken, attemptBaseline: ["child"], terminalEntryId: "missing" });
		saveAsyncRunResult(runId, saved);
		manager.appendCustomMessageEntry("subagent-notify", "Published before crash", true, { completion: { runId, completionId: saved.completionId, key: `completion:${saved.completionId}` } });
	}
	fs.mkdirSync(RESULTS_DIR, { recursive: true });
	const notice = path.join(RESULTS_DIR, `${runId}.json`);
	fs.writeFileSync(notice, JSON.stringify(final));

	for (const reopen of [false, true]) {
		const sessionManager = reopen ? sdk.SessionManager.open(manager.getSessionFile()) : manager;
		const bus = sdk.createEventBus(), completions: Array<{ suppressNotification?: boolean }> = [], errors: unknown[] = [];
		bus.on("subagent:async-complete", (event) => completions.push(event));
		const settingsManager = sdk.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: { enabled: false } });
		const loader = new sdk.DefaultResourceLoader({ cwd, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager, eventBus: bus,
			noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
			additionalExtensionPaths: [path.resolve("src/extension/index.ts")] });
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		const faux = ai.fauxProvider({ provider: "completion-fixture", tokensPerSecond: 1000000 });
		faux.setResponses([ai.fauxAssistantMessage("Result received")]);
		const modelRuntime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
		modelRuntime.registerNativeProvider(faux.provider);
		const { session } = await sdk.createAgentSession({ cwd, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager, resourceLoader: loader, sessionManager, modelRuntime, model: faux.getModel() });
		try {
			await session.bindExtensions({ mode: "json", onError: (error) => errors.push(error) });
			await delay(150);
			await session.waitForIdle();
			const visible = sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "subagent-notify");
			assert.equal(visible.length, scenario.suppress ? 0 : 1, `reopen=${reopen}: whole-run completion is delivered exactly once`);
			if (reopen && !scenario.suppress) assert.equal(completions.length, 0, "saved delivery prevents replay independently of notification TTL dedupe");
			if (!reopen && !(scenario.finished && scenario.suppress) && !("published" in scenario)) assert.ok(completions.length > 0, "watcher scanned the result");
			if ("published" in scenario) {
				assert.equal(completions.length, 0, "a persisted identity prevents retry even when owner delivery was never saved and billing fails");
				const projection = sessionManager.getEntries().findLast((entry) => entry.type === "custom" && entry.customType === "subagent-run" && entry.data.runId === runId).data;
				assert.equal(projection.completion.state, "journaled");
				assert.equal(projection.accounting.state, "incomplete");
			}
			assert.ok(completions.every((event) => Boolean(event.suppressNotification) === scenario.suppress));
			assert.equal(fs.existsSync(notice), !scenario.finished && scenario.suppress, "only pending native owners retain their notification receipt");
			assert.deepEqual(errors, []);
		} finally {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			await session.abort();
			session.dispose();
		}
	}
});
