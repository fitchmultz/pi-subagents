import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { afterEach, test, type TestContext } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { spy } from "sinon";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { JsonObject, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { createNativeSessionFixture } from "../support/native-session.ts";
import { registerUsage } from "../../src/agent/usage.ts";

const usage = {
  input: 10,
  output: 20,
  cacheRead: 30,
  cacheWrite: 40,
  cacheWrite1h: 15,
  reasoning: 5,
  totalTokens: 100,
  cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
};
const a = { id: "child:a", provider: "provider", model: "actual-response", usage };
const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()));
});

async function harness(manager = SessionManager.inMemory(process.cwd(), { id: "parent" })) {
  const native = await createNativeSessionFixture({
    cwd: process.cwd(),
    agentDir: process.env.HOME ?? process.cwd(),
    sessionManager: manager,
    bindExtensions: false,
    configure: registerUsage,
  });
  disposals.push(native.dispose);
  const errors: string[] = [];
  native.session.extensionRunner.onError((error) => {
    errors.push(error.error);
  });
  const finalize = async (agentUsage: JsonObject[]) => {
    const message: ToolResultMessage = {
      role: "toolResult",
      toolName: "agent_runs",
      toolCallId: "wait",
      isError: false,
      timestamp: 0,
      content: [{ type: "text", text: "done" }],
      details: { agentUsage },
    };
    const finalized =
      (await native.session.extensionRunner.emitMessageEnd({ type: "message_end", message })) ??
      message;
    assert.equal(finalized.role, "toolResult");
    return finalized;
  };
  return {
    manager,
    errors,
    finalize,
    persist: (message: Message) => manager.appendMessage(message),
  };
}

