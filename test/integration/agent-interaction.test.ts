import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import childProcess from "node:child_process";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { CustomMessageComponent, initTheme, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { Container, CURSOR_MARKER, Editor, ScrollView, Spacer, Text, TuiMainScreen, TuiAltScreen, VStack, getKeybindings, setKeybindings, visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
import { createEventBus, createMockPi, makeAgent, makeMinimalCtx } from "../support/helpers.ts";
import { createTestTerminal } from "../support/terminal.ts";
import type { OwnedRun, SubagentState } from "../../src/shared/types.ts";

const root = fs.mkdtempSync(path.join(process.env.PI_AGENT_VIEW_EVIDENCE_DIR ?? os.tmpdir(), "agent-interaction-"));
for (const key of Object.keys(process.env)) if (key.startsWith("PI_SUBAGENT_")) delete process.env[key];
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
process.env.PI_SUBAGENT_TEMP_ROOT = path.join(root, "pi-subagents-runtime");
const sdkRoot = process.env.PI_OWNERSHIP_TEST_PACKAGE_ROOT ?? path.dirname(path.dirname(new URL(import.meta.resolve("@earendil-works/pi-coding-agent")).pathname));
const { SessionManager } = await import(pathToFileURL(path.join(sdkRoot, "dist/core/session-manager.js")).href);
const { AgentViewController, AgentConversation } = await import("../../src/tui/agent-view.ts");
const { historyItems, withFinalResult } = await import("../../src/tui/agent-history.ts");
const { getSingleResultOutput } = await import("../../src/shared/utils.ts");
const { runHistoryIndex, closeRunHistory } = await import("../../src/runs/shared/history-index.ts");
const { restoreOwnedRuns, ownedRunView, OWNED_RUN_ENTRY } = await import("../../src/runs/shared/run-records.ts");
const { getRunMetadataDir, readQuestionState, saveRunStatus, saveAsyncRunResult, saveQuestionOwner, saveQuestionContract, createSupervisorQuestion } = await import("../../src/runs/shared/supervisor-questions.ts");
const { createSubagentExecutor } = await import("../../src/runs/foreground/subagent-executor.ts");
const { createAsyncJobTracker } = await import("../../src/runs/background/async-job-tracker.ts");
const { ASYNC_DIR } = await import("../../src/shared/types.ts");
initTheme("dark", false);
const { theme: uiTheme, loadThemeFromPath } = await import(new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
const sdkTui = await import(createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")).resolve("@earendil-works/pi-tui"));
function setTestKeybindings(t, keys) {
	const previous = getKeybindings(), sdkPrevious = sdkTui.getKeybindings();
	setKeybindings(keys); sdkTui.setKeybindings(keys);
	t.after(() => { setKeybindings(previous); sdkTui.setKeybindings(sdkPrevious); });
}
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, turns: 0 };
function assistant(manager, text: string) { return manager.appendMessage({ role: "assistant", content: [{ type: "text", text }], provider: "fixture", model: "fixture", api: "openai-responses", stopReason: "stop", usage, timestamp: Date.now() }); }
const plain = (component, width = 90) => component.render(width).map(stripTerminalSequences).join("\n");
const altLabel = process.platform === "darwin" ? "option" : "Alt";
async function readDetails(view, width = 90): Promise<string> {
	await until(() => !plain(view, width).includes("Loading selected details"), "selected full native details loaded");
	view.handleInput("\x1b[H");
	const pages: string[] = [];
	let previous = -1;
	while (view.scroll.scrollTop !== previous) {
		previous = view.scroll.scrollTop;
		pages.push(plain(view, width));
		view.handleInput("\x1b[6~");
	}
	return pages.join("\n").replace(/\s/g, "");
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(check: () => boolean, reason: string) { const deadline = Date.now() + 10_000; while (!check()) { assert.ok(Date.now() < deadline, reason); await delay(10); } }
function hintPoint(f, text: string) {
	f.tui.renderNow();
	const bounds = f.overlayBounds, lines = f.overlay.render(bounds.width).map(stripTerminalSequences);
	const y = lines.findIndex((line) => line.toLowerCase().includes(text.toLowerCase()));
	assert.ok(y >= 0 && y < bounds.height, `displayed hint ${JSON.stringify(text)} must be inside the overlay:\n${lines.join("\n")}`);
	const x = visibleWidth(lines[y].slice(0, lines[y].toLowerCase().indexOf(text.toLowerCase()) + text.length)) - 1;
	assert.ok(x < bounds.width);
	return { x: bounds.col + x, y: bounds.row + y };
}
async function clickHint(f, text: string) {
	const { x, y } = hintPoint(f, text);
	f.terminal.click(x, y); await turn(); f.tui.renderNow();
}

function nativeChild(cwd: string, scenario: "streaming" | "tool" | "question") {
	const release = path.join(cwd, "release"), bin = path.join(cwd, "bin"); fs.mkdirSync(bin);
	fs.writeFileSync(path.join(bin, "pi"), `#!/bin/sh\nexec "${process.execPath}" "${fileURLToPath(new URL("../fixtures/native-feedback-child.mjs", import.meta.url))}" "$@"\n`, { mode: 0o700 });
	const saved = { PATH: process.env.PATH, PI_FEEDBACK_SCENARIO: process.env.PI_FEEDBACK_SCENARIO, PI_FEEDBACK_RELEASE_FILE: process.env.PI_FEEDBACK_RELEASE_FILE };
	process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`; process.env.PI_FEEDBACK_SCENARIO = scenario; process.env.PI_FEEDBACK_RELEASE_FILE = release;
	return { release, restore() { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } } };
}

async function fixture(t, mode: "regular" | "fullscreen" = "regular", children = 1, executeControl?, profiles = ["worker", "reviewer"].map((name) => makeAgent(name, { completionGuard: false })), theme = uiTheme) {
	const cwd = path.join(root, randomUUID()); fs.mkdirSync(cwd);
	const parent = SessionManager.create(cwd, path.join(cwd, "parent"));
	assistant(parent, "Parent context stays unchanged");
	const childSessions = Array.from({ length: children }, (_, index) => {
		const manager = SessionManager.create(cwd, path.join(cwd, `child-${index}`));
		manager.appendMessage({ role: "user", content: "Fix the assigned behavior", timestamp: Date.now() });
		assistant(manager, "I found the relevant code.");
		return manager;
	});
	const run: OwnedRun = { runId: randomUUID(), rootRunId: "", ownerSessionId: parent.getSessionId(), source: "async", mode: children > 1 ? "parallel" : "single", cwd, task: "Combined tasks must not be used as per-child labels", startedAt: Date.now(),
		children: childSessions.map((session, index) => ({ agent: "worker", index, label: index === 0 ? "Fix login" : "Review changes", task: index === 0 ? "Fix the login regression.\nKeep the API unchanged." : "Review the diff carefully.", sessionFile: session.getSessionFile() })) };
	run.rootRunId = run.runId;
	run.asyncDir = getRunMetadataDir(run.runId);
	parent.appendCustomEntry(OWNED_RUN_ENTRY, run);
	saveQuestionOwner(run.runId, run.ownerSessionId);
	for (const child of run.children) saveQuestionContract(run.runId, child.index, { task: child.task, sessionFile: child.sessionFile });
	const state = { ...makeMinimalCtx(cwd), baseCwd: cwd, currentSessionId: parent.getSessionFile(), ownedRuns: new Map([[run.runId, run]]), asyncJobs: new Map(), foregroundRuns: new Map(),
		cleanupTimers: new Map(), lastUiContext: null, poller: null, completionSeen: new Map(), watcher: null, watcherRestartTimer: null, resultFileCoalescer: { schedule: () => false, clear() {} } } as unknown as SubagentState;
	const status = { runtimeVersion: 2, runId: run.runId, mode: run.mode, state: "running", pid: process.pid, startedAt: run.startedAt, lastUpdate: run.startedAt, indexedControl: true, controlRequestFiles: true,
		steps: run.children.map((child) => ({ agent: child.agent, status: "running", sessionFile: child.sessionFile })) };
	saveRunStatus(run.runId, status);
	const terminal = createTestTerminal(), copied: string[] = [];
	const tui = mode === "fullscreen" ? new TuiAltScreen(terminal, false, undefined, { copySelection: async (text) => { copied.push(text); return true; } }) : new TuiMainScreen(terminal);
	const events = createEventBus(), commands = new Map(), renderers = new Map(), sent = [], calls = [];
	let overlay, strip, overlayHandle;
	const pi = { events, getSessionName: () => "test-parent", registerCommand(name, command) { commands.set(name, command); }, registerMessageRenderer(name, renderer) { renderers.set(name, renderer); },
		appendEntry: (type, data) => parent.appendCustomEntry(type, structuredClone(data)),
		sendMessage(message, options) { sent.push({ message, options }); parent.appendCustomMessageEntry(message.customType, message.content, message.display, message.details); },
	};
	const mainEditor = new Editor(tui, { borderColor: (text) => text, selectList: getSelectListTheme() });
	mainEditor.setText("Unsent parent draft\nDo not replace this");
	const document = new Text("Parent context stays unchanged", 0, 0), widgets = new Container(), footer = new Text("Parent footer", 0, 0);
	for (const component of [document, widgets, mainEditor, footer]) tui.addChild(component);
	if (tui instanceof TuiAltScreen) tui.setLayoutRoot(new VStack([
		{ component: new ScrollView(document, { follow: "end", primary: true }), basis: 0, grow: 1, minSize: 1 },
		new VStack([widgets, mainEditor, footer]),
	]));
	tui.setFocus(mainEditor);
	const ctx = { ...makeMinimalCtx(cwd), mode: "tui", hasUI: true, sessionManager: parent, ui: { theme, getToolsExpanded: () => false,
		setWidget(_key, factory) { strip = factory?.(tui, theme); widgets.clear(); widgets.addChild(new Spacer(1)); if (strip) widgets.addChild(strip); },
		custom(factory, options) { return new Promise((resolve) => {
			let handle;
			overlay = factory(tui, theme, undefined, (value) => { handle?.hide(); overlay?.dispose?.(); resolve(value); });
			handle = tui.showOverlay(overlay, typeof options.overlayOptions === "function" ? options.overlayOptions() : options.overlayOptions);
			overlayHandle = handle;
		}); },
	} };
	state.lastUiContext = ctx;
	const tracker = createAsyncJobTracker(pi, state, ASYNC_DIR, { render: () => controller.refresh() });
	pi.events.on("subagent:async-started", tracker.handleStarted);
	const executor = createSubagentExecutor({ pi, state, config: {}, asyncByDefault: true, tempArtifactsDir: cwd, getSubagentSessionRoot: () => cwd, expandTilde: (value) => value, discoverAgents: () => ({ agents: profiles }) });
	const controller = new AgentViewController(pi, state, async (params, context) => { calls.push(params); return executeControl ? executeControl(params, context) : executor.execute(randomUUID(), params, undefined, undefined, context); });
	state.onRunsChanged = () => controller.refresh(true);
	state.persistOwnedRun = (owned) => parent.appendCustomEntry(OWNED_RUN_ENTRY, structuredClone(owned));
	controller.start(ctx);
	t.after(async () => { controller.dispose(); tui.stop(); if (state.poller) clearInterval(state.poller); for (const timer of state.cleanupTimers.values()) clearTimeout(timer); await closeRunHistory(state); });
	const ready = (async () => { const index = await runHistoryIndex(state); await index.refresh(); await controller.refresh(); })();
	await ready;
	const result = { ready, cwd, parent, run, state, status, childSessions,
		get interrupts() { const dir = path.join(run.asyncDir!, "control-requests"); const requests = fs.existsSync(dir) ? fs.readdirSync(dir).map((file) => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"))) : []; assert.ok(requests.every((request) => request.action === "interrupt" && request.index !== undefined), "selected controls never stop the whole group"); return run.children.map((child) => requests.filter((request) => request.index === child.index).length); }, controller, executor, ctx, pi, tui, terminal, mainEditor, sent, calls, commands, renderers, copied,
		get overlay() { return overlay; }, get overlayBounds() { return overlayHandle?.getBounds(); }, get strip() { return strip; }, key: `${run.runId}:0`,
		async complete() { saveAsyncRunResult(run.runId, { runtimeVersion: 2, id: run.runId, state: "complete", timestamp: Date.now(), results: run.children.map((child) => ({ agent: child.agent, task: child.task!, success: true, exitCode: 0, finalOutput: "Finished", sessionFile: child.sessionFile, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 } })) }); await refreshFixture(result); },
	};
	await refreshFixture(result);
	return result;
}

for (const count of [20, 227]) test(`Agents startup asynchronously pages ${count} owned runs and hydrates only selected details beside 8000 unrelated runs`, async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const f = await fixture(t, "regular", count);
	f.controller.dispose();
	f.state.ownedRuns.clear();
	for (const [index, manager] of f.childSessions.entries()) {
		const runId = randomUUID(), child = { ...f.run.children[index], index: 0 };
		const run = { ...f.run, runId, rootRunId: runId, asyncDir: getRunMetadataDir(runId), mode: "single", children: [child] };
		manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: `call-${index}`, name: "check", arguments: { input: "x".repeat(4096) } }], provider: "fixture", model: "fixture", api: "openai-responses", stopReason: "toolUse", usage, timestamp: Date.now() });
		manager.appendMessage({ role: "toolResult", toolCallId: `call-${index}`, toolName: "check", content: [{ type: "text", text: "Complete" }], details: { historyProbe: index, payload: "x".repeat(4096) }, isError: false, timestamp: Date.now() });
		saveQuestionOwner(runId, run.ownerSessionId);
		saveQuestionContract(runId, 0, { task: `Full assignment ${index}`, sessionFile: child.sessionFile, launch: { model: "fixture/original", cwd: f.cwd } });
		saveRunStatus(runId, { ...f.status, runId, state: "complete", pid: undefined, steps: [{ agent: "worker", status: "complete", sessionFile: child.sessionFile }] });
		saveAsyncRunResult(runId, { runtimeVersion: 2, id: runId, state: "complete", timestamp: Date.now(), results: [{ agent: "worker", task: child.task, sessionFile: child.sessionFile, success: true, exitCode: 0, finalOutput: "Saved completion" }] });
		f.state.ownedRuns.set(runId, run);
	}
	const metadataRoot = path.dirname(getRunMetadataDir(f.run.runId));
	for (let index = 0; index < 8000; index++) fs.mkdirSync(path.join(metadataRoot, `foreign-${index}`), { recursive: true });
	const files = new Set(f.childSessions.map((manager) => manager.getSessionFile()));
	const reads: string[] = [], formatted: number[] = [], rootListings: string[] = [];
	const open = fs.openSync, readdir = fs.readdirSync, stringify = JSON.stringify, parse = Date.parse;
	let timestampParses = 0;
	let historySerializations = 0;
	const displayedItems = new Set();
	t.mock.method(fs, "openSync", function(file, flags, ...args) { if (flags === "r" && files.has(String(file))) reads.push(String(file)); return open.call(this, file, flags, ...args); });
	t.mock.method(fs, "readdirSync", function(file, ...args) { if (String(file) === metadataRoot || String(file).endsWith("/supervisor-questions")) rootListings.push(String(file)); return readdir.call(this, file, ...args); });
	t.mock.method(JSON, "stringify", function(value, ...args) {
		if (value?.result?.details?.historyProbe !== undefined) formatted.push(value.result.details.historyProbe);
		if (displayedItems.has(value) || Array.isArray(value) && value.some((part) => displayedItems.has(part))) historySerializations++;
		return stringify.call(this, value, ...args);
	});
	t.mock.method(Date, "parse", function(value) { timestampParses++; return parse(value); });
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	f.controller.start(f.ctx);
	await indexedReady(f);
	assert.equal(reads.length, 0, "startup never opens a native source on the UI thread");
	assert.deepEqual(rootListings, [], "known run questions never enumerate global roots");
	assert.deepEqual(formatted, [], "closed-panel startup does not format raw tool details");
	assert.equal(f.controller.tasks.length, Math.min(count, 50));
	timestampParses = 0;
	await f.controller.refresh(); await f.controller.refresh(true);
	assert.equal(reads.length, 0, "unchanged live/forced observations stay off-thread");
	assert.equal(timestampParses, 0, "closed dock refreshes do not rebuild completed conversations");
	const renders = t.mock.method(f.tui, "requestRender");
	t.mock.timers.tick(1500);
	assert.equal(renders.mock.callCount(), 0, "an inert completed dock never requests full parent redraws");
	const opening = f.controller.open(f.controller.tasks[0].key);
	await historyReady(f);
	plain(f.overlay);
	for (const item of f.controller.tasks[0].history) displayedItems.add(item);
	plain(f.overlay); plain(f.overlay);
	assert.equal(historySerializations, 0, "unchanged conversation renders do not serialize stable message bodies");
	assert.equal(reads.length, 0, "opening one conversation does not read historical bodies on the UI thread");
	assert.equal(formatted.length, 0, "ordinary pages do not materialize raw tool details");
	const tool = f.controller.tasks[0].history.find((item) => item.kind === "tool")!;
	assert.match((await tool.load!()).details!, /historyProbe/);
	assert.equal(formatted.length, 1, "explicitly selected details hydrate only their native records");
	assert.equal(f.controller.tasks.every((task) => task.child.task?.startsWith("Full assignment")), true);
	f.overlay.handleInput("\x1b"); await opening;
	assert.equal(f.calls.length, 0);
	t.diagnostic(`${count} children: ${reads.length} transcript reads, ${rootListings.length} global question listings, ${formatted.length} formatted conversations`);
});

test("Agents metadata queries follow relevant state, not all visited terminal rows", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const f = await fixture(t, "regular", 50);
	f.controller.dispose(); f.state.ownedRuns.clear();
	const runs: OwnedRun[] = [];
	for (const [position, manager] of f.childSessions.entries()) {
		const runId = randomUUID(), child = { ...f.run.children[position], index: 0 };
		const run = { ...f.run, runId, rootRunId: runId, mode: "single" as const, asyncDir: getRunMetadataDir(runId), children: [child] };
		saveQuestionOwner(runId, run.ownerSessionId);
		saveQuestionContract(runId, 0, { task: child.task, sessionFile: child.sessionFile });
		saveRunStatus(runId, { ...f.status, runId, mode: "single", steps: [f.status.steps[position]] });
		if (position) saveAsyncRunResult(runId, { runtimeVersion: 2, id: runId, state: "complete", timestamp: run.startedAt,
			results: [{ agent: child.agent, sessionFile: child.sessionFile, success: true, exitCode: 0, finalOutput: `Saved report ${position}` }] });
		f.state.ownedRuns.set(runId, run); runs.push(run);
	}
	f.controller.start(f.ctx);
	await indexedReady(f);
	for (const task of f.controller.tasks) f.controller.visit(task.key).draft = "Retain my draft";
	await f.controller.refresh();
	const index = await runHistoryIndex(f.state), calls: string[] = [], historyPage = index.historyPage.bind(index);
	t.mock.method(index, "historyPage", (input) => {
		if (input.limit === 1) calls.push(input.runId);
		return historyPage(input);
	});
	const check = async (expected: string[]) => {
		calls.length = 0;
		await f.controller.refresh(); await f.controller.refresh();
		assert.deepEqual([...new Set(calls)].sort(), [...expected].sort());
		assert.ok(calls.length <= expected.length * 2, "coalesced refreshes may share selected metadata, never poll unrelated terminal rows");
	};
	await check([runs[0].runId]);
	const terminal = f.controller.task(`${runs[1].runId}:0`)!;
	const unread = terminal.unread;
	f.controller.pin(terminal.key);
	await check([runs[0].runId, runs[1].runId]);
	const outbox = f.controller.visit(`${runs[2].runId}:0`).outbox;
	outbox.push({ id: "awaited-human-receipt", runId: runs[2].runId, index: 0, text: "Direction", draft: "Retain my draft", at: Date.now(), status: "unconfirmed" });
	await check(runs.slice(0, 3).map((run) => run.runId));
	assert.equal(f.controller.task(terminal.key)!.unread, unread, "skipped observations retain unread state");
	assert.ok(f.controller.tasks.every((task) => f.controller.visit(task.key).draft === "Retain my draft"));
	calls.length = 0;
	const changed = runs[3];
	saveAsyncRunResult(changed.runId, { runtimeVersion: 2, id: changed.runId, state: "complete", timestamp: changed.startedAt + 1000,
		results: [{ agent: "worker", sessionFile: changed.children[0].sessionFile, success: true, exitCode: 0, finalOutput: "Updated saved report" }] });
	await index.refresh(changed.runId); await f.controller.refresh();
	await index.refresh();
	assert.equal((await index.listRuns({ limit: 100 })).freshness.state, "current", "Observe publication before asserting unchanged terminal rows stop polling");
	await f.controller.refresh();
	await until(() => {
		const task = f.controller.task(`${changed.runId}:0`);
		const published = task?.metadataAt === changed.startedAt + 1000
			&& task.run.updatedAt === changed.startedAt + 1000 && task.child.result?.finalOutput === "Updated saved report";
		if (!published) void f.controller.refresh();
		return published;
	}, "changed terminal metadata is published in the controller before unchanged polling");
	assert.ok(calls.includes(changed.runId), "changed terminal rows refresh their metadata");
	await check(runs.slice(0, 3).map((run) => run.runId));
	const questionRun = runs[5];
	createSupervisorQuestion({ runId: questionRun.runId, index: 0, agent: "worker", ownerTarget: "fixture-owner", childTarget: "fixture-child",
		childSessionId: f.childSessions[5].getSessionId(), sessionFile: questionRun.children[0].sessionFile, cwd: f.cwd, pid: process.pid,
		reason: "need_decision", message: "A question remains observable beside terminal rows" });
	await index.refresh(questionRun.runId); await f.controller.refresh();
	await check([runs[0].runId, runs[1].runId, runs[2].runId, questionRun.runId]);
	const opening = f.controller.open(`${runs[4].runId}:0`);
	await historyReady(f);
	await check([runs[0].runId, runs[1].runId, runs[2].runId, runs[4].runId, questionRun.runId]);
	assert.match(plain(f.overlay), /Saved report 4/);
	f.overlay.handleInput("\x1b"); await opening;
	t.diagnostic("50 visited rows (49 terminal): two unchanged ticks query only the live row; pin/outbox/question/selection and changed results remain observable.");
});

test("selected Agents controls refresh their own authority without touching unrelated completed histories", async (t) => {
	const f = await fixture(t, "regular", 25);
	await f.ready;
	f.controller.dispose(); f.state.ownedRuns.clear();
	fs.rmSync(path.join(f.run.asyncDir!, "contracts"), { recursive: true });
	const unrelated = new Set<string>();
	for (const [index, manager] of f.childSessions.entries()) {
		const runId = index === 0 ? f.run.runId : randomUUID();
		const child = { ...f.run.children[index], index: 0 };
		const run = { ...f.run, runId, rootRunId: runId, mode: "single", asyncDir: getRunMetadataDir(runId), children: [child] };
		saveQuestionOwner(runId, run.ownerSessionId);
		saveQuestionContract(runId, 0, { task: child.task, sessionFile: child.sessionFile });
		saveRunStatus(runId, { ...f.status, runId, mode: "single", steps: [{ ...f.status.steps[index] }] });
		if (index) {
			saveAsyncRunResult(runId, { runtimeVersion: 2, id: runId, state: "complete", timestamp: Date.now(), results: [{ agent: child.agent, task: child.task, sessionFile: child.sessionFile, success: true, exitCode: 0, finalOutput: "Unrelated saved report" }] });
			unrelated.add(run.asyncDir); unrelated.add(manager.getSessionFile());
		}
		f.state.ownedRuns.set(runId, run);
	}
	f.controller.start(f.ctx);
	await indexedReady(f);
	const accesses: string[] = [];
	for (const method of ["readFileSync", "statSync", "existsSync", "readdirSync", "openSync"] as const) {
		const original = fs[method];
		t.mock.method(fs, method, function(file, ...args) {
			const name = String(file);
			if ([...unrelated].some((root) => name === root || name.startsWith(`${root}${path.sep}`))) accesses.push(name);
			return original.call(this, file, ...args);
		});
	}
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	const opening = f.controller.open(f.key);
	assert.deepEqual(accesses, [], "opening a selected conversation must not force every completed run");
	const deliveries = [];
	f.pi.events.on("subagent:live-intercom", (payload) => {
		deliveries.push(payload);
		f.pi.events.emit("subagent:live-intercom-delivery", { requestId: payload.requestId, accepted: true, delivered: true, messageId: payload.messageId });
	});
	f.controller.visit(f.key).draft = "Keep my selected draft";
	await f.controller.send(f.key, "Keep my selected draft");
	assert.equal(deliveries.length, 1);
	assert.equal(deliveries[0].human.index, 0);
	assert.deepEqual(accesses, [], "send and its completion refresh are isolated to the selected run");
	await f.controller.stop(f.key);
	assert.equal(f.calls.at(-1).index, 0);
	assert.deepEqual(accesses, [], "Stop must not hydrate unrelated completed records");
	saveAsyncRunResult(f.run.runId, { runtimeVersion: 2, id: f.run.runId, state: "complete", timestamp: Date.now(), results: [{ agent: "worker", task: f.run.children[0].task, sessionFile: f.childSessions[0].getSessionFile(), success: true, exitCode: 0, finalOutput: "Selected completion" }] });
	await f.controller.send(f.key, "Another direction");
	assert.equal(deliveries.length, 1, "selected authority is rechecked before sending to a child that completed meanwhile");
	assert.equal(f.controller.visit(f.key).draft, "Keep my selected draft");
	assert.deepEqual(accesses, []);
	f.overlay.handleInput("\x1b"); await opening;
});

test("Agents predecessor and live continuation retain task identity and published history through bounded indexed refreshes", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: new Date("2030-01-01T00:00:00Z") });
	const f = await fixture(t), manager = f.childSessions[0], file = manager.getSessionFile();
	f.controller.dispose();
	const terminal = manager.getLeafId(), launch = { model: "fixture/fixture", cwd: f.cwd };
	saveQuestionContract(f.run.runId, 0, { launch });
	saveAsyncRunResult(f.run.runId, { runtimeVersion: 2, id: f.run.runId, state: "complete", timestamp: Date.now(),
		results: [{ agent: "worker", task: f.run.children[0].task, sessionFile: file, success: true, exitCode: 0,
			finalOutput: "I found the relevant code.", terminalEntryId: terminal, terminalLeafId: terminal }] });
	t.mock.timers.tick(10);
	const runId = randomUUID(), successor = { ...f.run, runId, asyncDir: getRunMetadataDir(runId), startedAt: Date.now(),
		predecessorRunId: f.run.runId, predecessorIndex: 0 };
	saveQuestionOwner(runId, f.run.ownerSessionId);
	saveQuestionContract(runId, 0, { task: "Continue the same conversation", sessionFile: file, launch });
	saveRunStatus(runId, { ...f.status, runId, startedAt: successor.startedAt, lastUpdate: successor.startedAt });
	f.state.ownedRuns.set(runId, successor);
	const published = assistant(manager, "Published continuation");
	fs.appendFileSync(file, JSON.stringify({ type: "message", id: "unpublished", parentId: published, timestamp: new Date().toISOString(),
		message: { role: "assistant", provider: "fixture", model: "unpublished", stopReason: "stop", usage,
			content: [{ type: "text", text: "Unpublished continuation" }] } }));
	const original = fs.readFileSync(file, "utf8"), open = fs.openSync;
	let reads = 0;
	t.mock.method(fs, "openSync", function(target, flags, ...args) { if (flags === "r" && String(target) === file) reads++; return open.call(this, target, flags, ...args); });
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	f.controller.start(f.ctx);
	await refreshFixture(f);
	assert.equal(reads, 0, "the UI never reads the shared continuation journal");
	assert.equal(f.controller.tasks.length, 1);
	assert.equal(f.controller.task(f.key)!.run.runId, runId);
	assert.equal(f.controller.task(f.key)!.child.state, "live");
	assert.ok(f.controller.task(f.key)!.historyIds.includes(`${published}:0`));
	assert.ok(!f.controller.task(f.key)!.historyIds.includes("unpublished:0"), "sealed metadata must not leak into the live continuation");
	f.controller.visit(f.key).draft = "Keep my continuation draft";
	for (let pass = 0; pass < 3; pass++) {
		t.mock.timers.tick(500);
		await f.controller.refresh(true);
		assert.equal(reads, 0, "unchanged predecessor/live refreshes remain off-thread");
	}
	assert.equal(f.controller.visit(f.key).draft, "Keep my continuation draft");
	assert.equal(fs.readFileSync(file, "utf8"), original);
	assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 0);
	fs.appendFileSync(file, "\n");
	await refreshFixture(f);
	assert.ok(f.controller.task(f.key)!.historyIds.includes("unpublished:0"), "published continuation entries become visible after off-thread catch-up");
	let latest = successor;
	for (let index = 0; index < 64; index++) {
		t.mock.timers.tick(10);
		const runId = randomUUID();
		const next = { ...successor, runId, asyncDir: getRunMetadataDir(runId), startedAt: Date.now(), predecessorRunId: latest.runId };
		saveQuestionOwner(runId, f.run.ownerSessionId);
		saveQuestionContract(runId, 0, { sessionFile: file, launch });
		saveRunStatus(runId, { ...f.status, runId, startedAt: next.startedAt, lastUpdate: next.startedAt });
		f.state.ownedRuns.set(runId, next);
		latest = next;
	}
	const get = f.state.ownedRuns.get;
	let lookups = 0;
	t.mock.method(f.state.ownedRuns, "get", function(id) { lookups++; return get.call(this, id); });
	await refreshFixture(f);
	assert.equal(f.controller.tasks.length, 1);
	assert.equal(f.controller.task(f.key)!.run.runId, latest.runId, "long continuation chains retain the original conversation/draft identity");
	assert.ok(lookups <= 5 * f.state.ownedRuns.size, `continuation identity resolution must be linear, observed ${lookups} run lookups`);
	assert.equal(f.controller.visit(f.key).draft, "Keep my continuation draft");
});

test("history reading IDs and delivery facts never need raw tool serialization", () => {
	let formatted = 0;
	const entries = [
		{ type: "custom_message", id: "direction", timestamp: "2026-01-01", customType: "subagent-human-message", content: "Keep the API", details: { message: { id: "ack-1" } } },
		{ type: "message", id: "call", timestamp: "2026-01-01", message: { role: "assistant", content: [{ type: "thinking", thinking: "Reasoning" }, { type: "text", text: "Reply" }, { type: "toolCall", id: "tool-1", name: "check", arguments: {} }], stopReason: "toolUse" } },
		{ type: "message", id: "result", timestamp: "2026-01-01", message: { role: "toolResult", toolCallId: "tool-1", toolName: "check", content: [{ type: "text", text: "Done" }], details: { toJSON() { formatted++; return { full: "RAW-DETAIL", diff: "-before\n+after" }; } } } },
	];
	const history = historyItems(entries);
	assert.deepEqual(history.entryIds, ["direction", "call:0", "call:1", "call:2", "result"]);
	assert.equal(history.items[0].messageId, "ack-1");
	assert.equal(history.items[1].kind, "assistant");
	assert.deepEqual(history.items[2].entryIds, ["call:2", "result"]);
	assert.equal(formatted, 0);
	assert.match(history.items[2].details, /RAW-DETAIL/);
	assert.equal(formatted, 1);
	assert.match(history.items[2].details, /RAW-DETAIL/);
	assert.equal(formatted, 1, "display details are formatted once per snapshot");
});

test("shared-history saved-result matching indexes exact sanitized text once and retains the latest matching native ID", () => {
	const entries = ["earlier", "latest"].map((id) => ({ type: "message", id, timestamp: "2026-01-01", message: { role: "assistant",
		content: [{ type: "thinking", thinking: "Context" }, { type: "text", text: "\x1b[31mFinal report\x1b[0m\n```acceptance-report\n{\"criteriaSatisfied\":[]}\n```" }] } }));
	const history = historyItems(entries);
	let textReads = 0;
	for (const item of history.items) {
		const get = Object.getOwnPropertyDescriptor(item, "text").get;
		Object.defineProperty(item, "text", { get() { textReads++; return get.call(this); } });
	}
	for (let run = 0; run < 267; run++) {
		assert.equal(withFinalResult(history, "Final report", `run-${run}`, run).finalId, "latest:0");
		assert.equal(withFinalResult(history, `Different saved result ${run}`, `run-${run}`, run).finalId, `result:run-${run}`);
	}
	assert.equal(textReads, 2, "many continuations must not rescan all assistant text on unchanged refresh");
	const saved = withFinalResult(history, "Only canonical", "saved", 1);
	assert.equal(withFinalResult(saved, "Only canonical", "saved", 1).items.length, saved.items.length, "reapplying a canonical result cannot duplicate it");
});

