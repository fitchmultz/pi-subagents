import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { initTheme, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { Container, CURSOR_MARKER, Editor, ScrollView, Spacer, Text, TuiMainScreen, TuiAltScreen, VStack, visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
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
const { restoreOwnedRuns, ownedRunView, saveForegroundRun, OWNED_RUN_ENTRY } = await import("../../src/runs/shared/run-records.ts");
const { getRunMetadataDir, readQuestionState, saveQuestionOwner, saveQuestionContract } = await import("../../src/runs/shared/supervisor-questions.ts");
const { createSubagentExecutor } = await import("../../src/runs/foreground/subagent-executor.ts");
const { createAsyncJobTracker } = await import("../../src/runs/background/async-job-tracker.ts");
const { ASYNC_DIR } = await import("../../src/shared/types.ts");
initTheme("dark", false);
const { theme: uiTheme } = await import(new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 }, turns: 0 };
function assistant(manager, text: string) { return manager.appendMessage({ role: "assistant", content: [{ type: "text", text }], provider: "fixture", model: "fixture", api: "openai-responses", stopReason: "stop", usage, timestamp: Date.now() }); }
const plain = (component, width = 90) => component.render(width).map(stripTerminalSequences).join("\n");
function readDetails(view, width = 90): string {
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
function nativeChild(cwd: string, scenario: "streaming" | "tool" | "question") {
	const release = path.join(cwd, "release"), bin = path.join(cwd, "bin"); fs.mkdirSync(bin);
	fs.writeFileSync(path.join(bin, "pi"), `#!/bin/sh\nexec "${process.execPath}" "${fileURLToPath(new URL("../fixtures/native-feedback-child.mjs", import.meta.url))}" "$@"\n`, { mode: 0o700 });
	const saved = { PATH: process.env.PATH, PI_FEEDBACK_SCENARIO: process.env.PI_FEEDBACK_SCENARIO, PI_FEEDBACK_RELEASE_FILE: process.env.PI_FEEDBACK_RELEASE_FILE };
	process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`; process.env.PI_FEEDBACK_SCENARIO = scenario; process.env.PI_FEEDBACK_RELEASE_FILE = release;
	return { release, restore() { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } } };
}

function fixture(t, mode: "regular" | "fullscreen" = "regular", children = 1) {
	const cwd = path.join(root, randomUUID()); fs.mkdirSync(cwd);
	const parent = SessionManager.create(cwd, path.join(cwd, "parent"));
	assistant(parent, "Parent context stays unchanged");
	const childSessions = Array.from({ length: children }, (_, index) => {
		const manager = SessionManager.create(cwd, path.join(cwd, `child-${index}`));
		manager.appendMessage({ role: "user", content: "Fix the assigned behavior", timestamp: Date.now() });
		assistant(manager, "I found the relevant code.");
		return manager;
	});
	const run: OwnedRun = { runId: randomUUID(), rootRunId: "", ownerSessionId: parent.getSessionId(), source: "foreground", mode: children > 1 ? "parallel" : "single", cwd, task: "Combined tasks must not be used as per-child labels", startedAt: Date.now(),
		children: childSessions.map((session, index) => ({ agent: "worker", index, label: index === 0 ? "Fix login" : "Review changes", task: index === 0 ? "Fix the login regression.\nKeep the API unchanged." : "Review the diff carefully.", sessionFile: session.getSessionFile() })) };
	run.rootRunId = run.runId;
	parent.appendCustomEntry(OWNED_RUN_ENTRY, run);
	saveQuestionOwner(run.runId, run.ownerSessionId);
	for (const child of run.children) saveQuestionContract(run.runId, child.index, { task: child.task, sessionFile: child.sessionFile });
	const state = { ...makeMinimalCtx(cwd), baseCwd: cwd, currentSessionId: parent.getSessionFile(), ownedRuns: new Map([[run.runId, run]]), asyncJobs: new Map(), foregroundControls: new Map(), foregroundRuns: new Map(), lastForegroundControlId: null,
		cleanupTimers: new Map(), lastUiContext: null, poller: null, completionSeen: new Map(), watcher: null, watcherRestartTimer: null, resultFileCoalescer: { schedule: () => false, clear() {} } } as unknown as SubagentState;
	const interrupts = Array(children).fill(0);
	state.foregroundControls.set(run.runId, { runId: run.runId, mode: run.mode, startedAt: run.startedAt, updatedAt: run.startedAt,
		activeChildren: new Map(run.children.map((child) => [child.index, { agent: child.agent, interrupt: () => { interrupts[child.index]++; return true; } }])),
		currentAgent: "worker", currentIndex: 0, interrupt: () => { throw new Error("Unexpected whole-group interrupt"); } });
	const terminal = createTestTerminal();
	const tui = mode === "fullscreen" ? new TuiAltScreen(terminal) : new TuiMainScreen(terminal);
	const events = createEventBus(), commands = new Map(), sent = [], calls = [];
	let overlay, strip, overlayHandle;
	const pi = { events, getSessionName: () => "test-parent", registerCommand(name, command) { commands.set(name, command); }, registerMessageRenderer() {},
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
	const ctx = { ...makeMinimalCtx(cwd), mode: "tui", hasUI: true, sessionManager: parent, ui: { theme: uiTheme, getToolsExpanded: () => false,
		setWidget(_key, factory) { strip = factory?.(tui, uiTheme); widgets.clear(); widgets.addChild(new Spacer(1)); if (strip) widgets.addChild(strip); },
		custom(factory, options) { return new Promise((resolve) => {
			let handle;
			overlay = factory(tui, uiTheme, undefined, (value) => { handle?.hide(); overlay?.dispose?.(); resolve(value); });
			handle = tui.showOverlay(overlay, typeof options.overlayOptions === "function" ? options.overlayOptions() : options.overlayOptions);
			overlayHandle = handle;
		}); },
	} };
	state.lastUiContext = ctx;
	const tracker = createAsyncJobTracker(pi, state, ASYNC_DIR);
	pi.events.on("subagent:async-started", tracker.handleStarted);
	const executor = createSubagentExecutor({ pi, state, config: {}, asyncByDefault: true, tempArtifactsDir: cwd, getSubagentSessionRoot: () => cwd, expandTilde: (value) => value, discoverAgents: () => ({ agents: ["worker", "reviewer"].map((name) => makeAgent(name, { completionGuard: false })) }) });
	const controller = new AgentViewController(pi, state, async (params, context) => { calls.push(params); return executor.execute(randomUUID(), params, undefined, undefined, context); });
	state.onRunsChanged = () => controller.refresh(true);
	state.persistOwnedRun = (owned) => parent.appendCustomEntry(OWNED_RUN_ENTRY, structuredClone(owned));
	controller.start(ctx);
	t.after(() => { controller.dispose(); tui.stop(); if (state.poller) clearInterval(state.poller); for (const timer of state.cleanupTimers.values()) clearTimeout(timer); });
	return { cwd, parent, run, state, childSessions, interrupts, controller, executor, ctx, pi, tui, terminal, mainEditor, sent, calls, commands,
		get overlay() { return overlay; }, get overlayBounds() { return overlayHandle?.getBounds(); }, get strip() { return strip; }, key: `${run.runId}:0`,
		complete() { state.foregroundControls.clear(); saveForegroundRun({ ...run, results: run.children.map((child) => ({ agent: child.agent, task: child.task!, exitCode: 0, finalOutput: "Finished", sessionFile: child.sessionFile, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 } })) }); controller.refresh(true); },
	};
}

for (const mode of ["regular", "fullscreen"] as const) test(`Agents strip and single-child open are native, read-only, and preserve the parent (${mode})`, async (t) => {
	const f = fixture(t, mode);
	assert.match(plain(f.strip, 90), /^Agents.*1 running[\s\S]*Fix login/);
	assert.doesNotMatch(plain(f.strip), /tokens|Combined tasks/);
	assert.match(plain(f.strip, 12), /^Agents/);
	const opening = f.controller.open();
	assert.ok(f.overlay instanceof AgentConversation);
	const view = f.overlay;
	assert.ok(view.editor instanceof Editor);
	assert.equal(view.focused, true);
	assert.equal(view.editor.focused, true);
	view.handleInput("\x1b[200~first line\nsecond line 日本語\x1b[201~");
	assert.equal(view.editor.getExpandedText(), "first line\nsecond line 日本語");
	assert.equal(f.calls.length, 0);
	view.handleInput("\x1b"); await opening;
	assert.equal(f.mainEditor.getText(), "Unsent parent draft\nDo not replace this");
	assert.deepEqual(f.interrupts, [0]);
	const reopen = f.controller.open();
	assert.equal(f.overlay.editor.getExpandedText(), "first line\nsecond line 日本語");
	f.overlay.handleInput("\x1b"); await reopen;
});

test("live multiple-child picker and fullscreen task click target the exact child", async (t) => {
	const f = fixture(t, "fullscreen", 2);
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
	const f = fixture(t);
	const manager = f.childSessions[0];
	for (let index = 0; index < 30; index++) assistant(manager, `Historical message ${index}\nReadable detail ${index}`);
	manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "edit-1", name: "edit", arguments: { path: "login.ts", oldText: "before", newText: "after" } }], stopReason: "toolUse", provider: "fixture", model: "fixture", api: "openai-responses", usage, timestamp: Date.now() });
	manager.appendMessage({ role: "toolResult", toolCallId: "edit-1", toolName: "edit", content: [{ type: "text", text: "Edited login.ts" }], isError: false, details: { diff: "-before\n+after", completeDetail: "FULL-DETAIL-END" }, timestamp: Date.now() });
	f.controller.refresh(true);
	const opening = f.controller.open();
	const view = f.overlay as InstanceType<typeof AgentConversation>;
	view.render(90);
	const readThrough = f.controller.visit(f.key).readThrough;
	view.handleInput("\x1b[5~"); view.render(90);
	assert.equal(f.controller.visit(f.key).readThrough, readThrough, "reading backwards cannot regress the unread boundary");
	const anchor = f.controller.visit(f.key).anchor;
	assistant(manager, "New streamed response\n".repeat(20));
	f.controller.refresh(true); view.render(90);
	assert.deepEqual(f.controller.visit(f.key).anchor, anchor, "append must not pull a scrolled reader to the bottom");
	assert.match(plain(view), /New activity/);
	view.handleInput("\t"); view.handleInput("\x1b[F"); view.render(90);
	// The last native message follows the edit result, so Up selects that result.
	view.handleInput("\x1b[A"); view.render(90);
	view.handleInput("\x1bd");
	assert.match(readDetails(view), /FULL-DETAIL-END/);
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
	f.controller.refresh(true);
	assert.equal(view.editor.getExpandedText(), "");
	assert.equal(f.controller.visit(f.key).outbox.length, 0);
	assert.equal(f.controller.visit(f.key).notice, undefined, "the native receipt clears the obsolete already-waiting notice");
	f.terminal.columns = 24; f.terminal.rows = 18;
	const narrow = view.render(24);
	assert.ok(narrow.every((line) => visibleWidth(line) <= 24));
	assert.ok(narrow.length <= 18, `view must fit the native overlay: ${narrow.length}`);
	view.handleInput("\x1b"); await opening;
});

for (const nativeAnswer of [false, true]) test(`completed structured-output history opens at the readable report without duplicates (native answer: ${nativeAnswer})`, async (t) => {
	const f = fixture(t), manager = f.childSessions[0];
	const report = "**The login fix is ready.**\n\n## Verification\n" + Array.from({ length: 40 }, (_, index) => `- Checked behavior ${index + 1}.`).join("\n");
	const submitted = `${report}\n\n\`\`\`acceptance-report\n${JSON.stringify({ criteriaSatisfied: [{ id: "login", status: "satisfied", evidence: "ACCEPTANCE-DETAIL-END" }], noStagedFiles: true })}\n\`\`\``;
	if (nativeAnswer) assistant(manager, submitted);
	manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "final-report", name: "structured_output", arguments: { value: { report: submitted } } }], stopReason: "toolUse", provider: "fixture", model: "fixture", api: "openai-responses", usage, timestamp: Date.now() });
	manager.appendMessage({ role: "toolResult", toolCallId: "final-report", toolName: "structured_output", content: [{ type: "text", text: "Structured output captured." }], details: { stored: true }, isError: false, timestamp: Date.now() });
	const original = fs.readFileSync(manager.getSessionFile(), "utf8");
	f.state.foregroundControls.clear();
	saveForegroundRun({ ...f.run, results: [{ agent: "worker", task: f.run.children[0].task!, exitCode: 0, finalOutput: report, sessionFile: manager.getSessionFile(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 } }] });
	f.controller.refresh(true);
	const opening = f.controller.open(), view = f.overlay;
	const first = plain(view);
	assert.match(first, /The login fix is ready\./, "a long finished report opens at its beginning, not its tail or serialized submission");
	assert.doesNotMatch(first, /criteriaSatisfied|\\n|"value"|"report"/);
	view.handleInput("\t"); view.handleInput("\x1b[F"); view.render(90);
	view.handleInput("\x1b[A"); view.render(90);
	view.handleInput("\r");
	assert.match(readDetails(view), /ACCEPTANCE-DETAIL-END/, "the recorded structured payload is still inspectable in full details");
	view.handleInput("\x1br");
	assert.match(f.controller.visit(f.key).quote!.text, /ACCEPTANCE-DETAIL-END/, "replying to the submission retains its actual recorded data");
	view.handleInput("\x1bq");
	view.handleInput("\x1b"); await opening;
	const reopen = f.controller.open();
	f.terminal.rows = 150;
	f.overlay.handleInput("\x1bl");
	const all = plain(f.overlay, 120);
	assert.equal(all.match(/The login fix is ready\./g)?.length, 1, "only one visible final answer, even when native history already contains it");
	assert.doesNotMatch(all, /ACCEPTANCE-DETAIL-END|criteriaSatisfied/);
	assert.equal(fs.readFileSync(manager.getSessionFile(), "utf8"), original, "viewing must not rewrite the native history");
	assert.equal(f.calls.length, 0);
	f.overlay.handleInput("\x1b"); await reopen;
});

