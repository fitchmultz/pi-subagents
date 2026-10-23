import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { test, type TestContext } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { spy, stub } from "sinon";
import { deliver, notifications, published, settle } from "../../src/agent/notifications.ts";
import { write } from "../../src/agent/storage.ts";
import { legacyNotifications } from "../../src/agent/legacy.ts";
import { resolveTempRootDir } from "../../src/shared/types.ts";
import { createNativeSessionFixture } from "../support/native-session.ts";
import { usageLaunch } from "../support/agent-launch.ts";
import { record } from "../support/assertions.ts";

async function fixture(t: TestContext, content = "Publish native fixture history") {
  const root = fs.mkdtempSync(path.join(tmpdir(), "pi-agent-receipts-"));
  const manager = SessionManager.create(root, path.join(root, "sessions"));
  manager.appendMessage({ role: "user", content, timestamp: 1 });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Fixture history" }],
    api: "openai-completions",
    provider: "fixture",
    model: "fixture",
    timestamp: 2,
    stopReason: "stop",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  const native = await createNativeSessionFixture({
    cwd: root,
    agentDir: root,
    sessionManager: manager,
  });
  t.after(async () => {
    await native.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const file = manager.getSessionFile();
  assert.notEqual(file, undefined);
  if (file === undefined) {
    throw new Error("Native fixture did not create a session file");
  }
  const launch = { ...usageLaunch(file), owner: manager.getSessionId() };
  return { ...native, manager, file, launch };
}

test("physical parent receipt authority follows LF, prefix replacement, inode, shrink and recovery, not stale memory", async (t) => {
  const h = await fixture(t);
  const before = fs.readFileSync(h.file, "utf8");
  const receiptId = h.manager.appendCustomMessageEntry(
    "agent-completion",
    "Literal result",
    false,
    {
      owner: h.launch.owner,
      id: "run",
      completed: true,
    },
  );
  const complete = fs.readFileSync(h.file, "utf8");
  const entryCount = h.manager.getEntries().length;
  assert.equal(published(h.context, h.launch), receiptId);
  const reads = spy(fs, "readSync");
  syncBuiltinESMExports();
  try {
    for (let i = 0; i < 10; i++) {
      assert.equal(published(h.context, h.launch), receiptId);
    }
    assert.equal(reads.callCount, 0, "unchanged journals are not reread by completion polling");
  } finally {
    reads.restore();
    syncBuiltinESMExports();
  }
  const stat = fs.statSync(h.file);
  const wrong = complete.replace(
    `"owner":"${h.launch.owner}"`,
    `"owner":"${"x".repeat(h.launch.owner.length)}"`,
  );
  assert.notEqual(wrong, complete);
  assert.equal(Buffer.byteLength(wrong), Buffer.byteLength(complete));
  fs.writeFileSync(h.file, wrong);
  fs.utimesSync(h.file, stat.atime, stat.mtime);
  assert.equal(
    published(h.context, h.launch),
    undefined,
    "same-size/stamp edit invalidates physical authority",
  );
  fs.writeFileSync(h.file, complete);
  assert.equal(published(h.context, h.launch), receiptId, "restore the valid cached prefix");
  // Same-inode growth follows the native append-only contract. An outside prefix
  // edit followed by an append between observations is outside that contract.
  SessionManager.open(h.file).appendMessage({
    role: "user",
    content: "native append",
    timestamp: 3,
  });
  assert.equal(published(h.context, h.launch), receiptId);
  fs.writeFileSync(h.file + ".replacement", complete);
  fs.renameSync(h.file + ".replacement", h.file);
  assert.equal(published(h.context, h.launch), receiptId, "replacement inode is inspected");
  fs.writeFileSync(h.file, before);
  assert.equal(published(h.context, h.launch), undefined, "truncation removes a former receipt");
  fs.appendFileSync(h.file, complete.slice(before.length).trimEnd());
  assert.equal(published(h.context, h.launch), undefined, "valid JSON without LF is unpublished");
  fs.appendFileSync(h.file, "\n");
  assert.equal(published(h.context, h.launch), receiptId);
  fs.appendFileSync(h.file, "not JSON\n");
  assert.throws(() => published(h.context, h.launch), SyntaxError);
  fs.writeFileSync(h.file, complete);
  assert.equal(published(h.context, h.launch), receiptId, "a failed scan does not poison recovery");
  assert.equal(
    h.manager.getEntries().length,
    entryCount,
    "all external transitions occurred with stale native memory",
  );
});

test("native migration and a later append invalidate warmed physical receipt IDs", async (t) => {
  const h = await fixture(t);
  const before = h.manager.appendCustomMessageEntry("agent-completion", "done", false, {
    owner: h.launch.owner,
    id: h.launch.id,
    completed: true,
  });
  const legacy = fs
    .readFileSync(h.file, "utf8")
    .replace('"version":3', '"version":1')
    .replace(`"id":"${before}"`, '"id":"legacy-receipt"');
  fs.writeFileSync(h.file, legacy);
  assert.equal(published(h.context, h.launch), "legacy-receipt", "warm the valid legacy prefix");
  const warmed = fs.statSync(h.file, { bigint: true });
  const migrated = SessionManager.open(h.file);
  const receipt = migrated
    .getEntries()
    .find((entry) => entry.type === "custom_message" && entry.customType === "agent-completion");
  assert.ok(receipt);
  assert.notEqual(receipt.id, "legacy-receipt", "native v1 migration assigns new entry IDs");
  migrated.appendMessage({ role: "user", content: "after migration", timestamp: 3 });
  const after = fs.statSync(h.file, { bigint: true });
  assert.ok(after.size > warmed.size, "the native rewrite plus append grew the warmed journal");
  t.diagnostic(`native migration replaced inode: ${after.ino !== warmed.ino}`);
  assert.ok(
    fs
      .readFileSync(h.file, "utf8")
      .split("\n")
      .slice(0, -1)
      .some((line) => record(JSON.parse(line)).id === receipt.id),
    "the migrated ID is physically LF-published",
  );
  assert.equal(published(h.context, h.launch), receipt.id, "native memory is still stale");
  assert.ok(h.manager.getEntry(before), "the former receipt remains in the old manager");
});

test("native receipt reconciliation reads only the published suffix after ordinary appends", async (t) => {
  const h = await fixture(t, "x".repeat(1024 * 1024));
  const receipt = h.manager.appendCustomMessageEntry("agent-completion", "done", false, {
    owner: h.launch.owner,
    id: h.launch.id,
    completed: true,
  });
  assert.equal(published(h.context, h.launch), receipt);
  for (let i = 0; i < 3; i++) {
    const before = fs.statSync(h.file).size;
    const launch = { ...h.launch, id: `run-${i}` };
    const appended = h.manager.appendCustomMessageEntry("agent-completion", "later", false, {
      owner: launch.owner,
      id: launch.id,
      completed: true,
    });
    const suffix = fs.statSync(h.file).size - before;
    const reads = spy(fs, "readSync");
    syncBuiltinESMExports();
    try {
      assert.equal(published(h.context, launch), appended, "the new physical receipt is indexed");
      assert.equal(published(h.context, h.launch), receipt);
      const bytes = reads.getCalls().reduce((total, call) => total + call.returnValue, 0);
      t.diagnostic(`native receipt append: ${suffix} bytes; readSync: ${bytes} bytes`);
      assert.ok(bytes <= suffix + 4096, `native append of ${suffix} bytes reread ${bytes} bytes`);
    } finally {
      reads.restore();
      syncBuiltinESMExports();
    }
  }
});

test("native recovery publishes a completion backlog chronologically once, then polls history without rereads", async (t) => {
  const h = await fixture(t);
  const base = path.join(path.dirname(h.file), "runs");
  const child = path.join(base, "child.jsonl");
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(
    child,
    `${JSON.stringify({ type: "session", id: "child" })}\n${JSON.stringify({ type: "custom", id: "terminal", customType: "fixture", data: {} })}`,
  );
  for (const [id, endedAt] of [
    ["z-original", 10],
    ["a-continuation", 20],
  ] as const) {
    const launch = {
      ...h.launch,
      id,
      rootId: "z-original",
      createdAt: endedAt - 1,
      sessionFile: child,
    };
    write(path.join(base, id, "launch.json"), launch);
    write(path.join(base, id, "result.json"), {
      id,
      owner: launch.owner,
      status: "completed",
      endedAt,
    });
    fs.writeFileSync(path.join(base, id, "output.txt"), `Result ${id}`);
  }
  deliver(h.pi, h.context, notifications(h.context, base, h.launch.owner));
  await h.session.waitForIdle();
  settle(h.launch.owner, h.context.hasPendingMessages());
  deliver(h.pi, h.context, notifications(h.context, base, h.launch.owner));
  await h.session.waitForIdle();
  const ids = h.manager
    .getEntries()
    .flatMap((entry) =>
      entry.type === "custom_message" && entry.customType === "agent-completion"
        ? [record(entry.details).id]
        : [],
    );
  assert.deepEqual(ids, ["z-original", "a-continuation"]);

  const scan = () => notifications(h.context, base, h.launch.owner);
  assert.deepEqual(scan(), [], "settled history is observed after native publication");
  const opened = spy(fs, "openSync");
  const reads = spy(fs, "readSync");
  syncBuiltinESMExports();
  try {
    for (let i = 0; i < 10; i++) {
      assert.deepEqual(scan(), []);
    }
    assert.equal(opened.callCount, 0, "unchanged delivered history opens no run or journal file");
    assert.equal(reads.callCount, 0, "unchanged delivered history reads no bytes");
  } finally {
    opened.restore();
    reads.restore();
    syncBuiltinESMExports();
  }

  const launchFile = path.join(base, "a-continuation", "launch.json");
  const savedLaunch = fs.readFileSync(launchFile, "utf8");
  write(launchFile, { ...record(JSON.parse(savedLaunch)), owner: "foreign" });
  assert.throws(scan, /Missing saved launch or foreign run owner/);
  fs.writeFileSync(launchFile, savedLaunch);
  assert.deepEqual(scan(), [], "restoring the warmed launch recovers without a second notice");

  const resultFile = path.join(base, "a-continuation", "result.json");
  const settled = fs.readFileSync(resultFile, "utf8");
  const stat = fs.statSync(resultFile);
  fs.writeFileSync(resultFile, settled.replace('"completed"', '"completed!'));
  fs.utimesSync(resultFile, stat.atime, stat.mtime);
  assert.throws(scan, SyntaxError, "a same-size in-place edit is revalidated");
  write(resultFile, { id: "a-continuation", owner: "foreign", status: "completed", endedAt: 20 });
  assert.throws(scan, /Foreign canonical result identity/);
  write(resultFile, {
    id: "a-continuation",
    owner: h.launch.owner,
    status: "completed",
    endedAt: 20,
    accountingPending: { terminalCandidate: "terminal", baseline: [] },
  });
  assert.deepEqual(scan(), [], "the completion receipt still suppresses a second notice");
  assert.deepEqual(scan(), []);
  assert.ok("accountingPending" in record(JSON.parse(fs.readFileSync(resultFile, "utf8"))));
  fs.appendFileSync(child, "\n");
  assert.deepEqual(scan(), []);
  const repaired = record(JSON.parse(fs.readFileSync(resultFile, "utf8")));
  assert.equal("accountingPending" in repaired, false, "repair retries after the receipt");
  assert.equal(repaired.terminalEntryId, "terminal");
  assert.deepEqual(repaired.contributions, []);

  const journal = fs.readFileSync(h.file, "utf8");
  const firstReceipt = journal.indexOf('"customType":"agent-completion"');
  fs.writeFileSync(h.file, journal.slice(0, journal.lastIndexOf("\n", firstReceipt) + 1));
  assert.deepEqual(
    scan().map((notice) => notice.id),
    ["z-original", "a-continuation"],
    "removed receipts renotify unchanged history chronologically",
  );
});

const legacyCases = [
  { name: "owner absent notice", received: true, kind: "notice", owner: "absent" },
  { name: "current owner notice", received: true, kind: "notice", owner: "current" },
  { name: "foreign owner notice", received: false, kind: "notice", owner: "foreign" },
  { name: "historical intercom receipt", received: true, kind: "intercom", owner: "current" },
  { name: "completed whole wait", received: true, kind: "wait", status: "completed" },
  {
    name: "completed single-child zero wait",
    received: true,
    kind: "wait",
    status: "completed",
    index: 0,
  },
  { name: "nonmatching child wait", received: false, kind: "wait", status: "completed", index: 1 },
  { name: "failed tool wait", received: false, kind: "wait", status: "completed", failed: true },
  { name: "pending wait", received: false, kind: "wait", status: "pending" },
  { name: "launch-only receipt", received: false, kind: "launch" },
] as const;

for (const boundary of ["root", "results"] as const) {
  test(`legacy receipt consumption refuses a symlinked ${boundary} directory`, async (t) => {
    const h = await fixture(t);
    const scratch = fs.mkdtempSync(path.join(tmpdir(), "pi-legacy-boundary-"));
    const configured = path.join(scratch, "pi-subagents-root");
    const outside = path.join(scratch, "outside");
    fs.mkdirSync(outside);
    if (boundary === "root") {
      fs.mkdirSync(path.join(outside, "async-subagent-results"));
      fs.symlinkSync(outside, configured, "dir");
    } else {
      fs.mkdirSync(configured);
      fs.symlinkSync(outside, path.join(configured, "async-subagent-results"), "dir");
    }
    const target = path.join(
      boundary === "root" ? path.join(outside, "async-subagent-results") : outside,
      "legacy-run.json",
    );
    const raw = JSON.stringify({
      runId: "legacy-run",
      sessionId: h.launch.owner,
      mode: "single",
      timestamp: 7,
    });
    fs.writeFileSync(target, raw);
    h.manager.appendCustomMessageEntry("subagent-notify", "Published", false, {
      completion: {
        runId: "legacy-run",
        key: "completion:legacy:legacy-run:7",
        ownerSessionId: h.launch.owner,
      },
    });
    const prior = process.env.PI_SUBAGENT_TEMP_ROOT;
    process.env.PI_SUBAGENT_TEMP_ROOT = configured;
    t.after(() => {
      if (prior === undefined) {
        delete process.env.PI_SUBAGENT_TEMP_ROOT;
      } else {
        process.env.PI_SUBAGENT_TEMP_ROOT = prior;
      }
      fs.rmSync(scratch, { recursive: true, force: true });
    });
    assert.throws(
      () => deliver(h.pi, h.context, legacyNotifications(h.context)),
      /Unsafe legacy recovery directory/,
    );
    assert.equal(
      fs.readFileSync(target, "utf8"),
      raw,
      "published receipts cannot authorize outside deletion",
    );
  });
}

test("a malformed legacy hint is logged and skipped without dropping valid legacy results", async (t) => {
  const h = await fixture(t);
  const directory = path.join(resolveTempRootDir(), "async-subagent-results");
  fs.mkdirSync(directory, { recursive: true });
  const corrupt = path.join(directory, "corrupt-legacy.json");
  const valid = path.join(directory, "valid-legacy.json");
  const raw = JSON.stringify({
    runId: "valid-legacy",
    sessionId: h.launch.owner,
    mode: "single",
    timestamp: 7,
    output: "Valid literal legacy output",
  });
  fs.writeFileSync(corrupt, '{"incomplete":');
  fs.writeFileSync(valid, raw);
  const errors = stub(console, "error");
  t.after(() => {
    errors.restore();
    fs.rmSync(corrupt, { force: true });
    fs.rmSync(valid, { force: true });
  });
  deliver(h.pi, h.context, legacyNotifications(h.context));
  await h.session.waitForIdle();
  assert.deepEqual(
    h.manager
      .getEntries()
      .flatMap((entry) =>
        entry.type === "custom_message" && entry.customType === "subagent-notify"
          ? [entry.content]
          : [],
      ),
    [raw],
    "the valid legacy result is published despite the malformed file",
  );
  deliver(h.pi, h.context, legacyNotifications(h.context));
  assert.equal(fs.existsSync(valid), false, "the published valid hint still retires");
  assert.equal(fs.readFileSync(corrupt, "utf8"), '{"incomplete":');
  assert.equal(errors.callCount, 2);
  assert.ok(errors.alwaysCalledWithMatch(corrupt), "each scan names the skipped file");
});

for (const scenario of legacyCases) {
  test(`sole legacy hint uses actual historical native receipt authority: ${scenario.name}`, async (t) => {
    const h = await fixture(t);
    const id = "legacy-run";
    const directory = path.join(resolveTempRootDir(), "async-subagent-results");
    fs.mkdirSync(directory, { recursive: true });
    const hint = path.join(directory, id + ".json");
    const raw = JSON.stringify({
      runId: id,
      sessionId: h.launch.owner,
      mode: "single",
      timestamp: 7,
      output: "Retained literal legacy output",
    });
    fs.writeFileSync(hint, raw);
    t.after(() => fs.rmSync(hint, { force: true }));
    if (scenario.kind === "notice" || scenario.kind === "intercom") {
      const completion = {
        runId: id,
        key: "completion:legacy:legacy-run:7",
        ...(scenario.owner === "absent"
          ? {}
          : { ownerSessionId: scenario.owner === "current" ? h.launch.owner : "foreign" }),
      };
      h.manager.appendCustomMessageEntry(
        scenario.kind === "notice" ? "subagent-notify" : "intercom",
        "Existing physical receipt",
        false,
        scenario.kind === "notice" ? { completion } : { subagentCompletion: completion },
      );
    } else {
      h.manager.appendMessage({
        role: "toolResult",
        toolName: "agent_runs",
        toolCallId: "historical",
        content: [{ type: "text", text: "Existing result" }],
        timestamp: 3,
        isError: "failed" in scenario && scenario.failed,
        details:
          scenario.kind === "launch"
            ? { asyncId: id }
            : {
                wait: {
                  runId: id,
                  status: scenario.status,
                  ...("index" in scenario ? { index: scenario.index } : {}),
                },
              },
      });
    }
    const before = h.manager.getEntries().length;
    deliver(h.pi, h.context, legacyNotifications(h.context));
    if (scenario.received) {
      assert.equal(fs.existsSync(hint), false);
      assert.equal(
        h.manager.getEntries().length,
        before,
        "published receipt suppresses any new native admission",
      );
    } else {
      assert.equal(
        fs.readFileSync(hint, "utf8"),
        raw,
        "send acceptance cannot retire the sole input",
      );
      await h.session.waitForIdle();
      const newNotices = h.manager
        .getEntries()
        .slice(before)
        .filter(
          (entry) => entry.type === "custom_message" && entry.customType === "subagent-notify",
        );
      assert.equal(
        newNotices.length,
        1,
        "actual SDK publishes the unsuppressed completion exactly once",
      );
      deliver(h.pi, h.context, legacyNotifications(h.context));
      assert.equal(fs.existsSync(hint), false);
    }
    assert.equal(
      fs.existsSync(path.join(resolveTempRootDir(), "async-subagent-runs", id)),
      false,
      "legacy consumption creates no owned run",
    );
  });
}
