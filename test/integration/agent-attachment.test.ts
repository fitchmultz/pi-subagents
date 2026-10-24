import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { spy } from "sinon";
import agents from "../../src/agent/index.ts";
import { attachmentSchema } from "../../src/agent/contracts.ts";
import { ownerDirectory, read, write } from "../../src/agent/storage.ts";
import { getPiAgentDir } from "../../src/pi-intercom/agent-dir.ts";
import { createNativeSessionFixture } from "../support/native-session.ts";
import { usageLaunch } from "../support/agent-launch.ts";
import { record } from "../support/assertions.ts";
import { until } from "../support/observation-child.ts";

test("native session_start publishes ownership without scanning runs, then tools and timer recover the backlog", async (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "agent-attachment-"));
  const manager = SessionManager.create(root, path.join(root, "sessions"));
  manager.appendMessage({ role: "user", content: "Synthetic owner", timestamp: 1 });
  const owner = manager.getSessionId();
  const base = ownerDirectory(getPiAgentDir(), owner);
  for (const [id, endedAt] of [
    ["later", 20],
    ["earlier", 10],
  ] as const) {
    write(path.join(base, id, "launch.json"), {
      ...usageLaunch(path.join(root, "unused-child.jsonl")),
      owner,
      id,
      rootId: id,
      createdAt: endedAt - 1,
    });
    write(path.join(base, id, "result.json"), {
      owner,
      id,
      status: "completed",
      endedAt,
    });
    fs.writeFileSync(path.join(base, id, "output.txt"), `Literal ${id} output`);
  }
  const native = await createNativeSessionFixture({
    cwd: root,
    agentDir: getPiAgentDir(),
    sessionManager: manager,
    configure: agents,
    bindExtensions: false,
  });
  t.after(async () => {
    await native.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    await native.dispose();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(base, { recursive: true, force: true });
  });
  const scans = spy(fs, "readdirSync");
  syncBuiltinESMExports();
  try {
    await native.session.bindExtensions({ mode: "print" });
    const attachment = read(path.join(base, "attachment.json"), attachmentSchema);
    assert.ok(attachment);
    assert.equal(attachment.attached, true);
    assert.equal(attachment.pid, process.pid);
    assert.ok(attachment.generation.length > 0);
    assert.equal(
      scans.withArgs(base).callCount,
      0,
      "run inventory must not block the awaited native session_start boundary",
    );
  } finally {
    scans.restore();
    syncBuiltinESMExports();
  }
  const runs = native.session.agent.state.tools.find((tool) => tool.name === "agent_runs");
  assert.ok(runs);
  const listed = record((await runs.execute("first-list", { action: "list" })).details);
  assert.equal(listed.total, 2, "the first needed tool sees the complete attached inventory");
  const receipts = () =>
    manager
      .getEntries()
      .flatMap((entry) =>
        entry.type === "custom_message" && entry.customType === "agent-completion" ? [entry] : [],
      );
  await until(() => receipts().length === 2, "timer publishes the recovered completions", 5_000);
  await native.session.waitForIdle();
  assert.deepEqual(
    receipts().map((entry) => record(entry.details).id),
    ["earlier", "later"],
  );
  assert.deepEqual(
    receipts().map((entry) => entry.content),
    [
      `Agent run earlier: completed. \nLiteral earlier output\nNative journal: ${path.join(root, "unused-child.jsonl")}`,
      `Agent run later: completed. \nLiteral later output\nNative journal: ${path.join(root, "unused-child.jsonl")}`,
    ],
  );
  await runs.execute("after-recovery", { action: "inspect", id: "earlier" });
  await native.session.waitForIdle();
  assert.equal(receipts().length, 2, "explicit reconciliation does not duplicate native receipts");
});