test("native grouped tools retain recorded diffs, full context and old result-entry reading positions", async (t) => {
	const f = fixture(t), manager = f.childSessions[0];
	for (let index = 0; index < 25; index++) assistant(manager, `Earlier history ${index}`);
	manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "saved-bash", name: "bash", arguments: { command: "printf NATIVE-BASH-RESULT", timeout: 15 } }], stopReason: "toolUse", provider: "fixture", model: "fixture", api: "openai-responses", usage, timestamp: Date.now() });
	const resultId = manager.appendMessage({ role: "toolResult", toolCallId: "saved-bash", toolName: "bash", content: [{ type: "text", text: "NATIVE-BASH-RESULT" }], details: { receipt: "BASH-RAW-DETAIL" }, isError: false, timestamp: Date.now() });
	const file = path.join(f.cwd, "login.ts"); fs.writeFileSync(file, "Today's file is different from this old edit.\n");
	manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "saved-edit", name: "edit", arguments: { path: file, oldText: "before", newText: "after" } }], stopReason: "toolUse", provider: "fixture", model: "fixture", api: "openai-responses", usage, timestamp: Date.now() });
	manager.appendMessage({ role: "toolResult", toolCallId: "saved-edit", toolName: "edit", content: [{ type: "text", text: "Edited login.ts" }], details: { diff: "-before\n+after", receipt: "EDIT-RAW-DETAIL" }, isError: false, timestamp: Date.now() });
	for (let index = 0; index < 25; index++) assistant(manager, `Later history ${index}`);
	f.controller.refresh(true);
	const visit = f.controller.visit(f.key);
	visit.readThrough = f.controller.task(f.key)!.history.at(-1)!.id;
	visit.anchor = { id: resultId, line: 0 };
	const opening = f.controller.open(), view = f.overlay;
	assert.match(plain(view), /\$ printf NATIVE-BASH-RESULT/, "restoring an old standalone result ID opens its grouped native tool card");
	assert.doesNotMatch(plain(view), /"command"|"timeout"|BASH-RAW-DETAIL|Today's file|Could not find/);
	view.handleInput("\t"); view.render(90); view.handleInput("\r");
	assert.match(readDetails(view), /BASH-RAW-DETAIL/);
	view.handleInput("\x1br");
	assert.match(visit.quote!.text, /printf NATIVE-BASH-RESULT/);
	assert.match(visit.quote!.text, /BASH-RAW-DETAIL/);
	view.handleInput("\x1bq"); view.handleInput("\t"); view.render(90);
	view.handleInput("\x1b[B"); view.render(90); view.handleInput("\r");
	assert.match(readDetails(view), /-before[\s\S]*\+after/);
	view.handleInput("\x1br");
	assert.match(visit.quote!.text, /EDIT-RAW-DETAIL/);
	assert.match(visit.quote!.text, /-before\n\+after/);
	assert.equal(fs.readFileSync(file, "utf8"), "Today's file is different from this old edit.\n");
	assert.equal(f.calls.length, 0);
	view.handleInput("\x1b"); await opening;
});