test("Agents model identity follows native branch settings and tool-only messages, not requested routes", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: new Date("2030-01-01T00:00:00Z") });
	const f = await fixture(t, "regular", 2);
	t.mock.timers.tick(10);
	f.status.steps = f.status.steps.map((step, index) => ({ ...step, model: `requested-${index}/vendor/model:low`, modelStartedAt: Date.now() }));
	saveRunStatus(f.run.runId, f.status);
	await refreshFixture(f);
	assert.match(plain(f.strip, 160), /Fix login.*selected: requested-0\/vendor\/model · thinking low/);
	assert.equal(f.controller.task(f.key)!.model.summary, "selected: requested-0/vendor/model · thinking low", "old native history is not the current attempt");
	t.mock.timers.tick(10);
	const first = f.childSessions[0], second = f.childSessions[1];
	first.appendModelChange("openrouter", "vendor/model:7b");
	const branch = first.appendThinkingLevelChange("high");
	second.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "native-model-tool", name: "read", arguments: { path: "login.ts" } }], provider: "vertex", model: "google/gemini-test", api: "openai-responses", stopReason: "toolUse", usage, timestamp: Date.now() });
	await refreshFixture(f);
	assert.equal(f.controller.task(f.key)!.model.summary, "openrouter/vendor/model:7b · thinking high");
	assert.equal(f.controller.task(`${f.run.runId}:1`)!.model.summary, "vertex/google/gemini-test", "tool-only assistants carry model data without inventing a thinking level");
	assert.match(f.controller.task(f.key)!.model.details, /Model \(session\): openrouter\/vendor\/model:7b · thinking high/);
	assert.match(f.controller.task(f.key)!.model.details, /Selected model: requested-0\/vendor\/model · thinking low/);
	const strip = plain(f.strip, 160);
	assert.doesNotMatch(strip, /session:|· working/);
	assert.match(strip.split("\n").find((row) => row.includes("Fix login"))!, /openrouter\/vendor\/model:7b · thinking high/);
	assert.match(strip.split("\n").find((row) => row.includes("Review changes"))!, /vertex\/google\/gemini-test/);
	const picker = f.controller.open();
	assert.match(plain(f.overlay, 160), /openrouter\/vendor\/model:7b/);
	assert.match(plain(f.overlay, 160), /vertex\/google\/gemini-test/);
	f.overlay.handleInput("\x1b"); await picker;
	const opening = f.controller.open(`${f.run.runId}:1`), view = f.overlay;
	assert.match(plain(view, 160), /worker · working · vertex\/google\/gemini-test/);
	view.handleInput("\t"); view.handleInput("\x1b[F"); view.render(160); view.handleInput("\r");
	assert.match(await readDetails(view, 160), /Messagemodel:vertex\/google\/gemini-test/);
	view.handleInput("\x1b"); view.handleInput("\x1b"); await opening;
	t.mock.timers.tick(10);
	first.appendModelChange("abandoned", "wrong-route");
	first.branch(branch); first.appendCustomEntry("branch-marker", {});
	first.appendThinkingLevelChange("medium");
	const saved = fs.readFileSync(first.getSessionFile(), "utf8");
	await refreshFixture(f);
	assert.equal(f.controller.task(f.key)!.model.summary, "openrouter/vendor/model:7b · thinking medium", "native branch traversal ignores a later abandoned model change");
	assert.equal(fs.readFileSync(first.getSessionFile(), "utf8"), saved, "reading configuration never rewrites native history");
	fs.writeFileSync(path.join(f.cwd, "model-frames.txt"), strip);
	assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 0);
});

test("Agents strip spends reclaimed status space on the model at screenshot and narrow widths", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: new Date("2030-01-01T00:00:00Z") });
	const f = await fixture(t, "fullscreen", 2);
	f.run.children[0].label = "Live fallback diagnosis";
	f.run.children[1].label = "Fix streamed-credit failover";
	f.status.steps = f.status.steps.map((step) => ({ ...step, model: "openai-codex/gpt-6", modelStartedAt: Date.now() }));
	saveRunStatus(f.run.runId, f.status);
	t.mock.timers.tick(10);
	for (const manager of f.childSessions) manager.appendModelChange("openai-codex", "gpt-6");
	await refreshFixture(f);
	const frames = [];
	for (const width of [90, 64, 56, 24]) {
		const rows = f.strip.render(width).map(stripTerminalSequences);
		assert.doesNotMatch(rows.join("\n"), /session:|working/);
		assert.ok(rows.every((row) => visibleWidth(row) <= width));
		if (width >= 56) {
			assert.equal(rows[1], "  ● Live fallback diagnosis · openai-codex/gpt-6");
			assert.equal(rows[2], "  ● Fix streamed-credit failover · openai-codex/gpt-6");
		} else assert.match(rows[1], /Live fallback/);
		frames.push(`${width} columns\n${rows.join("\n")}`);
	}
	fs.writeFileSync(path.join(f.cwd, "strip-widths.txt"), frames.join("\n\n"));
	assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 0);
});

for (const [name, mode, success] of [["dark", "truecolor", "#a0c880"], ["light", "truecolor", "#408060"], ["dark", "256color", "#a0c880"], ["dark", "truecolor", 112], ["dark", "truecolor", ""]]) test(`Agents running dot pulses slowly without changing theme, attention or pending rows (${name}/${mode}/${success})`, async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: new Date("2030-01-01T00:00:00Z") });
	const intervals = t.mock.method(globalThis, "setInterval");
	const data = JSON.parse(fs.readFileSync(new URL(`./modes/interactive/theme/${name}.json`, import.meta.resolve("@earendil-works/pi-coding-agent")), "utf8"));
	data.colors.success = success;
	const themeFile = path.join(root, `pulse-${randomUUID()}.json`); fs.writeFileSync(themeFile, JSON.stringify(data));
	const theme = loadThemeFromPath(themeFile, mode), f = await fixture(t, "regular", 3, undefined, undefined, theme);
	f.status.steps[1].status = "pending";
	saveRunStatus(f.run.runId, f.status);
	createSupervisorQuestion({ runId: f.run.runId, index: 2, agent: "worker", ownerTarget: "fixture-owner", childTarget: "fixture-child", childSessionId: f.childSessions[2].getSessionId(), sessionFile: f.childSessions[2].getSessionFile(), cwd: f.cwd, pid: process.pid, reason: "need_decision", message: "Which fixture choice?" });
	await refreshFixture(f);
	const frames = [f.strip.render(90)];
	for (let step = 0; step < 12; step++) { t.mock.timers.tick(500); frames.push(f.strip.render(90)); }
	const runningRow = frames[0].findIndex((row) => row.includes("●"));
	assert.ok(runningRow > 0);
	const truecolor = mode === "truecolor" && typeof success === "string" && success.startsWith("#");
	if (truecolor || theme.bold("●") !== "●") assert.notEqual(frames[0][runningRow], frames[6][runningRow], "running dot changes over half a six-second cycle");
	else assert.equal(frames[0][runningRow], frames[6][runningRow], "respect native suppression of emphasis when styling is disabled");
	assert.equal(frames[0][runningRow], frames[12][runningRow], "a full slow cycle returns to its starting appearance");
	for (const frame of frames) {
		assert.deepEqual(frame.map(stripTerminalSequences), frames[0].map(stripTerminalSequences), "animation never changes labels, symbols, badges or widths");
		for (let row = 0; row < frame.length; row++) if (row !== runningRow) assert.equal(frame[row], frames[0][row], "header, yellow needs-answer and queued rows remain steady");
		assert.ok(frame.some((row) => row.includes(theme.getFgAnsi("warning")) && /!.*needs answer/.test(stripTerminalSequences(row))));
		assert.ok(frame.some((row) => row.includes("◷") && row.includes("queued")));
		assert.equal(frame[runningRow].slice(frame[runningRow].indexOf("Fix login")), frames[0][runningRow].slice(frames[0][runningRow].indexOf("Fix login")), "task and model styling stays steady");
	}
	if (truecolor) {
		assert.ok(new Set(frames.map((frame) => frame[runningRow])).size >= 5, "truecolor brightness changes gradually, not as a blink");
		assert.ok(frames[0][runningRow].includes(theme.fg("success", "●")), "pulse peaks at the user's exact success color");
	} else for (const frame of frames) assert.ok(frame[runningRow].includes(theme.getFgAnsi("success")), "palette and default colors stay native");
	assert.deepEqual(intervals.mock.calls.map((call) => call.arguments[1]), [500], "only the existing refresh timer runs");
	assert.equal(f.mainEditor.getText(), "Unsent parent draft\nDo not replace this");
	assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 0);
	fs.writeFileSync(path.join(f.cwd, "pulse-frames.json"), JSON.stringify(frames));
});

test("regular Agents pulse leaves offscreen history alone and resumes when the row returns", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: new Date("2030-01-01T00:00:00Z") });
	const theme = loadThemeFromPath(new URL("./modes/interactive/theme/dark.json", import.meta.resolve("@earendil-works/pi-coding-agent")).pathname, "truecolor");
	const f = await fixture(t, "regular", 1, undefined, undefined, theme), document = f.tui.children[0] as Text;
	document.setText(Array.from({ length: 1440 }, (_, i) => `PARENT-HISTORY-${i}`).join("\n"));
	const historyRender = t.mock.method(document, "render");
	let expanded = true;
	t.mock.method(f.ctx.ui, "getToolsExpanded", () => expanded);
	const asyncId = randomUUID();
	f.state.asyncJobs.set(asyncId, { asyncId, asyncDir: f.cwd, status: "running", mode: "parallel", agents: Array(4).fill("worker"), stepsTotal: 4, activeParallelGroup: true, runningSteps: 4, completedSteps: 0, startedAt: 1, updatedAt: 2,
		steps: Array.from({ length: 4 }, (_, index) => ({ index, agent: "worker", status: "running", task: `Independent async work ${index}` })) });
	const writes: string[] = [], frames = [];
	t.mock.method(f.terminal, "write", (data: string) => { writes.push(data); });
	f.terminal.resize(90, 18); f.tui.start(); f.tui.renderNow();
	const details = plain(f.strip, 90);
	assert.match(details, /Agent 4\/4/);
	const cycle = (visible: boolean) => {
		writes.length = 0;
		const redraws = f.tui.fullRedraws, traversals = historyRender.mock.callCount();
		for (let tick = 0; tick < 12; tick++) { t.mock.timers.tick(500); f.tui.renderNow(); }
		assert.equal(f.tui.fullRedraws, redraws, "a pulse must never repaint offscreen parent history");
		assert.doesNotMatch(writes.join(""), /PARENT-HISTORY|\x1b\[(?:2|3)J/);
		assert.equal(writes.some((write) => write.includes("Fix login")), visible, "only a visible running row should produce pulse updates");
		const native = f.tui.captureRenderState();
		assert.equal(native.previousLines.slice(native.previousViewportTop, native.previousViewportTop + f.terminal.rows).some((line) => stripTerminalSequences(line).includes("Fix login")), visible);
		assert.equal(historyRender.mock.callCount() - traversals, 12, "visibility calculation must not render the parent transcript again");
		frames.push({ visible, rows: f.terminal.rows, writes: [...writes], strip: plain(f.strip, 90) });
	};
	cycle(false);
	f.terminal.input("!"); f.tui.renderNow();
	assert.equal(f.mainEditor.getText(), "Unsent parent draft\nDo not replace this!");
	f.terminal.input("\x7f"); f.tui.renderNow();
	f.terminal.resize(90, 42); f.tui.renderNow(); cycle(true);
	assert.equal(plain(f.strip, 90), details, "expanded content is retained, not clipped to hide the pulse");
	// Another ordinary widget below Agents can hide the row even with async details collapsed.
	expanded = false;
	const dock = f.tui.children.find((child) => child instanceof Container && child.children.includes(f.strip)) as Container;
	const below = new Text("Other widget\n".repeat(18).trimEnd(), 0, 0); dock.addChild(below);
	f.terminal.resize(90, 18); f.tui.renderNow(); cycle(false);
	dock.removeChild(below); f.terminal.resize(90, 42); f.tui.renderNow(); cycle(true);
	assert.equal(f.mainEditor.getText(), "Unsent parent draft\nDo not replace this");
	assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 0); assert.deepEqual(f.interrupts, [0]);
	fs.writeFileSync(path.join(f.cwd, "offscreen-pulse.json"), JSON.stringify(frames));
});

