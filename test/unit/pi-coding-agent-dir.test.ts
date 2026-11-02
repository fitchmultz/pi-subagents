import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { test as nodeTest } from "node:test";
import { getPiAgentDir } from "../../src/pi-intercom/agent-dir.ts";

nodeTest("native agent directory follows dynamic environment overrides and home expansion", (t) => {
  const original = process.env.PI_CODING_AGENT_DIR;
  t.after(() => {
    if (original === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = original;
    }
  });
  for (const [value, expected] of [
    ["/tmp/isolated-agent", "/tmp/isolated-agent"],
    ["~", os.homedir()],
    ["~/custom-agent-dir", path.join(os.homedir(), "custom-agent-dir")],
    ["", path.join(os.homedir(), ".pi", "agent")],
  ]) {
    process.env.PI_CODING_AGENT_DIR = value;
    assert.equal(getPiAgentDir(), expected);
  }
  delete process.env.PI_CODING_AGENT_DIR;
  assert.equal(getPiAgentDir(), path.join(os.homedir(), ".pi", "agent"));
});
