import "../support/isolated-home.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../../src/pi-intercom/config.ts";

test("retired UI and enabled settings do not disable ordinary messaging", () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const agentDir = mkdtempSync(path.join(tmpdir(), "pi-intercom-config-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    mkdirSync(path.join(agentDir, "intercom"), { recursive: true });
    writeFileSync(
      path.join(agentDir, "intercom", "config.json"),
      JSON.stringify({ enabled: false, shortcut: "ctrl+shift+k", confirmSend: true }),
    );
    const config = loadConfig();
    assert.equal(config.brokerCommand, process.execPath);
    assert.deepEqual(config.brokerArgs, []);
    assert.equal(config.confirmSend, true);
    assert.equal("enabled" in config, false);
    assert.equal("shortcut" in config, false);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
    if (previous === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previous;
    }
  }
});
