import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { published } from "../../src/agent/notifications.ts";
import { notifyLegacy } from "../../src/agent/legacy.ts";
import { resolveTempRootDir } from "../../src/shared/types.ts";
import { createNativeSessionFixture } from "../support/native-session.ts";
import { usageLaunch } from "../support/agent-launch.ts";

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
    assert.throws(() => notifyLegacy(h.pi, h.context), /Unsafe legacy recovery directory/);
    assert.equal(
      fs.readFileSync(target, "utf8"),
      raw,
      "published receipts cannot authorize outside deletion",
    );
  });
}

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
    notifyLegacy(h.pi, h.context);
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
      notifyLegacy(h.pi, h.context);
      assert.equal(fs.existsSync(hint), false);
    }
    assert.equal(
      fs.existsSync(path.join(resolveTempRootDir(), "async-subagent-runs", id)),
      false,
      "legacy consumption creates no owned run",
    );
  });
}