test("Agents model details preserve a provider-matching model namespace in assistant and tool cards", async (t) => {
	const f = await fixture(t), manager = f.childSessions[0];
	const model = { provider: "openrouter", id: "openrouter/fixture", api: "openai-completions" };
	manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Namespaced reply" }, { type: "toolCall", id: "namespace-read", name: "read", arguments: { path: "namespace.txt" } }], provider: model.provider, model: model.id, api: model.api, stopReason: "toolUse", usage, timestamp: Date.now() });
	const saved = fs.readFileSync(manager.getSessionFile(), "utf8");
	await refreshFixture(f);
	const opening = f.controller.open(), view = f.overlay;
	await historyReady(f);
	view.render(160); view.handleInput("\t"); view.handleInput("\x1b[F"); view.render(160); view.handleInput("\r");
	const toolDetail = await readDetails(view, 160);
	assert.match(toolDetail, /namespace\.txt/);
	assert.match(toolDetail, /Messagemodel:openrouter\/openrouter\/fixture/, "tool details keep the entire native model ID, not just the provider prefix");
	view.handleInput("\x1b"); view.render(160); view.handleInput("\t"); view.handleInput("\x1b[F"); view.render(160);
	view.handleInput("\x1b[A"); view.render(160); view.handleInput("\r");
	const detail = await readDetails(view, 160);
	assert.match(detail, /Namespacedreply/);
	assert.match(detail, /Messagemodel:openrouter\/openrouter\/fixture/, "assistant details use the same full journal identity");
	view.handleInput("\x1b"); view.handleInput("\x1b"); await opening;
	assert.equal(fs.readFileSync(manager.getSessionFile(), "utf8"), saved);
	assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 0);
});

test("Agents model details retain an empty-content error model after fallback", async (t) => {
	const f = await fixture(t), manager = f.childSessions[0];
	const failed = { provider: "openrouter", id: "vendor/failed-fixture", api: "anthropic-messages" };
	const fallback = { provider: "openrouter", id: "openrouter/fixture", api: "openai-completions" };
	assert.equal(failed.provider, "openrouter"); assert.notEqual(failed.id, fallback.id);
	manager.appendMessage({ role: "assistant", content: [], provider: failed.provider, model: failed.id, api: failed.api, stopReason: "error", errorMessage: "quota exceeded", usage, timestamp: Date.now() });
	manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Fallback completed" }], provider: fallback.provider, model: fallback.id, api: fallback.api, stopReason: "stop", usage, timestamp: Date.now() });
	const saved = fs.readFileSync(manager.getSessionFile(), "utf8");
	await refreshFixture(f);
	const opening = f.controller.open(), view = f.overlay;
	await historyReady(f);
	assert.match(plain(view, 160), /saved: openrouter\/openrouter\/fixture/, "the conversation status has moved to the fallback");
	view.handleInput("\t"); view.handleInput("\x1b[F"); view.render(160); view.handleInput("\x1b[A"); view.render(160); view.handleInput("\r");
	const detail = await readDetails(view, 160);
	assert.match(detail, /Agenterror[\s\S]*quotaexceeded/);
	assert.ok(detail.includes(`Messagemodel:openrouter/${failed.id}`), "the empty error still identifies the failed message's own provider/model");
	view.handleInput("\x1b"); view.handleInput("\x1b"); await opening;
	assert.equal(fs.readFileSync(manager.getSessionFile(), "utf8"), saved);
	assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 0);
});

for (const [columns, rows] of [[110, 38], [24, 18]]) test(`Agents model identity remains fully accessible with native compact controls (${columns}×${rows})`, async (t) => {
	const f = await fixture(t, "fullscreen", 2);
	const model = "openrouter/vendor/very-long-model-namespace/long-model-name-with-full-identity-ENDROUTE:high";
	Object.assign(f.status.steps[0], { model, modelStartedAt: Date.now() + 1 });
	saveRunStatus(f.run.runId, f.status);
	f.controller.visit(f.key).readThrough = null;
	await refreshFixture(f);
	f.terminal.resize(columns, rows);
	const opening = f.controller.open(f.key); f.tui.start(); f.tui.renderNow();
	f.terminal.input("Keep the child draft"); f.tui.renderNow();
	const compact = f.controller.availableHeight(f.tui) < 16;
	await clickHint(f, compact ? "F2" : "F2 Actions");
	for (let index = 0; index < 3; index++) f.terminal.input("\x1b[B");
	f.tui.renderNow(); await clickHint(f, "Enter");
	const width = f.overlayBounds.width, full = await readDetails(f.overlay, width);
	assert.match(full, /openrouter/); assert.match(full, /ENDROUTE/);
	const content = f.overlay.scroll.render(width - 2).map(stripTerminalSequences).join("\n").replace(/\s/g, "");
	assert.ok(content.includes(model.replace(":high", "")), "the full route is wrapped, not shortened, in the existing assignment details");
	assert.match(content, /thinkinghigh/); assert.match(content, /Fixtheloginregression\./); assert.match(content, /KeeptheAPIunchanged\./);
	const frame = f.overlay.render(width);
	assert.ok(frame.length <= f.overlayBounds.height); assert.ok(frame.every((line) => visibleWidth(line) <= width));
	await clickHint(f, compact ? "Esc" : "Esc Back");
	assert.equal(f.overlay.editor.getText(), "Keep the child draft");
	await clickHint(f, compact ? "Esc" : "Esc Back"); await opening;
	assert.equal(f.mainEditor.getText(), "Unsent parent draft\nDo not replace this");
	assert.equal(f.calls.length, 0); assert.deepEqual(f.interrupts, [0, 0]);
});

test("Agents model identity leaves bare selections and unavailable metadata honest", async (t) => {
	const f = await fixture(t);
	f.ctx.model = { provider: "not-evidence", id: "qwen2.5-coder:7b" };
	Object.assign(f.status.steps[0], { model: "qwen2.5-coder:7b", modelStartedAt: Date.now() + 1 });
	saveRunStatus(f.run.runId, f.status);
	await refreshFixture(f);
	assert.match(plain(f.strip, 160), /selected: qwen2\.5-coder:7b/);
	assert.equal(f.controller.task(f.key)!.model.summary, "selected: qwen2.5-coder:7b");
	assert.doesNotMatch(plain(f.strip, 160), /not-evidence|ollama/);
	f.status.steps[0].model = undefined;
	f.status.steps[0].sessionFile = undefined;
	saveRunStatus(f.run.runId, f.status);
	f.run.children[0].sessionFile = undefined;
	saveQuestionContract(f.run.runId, 0, { sessionFile: undefined });
	await refreshFixture(f);
	assert.equal(f.controller.task(f.key)!.model.summary, "model unavailable");
});

for (const [background, nativeReply] of [[false, true], [false, false], [true, true], [true, false]]) test(`Agents model identity follows the ${background ? "background" : "foreground"} fallback before its first response and freezes ${nativeReply ? "native" : "selection-only"} completion`, async (t) => {
	const primary = "requested/vendor/primary:high", fallback = "backup/vendor/fallback:low";
	const f = await fixture(t, "regular", 1, undefined, [makeAgent("worker", { model: primary, fallbackModels: [fallback], completionGuard: false })]);
	const mock = createMockPi(); mock.install();
	f.state.ownedRuns!.clear(); await refreshFixture(f);
	const releasePrimary = path.join(f.cwd, "release-primary"), releaseFallback = path.join(f.cwd, "release-fallback");
	mock.onCall({ matchArgsIncludes: primary, waitForFile: releasePrimary, stderr: "quota exceeded", exitCode: 1 });
	mock.onCall({ matchArgsIncludes: fallback, waitForFile: releaseFallback, output: "Fallback finished" });
	const pending = f.executor.execute("model-fallback-view", { agent: "worker", task: "Verify the model display", async: background, artifacts: false, output: false }, undefined, undefined, f.ctx);
	let runId: string | undefined;
	t.after(async () => {
		fs.writeFileSync(releasePrimary, "released"); fs.writeFileSync(releaseFallback, "released"); await pending;
		if (background && runId) await until(() => fs.existsSync(path.join(getRunMetadataDir(runId!), "result.json")), "model fallback runner cleanup");
		if (process.env.PI_AGENT_VIEW_EVIDENCE_DIR) fs.cpSync(mock.dir, path.join(f.cwd, "mock-receipts"), { recursive: true });
		mock.uninstall();
	});
	await until(() => mock.callCount() === 1, "primary attempt starts");
	await refreshFixture(f);
	const task = f.controller.tasks[0]!; runId = task.run.runId;
	assert.match(plain(f.strip, 160), /selected: requested\/vendor\/primary · thinking high/);
	assert.equal(task.model.summary, "selected: requested/vendor/primary · thinking high");
	const native = SessionManager.open(task.child.sessionFile!, undefined, f.cwd);
	native.appendMessage({ role: "assistant", content: [{ type: "text", text: "Prior attempt" }], provider: "observed-primary", model: "vendor/native-primary", api: "openai-responses", stopReason: "error", errorMessage: "quota exceeded", usage, timestamp: Date.now() });
	fs.writeFileSync(releasePrimary, "released");
	await until(() => mock.callCount() === 2, "fallback starts without a saved response");
	await refreshFixture(f);
	assert.equal(f.controller.task(task.key)!.model.summary, "selected: backup/vendor/fallback · thinking low", "old native history and the initial launch cannot mask the selected fallback");
	assert.match(f.controller.task(task.key)!.model.details, /Last saved session model \(may precede this attempt\): observed-primary\/vendor\/native-primary/);
	if (nativeReply) {
		native.appendThinkingLevelChange("high");
		native.appendMessage({ role: "assistant", content: [{ type: "text", text: "Fallback finished" }], provider: "observed-fallback", model: "vendor/native-final", api: "openai-responses", stopReason: "stop", usage, timestamp: Date.now() });
		await refreshFixture(f);
		assert.equal(f.controller.task(task.key)!.model.summary, "observed-fallback/vendor/native-final · thinking high");
	}
	fs.writeFileSync(releaseFallback, "released"); await pending;
	if (background) await until(() => fs.existsSync(path.join(getRunMetadataDir(runId!), "result.json")), "fallback completion is saved");
	await refreshFixture(f);
	const completed = f.controller.task(task.key)!;
	assert.equal(completed.child.state, "completed");
	assert.equal(completed.model.summary, nativeReply ? "saved: observed-fallback/vendor/native-final · thinking high" : "selected: backup/vendor/fallback · thinking low");
	assert.equal(completed.child.result?.model, fallback, "candidate-first execution results and routing stay unchanged");
	const completedView = ownedRunView(f.state.ownedRuns!.get(runId!)!, f.state);
	assert.deepEqual(completedView.children[0]!.result?.attemptedModels, [primary, fallback]);
	assert.equal(mock.callCount(), 2);
	native.appendModelChange("later-session", "vendor/continuation");
	f.controller.start(f.ctx);
	await refreshFixture(f);
	assert.equal(f.controller.task(task.key)!.model.summary, completed.model.summary, "completed display uses the frozen per-run snapshot, not later shared-file choices");
	const owned = f.state.ownedRuns!.get(runId!)!, successorId = randomUUID(), startedAt = Date.now() + 1;
	const successor = { ...owned, runId: successorId, source: "async" as const, asyncDir: getRunMetadataDir(successorId), pid: process.pid, predecessorRunId: runId, predecessorIndex: 0, startedAt };
	f.state.ownedRuns!.set(successorId, successor);
	saveQuestionContract(successorId, 0, { task: "New continuation", sessionFile: task.child.sessionFile, launch: completedView.children[0]!.launch });
	saveRunStatus(successorId, { ...f.status, runId: successorId, mode: "single", startedAt, lastUpdate: startedAt,
		steps: [{ agent: "worker", status: "running", sessionFile: task.child.sessionFile, model: "next-provider/vendor/model", modelStartedAt: startedAt }] });
	await refreshFixture(f);
	assert.equal(f.controller.tasks.length, 1);
	assert.equal(f.controller.task(task.key)!.run.runId, successorId);
	assert.equal(f.controller.task(task.key)!.model.summary, "selected: next-provider/vendor/model", "the successor must not claim the predecessor's frozen or last saved model as current");
	assert.equal(ownedRunView(owned, f.state).children[0]!.launch?.model, nativeReply ? "observed-fallback/vendor/native-final" : "observed-primary/vendor/native-primary", "display metadata does not rewrite continuation routing choices");
	fs.writeFileSync(path.join(f.cwd, "model-boundaries.json"), JSON.stringify({ background, completed: completed.model, successor: f.controller.task(task.key)!.model }, null, 2));
	assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 0);
});

test("Agents model identity keeps the owner's latest selection after response-less finalization", async (t) => {
	const requested = "requested/vendor/finalization:low";
	const f = await fixture(t), native = f.childSessions[0];
	native.appendMessage({ role: "assistant", content: [{ type: "text", text: "Initial report" }], provider: "observed", model: "vendor/earlier-remap", api: "openai-responses", stopReason: "stop", usage, timestamp: Date.now() });
	const modelSelection = { model: requested, modelStartedAt: Date.now() + 1 };
	saveQuestionContract(f.run.runId, 0, { modelSelection });
	Object.assign(f.status.steps[0], modelSelection);
	saveRunStatus(f.run.runId, f.status);
	await refreshFixture(f);
	assert.equal(f.controller.task(f.key)!.model.summary, "selected: requested/vendor/finalization · thinking low");
	saveAsyncRunResult(f.run.runId, { runtimeVersion: 2, id: f.run.runId, state: "failed", timestamp: modelSelection.modelStartedAt + 1,
		results: [{ agent: "worker", task: f.run.children[0].task, model: requested, sessionFile: native.getSessionFile(), success: false, exitCode: 1, error: "quota exceeded" }] });
	f.controller.start(f.ctx);
	await refreshFixture(f);
	assert.equal(f.controller.task(f.key)!.child.result?.model, requested);
	assert.equal(f.controller.task(f.key)!.child.state, "failed");
	const opening = f.controller.open(f.key);
	assert.match(plain(f.overlay, 160), /selected: requested\/vendor\/finalization · thinking low/, "the completed snapshot must keep the latest selected attempt when finalization saves no native response");
	f.overlay.handleInput("\x1b"); await opening;
	assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 0);
});

for (const mode of ["regular", "fullscreen"] as const) test(`Agents strip and single-child open are native, read-only, and preserve the parent (${mode})`, async (t) => {
	const f = await fixture(t, mode), frames = [];
	const capture = (state: string) => {
		f.tui.renderNow();
		const native = f.tui instanceof TuiAltScreen ? f.tui.getScreenLines() : (() => {
			const snapshot = f.tui.captureRenderState();
			return snapshot.previousLines.slice(snapshot.previousViewportTop, snapshot.previousViewportTop + f.terminal.rows);
		})();
		const lines = native.map(stripTerminalSequences);
		assert.ok(lines.length <= f.terminal.rows && lines.every((line) => visibleWidth(line) <= f.terminal.columns));
		frames.push({ state, mode, columns: f.terminal.columns, rows: f.terminal.rows, lines });
	};
	f.tui.start(); capture("dock");
	assert.match(plain(f.strip, 90), /^Agents.*1 running[\s\S]*Fix login/);
	assert.doesNotMatch(plain(f.strip), /tokens|Combined tasks/);
	assert.match(plain(f.strip, 12), /^Agents/);
	const opening = f.controller.open();
	assert.ok(f.overlay instanceof AgentConversation);
	const view = f.overlay;
	await historyReady(f);
	assert.ok(view.editor instanceof Editor);
	assert.equal(view.focused, true);
	assert.equal(view.editor.focused, true);
	f.terminal.input("\x1b[200~first line\nsecond line 日本語\x1b[201~");
	assert.equal(view.editor.getExpandedText(), "first line\nsecond line 日本語");
	assert.equal(f.calls.length, 0);
	for (const [columns, rows] of [[90, 28], [24, 18], [160, 40], [90, 28]]) {
		f.terminal.resize(columns, rows); capture("composing");
		assert.equal(view.editor.getExpandedText(), "first line\nsecond line 日本語");
	}
	f.terminal.input("\t"); capture("reading");
	assert.equal(view.editor.focused, false);
	f.terminal.input("\t"); assert.equal(view.editor.focused, true);
	f.terminal.input("\x1b"); await opening; capture("closed");
	assert.equal(f.mainEditor.getText(), "Unsent parent draft\nDo not replace this");
	assert.equal(f.mainEditor.focused, true);
	assert.deepEqual(f.interrupts, [0]);
	const reopen = f.controller.open();
	assert.equal(f.overlay.editor.getExpandedText(), "first line\nsecond line 日本語");
	f.controller.dispose(); await reopen; capture("disposed");
	assert.equal(f.tui.hasOverlay(), false);
	assert.equal(f.mainEditor.focused, true);
	assert.equal(f.calls.length, 0);
	if (process.env.PI_AGENT_VIEW_EVIDENCE_DIR) fs.writeFileSync(path.join(root, `native-${mode}-frames.json`), JSON.stringify(frames, null, 2));
});

test("clickable Agents hints: Esc Back closes the native conversation and preserves both drafts", async (t) => {
	const f = await fixture(t, "fullscreen"), opening = f.controller.open();
	f.tui.start(); f.tui.renderNow();
	f.terminal.input("Keep this child draft"); f.tui.renderNow();
	const bounds = f.overlayBounds, lines = f.overlay.render(bounds.width).map(stripTerminalSequences);
	const y = lines.findIndex((line) => line.includes("Esc Back"));
	assert.ok(y >= 0, "Esc Back is actually displayed");
	const x = lines[y].indexOf("Esc Back") + "Esc ".length;
	f.terminal.click(bounds.col + x, bounds.row + y); await turn();
	assert.equal(f.tui.hasOverlay(), false, "clicking Back must close the same view as Escape");
	await opening;
	assert.equal(f.controller.visit(f.key).draft, "Keep this child draft");
	assert.equal(f.mainEditor.getText(), "Unsent parent draft\nDo not replace this");
	assert.equal(f.mainEditor.focused, true);
	assert.equal(f.calls.length, 0); assert.deepEqual(f.interrupts, [0]);
});

for (const [columns, rows] of [[110, 38], [56, 38], [24, 18]]) test(`clickable Agents hints: actions, read/write, details, reply and quote (${columns}×${rows})`, async (t) => {
	const f = await fixture(t, "fullscreen"), opening = f.controller.open();
	f.terminal.resize(columns, rows); f.tui.start(); f.tui.renderNow();
	f.terminal.input("Unsent child draft"); f.tui.renderNow();
	await historyReady(f); f.tui.renderNow();
	const compact = f.controller.availableHeight(f.tui) < 16;
	await clickHint(f, compact ? "Tab" : "Read/write");
	assert.equal(f.overlay.editor.focused, false);
	f.terminal.input("\x1b[F"); await historyReady(f); f.tui.renderNow();
	if (!compact) {
		assert.match(plain(f.overlay, f.overlayBounds.width), /Enter Details/);
		assert.doesNotMatch(plain(f.overlay, f.overlayBounds.width), /Enter Send/);
		await clickHint(f, "Details");
	} else {
		await clickHint(f, "F2");
		assert.match(plain(f.overlay, f.overlayBounds.width), /Reply/);
		f.terminal.input("\x1b[B"); f.tui.renderNow();
		await clickHint(f, "Enter");
	}
	assert.ok(plain(f.overlay, f.overlayBounds.width).includes(compact ? `${altLabel}+R · F2` : "details"));
	assert.ok(!f.overlay.render(f.overlayBounds.width).some((line) => line.includes(CURSOR_MARKER)), "details hide the composer");
	assert.doesNotMatch(plain(f.overlay, f.overlayBounds.width), /Tab/);
	await until(() => plain(f.overlay, f.overlayBounds.width).replace(/\s/g, "").includes("Messagemodel:fixture/fixture"), "native selected details are ready before Reply");
	await clickHint(f, compact ? `${altLabel}+R` : "Reply");
	await until(() => Boolean(f.controller.visit(f.key).quote), "full contextual reply loaded");
	assert.equal(f.overlay.editor.focused, true);
	assert.equal(f.controller.visit(f.key).quote?.text, "I found the relevant code.");
	assert.equal(f.overlay.editor.getText(), "Unsent child draft");
	await clickHint(f, `${altLabel}+Q`);
	assert.equal(f.controller.visit(f.key).quote, undefined);
	await clickHint(f, compact ? "F2" : "Actions");
	assert.match(plain(f.overlay, f.overlayBounds.width), /Reply/);
	await clickHint(f, compact ? "Esc" : "Back to conversation");
	assert.equal(f.tui.hasOverlay(), true);
	assert.equal(f.overlay.editor.focused, true);
	assert.equal(f.overlay.editor.getText(), "Unsent child draft");
	await clickHint(f, compact ? "Esc" : "Back"); await opening;
	assert.equal(f.tui.hasOverlay(), false);
	assert.equal(f.calls.length, 0); assert.deepEqual(f.interrupts, [0]);
});

for (const [columns, rows] of [[110, 38], [56, 38], [24, 18]]) test(`clickable Agents hints: picker navigation, filter, open and back (${columns}×${rows})`, async (t) => {
	const f = await fixture(t, "fullscreen", 2), opening = f.controller.open();
	f.terminal.resize(columns, rows); f.tui.start(); f.tui.renderNow();
	await clickHint(f, "↓");
	assert.match(plain(f.overlay, f.overlayBounds.width), /→.*Revi/);
	await clickHint(f, "↑");
	assert.match(plain(f.overlay, f.overlayBounds.width), /→.*Fix/);
	if (f.controller.availableHeight(f.tui) >= 16) await clickHint(f, "Type to filter");
	f.terminal.input("Review");
	await until(() => !f.controller.listLoading && f.controller.tasks.length === 1 && f.controller.tasks[0].child.index === 1, "global picker filter loaded");
	f.tui.renderNow();
	assert.doesNotMatch(plain(f.overlay, f.overlayBounds.width), /Fix login/);
	await clickHint(f, "Enter");
	assert.equal(f.overlay.key, `${f.run.runId}:1`);
	await clickHint(f, "Esc"); await opening;
	assert.equal(f.tui.hasOverlay(), false);
	const again = f.controller.open(); f.tui.renderNow();
	await clickHint(f, "Esc"); await again;
	assert.equal(f.tui.hasOverlay(), false, "picker Back closes without choosing another child");
	assert.equal(f.calls.length, 0);
});

test("clickable Agents hints: latest leaves a scrolled reading position only on activation", async (t) => {
	const f = await fixture(t, "fullscreen"), manager = f.childSessions[0];
	for (let i = 0; i < 30; i++) assistant(manager, `Saved message ${i}`);
	await refreshFixture(f);
	const opening = f.controller.open(); await historyReady(f); f.tui.start(); f.tui.renderNow();
	f.terminal.input("Keep my draft"); f.terminal.input("\x1b[5~"); f.tui.renderNow();
	const anchor = structuredClone(f.controller.visit(f.key).anchor);
	assistant(manager, "New activity arrived"); await refreshFixture(f); f.tui.renderNow();
	assert.deepEqual(f.controller.visit(f.key).anchor, anchor);
	await clickHint(f, "Actions");
	assert.ok(!plain(f.overlay, f.overlayBounds.width).includes(`${altLabel}+L`), "menus do not advertise a shortcut they ignore");
	await clickHint(f, "Back to conversation");
	const point = hintPoint(f, `${altLabel}+L latest`);
	f.terminal.input(`\x1b[<0;${point.x + 1};${point.y + 1}M`); f.tui.renderNow();
	assert.equal(f.overlay.scroll.isFollowingEnd, false, "press cannot activate a hint");
	f.terminal.input(`\x1b[<0;${point.x + 1};${point.y + 1}m`); await turn(); f.tui.renderNow();
	assert.equal(f.overlay.scroll.isFollowingEnd, true);
	assert.match(plain(f.overlay, f.overlayBounds.width), /New activity arrived/);
	assert.equal(f.overlay.editor.getText(), "Keep my draft");
	await clickHint(f, "Esc Back"); await opening;
});

