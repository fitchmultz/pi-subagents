import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { SessionListOverlay } from "../../src/pi-intercom/ui/session-list.ts";
import type { SessionInfo } from "../../src/pi-intercom/types.ts";

const current: SessionInfo = { id: "current-session", name: "controller", cwd: "/repo", model: "model-a" };
const sessions: SessionInfo[] = Array.from({ length: 12 }, (_, index) => ({
  id: `worker-session-${index}`,
  name: `worker-${index}`,
  cwd: index === 0 ? "/repo" : `/very/long/project/path/${index}`,
  model: `model-${index}`,
}));
const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
const keybindings = {
  matches: (data: string, action: string) => action === "tui.select.cancel" && data === "\x1b",
  getKeys: (action: string) => action === "tui.select.confirm" ? ["Enter"] : ["Escape"],
};

function assertWidth(lines: string[], width: number): void {
  for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${line}`);
}

test("session list delegates selection, scrolling, and truncation to SelectList", () => {
  let renderRequests = 0;
  let selected: SessionInfo | undefined;
  const overlay = new SessionListOverlay(
    { requestRender: () => { renderRequests += 1; } } as never,
    theme as never,
    keybindings as never,
    current,
    sessions,
    (result) => { selected = result; },
  );

  const normal = overlay.render(88);
  assert.match(normal.join("\n"), /Current Session[\s\S]*controller[\s\S]*Other Sessions[\s\S]*worker-0[\s\S]*model-0/);
  assertWidth(normal, 88);

  for (let index = 0; index < 9; index++) overlay.handleInput("\x1b[B");
  const paged = overlay.render(50);
  assert.match(paged.join("\n"), /\(10\/12\)/);
  assert.match(paged.join("\n"), /worker-9/);
  assertWidth(paged, 50);

  const narrow = overlay.render(20);
  assertWidth(narrow, 20);
  overlay.handleInput("\r");
  assert.equal(selected?.id, "worker-session-9");
  assert.equal(renderRequests, 10);
});

test("empty session list keeps chrome and cancel behavior", () => {
  let cancelled = false;
  let renderRequests = 0;
  const overlay = new SessionListOverlay(
    { requestRender: () => { renderRequests += 1; } } as never,
    theme as never,
    keybindings as never,
    current,
    [],
    () => { cancelled = true; },
  );

  const lines = overlay.render(32);
  assert.match(lines.join("\n"), /Current Session[\s\S]*Other Sessions[\s\S]*No other intercom/);
  assertWidth(lines, 32);
  overlay.handleInput("\x1b");
  assert.equal(cancelled, true);
  assert.equal(renderRequests, 1);
});
