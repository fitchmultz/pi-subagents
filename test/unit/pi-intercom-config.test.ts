import "../support/isolated-home.ts";
import { test as nodeTest, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../../src/pi-intercom/config.ts";

function configFile(t: TestContext, content: Readonly<Record<string, unknown>>): string {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const agentDir = mkdtempSync(path.join(tmpdir(), "pi-intercom-config-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    rmSync(agentDir, { recursive: true, force: true });
    if (previous === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previous;
    }
  });
  mkdirSync(path.join(agentDir, "intercom"), { recursive: true });
  const file = path.join(agentDir, "intercom", "config.json");
  writeFileSync(file, JSON.stringify(content));
  return file;
}

nodeTest("retired UI and enabled settings do not disable ordinary messaging", (t) => {
  configFile(t, { enabled: false, shortcut: "ctrl+shift+k", confirmSend: true });
  const config = loadConfig();
  assert.equal(config.brokerCommand, process.execPath);
  assert.deepEqual(config.brokerArgs, []);
  assert.equal(config.confirmSend, true);
  assert.equal("enabled" in config, false);
  assert.equal("shortcut" in config, false);
  assert.equal(config.device, undefined);
  assert.deepEqual(config.otherDevices, [], "no device is reachable until one is configured");
});

nodeTest("device aliases load, and a name that ssh would read as an option is refused", (t) => {
  const file = configFile(t, {
    device: "desk",
    otherDevices: ["desk", "laptop", "phone.tailnet.example"],
  });
  const shared = loadConfig();
  assert.equal(shared.device, "desk");
  assert.deepEqual(
    shared.otherDevices,
    ["laptop", "phone.tailnet.example"],
    "a list shared by every device skips the device's own alias",
  );

  for (const [key, value] of [
    ["device", "-oProxyCommand=id"],
    ["otherDevices", ["laptop", "-oProxyCommand=id"]],
    ["otherDevices", ["laptop", "user@host"]],
    ["otherDevices", "laptop"],
  ] as const) {
    writeFileSync(file, JSON.stringify({ device: "desk", otherDevices: ["laptop"], [key]: value }));
    const reports: string[] = [];
    const config = loadConfig((message) => reports.push(message));
    assert.equal(reports.length, 1, JSON.stringify(value));
    assert.equal(reports[0]?.includes(`"${key}" must be`), true, reports[0]);
    assert.equal(config.device, undefined);
    assert.deepEqual(config.otherDevices, []);
  }
});