for (const binding of ["ctrl+o", "ctrl+e"]) test(`clickable Agents hints: direct-user breadcrumb uses native custom-message expansion (${binding})`, async (t) => {
	const { KeybindingsManager } = await import(pathToFileURL(path.join(sdkRoot, "dist/core/keybindings.js")).href);
	setTestKeybindings(t, new KeybindingsManager({ "app.tools.expand": binding }));
	const f = await fixture(t, "fullscreen");
	const message = { customType: "subagent-human-direction", content: "Informational only", details: { label: "Fix login", text: "Preserve the API", quote: { title: "Recorded change", text: "FULL-QUOTED-CONTEXT" } } };
	let card, done;
	const opening = f.ctx.ui.custom((_tui, _theme, _keys, close) => {
		done = close;
		card = new CustomMessageComponent(message, f.renderers.get("subagent-human-direction"));
		return card;
	}, { overlayOptions: { width: "90%", margin: 1 } });
	f.tui.start(); f.tui.renderNow();
	assert.doesNotMatch(plain(card), /FULL-QUOTED-CONTEXT/);
	await clickHint(f, binding);
	assert.match(plain(card), /FULL-QUOTED-CONTEXT/);
	card.setExpanded(true); card.setExpanded(false); f.tui.renderNow();
	assert.doesNotMatch(plain(card), /FULL-QUOTED-CONTEXT/, "native global expansion changes override the local click state");
	await clickHint(f, binding);
	assert.match(plain(card), /FULL-QUOTED-CONTEXT/);
	done(); await opening;
	assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 0);
});

for (const columns of [100, 24]) test(`clickable Agents hints: Send keeps a draft until native receipt and cannot duplicate (${columns} columns)`, async (t) => {
	const f = await fixture(t, "fullscreen"); f.terminal.resize(columns, 48);
	const deliveries = [], opening = f.controller.open(); f.tui.start(); f.tui.renderNow();
	f.pi.events.on("subagent:live-intercom", (payload) => {
		deliveries.push(payload);
		f.pi.events.emit("subagent:live-intercom-delivery", { requestId: payload.requestId, accepted: true, delivered: true, messageId: payload.messageId });
	});
	const draft = "  Keep the API\n日本語  ";
	f.terminal.input(`\x1b[200~${draft}\x1b[201~`); f.tui.renderNow();
	await clickHint(f, "Send");
	assert.equal(deliveries.length, 1);
	assert.equal(deliveries[0].message, draft.trim());
	assert.equal(deliveries[0].human.index, 0);
	assert.equal(deliveries[0].to, `subagent-worker-${f.run.runId}-1`);
	assert.equal(f.overlay.editor.getText(), draft);
	await clickHint(f, "Send");
	assert.equal(deliveries.length, 1);
	assert.equal(f.sent.length, 1); assert.equal(f.sent[0].options.triggerTurn, false);
	f.childSessions[0].appendCustomMessageEntry("subagent-human-message", draft.trim(), true, { bodyText: draft.trim(), message: { id: deliveries[0].messageId } });
	await refreshFixture(f); f.tui.renderNow();
	assert.equal(f.overlay.editor.getText(), "");
	assert.equal(f.controller.visit(f.key).outbox.length, 0);
	await clickHint(f, "Esc"); await opening;
	assert.equal(f.calls.length, 0);
});

for (const surface of ["footer", "notice", "menu"]) test(`clickable Agents hints: explicit Continue from ${surface} uses the saved assignment`, async (t) => {
	let release;
	const f = await fixture(t, "fullscreen", 1, () => new Promise((resolve) => { release = () => resolve({ content: [{ type: "text", text: "Continued" }], details: { mode: "single", results: [] } }); }));
	const agent = makeAgent("worker", { completionGuard: false });
	saveQuestionContract(f.run.runId, 0, { launch: { agent, systemPrompt: "Saved instructions", skills: [], cwd: f.cwd, context: "fresh", artifacts: false, output: false, outputMode: "inline", share: false } });
	await f.complete(); f.terminal.resize(180, 42);
	let opening = f.controller.open(); f.tui.start(); f.tui.renderNow();
	f.terminal.input("Continue with this exact draft"); f.tui.renderNow();
	assert.equal(f.calls.length, 0);
	if (surface === "notice") {
		f.terminal.input("\r"); f.tui.renderNow();
		assert.equal(f.calls.length, 0, "Enter cannot restart a completed child");
		await clickHint(f, "Esc Back"); await opening;
		f.controller.dispose(); f.controller.start(f.ctx);
		await refreshFixture(f);
		opening = f.controller.open(); f.tui.renderNow();
		await clickHint(f, "Continue with this message (");
	} else if (surface === "menu") {
		await clickHint(f, "Actions");
		assert.equal(f.calls.length, 0);
		await clickHint(f, "Continue with this message");
	} else await clickHint(f, "Continue with message");
	assert.deepEqual(f.calls, [{ action: "resume", id: f.run.runId, index: 0, message: "Continue with this exact draft", messageOrigin: "human" }]);
	assert.equal(f.overlay.editor.getText(), "Continue with this exact draft", "draft stays while continuation is pending");
	release(); await turn(); f.tui.renderNow();
	assert.equal(f.overlay.editor.getText(), "");
	assert.match(plain(f.overlay, f.overlayBounds.width), /Continuation started on the saved conversation/);
	assert.equal(f.sent.length, 1);
	await clickHint(f, "Esc Back"); await opening;
});

test("clickable Agents hints: native menu Stop remains explicit and targets only the selected child", async (t) => {
	const f = await fixture(t, "fullscreen", 2); f.terminal.resize(100, 48);
	const opening = f.controller.open(`${f.run.runId}:1`); f.tui.start(); f.tui.renderNow();
	await clickHint(f, "Actions");
	assert.deepEqual(f.interrupts, [0, 0]);
	await clickHint(f, "Stop this agent only");
	assert.deepEqual(f.interrupts, [0, 1]);
	assert.deepEqual(f.calls, [{ action: "interrupt", id: f.run.runId, index: 1 }]);
	assert.match(plain(f.overlay, f.overlayBounds.width), /Stop requested for this child only/);
	await clickHint(f, "Esc Back"); await opening;
});

test("clickable Agents hints: more-agents command opens the picker without choosing a child", async (t) => {
	const f = await fixture(t, "fullscreen", 6); f.tui.start(); f.tui.renderNow();
	const rows = f.strip.render(f.terminal.columns).map(stripTerminalSequences), row = rows.findIndex((line) => line.includes("/agents"));
	assert.ok(row >= 0);
	const dockTop = f.terminal.rows - rows.length - f.mainEditor.render(f.terminal.columns).length - 1;
	f.terminal.click(rows[row].indexOf("/agents") + 2, dockTop + row); await turn(); f.tui.renderNow();
	assert.equal(f.tui.hasOverlay(), true);
	assert.ok(!(f.overlay instanceof AgentConversation));
	await clickHint(f, "Esc");
	assert.equal(f.tui.hasOverlay(), false);
	assert.equal(f.calls.length, 0);
});

test("clickable Agents hints: native Option labels preserve Alt bindings and clipped quote actions", async (t) => {
	const f = await fixture(t, "fullscreen"), opening = f.controller.open();
	f.terminal.resize(100, 48); f.tui.start(); f.tui.renderNow();
	const draft = "Literal Alt+R stays in my draft";
	f.terminal.input(draft); f.terminal.input("\x1br");
	await until(() => Boolean(f.controller.visit(f.key).quote), "full quoted context loaded"); f.tui.renderNow();
	assert.ok(plain(f.overlay, f.overlayBounds.width).includes(`Quote · ${altLabel}+Q remove`));
	f.terminal.input("\t"); f.terminal.input("\r"); f.tui.renderNow();
	assert.ok(plain(f.overlay, f.overlayBounds.width).includes(`${altLabel}+R Reply`));
	f.terminal.input("\x1br"); f.tui.renderNow();
	assert.equal(f.overlay.editor.getText(), draft, "display formatting cannot rewrite draft text or bindings");
	f.terminal.resize(24, 48); f.tui.renderNow();
	await clickHint(f, `${altLabel}+Q`);
	assert.equal(f.controller.visit(f.key).quote, undefined, "the longer native label remains clickable after clipping");
	assert.equal(f.overlay.editor.getText(), draft);
	await clickHint(f, "Esc"); await opening;
	assert.equal(f.calls.length, 0);
});

test("clickable Agents hints: Back unwinds details and its menu without losing read position or native selection", async (t) => {
	const f = await fixture(t, "fullscreen");
	for (let i = 0; i < 30; i++) assistant(f.childSessions[0], `Historical message ${i}\nRecorded detail ${i}`);
	await refreshFixture(f);
	const opening = f.controller.open(); await historyReady(f); f.tui.start(); f.tui.renderNow();
	f.terminal.input("Unsent draft"); f.terminal.input("\x1b[5~"); f.tui.renderNow();
	const anchor = f.controller.visit(f.key).anchor?.id;
	assert.ok(anchor);
	await clickHint(f, "Read/write");
	await clickHint(f, "Enter Details");
	await clickHint(f, "F2 Actions");
	await clickHint(f, "Back to details");
	assert.ok(plain(f.overlay, f.overlayBounds.width).includes("› details"));
	assert.equal(f.overlay.editor.focused, false);
	await clickHint(f, "Esc Back");
	assert.equal(f.controller.visit(f.key).anchor?.id, anchor);
	assert.equal(f.overlay.editor.getText(), "Unsent draft");
	assert.equal(f.overlay.editor.focused, true);
	const word = "Historical", point = hintPoint(f, word), x = point.x - word.length + 1;
	f.terminal.input(`\x1b[<0;${x + 1};${point.y + 1}M`);
	f.terminal.input(`\x1b[<32;${point.x + 1};${point.y + 1}M`);
	f.terminal.input(`\x1b[<0;${point.x + 1};${point.y + 1}m`); await turn(); f.tui.renderNow();
	assert.deepEqual(f.copied, [word], "non-hint transcript drags still use native selection");
	const action = hintPoint(f, "F2 Actions"), back = hintPoint(f, "Esc Back");
	f.terminal.input(`\x1b[<0;${action.x + 1};${action.y + 1}M`);
	f.terminal.input(`\x1b[<32;${back.x + 1};${back.y + 1}M`);
	f.terminal.input(`\x1b[<0;${back.x + 1};${back.y + 1}m`); await turn(); f.tui.renderNow();
	assert.doesNotMatch(plain(f.overlay, f.overlayBounds.width), /Reply to selected/);
	assert.equal(f.tui.hasOverlay(), true, "a drag between hints activates neither end");
	await clickHint(f, "Esc Back"); await opening;
	assert.equal(f.calls.length, 0);
});

test("clickable Agents hints: configured native selection and submit keys keep matching their labels", async (t) => {
	const { KeybindingsManager } = await import(pathToFileURL(path.join(sdkRoot, "dist/core/keybindings.js")).href);
	setTestKeybindings(t, new KeybindingsManager({ "tui.select.down": "ctrl+e", "tui.select.confirm": "ctrl+g", "tui.select.cancel": "ctrl+q", "tui.input.submit": "alt+enter" }));
	const f = await fixture(t, "fullscreen", 2), deliveries = [], opening = f.controller.open();
	f.tui.start(); f.tui.renderNow();
	await clickHint(f, "ctrl+e Choose");
	await clickHint(f, "ctrl+g Open");
	assert.equal(f.overlay.key, `${f.run.runId}:1`);
	f.pi.events.on("subagent:live-intercom", (payload) => {
		deliveries.push(payload);
		f.pi.events.emit("subagent:live-intercom-delivery", { requestId: payload.requestId, accepted: true, delivered: true, messageId: payload.messageId });
	});
	f.terminal.input("Configured send"); f.terminal.input("\x1b[13;3u"); await turn(); f.tui.renderNow();
	assert.equal(deliveries.length, 1, "the actual configured native submit key still sends");
	await clickHint(f, `${altLabel.toLowerCase()}+enter Send`);
	assert.equal(deliveries.length, 1, "click uses the same pending-delivery guard");
	await clickHint(f, "Actions");
	await clickHint(f, "ctrl+q Back to conversation");
	await clickHint(f, "Esc Back"); await opening;
	assert.equal(f.calls.length, 0);
});

test("clickable Agents hints: quoted shell tabs keep native text and remove-control coordinates aligned", async (t) => {
	const f = await fixture(t, "fullscreen"); f.terminal.resize(120, 48);
	f.childSessions[0].appendMessage({ role: "bashExecution", command: "printf\tquote", output: "Recorded output", exitCode: 0, cancelled: false, timestamp: Date.now() });
	await refreshFixture(f);
	const opening = f.controller.open(); f.tui.start(); f.tui.renderNow();
	await historyReady(f);
	f.terminal.input("\t"); f.terminal.input("\x1b[F"); f.tui.renderNow();
	f.terminal.input("\x1br"); f.terminal.input("Unsent draft");
	await until(() => Boolean(f.controller.visit(f.key).quote), "full quoted shell context loaded"); f.tui.renderNow();
	assert.ok(f.controller.visit(f.key).quote?.title.includes("printf\tquote"));
	assert.match(plain(f.overlay, f.overlayBounds.width), /Shell: printf   quote/);
	await clickHint(f, `${altLabel}+Q remove`);
	assert.equal(f.controller.visit(f.key).quote, undefined);
	assert.equal(f.overlay.editor.getText(), "Unsent draft");
	await clickHint(f, "Esc Back"); await opening;
	assert.equal(f.calls.length, 0);
});

test("clickable Agents hints: remapped picker Up owns its displayed cell, not a letter in Type to filter", async (t) => {
	const { KeybindingsManager } = await import(pathToFileURL(path.join(sdkRoot, "dist/core/keybindings.js")).href);
	setTestKeybindings(t, new KeybindingsManager({ "tui.select.up": "p" }));
	const f = await fixture(t, "fullscreen", 2), opening = f.controller.open();
	f.tui.start(); f.tui.renderNow();
	f.terminal.input("\x1b[B"); f.tui.renderNow();
	assert.match(plain(f.overlay, f.overlayBounds.width), /→.*Review changes/);
	const up = hintPoint(f, "p/↓ Choose");
	f.terminal.click(up.x - visibleWidth("/↓ Choose"), up.y); await turn(); f.tui.renderNow();
	assert.match(plain(f.overlay, f.overlayBounds.width), /→.*Fix login/, "the displayed p performs Up");
	f.terminal.input("\x1b[B"); f.tui.renderNow();
	const filter = hintPoint(f, "Type");
	f.terminal.click(filter.x - 1, filter.y); await turn(); f.tui.renderNow();
	assert.match(plain(f.overlay, f.overlayBounds.width), /→.*Review changes/, "the p inside Type to filter only focuses the filter");
	f.terminal.input("p"); f.tui.renderNow();
	assert.match(plain(f.overlay, f.overlayBounds.width), /→.*Fix login/, "the configured key still performs Up");
	await clickHint(f, "Esc Back"); await opening;
	assert.equal(f.calls.length, 0);
});

test("clickable Agents hints: ordinary activity stays literal and cannot jump to latest", async (t) => {
	const f = await fixture(t, "fullscreen"); f.terminal.resize(120, 48);
	for (let i = 0; i < 30; i++) assistant(f.childSessions[0], `Saved message ${i}`);
	Object.assign(f.status.steps[0], { streamingText: "Alt+L latest is the old label", lastActivityAt: 0 });
	saveRunStatus(f.run.runId, f.status);
	await refreshFixture(f);
	const opening = f.controller.open(); f.tui.start(); f.tui.renderNow();
	await historyReady(f); f.tui.renderNow();
	assert.equal(f.overlay.scroll.isFollowingEnd, true);
	assert.match(plain(f.overlay, f.overlayBounds.width), /worker · Alt\+L latest is the old label/, "activity is not an owned keyboard label");
	f.terminal.input("Keep my draft"); f.terminal.input("\x1b[5~"); f.tui.renderNow();
	await refreshFixture(f); f.tui.renderNow();
	await f.controller.refresh(); f.tui.renderNow();
	assert.equal(f.controller.task(f.key).unread, false);
	const anchor = structuredClone(f.controller.visit(f.key).anchor);
	await clickHint(f, "latest");
	assert.equal(f.overlay.scroll.isFollowingEnd, false, "clicking ordinary activity cannot activate Latest");
	assert.deepEqual(f.controller.visit(f.key).anchor, anchor);
	assert.equal(f.overlay.editor.getText(), "Keep my draft");
	await clickHint(f, "Esc Back"); await opening;
	assert.equal(f.calls.length, 0);
});

test("clickable Agents hints: more-agents excludes clipping dots and padding but keeps visible command clicks", async (t) => {
	const f = await fixture(t, "fullscreen", 6); f.tui.start();
	for (const columns of [18, 100]) {
		f.terminal.resize(columns, 48); f.tui.renderNow();
		const rows = f.strip.render(columns).map(stripTerminalSequences), row = rows.findIndex((line) => line.includes("more"));
		assert.ok(row >= 0);
		const dockTop = f.terminal.rows - rows.length - f.mainEditor.render(columns).length - 1;
		const dots = rows[row].indexOf("...");
		if (columns === 18) assert.ok(dots >= 0, `narrow command must be clipped: ${rows[row]}`);
		for (const x of dots >= 0 ? [dots, dots + 1, dots + 2, 0, 1] : [0, 1, visibleWidth(rows[row]) + 1]) {
			f.terminal.click(x, dockTop + row); await turn(); f.tui.renderNow();
			assert.equal(f.tui.hasOverlay(), false, "clipping markers and padding are not command text");
		}
		f.terminal.click(rows[row].indexOf("more"), dockTop + row); await turn(); f.tui.renderNow();
		assert.equal(f.tui.hasOverlay(), true, "the visible command still opens the picker");
		assert.ok(!(f.overlay instanceof AgentConversation));
		await clickHint(f, "Esc");
		assert.equal(f.tui.hasOverlay(), false);
	}
	assert.equal(f.calls.length, 0);
});

test("clickable Agents hints: a returned notice cannot declare a Continue action, even after reload", async (t) => {
	const notice = "This agent has finished. Your draft is kept. Choose Continue with this message (Alt+C).";
	const f = await fixture(t, "fullscreen", 1, async () => ({ isError: true, content: [{ type: "text", text: notice }], details: { mode: "single", results: [] } }));
	f.terminal.resize(180, 48);
	let opening = f.controller.open(); f.tui.start(); f.tui.renderNow();
	f.terminal.input("Keep my draft");
	await clickHint(f, "Actions"); await clickHint(f, "Stop this agent only");
	for (const restored of [false, true]) {
		if (restored) {
			f.controller.dispose(); f.controller.start(f.ctx);
			await refreshFixture(f);
			opening = f.controller.open(); f.tui.renderNow();
		}
		assert.ok(plain(f.overlay, f.overlayBounds.width).includes(notice), "returned text stays literal even when it exactly matches an old generated notice");
		await clickHint(f, "Continue with this message (");
		assert.equal(f.calls.length, 1, "returned data must not start a continuation");
		assert.equal(f.calls[0].action, "interrupt");
		assert.equal(f.sent.length, 0); assert.equal(f.controller.visit(f.key).outbox.length, 0);
		assert.equal(f.overlay.editor.getText(), "Keep my draft");
		await clickHint(f, "Esc Back"); await opening;
	}
});

test("live multiple-child picker and fullscreen task click target the exact child", async (t) => {
	const f = await fixture(t, "fullscreen", 2);
	const opening = f.controller.open();
	assert.doesNotMatch(f.overlay.constructor.name, /AgentConversation/);
	assert.match(plain(f.overlay), /Fix login[\s\S]*Review changes[\s\S]*Other connected sessions/);
	f.overlay.handleInput("\x1b[B"); f.overlay.handleInput("\r"); await turn();
	assert.ok(f.overlay instanceof AgentConversation);
	assert.equal(f.overlay.key, `${f.run.runId}:1`);
	await f.controller.stop(f.overlay.key);
	assert.deepEqual(f.interrupts, [0, 1]);
	f.overlay.handleInput("\x1b"); await opening;
	const rows = f.strip.render(140).map(stripTerminalSequences);
	const y = rows.findIndex((line) => line.includes("Review changes")), x = rows[y].indexOf("Review changes") + 2;
	f.strip.handleMouse({ type: "click", button: "left", x, y, screenX: x, screenY: y, width: 140, height: rows.length, shift: false, alt: false, ctrl: false });
	assert.equal(f.overlay.key, `${f.run.runId}:1`);
	f.overlay.handleInput("\x1b"); await turn();
});

test("full native history, tool details and contextual reply survive streaming and narrow rendering", async (t) => {
	const f = await fixture(t);
	const manager = f.childSessions[0];
	for (let index = 0; index < 30; index++) assistant(manager, `Historical message ${index}\nReadable detail ${index}`);
	manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "edit-1", name: "edit", arguments: { path: "login.ts", oldText: "before", newText: "after" } }], stopReason: "toolUse", provider: "fixture", model: "fixture", api: "openai-responses", usage, timestamp: Date.now() });
	manager.appendMessage({ role: "toolResult", toolCallId: "edit-1", toolName: "edit", content: [{ type: "text", text: "Edited login.ts" }], isError: false, details: { diff: "-before\n+after", completeDetail: "FULL-DETAIL-END" }, timestamp: Date.now() });
	await refreshFixture(f);
	const opening = f.controller.open();
	const view = f.overlay as InstanceType<typeof AgentConversation>;
	await historyReady(f); view.render(90);
	const readThrough = f.controller.visit(f.key).readThrough;
	view.handleInput("\x1b[5~"); view.render(90);
	assert.equal(f.controller.visit(f.key).readThrough, readThrough, "reading backwards cannot regress the unread boundary");
	const anchor = f.controller.visit(f.key).anchor;
	assistant(manager, "New streamed response\n".repeat(20));
	await refreshFixture(f); view.render(90);
	assert.deepEqual(f.controller.visit(f.key).anchor, anchor, "append must not pull a scrolled reader to the bottom");
	assert.match(plain(view), /New activity/);
	view.handleInput("\t"); view.handleInput("\x1b[F"); view.render(90);
	// The last native message follows the edit result, so Up selects that result.
	view.handleInput("\x1b[A"); view.render(90);
	view.handleInput("\x1bd");
	assert.match(await readDetails(view), /FULL-DETAIL-END/);
	assert.equal(f.calls.length, 0);
	view.handleInput("\x1br"); view.render(90);
	assert.match(f.controller.visit(f.key).quote!.text, /FULL-DETAIL-END/);
	assert.match(f.controller.visit(f.key).quote!.text, /-before\n\+after/);
	view.handleInput("Keep this API");
	const observed = [];
	f.pi.events.on("subagent:live-intercom", (payload) => {
		observed.push(payload);
		f.pi.events.emit("subagent:live-intercom-delivery", { requestId: payload.requestId, delivered: true, accepted: true, messageId: payload.messageId });
	});
	view.handleInput("\r"); await turn();
	assert.equal(observed.length, 1);
	view.handleInput("\r"); await turn();
	assert.equal(observed.length, 1, "unchanged Enter cannot duplicate an accepted message awaiting native consumption");
	assert.equal(observed[0].human.ownerSessionId, f.parent.getSessionId());
	assert.equal(observed[0].human.index, 0);
	assert.match(observed[0].attachments[0].content, /FULL-DETAIL-END/);
	assert.equal(f.sent.length, 1);
	assert.equal(f.sent[0].options.triggerTurn, false);
	assert.match(f.sent[0].message.content, /Keep this API/);
	assert.equal(view.editor.getExpandedText(), "Keep this API", "keep the draft until native receipt confirms conversation delivery");
	manager.appendCustomMessageEntry("subagent-human-message", "Keep this API", true, { bodyText: "Keep this API", message: { id: observed[0].messageId } });
	await refreshFixture(f);
	assert.equal(view.editor.getExpandedText(), "");
	assert.equal(f.controller.visit(f.key).outbox.length, 0);
	assert.equal(f.controller.visit(f.key).notice, undefined, "the native receipt clears the obsolete already-waiting notice");
	f.terminal.columns = 24; f.terminal.rows = 18;
	const narrow = view.render(24);
	assert.ok(narrow.every((line) => visibleWidth(line) <= 24));
	assert.ok(narrow.length <= 18, `view must fit the native overlay: ${narrow.length}`);
	view.handleInput("\x1b"); await opening;
});

