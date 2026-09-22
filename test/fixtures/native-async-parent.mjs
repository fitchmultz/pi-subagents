import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { findPackageJSON } from "node:module";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const [root, repo, sdkRoot, phase, variant] = process.argv.slice(2);
const cwd = path.join(root, "project"), agentDir = path.join(root, "agent");
const portableChild = phase.startsWith("portable-child");
for (const dir of [cwd, agentDir, path.join(cwd, ".pi/agents"), path.join(root, "bin")]) fs.mkdirSync(dir, { recursive: true });
for (const key of Object.keys(process.env)) if (key.startsWith("PI_SUBAGENT_")) delete process.env[key];
Object.assign(process.env, { HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_SUBAGENT_TEMP_ROOT: path.join(root, "pi-subagents-runtime"), PI_OFFLINE: "1",
	NATIVE_ASYNC_ROOT: root, NATIVE_ASYNC_SDK: sdkRoot, PATH: `${path.join(root, "bin")}${path.delimiter}${process.env.PATH}` });
fs.writeFileSync(path.join(root, "bin/pi"), `#!/bin/sh\nexec "${process.execPath}" "${path.join(repo, "test/fixtures/native-async-child.mjs")}" "$@"\n`, { mode: 0o755 });
fs.writeFileSync(path.join(cwd, ".pi/agents/fixture.md"), "---\nname: fixture\ndescription: Native async fixture\nmodel: child-fixture/actual-model\ninheritProjectContext: false\ninheritSkills: false\ncompletionGuard: false\n---\nReturn the controlled fixture result.\n");
const sdkEntry = pathToFileURL(path.join(sdkRoot, "dist/index.js"));
const sdk = await import(sdkEntry.href);
const aiRoot = path.dirname(findPackageJSON("@earendil-works/pi-ai", sdkEntry));
const { fauxProvider, fauxAssistantMessage, InMemoryCredentialStore } = await import(pathToFileURL(path.join(aiRoot, "dist/index.js")).href);
const { default: subagents } = await import(pathToFileURL(path.join(repo, "dist/extension/index.js")).href);
const { default: fanoutChild } = await import(pathToFileURL(path.join(repo, "dist/extension/fanout-child.js")).href);
if (portableChild) Object.assign(process.env, { PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_FANOUT_CHILD: "1", PI_SUBAGENT_DEPTH: "1", PI_SUBAGENT_MAX_DEPTH: "2" });
const evidence = { phase, variant, pid: process.pid, networkRequests: 0, errors: [], checks: [] };
globalThis.fetch = async () => { evidence.networkRequests++; throw new Error("Network is forbidden in native async fixtures"); };
const seed = phase === "seed" || portableChild ? undefined : JSON.parse(fs.readFileSync(path.join(root, "seed.json"), "utf8"));
const modelRuntime = await sdk.ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
const faux = fauxProvider({ provider: "native-parent-fixture" });
modelRuntime.registerNativeProvider(faux.provider);
const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
settingsManager.setProjectTrusted(true);
const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
	extensionFactories: [subagents, ...(portableChild ? [fanoutChild] : [])] });
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const manager = seed ? sdk.SessionManager.open(seed.sessionFile) : sdk.SessionManager.create(cwd, path.join(root, "sessions"));
const { session } = await sdk.createAgentSession({ cwd, agentDir, settingsManager, modelRuntime, model: faux.getModel(), resourceLoader: loader, sessionManager: manager });
await session.bindExtensions({ mode: "json", onError: (error) => evidence.errors.push(error) });
if (!portableChild) {
	assert.equal(typeof session.getPendingToolCalls, "function", "candidate must expose the public native lifecycle ABI");
	const originalStream = session.agent.streamFunction;
	session.agent.state.model = { ...faux.getModel(), api: "openai-responses", compat: { supportsAsyncTools: true } };
	session.agent.streamFunction = (_model, context, options) => originalStream(faux.getModel(), context, options);
}
const originalCallId = "delegate_original|fc_delegate_original";
const resultEntries = () => manager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === originalCallId);
const children = () => fs.readdirSync(root).filter((name) => name.startsWith("child-") && name.endsWith(".json"));
const until = async (predicate, reason) => { const deadline = Date.now() + 20_000; while (!predicate()) { assert.ok(Date.now() < deadline, reason); await delay(20); } };

