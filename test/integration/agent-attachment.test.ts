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

test("recurring reconciliation errors report once, retry, and report again after recovery", async (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "agent-reporting-"));
  const manager = SessionManager.create(root, path.join(root, "sessions"));
  const base = ownerDirectory(getPiAgentDir(), manager.getSessionId());
  const native = await createNativeSessionFixture({
    cwd: root,
    agentDir: getPiAgentDir(),
    sessionManager: manager,
    configure: agents,
  });
  fs.chmodSync(base, 0);
  assert.throws(() => fs.readdirSync(base), { code: "EACCES" });
  const scans = spy(fs, "readdirSync");
  syncBuiltinESMExports();
  const errors = spy(console, "error");
  t.after(async () => {
    fs.chmodSync(base, 0o700);
    scans.restore();
    syncBuiltinESMExports();
    errors.restore();
    await native.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    await native.dispose();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(base, { recursive: true, force: true });
  });
  const reports = () =>
    errors.args.filter(([message]) =>
      String(message).includes("Agent completion reconciliation: EACCES:"),
    ).length;
  await until(
    () => scans.withArgs(base).callCount >= 3,
    "reconciliation retries the failed directory",
    5_000,
  );
  assert.equal(reports(), 1);
  fs.chmodSync(base, 0o700);
  await until(
    () =>
      scans
        .withArgs(base)
        .getCalls()
        .some((call) => call.exception === undefined),
    "successful reconciliation",
    5_000,
  );
  // Explicit native settlement requests another scan after the recovered pass.
  fs.chmodSync(base, 0);
  await native.session.extensionRunner.emit({ type: "agent_settled", aborted: false });
  await until(() => reports() === 2, "a new failure episode is reported", 5_000);
});

test("native UI context receives one reconciliation notice instead of terminal output", async (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "agent-ui-reporting-"));
  const manager = SessionManager.create(root, path.join(root, "sessions"));
  const base = ownerDirectory(getPiAgentDir(), manager.getSessionId());
  const native = await createNativeSessionFixture({
    cwd: root,
    agentDir: getPiAgentDir(),
    sessionManager: manager,
    configure: agents,
    bindExtensions: false,
  });
  const notices: string[] = [];
  const ui = native.session.extensionRunner.getUIContext();
  await native.session.bindExtensions({
    mode: "rpc",
    uiContext: {
      ...ui,
      notify: (message) => {
        notices.push(message);
      },
    },
  });
  fs.chmodSync(base, 0);
  assert.throws(() => fs.readdirSync(base), { code: "EACCES" });
  const scans = spy(fs, "readdirSync");
  syncBuiltinESMExports();
  const errors = spy(console, "error");
  t.after(async () => {
    fs.chmodSync(base, 0o700);
    scans.restore();
    syncBuiltinESMExports();
    errors.restore();
    await native.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    await native.dispose();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(base, { recursive: true, force: true });
  });
  await until(
    () => scans.withArgs(base).callCount >= 3,
    "reconciliation retries while UI is attached",
    5_000,
  );
  assert.equal(notices.length, 1);
  assert.match(notices[0] ?? "", /Agent completion reconciliation: EACCES:/);
  assert.equal(errors.callCount, 0);
});

test("an unreadable watched run reports safely and resumes completion recovery", async (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "agent-watch-reporting-"));
  const manager = SessionManager.create(root, path.join(root, "sessions"));
  const owner = manager.getSessionId();
  const base = ownerDirectory(getPiAgentDir(), owner);
  const id = "pending-run";
  const run = path.join(base, id);
  write(path.join(run, "launch.json"), {
    ...usageLaunch(path.join(root, "unused-child.jsonl")),
    owner,
    id,
    rootId: id,
  });
  const native = await createNativeSessionFixture({
    cwd: root,
    agentDir: getPiAgentDir(),
    sessionManager: manager,
    configure: agents,
    bindExtensions: false,
  });
  const notices: string[] = [];
  const ui = native.session.extensionRunner.getUIContext();
  const watches = spy(fs, "watch");
  const errors = spy(console, "error");
  syncBuiltinESMExports();
  t.after(async () => {
    fs.chmodSync(base, 0o700);
    watches.restore();
    syncBuiltinESMExports();
    errors.restore();
    await native.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    await native.dispose();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(base, { recursive: true, force: true });
  });
  await native.session.bindExtensions({
    mode: "rpc",
    uiContext: {
      ...ui,
      notify: (message) => {
        notices.push(message);
      },
    },
  });
  await until(() => watches.withArgs(run).callCount > 0, "pending run watch is armed", 5_000);
  fs.chmodSync(base, 0);
  assert.throws(() => fs.statSync(run), { code: "EACCES" });
  await native.session.extensionRunner.emit({ type: "agent_settled", aborted: false });
  await until(
    () => notices.some((message) => message.includes(`Agent directory watch ${run}: EACCES:`)),
    "the watched-directory failure is reported",
    5_000,
  );
  fs.chmodSync(base, 0o700);
  write(path.join(run, "result.json"), { owner, id, status: "completed", endedAt: 20 });
  fs.writeFileSync(path.join(run, "output.txt"), "Recovered output");
  await until(
    () =>
      manager
        .getEntries()
        .some(
          (entry) =>
            entry.type === "custom_message" &&
            entry.customType === "agent-completion" &&
            record(entry.details).id === id,
        ),
    "the completed run is published after permissions recover",
    5_000,
  );
  assert.equal(errors.callCount, 0);
});