test("native Agents earlier/later pages and Latest retain access to exact selected full bodies", async (t) => {
	const f = await fixture(t), manager = f.childSessions[0];
	const full = `History card 97\n${"full-detail ".repeat(600)}PAGE-97-FULL-END`;
	for (let index = 0; index < 250; index++) assistant(manager, index === 97 ? full : `History card ${index}`);
	await refreshFixture(f);
	const opening = f.controller.open(f.key); await historyReady(f); f.tui.start(); f.tui.renderNow();
	const page = async (label: string) => { await historyAction(f, label); f.tui.renderNow(); };
	await page("Earlier history");
	assert.match(plain(f.overlay), /History card 149/);
	assert.match(f.overlay.scroll.render(88).map(stripTerminalSequences).join("\n"), /History card 97/);
	await page("Earlier history");
	assert.match(plain(f.overlay), /History card 49/, "the first physical page remains reachable");
	await page("Later history");
	f.terminal.input("\t"); f.tui.renderNow();
	for (let index = 0; index < 105; index++) { f.terminal.input("\x1b[A"); f.tui.renderNow(); }
	// Two page-heading cards precede card 50; native Down selects card 97.
	for (let index = 0; index < 49; index++) { f.terminal.input("\x1b[B"); f.tui.renderNow(); }
	assistant(manager, "Continuation appended after selection, before detail input");
	f.terminal.input("\x1br");
	await until(() => Boolean(f.controller.visit(f.key).quote), "full selected contextual reply loaded");
	assert.equal(f.controller.visit(f.key).quote!.text, full, "direct Reply quotes the full selected body, not its bounded preview");
	f.terminal.input("\x1bq"); f.terminal.input("\t"); f.tui.renderNow();
	f.terminal.input("\r"); f.tui.renderNow();
	assert.match(await readDetails(f.overlay), /PAGE-97-FULL-END/);
	f.terminal.input("\x1b"); f.tui.renderNow();
	await page("Later history");
	assert.match(plain(f.overlay), /History card 249/);
	await page("Earlier history");
	assert.match(plain(f.overlay), /History card 149/);
	f.terminal.input("\x1bl"); await historyReady(f); f.tui.renderNow();
	assert.match(plain(f.overlay), /History card 249/, "Latest returns to the current final page, not merely its old page's last row");
	assert.doesNotMatch(plain(f.overlay), /History card 149/);
	f.terminal.input("\t"); f.terminal.input("\x1b[H"); f.tui.renderNow();
	assert.equal(f.controller.visit(f.key).anchor?.id, "assignment");
	f.terminal.input("\x1b"); await opening;
	const reopen = f.controller.open(f.key); await historyReady(f); f.tui.renderNow();
	assert.match(plain(f.overlay), /History · 100 of .* · latest/, "synthetic saved anchors still load the latest physical page");
	await page("Later history");
	assert.equal(f.controller.task(f.key)!.page!.entries.length, 100, "Later on the latest page cannot replace it with a forward-past-end page");
	const original = f.controller.historyPage.bind(f.controller);
	let held = false, release!: () => void;
	const delayed = new Promise<void>((resolve) => { release = resolve; });
	t.mock.method(f.controller, "historyPage", async (...args) => {
		const result = await original(...args);
		if (args[1]?.before !== undefined) { held = true; await delayed; }
		return result;
	});
	try {
		const earlier = historyAction(f, "Earlier history");
		await until(() => held, "earlier page is in flight");
		f.terminal.input("\x1bl"); await historyReady(f); f.tui.renderNow();
		assert.match(plain(f.overlay), /History card 249/, "explicit Latest supersedes a pending older-page request");
		release(); await earlier; await turn(); f.tui.renderNow();
		assert.match(plain(f.overlay), /History card 249/, "a late older-page result cannot overwrite Latest");
		assert.doesNotMatch(plain(f.overlay), /History card 149/);
	} finally { release(); t.mock.restoreAll(); }
	f.terminal.input("\x1b"); await reopen;
	assert.equal(f.calls.length, 0);
});

for (const loss of ["missing", "replacement", "truncation"]) test(`native detail requests show ${loss} failures without escaping TUI input or losing drafts`, async (t) => {
	const f = await fixture(t), manager = f.childSessions[0], file = manager.getSessionFile();
	assistant(manager, `Full selected body\n${"detail ".repeat(600)}SELECTED-END`);
	await refreshFixture(f);
	const opening = f.controller.open(f.key);
	f.tui.start(); f.tui.renderNow();
	f.terminal.input("Keep my unsent message");
	f.terminal.input("\t"); f.tui.renderNow();
	if (loss === "missing") fs.unlinkSync(file);
	else if (loss === "replacement") {
		fs.writeFileSync(`${file}.replacement`, fs.readFileSync(file));
		fs.renameSync(`${file}.replacement`, file);
	} else fs.truncateSync(file, fs.readFileSync(file, "utf8").indexOf("\n") + 1);
	assert.doesNotThrow(() => f.terminal.input("\r"), "detail failures cannot escape the native input listener");
	f.tui.renderNow();
	await until(() => plain(f.overlay).includes("Details unavailable"), "selected detail validation reports source loss asynchronously");
	f.terminal.input("\x1br"); f.tui.renderNow();
	assert.equal(f.controller.visit(f.key).quote, undefined, "Reply cannot quote an unavailable-details notice as saved evidence");
	assert.match(plain(f.overlay), /Quoted context unavailable; draft kept/);
	assert.equal(f.overlay.editor.getExpandedText(), "Keep my unsent message");
	assert.equal(f.calls.length, 0);
	f.terminal.input("\x1b"); await opening;
});

for (const nativeAnswer of [false, true]) test(`completed structured-output history opens at the readable report without duplicates (native answer: ${nativeAnswer})`, async (t) => {
	const f = await fixture(t), manager = f.childSessions[0];
	const report = "**The login fix is ready.**\n\n## Verification\n" + Array.from({ length: 120 }, (_, index) => `- Checked behavior ${index + 1}.`).join("\n");
	const submitted = `${report}\n\n\`\`\`acceptance-report\n${JSON.stringify({ criteriaSatisfied: [{ id: "login", status: "satisfied", evidence: "ACCEPTANCE-DETAIL-END" }], noStagedFiles: true })}\n\`\`\``;
	const earlierAnswer = nativeAnswer ? assistant(manager, submitted) : undefined;
	for (let index = 0; index < 140; index++) assistant(manager, `Earlier report activity ${index}`);
	if (nativeAnswer) assistant(manager, submitted);
	manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "final-report", name: "structured_output", arguments: { value: { report: submitted } } }], stopReason: "toolUse", provider: "fixture", model: "fixture", api: "openai-responses", usage, timestamp: Date.now() });
	manager.appendMessage({ role: "toolResult", toolCallId: "final-report", toolName: "structured_output", content: [{ type: "text", text: "Structured output captured." }], details: { stored: true }, isError: false, timestamp: Date.now() });
	if (nativeAnswer) for (let index = 0; index < 140; index++) manager.appendCustomEntry("after-report", { index });
	const original = fs.readFileSync(manager.getSessionFile(), "utf8");
	saveAsyncRunResult(f.run.runId, { runtimeVersion: 2, id: f.run.runId, state: "complete", timestamp: Date.now(), results: [{ agent: "worker", task: f.run.children[0].task!, success: true, exitCode: 0, finalOutput: report, sessionFile: manager.getSessionFile(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 } }] });
	await refreshFixture(f);
	const opening = f.controller.open(), view = f.overlay;
	await historyReady(f);
	const first = plain(view);
	assert.match(first, /The login fix is ready\./, "a long finished report opens at its beginning, not its tail or serialized submission");
	assert.doesNotMatch(first, /criteriaSatisfied|\\n|"value"|"report"/);
	assert.match(view.scroll.render(88).map(stripTerminalSequences).join("\n"), /Checked behavior 120\./, "the selected report retains its full body beyond the indexed preview");
	view.handleInput("\t"); view.handleInput("\x1b[F"); view.render(90);
	view.handleInput("\x1b[A"); view.render(90);
	view.handleInput("\r");
	assert.match(await readDetails(view), /ACCEPTANCE-DETAIL-END/, "the recorded structured payload is still inspectable in full details");
	view.handleInput("\x1br");
	assert.match(f.controller.visit(f.key).quote!.text, /ACCEPTANCE-DETAIL-END/, "replying to the submission retains its actual recorded data");
	view.handleInput("\x1bq");
	view.handleInput("\x1b"); await opening;
	const reopen = f.controller.open();
	f.terminal.rows = 200;
	await historyReady(f);
	assert.match(f.overlay.scroll.render(118).map(stripTerminalSequences).join("\n"), /Checked behavior 120\./, "reopening a saved report anchor retains the full report before Latest is requested");
	f.overlay.handleInput("\x1bl"); await historyReady(f);
	const all = plain(f.overlay, 120);
	assert.equal(all.match(/The login fix is ready\./g)?.length, 1, "Latest keeps one canonical report even when its native answer is outside the current page");
	assert.doesNotMatch(all, /ACCEPTANCE-DETAIL-END|criteriaSatisfied/);
	assert.equal(fs.readFileSync(manager.getSessionFile(), "utf8"), original, "viewing must not rewrite the native history");
	assert.equal(f.calls.length, 0);
	f.overlay.handleInput("\x1b"); await reopen;
	const savedResult = f.controller.savedResult.bind(f.controller);
	let reportHeld = false, releaseReport!: () => void;
	const reportBarrier = new Promise<void>((resolve) => { releaseReport = resolve; });
	t.mock.method(f.controller, "savedResult", async (...args) => {
		const report = await savedResult(...args);
		reportHeld = true;
		await reportBarrier;
		return report;
	});
	t.after(() => releaseReport());
	const reopenLatest = f.controller.open();
	await until(() => reportHeld, "real worker's selected canonical result returned");
	await f.controller.refresh();
	await f.controller.refresh();
	releaseReport();
	await historyReady(f);
	assert.equal(plain(f.overlay, 120).match(/The login fix is ready\./g)?.length, 1, "reopening the saved Latest position keeps the canonical report visible exactly once");
	f.overlay.handleInput("\x1b"); await reopenLatest;
	if (earlierAnswer) {
		f.controller.visit(f.key).anchor = { id: `${earlierAnswer}:0`, line: 0 };
		const reopenEarlier = f.controller.open(); await historyReady(f);
		const olderPage = f.overlay.scroll.render(118).map(stripTerminalSequences).join("\n");
		assert.equal(olderPage.match(/The login fix is ready\./g)?.length, 1, "a page-visible earlier exact answer prevents a duplicate canonical card even when the latest matching answer is off-page");
		assert.match(olderPage, /Checked behavior 120\./, "page-visible matching uses the full canonical answer, not preview equality");
		f.overlay.handleInput("\x1b"); await reopenEarlier;
	}
});

test("native grouped tools retain recorded diffs, full context and old result-entry reading positions", async (t) => {
	const f = await fixture(t), manager = f.childSessions[0];
	for (let index = 0; index < 25; index++) assistant(manager, `Earlier history ${index}`);
	manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "saved-bash", name: "bash", arguments: { command: "printf NATIVE-BASH-RESULT", timeout: 15 } }], stopReason: "toolUse", provider: "fixture", model: "fixture", api: "openai-responses", usage, timestamp: Date.now() });
	const resultId = manager.appendMessage({ role: "toolResult", toolCallId: "saved-bash", toolName: "bash", content: [{ type: "text", text: "NATIVE-BASH-RESULT" }], details: { receipt: "BASH-RAW-DETAIL" }, isError: false, timestamp: Date.now() });
	const file = path.join(f.cwd, "login.ts"); fs.writeFileSync(file, "Today's file is different from this old edit.\n");
	manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "saved-edit", name: "edit", arguments: { path: file, oldText: "before", newText: "after" } }], stopReason: "toolUse", provider: "fixture", model: "fixture", api: "openai-responses", usage, timestamp: Date.now() });
	manager.appendMessage({ role: "toolResult", toolCallId: "saved-edit", toolName: "edit", content: [{ type: "text", text: "Edited login.ts" }], details: { diff: "-before\n+after", receipt: "EDIT-RAW-DETAIL" }, isError: false, timestamp: Date.now() });
	for (let index = 0; index < 25; index++) assistant(manager, `Later history ${index}`);
	await refreshFixture(f);
	const visit = f.controller.visit(f.key);
	visit.readThrough = f.controller.task(f.key)!.history.at(-1)!.id;
	visit.anchor = { id: resultId, line: 0 };
	const opening = f.controller.open(), view = f.overlay;
	await historyReady(f);
	assert.match(plain(view), /\$ printf NATIVE-BASH-RESULT/, "restoring an old standalone result ID opens its grouped native tool card");
	assert.doesNotMatch(plain(view), /"command"|"timeout"|BASH-RAW-DETAIL|Today's file|Could not find/);
	view.handleInput("\t"); view.render(90); view.handleInput("\r");
	assert.match(await readDetails(view), /BASH-RAW-DETAIL/);
	view.handleInput("\x1br");
	assert.match(visit.quote!.text, /printf NATIVE-BASH-RESULT/);
	assert.match(visit.quote!.text, /BASH-RAW-DETAIL/);
	view.handleInput("\x1bq"); view.handleInput("\t"); view.render(90);
	view.handleInput("\x1b[B"); view.render(90); view.handleInput("\r");
	assert.match(await readDetails(view), /-before[\s\S]*\+after/);
	view.handleInput("\x1br");
	assert.match(visit.quote!.text, /EDIT-RAW-DETAIL/);
	assert.match(visit.quote!.text, /-before\n\+after/);
	assert.equal(fs.readFileSync(file, "utf8"), "Today's file is different from this old edit.\n");
	assert.equal(f.calls.length, 0);
	view.handleInput("\x1b"); await opening;
});

test("paired tool details show recorded diff on physical lines before raw metadata", async (t) => {
	const f = await fixture(t, "fullscreen"), manager = f.childSessions[0];
	f.terminal.resize(64, 78);
	const file = path.join(f.cwd, "history-only.ts"), current = "Today's file does not match the old edit.\n";
	fs.writeFileSync(file, current);
	const diff = "--- history-only.ts\n+++ history-only.ts\n@@ -1 +1 @@\n-return before;\n+return after;";
	manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "saved-apply", name: "apply_edits", arguments: { path: file, rewrite: "return after;\n" } }], stopReason: "toolUse", provider: "fixture", model: "fixture", api: "openai-responses", usage, timestamp: Date.now() });
	manager.appendMessage({ role: "toolResult", toolCallId: "saved-apply", toolName: "apply_edits", content: [{ type: "text", text: "Rewrote history-only.ts." }], details: { diff, diffTruncated: false, warnings: ["RECORDED-WARNING"] }, isError: false, timestamp: Date.now() });
	const original = fs.readFileSync(manager.getSessionFile(), "utf8");
	await refreshFixture(f);
	const opening = f.controller.open(); f.tui.start(); f.tui.renderNow();
	const view = f.overlay, width = f.overlayBounds.width;
	assert.doesNotMatch(plain(view, width), /return before|RECORDED-WARNING|"rewrite"/, "ordinary cards stay compact");
	view.handleInput("\t"); view.handleInput("\x1b[F"); view.render(width); view.handleInput("\r"); await readDetails(view, width); view.handleInput("\x1b[H");
	const lines = view.render(width).map(stripTerminalSequences).map((line) => line.trim());
	const removed = lines.indexOf("-return before;"), metadata = lines.indexOf('"call": {');
	assert.ok(removed >= 0, "the recorded removal is a physical diff line, not an escaped JSON substring");
	assert.equal(lines[removed + 1], "+return after;", "the recorded addition follows on its own line");
	assert.ok(metadata > removed + 1, "readable diff appears before raw metadata");
	const full = await readDetails(view, width);
	assert.match(full, /"rewrite"/); assert.match(full, /RECORDED-WARNING/);
	view.handleInput("\x1br");
	assert.ok(f.controller.visit(f.key).quote!.text.startsWith(`${diff}\n\n`));
	assert.match(f.controller.visit(f.key).quote!.text, /"rewrite"[\s\S]*RECORDED-WARNING/);
	assert.equal(fs.readFileSync(file, "utf8"), current); assert.equal(fs.readFileSync(manager.getSessionFile(), "utf8"), original);
	assert.equal(f.calls.length, 0);
	view.handleInput("\x1b"); await opening;
});

test("a newly paired custom-tool result stays unread and supports native expansion without losing raw details", async (t) => {
	const f = await fixture(t, "fullscreen"), manager = f.childSessions[0];
	manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "custom-call", name: "custom_check", arguments: { check: "login", payload: { retained: "RAW-ARGUMENT" } } }], stopReason: "toolUse", provider: "fixture", model: "fixture", api: "openai-responses", usage, timestamp: Date.now() });
	await refreshFixture(f);
	const pending = f.controller.open(); await historyReady(f);
	assert.match(plain(f.overlay), /result not recorded/);
	f.overlay.handleInput("\x1b"); await pending;
	const resultId = manager.appendMessage({ role: "toolResult", toolCallId: "custom-call", toolName: "custom_check", content: [{ type: "text", text: `Checks completed\n${"Checked a behavior\n".repeat(20)}FINAL-TOOL-LINE` }], details: { receipt: "RAW-RESULT" }, isError: false, timestamp: Date.now() });
	await refreshFixture(f);
	assert.equal(f.controller.task(f.key)!.unread, true, "a result is new activity even though it joins an existing tool card");
	const opening = f.controller.open(), view = f.overlay;
	await historyReady(f); f.terminal.rows = 60;
	const collapsed = view.render(90).map(stripTerminalSequences);
	assert.match(collapsed.join("\n"), /Checks completed/);
	assert.doesNotMatch(collapsed.join("\n"), /RAW-ARGUMENT|RAW-RESULT|FINAL-TOOL-LINE/);
	assert.equal(f.controller.visit(f.key).readThrough, resultId, "reading the paired card acknowledges the original result ID");
	const y = collapsed.findIndex((line) => line.includes("custom_check"));
	view.handleMouse({ type: "click", button: "left", x: 4, y, screenX: 4, screenY: y, width: 90, height: collapsed.length, shift: false, alt: false, ctrl: false });
	assert.match(plain(view), /FINAL-TOOL-LINE/, "fullscreen tool clicks expand the native tool output");
	view.handleInput("\x0f"); view.handleInput("\x0f");
	assert.doesNotMatch(plain(view), /FINAL-TOOL-LINE/, "native tool expansion keys can collapse it again");
	view.handleInput("\r");
	const details = await readDetails(view);
	assert.match(details, /RAW-ARGUMENT/); assert.match(details, /RAW-RESULT/); assert.match(details, /FINAL-TOOL-LINE/);
	view.handleInput("\x1br");
	assert.match(f.controller.visit(f.key).quote!.text, /RAW-ARGUMENT[\s\S]*RAW-RESULT/);
	assert.equal(f.calls.length, 0);
	view.handleInput("\x1b"); await opening;
});

test("twenty-task picker is framed, width-aware and searchable by the full assignment", async (t) => {
	const f = await fixture(t, "regular", 20);
	f.terminal.columns = 140; f.terminal.rows = 40;
	const label = "Fix authentication for team memberships across regions";
	for (const child of f.run.children) {
		child.label = child.index === 0 ? label : `Review behavior ${child.index}`;
		saveQuestionContract(f.run.runId, child.index, { task: `Assignment ${child.index}\n${child.index === 19 ? "Distinctive assignment needle" : "Other work"}\nFULL-ASSIGNMENT-END` });
	}
	await refreshFixture(f);
	const opening = f.controller.open(), picker = f.overlay;
	const wide = picker.render(140).map(stripTerminalSequences);
	assert.match(wide[0], /─{20}/, "the picker has a visible themed boundary");
	assert.match(wide.at(-1)!, /─{20}/);
	assert.ok(wide.some((line) => line.includes("→") && line.includes(label)), "the task column uses available width instead of clipping at 30 characters");
	assert.match(wide.join("\n"), /worker/);
	picker.handleInput("Distinctive assignment needle");
	await until(() => !f.controller.listLoading && f.controller.listPage?.total === 1, "full assignment filter loaded");
	const filtered = plain(picker, 140);
	assert.match(filtered, /Review behavior 19/); assert.doesNotMatch(filtered, /Review behavior 18/);
	assert.equal(picker.focused, true, "native filter input owns focus without touching the parent editor");
	f.terminal.columns = 24; f.terminal.rows = 18;
	const narrow = picker.render(24);
	assert.ok(narrow.length <= 18); assert.ok(narrow.every((line) => visibleWidth(line) <= 24));
	picker.handleInput("\r"); await turn();
	assert.equal(f.overlay.key, `${f.run.runId}:19`);
	assert.equal(f.mainEditor.getText(), "Unsent parent draft\nDo not replace this");
	assert.equal(f.calls.length, 0);
	f.overlay.handleInput("\x1b"); await opening;
	f.terminal.columns = 140; f.terminal.rows = 40;
	const reopened = f.controller.open();
	assert.ok(!(f.overlay instanceof AgentConversation), "a retained filter reopens the picker, not an unexplained single result");
	assert.match(plain(f.overlay, 140), /Distinctive assignment needle/);
	assert.doesNotMatch(plain(f.overlay, 140), /Filter agents or assignments/);
	f.overlay.handleInput("\x05"); f.overlay.handleInput("\x15");
	await until(() => !f.controller.listPending && f.controller.tasks.length === 20, "clearing the visible retained filter restores other agents");
	assert.match(plain(f.overlay, 140), /Review behavior 18/);
	f.overlay.handleInput("\x1b"); await reopened;
});