try {
	if (portableChild) {
		const { readNativeUsage, snapshotNativeUsage } = await import(pathToFileURL(path.join(repo, "dist/runs/shared/native-usage.js")).href);
		const baseline = snapshotNativeUsage(manager.getSessionFile());
		if (phase === "portable-child") fs.writeFileSync(path.join(root, "release-child"), "release");
		const args = { agent: "fixture", task: "Return the controlled fixture result", output: false, async: false };
		faux.setResponses([fauxAssistantMessage([{ type: "toolCall", id: originalCallId, name: "subagent", arguments: args }], { stopReason: "toolUse" }), fauxAssistantMessage("Nested work collected")]);
		const launch = session.prompt("Delegate one bounded nested task");
		if (phase === "portable-child-control") {
			await until(() => children().length === 1, "nested child starts before interruption");
			const run = manager.getEntries().find((entry) => entry.type === "custom" && entry.customType === "subagent-run").data;
			const control = session.agent.state.tools.find((tool) => tool.name === "subagent");
			const receipt = await control.execute("stop_nested", { action: "interrupt", id: run.runId }, new AbortController().signal);
			assert.notEqual(receipt.isError, true, JSON.stringify(receipt));
		}
		await launch;
		await session.waitForIdle();
		assert.equal(resultEntries().length, 1);
		assert.equal(resultEntries()[0].message.isError, false, JSON.stringify(resultEntries()[0].message));
		assert.equal(resultEntries()[0].message.details.wait.status, "completed", "concurrent control in the same saved session cannot end the wait as a session switch");
		if (phase === "portable-child-control") {
			assert.equal(resultEntries()[0].message.details.run.state, "paused");
			assert.equal(children().length, 1);
			evidence.checks.push("actual child-safe interruption preserves waiting-session identity and returns the saved paused result");
		} else {
			assert.match(resultEntries()[0].message.content[0].text, /NATIVE_ORIGINAL_CALL_RESULT/);
			assert.equal(session.getSessionStats().cost, 1, "paid grandchild work must reach the child native journal");
			const runId = resultEntries()[0].message.details.runId;
			faux.setResponses([fauxAssistantMessage([{ type: "toolCall", id: "inspect_result", name: "subagent", arguments: { action: "status", id: runId } }], { stopReason: "toolUse" }), fauxAssistantMessage("Saved result inspected")]);
			await session.prompt("Read the same completed nested work");
			const inspected = manager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "inspect_result").message;
			assert.equal(inspected.isError, false, JSON.stringify(inspected));
			assert.equal(inspected.details.run.state, "completed");
			assert.equal(inspected.usage, undefined);
			assert.equal(session.getSessionStats().cost, 1, "inspecting completed nested work cannot charge it twice");
			assert.equal(children().length, 1);
			const delta = readNativeUsage(manager.getSessionFile(), baseline);
			assert.equal(delta.reduce((sum, usage) => sum + usage.cost, 0), 1, "the grandparent imports the direct child's native journal, including its nested work");
			evidence.checks.push("actual child-safe tool records grandchild usage once through native journal; inspection stays pure and never relaunches");
		}
	} else if (phase === "seed") {
		const args = { agent: "fixture", task: "Return the controlled fixture result", output: false };
		const call = { type: "toolCall", id: originalCallId, name: "delegate", arguments: args, async: true,
			responsesItem: { type: "function_call", id: "fc_delegate_original", call_id: "delegate_original", name: "delegate", arguments: JSON.stringify(args), async: true, status: "completed" } };
		faux.setResponses([fauxAssistantMessage([call, { type: "text", text: "Independent parent answer while the child runs" }], { responseId: "initial-response", stopReason: "toolUse" }), fauxAssistantMessage("Ready for child result")]);
		const run = session.prompt("Delegate controlled work");
		await until(() => children().length === 1 && session.getPendingToolCalls().some((call) => call.toolCallId === originalCallId), "one owned native call starts");
		const binding = manager.getEntries().find((entry) => entry.type === "custom" && entry.customType === "subagent-invocation")?.data;
		assert.equal(binding.toolCallId, originalCallId);
		assert.ok(fs.readFileSync(manager.getSessionFile(), "utf8").includes('"executionStarted":true'));
		assert.equal(resultEntries().length, 0, "native delegation cannot publish an ordinary launch receipt");
		await session.abort(); await run;
		assert.equal(session.getPendingToolCalls()[0].state, "detached");
		assert.equal(resultEntries().length, 0);
		const originalLeaf = manager.getLeafId();
		if (variant === "compaction") {
			const kept = manager.appendMessage({ role: "user", content: "Retained after controlled compaction", timestamp: Date.now() });
			manager.appendCompaction("Controlled compaction with one unresolved native delegation", kept, 100);
		}
		const seed = { sessionFile: manager.getSessionFile(), runId: binding.runId, pid: process.pid, originalLeaf,
			beforeCall: manager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "user").id };
		fs.writeFileSync(path.join(root, "seed.json"), JSON.stringify(seed));
		evidence.checks.push("original call journaled before launch; abort leaves durable work pending without a tool result");
	} else {
		assert.notEqual(process.pid, seed.pid, "reattachment must use a fresh parent process");
		assert.equal(session.getPendingToolCalls()[0].toolCallId, originalCallId);
		if (variant === "branch") {
			await session.navigateTree(seed.beforeCall, { summarize: false });
			assert.equal(session.getPendingToolCalls().length, 0);
		}
		fs.writeFileSync(path.join(root, "release-child"), "release");
		const finalFile = path.join(agentDir, "sessions/subagent-runs", seed.runId, "result.json");
		await until(() => fs.existsSync(finalFile), "detached owner commits its result");
		if (variant === "branch") {
			await delay(100);
			assert.equal(resultEntries().length, 0, "off-branch completion cannot fabricate an original-call result");
			await session.navigateTree(seed.originalLeaf, { summarize: false });
			assert.equal(session.getPendingToolCalls()[0].toolCallId, originalCallId);
		}
		faux.setResponses([fauxAssistantMessage("Collected the original child result"), fauxAssistantMessage("Finished")]);
		await session.prompt("Collect the pending work");
		await session.waitForIdle();
		assert.equal(session.getPendingToolCalls().length, 0);
		assert.equal(children().length, 1, "recovery must not create a second child");
		assert.equal(resultEntries().length, 1);
		assert.match(resultEntries()[0].message.content[0].text, /NATIVE_ORIGINAL_CALL_RESULT/);
		assert.equal(resultEntries()[0].message.usage, undefined, "recordUsage and tool-result usage cannot charge the same work");
		assert.equal(manager.getEntries().filter((entry) => entry.type === "usage" && entry.kind === "subagent").length, 1);
		assert.equal(session.getSessionStats().cost, 1);
		assert.ok(!manager.getEntries().some((entry) => entry.type === "custom_message" && entry.customType === "subagent-notify"));
		evidence.checks.push("fresh parent attaches the same owner and emits one original-call result with one native usage contribution");
	}
	assert.equal(evidence.networkRequests, 0);
	assert.deepEqual(evidence.errors, []);
} finally {
	await session.abort();
	session.dispose();
	fs.writeFileSync(path.join(root, `${phase}-evidence.json`), JSON.stringify({ ...evidence, entries: manager.getEntries() }, null, 2));
}