test("paired tool details show recorded diff on physical lines before raw metadata", async (t) => {
	const f = fixture(t, "fullscreen"), manager = f.childSessions[0];
	f.terminal.resize(64, 78);
	const file = path.join(f.cwd, "history-only.ts"), current = "Today's file does not match the old edit.\n";
	fs.writeFileSync(file, current);
	const diff = "--- history-only.ts\n+++ history-only.ts\n@@ -1 +1 @@\n-return before;\n+return after;";
	manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "saved-apply", name: "apply_edits", arguments: { path: file, rewrite: "return after;\n" } }], stopReason: "toolUse", provider: "fixture", model: "fixture", api: "openai-responses", usage, timestamp: Date.now() });
	manager.appendMessage({ role: "toolResult", toolCallId: "saved-apply", toolName: "apply_edits", content: [{ type: "text", text: "Rewrote history-only.ts." }], details: { diff, diffTruncated: false, warnings: ["RECORDED-WARNING"] }, isError: false, timestamp: Date.now() });
	const original = fs.readFileSync(manager.getSessionFile(), "utf8");
	f.controller.refresh(true);
	const opening = f.controller.open(); f.tui.start(); f.tui.renderNow();
	const view = f.overlay, width = f.overlayBounds.width;
	assert.doesNotMatch(plain(view, width), /return before|RECORDED-WARNING|"rewrite"/, "ordinary cards stay compact");
	view.handleInput("\t"); view.handleInput("\x1b[F"); view.render(width); view.handleInput("\r"); view.handleInput("\x1b[H");
	const lines = view.render(width).map(stripTerminalSequences).map((line) => line.trim());
	const removed = lines.indexOf("-return before;"), metadata = lines.indexOf('"call": {');
	assert.ok(removed >= 0, "the recorded removal is a physical diff line, not an escaped JSON substring");
	assert.equal(lines[removed + 1], "+return after;", "the recorded addition follows on its own line");
	assert.ok(metadata > removed + 1, "readable diff appears before raw metadata");
	const full = readDetails(view, width);
	assert.match(full, /"rewrite"/); assert.match(full, /RECORDED-WARNING/);
	view.handleInput("\x1br");
	assert.ok(f.controller.visit(f.key).quote!.text.startsWith(`${diff}\n\n`));
	assert.match(f.controller.visit(f.key).quote!.text, /"rewrite"[\s\S]*RECORDED-WARNING/);
	assert.equal(fs.readFileSync(file, "utf8"), current); assert.equal(fs.readFileSync(manager.getSessionFile(), "utf8"), original);
	assert.equal(f.calls.length, 0);
	view.handleInput("\x1b"); await opening;
});