for (const mode of ["regular", "fullscreen"] as const) test(`settled idle Agents dock stays hidden throughout delayed background refresh (${mode})`, async (t) => {
	const f = await fixture(t, mode);
	await f.complete(); f.tui.start(); f.tui.renderNow();
	assert.equal(plain(f.strip), "");
	const index = await runHistoryIndex(f.state), original = index.listRuns.bind(index);
	let release!: () => void, entered!: () => void;
	const held = new Promise<void>((resolve) => { release = resolve; });
	const requested = new Promise<void>((resolve) => { entered = resolve; });
	t.mock.method(index, "listRuns", async (...args) => { entered(); await held; return original(...args); });
	const refresh = f.controller.refresh();
	await requested;
	try {
		for (const width of [110, 56, 24]) {
			f.terminal.resize(width, 38); f.tui.renderNow();
			assert.deepEqual(f.strip.render(width), [], "an in-flight background observation must not add a loading row or move the editor");
		}
	} finally { release(); await refresh; }
	assert.equal(plain(f.strip), "");
});

test("active Agents rows distinguish running, queued and needs-action work, then disappear after completion", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: new Date("2030-01-01T00:00:00Z") });
	const f = await fixture(t, "fullscreen", 4);
	for (const [index, label] of ["Fix login", "Queued docs", "Approve change", "Finished report"].entries()) f.run.children[index].label = label;
	for (const index of [1, 2, 3]) f.status.steps[index].status = "pending";
	saveRunStatus(f.run.runId, f.status);
	const { resolveEffectiveAcceptance } = await import("../../src/runs/shared/acceptance.ts");
	const effectiveAcceptance = resolveEffectiveAcceptance({ explicit: { criteria: ["Confirm the user action"] } })!;
	const result = { agent: "worker", task: "Saved assignment", exitCode: 0, finalOutput: "Saved report", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 } };
	saveQuestionContract(f.run.runId, 2, { result: { ...result, acceptance: { status: "blocked", explicit: true, effectiveAcceptance, criteria: effectiveAcceptance.criteria, runtimeChecks: [], verifyRuns: [], childReport: { criteriaSatisfied: [{ id: "criterion-1", status: "blocked", evidence: "The approval control requires a person.", humanAction: "Confirm the approval control." }] } } } });
	saveQuestionContract(f.run.runId, 3, { result });
	f.controller.visit(`${f.run.runId}:3`).readThrough = null;
	await refreshFixture(f);
	const raw = f.strip.render(90), rows = raw.map(stripTerminalSequences);
	assert.match(rows[0], /1 running/);
	for (const label of ["Fix login", "Queued docs", "Approve change"]) assert.equal(rows.filter((line) => line.includes(label)).length, 1);
	assert.notEqual(rows.findIndex((line) => line.includes("Fix login")), rows.findIndex((line) => line.includes("Queued docs")), "agents have distinct compact rows");
	assert.match(rows.join("\n"), /queued|waiting to start/); assert.match(rows.join("\n"), /needs.*action|action required/);
	assert.doesNotMatch(rows.join("\n"), /Finished report|done.*new/);
	const codes = (label: string) => raw[rows.findIndex((line) => line.includes(label))].match(/\x1b\[[\d;]+m/g);
	assert.ok(codes("Fix login")?.length); assert.notDeepEqual(codes("Fix login"), codes("Approve change"), "native status colors distinguish work from needs-action states");
	assert.ok(f.strip.render(24).every((line) => visibleWidth(line) <= 24));
	t.mock.timers.tick(3000);
	const attentionRow = rows.findIndex((line) => line.includes("Approve change"));
	assert.equal(f.strip.render(90)[attentionRow], raw[attentionRow], "needs-action indicator and text stay steady across the pulse");
	const messageId = randomUUID(), visit = f.controller.visit(f.key);
	visit.lastSentId = messageId;
	visit.readThrough = f.childSessions[0].appendCustomMessageEntry("subagent-human-message", "Please check the API", true, { bodyText: "Please check the API", message: { id: messageId } });
	assistant(f.childSessions[0], "The API is unchanged.");
	await refreshFixture(f);
	assert.match(plain(f.strip).split("\n").find((line) => line.includes("Fix login"))!, /replied/, "an actual child response retains its existing distinction from other unread activity");
	f.controller.pin(f.key); f.controller.visit(f.key).draft = "Retained private draft";
	await f.complete();
	assert.equal(plain(f.strip), "", "no Agents area, results badge, completed row or finished pin remains when all work finishes");
	f.controller.start(f.ctx);
	await refreshFixture(f);
	assert.equal(plain(f.strip), ""); assert.equal(f.controller.pinned, f.key); assert.equal(f.controller.visit(f.key).draft, "Retained private draft");
	assert.equal(f.controller.task(`${f.run.runId}:3`)!.unread, true, "hiding the area does not discard unread completed history");
	const opening = f.commands.get("agents").handler("", f.ctx);
	assert.ok(f.tui.hasOverlay(), "/agents still opens saved completed conversations");
	f.overlay.handleInput("\x1b"); await opening;
	assert.equal(f.calls.length, 0);
});

for (const [children, columns, rows] of [[1, 90, 28], [2, 90, 28], [2, 24, 18]]) test(`native entrance pointer toggles the same spot for ${children === 1 ? "a conversation" : "the picker and a conversation"} (${columns}×${rows})`, async (t) => {
	const f = await fixture(t, "fullscreen", children);
	f.terminal.resize(columns, rows);
	for (let index = 0; index < 25; index++) assistant(f.childSessions[0], `Prior history ${index}\n${"Readable earlier detail. ".repeat(6)}`);
	await refreshFixture(f); f.tui.start(); f.tui.renderNow();
	const width = f.terminal.columns;
	// The native fixed dock contains this widget, the four-row parent draft, and a one-row footer.
	const y = f.terminal.rows - f.strip.render(width).length - f.mainEditor.render(width).length - 1, x = 5;
	f.terminal.click(x, y); await turn(); f.tui.renderNow();
	assert.equal(f.tui.hasOverlay(), true, "native SGR input opens the view");
	const openingBounds = f.overlayBounds;
	assert.ok(f.overlay.render(openingBounds.width).length <= openingBounds.height, "the picker keeps its controls within the available native rectangle");
	f.terminal.click(x, y); await turn(); f.tui.renderNow();
	assert.equal(f.tui.hasOverlay(), false, "the same real pointer coordinate closes it");
	assert.ok(openingBounds.row + openingBounds.height <= y, "the original entrance stays outside the modal pointer rectangle");
	f.terminal.click(x, y); await turn(); f.tui.renderNow();
	if (children > 1) { f.terminal.input("\r"); await turn(); f.tui.renderNow(); }
	assert.ok(f.overlay instanceof AgentConversation);
	const draft = "DRAFT-ONE\nDRAFT-TWO\nDRAFT-THREE\nDRAFT-FOUR\nDRAFT-FIVE";
	f.terminal.input(`\x1b[200~${draft}\x1b[201~`); f.tui.renderNow();
	const rendered = f.overlay.render(f.overlayBounds.width);
	assert.ok(rendered.length <= f.overlayBounds.height, "a multiline draft cannot clip its native editor or controls");
	assert.ok(rendered.some((line) => line.includes(CURSOR_MARKER)), "the native editor cursor remains visible in a short view");
	const lastLine = rendered.map(stripTerminalSequences).findIndex((line) => line.includes("DRAFT-FIVE"));
	assert.ok(lastLine >= 0);
	f.terminal.click(f.overlayBounds.col + 1, f.overlayBounds.row + lastLine); f.terminal.input("!"); f.tui.renderNow();
	assert.equal(f.controller.visit(f.key).draft, draft.replace("DRAFT-FIVE", "!DRAFT-FIVE"), "native mouse placement follows the clipped editor offset");
	for (let index = 0; index < 4; index++) f.terminal.input("\x1b[A");
	f.tui.renderNow();
	assert.match(plain(f.overlay, f.overlayBounds.width), /DRAFT-ONE/, "moving the native cursor up reveals earlier draft lines");
	f.terminal.input("\x1b[5~"); f.tui.renderNow();
	const anchor = f.controller.visit(f.key).anchor;
	f.terminal.click(x, y); await turn();
	assert.equal(f.tui.hasOverlay(), false);
	assert.equal(f.controller.visit(f.key).draft, draft.replace("DRAFT-FIVE", "!DRAFT-FIVE"));
	assert.deepEqual(f.controller.visit(f.key).anchor, anchor);
	assert.equal(f.mainEditor.getText(), "Unsent parent draft\nDo not replace this");
	f.tui.renderNow();
	f.terminal.click(x, y + 1); await turn(); f.tui.renderNow();
	assert.equal(f.overlay.key, f.key, "the individual task row opens its exact conversation");
	f.terminal.click(x, y + 1); await turn(); f.tui.renderNow();
	assert.equal(f.tui.hasOverlay(), false, "clicking the same task row closes its conversation too");
	assert.deepEqual(f.interrupts, Array(children).fill(0)); assert.equal(f.calls.length, 0);
});

test("short native conversation keeps reply, pending-send notice, draft and actions visible after pinning", async (t) => {
	const f = await fixture(t, "fullscreen", 4), draft = "Please keep the API unchanged.", deliveries = [];
	f.terminal.resize(24, 18);
	const opening = f.controller.open(f.key);
	f.tui.start(); f.tui.renderNow();
	f.pi.events.on("subagent:live-intercom", (payload) => {
		deliveries.push(payload);
		f.pi.events.emit("subagent:live-intercom-delivery", { requestId: payload.requestId, accepted: true, delivered: true, messageId: payload.messageId });
	});
	f.terminal.input(draft); f.terminal.input("\x1br");
	await until(() => Boolean(f.controller.visit(f.key).quote), "full quoted context loaded"); f.tui.renderNow();
	f.terminal.input("\r"); await turn();
	f.terminal.input("\r"); await turn();
	f.terminal.input("\x1bp"); f.tui.renderNow();
	const visit = f.controller.visit(f.key), quote = structuredClone(visit.quote), notice = visit.notice;
	assert.equal(deliveries.length, 1, "duplicate Enter cannot resend the accepted message");
	assert.equal(deliveries[0].human.index, 0);
	assert.equal(quote?.text, "I found the relevant code.");
	assert.match(notice!, /already waiting/);
	assert.equal(f.controller.pinned, f.key);
	const frame = () => {
		f.tui.renderNow();
		const bounds = f.overlayBounds, raw = f.overlay.render(bounds.width), lines = raw.map(stripTerminalSequences);
		assert.ok(raw.length <= bounds.height, `required rows must fit the native rectangle: ${raw.length} > ${bounds.height}`);
		assert.ok(raw.every((line) => visibleWidth(line) <= bounds.width));
		return { bounds, raw, lines };
	};
	const initial = frame();
	t.diagnostic(JSON.stringify({ bounds: initial.bounds, renderedRows: initial.raw.length, cursorRow: initial.raw.findIndex((line) => line.includes(CURSOR_MARKER)), controlsRow: initial.lines.findIndex((line) => line.includes("F2")) }));
	assert.match(initial.lines.join("\n"), /Quote/); assert.match(initial.lines.join("\n"), /This message/);
	assert.ok(initial.raw.some((line) => line.includes(CURSOR_MARKER)), "the draft caret is inside the visible native rectangle");
	assert.match(initial.lines.join("\n"), /F2/);
	f.terminal.input("\x1bOQ");
	assert.match(frame().lines.join("\n"), /Reply/);
	f.terminal.input("\x1b[B");
	assert.match(frame().lines.join("\n"), /Full details/);
	f.terminal.input("\x1b");
	const composed = frame(), cursorRow = composed.raw.findIndex((line) => line.includes(CURSOR_MARKER));
	assert.ok(cursorRow >= 0);
	f.terminal.click(composed.bounds.col + 1, composed.bounds.row + cursorRow); f.terminal.input("!");
	assert.equal(visit.draft, draft.replace("API unchanged.", "!API unchanged."), "mouse placement follows the clipped native editor row");
	f.terminal.input("\x1b[A"); assert.match(frame().lines.join("\n"), /Please keep/);
	f.terminal.input("\x1b[5~"); frame();
	const anchor = structuredClone(visit.anchor), savedDraft = visit.draft;
	const y = f.terminal.rows - f.strip.render(f.terminal.columns).length - f.mainEditor.render(f.terminal.columns).length - 1;
	assert.ok(f.overlayBounds.row + f.overlayBounds.height <= y, "the entrance stays outside the modal rectangle");
	f.terminal.click(5, y); await opening;
	assert.equal(f.tui.hasOverlay(), false);
	f.terminal.click(5, y + 1); await turn(); frame();
	assert.equal(f.overlay.key, f.key); assert.equal(f.overlay.editor.getText(), savedDraft);
	assert.deepEqual(visit.quote, quote); assert.equal(visit.notice, notice); assert.deepEqual(visit.anchor, anchor);
	f.terminal.click(5, y + 1); await turn();
	assert.equal(f.tui.hasOverlay(), false, "the same task point closes the fully composed view");
	assert.equal(f.mainEditor.getText(), "Unsent parent draft\nDo not replace this");
	assert.equal(deliveries.length, 1); assert.equal(f.calls.length, 0); assert.deepEqual(f.interrupts, [0, 0, 0, 0]);
});

