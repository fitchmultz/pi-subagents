import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire, findPackageJSON } from "node:module";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const [root, repo, sdkRoot, phase, variant] = process.argv.slice(2);
const cwd = path.join(root, "project"), agentDir = path.join(root, "agent");
const portableChild = phase.startsWith("portable-child");
const continuation = variant === "continue-restart" || variant === "answer-restart";
const advanced = variant === "advanced-child-restart" || variant === "advanced-parent-restart";
const expectedChildren = continuation ? 2 : 1;
const childSafe = portableChild || continuation || variant === "fork" || variant === "child-restart" || variant === "advanced-child-restart";
const providerSteering = variant.startsWith("steering");
for (const dir of [cwd, agentDir, path.join(cwd, ".pi/agents"), path.join(root, "bin")]) fs.mkdirSync(dir, { recursive: true });
for (const key of Object.keys(process.env)) if (key.startsWith("PI_SUBAGENT_")) delete process.env[key];
Object.assign(process.env, { HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_PACKAGE_DIR: sdkRoot, PI_SUBAGENT_TEMP_ROOT: path.join(root, "pi-subagents-runtime"), PI_OFFLINE: "1",
	NATIVE_ASYNC_ROOT: root, NATIVE_ASYNC_SDK: sdkRoot, PATH: `${path.join(root, "bin")}${path.delimiter}${process.env.PATH}` });
fs.writeFileSync(path.join(root, "bin/pi"), `#!/bin/sh\nexec "${process.execPath}" "${path.join(repo, "test/fixtures/native-async-child.mjs")}" "$@"\n`, { mode: 0o755 });
fs.writeFileSync(path.join(cwd, ".pi/agents/fixture.md"), "---\nname: fixture\ndescription: Native async fixture\nmodel: child-fixture/actual-model\ninheritProjectContext: false\ninheritSkills: false\ncompletionGuard: false\n---\nReturn the controlled fixture result.\n");
const sdkEntry = pathToFileURL(path.join(sdkRoot, "dist/index.js"));
const sdk = await import(sdkEntry.href);
const aiRoot = path.dirname(findPackageJSON("@earendil-works/pi-ai", sdkEntry));
const { fauxProvider, fauxAssistantMessage, InMemoryCredentialStore } = await import(pathToFileURL(path.join(aiRoot, "dist/index.js")).href);
const { default: subagents } = await import(pathToFileURL(path.join(repo, "dist/extension/index.js")).href);
const { default: fanoutChild } = await import(pathToFileURL(path.join(repo, "dist/extension/fanout-child.js")).href);
const nativeSession = await import(pathToFileURL(path.join(repo, "dist/shared/native-session.js")).href);
const { RESULTS_DIR } = await import(pathToFileURL(path.join(repo, "dist/shared/types.js")).href);
const { createSupervisorQuestion, listSupervisorQuestions, saveQuestionAnswer, recordQuestionDelivery, readQuestionContract } = await import(pathToFileURL(path.join(repo, "dist/runs/shared/supervisor-questions.js")).href);
assert.equal(nativeSession.SessionManager, sdk.SessionManager, "extension native readers must use the selected SDK");
if (childSafe) Object.assign(process.env, { PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_FANOUT_CHILD: "1", PI_SUBAGENT_DEPTH: "1", PI_SUBAGENT_MAX_DEPTH: "2" });
const evidence = { phase, variant, sdkRoot, nativeSessionManagerMatches: nativeSession.SessionManager === sdk.SessionManager,
	pid: process.pid, networkRequests: 0, errors: [], checks: [], providerInputs: [], steering: [] };
globalThis.fetch = async () => { evidence.networkRequests++; throw new Error("Network is forbidden in native async fixtures"); };
const seed = phase === "seed" || portableChild ? undefined : JSON.parse(fs.readFileSync(path.join(root, "seed.json"), "utf8"));
if (seed && variant === "canonical-result") assert.equal(fs.existsSync(path.join(RESULTS_DIR, `${seed.runId}.json`)), false, "fresh startup has no temporary result notification");
const modelRuntime = await sdk.ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
const faux = fauxProvider({ provider: "native-parent-fixture" });
modelRuntime.registerNativeProvider(faux.provider);
const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
settingsManager.setProjectTrusted(true);
const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
	extensionFactories: [subagents, ...(childSafe ? [fanoutChild] : [])] });
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const sourceBytes = phase === "fork" ? fs.readFileSync(seed.sessionFile, "utf8") : undefined;
const manager = phase === "fork" ? sdk.SessionManager.forkFrom(seed.sessionFile, cwd, path.join(root, "forks"))
	: seed ? sdk.SessionManager.open(seed.sessionFile) : sdk.SessionManager.create(cwd, path.join(root, "sessions"));
