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
process.env.PI_PACKAGE_DIR = sdkRoot;
const sdkEntry = pathToFileURL(path.join(sdkRoot, "dist/index.js"));
const sdk = await import(sdkEntry.href);
const aiRoot = path.dirname(findPackageJSON("@earendil-works/pi-ai", sdkEntry)!);
const ai = await import(pathToFileURL(path.join(aiRoot, "dist/index.js")).href);
const { getRunMetadataDir, saveQuestionOwner, saveRunStatus, saveAsyncRunResult, createSupervisorQuestion, saveQuestionAnswer, recordQuestionDelivery } = await import("../../src/runs/shared/supervisor-questions.ts");
const { RESULTS_DIR } = await import("../../src/shared/types.ts");
const { default: registerRoot } = await import("../../src/extension/index.ts");
const { default: registerChild } = await import("../../src/extension/fanout-child.ts");
const { createCompletionDelivery } = await import("../../src/runs/background/completion-delivery.ts");
const { registerParentUsage } = await import("../../src/runs/shared/parent-usage.ts");

for (const childSafe of [false, true]) for (const drop of [false, true]) for (const unowned of [false, true]) test(`${childSafe ? "child-safe" : "root"} ${unowned ? "unowned legacy" : "owned"} queued completion ${drop ? "retries once after being dropped" : "survives streaming beyond the TTL"}${!childSafe && !drop ? " and abort/reload" : ""}`, async (t) => {
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
	if (!unowned) {
		manager.appendCustomEntry("subagent-run", { runId, rootRunId: runId, ownerSessionId: manager.getSessionId(), source: "async", mode: "single",
			cwd, task: "Bounded work", startedAt: Date.now(), asyncDir, children: [{ agent: "worker", index: 0 }] });
		saveQuestionOwner(runId, manager.getSessionId());
	}
	const sent = [], errors = [];
	let factoryRuns = 0;
	let release, ctx;
	const settingsManager = sdk.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: { enabled: false } });
	const loader = new sdk.DefaultResourceLoader({ cwd, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager,
		noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
		extensionFactories: [(pi) => {
			factoryRuns++;
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
	faux.setResponses([!childSafe && !drop ? async (_context, options) => {
		await new Promise<void>((resolve) => { release = resolve; options?.signal?.addEventListener("abort", () => resolve(), { once: true }); });
		return ai.fauxAssistantMessage("Held response");
	} : ai.fauxAssistantMessage(ai.fauxToolCall("hold_turn", {}, { id: "hold" }), { stopReason: "toolUse" }),
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
		await until(() => release, "native parent turn starts");
		assert.equal(ctx.isIdle(), false);
		const result = { runtimeVersion: unowned ? undefined : 2, id: runId, mode: "single", sessionId: unowned ? manager.getSessionId() : manager.getSessionFile(), state: "complete",
			success: true, timestamp: Date.now(), summary: "QUEUED_RESULT", results: [{ agent: "worker", success: true, exitCode: 0, output: "QUEUED_RESULT" }] };
		const notice = path.join(RESULTS_DIR, `${runId}.json`);
		const recreateNotice = () => fs.writeFileSync(notice, JSON.stringify(result));
		if (!unowned) saveRunStatus(runId, { runtimeVersion: 2, runId, mode: "single", sessionId: manager.getSessionFile(), state: "complete",
			startedAt: Date.now(), lastUpdate: Date.now(), cwd, steps: [{ agent: "worker", status: "complete" }] });
		if (unowned) recreateNotice(); else saveAsyncRunResult(runId, result);
		t.mock.timers.tick(3000);
		await until(() => sent.length === 1, "completion reaches the real host queue");
		assert.equal(notices().length, 0);
		assert.equal(delivered(), false, "queued is not durably delivered");
		assert.equal(session.agent.hasQueuedMessages(), true);
		if (drop) {
			session.clearQueue();
			assert.equal(session.agent.hasQueuedMessages(), false, "the real host dropped the queued wake-up");
			if (unowned) recreateNotice();
		} else {
			for (let scan = 0; scan < 2; scan++) {
				if (unowned) recreateNotice();
				t.mock.timers.tick(11 * 60_000);
				await delay(50);
				assert.equal(sent.length, 1, "streaming past TTL must not queue another wake-up");
			}
		}
		if (unowned && !childSafe && !drop) {
			const pendingKey = sent[0].details.completion.key;
			const otherCwd = fs.mkdtempSync(path.join(root, "other-controller-"));
			const otherLoader = new sdk.DefaultResourceLoader({ cwd: otherCwd, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager,
				noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true, extensionFactories: [(pi) => {
					// Register the real completion boundary without another full root's
					// global cleanup stopping the first watcher's abort/reload proof.
					createCompletionDelivery(pi, { completionSeen: new Map() } as Parameters<typeof createCompletionDelivery>[1], registerParentUsage(pi, []));
				}] });
			await otherLoader.reload();
			assert.deepEqual(otherLoader.getExtensions().errors, []);
			const otherFaux = ai.fauxProvider({ provider: "other-controller-fixture", tokensPerSecond: 1000000 });
			otherFaux.setResponses([ai.fauxAssistantMessage("Other controller settled")]);
			const otherRuntime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
			otherRuntime.registerNativeProvider(otherFaux.provider);
			const { session: other } = await sdk.createAgentSession({ cwd: otherCwd, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager,
				resourceLoader: otherLoader, modelRuntime: otherRuntime, model: otherFaux.getModel(), sessionManager: sdk.SessionManager.create(otherCwd, path.join(otherCwd, "sessions")) });
			try {
				await other.bindExtensions({ mode: "json", onError: (error) => errors.push(error) });
				await other.prompt("Settle this independent native controller");
				await other.waitForIdle();
				assert.equal(session.agent.hasQueuedMessages(), true, "the first controller's actual custom queue is still pending");
				assert.equal((globalThis.__pi_subagents_queued_notifications__ as Map<string, unknown>).has(pendingKey), true,
					"another native controller's turn/settlement cannot retire this pending identity");
			} finally {
				await other.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
				other.dispose();
			}
		}
		if (!childSafe && !drop) {
			recreateNotice();
			t.mock.timers.tick(3000);
			await until(() => !fs.existsSync(notice), "the first watcher remains active before abort/reload");
			assert.equal(sent.length, 1);
			await session.abort();
			await prompt;
			assert.equal(ctx.isIdle(), true);
			assert.equal(session.agent.hasQueuedMessages(), true, "abort settles without consuming the native custom queue");
			recreateNotice();
			t.mock.timers.tick(11 * 60_000);
			await until(() => !fs.existsSync(notice), "the active aborted owner's watcher reconciles recreated input");
			assert.equal(sent.length, 1, "an idle aborted parent must not duplicate its still-pending custom message");
			assert.equal(factoryRuns, 1);
			await session.reload();
			assert.equal(factoryRuns, 2, "native reload replaces the extension controller");
			recreateNotice();
			t.mock.timers.tick(11 * 60_000);
			await until(() => !fs.existsSync(notice), "the replacement watcher actively reconciles recreated input");
			await session.waitForIdle();
			assert.equal(sent.length, 1, "reload preserves the actual pending admission rather than sending a second notice");
			assert.equal(notices().length, 0, "native reload has not consumed the pending completion");
			assert.equal(session.agent.hasQueuedMessages(), true);
			prompt = session.prompt("Resume the parent and consume its pending completion");
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
		if (!unowned) await until(delivered, "journal reconciliation records delivery");
		t.mock.timers.tick(11 * 60_000);
		await delay(50);
		assert.equal(sent.length, drop ? 2 : 1);
		assert.equal(notices().length, 1);
		if (unowned) {
			assert.equal(delivered(), false, "native receipt authority does not fabricate an owned-run projection");
			assert.equal((globalThis.__pi_subagents_queued_notifications__ as Map<string, unknown>).has(sent[0].details.completion.key), false,
				"a consumed or dropped runless admission cannot become a permanent global queued key");
		}
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
	{ name: "repeat native startup joins in-flight delivery before replacing the completion listeners", shutdown: false, childSafe: false, unowned: false, delivered: false },
	{ name: "native shutdown retains failed in-flight completion for session reopen", shutdown: true, childSafe: false, unowned: false, delivered: false },
	{ name: "child-safe native shutdown retains failed in-flight completion for session reopen", shutdown: true, childSafe: true, unowned: false, delivered: false },
	{ name: "native shutdown retains an unowned legacy completion for session reopen", shutdown: true, childSafe: false, unowned: true, delivered: false },
	{ name: "native shutdown preserves an acknowledged Intercom completion without fabricating a published receipt", shutdown: true, childSafe: false, unowned: false, delivered: true },
]) test(scenario.name, async (t) => {
	const previousChild = process.env.PI_SUBAGENT_CHILD, previousFanout = process.env.PI_SUBAGENT_FANOUT_CHILD;
	process.env.PI_SUBAGENT_CHILD = scenario.childSafe ? "1" : "0";
	process.env.PI_SUBAGENT_FANOUT_CHILD = scenario.childSafe ? "1" : "0";
	t.after(() => {
		if (previousChild === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = previousChild;
		if (previousFanout === undefined) delete process.env.PI_SUBAGENT_FANOUT_CHILD; else process.env.PI_SUBAGENT_FANOUT_CHILD = previousFanout;
	});
	const cwd = fs.mkdtempSync(path.join(root, "rebinding-"));
	const manager = sdk.SessionManager.create(cwd, path.join(cwd, "sessions"));
	manager.appendMessage(ai.fauxAssistantMessage("Retain saved child work"));
	for (let index = 0; index < 64; index++) manager.appendCustomEntry("fixture", {});
	const runId = randomUUID(), asyncDir = getRunMetadataDir(runId);
	if (!scenario.unowned) {
		manager.appendCustomEntry("subagent-run", { runId, rootRunId: runId, ownerSessionId: manager.getSessionId(), source: "async",
			mode: "single", cwd, task: "Bounded work", startedAt: 1, asyncDir, children: [{ agent: "worker", index: 0 }] });
		saveQuestionOwner(runId, manager.getSessionId());
		saveRunStatus(runId, { runtimeVersion: 2, runId, sessionId: manager.getSessionId(), mode: "single",
			state: "complete", startedAt: 1, endedAt: 2, steps: [{ agent: "worker", status: "complete" }] });
	}
	const result = { runtimeVersion: scenario.unowned ? undefined : 2, id: runId, sessionId: manager.getSessionId(), mode: "single",
		state: "complete", success: true, timestamp: 2, summary: "Retained completion", intercomTarget: "fixture-parent",
		results: [{ agent: "worker", success: true, exitCode: 0, output: "Retained completion" }] };
	const hint = path.join(RESULTS_DIR, `${runId}.json`);
	if (scenario.unowned) {
		fs.mkdirSync(RESULTS_DIR, { recursive: true });
		fs.writeFileSync(hint, JSON.stringify(result));
	} else saveAsyncRunResult(runId, result);
	const bus = sdk.createEventBus(), errors: unknown[] = [];
	let request: { requestId: string } | undefined;
	bus.on("subagent:result-intercom", (data) => { request = data; });
	const settingsManager = sdk.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: { enabled: false } });
	const faux = ai.fauxProvider({ provider: "rebinding-completion-fixture", tokensPerSecond: 1000000 });
	faux.setResponses([ai.fauxAssistantMessage("Completion received")]);
	const modelRuntime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	modelRuntime.registerNativeProvider(faux.provider);
	const createRuntime = async ({ sessionManager }) => {
		const services = await sdk.createAgentSessionServices({ cwd, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager, modelRuntime,
			resourceLoaderOptions: { eventBus: bus, noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
				additionalExtensionPaths: [path.resolve(scenario.childSafe ? "src/extension/fanout-child.ts" : "src/extension/index.ts")] } });
		assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
		return { ...await sdk.createAgentSessionFromServices({ services, sessionManager, model: faux.getModel(), tools: ["subagent", "agent_runs"] }),
			services, diagnostics: services.diagnostics };
	};
	let runtime = await sdk.createAgentSessionRuntime(createRuntime, { cwd, agentDir: process.env.PI_CODING_AGENT_DIR, sessionManager: manager });
	let disposed = false;
	const until = async (check: () => boolean, reason: string) => {
		const deadline = performance.now() + 5000;
		while (!check()) { assert.ok(performance.now() < deadline, reason); await delay(10); }
	};
	const notices = () => runtime.session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "subagent-notify");
	const projection = () => runtime.session.sessionManager.getEntries().findLast((entry) => entry.type === "custom" && entry.customType === "subagent-run" && entry.data.runId === runId)?.data;
	try {
		const bindings = { mode: "json", onError: (error) => errors.push(error) };
		await runtime.session.bindExtensions(bindings);
		await until(() => Boolean(request), "the first watcher starts Intercom delivery");
		disposed = scenario.shutdown;
		const transition = scenario.shutdown ? runtime.dispose() : runtime.session.bindExtensions(bindings);
		await new Promise<void>((resolve) => setImmediate(resolve));
		bus.emit("subagent:result-intercom-delivery", { requestId: request!.requestId, delivered: scenario.delivered });
		await transition;
		if (scenario.shutdown) {
			assert.deepEqual(errors, [], "shutdown must not request a new native turn after ingress closes");
			assert.equal(faux.state.callCount, 0);
			assert.equal(notices().length, 0);
			assert.equal(fs.existsSync(hint), scenario.unowned && !scenario.delivered, "unacknowledged legacy-only input remains available");
			assert.equal(fs.existsSync(path.join(asyncDir, "result.json")), !scenario.unowned);
			assert.equal(projection()?.delivery, undefined, "acknowledgement alone is not a published parent receipt");
			if (scenario.delivered) {
				assert.equal(projection().completion.state, "queued");
				assert.equal(projection().completion.channel, "intercom", "listeners retain the remote acknowledgement before stopping");
				return;
			}
			assert.notEqual(projection()?.completion?.state, "queued", "an undelivered result must remain eligible");
			request = undefined;
			runtime = await sdk.createAgentSessionRuntime(createRuntime, { cwd, agentDir: process.env.PI_CODING_AGENT_DIR,
				sessionManager: sdk.SessionManager.open(manager.getSessionFile()) });
			disposed = false;
			await runtime.session.bindExtensions(bindings);
			await until(() => Boolean(request), "reopened session retries the retained completion");
			bus.emit("subagent:result-intercom-delivery", { requestId: request!.requestId, delivered: false });
		}
		await until(() => notices().length > 0, "failed in-flight Intercom delivery publishes its fallback during startup or reopen");
		await runtime.session.waitForIdle();
		assert.equal(notices().length, 1, "the retained result is delivered exactly once");
		if (!scenario.unowned) {
			await until(() => Boolean(projection().delivery?.entryId), "the owner reconciles its published receipt");
			assert.equal(projection().delivery.entryId, notices()[0].id);
		}
		assert.equal(fs.existsSync(hint), false);
		assert.equal(fs.existsSync(path.join(asyncDir, "result.json")), !scenario.unowned);
		assert.deepEqual(errors, []);
	} finally {
		if (!disposed) {
			await runtime.session.abort();
			await runtime.dispose();
		}
	}
});

for (const scenario of [
	{ name: "unowned legacy completion", kind: "launch", index: undefined, finished: true, receipt: true, unowned: true, suppress: false },
	{ name: "background launch receipt", kind: "launch", index: undefined, finished: true, receipt: true, suppress: false },
	{ name: "completed child answer", kind: "answer", index: 1, finished: true, suppress: false },
	{ name: "completed child follow-up", kind: "delivery", index: 1, finished: true, suppress: false },
	{ name: "pending child follow-up", kind: "delivery", index: 1, finished: false, suppress: false },
	{ name: "obsolete detached whole-run launch", kind: "launch", index: undefined, finished: false, suppress: false },
	{ name: "obsolete detached single-child follow-up", kind: "delivery", index: 0, mode: "single", finished: false, suppress: false },
	{ name: "failed whole-run call", kind: "launch", index: undefined, finished: true, failed: true, suppress: false },
	{ name: "consumed whole-run call", kind: "launch", index: undefined, finished: true, suppress: true },
	{ name: "persisted notice before owner/accounting save", kind: "launch", index: undefined, finished: true, receipt: true, published: true, suppress: false },
] as const) test(`registered extension routes completion after ${scenario.name}, including session reopen`, async (t) => {
	const cwd = fs.mkdtempSync(path.join(root, "case-"));
	const manager = sdk.SessionManager.create(cwd, path.join(cwd, "sessions"));
	manager.appendMessage(ai.fauxAssistantMessage("Delegate work"));
	const runId = randomUUID(), asyncDir = getRunMetadataDir(runId), sessionId = manager.getSessionId();
	const mode = "mode" in scenario ? scenario.mode : "parallel";
	const children = Array.from({ length: mode === "single" ? 1 : 2 }, (_, index) => ({ agent: "worker", index }));
	const unowned = "unowned" in scenario;
	if (unowned) t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
	if (!unowned) {
		manager.appendCustomEntry("subagent-run", { runId, rootRunId: runId, ownerSessionId: sessionId, source: "async", mode, cwd, task: "Bounded work", startedAt: Date.now(), asyncDir, children });
		saveQuestionOwner(runId, sessionId);
	}
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
	if (scenario.finished && !unowned) manager.appendMessage(ai.fauxAssistantMessage(
		ai.fauxToolCall("agent_runs", { action: scenario.kind === "answer" ? "answer" : "resume", id: runId, index: scenario.index }, { id: callId }),
		{ stopReason: "toolUse" }));
	if (!("receipt" in scenario)) manager.appendCustomEntry("subagent-invocation",
		{ toolCallId: callId, ownerSessionId: sessionId, runId, index: scenario.index, kind: scenario.kind, accepted: true, ...(questionId ? { questionId, answer: "Yes" } : {}) });
	if (scenario.finished && !unowned) manager.appendMessage({ role: "toolResult", toolName: "agent_runs", toolCallId: callId,
		content: [{ type: "text", text: "Call finished" }], timestamp: Date.now(), isError: "failed" in scenario,
		details: "receipt" in scenario ? { mode: "single", results: [], asyncId: runId } : "failed" in scenario ? {} : { mode: "management", results: [], wait: { runId, index: scenario.index, status: "completed" } } });
	manager.appendMessage(ai.fauxAssistantMessage("Waiting for completion"));
	const final = { runtimeVersion: unowned ? undefined : 2, id: runId, mode, sessionId: unowned ? sessionId : manager.getSessionFile(), state: "complete", success: true, timestamp: Date.now(),
		results: children.map(({ agent, index }) => ({ agent, success: true, exitCode: 0, output: `CHILD_${index}_RESULT` })) };
	if (!unowned) saveRunStatus(runId, { runId, runtimeVersion: 2, mode, sessionId: manager.getSessionFile(), state: "complete", startedAt: Date.now(), lastUpdate: Date.now(), cwd, steps: children.map(({ agent }) => ({ agent, status: "complete" })) });
	const saved = unowned ? final : saveAsyncRunResult(runId, final);
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
		if (unowned) fs.writeFileSync(notice, JSON.stringify(final));
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
			if (unowned) {
				t.mock.timers.tick(11 * 60_000);
				fs.writeFileSync(notice, JSON.stringify(final));
				t.mock.timers.tick(3000);
				await delay(150);
				await session.waitForIdle();
				assert.equal(sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "subagent-notify").length, 1,
					"a published runless native receipt prevents replay of retained/recreated input past TTL");
				assert.ok(!sessionManager.getEntries().some((entry) => entry.type === "custom" && entry.customType === "subagent-run" && entry.data.runId === runId));
			}
			if (unowned) assert.equal((globalThis.__pi_subagents_queued_notifications__ as Map<string, unknown>).has(visible[0].details.completion.key), false,
				"a legacy notification without an owned run must not retain an unreconcilable durable queue key");
			if (reopen && !scenario.suppress) assert.equal(completions.length, 0, "saved delivery prevents replay independently of notification TTL dedupe");
			if (!reopen && !(scenario.finished && scenario.suppress) && !("published" in scenario)) assert.ok(completions.length > 0, "watcher scanned the result");
			if ("published" in scenario) {
				assert.equal(completions.length, 0, "a persisted identity prevents retry even when owner delivery was never saved and billing fails");
				const projection = sessionManager.getEntries().findLast((entry) => entry.type === "custom" && entry.customType === "subagent-run" && entry.data.runId === runId).data;
				assert.equal(projection.completion.state, "journaled");
				assert.equal(projection.accounting.state, "incomplete");
			}
			assert.ok(completions.every((event) => Boolean(event.suppressNotification) === scenario.suppress));
			assert.equal(fs.existsSync(notice), false, "finalized receipts or published notification consume recovery hints, not obsolete call bindings");
			assert.deepEqual(errors, []);
		} finally {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			await session.abort();
			session.dispose();
		}
	}
});
