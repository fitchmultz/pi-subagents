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

async function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(tmpdir(), "pi-agent-receipts-"));
  const manager = SessionManager.create(root, path.join(root, "sessions"));
  manager.appendMessage({ role: "user", content: "Publish native fixture history", timestamp: 1 });
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
  fs.writeFileSync(h.file, wrong);
  fs.appendFileSync(
    h.file,
    JSON.stringify({ type: "custom", id: "later", customType: "unrelated", data: {} }) + "\n",
  );
  assert.equal(published(h.context, h.launch), undefined, "growth cannot hide a changed prefix");
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
    fs.mkdirSync(path.join(configured, "async-subagent-results"), { recursive: true });
    fs.writeFileSync(
      path.join(configured, "async-subagent-results", "legacy-run.json"),
      JSON.stringify({ runId: "legacy-run", sessionId: "foreign", output: "Warm ignored input" }),
    );
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
    assert.deepEqual(legacyNotifications(h.context), [], "warm the safe directory first");
    if (boundary === "root") {
      fs.renameSync(configured, path.join(scratch, "previous"));
      fs.mkdirSync(path.join(outside, "async-subagent-results"));
      fs.symlinkSync(outside, configured, "dir");
    } else {
      fs.renameSync(
        path.join(configured, "async-subagent-results"),
        path.join(scratch, "previous"),
      );
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
  fs.writeFileSync(corrupt, JSON.stringify({ sessionId: "foreign", output: "Previously ignored" }));
  assert.deepEqual(legacyNotifications(h.context), []);
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
  const repaired = JSON.stringify({
    runId: "corrupt-legacy",
    sessionId: h.launch.owner,
    output: "Repaired",
  });
  fs.writeFileSync(corrupt, repaired);
  deliver(h.pi, h.context, legacyNotifications(h.context));
  assert.equal(
    fs.readFileSync(corrupt, "utf8"),
    repaired,
    "repair is not retired on send acceptance",
  );
  await h.session.waitForIdle();
  assert.deepEqual(
    h.manager
      .getEntries()
      .flatMap((entry) =>
        entry.type === "custom_message" && entry.customType === "subagent-notify"
          ? [entry.content]
          : [],
      ),
    [raw, repaired],
    "changed malformed input recovers through actual native publication",
  );
  deliver(h.pi, h.context, legacyNotifications(h.context));
  assert.equal(fs.existsSync(corrupt), false);
  assert.equal(errors.callCount, 2, "repair adds no errors");
});