const inheritedEntries = phase === "fork" ? sdk.SessionManager.open(seed.sessionFile).getEntries() : undefined;
if (inheritedEntries) {
	assert.notEqual(manager.getSessionId(), seed.sessionId);
	assert.deepEqual(manager.getEntries(), inheritedEntries, "fork copies the full history, including tool calls and results");
}
const { session } = await sdk.createAgentSession({ cwd, agentDir, settingsManager, modelRuntime, model: faux.getModel(), resourceLoader: loader, sessionManager: manager });
await session.bindExtensions({ mode: "json", onError: (error) => evidence.errors.push(error) });
for (const name of ["delegate", "agent_runs", "load_subagent"]) assert.ok(session.agent.state.tools.some((tool) => tool.name === name), `${name} is active by default`);
evidence.activeTools = session.agent.state.tools.map((tool) => tool.name);
assert.equal(evidence.activeTools.includes("subagent"), advanced && phase === "resume", "advanced orchestration is active on startup only for its pending native call");
session.subscribe((event) => {
	if (event.type === "steering") evidence.steering.push(structuredClone(event));
});
if (!portableChild) {
	assert.equal(typeof session.getPendingToolCalls, "function", "candidate must expose the public native lifecycle ABI");
	const originalStream = session.agent.streamFunction;
	session.agent.state.model = { ...faux.getModel(), api: "openai-responses", compat: { supportsAsyncTools: true } };
	session.agent.streamFunction = (_model, context, options) => {
		evidence.providerInputs.push(structuredClone(context.messages));
		return originalStream(faux.getModel(), context, options);
	};
}
const originalCallId = "delegate_original|fc_delegate_original";
const toolName = continuation ? "agent_runs" : advanced ? "subagent" : "delegate";
const args = continuation ? { ...seed?.continuationArgs }
	: { agent: "fixture", task: "Return the controlled fixture result", output: false, ...(childSafe ? { async: true } : {}) };
const wireCall = { type: "function_call", id: "fc_delegate_original", call_id: "delegate_original", name: toolName,
	arguments: JSON.stringify(args), async: true, status: "completed" };