test("a newly paired custom-tool result stays unread and supports native expansion without losing raw details", async (t) => {
	const f = fixture(t, "fullscreen"), manager = f.childSessions[0];
	manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "custom-call", name: "custom_check", arguments: { check: "login", payload: { retained: "RAW-ARGUMENT" } } }], stopReason: "toolUse", provider: "fixture", model: "fixture", api: "openai-responses", usage, timestamp: Date.now() });
	f.controller.refresh(true);
	const pending = f.controller.open();
	assert.match(plain(f.overlay), /result not recorded/);
	f.overlay.handleInput("\x1b"); await pending;
	const resultId = manager.appendMessage({ role: "toolResult", toolCallId: "custom-call", toolName: "custom_check", content: [{ type: "text", text: `Checks completed\n${"Checked a behavior\n".repeat(20)}FINAL-TOOL-LINE` }], details: { receipt: "RAW-RESULT" }, isError: false, timestamp: Date.now() });
	f.controller.refresh(true);
	assert.equal(f.controller.task(f.key)!.unread, true, "a result is new activity even though it joins an existing tool card");
	const opening = f.controller.open(), view = f.overlay;
	f.terminal.rows = 60;
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
	const details = readDetails(view);
	assert.match(details, /RAW-ARGUMENT/); assert.match(details, /RAW-RESULT/); assert.match(details, /FINAL-TOOL-LINE/);
	view.handleInput("\x1br");
	assert.match(f.controller.visit(f.key).quote!.text, /RAW-ARGUMENT[\s\S]*RAW-RESULT/);
	assert.equal(f.calls.length, 0);
	view.handleInput("\x1b"); await opening;
});

test("twenty-task picker is framed, width-aware and searchable by the full assignment", async (t) => {
	const f = fixture(t, "regular", 20);
	f.terminal.columns = 140; f.terminal.rows = 40;
	const label = "Fix authentication for team memberships across regions";
	for (const child of f.run.children) {
		child.label = child.index === 0 ? label : `Review behavior ${child.index}`;
		saveQuestionContract(f.run.runId, child.index, { task: `Assignment ${child.index}\n${child.index === 19 ? "Distinctive assignment needle" : "Other work"}\nFULL-ASSIGNMENT-END` });
	}
	f.controller.refresh(true);
	const opening = f.controller.open(), picker = f.overlay;
	const wide = picker.render(140).map(stripTerminalSequences);
	assert.match(wide[0], /─{20}/, "the picker has a visible themed boundary");
	assert.match(wide.at(-1)!, /─{20}/);
	assert.ok(wide.some((line) => line.includes("→") && line.includes(label)), "the task column uses available width instead of clipping at 30 characters");
	assert.match(wide.join("\n"), /worker/);
	picker.handleInput("Distinctive assignment needle");
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
});

test("active Agents rows distinguish running, queued and needs-action work, then disappear after completion", async (t) => {
	const f = fixture(t, "fullscreen", 4);
	for (const [index, label] of ["Fix login", "Queued docs", "Approve change", "Finished report"].entries()) f.run.children[index].label = label;
	const control = f.state.foregroundControls.get(f.run.runId)!;
	for (const index of [1, 2, 3]) control.activeChildren!.delete(index);
	const { resolveEffectiveAcceptance } = await import("../../src/runs/shared/acceptance.ts");
	const effectiveAcceptance = resolveEffectiveAcceptance({ explicit: { criteria: ["Confirm the user action"] } })!;
	const result = { agent: "worker", task: "Saved assignment", exitCode: 0, finalOutput: "Saved report", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 } };
	saveQuestionContract(f.run.runId, 2, { result: { ...result, acceptance: { status: "blocked", explicit: true, effectiveAcceptance, criteria: effectiveAcceptance.criteria, runtimeChecks: [], verifyRuns: [], childReport: { criteriaSatisfied: [{ id: "criterion-1", status: "blocked", evidence: "The approval control requires a person.", humanAction: "Confirm the approval control." }] } } } });
	saveQuestionContract(f.run.runId, 3, { result });
	f.controller.visit(`${f.run.runId}:3`).readThrough = null;
	f.controller.refresh(true);
	const raw = f.strip.render(90), rows = raw.map(stripTerminalSequences);
	assert.match(rows[0], /1 running/);
	for (const label of ["Fix login", "Queued docs", "Approve change"]) assert.equal(rows.filter((line) => line.includes(label)).length, 1);
	assert.notEqual(rows.findIndex((line) => line.includes("Fix login")), rows.findIndex((line) => line.includes("Queued docs")), "agents have distinct compact rows");
	assert.match(rows.join("\n"), /queued|waiting to start/); assert.match(rows.join("\n"), /needs.*action|action required/);
	assert.doesNotMatch(rows.join("\n"), /Finished report|done.*new/);
	const codes = (label: string) => raw[rows.findIndex((line) => line.includes(label))].match(/\x1b\[[\d;]+m/g);
	assert.ok(codes("Fix login")?.length); assert.notDeepEqual(codes("Fix login"), codes("Approve change"), "native status colors distinguish work from needs-action states");
	assert.ok(f.strip.render(24).every((line) => visibleWidth(line) <= 24));
	const messageId = randomUUID(), visit = f.controller.visit(f.key);
	visit.lastSentId = messageId;
	visit.readThrough = f.childSessions[0].appendCustomMessageEntry("subagent-human-message", "Please check the API", true, { bodyText: "Please check the API", message: { id: messageId } });
	assistant(f.childSessions[0], "The API is unchanged.");
	f.controller.refresh(true);
	assert.match(plain(f.strip).split("\n").find((line) => line.includes("Fix login"))!, /replied/, "an actual child response retains its existing distinction from other unread activity");
	f.controller.pin(f.key); f.controller.visit(f.key).draft = "Retained private draft";
	f.complete();
	assert.equal(plain(f.strip), "", "no Agents area, results badge, completed row or finished pin remains when all work finishes");
	f.controller.start(f.ctx);
	assert.equal(plain(f.strip), ""); assert.equal(f.controller.pinned, f.key); assert.equal(f.controller.visit(f.key).draft, "Retained private draft");
	assert.equal(f.controller.task(`${f.run.runId}:3`)!.unread, true, "hiding the area does not discard unread completed history");
	const opening = f.commands.get("agents").handler("", f.ctx);
	assert.ok(f.tui.hasOverlay(), "/agents still opens saved completed conversations");
	f.overlay.handleInput("\x1b"); await opening;
	assert.equal(f.calls.length, 0);
});

