import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  initTheme,
  type ExtensionUIContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  setKeybindings,
  Text,
  TuiAltScreen,
  stripTerminalSequences,
  visibleWidth,
  type Component,
  type OverlayHandle,
  type KeyId,
} from "@earendil-works/pi-tui";
import { SessionListOverlay } from "../../src/pi-intercom/ui/session-list.ts";
import { ComposeOverlay } from "../../src/pi-intercom/ui/compose.ts";
import type { SendResult } from "../../src/pi-intercom/types.ts";
import type { IntercomClient } from "../../src/pi-intercom/broker/client.ts";
type SendOptions = Parameters<IntercomClient["send"]>[1];
import { IntercomTopics } from "../../src/pi-intercom/topics.ts";
import { createTestTerminal } from "../support/terminal.ts";
import { makeExtensionContext } from "../support/helpers.ts";
import { createNativeSessionFixture } from "../support/native-session.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ReadonlyInput } from "../../src/shared/types/inputs.ts";

const { KeybindingsManager } =
  await import("../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js");
initTheme("dark", false);
const { theme: nativeTheme } =
  await import("../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js");
const turn = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
const current = { id: "self", name: "Parent", cwd: "/fixture", model: "fixture" };
const first = { ...current, id: "first", name: "First" };
const second = { ...current, id: "second", name: "Second" };
const peers = [first, second];

function nativeUi(
  t: TestContext,
  columns = 100,
  rows = 32,
  bindings: Readonly<Record<string, KeyId>> = {},
) {
  const terminal = createTestTerminal(columns, rows);
  const tui = new TuiAltScreen(terminal);
  const previous = getKeybindings(),
    keys = new KeybindingsManager(bindings);
  setKeybindings(keys);
  tui.addChild(new Text("Unchanged parent", 0, 0));
  let component: (Component & { readonly dispose?: () => void }) | undefined;
  let handle: OverlayHandle | undefined;
  const results: unknown[] = [];
  tui.start();
  t.after(() => {
    handle?.hide();
    component?.dispose?.();
    tui.stop();
    setKeybindings(previous);
  });
  const custom: ExtensionUIContext["custom"] = (factory, options) =>
    new Promise((resolve, reject) => {
      const mount = (view: Component & { readonly dispose?: () => void }) => {
        component = view;
        const overlayOptions =
          typeof options?.overlayOptions === "function"
            ? options.overlayOptions()
            : options?.overlayOptions;
        handle = tui.showOverlay(view, overlayOptions ?? { width: "96%", margin: 1 });
        options?.onHandle?.(handle);
        tui.renderNow();
      };
      const view = factory(tui, nativeTheme, keys, (value) => {
        results.push(value);
        handle?.hide();
        component?.dispose?.();
        resolve(value);
      });
      if (view instanceof Promise) {
        view.then(mount).catch(reject);
      } else {
        mount(view);
      }
    });
  const f = {
    tui,
    terminal,
    keys,
    results,
    custom,
    get component() {
      assert.ok(component, "overlay must be mounted");
      return component;
    },
    get bounds() {
      const bounds = handle?.getBounds();
      assert.ok(bounds, "native overlay must have published its bounds");
      return bounds;
    },
    lines() {
      tui.renderNow();
      return f.component.render(f.bounds.width).map(stripTerminalSequences);
    },
    point(text: string) {
      const lines = f.lines(),
        y = lines.findIndex((line) => line.includes(text));
      assert.ok(
        y >= 0 && y < f.bounds.height,
        `visible hint ${JSON.stringify(text)}:\n${lines.join("\n")}`,
      );
      return {
        x: f.bounds.col + visibleWidth(lines[y].slice(0, lines[y].indexOf(text) + text.length)) - 1,
        y: f.bounds.row + y,
      };
    },
    async click(text: string) {
      const { x, y } = f.point(text);
      terminal.click(x, y);
      await turn();
      tui.renderNow();
    },
  };
  return f;
}

