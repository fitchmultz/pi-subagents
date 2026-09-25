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

for (const scenario of [
	{ name: "completed child answer", kind: "answer", index: 1, finished: true, suppress: false },
	{ name: "completed child follow-up", kind: "delivery", index: 1, finished: true, suppress: false },
	{ name: "pending child follow-up", kind: "delivery", index: 1, finished: false, suppress: false },
	{ name: "detached whole-run launch", kind: "launch", index: undefined, finished: false, suppress: true },
	{ name: "detached single-child follow-up", kind: "delivery", index: 0, mode: "single", finished: false, suppress: true },
	{ name: "failed whole-run call", kind: "launch", index: undefined, finished: true, failed: true, suppress: false },
	{ name: "consumed whole-run call", kind: "launch", index: undefined, finished: true, suppress: true },
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
	bindNativeInvocation({ appendEntry: (type, data) => manager.appendCustomEntry(type, data) }, { sessionManager: manager }, callId,
		{ runId, index: scenario.index, kind: scenario.kind, accepted: true, ...(questionId ? { questionId, answer: "Yes" } : {}) });
	if (scenario.finished) manager.appendMessage({ role: "toolResult", toolName: "agent_runs", toolCallId: callId,
		content: [{ type: "text", text: "Call finished" }], timestamp: Date.now(), isError: "failed" in scenario,
		details: "failed" in scenario ? {} : { mode: "management", results: [], wait: { runId, index: scenario.index, status: "completed" } } });
	manager.appendMessage(ai.fauxAssistantMessage("Waiting for completion"));
	const final = { runtimeVersion: 2, id: runId, mode, sessionId: manager.getSessionFile(), state: "complete", success: true, timestamp: Date.now(),
		results: children.map(({ agent, index }) => ({ agent, success: true, exitCode: 0, output: `CHILD_${index}_RESULT` })) };
	saveRunStatus(runId, { runId, runtimeVersion: 2, mode, sessionId: manager.getSessionFile(), state: "complete", startedAt: Date.now(), lastUpdate: Date.now(), cwd, steps: children.map(({ agent }) => ({ agent, status: "complete" })) });
	saveAsyncRunResult(runId, final);
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
			if (!reopen && !(scenario.finished && scenario.suppress)) assert.ok(completions.length > 0, "watcher scanned the result");
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