const resultEntries = () => manager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === originalCallId);
const children = () => fs.readdirSync(root).filter((name) => name.startsWith("child-") && name.endsWith(".json"));
const childStarts = () => fs.existsSync(path.join(root, "child-starts.jsonl"))
	? fs.readFileSync(path.join(root, "child-starts.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
const until = async (predicate, reason) => { const deadline = Date.now() + 20_000; while (!predicate()) { assert.ok(Date.now() < deadline, reason); await delay(20); } };
let provider;

try {
	if (providerSteering) {
		const { WebSocket, WebSocketServer } = createRequire(sdkEntry)("ws");
		globalThis.WebSocket = WebSocket;
		await modelRuntime.setRuntimeApiKey("openai", "local-fixture-key");
		const { createResponsesFixture, reply, zeroUsage } = await import("./native-async-responses.mjs");
		const { stream } = await import(pathToFileURL(path.join(aiRoot, "dist/api/openai-responses.js")).href);
		let initialRequest;
		provider = await createResponsesFixture(WebSocketServer, (request) => {
			if (request.body.type === "response.steer") {
				assert.equal(phase, "seed");
				assert.equal(provider.requests.filter((body) => body.type === "response.steer").length, 1, "accepted steering must not be resent");
				request.send({ type: "response.steer.accepted", steer: { id: "accepted-steer", previous_response_id: "parent" } });
				initialRequest.send({ type: "response.incomplete", response: { id: "parent", status: "incomplete",
					incomplete_details: { reason: "steered" }, output: [wireCall], end_turn: false, usage: zeroUsage } });
				if (variant === "steering-disconnect") request.socket.close();
				else reply(request, "steered-successor");
			} else {
				assert.equal(request.body.type, "response.create");
				assert.ok(provider.requests.length < 6, "recovery must settle without a provider request loop");
				if (phase === "seed" && !initialRequest) {
					initialRequest = request;
					request.send({ type: "response.created", response: { id: "parent", status: "in_progress" } });
					request.send({ type: "response.output_item.added", output_index: 0, item: wireCall });
					request.send({ type: "response.output_item.done", output_index: 0, item: wireCall });
				} else reply(request, `recovered-${provider.requests.length}`);
			}
		});
		session.agent.state.model = { ...faux.getModel(), id: "gpt-6-astra", provider: "openai", api: "openai-responses",
			baseUrl: provider.baseUrl, compat: { supportsAsyncTools: true, supportsSteering: true } };
		session.agent.streamFunction = (model, context, options) => {
			assert.equal(model.baseUrl, provider.baseUrl, "provider requests must stay on the loopback fixture");
			return stream(model, context, { ...options, apiKey: "local-fixture-key", transport: "websocket", timeoutMs: 20_000 });
		};
	}
	if (portableChild) {
		const { readNativeUsage, snapshotNativeUsage } = await import(pathToFileURL(path.join(repo, "dist/runs/shared/native-usage.js")).href);
		const baseline = snapshotNativeUsage(manager.getSessionFile());
		if (phase === "portable-child") fs.writeFileSync(path.join(root, "release-child"), "release");
		const args = { agent: "fixture", task: "Return the controlled fixture result", output: false };
		faux.setResponses([fauxAssistantMessage([{ type: "toolCall", id: originalCallId, name: "delegate", arguments: args }], { stopReason: "toolUse" }), fauxAssistantMessage("Nested work collected")]);
		const launch = session.prompt("Delegate one bounded nested task");
		if (phase === "portable-child-control") {
			await until(() => children().length === 1, "nested child starts before interruption");
			const run = manager.getEntries().find((entry) => entry.type === "custom" && entry.customType === "subagent-run").data;
			const control = session.agent.state.tools.find((tool) => tool.name === "agent_runs");
			const receipt = await control.execute("stop_nested", { action: "stop", id: run.runId }, new AbortController().signal);
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
			faux.setResponses([fauxAssistantMessage([{ type: "toolCall", id: "inspect_result", name: "agent_runs", arguments: { action: "inspect", id: runId } }], { stopReason: "toolUse" }), fauxAssistantMessage("Saved result inspected")]);
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
		if (advanced) {
			faux.setResponses([fauxAssistantMessage([{ type: "toolCall", id: "load_advanced", name: "load_subagent", arguments: {} }], { stopReason: "toolUse" }),
				fauxAssistantMessage("Advanced delegation enabled")]);
			await session.prompt("Load advanced delegation before launching the pending call");
			assert.equal(manager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "load_advanced").message.isError, false);
			assert.ok(session.agent.state.tools.some((tool) => tool.name === "subagent"));
			assert.equal(process.env.PI_SUBAGENT_EAGER_TOOL, undefined, "recovery must work without eager activation");
		}
		if (continuation) {
			fs.writeFileSync(path.join(root, "release-child"), "release");
			faux.setResponses([fauxAssistantMessage([{ type: "toolCall", id: "predecessor", name: "delegate",
				arguments: { agent: "fixture", task: "Create the saved child session", output: false, async: false } }], { stopReason: "toolUse" }),
				fauxAssistantMessage("Saved child completed")]);
			await session.prompt("Complete the predecessor before continuing its saved session");
			await session.waitForIdle();
			fs.unlinkSync(path.join(root, "release-child"));
			const previous = manager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "predecessor").message;
			assert.equal(previous.isError, false, JSON.stringify(previous));
			assert.equal(childStarts().length, 1);
			assert.equal(session.getSessionStats().cost, 1, "predecessor contributes one charge before continuation");
			assert.equal(session.getPendingToolCalls().length, 0);
			Object.assign(args, { action: variant === "answer-restart" ? "answer" : "continue", id: previous.details.runId,
				message: "Continue the saved fixture session", async: true });
			if (variant === "answer-restart") {
				const contract = readQuestionContract(args.id, 0);
				const question = createSupervisorQuestion({ runId: args.id, ownerTarget: "parent", agent: "fixture", index: 0,
					childSessionId: sdk.SessionManager.open(contract.sessionFile).getSessionId(), childTarget: "child",
					sessionFile: contract.sessionFile, cwd, pid: contract.pid, reason: "need_decision", message: "May the fixture continue?" });
				args.questionId = question.questionId;
			}
			wireCall.arguments = JSON.stringify(args);
		}
		if (variant === "fork") {
			faux.setResponses([fauxAssistantMessage([{ type: "toolCall", id: "inherited_inspection", name: "agent_runs", arguments: { action: "profiles" } }], { stopReason: "toolUse" }),
				fauxAssistantMessage("Inherited completed fanout inspection")]);
			await session.prompt("Inspect available child profiles");
			assert.equal(manager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "toolResult"
				&& entry.message.toolCallId === "inherited_inspection").message.isError, false);
		}
		const call = { type: "toolCall", id: originalCallId, name: toolName, arguments: args, async: true, responsesItem: wireCall };
		faux.setResponses([fauxAssistantMessage([call, { type: "text", text: "Independent parent answer while the child runs" }], { responseId: "initial-response", stopReason: "toolUse" }), fauxAssistantMessage("Ready for child result")]);
		const run = session.prompt("Delegate controlled work");
		await until(() => children().length === expectedChildren && session.getPendingToolCalls().some((call) => call.toolCallId === originalCallId), "one owned native call starts");
		const binding = manager.getEntries().find((entry) => entry.type === "custom" && entry.customType === "subagent-invocation" && entry.data.toolCallId === originalCallId)?.data;
		assert.equal(binding.toolCallId, originalCallId);
		assert.ok(fs.readFileSync(manager.getSessionFile(), "utf8").includes('"executionStarted":true'));
		assert.equal(resultEntries().length, 0, "native delegation cannot publish an ordinary launch receipt");
		if (providerSteering) {
			await session.steer("STEER_ONCE: continue independently while the original child runs");
			const expected = variant === "steering-disconnect" ? "unknown" : "applied";
			await until(() => evidence.steering.some((event) => event.status === expected), `provider steering reaches ${expected}`);
			if (variant === "steering-disconnect") {
				await until(() => provider.requests.filter((body) => body.type === "response.create").length === 2, "disconnect reconciles through a new provider request");
				const replay = provider.requests.filter((body) => body.type === "response.create")[1].input;
				assert.equal(replay.filter((item) => item.type === "function_call" && item.call_id === "delegate_original").length, 1);
				assert.equal(replay.filter((item) => item.type === "function_call_output").length, 0, "disconnect cannot fabricate a child result");
				assert.equal(replay.filter((item) => item.role === "user" && JSON.stringify(item.content).includes("STEER_ONCE")).length, 1);
			}
			await until(() => manager.getEntries().some((entry) => entry.type === "message" && entry.message.role === "assistant"
				&& entry.message.stopReason === "stop" && (variant === "steering-disconnect"
					? entry.message.responseId?.startsWith("recovered-") : entry.message.responseId === "steered-successor")), "independent provider response completes while the child remains pending");
			assert.deepEqual(evidence.steering.map((event) => event.status), ["queued", "accepted", expected]);
			assert.deepEqual(manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "response-steering").map((entry) => entry.data.status), ["queued", "accepted", expected]);
			assert.equal(resultEntries().length, 0);
			assert.equal(childStarts().length, 1);
			assert.equal(session.getSessionStats().cost, 0);
			evidence.checks.push(`real loopback Responses peer accepts steering; ${expected} is durably reported without replaying child effects or claiming completion`);
		}
		await session.abort(); await run;
		assert.equal(session.getPendingToolCalls()[0].state, "detached");
		assert.equal(resultEntries().length, 0);
		const originalLeaf = manager.getLeafId();
		if (variant === "compaction") {
			const kept = manager.appendMessage({ role: "user", content: "Retained after controlled compaction", timestamp: Date.now() });
			manager.appendCompaction("Controlled compaction with one unresolved native delegation", kept, 100);
		}
		const seed = { sessionFile: manager.getSessionFile(), sessionId: manager.getSessionId(), runId: continuation ? childStarts().at(-1).runId : binding.runId, pid: process.pid, originalLeaf,
			...(continuation ? { continuationArgs: args } : {}),
			beforeCall: manager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "user").id };
		if (continuation) {
			assert.notEqual(seed.runId, args.id, "continuation gets a distinct owned run");
			assert.equal(childStarts().filter((child) => child.runId === seed.runId).length, 1, "continuation launches exactly once");
			assert.equal(childStarts()[0].sessionFile, childStarts()[1].sessionFile, "continuation uses the completed child's saved journal");
			assert.equal(session.getSessionStats().cost, 1, "pending continuation has not charged usage");
			evidence.checks.push(`native agent_runs ${args.action} launches one saved-session continuation and remains pending on its original call`);
		}
		if (variant === "question-restart") {
			const child = childStarts()[0];
			const question = createSupervisorQuestion({ runId: binding.runId, ownerTarget: "parent", agent: "fixture", index: 0,
				childSessionId: sdk.SessionManager.open(child.sessionFile).getSessionId(), childTarget: "child", sessionFile: child.sessionFile,
				cwd, pid: child.pid, reason: "need_decision", message: "May the fixture complete?" });
			saveQuestionAnswer(question, "Proceed");
			seed.questionId = question.questionId;
		}
		fs.writeFileSync(path.join(root, "seed.json"), JSON.stringify(seed));
		if (variant === "canonical-result") {
			fs.writeFileSync(path.join(root, "release-child"), "release");
			await until(() => fs.existsSync(path.join(RESULTS_DIR, `${binding.runId}.json`)), "owner finishes result publication");
			assert.equal(fs.existsSync(path.join(agentDir, "sessions/subagent-runs", binding.runId, "result.json")), true);
			fs.rmSync(path.join(RESULTS_DIR, `${binding.runId}.json`));
			evidence.checks.push("only the canonical result remains before the fresh parent resumes");
		}
		evidence.checks.push("original call journaled before launch; abort leaves durable work pending without a tool result");
	} else if (phase === "fork") {
		assert.notEqual(process.pid, seed.pid);
		assert.equal(session.getPendingToolCalls()[0].toolCallId, originalCallId);
		const registered = session.agent.state.tools.find((tool) => tool.name === toolName);
		assert.equal(typeof registered.resume, "function", "fork must exercise the actual registered resume hook");
		const inheritedMessages = manager.buildSessionProjection().messages;
		assert.ok(inheritedMessages.some((message) => message.role === "toolResult" && message.toolCallId === "inherited_inspection"));
		const inheritedCall = inheritedMessages.flatMap((message) => message.role === "assistant" ? message.content : [])
			.find((block) => block.type === "toolCall" && block.id === originalCallId);
		assert.equal(inheritedCall.executionStarted, true);
		assert.equal(inheritedCall.executionDetached, true);
		const beforeStarts = childStarts();
		const inspect = async () => {
			const control = session.agent.state.tools.find((tool) => tool.name === "agent_runs");
			const result = await control.execute("fork_inspection", { action: "inspect", id: seed.runId }, new AbortController().signal);
			(evidence.forkInspections ??= []).push(result);
			assert.notEqual(result.isError, true, JSON.stringify(result));
			assert.equal(result.details.run, undefined, "explicit inspection cannot project the original run as fork-owned");
			assert.equal(manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "subagent-run"
				&& entry.data.ownerSessionId === manager.getSessionId()).length, 0, "fork cannot persist an owned-run adoption");
		};
		await inspect();
		faux.setResponses([fauxAssistantMessage("Inherited work belongs to the original parent"), fauxAssistantMessage("No work adopted")]);
		await session.prompt("Continue this fork without starting new work");
		await session.waitForIdle();
		assert.equal(session.getPendingToolCalls().length, 0);
		assert.equal(resultEntries().length, 1);
		assert.equal(resultEntries()[0].message.isError, true);
		assert.match(resultEntries()[0].message.content[0].text, /outcome is unknown/i);
		assert.deepEqual(childStarts(), beforeStarts, "fork must not execute the inherited call again");
		await inspect();
		assert.equal(session.getSessionStats().cost, 0);
		assert.equal(manager.getEntries().filter((entry) => entry.type === "usage" && entry.kind === "subagent").length, 0);
		assert.deepEqual(manager.getEntries().slice(0, inheritedEntries.length), inheritedEntries, "inherited tool history remains unchanged");
		assert.ok(evidence.providerInputs.some((messages) => messages.some((message) => message.role === "toolResult" && message.toolCallId === "inherited_inspection")));
		assert.ok(evidence.providerInputs.some((messages) => messages.some((message) => message.role === "assistant" && message.content.some((block) => block.type === "toolCall" && block.id === originalCallId))));
		assert.equal(fs.readFileSync(seed.sessionFile, "utf8"), sourceBytes, "fork cannot write into its parent's native journal");
		evidence.checks.push("actual native fork preserves full fanout tool history, reports unknown ownership, and creates no child, owned run, or usage charge");
	} else {
		assert.notEqual(process.pid, seed.pid, "reattachment must use a fresh parent process");
		assert.equal(session.getPendingToolCalls()[0].toolCallId, originalCallId);
		if (continuation) {
			const pendingCall = manager.buildSessionProjection().messages.flatMap((message) => message.role === "assistant" ? message.content : [])
				.find((block) => block.type === "toolCall" && block.id === originalCallId);
			assert.equal(pendingCall.name, "agent_runs");
			assert.equal(pendingCall.executionStarted, true);
			assert.equal(pendingCall.executionDetached, true);
			assert.equal(typeof session.agent.state.tools.find((tool) => tool.name === "agent_runs").resume, "function");
			assert.equal(session.getSessionStats().cost, 1, "reopening has only the predecessor's usage");
			if (variant === "answer-restart") {
				const question = listSupervisorQuestions(manager.getSessionId(), args.id).find((question) => question.questionId === args.questionId);
				assert.equal(question.state, "answered");
				assert.equal(question.answer.message, args.message);
				assert.equal(question.delivery.runId, seed.runId);
			}
		}
		if (variant === "question-restart") {
			const question = listSupervisorQuestions(manager.getSessionId(), seed.runId).find((question) => question.questionId === seed.questionId);
			assert.equal(question.state, "answer_pending");
			assert.equal(question.answer.message, "Proceed");
			assert.throws(() => saveQuestionAnswer(question, "Different answer"), /already has a different saved answer/);
			recordQuestionDelivery(question, { kind: "live", runId: seed.runId, deliveredAt: Date.now() });
			evidence.checks.push("startup retains the immutable saved supervisor answer before native call recovery");
		}
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
		assert.equal(children().length, expectedChildren, "recovery must not create another child");
		assert.equal(childStarts().length, expectedChildren, "recovery cannot re-execute even the same run ID");
		assert.equal(childStarts().filter((child) => child.runId === seed.runId).length, 1, "the pending run launches exactly once");
		assert.equal(resultEntries().length, 1);
		assert.equal(resultEntries()[0].message.toolName, toolName);
		assert.equal(resultEntries()[0].message.isError, false);
		assert.equal(resultEntries()[0].message.details.runId, seed.runId, "original call receives its own run's result");
		assert.match(resultEntries()[0].message.content[0].text, /NATIVE_ORIGINAL_CALL_RESULT/);
		assert.equal(resultEntries()[0].message.usage, undefined, "recordUsage and tool-result usage cannot charge the same work");
		assert.equal(manager.getEntries().filter((entry) => entry.type === "usage" && entry.kind === "subagent").length, expectedChildren);
		assert.equal(session.getSessionStats().cost, expectedChildren, "each launch contributes exactly one charge, including only new usage from a continued journal");
		assert.ok(!manager.getEntries().some((entry) => entry.type === "custom_message" && entry.customType === "subagent-notify"));
		if (providerSteering) {
			assert.equal(provider.requests.filter((body) => body.type === "response.steer").length, 0, "reopening must not resend accepted steering");
			assert.ok(provider.requests.some((body) => body.input?.some((item) => item.type === "function_call_output" && item.call_id === "delegate_original" && item.output.includes("NATIVE_ORIGINAL_CALL_RESULT"))));
			const steeringMessages = manager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "user" && JSON.stringify(entry.message.content).includes("STEER_ONCE"));
			assert.equal(steeringMessages.length, 1, "accepted steering input is persisted once through disconnect/reopen");
		}
		evidence.checks.push("fresh parent attaches the same owner and emits one original-call result with one native usage contribution");
	}
	if (provider) assert.deepEqual(provider.errors, []);
	assert.equal(childStarts().length, expectedChildren, "exactly one process per launch, plus a completed predecessor for continuation scenarios");
	assert.equal(evidence.networkRequests, 0);
	assert.deepEqual(evidence.errors, []);
} finally {
	await session.abort();
	await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	session.dispose();
	if (provider) await provider.close();
	fs.writeFileSync(path.join(root, `${phase}-evidence.json`), JSON.stringify({ ...evidence,
		providerRequests: provider?.requests, providerErrors: provider?.errors, childStarts: childStarts(), entries: manager.getEntries() }, null, 2));
}