for (const change of ["same-size", "replacement", "growth", "shrink"] as const) {
  test(`foreign legacy body reads are bounded until changed input: ${change}`, async (t) => {
    const h = await fixture(t);
    const directory = path.join(resolveTempRootDir(), "async-subagent-results");
    fs.mkdirSync(directory, { recursive: true });
    const id = `foreign-${change}`;
    const hint = path.join(directory, id + ".json");
    const foreign = JSON.stringify(
      {
        runId: id,
        sessionId: "x".repeat(h.launch.owner.length),
        mode: "single",
        timestamp: 7,
        output: "Literal saved output\n" + "x".repeat(1024 * 1024),
      },
      null,
      2,
    );
    fs.writeFileSync(hint, foreign);
    fs.utimesSync(hint, 1234567890, 1234567890);
    const before = fs.lstatSync(hint, { bigint: true });
    const reads = spy(fs, "readFileSync");
    syncBuiltinESMExports();
    t.after(() => {
      reads.restore();
      syncBuiltinESMExports();
      fs.rmSync(hint, { force: true });
    });
    assert.deepEqual(legacyNotifications(h.context), []);
    assert.equal(reads.withArgs(hint).callCount, 1, "classify the real foreign body");
    for (let tick = 0; tick < 25; tick++) {
      assert.deepEqual(legacyNotifications(h.context), []);
    }
    assert.equal(
      reads.withArgs(hint).callCount,
      1,
      "unchanged foreign input must not be reread on every poll",
    );
    assert.equal(
      h.manager.getEntries().some((entry) => entry.type === "custom_message"),
      false,
    );
    const priorNotices: string[] = [];
    if (change === "same-size") {
      const peer = path.join(directory, "zz-owned-peer.json");
      const peerRaw = JSON.stringify({
        runId: "zz-owned-peer",
        sessionId: h.launch.owner,
        output: "Peer",
      });
      fs.writeFileSync(peer, peerRaw);
      t.after(() => fs.rmSync(peer, { force: true }));
      const names = fs.readdirSync(directory);
      assert.ok(names.indexOf(path.basename(hint)) < names.indexOf(path.basename(peer)));
      deliver(h.pi, h.context, legacyNotifications(h.context));
      assert.equal(fs.existsSync(peer), true, "peer send acceptance is not retirement");
      await h.session.waitForIdle();
      assert.deepEqual(
        h.manager
          .getEntries()
          .flatMap((entry) =>
            entry.type === "custom_message" && entry.customType === "subagent-notify"
              ? [entry.content]
              : [],
          ),
        [peerRaw],
        "an ignored cache hit cannot drop the later owned peer's actual native publication",
      );
      deliver(h.pi, h.context, legacyNotifications(h.context));
      assert.equal(fs.existsSync(peer), false, "the published peer retires normally");
      assert.equal(fs.existsSync(hint), true);
      assert.equal(
        reads.withArgs(hint).callCount,
        1,
        "valid peer processing never rereads the foreign body",
      );
      priorNotices.push(peerRaw);
    }
    assert.equal(fs.readFileSync(hint, "utf8"), foreign, "foreign bytes stay untouched");
    let owned = foreign.replace("x".repeat(h.launch.owner.length), h.launch.owner);
    if (change === "growth") {
      owned += "\n ";
    } else if (change === "shrink") {
      owned = owned.replace("x".repeat(1024 * 1024), "short literal output");
    }
    const target = change === "replacement" ? hint + ".next" : hint;
    fs.writeFileSync(target, owned);
    fs.utimesSync(target, 1234567890, 1234567890);
    if (change === "replacement") {
      fs.renameSync(target, hint);
    }
    const after = fs.lstatSync(hint, { bigint: true });
    assert.equal(after.mtimeNs, before.mtimeNs, "mtime is deliberately restored");
    if (change === "same-size" || change === "replacement") {
      assert.equal(after.size, before.size);
    }
    if (change === "replacement") {
      assert.notEqual(after.ino, before.ino, "replacement really changes inode");
    } else {
      assert.notEqual(after.ctimeNs, before.ctimeNs, "in-place mutation changes ctime");
    }
    const notices = legacyNotifications(h.context);
    assert.equal(notices.length, 1, "changed foreign input is reclassified for its current owner");
    assert.equal(
      notices[0]?.message.content,
      owned,
      "publish exact literal bytes, not parsed JSON",
    );
    deliver(h.pi, h.context, notices);
    assert.equal(fs.readFileSync(hint, "utf8"), owned, "send acceptance is not retirement");
    await h.session.waitForIdle();
    assert.deepEqual(
      h.manager
        .getEntries()
        .flatMap((entry) =>
          entry.type === "custom_message" && entry.customType === "subagent-notify"
            ? [entry.content]
            : [],
        ),
      [...priorNotices, owned],
      "the actual native SDK publishes each literal completion exactly once",
    );
    deliver(h.pi, h.context, legacyNotifications(h.context));
    assert.equal(fs.existsSync(hint), false, "actual matching receipt retires unchanged input");
    assert.equal(fs.existsSync(path.join(resolveTempRootDir(), "async-subagent-runs", id)), false);
  });
}