test("configured Agents shortcut registration, hint and native overlay closing use one setting", async (t) => {
	const configPath = path.join(process.env.PI_CODING_AGENT_DIR!, "intercom", "config.json");
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	const previous = fs.existsSync(configPath) ? fs.readFileSync(configPath) : undefined;
	fs.writeFileSync(configPath, JSON.stringify({ shortcut: "ctrl+shift+k" }));
	t.after(() => { if (previous) fs.writeFileSync(configPath, previous); else fs.rmSync(configPath); });
	const f = await fixture(t, "fullscreen", 2);
	const { createExtensionRuntime } = await import("@earendil-works/pi-coding-agent");
	const { loadExtensionFromFactory } = await import(new URL("./core/extensions/loader.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
	const { default: registerIntercom } = await import("../../src/pi-intercom/index.ts");
	const runtime = createExtensionRuntime(); t.after(() => runtime.invalidate());
	const extension = await loadExtensionFromFactory(registerIntercom, f.cwd, f.pi.events, runtime);
	const shortcut = extension.shortcuts.get("ctrl+shift+k");
	assert.ok(shortcut); assert.equal(extension.shortcuts.has("alt+m"), false);
	assert.match(plain(f.strip), /ctrl\+shift\+k/i);
	f.tui.start();
	await shortcut.handler(f.ctx); await turn(); f.tui.renderNow();
	assert.ok(f.tui.hasOverlay());
	f.terminal.input("\x1b[107;6u"); await turn();
	assert.equal(f.tui.hasOverlay(), false, "configured chord closes the picker through focused native input");
	await shortcut.handler(f.ctx); await turn(); f.tui.renderNow();
	f.terminal.input("\r"); await turn(); f.tui.renderNow();
	assert.ok(f.overlay instanceof AgentConversation);
	f.terminal.input("Saved draft");
	f.terminal.input("\x1b[107;6u"); await turn();
	assert.equal(f.tui.hasOverlay(), false);
	assert.equal(f.controller.visit(f.key).draft, "Saved draft");
	assert.equal(f.calls.length, 0); assert.equal(f.mainEditor.getText(), "Unsent parent draft\nDo not replace this");
});

for (const surface of ["widget", "picker"]) test(`64-column ${surface} keeps task identity, full state and unread badges ahead of activity`, async (t) => {
	const f = await fixture(t, "fullscreen", 2);
	f.terminal.resize(64, 78);
	f.run.children[0].label = "Build native Agents experience";
	f.run.children[1].label = "Review current UX changes and preserve every public interface";
	f.run.children[1].agent = "reviewer"; f.status.steps[1].agent = "reviewer";
	f.status.steps = f.run.children.map((child) => ({ index: child.index, agent: child.agent, task: child.task!, status: "running" as const, recentTools: [], recentOutput: [], toolCount: 0, tokens: { input: 0, output: 0, total: 0 }, durationMs: 1,
		...(child.index === 0 ? { currentTool: "bash", currentToolArgs: "export VERY_VERBOSE_COMMAND_PREVIEW=the_command_must_not_replace_task_identity; printf finished" } : {}) }));
	saveRunStatus(f.run.runId, f.status);
	for (const child of f.run.children) f.controller.visit(`${f.run.runId}:${child.index}`).readThrough = null;
	await refreshFixture(f); f.tui.start();
	const opening = surface === "picker" ? f.controller.open() : undefined;
	f.tui.renderNow();
	const component = surface === "picker" ? f.overlay : f.strip, width = surface === "picker" ? f.overlayBounds.width : 64;
	const rows = component.render(width).map(stripTerminalSequences);
	const writer = rows.find((line) => line.includes("Build")) ?? "", reviewer = rows.find((line) => line.includes("Review current")) ?? "";
	assert.match(writer, /Build native Agents experience/); assert.match(writer, surface === "picker" ? /working · new/ : /· new/);
	assert.match(reviewer, /Review current UX changes/); assert.match(reviewer, surface === "picker" ? /working · new/ : /· new/);
	if (surface === "widget") assert.doesNotMatch(writer + reviewer, /working/);
	assert.doesNotMatch(writer, /export|VERY_VERBOSE/);
	if (surface === "picker") {
		assert.match(writer, /worker/); assert.match(reviewer, /reviewer/);
		assert.match(plain(component, width), /bash export/, "selected preview retains activity detail");
		f.status.steps[0].currentToolArgs = "export UPDATED_ACTIVITY_PROOF=1";
		saveRunStatus(f.run.runId, f.status);
		await refreshFixture(f); f.tui.renderNow();
		assert.match(plain(component, width), /UPDATED_ACTIVITY_PROOF/, "selected activity stays fresh when state and badge have not changed");
	} else assert.match(rows[0], /2 running/);
	const messageId = randomUUID(), visit = f.controller.visit(f.key);
	visit.lastSentId = messageId;
	visit.readThrough = f.childSessions[0].appendCustomMessageEntry("subagent-human-message", "Keep the API", true, { bodyText: "Keep the API", message: { id: messageId } });
	assistant(f.childSessions[0], "The API is preserved."); await refreshFixture(f); f.tui.renderNow();
	const repliedRows = component.render(width).map(stripTerminalSequences);
	assert.match(repliedRows.find((line) => line.includes("Build")) ?? "", surface === "picker" ? /Build native Agents[\s\S]*working · replied/ : /Build native Agents[\s\S]*· replied/);
	assert.match(repliedRows.find((line) => line.includes("Review current")) ?? "", surface === "picker" ? /Review current UX[\s\S]*working · new/ : /Review current UX[\s\S]*· new/);
	assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
	if (opening) { f.overlay.handleInput("\x1b"); await opening; }
	const conversation = f.controller.open(f.key); f.tui.renderNow();
	assert.match(plain(f.overlay, f.overlayBounds.width), /bash export/, "conversation retains activity detail");
	f.overlay.handleInput("\x1b"); await conversation;
	assert.equal(f.calls.length, 0); assert.deepEqual(f.interrupts, [0, 0]);
});

test("native delivery clears an obsolete saved duplicate notice after reload, not unrelated notices", async (t) => {
	const f = await fixture(t), messageId = randomUUID();
	f.childSessions[0].appendCustomMessageEntry("subagent-human-message", "Delivered direction", true, { bodyText: "Delivered direction", message: { id: messageId } });
	for (const [notice, expected] of [["This message is already waiting for the child. You can keep working or write a different message.", undefined], ["Changes unavailable: repository could not be read", "Changes unavailable: repository could not be read"]]) {
		f.controller.dispose();
		f.parent.appendCustomEntry("subagent-view", { ownerSessionId: f.parent.getSessionId(), visits: [[f.key, { draft: "", outbox: [], lastSentId: messageId, notice }]] });
		f.controller.start(f.ctx);
		await refreshFixture(f);
		assert.equal(f.controller.visit(f.key).notice, expected);
	}
});

test("completion during compose keeps the draft, and viewing a finished child never continues it", async (t) => {
	const f = await fixture(t);
	const opening = f.controller.open(); const view = f.overlay;
	view.handleInput("Follow up after completion"); await f.complete();
	view.handleInput("\r"); await turn();
	assert.equal(f.calls.length, 0);
	assert.equal(view.editor.getExpandedText(), "Follow up after completion");
	assert.ok(plain(view).includes(`${altLabel}+C Continue`));
	view.handleInput("\x1b"); await opening;
	const reopening = f.controller.open();
	assert.equal(f.calls.length, 0);
	assert.equal(f.overlay.editor.getExpandedText(), "Follow up after completion");
	f.overlay.handleInput("\x1bc"); await turn();
	assert.equal(f.calls.length, 0, "legacy configuration is explicitly unavailable, not silently guessed");
	assert.match(f.controller.visit(f.key).notice!, /older run has no saved profile/);
	f.overlay.handleInput("\x1b"); await reopening;
});

test("a first foreground launch updates the strip without a manual open", async (t) => {
	const f = await fixture(t), mock = createMockPi(); mock.install();
	f.state.ownedRuns!.clear(); await refreshFixture(f);
	const release = path.join(f.cwd, "first-launch-release");
	mock.onCall({ waitForFile: release, output: "Fresh foreground completed" });
	const pending = f.executor.execute("first-launch", { agent: "worker", task: "A first foreground task", label: "Fresh foreground", async: false, artifacts: false, output: false }, undefined, undefined, f.ctx);
	t.after(async () => { fs.writeFileSync(release, "released"); await pending; mock.uninstall(); });
	await until(() => mock.callCount() === 1 && f.controller.tasks[0]?.child.activity?.status === "running", "the real child starts and the strip observes it without a manual refresh");
	assert.match(plain(f.strip), /1 running[\s\S]*● Fresh foreground/);
	assert.equal(f.controller.tasks[0]?.child.state, "live");
	assert.equal(f.tui.hasOverlay(), false);
	fs.writeFileSync(release, "released");
	const result = await pending;
	assert.equal(result.isError, undefined);
	assert.match(result.content[0].text, /Fresh foreground completed/);
});

test("new async chain preserves its launch identity, draft and pin through first status persistence", async (t) => {
	const f = await fixture(t), mock = createMockPi(); mock.install();
	f.state.ownedRuns!.clear(); await refreshFixture(f);
	const release = path.join(f.cwd, "startup-release"), draft = "Keep the existing public API";
	const startup = path.join(f.cwd, "launcher-release"), spawn = childProcess.spawn;
	t.mock.method(childProcess, "spawn", function(command, args, options) {
		if (!/subagent-runner-launcher\.(?:ts|js)$/.test(args[0] ?? "")) return spawn(command, args, options);
		return spawn(command, ["--import", fileURLToPath(new URL("../fixtures/hold-runner-startup.mjs", import.meta.url)), ...args], {
			...options, env: { ...process.env, PI_TEST_STARTUP_RELEASE: startup },
		});
	});
	syncBuiltinESMExports();
	t.after(() => { fs.writeFileSync(startup, "released"); t.mock.restoreAll(); syncBuiltinESMExports(); });
	mock.onCall({ matchArgsIncludes: "Fix login with original assignment", waitForFile: release, output: "Fixed" });
	let initial, opening, runId: string | undefined;
	f.state.onRunsChanged = () => { void f.controller.refresh(true); };
	const deliveries = [];
	f.pi.events.on("subagent:live-intercom", (payload) => { deliveries.push(payload); f.pi.events.emit("subagent:live-intercom-delivery", { requestId: payload.requestId, accepted: true, delivered: true, messageId: payload.messageId }); });
	const pending = f.executor.execute("startup-view", { chain: [{ agent: "worker", task: "Fix login with original assignment", label: "Fix login", output: false }], async: true, artifacts: false }, undefined, undefined, f.ctx);
	t.after(async () => {
		fs.writeFileSync(startup, "released"); fs.writeFileSync(release, "released"); await pending;
		if (runId) await until(() => fs.existsSync(path.join(getRunMetadataDir(runId!), "result.json")), "startup runner cleanup");
		if (process.env.PI_AGENT_VIEW_EVIDENCE_DIR) fs.cpSync(mock.dir, path.join(f.cwd, "mock-receipts"), { recursive: true });
		mock.uninstall();
	});
	const launched = await pending; assert.ok(!launched.isError); runId = launched.details.asyncId;
	await until(() => fs.existsSync(`${startup}.held`), "native launcher is held before status persistence");
	await refreshFixture(f);
	const task = f.controller.tasks.find((task) => task.run.runId === runId)!;
	assert.ok(task, "pre-status owned launch is observable before native runner starts");
	initial = { key: task.key, label: task.label, task: task.child.task,
		statusExists: fs.existsSync(path.join(ASYNC_DIR, task.run.runId, "status.json")) || fs.existsSync(path.join(getRunMetadataDir(task.run.runId), "status.json")) };
	opening = f.controller.open(task.key);
	f.overlay.handleInput(draft); f.overlay.handleInput("\x1bp");
	fs.writeFileSync(startup, "released");
	await until(() => mock.callCount() === 1, "the real runner persists status and starts the assigned child");
	await refreshFixture(f);
	assert.equal(initial.statusExists, false, "the initial view is captured before either status record exists");
	assert.equal(initial.key, `${runId}:step-0`, "the new launch's authoritative assignment identity must survive the pre-status window");
	assert.equal(initial.label, "Fix login"); assert.equal(initial.task, "Fix login with original assignment");
	assert.deepEqual(f.controller.tasks.map((task) => task.key), [initial.key], "first status must not strand an early draft on an unavailable duplicate");
	assert.equal(f.controller.pinned, initial.key);
	assert.equal(f.controller.visit(initial.key).draft, draft); assert.equal(f.overlay.editor.getText(), draft);
	assert.match(plain(f.overlay), /Agents › Fix login/); assert.doesNotMatch(plain(f.overlay), /Assignment unavailable/);
	await f.controller.send(initial.key, f.overlay.editor.getText());
	assert.equal(deliveries.length, 1);
	assert.equal(deliveries[0].to, `subagent-worker-${runId}-1`);
	assert.equal(deliveries[0].human.runId, runId); assert.equal(deliveries[0].human.index, 0);
	f.overlay.handleInput("\x1b"); await opening;
});

test("the first native streaming response is readable before its final assistant message is saved", async (t) => {
	const f = await fixture(t), native = nativeChild(f.cwd, "streaming"), { release } = native;
	f.state.ownedRuns!.clear(); await refreshFixture(f);
	const requested = "requested/vendor/streaming:high";
	const pending = f.executor.execute("initial-stream", { agent: "worker", model: requested, task: "Read initial streaming output", async: false, artifacts: false, output: false }, undefined, undefined, f.ctx);
	t.after(async () => { fs.writeFileSync(release, "released"); await pending; native.restore(); });
	const deadline = Date.now() + 10_000;
	while (!f.controller.tasks.some((task) => task.child.activity?.streamingText?.includes("First live text"))) { assert.ok(Date.now() < deadline, "initial native text must arrive"); await delay(10); }
	const task = f.controller.tasks[0]!;
	if (fs.existsSync(task.child.sessionFile!)) {
		const entries = SessionManager.open(task.child.sessionFile!).getEntries();
		assert.equal(entries.some((entry) => entry.type === "message" && entry.message.role === "assistant"), false,
			"early native metadata persistence is not a completed assistant response");
	}
	assert.match(plain(f.strip, 160), fs.existsSync(task.child.sessionFile!)
		? /feedback-fixture\/faux-1 · thinking off/
		: /selected: requested\/vendor\/streaming · thinking high/,
		"early native model metadata supersedes requested display without inventing an assistant completion");
	const receipt = JSON.parse(fs.readFileSync(`${release}.json`, "utf8"));
	assert.equal(receipt.events.some((event) => event.type === "message_end" && event.role === "assistant"), false);
	const opening = f.controller.open(task.key); await historyReady(f);
	assert.match(plain(f.overlay), /First live text/);
	assert.doesNotMatch(plain(f.overlay), /Conversation unavailable|Saved conversation unavailable|ENOENT/);
	f.overlay.handleInput("Draft for after the first response");
	f.overlay.handleInput("\x1bp");
	f.overlay.handleInput("\x1b"); await opening;
	fs.writeFileSync(release, "released");
	await pending;
	const completed = SessionManager.open(task.child.sessionFile!);
	for (let index = 0; index < 30; index++) assistant(completed, `Later response ${index}\n${"Later detail ".repeat(15)}`);
	f.controller.start(f.ctx);
	await refreshFixture(f);
	assert.equal(f.controller.task(task.key)!.unavailable, undefined);
	assert.match(f.controller.task(task.key)!.model.summary, /^saved: feedback-fixture\/faux-1\b/, "native saved choices replace requested display without rereading a later continuation");
	assert.equal((await pending).details.results[0].model, requested, "display must not change the candidate-first execution result");
	assert.equal(f.controller.task(task.key)!.unread, true, "visiting before native message_end must retain the before-first-saved-entry boundary after completion and reload");
	assert.equal(plain(f.strip), "", "completed unread history and a saved pin do not keep the active area visible");
	assert.equal(f.controller.pinned, task.key);
	const reopen = f.controller.open(task.key); await historyReady(f);
	assert.match(plain(f.overlay), /Second live text block continues before message end\./, "reopening must show the first finished reply, not the tail of later history");
	assert.equal(f.overlay.editor.getText(), "Draft for after the first response");
	f.overlay.handleInput("\x1b"); await reopen;
	fs.renameSync(task.child.sessionFile!, `${task.child.sessionFile}.removed`); await refreshFixture(f);
	assert.match(f.controller.tasks[0]!.unavailable!, /Saved conversation unavailable/, "a missing completed history remains an honest error");
});

test("explicit Continue uses the saved launch and follows the active successor without a duplicate runtime", async (t) => {
	const f = await fixture(t), native = nativeChild(f.cwd, "tool"), agent = makeAgent("worker", { model: "feedback-fixture/faux-1", completionGuard: false, output: false, extensions: [] });
	saveQuestionContract(f.run.runId, 0, { launch: { agent, systemPrompt: "Saved effective instructions", skills: [], model: agent.model, modelCandidates: [agent.model], cwd: f.cwd, context: "fresh", artifacts: false, output: false, outputMode: "inline", share: false } });
	await f.complete();
	const opening = f.controller.open(f.key), view = f.overlay;
	view.handleInput("Continue after my check"); view.handleInput("\r"); await turn();
	assert.equal(f.calls.length, 0); assert.equal(view.editor.getText(), "Continue after my check");
	view.handleInput("\x1bc");
	await until(() => !f.controller.isBusy(f.key), "explicit continuation receipt");
	const successor = f.controller.task(f.key)!;
	assert.notEqual(successor.run.runId, f.run.runId);
	t.after(async () => { fs.writeFileSync(native.release, "released"); await until(() => fs.existsSync(path.join(getRunMetadataDir(successor.run.runId), "result.json")), "continuation cleanup"); native.restore(); });
	await until(() => fs.existsSync(`${native.release}.json`) && JSON.parse(fs.readFileSync(`${native.release}.json`, "utf8")).events.some((event) => event.type === "tool_execution_start"), "native continuation must run");
	await refreshFixture(f);
	assert.equal(f.controller.task(f.key)!.child.sessionFile, f.run.children[0].sessionFile);
	assert.equal(ownedRunView(f.state.ownedRuns!.get(successor.run.runId)!, f.state).children[0]!.launch!.systemPrompt, "Saved effective instructions");
	assert.equal(view.editor.getText(), "");
	const direction = f.controller.task(f.key)!.history.find((item) => item.kind === "user" && item.text.includes("direct user follow-up"))!;
	assert.match((await direction.load!()).text, /direct user follow-up \(human origin\)[\s\S]*Continue after my check/);
	const deliveries = [];
	f.pi.events.on("subagent:live-intercom", (payload) => { deliveries.push(payload); f.pi.events.emit("subagent:live-intercom-delivery", { requestId: payload.requestId, delivered: true, accepted: true, messageId: payload.messageId }); });
	view.handleInput("More direction to the active continuation"); view.handleInput("\x1bc"); await turn();
	assert.equal(deliveries.length, 1);
	assert.equal(deliveries[0].human.runId, successor.run.runId);
	assert.ok(deliveries[0].to.includes(successor.run.runId));
	assert.equal(f.calls.filter((call) => call.action === "resume").length, 1);
	assert.equal(f.state.ownedRuns!.size, 2);
	fs.writeFileSync(native.release, "released");
	await until(() => fs.existsSync(path.join(getRunMetadataDir(successor.run.runId), "result.json")), "saved continuation result");
	await refreshFixture(f);
	assert.equal(f.controller.task(f.key)!.child.state, "completed");
	assert.match(f.controller.task(f.key)!.history.at(-1)!.text, /Synthetic child finished normally/);
	view.handleInput("\x1b"); await opening;
});

test("answering in the view releases the real native durable question with human provenance", async (t) => {
	const f = await fixture(t), native = nativeChild(f.cwd, "question");
	f.state.ownedRuns!.clear(); await refreshFixture(f);
	const pending = f.executor.execute("question", { agent: "worker", task: "Ask for the required choice", async: false, artifacts: false, output: false }, undefined, undefined, f.ctx);
	t.after(async () => { await pending; native.restore(); });
	await until(() => { f.controller.refresh(true); return Boolean(f.controller.tasks[0]?.question); }, "real native durable question");
	const task = f.controller.tasks[0]!, question = task.question!, opening = f.controller.open(task.key), view = f.overlay;
	assert.match(plain(view), /Waiting for your answer/);
	assert.match(plain(view), /Which synthetic path/);
	view.handleInput("Use the first path"); view.handleInput("\r");
	await until(() => !f.controller.isBusy(task.key), "durable answer saved");
	assert.equal(readQuestionState(question).answer?.origin, "human");
	assert.equal(readQuestionState(question).answer?.message, "Use the first path");
	assert.equal(f.calls[0].action, "answer");
	assert.equal(f.calls[0].questionId, question.questionId);
	await pending;
	await until(() => readQuestionState(question).delivery?.kind === "live", "native child consumes the saved answer");
	await refreshFixture(f);
	assert.equal(readQuestionState(question).delivery?.kind, "live");
	assert.equal(f.state.ownedRuns!.size, 1, "answering a live question starts no continuation");
	assert.match(f.controller.task(task.key)!.history.map((item) => item.text).join("\n"), /Direct user answer \(human origin\)[\s\S]*Use the first path/);
	assert.equal(f.sent.length, 1); assert.match(f.sent[0].message.content, /Use the first path/);
	view.handleInput("\x1b"); await opening;
});

test("foreground chain parallel updates retain both live children's unfinished text", async (t) => {
	const f = await fixture(t), native = nativeChild(f.cwd, "streaming");
	f.state.ownedRuns!.clear(); await refreshFixture(f);
	const seen = new Set<number>();
	const pending = f.executor.execute("parallel-stream", { chain: [{ parallel: [{ agent: "worker", task: "A streaming", output: false }, { agent: "worker", task: "B streaming", output: false }] }], async: false, artifacts: false }, undefined, (update) => {
		for (const progress of update.details.progress ?? []) if (progress.streamingText?.includes("Second live text")) seen.add(progress.index);
	}, f.ctx);
	t.after(async () => { fs.writeFileSync(native.release, "released"); await pending; native.restore(); });
	await until(() => seen.size === 2, "both native children streamed before message_end");
	await refreshFixture(f);
	const observation = f.controller.tasks.map((task) => ({ index: task.child.index, state: task.child.state, text: task.child.activity?.streamingText }));
	assert.deepEqual(observation.map((child) => child.index), [0, 1]);
	assert.deepEqual(observation.map((child) => child.state), ["live", "live"]);
	for (const child of observation) assert.match(child.text ?? "", /Second live text/, `child ${child.index} retains its unfinished response when a sibling updates`);
	fs.writeFileSync(native.release, "released"); await pending;
});

for (const background of [false, true]) test(`${background ? "background" : "foreground"} queued child is waiting to start, keeps its draft, and cannot create duplicate continuation`, async (t) => {
	const f = await fixture(t), native = nativeChild(f.cwd, "tool"), releaseA = `${native.release}-0`, releaseB = `${native.release}-1`;
	process.env.PI_FEEDBACK_RELEASE_FILE = `${native.release}-{index}`;
	f.state.ownedRuns!.clear(); await refreshFixture(f);
	const pending = f.executor.execute("queued-child", { tasks: [{ agent: "worker", task: "Held original A", output: false }, { agent: "worker", task: "Queued original B", output: false }], concurrency: 1, async: background, artifacts: false }, undefined, undefined, f.ctx);
	t.after(async () => { fs.writeFileSync(releaseA, "released"); fs.writeFileSync(releaseB, "released"); await pending; if (background) await until(() => [...f.state.ownedRuns!.keys()].every((id) => fs.existsSync(path.join(getRunMetadataDir(id), "result.json"))), "queued workflow cleanup"); native.restore(); });
	await until(() => fs.existsSync(`${releaseA}.json`) && JSON.parse(fs.readFileSync(`${releaseA}.json`, "utf8")).events.some((event) => event.type === "tool_execution_start"), "first native child holds the queue");
	await refreshFixture(f);
	const task = f.controller.tasks.find((task) => task.child.index === 1)!;
	assert.equal(task.child.state, "live");
	assert.equal(task.child.activity?.status, "pending");
	const opening = f.controller.open(task.key), view = f.overlay;
	assert.match(plain(view), /waiting to start/i);
	view.handleInput("Keep this draft for B"); view.handleInput("\r"); await turn();
	assert.match(plain(view), /waiting to start/i);
	assert.doesNotMatch(plain(view), /has finished|Continue with/);
	view.handleInput("\x1bc"); if (background) view.handleInput("\x1bs"); await turn();
	assert.equal(f.calls.length, 0, "neither send nor Continue launches a duplicate queued child");
	assert.equal(view.editor.getText(), "Keep this draft for B");
	view.handleInput("\x1bOQ"); assert.doesNotMatch(plain(view), /Continue with this message|Stop this agent only/); view.handleInput("\x1b");
	fs.writeFileSync(releaseA, "released");
	await until(() => fs.existsSync(`${releaseB}.json`) && JSON.parse(fs.readFileSync(`${releaseB}.json`, "utf8")).events.some((event) => event.type === "tool_execution_start"), "queued B must start normally");
	await refreshFixture(f);
	assert.doesNotMatch(plain(view), /waiting to start/i, "a prior pending action must not leave a stale state notice once B starts");
	fs.writeFileSync(releaseB, "released"); await pending;
	if (background) await until(() => fs.existsSync(path.join(getRunMetadataDir(task.run.runId), "result.json")), "queued workflow publishes its result");
	const result = await f.executor.execute("inspect-queued", { action: "status", id: task.run.runId }, undefined, undefined, f.ctx);
	assert.deepEqual(result.details.run?.children.map((child) => child.state), ["completed", "completed"]);
	assert.equal(f.state.ownedRuns!.size, 1);
	assert.equal(view.editor.getText(), "Keep this draft for B");
	assert.doesNotMatch(plain(view), /waiting to start/i);
	view.handleInput("\x1b"); await opening;
});

for (const background of [false, true]) test(`${background ? "background" : "foreground"} dynamic expansion preserves a later assignment's open view, draft, pin and controls`, async (t) => {
	const f = await fixture(t), mock = createMockPi(); mock.install();
	f.state.ownedRuns!.clear(); await refreshFixture(f);
	const discover = path.join(f.cwd, "discover-release"), reviews = path.join(f.cwd, "reviews-release"), final = path.join(f.cwd, "final-release");
	mock.onCall({ matchArgsIncludes: "Discover two targets", waitForFile: discover, structuredOutput: { items: [{ name: "alpha" }, { name: "beta" }] }, output: "Targets ready" });
	mock.onCall({ matchArgsIncludes: "Review alpha", waitForFile: reviews, output: "Alpha review complete" });
	mock.onCall({ matchArgsIncludes: "Review beta", waitForFile: reviews, output: "Beta review complete" });
	mock.onCall({ matchArgsIncludes: "Finalize from", waitForFile: final, output: "Finalized" });
	const pending = f.executor.execute("dynamic-view", { chain: [
		{ agent: "worker", model: "discovery/model", task: "Discover two targets", label: "Discover files", as: "targets", output: false, outputSchema: { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } } }, required: ["items"] } },
		{ expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/name", maxItems: 2 }, parallel: { agent: "reviewer", model: "reviews/model", task: "Review {target.name}", label: "Review {target.name}", output: false }, collect: { as: "reviews" } },
		{ agent: "worker", model: "final/model", task: "Finalize from {outputs.reviews}", label: "Finalize", output: false },
	], async: background, artifacts: false }, undefined, undefined, f.ctx);
	let runId: string | undefined;
	t.after(async () => {
		for (const gate of [discover, reviews, final]) fs.writeFileSync(gate, "released");
		await pending;
		if (background && runId) await until(() => fs.existsSync(path.join(getRunMetadataDir(runId!), "result.json")), "dynamic runner cleanup");
		if (process.env.PI_AGENT_VIEW_EVIDENCE_DIR) fs.cpSync(mock.dir, path.join(f.cwd, "mock-receipts"), { recursive: true });
		mock.uninstall();
	});
	await until(() => mock.callCount() === 1, "discovery starts before materialization");
	await refreshFixture(f);
	const later = f.controller.tasks.find((task) => task.label === "Finalize")!;
	assert.ok(later, "later pending assignments must remain visible");
	runId = later.run.runId;
	const opening = f.controller.open(later.key), view = f.overlay;
	view.handleInput("Directions intended only for Finalize"); view.handleInput("\x1bp");
	const deliveries = [];
	f.pi.events.on("subagent:live-intercom", (payload) => { deliveries.push(payload); f.pi.events.emit("subagent:live-intercom-delivery", { requestId: payload.requestId, accepted: true, delivered: true, messageId: payload.messageId }); });
	fs.writeFileSync(discover, "released");
	await until(() => mock.callCount() === 3, "both materialized reviewers start");
	await refreshFixture(f);
	await f.controller.send(later.key, view.editor.getText());
	await f.controller.stop(later.key);
	t.diagnostic(JSON.stringify({ phase: "expanded", background, key: later.key, task: f.controller.task(later.key)?.child.task, labels: f.controller.tasks.map((task) => task.label), deliveries: deliveries.map((payload) => payload.to), controls: f.calls }));
	assert.equal(deliveries.length, 0, "a later-step draft must not be sent to a materialized reviewer");
	assert.equal(f.calls.length, 0, "a later pending view must not stop an expanded reviewer");
	assert.equal(f.controller.task(later.key)!.child.activity?.status, "pending");
	assert.match(plain(view), /Agents › Finalize/);
	assert.deepEqual(f.controller.tasks.filter((task) => task.child.agent === "reviewer").map((task) => task.label).sort(), ["Review alpha", "Review beta"]);
	for (const reviewer of f.controller.tasks.filter((task) => task.child.agent === "reviewer")) assert.equal(reviewer.model?.summary, "selected: reviews/model");
	assert.doesNotMatch(f.controller.task(later.key)!.model.summary, /reviews\/model/, "the shifted pending assignment must not inherit a reviewer's model");
	view.handleInput("\x1b"); await opening;
	restoreOwnedRuns(f.state, f.ctx); f.controller.start(f.ctx);
	await refreshFixture(f);
	assert.equal(f.controller.pinned, later.key);
	assert.equal(f.controller.visit(later.key).draft, "Directions intended only for Finalize");
	fs.writeFileSync(reviews, "released");
	await until(() => mock.callCount() === 4, "original final assignment starts normally");
	await refreshFixture(f);
	const active = f.controller.task(later.key)!;
	assert.equal(active.child.agent, "worker"); assert.match(active.child.task!, /^Finalize from/);
	assert.equal(active.model.summary, "selected: final/model", "model metadata follows the workflow node after its child index changes");
	await f.controller.send(later.key, f.controller.visit(later.key).draft);
	assert.equal(deliveries.length, 1);
	assert.equal(deliveries[0].human.index, active.child.index);
	assert.equal(deliveries[0].human.runId, runId);
	assert.equal(deliveries[0].to, `subagent-worker-${runId}-${active.child.index + 1}`);
	await f.controller.stop(later.key);
	assert.deepEqual(f.calls, [{ action: "interrupt", id: runId, index: active.child.index }]);
	await pending;
	if (background) await until(() => fs.existsSync(path.join(getRunMetadataDir(runId!), "result.json")), "selected final child stops");
	restoreOwnedRuns(f.state, f.ctx); f.controller.start(f.ctx);
	await refreshFixture(f);
	assert.equal(f.controller.task(later.key)!.child.state, "paused");
	assert.equal(f.controller.visit(later.key).draft, "Directions intended only for Finalize");
	assert.equal(f.controller.pinned, later.key);
	assert.deepEqual(ownedRunView(f.state.ownedRuns!.get(runId!)!, f.state).children.map((child) => [child.label, child.state]), [["Discover files", "completed"], ["Review alpha", "completed"], ["Review beta", "completed"], ["Finalize", "paused"]]);
});

