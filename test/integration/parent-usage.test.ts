import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_LIVE_INTERCOM_EVENT, SUBAGENT_LIVE_INTERCOM_DELIVERY_EVENT, SUBAGENT_RESULT_INTERCOM_EVENT, SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, type SubagentExecutionResult, type UsageContribution } from "../../src/shared/types.ts";
import { registerParentUsage } from "../../src/runs/shared/parent-usage.ts";
import { readNativeUsage, snapshotNativeUsage } from "../../src/runs/shared/native-usage.ts";
import registerSubagents from "../../src/extension/index.ts";
import registerFanoutSubagent from "../../src/extension/fanout-child.ts";
import { getRunMetadataDir, saveQuestionOwner, saveQuestionContract, saveRunStatus, saveAsyncRunResult } from "../../src/runs/shared/supervisor-questions.ts";
import { createNestedRoute, writeNestedEvent, readNestedControlRequests, writeNestedControlResult } from "../../src/runs/shared/nested-events.ts";

const sdkRoot = process.env.PI_PARENT_USAGE_TEST_SDK ?? path.dirname(findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url)!);
const sdkEntry = pathToFileURL(path.join(sdkRoot, "dist/index.js"));
const sdk = await import(sdkEntry.href);
const aiRoot = path.dirname(findPackageJSON("@earendil-works/pi-ai", sdkEntry)!);
const { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore } = await import(pathToFileURL(path.join(aiRoot, "dist/index.js")).href);
const usage = { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cacheWrite1h: 15, reasoning: 5,
	totalTokens: 100, cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 } };
const contribution: UsageContribution = { id: "child-session:assistant-entry", provider: "child-provider", model: "actual-response-model", usage };
const result = (): SubagentExecutionResult => ({ content: [{ type: "text", text: "Saved child result" }], details: { mode: "management", results: [] } });

async function harness(t: TestContext, portable = true) {
	const root = mkdtempSync(path.join(tmpdir(), "parent-usage-"));
	const sessions = new Set<InstanceType<typeof sdk.AgentSession>>();
	async function close(session: InstanceType<typeof sdk.AgentSession>) {
		if (!sessions.delete(session)) return;
		await session.abort();
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	}
	t.after(async () => { for (const session of sessions) await close(session); rmSync(root, { recursive: true, force: true }); });
	const faux = fauxProvider({ provider: "parent-usage-fixture" });
	const modelRuntime = await sdk.ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	modelRuntime.registerNativeProvider(faux.provider);
	async function open(file?: string, delegation?: { tool: string; register: (pi: ExtensionAPI) => void }) {
		let adapter!: ReturnType<typeof registerParentUsage>;
		let ctx!: ExtensionContext;
		let nativeAvailable = false;
		let contributions = [contribution];
		const errors: unknown[] = [];
		const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
		const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [(pi: ExtensionAPI) => {
				nativeAvailable = typeof (pi as ExtensionAPI & { recordUsage?: unknown }).recordUsage === "function";
				adapter = registerParentUsage(portable ? { on: pi.on } as ExtensionAPI : pi, ["usage_wait"]);
				pi.on("session_start", (_event, context) => { ctx = context; });
				pi.registerTool({ name: "usage_wait", label: "Usage wait", description: "Read a finalized fixture child", parameters: Type.Object({ discard: Type.Optional(Type.Boolean()), inspect: Type.Optional(Type.Boolean()) }),
					async execute(_id, params, signal, onUpdate, context) {
						onUpdate?.(result());
						if (params.inspect) return result();
						const final = adapter.attach(result(), contributions, context);
						if (params.discard) {
							context.abort();
							assert.equal(signal?.aborted, true);
							throw new DOMException("Wait aborted before returning its result", "AbortError");
						}
						return final;
					},
				});
				delegation?.register(pi);
			}],
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		const { session } = await sdk.createAgentSession({ cwd: root, agentDir: root, modelRuntime, model: faux.getModel(), settingsManager, resourceLoader: loader,
			sessionManager: file ? sdk.SessionManager.open(file) : sdk.SessionManager.create(root, path.join(root, "sessions")), tools: ["usage_wait", ...(delegation ? [delegation.tool] : [])] });
		sessions.add(session);
		await session.bindExtensions({ mode: "print", onError: (error: unknown) => errors.push(error) });
		const invoke = async (tool: string, ...args: object[]) => {
			faux.setResponses([fauxAssistantMessage(args.map((params) => fauxToolCall(tool, params)), { stopReason: "toolUse" }), fauxAssistantMessage("Done")]);
			await session.prompt("Read saved child work");
			assert.deepEqual(errors, []);
		};
		return { session, adapter, ctx, nativeAvailable, invoke, wait: (...args: object[]) => invoke("usage_wait", ...args), setContributions(value: UsageContribution[]) { contributions = value; } };
	}
	return { open, close };
}