test("warm ignored legacy files refuse symlinks and retry input changed during classification", async (t) => {
  const h = await fixture(t);
  const directory = path.join(resolveTempRootDir(), "async-subagent-results");
  fs.mkdirSync(directory, { recursive: true });
  const hint = path.join(directory, "warm-boundary.json");
  const outside = path.join(directory, "outside-saved.txt");
  const foreign = JSON.stringify({
    runId: "warm-boundary",
    sessionId: "foreign",
    output: "Ignored",
  });
  const raw = JSON.stringify({
    runId: "warm-boundary",
    sessionId: h.launch.owner,
    output: "Actual",
  });
  fs.writeFileSync(hint, foreign);
  assert.deepEqual(legacyNotifications(h.context), []);
  fs.writeFileSync(outside, raw);
  fs.unlinkSync(hint);
  fs.symlinkSync(outside, hint);
  t.after(() => {
    fs.rmSync(hint, { force: true });
    fs.rmSync(outside, { force: true });
  });
  const reads = spy(fs, "readFileSync");
  syncBuiltinESMExports();
  try {
    assert.deepEqual(legacyNotifications(h.context), []);
    assert.equal(reads.withArgs(hint).callCount, 0, "never follow the warm file symlink");
    assert.equal(fs.readFileSync(outside, "utf8"), raw);
  } finally {
    reads.restore();
    syncBuiltinESMExports();
  }
  fs.unlinkSync(hint);
  fs.writeFileSync(hint, foreign);
  const read = fs.readFileSync;
  const changing = stub(fs, "readFileSync").callsFake((...args: Parameters<typeof read>) => {
    const result = read(...args);
    if (args[0] === hint) {
      fs.writeFileSync(hint, raw);
    }
    return result;
  });
  syncBuiltinESMExports();
  try {
    assert.deepEqual(
      legacyNotifications(h.context),
      [],
      "first classification saw the foreign bytes",
    );
    assert.equal(changing.withArgs(hint).callCount, 1, "observe the actual classification read");
  } finally {
    changing.restore();
    syncBuiltinESMExports();
  }
  const notices = legacyNotifications(h.context);
  assert.equal(
    notices[0]?.message.content,
    raw,
    "changed-during-read input cannot be cached as ignored",
  );
  deliver(h.pi, h.context, notices);
  assert.equal(fs.readFileSync(hint, "utf8"), raw);
  await h.session.waitForIdle();
  deliver(h.pi, h.context, legacyNotifications(h.context));
  assert.equal(fs.existsSync(hint), false);
  assert.equal(fs.readFileSync(outside, "utf8"), raw, "outside saved bytes are never consumed");
});

test("ignored legacy classification follows the actual current session owner", async (t) => {
  const h = await fixture(t);
  const other = await fixture(t);
  const directory = path.join(resolveTempRootDir(), "async-subagent-results");
  fs.mkdirSync(directory, { recursive: true });
  const hint = path.join(directory, "owner-switch.json");
  const raw = JSON.stringify({
    runId: "owner-switch",
    sessionId: other.launch.owner,
    output: "Saved",
  });
  fs.writeFileSync(hint, raw);
  t.after(() => fs.rmSync(hint, { force: true }));
  assert.deepEqual(legacyNotifications(h.context), []);
  assert.deepEqual(legacyNotifications(h.context), []);
  h.manager.setSessionFile(other.file);
  try {
    assert.equal(legacyNotifications(h.context)[0]?.message.content, raw);
  } finally {
    h.manager.setSessionFile(h.file);
  }
  assert.deepEqual(
    legacyNotifications(h.context),
    [],
    "the original owner still cannot consume it",
  );
  deliver(other.pi, other.context, legacyNotifications(other.context));
  assert.equal(fs.readFileSync(hint, "utf8"), raw);
  await other.session.waitForIdle();
  deliver(other.pi, other.context, legacyNotifications(other.context));
  assert.equal(fs.existsSync(hint), false);
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
