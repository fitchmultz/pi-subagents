// Actual native registration -> agent loop -> tool_result hook -> saved message -> native TUI events.
// Only the provider stream, leaf-child CLI, and local intercom acknowledgment are controlled.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire, findPackageJSON } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { Type } from "typebox";
import { createMockPi, events } from "../support/helpers.ts";

const [root, repo, sdkRoot, route] = process.argv.slice(2);
const cwd = path.join(root, "project"), agentDir = path.join(root, "agent");
for (const dir of [cwd, agentDir, path.join(cwd, ".pi/agents")]) fs.mkdirSync(dir, { recursive: true });
if (route === "child") Object.assign(process.env, { PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_FANOUT_CHILD: "1", PI_SUBAGENT_DEPTH: "1", PI_SUBAGENT_MAX_DEPTH: "2" });
fs.writeFileSync(path.join(cwd, ".pi/agents/probe.md"), "---\nname: probe\ndescription: Controlled leaf for native tool-result regression\nmodel: faux/faux-1\ncompletionGuard: false\ninheritProjectContext: false\ninheritSkills: false\n---\nReturn the controlled fixture response.\n");
const evidence = { route, nativeProviderRequests: 0, networkRequests: 0, extensionErrors: [], failures: [], cases: [] };
globalThis.fetch = async () => { evidence.networkRequests++; throw new Error("Network is forbidden in this fixture"); };
const sdk = await import(pathToFileURL(path.join(sdkRoot, "dist/index.js")).href);
const nativePackage = (name) => path.dirname(findPackageJSON(name, pathToFileURL(path.join(sdkRoot, "dist/index.js"))));
const { setKeybindings } = await import(createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")).resolve("@earendil-works/pi-tui"));
const { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore } = await import(pathToFileURL(path.join(nativePackage("@earendil-works/pi-ai"), "dist/index.js")).href);
const { visibleWidth } = await import(pathToFileURL(path.join(nativePackage("@earendil-works/pi-tui"), "dist/index.js")).href);
const { INTERCOM_DETACH_REQUEST_EVENT } = await import(pathToFileURL(path.join(repo, "dist/shared/types.js")).href);
const mock = createMockPi();
mock.install();
const bus = sdk.createEventBus();
const notifications = [];
let current, session, mode;
bus.on("subagent:result-intercom", (payload) => {
	notifications.push(JSON.parse(JSON.stringify(payload)));
	bus.emit("subagent:result-intercom-delivery", { requestId: payload.requestId, delivered: current?.stop === "detach" || current?.id === "intercom-receipt-success" });
});
const snapshot = (value) => JSON.parse(JSON.stringify(value));
const waitFor = async (predicate, label) => {
	const deadline = Date.now() + 15_000;
	while (!predicate()) { assert.ok(Date.now() < deadline, `Timeout: ${label}`); await delay(20); }
};
const calls = () => fs.readdirSync(mock.dir).filter((name) => name.startsWith("call-")).sort().map((name) => JSON.parse(fs.readFileSync(path.join(mock.dir, name), "utf8")));
const text = (result) => result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
const unwrap = (value) => value.replace(/\s/g, "");
const header = (card, mode) => card.split("\n").map((line) => line.trim()).find((line) => new RegExp(`^(?:failed|paused|detached|warning|ok|✗|■|✓) ${mode}(?:[ ·]|$)`).test(line));
const failureReason = "MIXED_BAD: required evidence was rejected";
const faux = fauxProvider({ api: "native-tool-result-fixture" });

function renderCard(card, width, id) {
	const lines = card.render(width);
	assert.ok(lines.every((line) => visibleWidth(line) <= width), `${id}: native card fits ${width} columns`);
	return lines.map(stripVTControlCharacters).map((line) => line.trimEnd()).join("\n");
}

async function open() {
	const settingsManager = sdk.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, showTerminalProgress: false });
	settingsManager.setProjectTrusted(true);
	const resourceLoader = new sdk.DefaultResourceLoader({
		cwd, agentDir, settingsManager, eventBus: bus,
		noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
		additionalExtensionPaths: [path.join(repo, "dist/extension/index.js"), ...(route === "child" ? [path.join(repo, "dist/extension/fanout-child.js")] : [])],
		extensionFactories: [(pi) => {
			pi.registerTool({ name: "fixture_throw", label: "Fixture throw", description: "Ordinary thrown-error control", parameters: Type.Object({}), execute() { throw new Error("ORDINARY_THROWN_CONTROL"); } });
			pi.on("tool_call", (event) => { if (event.toolCallId === "native-cancel") session.agent.abort(); });
			pi.on("before_provider_request", () => { evidence.nativeProviderRequests++; throw new Error("Real provider requests are forbidden"); });
		}],
	});
	await resourceLoader.reload();
	assert.deepEqual(resourceLoader.getExtensions().errors, []);
	const modelRuntime = await sdk.ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	modelRuntime.registerNativeProvider(faux.provider);
	({ session } = await sdk.createAgentSession({ cwd, agentDir, modelRuntime, model: faux.getModel(), settingsManager, resourceLoader, sessionManager: sdk.SessionManager.create(cwd, path.join(root, "sessions")), noTools: "builtin" }));
	await session.bindExtensions({ mode: "json", onError: (error) => evidence.extensionErrors.push(error) });
	evidence.sessionFile = session.sessionManager.getSessionFile();
	sdk.initTheme("dark", false);
	const runtime = new sdk.AgentSessionRuntime(session, { cwd, agentDir, modelRuntime, settingsManager, resourceLoader }, () => { throw new Error("Session replacement is not part of this fixture"); });
	mode = new sdk.InteractiveMode(runtime);
	// The unbundled fixture and installed renderer peers have separate TUI module instances.
	setKeybindings(mode.keybindings);
	// Keep the real native event-to-card path, without starting a terminal or taking keyboard ownership.
	mode.isInitialized = true;
	mode.workingVisible = false;
	mode.ui.requestRender = () => {};
	mode.subscribeToAgent();
	session.subscribe((event) => {
		if (event.toolCallId !== current?.id) return;
		if (event.type === "tool_execution_update" && event.partialResult.details?.progress?.some((progress) => progress.currentTool === (current.stop === "detach" ? "contact_supervisor" : "bash"))) {
			current.ready = true;
			if (current.id === "static-chain-interrupt-pure") current.liveUpdate = snapshot(event);
		}
		const settlingStatus = current.id === "static-chain-interrupt-mixed" ? "failed" : current.id === "static-chain-interrupt-pure" ? "paused" : undefined;
		if (event.type === "tool_execution_update" && settlingStatus && event.partialResult.details?.progress?.some((progress) => progress.index === 2 && progress.status === settlingStatus)) {
			const card = mode.chatContainer.children.find((component) => component instanceof sdk.ToolExecutionComponent);
			const wasExpanded = mode.toolOutputExpanded;
			const settlingCard = snapshot({ toolCallId: card.toolCallId, isPartial: card.isPartial, result: card.result });
			mode.setToolsExpanded(false);
			const settlingCollapsed = renderCard(card, 120, current.id);
			mode.setToolsExpanded(true);
			const settlingExpanded = renderCard(card, 120, current.id);
			mode.setToolsExpanded(wasExpanded);
			current.settling = { settlingUpdate: snapshot(event), settlingCard, settlingCollapsed, settlingExpanded };
		}
		if (event.type === "tool_execution_end") current.executionEnd = snapshot(event);
	});
}