for (const remapped of [false, true]) {
  test(`clickable Intercom hints: native peer selection, Message and Close (remapped: ${remapped})`, async (t) => {
    const f = nativeUi(
      t,
      100,
      32,
      remapped ? { "tui.select.confirm": "ctrl+g", "tui.select.cancel": "ctrl+e" } : {},
    );
    const opening = f.custom(
      (tui, theme, keys, done) =>
        new SessionListOverlay(tui, theme, {
          keybindings: keys,
          currentSession: current,
          sessions: peers,
          done,
        }),
    );
    f.terminal.input("\x1b[B");
    f.tui.renderNow();
    assert.match(f.lines().join("\n"), /→ Second/);
    await f.click(`${remapped ? "ctrl+g" : "enter"}: Message`);
    assert.deepEqual(f.results, [peers[1]], "Message activates the selected native row");
    await opening;
    assert.equal(f.tui.hasOverlay(), false);
    const rowOpening = f.custom(
      (tui, theme, keys, done) =>
        new SessionListOverlay(tui, theme, {
          keybindings: keys,
          currentSession: current,
          sessions: peers,
          done,
        }),
    );
    await f.click("Second (");
    assert.deepEqual(
      f.results,
      [peers[1], peers[1]],
      "the embedded native list receives mouse coordinates too",
    );
    await rowOpening;
    const empty = f.custom(
      (tui, theme, keys, done) =>
        new SessionListOverlay(tui, theme, {
          keybindings: keys,
          currentSession: current,
          sessions: [],
          done,
        }),
    );
    await f.click("Close");
    assert.equal(f.tui.hasOverlay(), false);
    await empty;
    assert.deepEqual(f.results, [peers[1], peers[1], undefined]);
  });
}

for (const remapped of [false, true]) {
  test(`clickable Intercom hints: compose modes and single explicit send (remapped: ${remapped})`, async (t) => {
    const f = nativeUi(
      t,
      100,
      32,
      remapped ? { "tui.select.confirm": "ctrl+g", "tui.select.cancel": "ctrl+e" } : {},
    );
    const sent: Array<ReadonlyInput<SendOptions> & { to: string }> = [];
    const delivery = Promise.withResolvers<SendResult>();
    const client: Pick<IntercomClient, "send"> = {
      send: async (to: string, options: ReadonlyInput<SendOptions>) => {
        sent.push({ to, ...options });
        return delivery.promise;
      },
    };
    const opening = f.custom(
      (tui, theme, keys, done) =>
        new ComposeOverlay(tui, theme, {
          keybindings: keys,
          target: first,
          targetLabel: first.name,
          client,
          done,
        }),
    );
    f.terminal.input("\x1b[200~\tLine 1\r\nLine 2\x1b[201~");
    f.tui.renderNow();
    await f.click("Tab: Request-reply mode");
    assert.match(f.lines().join("\n"), /Request reply to: First/);
    await f.click("Tab: Send mode");
    assert.match(f.lines().join("\n"), /Send to: First/);
    await f.click("Tab: Request-reply mode");
    const point = f.point(`${remapped ? "ctrl+g" : "enter"}: Request reply`);
    f.terminal.input(`\x1b[<0;${point.x + 1};${point.y + 1}M`);
    f.tui.renderNow();
    assert.equal(sent.length, 0, "press alone must not send");
    f.terminal.input(`\x1b[<0;${point.x + 1};${point.y + 1}m`);
    await turn();
    f.tui.renderNow();
    assert.deepEqual(sent, [{ to: "first", text: "\tLine 1\nLine 2", expectsReply: true }]);
    f.terminal.click(point.x, point.y);
    f.terminal.input("\r");
    f.terminal.input("\t");
    assert.equal(
      sent.length,
      1,
      "in-flight clicks and keys cannot duplicate a send or change its mode",
    );
    assert.match(f.lines().join("\n"), /Sending/);
    delivery.resolve({ id: "receipt", accepted: true, delivered: true });
    await opening;
    assert.deepEqual(f.results, [
      { sent: true, messageId: "receipt", text: "\tLine 1\nLine 2", expectsReply: true },
    ]);
    assert.ok(typeof f.component.handleInput === "function", "compose overlay handles input");
    f.component.handleInput("late input");
    assert.equal(sent.length, 1);
  });
}

