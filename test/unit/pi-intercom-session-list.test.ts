import "../support/isolated-home.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { createTestTerminal } from "../support/terminal.ts";
import { createPlainTheme } from "../support/ui.ts";
import { SessionListOverlay } from "../../src/pi-intercom/ui/session-list.ts";
import type { SessionInfo } from "../../src/pi-intercom/types.ts";

const current: SessionInfo = {
  id: "current-session",
  name: "controller",
  cwd: "/repo",
  model: "model-a",
};
const sessions: SessionInfo[] = Array.from({ length: 12 }, (_, index) => ({
  id: `worker-session-${index}`,
  name: `worker-${index}`,
  cwd: index === 0 ? "/repo" : `/very/long/project/path/${index}`,
  model: `model-${index}`,
}));
const theme = createPlainTheme();
const keybindings = new KeybindingsManager();

function assertWidth(lines: readonly string[], width: number): void {
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${line}`);
  }
}

test("session list delegates selection, scrolling, and truncation to SelectList", () => {
  let selected: SessionInfo | undefined;
  const overlay = new SessionListOverlay(new TuiAltScreen(createTestTerminal(88, 30)), theme, {
    keybindings,
    currentSession: current,
    sessions,
    done(result) {
      selected = result;
    },
  });

  const normal = overlay.render(88);
  assert.match(
    normal.join("\n"),
    /Current Session[\s\S]*controller[\s\S]*Other Sessions[\s\S]*worker-0[\s\S]*model-0/,
  );
  assertWidth(normal, 88);

  for (let index = 0; index < 9; index++) {
    overlay.handleInput("\x1b[B");
  }
  const paged = overlay.render(50);
  assert.match(paged.join("\n"), /\(10\/12\)/);
  assert.match(paged.join("\n"), /worker-9/);
  assertWidth(paged, 50);

  const narrow = overlay.render(20);
  assertWidth(narrow, 20);
  overlay.handleInput("\r");
  assert.equal(selected?.id, "worker-session-9");
});

test("project-scoped session list explains how to reveal hidden projects", () => {
  const overlay = new SessionListOverlay(new TuiAltScreen(createTestTerminal(88, 30)), theme, {
    keybindings,
    currentSession: current,
    sessions: [],
    hiddenSessionCount: 3,
    done() {
      /* This display-only case does not accept a selection. */
    },
  });

  const lines = overlay.render(88);
  assert.match(lines.join("\n"), /No other sessions in this project/);
  assert.match(lines.join("\n"), /3 in other projects hidden/);
  assert.match(lines.join("\n"), /\/intercom all/);
  assertWidth(lines, 88);
});

test("empty session list keeps chrome and cancel behavior", () => {
  let cancelled = false;
  const overlay = new SessionListOverlay(new TuiAltScreen(createTestTerminal(88, 30)), theme, {
    keybindings,
    currentSession: current,
    sessions: [],
    done() {
      cancelled = true;
    },
  });

  const lines = overlay.render(32);
  assert.match(lines.join("\n"), /Current Session[\s\S]*Other Sessions[\s\S]*No other intercom/);
  assertWidth(lines, 32);
  overlay.handleInput("\x1b");
  assert.equal(cancelled, true);
});