async function invoke(receipt, name, args, stop) {
	const id = receipt.name;
	current = { id, stop, ready: false };
	mode.chatContainer.clear();
	mode.toolOutputExpanded = false;
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: "toolUse" }),
		fauxAssistantMessage("CONTROLLED_PARENT_DONE"),
	]);
	const pending = session.prompt(`Run the public synthetic fixture ${id}.`);
	// A real registered control call stops only this fixture's owned child; the tested workflow
	// itself always enters through session.prompt and the native registered-tool/agent-loop boundary.
	if (stop) {
		try {
			await waitFor(() => current.ready, `${id}: controlled child is waiting`);
			if (id === "static-chain-interrupt-pure") {
				const card = mode.chatContainer.children.find((component) => component instanceof sdk.ToolExecutionComponent);
				receipt.liveUpdate = current.liveUpdate;
				assert.equal(card.isPartial, true);
				assert.equal(card.result.isError, false);
				assert.deepEqual(snapshot(card.result.details), receipt.liveUpdate.partialResult.details);
				receipt.liveCollapsed = renderCard(card, 120, id);
				mode.setToolsExpanded(true);
				receipt.liveExpanded = renderCard(card, 120, id);
				mode.setToolsExpanded(false);
				for (const view of ["liveCollapsed", "liveExpanded"]) fs.writeFileSync(path.join(root, `${id}.${view}.txt`), receipt[view] + "\n");
			}
			const owned = session.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "subagent-run").at(-1);
			receipt.runId = owned.data.runId;
			if (stop === "detach") bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: id });
			else {
				const control = session.agent.state.tools.find((tool) => tool.name === "subagent");
				const result = await control.execute(`${id}-interrupt`, { action: "interrupt", id: receipt.runId }, new AbortController().signal);
				assert.equal(result.isError, undefined, text(result));
			}
		} catch (error) { await session.abort(); await pending; throw error; }
	}
	await pending;
	await session.waitForIdle();
	try {
		const saved = sdk.SessionManager.open(evidence.sessionFile).getEntries().filter((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === id);
		assert.equal(saved.length, 1, `${id}: exactly one native persisted toolResult`);
		receipt.result = snapshot(saved[0].message);
		receipt.executionEnd = current.executionEnd;
		Object.assign(receipt, current.settling);
		if (receipt.settlingUpdate) for (const view of ["settlingCollapsed", "settlingExpanded"]) fs.writeFileSync(path.join(root, `${id}.${view}.txt`), receipt[view] + "\n");
		receipt.calls = calls();
		const cards = mode.chatContainer.children.filter((component) => component instanceof sdk.ToolExecutionComponent);
		assert.equal(cards.length, 1, `${id}: native event handler must compose exactly one tool card`);
		assert.equal(cards[0].toolCallId, id);
		assert.equal(cards[0].result.isError, receipt.result.isError);
		assert.deepEqual(snapshot(cards[0].result.details), receipt.result.details);
		const render = (width) => renderCard(cards[0], width, id);
		receipt.collapsed = render(120);
		receipt.narrowCollapsed = render(40);
		mode.setToolsExpanded(true);
		receipt.expanded = render(120);
		receipt.narrowExpanded = render(40);
		mode.setToolsExpanded(false);
		assert.equal(render(120), receipt.collapsed, `${id}: native collapse restores the compact card`);
		assert.deepEqual(snapshot(cards[0].result.details), receipt.result.details, `${id}: rendering leaves native details unchanged`);
		assert.deepEqual(snapshot(cards[0].result.content), receipt.result.content, `${id}: rendering leaves model content unchanged`);
		for (const view of ["collapsed", "expanded", "narrowCollapsed", "narrowExpanded"]) fs.writeFileSync(path.join(root, `${id}.${view}.txt`), receipt[view] + "\n");
		return receipt.result;
	} finally {
		if (stop === "detach") await waitFor(() => notifications.some((entry) => entry.runId === receipt.runId), `${id}: detached fixture child settles`);
	}
}