test("clickable Intercom hints: Close cancels, clipped controls stay inert, and a paste cannot become an action", async (t) => {
  const f = nativeUi(t);
  const sent: Array<readonly [string, ReadonlyInput<SendOptions>]> = [];
  const client: Pick<IntercomClient, "send"> = {
    send: async (...args: readonly [string, ReadonlyInput<SendOptions>]) => {
      sent.push(args);
      return { id: "unused", accepted: true, delivered: true };
    },
  };
  const opening = f.custom(
    (tui, theme, keys, done) =>
      new ComposeOverlay(tui, theme, {
        keybindings: keys,
        target: first,
        targetLabel: first.name,
        client,
        done,
      }),
  );
  const close = f.point("Close"),
    tab = f.point("Tab: Request-reply mode");
  f.terminal.input("\x1b[200~partial paste");
  f.tui.renderNow();
  f.terminal.click(close.x, close.y);
  f.terminal.click(tab.x, tab.y);
  assert.equal(
    f.tui.hasOverlay(),
    true,
    "controls cannot act while a bracketed paste is incomplete",
  );
  f.terminal.input("\x1b[201~");
  f.tui.renderNow();
  assert.match(f.lines().join("\n"), /Send to: First/);
  f.terminal.resize(24, 32);
  f.tui.renderNow();
  const lines = f.lines(),
    footer = lines.findIndex((line) => line.includes("enter: Send"));
  assert.doesNotMatch(lines.join("\n"), /Close|Request-reply/);
  const dots = lines[footer].indexOf("…");
  assert.ok(dots >= 0);
  f.terminal.click(f.bounds.col + dots, f.bounds.row + footer);
  await turn();
  assert.equal(sent.length, 0, "the ellipsis is not part of a clipped action");
  f.terminal.resize(100, 32);
  f.tui.renderNow();
  await f.click("Close");
  assert.deepEqual(f.results, [{ sent: false }]);
  await opening;
  assert.equal(sent.length, 0);
});

test("clickable Intercom hints: configured Alt submit and retry preserve the draft after a rejected send", async (t) => {
  const f = nativeUi(t, 100, 32, { "tui.select.confirm": "alt+enter" });
  const sent: Array<ReadonlyInput<SendOptions> & { to: string }> = [];
  const client: Pick<IntercomClient, "send"> = {
    send: async (to: string, options: ReadonlyInput<SendOptions>) => {
      sent.push({ to, ...options });
      return sent.length === 1
        ? { id: "rejected", accepted: false, delivered: false, reason: "Peer unavailable" }
        : { id: "retry", accepted: true, delivered: true };
    },
  };
  const opening = f.custom(
    (tui, theme, keys, done) =>
      new ComposeOverlay(tui, theme, {
        keybindings: keys,
        target: first,
        targetLabel: first.name,
        client,
        done,
      }),
  );
  f.terminal.input("Keep the exact draft");
  f.terminal.input("\x1b[13;3u");
  await turn();
  f.tui.renderNow();
  assert.equal(
    sent.length,
    1,
    "the configured native key must not be discarded as an unknown escape sequence",
  );
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
  const f = nativeUi(t, 64, 18);
  const agentDir = mkdtempSync(path.join(tmpdir(), "intercom-hints-"));
  const manager = SessionManager.inMemory("/fixture", { id: "self" });
  const fixture = await createNativeSessionFixture({
    cwd: "/fixture",
    agentDir,
    sessionManager: manager,
  });
  t.after(async () => {
    await fixture.dispose();
    rmSync(agentDir, { recursive: true, force: true });
  });
  const ctx = makeExtensionContext("/fixture", { sessionManager: manager });
  const topics = new IntercomTopics(fixture.pi, () => ctx);
  topics.start(ctx);
  for (let i = 0; i < 12; i++) {
    topics.publish(
      {
        topic: `work/${i}`,
        text: `Recorded topic ${i}\nDetails ${i}`,
        event: "update",
        revision: 1,
        updatedAt: i,
      },
      current,
    );
  }
  const opening = topics.open({ ...ctx, ui: { ...ctx.ui, custom: f.custom } });
  const start = f.lines().join("\n");
  await f.click("↓");
  const down = f.lines().join("\n");
  assert.notEqual(down, start);
  await f.click("↑");
  assert.equal(f.lines().join("\n"), start);
  await f.click("PgDn Read");
  const paged = f.lines().join("\n");
  assert.notEqual(paged, start);
  assert.notEqual(paged, down);
  await f.click("PgUp");
  assert.equal(f.lines().join("\n"), start);
  f.terminal.resize(18, 18);
  f.tui.renderNow();
  const narrow = f.lines().join("\n");
  assert.doesNotMatch(narrow, /Esc Back/);
  await f.click("PgDn");
  assert.notEqual(f.lines().join("\n"), narrow, "visible clipped page control still works");
  f.terminal.resize(64, 18);
  f.tui.renderNow();
  await f.click("Esc Back");
  await opening;
  assert.equal(f.tui.hasOverlay(), false);
});
