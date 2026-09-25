import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, setKeybindings, KeybindingsManager, TUI_KEYBINDINGS, Text, TuiAltScreen, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { SessionListOverlay } from "../../src/pi-intercom/ui/session-list.ts";
import { ComposeOverlay } from "../../src/pi-intercom/ui/compose.ts";
import { IntercomTopics } from "../../src/pi-intercom/topics.ts";
import { createTestTerminal } from "../support/terminal.ts";

initTheme("dark", false);
const { theme } = await import(new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const current = { id: "self", name: "Parent", cwd: "/fixture", model: "fixture" };
const peers = ["First", "Second"].map((name) => ({ ...current, id: name.toLowerCase(), name }));

function nativeUi(t, columns = 100, rows = 32, bindings = {}) {
	const terminal = createTestTerminal(columns, rows);
	const tui = new TuiAltScreen(terminal);
	const previous = getKeybindings(), keys = new KeybindingsManager(TUI_KEYBINDINGS, bindings);
	setKeybindings(keys);
	tui.addChild(new Text("Unchanged parent", 0, 0));
	let component, handle;
	const results = [];
	tui.start();
	t.after(() => { handle?.hide(); component?.dispose?.(); tui.stop(); setKeybindings(previous); });
	const f = {
		tui, terminal, keys, results,
		custom(factory, options?) { return new Promise((resolve) => {
			component = factory(tui, theme, keys, (value) => { results.push(value); handle?.hide(); component.dispose?.(); resolve(value); });
			handle = tui.showOverlay(component, options?.overlayOptions ?? { width: "96%", margin: 1 });
			tui.renderNow();
		}); },
		get component() { return component; },
		get bounds() { return handle.getBounds(); },
		lines() { tui.renderNow(); return component.render(f.bounds.width).map(stripTerminalSequences); },
		point(text: string) {
			const lines = f.lines(), y = lines.findIndex((line) => line.includes(text));
			assert.ok(y >= 0 && y < f.bounds.height, `visible hint ${JSON.stringify(text)}:\n${lines.join("\n")}`);
			return { x: f.bounds.col + visibleWidth(lines[y].slice(0, lines[y].indexOf(text) + text.length)) - 1, y: f.bounds.row + y };
		},
		async click(text: string) { const { x, y } = f.point(text); terminal.click(x, y); await turn(); tui.renderNow(); },
	};
	return f;
}

for (const remapped of [false, true]) test(`clickable Intercom hints: native peer selection, Message and Close (remapped: ${remapped})`, async (t) => {
	const f = nativeUi(t, 100, 32, remapped ? { "tui.select.confirm": "ctrl+g", "tui.select.cancel": "ctrl+e" } : {});
	const opening = f.custom((tui, theme, keys, done) => new SessionListOverlay(tui, theme, keys, current, peers, done));
	f.terminal.input("\x1b[B"); f.tui.renderNow();
	assert.match(f.lines().join("\n"), /→ Second/);
	await f.click(`${remapped ? "ctrl+g" : "enter"}: Message`);
	assert.deepEqual(f.results, [peers[1]], "Message activates the selected native row");
	await opening;
	assert.equal(f.tui.hasOverlay(), false);
	const rowOpening = f.custom((tui, theme, keys, done) => new SessionListOverlay(tui, theme, keys, current, peers, done));
	await f.click("Second (");
	assert.deepEqual(f.results, [peers[1], peers[1]], "the embedded native list receives mouse coordinates too");
	await rowOpening;
	const empty = f.custom((tui, theme, keys, done) => new SessionListOverlay(tui, theme, keys, current, [], done));
	await f.click("Close");
	assert.equal(f.tui.hasOverlay(), false);
	await empty;
	assert.deepEqual(f.results, [peers[1], peers[1], undefined]);
});

for (const remapped of [false, true]) test(`clickable Intercom hints: compose modes and single explicit send (remapped: ${remapped})`, async (t) => {
	const f = nativeUi(t, 100, 32, remapped ? { "tui.select.confirm": "ctrl+g", "tui.select.cancel": "ctrl+e" } : {});
	const sent = [];
	let release;
	const client = { send: async (to, options) => { sent.push({ to, ...options }); return new Promise((resolve) => { release = () => resolve({ id: "receipt", accepted: true, delivered: true }); }); } };
	const opening = f.custom((tui, theme, keys, done) => new ComposeOverlay(tui, theme, keys, peers[0], peers[0].name, client, done));
	f.terminal.input("\x1b[200~\tLine 1\r\nLine 2\x1b[201~"); f.tui.renderNow();
	await f.click("Tab: Request-reply mode");
	assert.match(f.lines().join("\n"), /Request reply to: First/);
	await f.click("Tab: Send mode");
	assert.match(f.lines().join("\n"), /Send to: First/);
	await f.click("Tab: Request-reply mode");
	const point = f.point(`${remapped ? "ctrl+g" : "enter"}: Request reply`);
	f.terminal.input(`\x1b[<0;${point.x + 1};${point.y + 1}M`); f.tui.renderNow();
	assert.equal(sent.length, 0, "press alone must not send");
	f.terminal.input(`\x1b[<0;${point.x + 1};${point.y + 1}m`); await turn(); f.tui.renderNow();
	assert.deepEqual(sent, [{ to: "first", text: "\tLine 1\nLine 2", expectsReply: true }]);
	f.terminal.click(point.x, point.y); f.terminal.input("\r"); f.terminal.input("\t");
	assert.equal(sent.length, 1, "in-flight clicks and keys cannot duplicate a send or change its mode");
	assert.match(f.lines().join("\n"), /Sending/);
	release(); await opening;
	assert.deepEqual(f.results, [{ sent: true, messageId: "receipt", text: "\tLine 1\nLine 2", expectsReply: true }]);
	f.component.handleInput("late input");
	assert.equal(sent.length, 1);
});

test("clickable Intercom hints: Close cancels, clipped controls stay inert, and a paste cannot become an action", async (t) => {
	const f = nativeUi(t), sent = [];
	const client = { send: async (...args) => { sent.push(args); return { id: "unused", accepted: true }; } };
	const opening = f.custom((tui, theme, keys, done) => new ComposeOverlay(tui, theme, keys, peers[0], peers[0].name, client, done));
	const close = f.point("Close"), tab = f.point("Tab: Request-reply mode");
	f.terminal.input("\x1b[200~partial paste"); f.tui.renderNow();
	f.terminal.click(close.x, close.y); f.terminal.click(tab.x, tab.y);
	assert.equal(f.tui.hasOverlay(), true, "controls cannot act while a bracketed paste is incomplete");
	f.terminal.input("\x1b[201~"); f.tui.renderNow();
	assert.match(f.lines().join("\n"), /Send to: First/);
	f.terminal.resize(24, 32); f.tui.renderNow();
	const lines = f.lines(), footer = lines.findIndex((line) => line.includes("enter: Send"));
	assert.doesNotMatch(lines.join("\n"), /Close|Request-reply/);
	const dots = lines[footer].indexOf("…");
	assert.ok(dots >= 0);
	f.terminal.click(f.bounds.col + dots, f.bounds.row + footer); await turn();
	assert.equal(sent.length, 0, "the ellipsis is not part of a clipped action");
	f.terminal.resize(100, 32); f.tui.renderNow();
	await f.click("Close");
	assert.deepEqual(f.results, [{ sent: false }]);
	await opening;
	assert.equal(sent.length, 0);
});

test("clickable Intercom hints: configured Alt submit and retry preserve the draft after a rejected send", async (t) => {
	const f = nativeUi(t, 100, 32, { "tui.select.confirm": "alt+enter" }), sent = [];
	const client = { send: async (to, options) => { sent.push({ to, ...options }); return sent.length === 1 ? { accepted: false, reason: "Peer unavailable" } : { id: "retry", accepted: true }; } };
	const opening = f.custom((tui, theme, keys, done) => new ComposeOverlay(tui, theme, keys, peers[0], peers[0].name, client, done));
	f.terminal.input("Keep the exact draft"); f.terminal.input("\x1b[13;3u"); await turn(); f.tui.renderNow();
	assert.equal(sent.length, 1, "the configured native key must not be discarded as an unknown escape sequence");
	assert.match(f.lines().join("\n"), /Peer unavailable/);
	assert.match(f.lines().join("\n"), /Keep the exact draft/);
	await f.click(`${process.platform === "darwin" ? "option" : "alt"}+enter: Send`);
	assert.equal(f.results.length, 1);
	await opening;
	assert.deepEqual(sent, [
		{ to: "first", text: "Keep the exact draft", expectsReply: false },
		{ to: "first", text: "Keep the exact draft", expectsReply: false },
	]);
});

test("clickable Intercom hints: topic arrows, page controls and Back use the native viewport", async (t) => {
	const f = nativeUi(t, 64, 18), entries = [];
	const ctx = { mode: "json", sessionManager: { getSessionId: () => "self", getEntries: () => entries } };
	const topics = new IntercomTopics({ appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }) }, () => ctx);
	topics.start(ctx);
	for (let i = 0; i < 12; i++) topics.publish({ topic: `work/${i}`, text: `Recorded topic ${i}\nDetails ${i}`, event: "update", revision: 1, updatedAt: i }, current);
	const opening = topics.open({ ...ctx, ui: { custom: f.custom } });
	const start = f.lines().join("\n");
	await f.click("↓"); const down = f.lines().join("\n");
	assert.notEqual(down, start);
	await f.click("↑"); assert.equal(f.lines().join("\n"), start);
	await f.click("PgDn Read"); const paged = f.lines().join("\n");
	assert.notEqual(paged, start); assert.notEqual(paged, down);
	await f.click("PgUp"); assert.equal(f.lines().join("\n"), start);
	f.terminal.resize(18, 18); f.tui.renderNow();
	const narrow = f.lines().join("\n");
	assert.doesNotMatch(narrow, /Esc Back/);
	await f.click("PgDn"); assert.notEqual(f.lines().join("\n"), narrow, "visible clipped page control still works");
	f.terminal.resize(64, 18); f.tui.renderNow();
	await f.click("Esc Back"); await opening;
	assert.equal(f.tui.hasOverlay(), false);
});