async function check(name, run) {
	const receipt = { name, checks: [], failures: [] };
	evidence.cases.push(receipt);
	const verify = (label, fn) => {
		try { fn(); receipt.checks.push(label); }
		catch (error) { receipt.failures.push(`${label}: ${error.stack ?? error}`); }
	};
	mock.reset();
	try { await run(receipt, verify); }
	catch (error) { receipt.failures.push(error.stack ?? String(error)); }
}

function verifyNative(receipt, verify, expectedError) {
	verify("native error flag, finalized event and saved details agree", () => {
		assert.equal(receipt.result.isError, expectedError);
		assert.equal(receipt.executionEnd.isError, expectedError);
		assert.deepEqual(receipt.result.content, receipt.executionEnd.result.content);
		assert.deepEqual(receipt.result.details, receipt.executionEnd.result.details);
		assert.equal(Object.hasOwn(receipt.result.details, "isError"), false, "the native result hook removes its temporary marker");
	});
}

async function workflow(shape, stop, failed = true) {
	await check(`${shape}-${stop}-${failed ? "mixed" : "pure"}`, async (receipt, verify) => {
		receipt.mixed = failed;
		const single = shape === "single";
		const tokens = [...(single ? [] : ["MIXED_OK", ...(failed ? ["MIXED_BAD"] : [])]), "MIXED_WAIT", ...(stop === "interrupt" && !single ? ["MIXED_QUEUED"] : [])];
		const prefixCount = shape.endsWith("-chain") ? 1 : 0;
		const waitIndex = prefixCount + tokens.indexOf("MIXED_WAIT");
		mock.onCall({ matchArgsIncludes: "MIXED_SOURCE", output: "PREFIX_EVIDENCE", structuredOutput: { items: tokens } });
		mock.onCall({ matchArgsIncludes: "MIXED_OK", output: "SUCCESSFUL_SIBLING_EVIDENCE" });
		mock.onCall({ matchArgsIncludes: "MIXED_BAD", stderr: failureReason, exitCode: 1 });
		mock.onCall({ matchArgsIncludes: "MIXED_WAIT", steps: [
			{ jsonl: [events.toolStart(stop === "detach" ? "contact_supervisor" : "bash", stop === "detach" ? { reason: "need_decision" } : { command: "controlled wait" })] },
			{ delay: stop === "detach" ? 1_000 : 10_000, jsonl: [events.assistantMessage("DETACHED_CHILD_FINISHED")] },
		] });
		const tasks = tokens.map((task) => ({ agent: "probe", task, output: false }));
		const prefix = { agent: "probe", task: "MIXED_SOURCE", as: "targets", output: false, outputSchema: { type: "object" } };
		const group = shape === "dynamic-chain" ? {
			expand: { from: { output: "targets", path: "/items" }, maxItems: tokens.length },
			parallel: { agent: "probe", task: "{item}", output: false }, collect: { as: "collected" }, concurrency: 1, failFast: false,
		} : { parallel: tasks.map((task, index) => ({ ...task, ...(index === 0 ? { as: "evidence" } : {}) })), concurrency: 1, failFast: false };
		const result = await invoke(receipt, "subagent", {
			...(single ? tasks[0] : shape === "parallel" ? { tasks, concurrency: 1 } : { chain: [prefix, group, { agent: "probe", task: "MIXED_DOWNSTREAM", output: false }] }),
			async: false, context: "fresh", artifacts: false,
		}, stop);
		verifyNative(receipt, verify, failed);
		if (receipt.name === "static-chain-interrupt-pure") verify("sparse native live updates count their indexed child once", () => {
			const d = receipt.liveUpdate.partialResult.details;
			assert.equal(d.results.length, 2, "native update contains the prefix and only the current child");
			assert.equal(d.results[1].progress.index, 2, "the current child's flat index differs from its array position");
			assert.deepEqual(d.progress.filter((progress) => progress.status === "running").map((progress) => progress.index), [2]);
			for (const view of [receipt.liveCollapsed, receipt.liveExpanded]) assert.match(view, /chain · step 2\/3 · parallel group: 1 agent running/);
		});
		if (shape === "static-chain" && stop === "interrupt") verify("settling native updates count each failed or paused child once", () => {
			const status = failed ? "failed" : "paused";
			const d = receipt.settlingUpdate.partialResult.details;
			assert.equal(receipt.settlingCard.toolCallId, receipt.name);
			assert.equal(receipt.settlingCard.isPartial, true);
			assert.equal(receipt.settlingCard.result.isError, false);
			assert.deepEqual(receipt.settlingCard.result.details, d);
			assert.deepEqual(d.results.map((child) => child.progress.index), [0, 2]);
			assert.deepEqual(d.progress.filter((progress) => progress.status === status).map((progress) => progress.index), [2]);
			assert.ok(d.workflowGraph.nodes.every((node) => node.status !== "running"), "settling can be sparse even when no graph node is running");
			for (const view of [receipt.settlingCollapsed, receipt.settlingExpanded]) {
				const parts = header(view, "chain")?.split(" | ")[0].split(" · ");
				assert.equal(parts?.find((part) => part.endsWith(` ${status}`)), `1 ${status}`);
			}
		});
		verify("the actual children stop before queued/downstream work", () => {
			assert.equal(receipt.calls.length, waitIndex + 1);
			assert.deepEqual(receipt.calls.map((call) => call.expandedArgs.at(-1).match(/MIXED_(SOURCE|OK|BAD|WAIT|QUEUED|DOWNSTREAM)/)?.[0]), [ ...(prefixCount ? ["MIXED_SOURCE"] : []), ...tokens.slice(0, tokens.indexOf("MIXED_WAIT") + 1) ]);
		});
		verify("saved native details retain every successful/failed/stopped child and the handle", () => {
			const d = result.details;
			assert.equal(d.runId, receipt.runId);
			assert.equal(d.results.length, prefixCount + tokens.length);
			assert.equal(d.intercomDelivery, undefined, "stopped runs retain their control receipt, not a delivery receipt");
			if (!single) {
				assert.equal(d.results[prefixCount].finalOutput, "SUCCESSFUL_SIBLING_EVIDENCE");
				assert.equal(d.results[prefixCount].exitCode, 0);
			}
			if (failed) { assert.equal(d.results[prefixCount + 1].error, failureReason); assert.equal(d.results[prefixCount + 1].exitCode, 1); }
			assert.equal(d.results[waitIndex][stop === "detach" ? "detached" : "interrupted"], true);
			if (stop === "interrupt" && !single) assert.equal(d.results[waitIndex + 1].interrupted, true);
			if (prefixCount) {
				assert.equal(d.results[0].finalOutput, "PREFIX_EVIDENCE");
				assert.deepEqual(d.workflowGraph.nodes.map((node) => node.status), ["completed", failed ? "failed" : stop === "detach" ? "detached" : "paused", "pending"]);
				assert.deepEqual(d.outputs.targets.structured, { items: tokens });
				assert.equal(d.outputs.targets.text, JSON.stringify({ items: tokens }));
				if (shape === "static-chain") assert.equal(d.outputs.evidence.text, "SUCCESSFUL_SIBLING_EVIDENCE");
				else assert.equal(d.outputs.collected, undefined);
			}
		});
		verify("native final card renders retained sibling/prefix and graph rather than the text-only error", () => {
			if (!single) assert.match(receipt.expanded, /SUCCESSFUL_SIBLING_EVIDENCE/);
			assert.match(receipt.expanded, stop === "detach" ? /detached/i : /paused/i);
			if (failed) {
				assert.ok(receipt.expanded.includes(failureReason));
				assert.ok(receipt.expanded.includes(receipt.runId), "failed native card retains its exact run handle");
			}
			if (prefixCount) {
				assert.match(receipt.expanded, /PREFIX_EVIDENCE/);
				assert.match(receipt.expanded, /Step 1:/);
				assert.match(receipt.expanded, /Step 3:/);
				assert.match(receipt.expanded, /status: pending/);
			}
			if (prefixCount) assert.match(receipt.narrowExpanded, /PREFIX_EVIDENCE/);
		});
		verify("native compact and expanded headers report exact final outcomes", () => {
			const mode = single ? "probe" : prefixCount ? "chain" : "parallel";
			const label = `${prefixCount ? "step 2/3 · parallel group: " : ""}1/${tokens.length} succeeded${failed ? " · 1 failed" : ""} · ${stop === "interrupt" ? 2 : 1} paused`;
			const compact = header(receipt.collapsed, mode);
			const expanded = header(receipt.expanded, mode)?.split(" | ")[0];
			if (single) {
				assert.match(compact, /^■ probe/);
				assert.equal(expanded, `${stop === "detach" ? "detached" : "paused"} probe`);
			} else {
				const expected = `${failed ? "✗" : "■"} ${mode} · ${label}`;
				assert.equal(compact?.split(" · ").slice(0, expected.split(" · ").length).join(" · "), expected);
				assert.equal(expanded, `${failed ? "failed" : "paused"} ${mode} · ${label}`);
			}
			assert.doesNotMatch(compact, /agents? running/);
			if (!failed) assert.doesNotMatch(`${compact}\n${expanded}`, /failed|warning/);
		});
		verify("native expansion retains the full stop receipt and exact recovery handle", () => {
			for (const view of [receipt.expanded, receipt.narrowExpanded]) {
				assert.ok(unwrap(view).includes(unwrap(text(result))), "expanded card must keep every control receipt line");
				assert.ok(unwrap(view).includes(receipt.runId), "even a pure pause/detach keeps its exact run handle");
			}
			assert.match(receipt.narrowCollapsed, /ctrl\+o/i);
			assert.doesNotMatch(receipt.collapsed, /Do this now:|Inspect pending asks|After the child exits/);
			if (stop === "detach") {
				assert.match(text(result), /Child is waiting on a parent\/coordinator reply\./);
				assert.match(text(result), /Reply: intercom\(\{ action: "reply", to: "/);
				assert.ok(text(result).includes(`Then inspect the child: ${route === "parent" ? "agent_runs" : "subagent"}({ action: "${route === "parent" ? "inspect" : "status"}", id: "${receipt.runId}" })`), text(result));
			} else assert.match(text(result), /Waiting for explicit next action\./);
		});
	});
}

try {
	await open();
	if (route === "parent") await check("load-success", async (receipt, verify) => {
		await invoke(receipt, "load_subagent", {});
		verifyNative(receipt, verify, false);
		verify("loader still enables the actual registered tool", () => assert.ok(session.agent.state.tools.some((tool) => tool.name === "subagent")));
	});
	for (const shape of ["parallel", "static-chain", "dynamic-chain"]) for (const stop of ["interrupt", "detach"]) for (const failed of [true, false]) await workflow(shape, stop, failed);
	for (const stop of ["interrupt", "detach"]) await workflow("single", stop, false);
	await check("static-preflight-failure", async (receipt, verify) => {
		mock.onCall({ matchArgsIncludes: "STATIC_PREFIX", output: "STATIC_PREFIX_EVIDENCE" });
		const result = await invoke(receipt, "subagent", {
			chain: [
				{ agent: "probe", task: "STATIC_PREFIX", as: "prefix", output: false },
				{ parallel: [{ agent: "probe", task: "STATIC_INVALID", as: "unpublished", outputMode: "file-only", output: false }] },
				{ agent: "probe", task: "STATIC_DOWNSTREAM", as: "downstream", output: false },
			], async: false, context: "fresh", artifacts: false,
		});
		verifyNative(receipt, verify, true);
		verify("static preflight error keeps the successful prefix and launches no later child", () => {
			assert.equal(receipt.calls.length, 1);
			assert.match(receipt.calls[0].expandedArgs.at(-1), /STATIC_PREFIX/);
			assert.equal(result.details.intercomDelivery, undefined);
			assert.deepEqual(result.details.results.map((child) => [child.exitCode, child.finalOutput]), [[0, "STATIC_PREFIX_EVIDENCE"]]);
			assert.equal(result.details.outputs.prefix.text, "STATIC_PREFIX_EVIDENCE");
			assert.equal(result.details.outputs.unpublished, undefined);
			assert.equal(result.details.outputs.downstream, undefined);
			assert.deepEqual(result.details.workflowGraph.nodes.map((node) => node.status), ["completed", "running", "pending"], "native failure must outrank the graph's last position without rewriting it");
			assert.deepEqual(result.details.workflowGraph.nodes[1].children.map((node) => node.status), ["running"]);
			assert.match(text(result), /sets outputMode: "file-only" but does not configure an output file/);
		});
		verify("native error truth controls both headers even without a failed child or graph node", () => {
			assert.ok(header(receipt.collapsed, "chain")?.startsWith("✗ chain · step 2/3 · parallel group: 0/1 succeeded"));
			assert.equal(header(receipt.expanded, "chain")?.split(" | ")[0], "failed chain · step 2/3 · parallel group: 0/1 succeeded");
			for (const view of [receipt.expanded, receipt.narrowExpanded]) {
				assert.match(view, /STATIC_PREFIX_EVIDENCE/);
				assert.ok(unwrap(view).includes("doneStep1:probe"), "the prefix child remains successful");
				assert.ok(unwrap(view).includes(unwrap(text(result))));
				assert.ok(unwrap(view).includes(result.details.runId));
			}
		});
	});
	for (const rejected of [true, false]) await check(`dynamic-collect-${rejected ? "schema-failure" : "success"}`, async (receipt, verify) => {
		const targets = { items: [{ path: "src/a.ts" }] };
		mock.onCall({ matchArgsIncludes: "COLLECT_SOURCE", output: "COLLECT_PREFIX_EVIDENCE", structuredOutput: targets });
		mock.onCall({ matchArgsIncludes: "Review src/a.ts", output: "COLLECT_CHILD_EVIDENCE", structuredOutput: { ok: "a" } });
		mock.onCall({ matchArgsIncludes: "COLLECT_DOWNSTREAM", output: "COLLECT_DOWNSTREAM_EVIDENCE" });
		const result = await invoke(receipt, "subagent", {
			chain: [
				{ agent: "probe", task: "COLLECT_SOURCE", as: "targets", output: false, outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, key: "/path", maxItems: 4 },
					parallel: { agent: "probe", task: "Review {item.path}", output: false, outputSchema: { type: "object" } },
					collect: { as: "reviews", outputSchema: { type: rejected ? "object" : "array" } },
				},
				{ agent: "probe", task: "COLLECT_DOWNSTREAM {outputs.reviews}", output: false },
			], async: false, context: "fresh", artifacts: false,
		});
		verifyNative(receipt, verify, rejected);
		verify("native collection truth retains successful children and never publishes invalid output", () => {
			assert.equal(result.details.intercomDelivery, undefined, "aggregate failure must be tested without an intercom receipt");
			assert.equal(receipt.calls.length, rejected ? 2 : 3);
			assert.deepEqual(result.details.results.map((child) => child.exitCode), rejected ? [0, 0] : [0, 0, 0]);
			assert.deepEqual(result.details.results.slice(0, 2).map((child) => child.finalOutput), ["COLLECT_PREFIX_EVIDENCE", "COLLECT_CHILD_EVIDENCE"]);
			assert.deepEqual(result.details.results.slice(0, 2).map((child) => child.structuredOutput), [targets, { ok: "a" }]);
			assert.deepEqual(result.details.outputs.targets.structured, targets);
			assert.deepEqual(result.details.workflowGraph.nodes.map((node) => node.status), rejected ? ["completed", "failed", "pending"] : ["completed", "completed", "completed"]);
			assert.deepEqual(result.details.workflowGraph.nodes[1].children.map((node) => node.status), ["completed"]);
			if (rejected) {
				assert.equal(result.details.outputs.reviews, undefined);
				assert.match(text(result), /Collected output validation failed/);
				assert.match(result.details.workflowGraph.nodes[1].error, /Collected output validation failed/);
				assert.ok(receipt.calls.every((call) => !call.expandedArgs.at(-1).includes("COLLECT_DOWNSTREAM")));
			} else assert.equal(result.details.outputs.reviews.structured.length, 1);
		});
		verify("native cards preserve aggregate diagnosis without hiding successful child evidence", () => {
			for (const view of [receipt.expanded, receipt.narrowExpanded]) {
				assert.match(view, /COLLECT_PREFIX_EVIDENCE/);
				assert.match(view, /COLLECT_CHILD_EVIDENCE/);
				if (rejected) {
					assert.match(view, /Collected output validation failed/);
					assert.ok(unwrap(view).includes(unwrap(text(result))));
					assert.ok(unwrap(view).includes(result.details.runId));
				} else assert.match(view, /COLLECT_DOWNSTREAM_EVIDENCE/);
			}
			const expected = rejected ? "failed chain · step 2/3 · parallel group: 1/1 succeeded" : "ok chain · step 3/3";
			assert.equal(header(receipt.expanded, "chain")?.split(" | ")[0], expected);
			assert.ok(header(receipt.collapsed, "chain")?.startsWith(rejected ? "✗ chain · step 2/3 · parallel group: 1/1 succeeded" : "✓ chain · step 3/3"));
		});
	});
	for (const delivered of [false, true]) await check(delivered ? "intercom-receipt-success" : "normal-success", async (receipt, verify) => {
		mock.onCall({ output: "NORMAL_SUCCESS_EVIDENCE" });
		await invoke(receipt, route === "parent" ? "delegate" : "subagent", { agent: "probe", task: "normal success", output: false, async: false, context: "fresh" });
		verifyNative(receipt, verify, false);
		verify("nonerror content, details and rendering survive", () => {
			if (delivered) {
				assert.equal(receipt.result.details.intercomDelivery.delivered, true);
				assert.equal(receipt.result.details.results[0].finalOutput, undefined);
				assert.ok(unwrap(receipt.narrowExpanded).includes(unwrap(text(receipt.result))));
				assert.match(receipt.collapsed, /receipt details/);
				assert.doesNotMatch(`${receipt.collapsed}\n${receipt.expanded}`, /warning|failed|no text output|NORMAL_SUCCESS_EVIDENCE/);
			} else {
				assert.match(text(receipt.result), /NORMAL_SUCCESS_EVIDENCE/);
				assert.equal(receipt.result.details.results[0].finalOutput, "NORMAL_SUCCESS_EVIDENCE");
				assert.match(receipt.expanded, /NORMAL_SUCCESS_EVIDENCE/);
				assert.equal(receipt.expanded.match(/NORMAL_SUCCESS_EVIDENCE/g).length, 1, "ordinary success does not duplicate model content");
			}
		});
	});
	await check("inspect-handle", async (receipt, verify) => {
		const runId = evidence.cases.find((entry) => entry.name === "static-chain-interrupt-mixed").runId;
		await invoke(receipt, route === "parent" ? "agent_runs" : "subagent", { action: route === "parent" ? "inspect" : "status", id: runId });
		verifyNative(receipt, verify, false);
		verify("native inspection renders the exact saved run handle without restarting it", () => {
			assert.equal(receipt.result.details.run.runId, runId);
			assert.equal(receipt.result.details.run.state, "failed");
			assert.ok(receipt.expanded.includes(runId));
			assert.match(receipt.expanded, /SUCCESSFUL_SIBLING_EVIDENCE/);
			assert.equal(receipt.calls.length, 0);
		});
	});
	if (route === "parent") {
		await check("delegate-failure", async (receipt, verify) => {
			mock.onCall({ output: "FAILED_CHILD_EVIDENCE", stderr: failureReason, exitCode: 1 });
			await invoke(receipt, "delegate", { agent: "probe", task: "controlled failure", output: false, async: false, context: "fresh" });
			verifyNative(receipt, verify, true);
			verify("delegate retains failed child details and rendering", () => {
				assert.equal(receipt.result.details.results[0].finalOutput, "FAILED_CHILD_EVIDENCE");
				assert.match(receipt.expanded, /FAILED_CHILD_EVIDENCE/);
				assert.match(header(receipt.collapsed, "probe"), /^✗ probe/);
				assert.ok(receipt.expanded.includes(receipt.result.details.runId));
			});
		});
		await check("agent-runs-error", async (receipt, verify) => {
			await invoke(receipt, "agent_runs", { action: "inspect", id: "not-owned" });
			verifyNative(receipt, verify, true);
			verify("returned management error keeps its original details", () => assert.deepEqual(receipt.result.details, { mode: "single", results: [] }));
		});
		for (const [name, tool, args, expected] of [
			["ordinary-throw", "fixture_throw", {}, /ORDINARY_THROWN_CONTROL/],
			["native-validation", "delegate", {}, /validation|required/i],
			["native-cancel", "delegate", { agent: "probe", task: "must not launch" }, /Operation aborted/],
		]) await check(name, async (receipt, verify) => {
			await invoke(receipt, tool, args);
			verifyNative(receipt, verify, true);
			verify("native exception/validation/cancellation semantics are unchanged", () => {
				assert.match(text(receipt.result), expected);
				assert.deepEqual(receipt.result.details, {});
				assert.equal(receipt.calls.length, 0);
			});
		});
	} else await check("child-management-error", async (receipt, verify) => {
		await invoke(receipt, "subagent", { action: "create", config: { name: "not-created" } });
		verifyNative(receipt, verify, true);
		verify("child-safe mutation rejection remains a native tool error with its details", () => {
			assert.match(text(receipt.result), /not available from child-safe/);
			assert.equal(receipt.result.details.mode, "management");
			assert.equal(fs.existsSync(path.join(cwd, ".pi/agents/not-created.md")), false);
		});
	});
} catch (error) {
	evidence.failures.push(error.stack ?? String(error));
} finally {
	if (session) {
		await session.abort();
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		mode?.unsubscribe?.();
		mode?.footer.dispose();
		mode?.footerDataProvider.dispose();
		session.dispose();
	}
	mock.uninstall();
	evidence.fauxProviderCalls = faux.state.callCount;
	fs.writeFileSync(path.join(root, "evidence.json"), JSON.stringify(evidence, null, 2));
	console.log(JSON.stringify({ route, cases: evidence.cases.map(({ name, checks, failures }) => ({ name, checks: checks.length, failures })), failures: evidence.failures, nativeProviderRequests: evidence.nativeProviderRequests, networkRequests: evidence.networkRequests, sessionFile: evidence.sessionFile }));
	if (evidence.failures.length || evidence.cases.some((receipt) => receipt.failures.length)) process.exitCode = 1;
}