for (const [children, columns, rows] of [[1, 90, 28], [2, 90, 28], [2, 24, 18]]) test(`native entrance pointer toggles the same spot for ${children === 1 ? "a conversation" : "the picker and a conversation"} (${columns}×${rows})`, async (t) => {
	const f = fixture(t, "fullscreen", children);
	f.terminal.resize(columns, rows);
	for (let index = 0; index < 25; index++) assistant(f.childSessions[0], `Prior history ${index}\n${"Readable earlier detail. ".repeat(6)}`);
	f.controller.refresh(true); f.tui.start(); f.tui.renderNow();
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
	const f = fixture(t, "fullscreen", 4), draft = "Please keep the API unchanged.", deliveries = [];
	f.terminal.resize(24, 18);
	const opening = f.controller.open(f.key);
	f.tui.start(); f.tui.renderNow();
	f.pi.events.on("subagent:live-intercom", (payload) => {
		deliveries.push(payload);
		f.pi.events.emit("subagent:live-intercom-delivery", { requestId: payload.requestId, accepted: true, delivered: true, messageId: payload.messageId });
	});
	f.terminal.input(draft); f.terminal.input("\x1br"); f.tui.renderNow();
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
	const f = fixture(t, "fullscreen", 2);
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
	const f = fixture(t, "fullscreen", 2), control = f.state.foregroundControls.get(f.run.runId)!;
	f.terminal.resize(64, 78);
	f.run.children[0].label = "Build native Agents experience";
	f.run.children[1].label = "Review current UX changes and preserve every public interface";
	f.run.children[1].agent = "reviewer"; control.activeChildren!.get(1)!.agent = "reviewer";
	control.progress = f.run.children.map((child) => ({ index: child.index, agent: child.agent, task: child.task!, status: "running" as const, recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, durationMs: 1,
		...(child.index === 0 ? { currentTool: "bash", currentToolArgs: "export VERY_VERBOSE_COMMAND_PREVIEW=the_command_must_not_replace_task_identity; printf finished" } : {}) }));
	for (const child of f.run.children) f.controller.visit(`${f.run.runId}:${child.index}`).readThrough = null;
	f.controller.refresh(true); f.tui.start();
	const opening = surface === "picker" ? f.controller.open() : undefined;
	f.tui.renderNow();
	const component = surface === "picker" ? f.overlay : f.strip, width = surface === "picker" ? f.overlayBounds.width : 64;
	const rows = component.render(width).map(stripTerminalSequences);
	const writer = rows.find((line) => line.includes("Build")) ?? "", reviewer = rows.find((line) => line.includes("Review current")) ?? "";
	assert.match(writer, /Build native Agents experience/); assert.match(writer, /working · new/);
	assert.match(reviewer, /Review current UX changes/); assert.match(reviewer, /working · new/);
	assert.doesNotMatch(writer, /export|VERY_VERBOSE/);
	if (surface === "picker") {
		assert.match(writer, /worker/); assert.match(reviewer, /reviewer/);
		assert.match(plain(component, width), /bash export/, "selected preview retains activity detail");
		control.progress![0].currentToolArgs = "export UPDATED_ACTIVITY_PROOF=1";
		f.controller.refresh(true); f.tui.renderNow();
		assert.match(plain(component, width), /UPDATED_ACTIVITY_PROOF/, "selected activity stays fresh when state and badge have not changed");
	} else assert.match(rows[0], /2 running/);
	const messageId = randomUUID(), visit = f.controller.visit(f.key);
	visit.lastSentId = messageId;
	visit.readThrough = f.childSessions[0].appendCustomMessageEntry("subagent-human-message", "Keep the API", true, { bodyText: "Keep the API", message: { id: messageId } });
	assistant(f.childSessions[0], "The API is preserved."); f.controller.refresh(true); f.tui.renderNow();
	const repliedRows = component.render(width).map(stripTerminalSequences);
	assert.match(repliedRows.find((line) => line.includes("Build")) ?? "", /Build native Agents[\s\S]*working · replied/);
	assert.match(repliedRows.find((line) => line.includes("Review current")) ?? "", /Review current UX[\s\S]*working · new/);
	assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
	if (opening) { f.overlay.handleInput("\x1b"); await opening; }
	const conversation = f.controller.open(f.key); f.tui.renderNow();
	assert.match(plain(f.overlay, f.overlayBounds.width), /bash export/, "conversation retains activity detail");
	f.overlay.handleInput("\x1b"); await conversation;
	assert.equal(f.calls.length, 0); assert.deepEqual(f.interrupts, [0, 0]);
});

test("native delivery clears an obsolete saved duplicate notice after reload, not unrelated notices", (t) => {
	const f = fixture(t), messageId = randomUUID();
	f.childSessions[0].appendCustomMessageEntry("subagent-human-message", "Delivered direction", true, { bodyText: "Delivered direction", message: { id: messageId } });
	for (const [notice, expected] of [["This message is already waiting for the child. You can keep working or write a different message.", undefined], ["Changes unavailable: repository could not be read", "Changes unavailable: repository could not be read"]]) {
		f.controller.dispose();
		f.parent.appendCustomEntry("subagent-view", { ownerSessionId: f.parent.getSessionId(), visits: [[f.key, { draft: "", outbox: [], lastSentId: messageId, notice }]] });
		f.controller.start(f.ctx);
		assert.equal(f.controller.visit(f.key).notice, expected);
	}
});

test("completion during compose keeps the draft, and viewing a finished child never continues it", async (t) => {
	const f = fixture(t);
	const opening = f.controller.open(); const view = f.overlay;
	view.handleInput("Follow up after completion"); f.complete();
	view.handleInput("\r"); await turn();
	assert.equal(f.calls.length, 0);
	assert.equal(view.editor.getExpandedText(), "Follow up after completion");
	assert.match(plain(view), /Alt\+C Continue/);
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
	const f = fixture(t), mock = createMockPi(); mock.install(); t.after(() => mock.uninstall());
	f.state.ownedRuns!.clear(); f.state.foregroundControls.clear(); f.controller.refresh(true);
	mock.onCall({ delay: 1200, output: "Fresh foreground completed" });
	const pending = f.executor.execute("first-launch", { agent: "worker", task: "A first foreground task", label: "Fresh foreground", async: false, artifacts: false, output: false }, undefined, undefined, f.ctx);
	t.after(async () => { await pending; });
	await new Promise((resolve) => setTimeout(resolve, 650));
	assert.match(plain(f.strip), /Fresh foreground.*working/);
	assert.equal(f.controller.tasks[0]?.child.state, "live");
	await pending;
});

