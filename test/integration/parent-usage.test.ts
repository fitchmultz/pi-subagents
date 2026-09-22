import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentExecutionResult, UsageContribution } from "../../src/shared/types.ts";
import { registerParentUsage } from "../../src/runs/shared/parent-usage.ts";
import { readNativeUsage, snapshotNativeUsage } from "../../src/runs/shared/native-usage.ts";

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
	const sessions: Array<{ abort(): Promise<void>; dispose(): void }> = [];
	t.after(async () => { for (const session of sessions) { await session.abort(); session.dispose(); } rmSync(root, { recursive: true, force: true }); });
	const faux = fauxProvider({ provider: "parent-usage-fixture" });
	const modelRuntime = await sdk.ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	modelRuntime.registerNativeProvider(faux.provider);
	async function open(file?: string) {
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
			}],
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		const { session } = await sdk.createAgentSession({ cwd: root, agentDir: root, modelRuntime, model: faux.getModel(), settingsManager, resourceLoader: loader,
			sessionManager: file ? sdk.SessionManager.open(file) : sdk.SessionManager.create(root, path.join(root, "sessions")), tools: ["usage_wait"] });
		sessions.push(session);
		await session.bindExtensions({ mode: "print", onError: (error: unknown) => errors.push(error) });
		const wait = async (...args: object[]) => {
			faux.setResponses([fauxAssistantMessage(args.map((params) => fauxToolCall("usage_wait", params)), { stopReason: "toolUse" }), fauxAssistantMessage("Done")]);
			await session.prompt("Read saved child work");
			assert.deepEqual(errors, []);
		};
		return { session, adapter, ctx, nativeAvailable, wait, setContributions(value: UsageContribution[]) { contributions = value; } };
	}
	return { open };
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
	await first.session.abort(); first.session.dispose();
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
	const entries = first.session.sessionManager.getEntries().filter((entry: any) => entry.type === "usage");
	assert.deepEqual(entries.map((entry: any) => [entry.contributionId, entry.provider, entry.model, entry.usage]), [
		["subagent:child-session:assistant-entry", "child-provider", "actual-response-model", usage],
		["subagent:child-session:summary-entry", "unattributed", "unattributed", usage],
	]);
	const file = first.session.sessionManager.getSessionFile();
	const before = readFileSync(file, "utf8");
	await first.session.abort(); first.session.dispose();
	const resumed = await h.open(file);
	assert.equal(resumed.adapter.record(contributions, resumed.ctx), true);
	assert.equal(readFileSync(file, "utf8"), before);
	assert.throws(() => resumed.adapter.record([{ ...contribution, model: "changed" }], resumed.ctx), /conflict/i);
	assert.equal(readFileSync(file, "utf8"), before);
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