function toolMessages(session: any) {
	return session.sessionManager.getEntries().flatMap((entry: any) => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []);
}

test("portable concurrent final waits charge once in native journal and survive a fresh session reader", async (t) => {
	const h = await harness(t);
	const first = await h.open();
	await first.wait({}, {});
	assert.equal(first.session.getSessionStats().cost, 10);
	assert.deepEqual(toolMessages(first.session).map((message: any) => message.usage), [usage, undefined]);
	const file = first.session.sessionManager.getSessionFile();
	assert.equal(readFileSync(file, "utf8").split("\n").filter((line) => line.includes('"role":"toolResult"') && line.includes('"parentUsage"')).length, 1);
	await h.close(first.session);
	const resumed = await h.open(file);
	await resumed.wait({});
	assert.equal(resumed.session.getSessionStats().cost, 10);
	assert.equal(toolMessages(resumed.session).at(-1).usage, undefined);
	resumed.setContributions([contribution, { ...contribution, id: "child-session:resumed-entry" }]);
	await resumed.wait({});
	assert.equal(resumed.session.getSessionStats().cost, 20, "only resumed child work is new");
});

test("portable discarded result does not reserve usage; inspection and custom details never charge", async (t) => {
	const h = await harness(t);
	const { session, adapter, ctx, wait } = await h.open();
	assert.equal(adapter.record([contribution], ctx), false, "async-only portable accounting is explicitly unsupported");
	const prepared = adapter.attach(result(), [contribution], ctx);
	session.sessionManager.appendCustomMessageEntry("subagent-notify", "finished", false, { result: prepared });
	await wait({ inspect: true }, { discard: true });
	assert.equal(session.getSessionStats().cost, 0);
	assert.ok(toolMessages(session).every((message: any) => message.usage === undefined));
	await wait({}, {});
	assert.equal(session.getSessionStats().cost, 10);
	assert.deepEqual(toolMessages(session).slice(-2).map((message: any) => message.usage), [usage, undefined]);
});

test("native delayed recordUsage keeps attribution and deduplicates after recovery without a tool receipt", async (t) => {
	const h = await harness(t, false);
	const first = await h.open();
	if (!first.nativeAvailable) {
		assert.notEqual(process.env.PI_PARENT_USAGE_REQUIRE_NATIVE, "1", "native recordUsage required by this test invocation");
		t.skip("host has no public recordUsage; portable path tested separately"); return;
	}
	await first.wait({ inspect: true });
	const contributions = [contribution, { id: "child-session:summary-entry", usage }];
	assert.equal(first.adapter.record(contributions, first.ctx), true);
	assert.equal(first.session.getSessionStats().cost, 20);
	assert.equal(first.adapter.attach(result(), contributions, first.ctx).usage, undefined, "native usage must not also travel on tool result");
	first.setContributions(contributions);
	await first.wait({});
	assert.equal(first.session.getSessionStats().cost, 20);
	assert.ok(toolMessages(first.session).every((message: any) => message.usage === undefined));
	const entries = first.session.sessionManager.getEntries().filter((entry: any) => entry.type === "usage");
	assert.deepEqual(entries.map((entry: any) => [entry.contributionId, entry.provider, entry.model, entry.usage]), [
		["subagent:child-session:assistant-entry", "child-provider", "actual-response-model", usage],
		["subagent:child-session:summary-entry", "unattributed", "unattributed", usage],
	]);
	const file = first.session.sessionManager.getSessionFile();
	const before = readFileSync(file, "utf8");
	await h.close(first.session);
	const resumed = await h.open(file);
	assert.equal(resumed.adapter.record(contributions, resumed.ctx), true);
	assert.equal(readFileSync(file, "utf8"), before);
	assert.throws(() => resumed.adapter.record([{ ...contribution, model: "changed" }], resumed.ctx), /conflict/i);
	assert.equal(readFileSync(file, "utf8"), before);
});