test("new async chain preserves its launch identity, draft and pin through first status persistence", async (t) => {
	const f = fixture(t), mock = createMockPi(); mock.install();
	f.state.ownedRuns!.clear(); f.state.foregroundControls.clear(); f.controller.refresh(true);
	const release = path.join(f.cwd, "startup-release"), draft = "Keep the existing public API";
	mock.onCall({ matchArgsIncludes: "Fix login with original assignment", waitForFile: release, output: "Fixed" });
	let initial, opening, runId: string | undefined;
	f.state.onRunsChanged = () => {
		f.controller.refresh(true);
		if (initial || !f.controller.tasks.length) return;
		const task = f.controller.tasks[0]!;
		// The executor publishes the owned assignment synchronously, before spawning the runner.
		initial = { key: task.key, label: task.label, task: task.child.task,
			statusExists: fs.existsSync(path.join(ASYNC_DIR, task.run.runId, "status.json")) || fs.existsSync(path.join(getRunMetadataDir(task.run.runId), "status.json")) };
		opening = f.controller.open(task.key);
		f.overlay.handleInput(draft); f.overlay.handleInput("\x1bp");
	};
	const deliveries = [];
	f.pi.events.on("subagent:live-intercom", (payload) => { deliveries.push(payload); f.pi.events.emit("subagent:live-intercom-delivery", { requestId: payload.requestId, accepted: true, delivered: true, messageId: payload.messageId }); });
	const pending = f.executor.execute("startup-view", { chain: [{ agent: "worker", task: "Fix login with original assignment", label: "Fix login", output: false }], async: true, artifacts: false }, undefined, undefined, f.ctx);
	t.after(async () => {
		fs.writeFileSync(release, "released"); await pending;
		if (runId) await until(() => fs.existsSync(path.join(getRunMetadataDir(runId!), "result.json")), "startup runner cleanup");
		if (process.env.PI_AGENT_VIEW_EVIDENCE_DIR) fs.cpSync(mock.dir, path.join(f.cwd, "mock-receipts"), { recursive: true });
		mock.uninstall();
	});
	const launched = await pending; assert.ok(!launched.isError); runId = launched.details.asyncId;
	await until(() => mock.callCount() === 1, "the real runner persists status and starts the assigned child");
	f.controller.refresh(true);
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

test("the first native streaming response is readable before its session file exists", async (t) => {
	const f = fixture(t), native = nativeChild(f.cwd, "streaming"), { release } = native;
	f.state.ownedRuns!.clear(); f.state.foregroundControls.clear(); f.controller.refresh(true);
	const pending = f.executor.execute("initial-stream", { agent: "worker", task: "Read initial streaming output", async: false, artifacts: false, output: false }, undefined, undefined, f.ctx);
	t.after(async () => { fs.writeFileSync(release, "released"); await pending; native.restore(); });
	const deadline = Date.now() + 10_000;
	while (!f.controller.tasks.some((task) => task.child.activity?.streamingText?.includes("First live text"))) { assert.ok(Date.now() < deadline, "initial native text must arrive"); await delay(10); }
	const task = f.controller.tasks[0]!;
	assert.equal(fs.existsSync(task.child.sessionFile!), false, "native Pi defers saving the first response until message_end");
	const receipt = JSON.parse(fs.readFileSync(`${release}.json`, "utf8"));
	assert.equal(receipt.events.some((event) => event.type === "message_end" && event.role === "assistant"), false);
	const opening = f.controller.open(task.key);
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
	assert.equal(f.controller.task(task.key)!.unavailable, undefined);
	assert.equal(f.controller.task(task.key)!.unread, true, "visiting before native message_end must retain the before-first-saved-entry boundary after completion and reload");
	assert.equal(plain(f.strip), "", "completed unread history and a saved pin do not keep the active area visible");
	assert.equal(f.controller.pinned, task.key);
	const reopen = f.controller.open(task.key);
	assert.match(plain(f.overlay), /Second live text block continues before message end\./, "reopening must show the first finished reply, not the tail of later history");
	assert.equal(f.overlay.editor.getText(), "Draft for after the first response");
	f.overlay.handleInput("\x1b"); await reopen;
	fs.renameSync(task.child.sessionFile!, `${task.child.sessionFile}.removed`); f.controller.refresh(true);
	assert.match(f.controller.tasks[0]!.unavailable!, /Saved conversation unavailable/, "a missing completed history remains an honest error");
});

test("explicit Continue uses the saved launch and follows the active successor without a duplicate runtime", async (t) => {
	const f = fixture(t), native = nativeChild(f.cwd, "tool"), agent = makeAgent("worker", { model: "feedback-fixture/faux-1", completionGuard: false, output: false, extensions: [] });
	saveQuestionContract(f.run.runId, 0, { launch: { agent, systemPrompt: "Saved effective instructions", skills: [], model: agent.model, modelCandidates: [agent.model], cwd: f.cwd, context: "fresh", artifacts: false, output: false, outputMode: "inline", share: false } });
	f.complete();
	const opening = f.controller.open(f.key), view = f.overlay;
	view.handleInput("Continue after my check"); view.handleInput("\r"); await turn();
	assert.equal(f.calls.length, 0); assert.equal(view.editor.getText(), "Continue after my check");
	view.handleInput("\x1bc");
	await until(() => !f.controller.isBusy(f.key), "explicit continuation receipt");
	const successor = f.controller.task(f.key)!;
	assert.notEqual(successor.run.runId, f.run.runId);
	t.after(async () => { fs.writeFileSync(native.release, "released"); await until(() => fs.existsSync(path.join(getRunMetadataDir(successor.run.runId), "result.json")), "continuation cleanup"); native.restore(); });
	await until(() => fs.existsSync(`${native.release}.json`) && JSON.parse(fs.readFileSync(`${native.release}.json`, "utf8")).events.some((event) => event.type === "tool_execution_start"), "native continuation must run");
	f.controller.refresh(true);
	assert.equal(f.controller.task(f.key)!.child.sessionFile, f.run.children[0].sessionFile);
	assert.equal(f.controller.task(f.key)!.child.launch!.systemPrompt, "Saved effective instructions");
	assert.equal(view.editor.getText(), "");
	assert.match(f.controller.task(f.key)!.history.map((item) => item.text).join("\n"), /direct user follow-up \(human origin\)[\s\S]*Continue after my check/);
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
	f.controller.refresh(true);
	assert.equal(f.controller.task(f.key)!.child.state, "completed");
	assert.match(f.controller.task(f.key)!.history.at(-1)!.text, /Synthetic child finished normally/);
	view.handleInput("\x1b"); await opening;
});

test("answering in the view releases the real native durable question with human provenance", async (t) => {
	const f = fixture(t), native = nativeChild(f.cwd, "question");
	f.state.ownedRuns!.clear(); f.state.foregroundControls.clear(); f.controller.refresh(true);
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
	await pending; f.controller.refresh(true);
	assert.equal(readQuestionState(question).delivery?.kind, "live");
	assert.equal(f.state.ownedRuns!.size, 1, "answering a live question starts no continuation");
	assert.match(f.controller.task(task.key)!.history.map((item) => item.text).join("\n"), /Direct user answer \(human origin\)[\s\S]*Use the first path/);
	assert.equal(f.sent.length, 1); assert.match(f.sent[0].message.content, /Use the first path/);
	view.handleInput("\x1b"); await opening;
});

test("foreground chain parallel updates retain both live children's unfinished text", async (t) => {
	const f = fixture(t), native = nativeChild(f.cwd, "streaming");
	f.state.ownedRuns!.clear(); f.state.foregroundControls.clear(); f.controller.refresh(true);
	const seen = new Set<number>(); let observation;
	const pending = f.executor.execute("parallel-stream", { chain: [{ parallel: [{ agent: "worker", task: "A streaming", output: false }, { agent: "worker", task: "B streaming", output: false }] }], async: false, artifacts: false }, undefined, (update) => {
		for (const progress of update.details.progress ?? []) if (progress.streamingText?.includes("Second live text")) seen.add(progress.index);
		if (seen.size === 2 && !observation) { f.controller.refresh(true); observation = f.controller.tasks.map((task) => ({ index: task.child.index, state: task.child.state, text: task.child.activity?.streamingText })); }
	}, f.ctx);
	t.after(async () => { fs.writeFileSync(native.release, "released"); await pending; native.restore(); });
	await until(() => Boolean(observation), "both native children streamed before message_end");
	assert.deepEqual(observation.map((child) => child.state), ["live", "live"]);
	for (const child of observation) assert.match(child.text ?? "", /Second live text/, `child ${child.index} retains its unfinished response when a sibling updates`);
	fs.writeFileSync(native.release, "released"); await pending;
});

for (const background of [false, true]) test(`${background ? "background" : "foreground"} queued child is waiting to start, keeps its draft, and cannot create duplicate continuation`, async (t) => {
	const f = fixture(t), native = nativeChild(f.cwd, "tool"), releaseA = `${native.release}-0`, releaseB = `${native.release}-1`;
	process.env.PI_FEEDBACK_RELEASE_FILE = `${native.release}-{index}`;
	f.state.ownedRuns!.clear(); f.state.foregroundControls.clear(); f.controller.refresh(true);
	const pending = f.executor.execute("queued-child", { tasks: [{ agent: "worker", task: "Held original A", output: false }, { agent: "worker", task: "Queued original B", output: false }], concurrency: 1, async: background, artifacts: false }, undefined, undefined, f.ctx);
	t.after(async () => { fs.writeFileSync(releaseA, "released"); fs.writeFileSync(releaseB, "released"); await pending; if (background) await until(() => [...f.state.ownedRuns!.keys()].every((id) => fs.existsSync(path.join(getRunMetadataDir(id), "result.json"))), "queued workflow cleanup"); native.restore(); });
	await until(() => fs.existsSync(`${releaseA}.json`) && JSON.parse(fs.readFileSync(`${releaseA}.json`, "utf8")).events.some((event) => event.type === "tool_execution_start"), "first native child holds the queue");
	f.controller.refresh(true);
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
	f.controller.refresh(true);
	assert.doesNotMatch(plain(view), /waiting to start/i, "a prior pending action must not leave a stale state notice once B starts");
	fs.writeFileSync(releaseB, "released"); await pending;
	const result = await f.executor.execute("collect-queued", { action: "wait", id: task.run.runId }, AbortSignal.timeout(5_000), undefined, f.ctx);
	assert.deepEqual(result.details.run?.children.map((child) => child.state), ["completed", "completed"]);
	assert.equal(f.state.ownedRuns!.size, 1);
	assert.equal(view.editor.getText(), "Keep this draft for B");
	assert.doesNotMatch(plain(view), /waiting to start/i);
	view.handleInput("\x1b"); await opening;
});

for (const background of [false, true]) test(`${background ? "background" : "foreground"} dynamic expansion preserves a later assignment's open view, draft, pin and controls`, async (t) => {
	const f = fixture(t), mock = createMockPi(); mock.install();
	f.state.ownedRuns!.clear(); f.state.foregroundControls.clear(); f.controller.refresh(true);
	const discover = path.join(f.cwd, "discover-release"), reviews = path.join(f.cwd, "reviews-release"), final = path.join(f.cwd, "final-release");
	mock.onCall({ matchArgsIncludes: "Discover two targets", waitForFile: discover, structuredOutput: { items: [{ name: "alpha" }, { name: "beta" }] }, output: "Targets ready" });
	mock.onCall({ matchArgsIncludes: "Review alpha", waitForFile: reviews, output: "Alpha review complete" });
	mock.onCall({ matchArgsIncludes: "Review beta", waitForFile: reviews, output: "Beta review complete" });
	mock.onCall({ matchArgsIncludes: "Finalize from", waitForFile: final, output: "Finalized" });
	const pending = f.executor.execute("dynamic-view", { chain: [
		{ agent: "worker", task: "Discover two targets", label: "Discover files", as: "targets", output: false, outputSchema: { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } } }, required: ["items"] } },
		{ expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/name", maxItems: 2 }, parallel: { agent: "reviewer", task: "Review {target.name}", label: "Review {target.name}", output: false }, collect: { as: "reviews" } },
		{ agent: "worker", task: "Finalize from {outputs.reviews}", label: "Finalize", output: false },
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
	f.controller.refresh(true);
	const later = f.controller.tasks.find((task) => task.label === "Finalize")!;
	assert.ok(later, "later pending assignments must remain visible");
	runId = later.run.runId;
	const opening = f.controller.open(later.key), view = f.overlay;
	view.handleInput("Directions intended only for Finalize"); view.handleInput("\x1bp");
	const deliveries = [];
	f.pi.events.on("subagent:live-intercom", (payload) => { deliveries.push(payload); f.pi.events.emit("subagent:live-intercom-delivery", { requestId: payload.requestId, accepted: true, delivered: true, messageId: payload.messageId }); });
	fs.writeFileSync(discover, "released");
	await until(() => mock.callCount() === 3, "both materialized reviewers start");
	f.controller.refresh(true);
	await f.controller.send(later.key, view.editor.getText());
	await f.controller.stop(later.key);
	t.diagnostic(JSON.stringify({ phase: "expanded", background, key: later.key, task: f.controller.task(later.key)?.child.task, labels: f.controller.tasks.map((task) => task.label), deliveries: deliveries.map((payload) => payload.to), controls: f.calls }));
	assert.equal(deliveries.length, 0, "a later-step draft must not be sent to a materialized reviewer");
	assert.equal(f.calls.length, 0, "a later pending view must not stop an expanded reviewer");
	assert.equal(f.controller.task(later.key)!.child.activity?.status, "pending");
	assert.match(plain(view), /Agents › Finalize/);
	assert.deepEqual(f.controller.tasks.filter((task) => task.child.agent === "reviewer").map((task) => task.label).sort(), ["Review alpha", "Review beta"]);
	view.handleInput("\x1b"); await opening;
	restoreOwnedRuns(f.state, f.ctx); f.controller.start(f.ctx);
	assert.equal(f.controller.pinned, later.key);
	assert.equal(f.controller.visit(later.key).draft, "Directions intended only for Finalize");
	fs.writeFileSync(reviews, "released");
	await until(() => mock.callCount() === 4, "original final assignment starts normally");
	f.controller.refresh(true);
	const active = f.controller.task(later.key)!;
	assert.equal(active.child.agent, "worker"); assert.match(active.child.task!, /^Finalize from/);
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
	assert.equal(f.controller.task(later.key)!.child.state, "paused");
	assert.equal(f.controller.visit(later.key).draft, "Directions intended only for Finalize");
	assert.equal(f.controller.pinned, later.key);
	assert.deepEqual(ownedRunView(f.state.ownedRuns!.get(runId!)!, f.state).children.map((child) => [child.label, child.state]), [["Discover files", "completed"], ["Review alpha", "completed"], ["Review beta", "completed"], ["Finalize", "paused"]]);
});

for (const identity of ["graph", "session", "missing"]) test(`restored legacy dynamic assignments ${identity === "missing" ? "keep unidentifiable drafts unavailable" : `recover saved ${identity} identities`} instead of reusing child slots`, async (t) => {
	const graphAvailable = identity === "graph";
	const f = fixture(t), id = randomUUID(), asyncDir = path.join(ASYNC_DIR, id);
	f.state.ownedRuns!.clear(); f.state.foregroundControls.clear();
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
	const later = f.controller.tasks.find((task) => task.run.runId === id && task.child.index === 2)!;
	const opening = f.controller.open(later.key), view = f.overlay;
	view.handleInput("Only Finalize should see this"); view.handleInput("\x1bp");
	const deliveries = [];
	f.pi.events.on("subagent:live-intercom", (payload) => { deliveries.push(payload); f.pi.events.emit("subagent:live-intercom-delivery", { requestId: payload.requestId, accepted: true, delivered: true, messageId: payload.messageId }); });
	graph.nodes[0].status = "completed"; graph.nodes[1].status = "running"; graph.nodes[2].flatIndex = 3;
	graph.nodes[1].children = ["alpha", "beta"].map((name, index) => ({ id: `step-1-item-${name}`, kind: "agent", agent: "reviewer", label: `Review ${name}`, status: "running", stepIndex: 1, flatIndex: index + 1, itemKey: name }));
	status.steps = [{ ...status.steps[0], status: "complete" }, ...["alpha", "beta"].map((name) => ({ agent: "reviewer", label: `Review ${name}`, status: "running", sessionFile: f.childSessions[0].getSessionFile() })), { agent: "worker", label: "Finalize", status: "pending", sessionFile: finalSession }];
	for (const index of [1, 2]) saveQuestionContract(id, index, { pid: process.pid, task: `Review ${index === 1 ? "alpha" : "beta"}` });
	save(); f.controller.refresh(true);
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
		save(); f.controller.refresh(true);
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
	const f = fixture(t); f.terminal.columns = 99; f.terminal.rows = 34;
	for (let index = 0; index < 25; index++) assistant(f.childSessions[0], `HISTORY-${index}\n${`Message ${index} contains an inspectable long line. `.repeat(9)}`);
	f.controller.refresh(true);
	const opening = f.controller.open(), view = f.overlay;
	view.handleInput("Unsent while reading"); view.render(99);
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
	const f = fixture(t), opening = f.controller.open();
	const view = f.overlay;
	view.handleInput("one two"); view.handleInput("\x01"); view.handleInput("\x1bd");
	assert.equal(view.editor.getText(), " two");
	assert.doesNotMatch(plain(view).split("\n")[0], /details/);
	view.handleInput("\x1bOQ"); // native F2
	assert.match(plain(view), /Full details \/ diff/);
	view.handleInput("\x1b"); view.handleInput("\x1b"); await opening;
});

test("reopen starts at the first real unread reply rather than already-read history", async (t) => {
	const f = fixture(t);
	for (let i = 0; i < 25; i++) assistant(f.childSessions[0], `Read earlier ${i}`);
	f.controller.refresh(true);
	const opening = f.controller.open();
	f.overlay.render(90); const highWater = f.controller.visit(f.key).readThrough;
	f.overlay.handleInput("\x1b[5~"); f.overlay.render(90);
	assert.equal(f.controller.visit(f.key).readThrough, highWater);
	f.overlay.handleInput("\x1b"); await opening;
	const first = assistant(f.childSessions[0], "FIRST UNREAD REPLY");
	assistant(f.childSessions[0], "Later unread activity\n".repeat(30));
	f.controller.refresh(true);
	const reopen = f.controller.open();
	assert.match(plain(f.overlay), /FIRST UNREAD REPLY/);
	assert.equal(f.controller.visit(f.key).anchor?.id, `${first}:0`);
	f.overlay.handleInput("\x1b"); await reopen;
	f.controller.pin(f.key); f.complete();
	assert.equal(plain(f.strip), "", "finished agents and pins do not keep the live widget visible");
	assert.equal(f.controller.pinned, f.key, "the explicit pin is retained for reopening, not deleted");
});

test("same-parent restore retains drafts/pin and a replaced session ignores late delivery", async (t) => {
	const f = fixture(t);
	const opening = f.controller.open();
	f.overlay.handleInput("Preserved draft"); f.overlay.handleInput("\x1bp"); f.overlay.handleInput("\x1b"); await opening;
	f.controller.start(f.ctx);
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