async function diskHarness(t: TestContext) {
  const root = fs.mkdtempSync(path.join(tmpdir(), "pi-parent-usage-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = SessionManager.create(root, path.join(root, "sessions"));
  manager.appendMessage({ role: "user", content: "x".repeat(1024 * 1024), timestamp: 1 });
  const file = manager.getSessionFile();
  assert.ok(file !== undefined);
  return { ...(await harness(manager)), file };
}

test("native usage finalization reads only the published suffix after ordinary appends", async (t) => {
  const h = await diskHarness(t);
  const { manager, file } = h;
  assert.deepEqual((await h.finalize([a])).usage, usage, "warm without reserving a charge");
  const writer = SessionManager.open(file);
  const before = fs.statSync(file).size;
  writer.appendMessage(await h.finalize([a]));
  const suffix = fs.statSync(file).size - before;
  const entries = spy(manager, "getEntries");
  const reads = spy(fs, "readSync");
  syncBuiltinESMExports();
  try {
    assert.equal((await h.finalize([a])).usage, undefined);
    const bytes = reads.getCalls().reduce((total, call) => total + call.returnValue, 0);
    t.diagnostic(`native usage append: ${suffix} bytes; readSync: ${bytes} bytes`);
    assert.ok(bytes <= suffix + 4096, `native append of ${suffix} bytes reread ${bytes} bytes`);
    assert.equal(entries.callCount, 0, "published journals do not rescan stale native memory");
  } finally {
    entries.restore();
    reads.restore();
    syncBuiltinESMExports();
  }
  assert.deepEqual(h.errors, []);
});

test("physical usage authority follows LF, edits, replacement, shrink and malformed recovery with stale memory", async (t) => {
  const h = await diskHarness(t);
  const before = fs.readFileSync(h.file, "utf8");
  assert.deepEqual((await h.finalize([a])).usage, usage);
  assert.deepEqual((await h.finalize([a])).usage, usage, "discarding cannot reserve a charge");
  SessionManager.open(h.file).appendMessage(await h.finalize([a]));
  const complete = fs.readFileSync(h.file, "utf8");
  assert.equal((await h.finalize([a])).usage, undefined);
  fs.writeFileSync(h.file, complete.trimEnd());
  assert.deepEqual((await h.finalize([a])).usage, usage, "a missing LF unpublishes the charge");
  fs.appendFileSync(h.file, "\n");
  assert.equal((await h.finalize([a])).usage, undefined);
  const wrong = complete.replace("actual-response", "other--response");
  assert.equal(Buffer.byteLength(wrong), Buffer.byteLength(complete));
  fs.writeFileSync(h.file, wrong);
  assert.equal((await h.finalize([a])).usage, undefined);
  assert.match(h.errors.pop() ?? "", /Conflicting native usage/);
  fs.writeFileSync(h.file, complete);
  assert.equal((await h.finalize([a])).usage, undefined);
  fs.appendFileSync(h.file, "not JSON\n");
  assert.equal((await h.finalize([a])).usage, undefined);
  assert.match(h.errors.pop() ?? "", /Invalid JSONL/);
  fs.writeFileSync(h.file, complete);
  assert.equal((await h.finalize([a])).usage, undefined, "a failed scan does not poison recovery");
  fs.writeFileSync(h.file + ".replacement", before);
  fs.renameSync(h.file + ".replacement", h.file);
  assert.deepEqual((await h.finalize([a])).usage, usage, "replacement removes the old charge");
  fs.writeFileSync(h.file, complete);
  assert.equal((await h.finalize([a])).usage, undefined);
  fs.writeFileSync(h.file, before);
  assert.deepEqual((await h.finalize([a])).usage, usage, "shrink removes the old charge");
  assert.equal(
    h.manager
      .getEntries()
      .some((entry) => entry.type === "message" && entry.message.role === "toolResult"),
    false,
    "the observing manager never loaded the charge",
  );
  assert.deepEqual(h.errors, []);
});

test("non-persistent native managers retain memory usage authority when attached to a source file", async (t) => {
  const source = await diskHarness(t);
  const manager = SessionManager.inMemory(process.cwd());
  manager.setSessionFile(source.file);
  assert.equal(manager.isPersisted(), false);
  const h = await harness(manager);
  const before = fs.readFileSync(source.file, "utf8");
  h.persist(await h.finalize([a]));
  assert.equal(fs.readFileSync(source.file, "utf8"), before, "the source is not published to");
  assert.equal((await h.finalize([a])).usage, undefined, "native memory owns this new charge");
  assert.deepEqual(h.errors, []);
});

test("details alone, custom messages and mismatched top-level usage are not portable receipts", async () => {
  const h = await harness();
  h.persist({ ...(await h.finalize([a])), usage: undefined });
  h.manager.appendCustomMessageEntry("agent-notify", "done", false, { agentUsage: [a] });
  h.persist({ ...(await h.finalize([a])), usage: { ...usage, output: 999 } });
  assert.deepEqual((await h.finalize([a])).usage, usage);
  h.persist(await h.finalize([a]));
  assert.equal((await h.finalize([a])).usage, undefined);
  assert.deepEqual(h.errors, []);
});

test("conflicting and empty native IDs cannot publish accounting; optional fields survive JSON receipts", async () => {
  const h = await harness();
  assert.deepEqual(
    (await h.finalize([a, a])).usage,
    usage,
    "identical contributions in one result charge once",
  );
  assert.equal((await h.finalize([a, { ...a, model: "other" }])).usage, undefined);
  assert.match(h.errors.pop() ?? "", /Conflicting native usage/);
  assert.equal((await h.finalize([{ ...a, id: "" }])).usage, undefined);
  assert.notEqual(
    h.errors.pop(),
    undefined,
    "native dispatch exposes invalid contribution instead of charging",
  );
  const { reasoning: _reasoning, cacheWrite1h: _cacheWrite1h, ...basic } = usage;
  const optional = { ...a, usage: basic };
  h.persist(await h.finalize([optional]));
  assert.equal((await h.finalize([optional])).usage, undefined);
  assert.equal((await h.finalize([a])).usage, undefined);
  assert.match(h.errors.pop() ?? "", /Conflicting native usage/);
  assert.deepEqual(h.errors, []);
});