for (const identity of ["graph", "session", "missing"]) test(`restored legacy dynamic assignments ${identity === "missing" ? "keep unidentifiable drafts unavailable" : `recover saved ${identity} identities`} instead of reusing child slots`, async (t) => {
	const graphAvailable = identity === "graph";
	const f = await fixture(t), id = randomUUID(), asyncDir = path.join(ASYNC_DIR, id);
	f.state.ownedRuns!.clear();
	fs.mkdirSync(asyncDir, { recursive: true });
	const finalSession = path.join(f.cwd, "legacy-final.jsonl");
	// d57's saved graph excludes an unexpanded group from flatIndex, but status.steps includes its placeholder.
	const graph = { runId: id, mode: "chain", phases: [], nodes: [
		{ id: "step-0", kind: "step", agent: "worker", label: "Discover files", status: "running", stepIndex: 0, flatIndex: 0 },
		{ id: "step-1", kind: "dynamic-parallel-group", label: "Review {target.name}", status: "pending", stepIndex: 1, children: [] },
		{ id: "step-2", kind: "step", agent: "worker", label: "Finalize", status: "pending", stepIndex: 2, flatIndex: 1 },
	] };
	const status = { runId: id, sessionId: f.parent.getSessionFile(), mode: "chain", state: "running", startedAt: Date.now(), pid: process.pid, cwd: f.cwd,
		steps: [{ agent: "worker", label: "Discover files", status: "running", sessionFile: f.childSessions[0].getSessionFile() }, { agent: "expand:reviewer", label: "Review {target.name}", status: "pending" }, { agent: "worker", label: "Finalize", status: "pending", ...(identity !== "missing" ? { sessionFile: finalSession } : {}) }],
		...(graphAvailable ? { workflowGraph: graph } : {}) };
	const save = () => fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(status));
	save(); f.state.asyncJobs.set(id, { asyncId: id, asyncDir, status: "running" });
	restoreOwnedRuns(f.state, f.ctx); f.controller.start(f.ctx);
	await refreshFixture(f);
	const later = f.controller.tasks.find((task) => task.run.runId === id && task.child.index === 2)!;
	const opening = f.controller.open(later.key), view = f.overlay;
	view.handleInput("Only Finalize should see this"); view.handleInput("\x1bp");
	const deliveries = [];
	f.pi.events.on("subagent:live-intercom", (payload) => { deliveries.push(payload); f.pi.events.emit("subagent:live-intercom-delivery", { requestId: payload.requestId, accepted: true, delivered: true, messageId: payload.messageId }); });
	graph.nodes[0].status = "completed"; graph.nodes[1].status = "running"; graph.nodes[2].flatIndex = 3;
	graph.nodes[1].children = ["alpha", "beta"].map((name, index) => ({ id: `step-1-item-${name}`, kind: "agent", agent: "reviewer", label: `Review ${name}`, status: "running", stepIndex: 1, flatIndex: index + 1, itemKey: name }));
	status.steps = [{ ...status.steps[0], status: "complete" }, ...["alpha", "beta"].map((name) => ({ agent: "reviewer", label: `Review ${name}`, status: "running", sessionFile: f.childSessions[0].getSessionFile() })), { agent: "worker", label: "Finalize", status: "pending", sessionFile: finalSession }];
	for (const index of [1, 2]) saveQuestionContract(id, index, { pid: process.pid, task: `Review ${index === 1 ? "alpha" : "beta"}` });
	save(); await refreshFixture(f);
	await f.controller.send(later.key, f.controller.visit(later.key).draft);
	await f.controller.stop(later.key);
	assert.equal(deliveries.length, 0, "a restored legacy draft must not be sent to a reviewer occupying its former slot");
	assert.equal(f.calls.length, 0, "an uncertain or pending assignment must not address Stop to a reviewer");
	assert.equal(f.controller.pinned, later.key);
	assert.equal(f.controller.visit(later.key).draft, "Only Finalize should see this");
	if (identity !== "missing") {
		assert.equal(f.controller.task(later.key)!.label, "Finalize");
		assert.equal(f.controller.task(later.key)!.child.activity?.status, "pending");
		status.steps[1].status = status.steps[2].status = "complete"; status.steps[3].status = "running";
		saveQuestionContract(id, 3, { pid: process.pid, task: "Finalize the reviews", sessionFile: finalSession });
		save(); await refreshFixture(f);
		await f.controller.send(later.key, f.controller.visit(later.key).draft);
		assert.equal(deliveries.length, 1);
		assert.equal(deliveries[0].to, `subagent-worker-${id}-4`);
		assert.equal(deliveries[0].human.index, 3);
		await f.controller.stop(later.key);
		assert.equal(f.calls[0].index, 3);
		assert.match(f.controller.visit(later.key).notice!, /older runner/, "the old runner still truthfully refuses unsupported selected Stop");
	} else {
		assert.match(plain(view), /assignment.*unavailable/i);
		view.handleInput("\x1b"); await opening;
		status.workflowGraph = graph; save();
		restoreOwnedRuns(f.state, f.ctx); f.controller.start(f.ctx);
		await refreshFixture(f);
		const reopen = f.controller.open(later.key);
		assert.ok(f.overlay instanceof AgentConversation, "an unmatched saved draft remains inspectable after reliable graph data becomes available");
		assert.equal(f.overlay.editor.getText(), "Only Finalize should see this");
		assert.match(plain(f.overlay), /assignment.*unavailable/i);
		await f.controller.send(later.key, f.controller.visit(later.key).draft, true);
		assert.equal(deliveries.length, 0); assert.equal(f.calls.length, 0);
		f.overlay.handleInput("\x1b"); await reopen;
		return;
	}
	view.handleInput("\x1b"); await opening;
});

test("native history reflow preserves the same reading message and draft across terminal widths", async (t) => {
	const f = await fixture(t); f.terminal.columns = 99; f.terminal.rows = 34;
	for (let index = 0; index < 25; index++) assistant(f.childSessions[0], `HISTORY-${index}\n${`Message ${index} contains an inspectable long line. `.repeat(9)}`);
	await refreshFixture(f);
	const opening = f.controller.open(), view = f.overlay;
	await historyReady(f); view.handleInput("Unsent while reading"); view.render(99);
	view.handleInput("\x1b[5~"); view.handleInput("\x1b[5~"); view.render(99);
	const anchor = f.controller.visit(f.key).anchor!.id;
	f.terminal.columns = 64; f.terminal.rows = 24; view.render(64);
	assert.equal(f.controller.visit(f.key).anchor!.id, anchor, "narrow reflow must not jump to an earlier message");
	f.terminal.columns = 99; f.terminal.rows = 34; view.render(99);
	assert.equal(f.controller.visit(f.key).anchor!.id, anchor);
	assert.equal(view.editor.getText(), "Unsent while reading");
	view.handleInput("\x1b"); await opening;
});

test("native word deletion stays native while composing and F2 retains full-details access", async (t) => {
	const f = await fixture(t), opening = f.controller.open();
	const view = f.overlay;
	view.handleInput("one two"); view.handleInput("\x01"); view.handleInput("\x1bd");
	assert.equal(view.editor.getText(), " two");
	assert.doesNotMatch(plain(view).split("\n")[0], /details/);
	view.handleInput("\x1bOQ"); // native F2
	assert.match(plain(view), /Full details \/ diff/);
	view.handleInput("\x1b"); view.handleInput("\x1b"); await opening;
});

test("reopen starts at the first real unread reply rather than already-read history", async (t) => {
	const f = await fixture(t);
	for (let i = 0; i < 25; i++) assistant(f.childSessions[0], `Read earlier ${i}`);
	await refreshFixture(f);
	const opening = f.controller.open(); await historyReady(f);
	f.overlay.render(90); const highWater = f.controller.visit(f.key).readThrough;
	f.overlay.handleInput("\x1b[5~"); f.overlay.render(90);
	assert.equal(f.controller.visit(f.key).readThrough, highWater);
	f.overlay.handleInput("\x1b"); await opening;
	const first = assistant(f.childSessions[0], "FIRST UNREAD REPLY");
	assistant(f.childSessions[0], "Later unread activity\n".repeat(30));
	await refreshFixture(f);
	const reopen = f.controller.open(); await historyReady(f);
	assert.match(plain(f.overlay), /FIRST UNREAD REPLY/);
	assert.equal(f.controller.visit(f.key).anchor?.id, `${first}:0`);
	f.overlay.handleInput("\x1b"); await reopen;
	f.controller.pin(f.key); await f.complete();
	assert.equal(plain(f.strip), "", "finished agents and pins do not keep the live widget visible");
	assert.equal(f.controller.pinned, f.key, "the explicit pin is retained for reopening, not deleted");
});

test("same-parent restore retains drafts/pin and a replaced session ignores late delivery", async (t) => {
	const f = await fixture(t);
	const opening = f.controller.open();
	f.overlay.handleInput("Preserved draft"); f.overlay.handleInput("\x1bp"); f.overlay.handleInput("\x1b"); await opening;
	f.controller.start(f.ctx);
	await refreshFixture(f);
	assert.equal(f.controller.visit(f.key).draft, "Preserved draft");
	assert.equal(f.controller.pinned, f.key);
	let delivery;
	f.pi.events.on("subagent:live-intercom", (payload) => { delivery = payload; });
	const pending = f.controller.send(f.key, "Preserved draft");
	assert.ok(delivery);
	const fork = SessionManager.forkFrom(f.parent.getSessionFile(), f.cwd, path.join(f.cwd, "fork"));
	const ctx = { ...f.ctx, sessionManager: fork };
	f.state.lastUiContext = ctx;
	restoreOwnedRuns(f.state, ctx);
	f.controller.start(ctx);
	const entries = fork.getEntries().length;
	f.pi.events.emit("subagent:live-intercom-delivery", { requestId: delivery.requestId, accepted: true, delivered: true });
	await pending;
	assert.equal(f.controller.tasks.length, 0, "fork does not adopt parent agents");
	assert.equal(f.controller.pinned, undefined);
	assert.equal(fork.getEntries().length, entries, "late delivery cannot append into a replaced session");
	assert.equal(f.sent.length, 0, "no stale breadcrumb");
});

async function indexedRunsWhenReady(index, deadline: number) {
	let notify = () => {};
	const unsubscribe = index.onChanged(() => notify());
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error("Indexed fixture did not settle within the refresh budget")), Math.max(0, deadline - Date.now()));
		timer.unref();
	});
	try {
		for (;;) {
			const changed = new Promise<void>((resolve) => { notify = resolve; });
			const runs = await Promise.race([index.listRuns({ limit: 100 }), expired]);
			if (runs.freshness.pending === 0) return runs;
			await Promise.race([changed, expired]);
		}
	} finally {
		unsubscribe(); clearTimeout(timer);
	}
}

async function indexedReady(f): Promise<void> {
	await f.ready;
	const index = await runHistoryIndex(f.state);
	await index.setOwner({ ownerSessionId: f.parent.getSessionId(), ownerSessionFile: f.parent.getSessionFile(), runs: [...f.state.ownedRuns.values()], foregroundRuns: [...f.state.foregroundRuns.values()] });
	const deadline = Date.now() + 120_000;
	try { await index.refresh(); }
	catch (error) {
		assert.equal(error.code, "DEGRADED", "only honest absent native sources are expected in restored/unstarted fixtures");
		const runs = await indexedRunsWhenReady(index, deadline);
		assert.equal(runs.freshness.pending, 0);
		let missing = 0;
		for (const run of runs.rows) for (const child of run.children) {
			assert.equal(run.diagnosis, undefined, "canonical run projection must succeed");
			const page = await index.historyPage({ runId: run.runId, index: child.index });
			if (child.sessionFile && !fs.existsSync(child.sessionFile)) {
				assert.equal(page.sourceState, "missing"); assert.ok(page.unavailable); missing++;
			} else assert.ok(["current", "unlinked"].includes(page.sourceState), `unexpected indexed source ${page.sourceState}: ${page.unavailable}`);
		}
		assert.ok(missing > 0, "DEGRADED requires an independently verified missing source");
	}
	await f.controller.refresh();
	await f.controller.refresh();
}

async function refreshFixture(f): Promise<void> {
	await indexedReady(f);
	for (const task of f.controller.tasks) {
		if (task.child.missingSession && task.child.state !== "live") continue;
		const value = await f.controller.historyPage(task.key);
		if (!value) continue;
		const history = task.child.state !== "live" && task.child.result ? withFinalResult(value.history, getSingleResultOutput(task.child.result), task.run.runId, task.run.updatedAt) : value.history;
		task.history = history.items; task.historyIds = history.entryIds; task.page = value.page; task.finalId = history.finalId;
	}
	if (f.tui.hasOverlay() && f.overlay instanceof AgentConversation) { f.overlay.refresh(); await historyReady(f); }
}

async function historyReady(f): Promise<void> {
	await until(() => {
		const task = f.controller.task(f.overlay?.key);
		return Boolean(task && (task.page || task.child.identityUnavailable || task.unavailable && plain(f.overlay).includes("History unavailable")) && !task.historyLoading);
	}, "selected physical page loaded");
}

async function historyAction(f, label: string): Promise<void> {
	f.overlay.handleInput("\x1bOQ");
	for (let step = 0; step < 24 && !plain(f.overlay).includes(`→ ${label}`); step++) f.overlay.handleInput("\x1b[B");
	assert.ok(plain(f.overlay).includes(`→ ${label}`), `native action ${label} is reachable`);
	f.overlay.handleInput("\r");
	await historyReady(f);
}

test("indexed Agents startup, ticks, global filter and pagination never hydrate historical sources on the UI thread", async (t) => {
	const f = await fixture(t);
	await f.ready; f.controller.dispose(); await closeRunHistory(f.state);
	f.state.ownedRuns.clear();
	for (let position = 0; position < 125; position++) {
		const runId = `indexed-ui-${String(position).padStart(3, "0")}`;
		const run = { ...f.run, runId, rootRunId: runId, asyncDir: getRunMetadataDir(runId), startedAt: f.run.startedAt + position,
			children: [{ ...f.run.children[0], label: `Owned assignment ${position}`, task: position === 3 ? "A unique needle outside the first two pages" : `Original work ${position}` }] };
		saveQuestionOwner(runId, run.ownerSessionId);
		saveQuestionContract(runId, 0, { task: run.children[0].task, sessionFile: run.children[0].sessionFile });
		saveAsyncRunResult(runId, { runtimeVersion: 2, id: runId, state: "complete", timestamp: run.startedAt + 1, results: [{ agent: "worker", task: run.children[0].task, sessionFile: run.children[0].sessionFile, success: true, exitCode: 0, finalOutput: "Completed" }] });
		f.state.ownedRuns.set(runId, run);
	}
	const accesses: string[] = [], metadataRoot = path.dirname(getRunMetadataDir(f.run.runId));
	for (const method of ["readFileSync", "statSync", "existsSync", "readdirSync", "openSync"] as const) {
		const original = fs[method];
		t.mock.method(fs, method, function(file, ...args) {
			const name = String(file);
			if (name.startsWith(metadataRoot) || name === f.childSessions[0].getSessionFile()) accesses.push(`${method}:${name}`);
			return original.call(this, file, ...args);
		});
	}
	syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	f.controller.start(f.ctx);
	const index = await runHistoryIndex(f.state); await index.refresh(); await f.controller.refresh();
	assert.equal(f.controller.listPage?.total, 125);
	assert.equal(f.controller.tasks.length, 50);
	assert.ok(f.controller.tasks.every((task) => task.history.length === 0), "closed startup retains no native history cards");
	await f.controller.refresh(); await f.controller.refresh(true);
	assert.deepEqual(accesses, [], "startup and forced/scheduled observations are genuinely off-thread");
	const opening = f.controller.open();
	assert.match(plain(f.overlay), /page 1/);
	f.overlay.handleInput("\x1b[6~");
	await until(() => f.controller.listPage?.offset === 50 && !f.controller.listLoading, "second run page");
	assert.equal(f.controller.tasks.length, 50);
	f.overlay.handleInput("\x1b[6~");
	await until(() => f.controller.listPage?.offset === 100 && !f.controller.listLoading, "third run page");
	assert.equal(f.controller.tasks.length, 25, "tasks after the first 100 remain discoverable");
	f.overlay.handleInput("unique needle");
	await until(() => f.controller.listPage?.total === 1 && !f.controller.listLoading, "filter applies to all owned tasks, not just loaded rows");
	assert.equal(f.controller.tasks[0].run.runId, "indexed-ui-003");
	assert.deepEqual(accesses, []);
	f.overlay.handleInput("\x1b"); await opening;
});

test("indexed Agents history pages retain cross-page tool pairing, validated full details, drafts and abandoned-overlay guards", async (t) => {
	const f = await fixture(t, "fullscreen"), manager = f.childSessions[0];
	await f.ready;
	for (let position = 0; position < 220; position++) {
		if (position === 80) manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "cross-page-call", name: "check", arguments: { command: "Saved command", payload: "FULL-ARGUMENT-END" } }], provider: "fixture", model: "fixture", api: "openai-responses", stopReason: "toolUse", usage, timestamp: Date.now() });
		else if (position === 190) manager.appendMessage({ role: "toolResult", toolCallId: "cross-page-call", toolName: "check", content: [{ type: "text", text: "Saved result" }], details: { receipt: "FULL-RESULT-END" }, isError: false, timestamp: Date.now() });
		else assistant(manager, `Physical history ${position}`);
	}
	await indexedReady(f);
	const opening = f.controller.open(f.key); f.tui.start();
	await historyReady(f);
	const task = f.controller.task(f.key)!, firstSequence = task.page!.entries[0].sequence;
	assert.equal(task.page?.entries.length, 100);
	assert.ok(task.history.length <= 100, "only the current physical page is retained");
	const paired = task.history.find((item) => item.call?.id === "cross-page-call")!;
	assert.equal(paired.result?.toolCallId, "cross-page-call", "a result page resolves its call on an earlier physical page");
	assert.match((await paired.load!()).details!, /FULL-ARGUMENT-END[\s\S]*FULL-RESULT-END/);
	f.overlay.handleInput("Unsent child draft");
	await historyAction(f, "Earlier history");
	assert.ok(f.controller.task(f.key)!.page!.entries.at(-1)!.sequence < firstSequence);
	assert.equal(f.overlay.editor.getText(), "Unsent child draft");
	await historyAction(f, "Later history");
	assert.ok(f.controller.task(f.key)!.history.some((item) => item.call?.id === "cross-page-call"));
	f.overlay.handleInput("\x1bl"); await historyReady(f);
	assert.match(f.overlay.scroll.render(88).map(stripTerminalSequences).join("\n"), /Physical history 219/);
	const index = await runHistoryIndex(f.state), record = index.record.bind(index);
	const ready = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
	t.after(() => release.resolve());
	const selectedRecord = t.mock.method(index, "record", async (...args) => {
		const result = await record(...args);
		ready.resolve();
		await release.promise;
		return result;
	});
	f.overlay.handleInput("\t"); f.overlay.handleInput("\x1b[F"); plain(f.overlay); f.overlay.handleInput("\r");
	await ready.promise;
	assert.match(plain(f.overlay), /Loading selected details/);
	f.overlay.handleInput("\x1b");
	release.resolve();
	await selectedRecord.mock.calls[0].result;
	await turn();
	assert.doesNotMatch(plain(f.overlay), /› details/, "a late selected-detail result cannot reopen an abandoned detail view");
	assert.equal(f.overlay.editor.getText(), "Unsent child draft");
	f.overlay.handleInput("\x1b"); await opening;
});

test("indexed Agents selected detail rejects source replacement without dropping the draft", async (t) => {
	const f = await fixture(t, "fullscreen"), manager = f.childSessions[0];
	await f.ready;
	assistant(manager, `Saved selected body ${"detail ".repeat(200)}FULL-SELECTED-END`);
	await indexedReady(f);
	const opening = f.controller.open(f.key); f.tui.start(); await historyReady(f);
	f.overlay.handleInput("Keep this draft"); plain(f.overlay);
	f.overlay.handleInput("\t"); f.overlay.handleInput("\x1b[F"); await historyReady(f); plain(f.overlay);
	const file = manager.getSessionFile();
	fs.writeFileSync(`${file}.replacement`, fs.readFileSync(file)); fs.renameSync(`${file}.replacement`, file);
	f.overlay.handleInput("\r");
	await until(() => plain(f.overlay).includes("Details unavailable"), "native byte references reject replaced sources");
	f.overlay.handleInput("\x1b");
	assert.equal(f.overlay.editor.getText(), "Keep this draft");
	assert.equal(f.calls.length, 0);
	f.overlay.handleInput("\x1b"); await opening;
});

for (const retry of ["F5", "run list"] as const) test(`unavailable Agents history stays quiet through background refreshes and recovers with ${retry}`, async (t) => {
	const f = await fixture(t);
	f.controller.dispose(); await closeRunHistory(f.state);
	const previous = process.env.PI_CODING_AGENT_DIR;
	const agentDir = path.join(f.cwd, "unavailable-agent");
	fs.mkdirSync(agentDir);
	const indexDir = path.join(agentDir, "history-index");
	fs.symlinkSync(path.join(previous!, "history-index"), indexDir, "dir");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(async () => {
		f.controller.dispose(); await closeRunHistory(f.state);
		process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(agentDir, { recursive: true, force: true });
	});
	const fork = childProcess.fork;
	const starts = t.mock.method(childProcess, "fork", (...args) => Reflect.apply(fork, childProcess, args));
	const errors = t.mock.method(console, "error", () => {});
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });

	f.controller.start(f.ctx); await f.controller.refresh();
	assert.match(f.controller.listError!, /History directory must not be a symbolic link/);
	for (let update = 0; update < 3; update++) {
		f.state.onRunsChanged?.(); await f.controller.refresh();
	}
	assert.equal(starts.mock.callCount(), 1, "background updates must not keep restarting failed history");
	assert.equal(errors.mock.callCount(), 0, "unavailable history must be rendered without raw terminal output");
	assert.match(plain(f.strip), /Agents history unavailable/);
	assert.equal(f.mainEditor.getText(), "Unsent parent draft\nDo not replace this");

	const opening = f.controller.open();
	await until(() => Boolean(f.overlay), "unavailable picker opens");
	assert.match(plain(f.overlay), /Retry \(F5\)/);
	fs.unlinkSync(indexDir);
	if (retry === "F5") f.overlay.handleInput("\x1b[15~");
	else {
		const result = await f.executor.execute("history-retry", { action: "status" }, undefined, undefined, f.ctx);
		assert.notEqual(result.isError, true);
		assert.equal(result.details.runList?.total, 1);
		await f.controller.refresh();
	}
	await until(() => !f.controller.listError && f.controller.listPage?.total === 1, "explicit retry restores history");
	assert.equal(starts.mock.callCount(), 2);
	assert.equal(errors.mock.callCount(), 0);
	assert.match(plain(f.overlay), /Fix login/);
	assert.equal(f.mainEditor.getText(), "Unsent parent draft\nDo not replace this");
	f.overlay.handleInput("\x1b"); await opening;
});
