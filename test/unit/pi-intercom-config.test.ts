import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../../src/pi-intercom/config.ts";
import { matchesKey } from "@earendil-works/pi-tui";

test("Agents shortcut defaults to Option/Alt+Shift+M and accepts native key identifiers", (t) => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const agentDir = mkdtempSync(path.join(tmpdir(), "pi-intercom-shortcut-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const defaultKey = loadConfig().shortcut;
    assert.equal(defaultKey, "alt+shift+m");
    assert.equal(matchesKey("\x1b[109;4u", defaultKey), true);
    assert.equal(matchesKey("\x1b[27;4;109~", defaultKey), true);
    assert.equal(matchesKey("\x1bM", defaultKey), false, "native Pi requires a terminal protocol that reports both modifiers");
    assert.equal(matchesKey("\r", defaultKey), false, "Enter must not open Agents");
    mkdirSync(path.join(agentDir, "intercom"), { recursive: true });
    const file = path.join(agentDir, "intercom", "config.json");
    for (const shortcut of ["ctrl+shift+k", "super+f2", "shift+pageDown", "ctrl+/"]) {
      writeFileSync(file, JSON.stringify({ shortcut }));
      assert.equal(loadConfig().shortcut, shortcut);
    }
    t.mock.method(console, "error", () => {});
    for (const shortcut of [false, 7, "", "hyper+m", "ctrl+ctrl+m", "alt+"]) {
      writeFileSync(file, JSON.stringify({ shortcut }));
      assert.equal(loadConfig().shortcut, defaultKey, "invalid configuration uses the existing default fallback");
    }
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("legacy enabled config is ignored in favor of pi config", () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const agentDir = mkdtempSync(path.join(tmpdir(), "pi-intercom-config-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    mkdirSync(path.join(agentDir, "intercom"), { recursive: true });
    writeFileSync(path.join(agentDir, "intercom", "config.json"), JSON.stringify({ enabled: false, confirmSend: true }));
    const config = loadConfig();
    assert.equal(config.brokerCommand, process.execPath);
    assert.deepEqual(config.brokerArgs, []);
    assert.equal(config.confirmSend, true);
    assert.equal("enabled" in config, false);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});