test("native delayed usage survives restart before the parent's first assistant turn", async (t) => {
	const h = await harness(t, false);
	const first = await h.open();
	if (!first.nativeAvailable) {
		assert.notEqual(process.env.PI_PARENT_USAGE_REQUIRE_NATIVE, "1");
		t.skip("host has no public recordUsage"); return;
	}
	first.adapter.record([contribution], first.ctx);
	const file = first.session.sessionManager.getSessionFile();
	assert.ok(existsSync(file), "successful native recordUsage must persist paid work even before the first assistant turn");
	await h.close(first.session);
	const resumed = await h.open(file);
	resumed.adapter.record([contribution], resumed.ctx);
	assert.equal(resumed.session.getSessionStats().cost, 10);
	assert.equal(resumed.session.sessionManager.getEntries().filter((entry: any) => entry.type === "usage").length, 1);
});

test("native grandchild usage reaches the parent once through the child's own journal delta", async (t) => {
	const h = await harness(t, false);
	const child = await h.open();
	if (!child.nativeAvailable) {
		assert.notEqual(process.env.PI_PARENT_USAGE_REQUIRE_NATIVE, "1");
		t.skip("host has no public recordUsage"); return;
	}
	await child.wait({ inspect: true });
	const file = child.session.sessionManager.getSessionFile();
	const baseline = snapshotNativeUsage(file);
	child.adapter.record([contribution], child.ctx);
	const delta = readNativeUsage(file, baseline)![0]!.contributions!;
	assert.equal(delta.length, 1);
	assert.notEqual(delta[0].id, contribution.id, "the parent imports its direct child's native entry, not a recursive grandchild rollup");
	assert.equal(delta[0].provider, contribution.provider);
	assert.equal(delta[0].model, contribution.model);
	const parent = await h.open();
	parent.adapter.record(delta, parent.ctx);
	parent.adapter.record(delta, parent.ctx);
	assert.equal(parent.session.getSessionStats().cost, 10);
	assert.equal(parent.session.sessionManager.getEntries().filter((entry: any) => entry.type === "usage").length, 1);
});

for (const surface of ["parent", "child-advanced", "child-compact"]) test(`${surface} nested continuation charges only the later direct-child journal delta`, async (t) => {
	const childSafe = surface !== "parent", advanced = surface === "child-advanced";
	const h = await harness(t), child = await h.open(), original = await h.open();
	await child.wait({ inspect: true });
	// Native journals buffer pre-response entries; persist the parent before reopening it.
	await original.wait({ inspect: true });
	const childFile = child.session.sessionManager.getSessionFile(), baseline = snapshotNativeUsage(childFile);
	const parentId = original.session.sessionManager.getSessionId();
	const rootId = randomUUID(), nestedId = randomUUID(), rootDir = getRunMetadataDir(rootId), nestedDir = getRunMetadataDir(nestedId), route = createNestedRoute(rootId);
	const cwd = child.ctx.cwd;
	const owner = { runId: rootId, rootRunId: rootId, ownerSessionId: parentId, source: "async", mode: "single", cwd, task: "Direct child", startedAt: Date.now(), asyncDir: rootDir, children: [{ agent: "worker", index: 0, sessionFile: childFile }] };
	original.session.sessionManager.appendCustomEntry("subagent-run", owner);
	const savedParentFile = original.session.sessionManager.getSessionFile();
	saveQuestionOwner(rootId, parentId); saveQuestionOwner(nestedId, child.session.sessionManager.getSessionId());
	for (const [id, sessionId] of [[rootId, savedParentFile], [nestedId, childFile]]) saveRunStatus(id, { runtimeVersion: 2, runId: id, sessionId, mode: "single", state: "running", pid: process.pid, startedAt: Date.now(), cwd, controlRequestFiles: true, steps: [{ agent: "worker", status: "running", ...(id === rootId ? { sessionFile: childFile } : {}) }] });
	saveQuestionContract(rootId, 0, { task: "Direct child", sessionFile: childFile });
	saveQuestionContract(nestedId, 0, { task: "Grandchild work" });
	writeFileSync(path.join(nestedDir, "launch.json"), JSON.stringify({ runtimeVersion: 2, nestedRoute: route, nestedSelf: { parentRunId: rootId } }));
	writeNestedEvent(route, { type: "subagent.nested.started", ts: Date.now(), parentRunId: rootId, parentStepIndex: 0, child: { id: nestedId, parentRunId: rootId, parentStepIndex: 0, depth: 1, path: [{ runId: rootId, stepIndex: 0 }], state: "running", mode: "single", agent: "worker", asyncDir: nestedDir } });
	const env = { PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_FANOUT_CHILD: "1", PI_SUBAGENT_PARENT_ROOT_RUN_ID: rootId, PI_SUBAGENT_PARENT_RUN_ID: rootId, PI_SUBAGENT_PARENT_CHILD_INDEX: "0", PI_SUBAGENT_PARENT_EVENT_SINK: route.eventSink, PI_SUBAGENT_PARENT_CONTROL_INBOX: route.controlInbox, PI_SUBAGENT_PARENT_CAPABILITY_TOKEN: route.capabilityToken };
	const savedEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	if (childSafe) Object.assign(process.env, env);
	await h.close(original.session);
	let directUsage;
	const parent = await h.open(savedParentFile, { tool: advanced ? "subagent" : "agent_runs", register(pi) {
		(childSafe ? registerFanoutSubagent : registerSubagents)(pi);
		for (const [send, delivered] of [[SUBAGENT_LIVE_INTERCOM_EVENT, SUBAGENT_LIVE_INTERCOM_DELIVERY_EVENT], [SUBAGENT_RESULT_INTERCOM_EVENT, SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT]]) {
			pi.events.on(send, (request) => {
				if (request.runId !== rootId) return;
				saveAsyncRunResult(rootId, { runtimeVersion: 2, id: rootId, state: "complete", success: true, results: [{ agent: "worker", success: true, exitCode: 0, output: "Direct child completed", sessionFile: childFile, usage: directUsage }] });
				pi.events.emit(delivered, { requestId: request.requestId, delivered: true });
			});
		}
	} });
	let delivered = false;
	const reply = setInterval(() => {
		const request = readNestedControlRequests(route)[0]; if (!request || delivered) return; delivered = true;
		saveAsyncRunResult(nestedId, { runtimeVersion: 2, id: nestedId, state: "complete", success: true, results: [{ agent: "worker", success: true, exitCode: 0, output: "Grandchild completed", usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cost: 10, turns: 1, contributions: [contribution] } }] });
		writeNestedControlResult(route, { ts: Date.now(), requestId: request.requestId, targetRunId: nestedId, ok: true, message: "Nested guidance delivered" });
	}, 10);
	t.after(() => { clearInterval(reply); for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } for (const dir of [rootDir, nestedDir, path.dirname(route.eventSink)]) rmSync(dir, { recursive: true, force: true }); });
	const tool = advanced ? "subagent" : "agent_runs", action = advanced ? "resume" : "continue";
	await parent.invoke(tool, { action, id: nestedId, message: "Finish grandchild", async: false });
	const nestedResult = toolMessages(parent.session).at(-1);
	assert.equal(nestedResult.isError, false, nestedResult.content[0]?.text);
	assert.match(nestedResult.content[0]?.text, /Grandchild completed/);
	assert.equal(nestedResult.details.run.ownerSessionId, child.session.sessionManager.getSessionId());
	assert.equal(parent.session.getSessionStats().cost, 0, "observing a descendant must not charge it directly to the ancestor");
	await child.wait({}, {});
	directUsage = readNativeUsage(childFile, baseline)![0]!;
	assert.equal(directUsage.cost, 10);
	assert.ok(directUsage.contributions.every((item) => item.id !== contribution.id));
	await parent.invoke(tool, { action, id: rootId, message: "Finish direct child", async: false });
	assert.match(toolMessages(parent.session).at(-1).content[0]?.text, /Direct child completed/);
	assert.equal(parent.session.getSessionStats().cost, 10, "the direct child's native journal delta is charged exactly once");
	await parent.invoke(tool, { action: advanced ? "status" : "inspect", id: rootId });
	assert.equal(parent.session.getSessionStats().cost, 10);
});
