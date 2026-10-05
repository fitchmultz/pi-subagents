import { assertDefined, record, records, text } from "../support/assertions.ts";
import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import { findPackageJSON, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { createSubagentState } from "../support/background-fixtures.ts";
import type { TrackedOwnedRun } from "../../src/shared/types.ts";
import { createEventBus, createNativeSessionFixture, makeMinimalCtx } from "../support/helpers.ts";

const defined565_0 = findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url);
assertDefined(defined565_0);
const sdkRoot = process.env.PI_INTERCOM_TEST_SDK ?? path.dirname(defined565_0);
process.env.PI_PACKAGE_DIR = sdkRoot;
assert.equal(
  fs.realpathSync(sdkRoot),
  fs.realpathSync(path.dirname(defined565_0)),
  "selected host must match the installed SDK graph",
);
const { SessionManager, DefaultResourceLoader, SettingsManager, createAgentSession } =
  await import("@earendil-works/pi-coding-agent");
const nativeRoot = fs.mkdtempSync(path.join(tmpdir(), "resume-cost-sdk-"));
const native = await createNativeSessionFixture({ cwd: nativeRoot, agentDir: nativeRoot });
after(async () => {
  await native.dispose();
  fs.rmSync(nativeRoot, { recursive: true, force: true });
});
const { createCompletionDelivery } =
  await import("../../src/runs/background/completion-delivery.ts");
const { registerParentUsage } = await import("../../src/runs/shared/parent-usage.ts");
const { createParentReceiptReader } = await import("../../src/runs/shared/parent-receipts.ts");
const { saveAsyncRunResult, getRunMetadataDir, saveQuestionOwner, createSupervisorQuestion } =
  await import("../../src/runs/shared/supervisor-questions.ts");
const { saveForegroundRun } = await import("../../src/runs/shared/run-records.ts");
const { JsonProjection } = await import("../../src/shared/journal-reader.ts");

test("native session startup services input during archive discovery and restores only its own runs and questions", async (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "subagent-startup-cost-"));
  const prefix = path.basename(root),
    foreignCount = 2048;
  const manager = SessionManager.inMemory(root);
  const runId = `${prefix}-owned`;
  const run: TrackedOwnedRun = {
    runId,
    rootRunId: runId,
    ownerSessionId: manager.getSessionId(),
    source: "foreground",
    mode: "single",
    cwd: root,
    task: "Retain saved work",
    startedAt: 1,
    children: [{ agent: "worker", index: 0 }],
    review: { decision: "accepted", reviewedAt: 2 },
  };
  manager.appendCustomEntry("subagent-run", run);
  saveForegroundRun({
    runId,
    mode: "single",
    cwd: root,
    results: [
      {
        agent: "worker",
        task: run.task,
        exitCode: 0,
        finalOutput: "Saved report",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
      },
    ],
  });
  saveQuestionOwner(runId, manager.getSessionId());
  const question = createSupervisorQuestion({
    runId,
    ownerTarget: "fixture",
    agent: "worker",
    index: 0,
    childSessionId: "child",
    childTarget: "child",
    sessionFile: path.join(root, "child.jsonl"),
    cwd: root,
    pid: process.pid,
    reason: "need_decision",
    message: "Keep this question available.",
  });
  for (let index = 0; index < foreignCount; index++) {
    saveQuestionOwner(`${prefix}-foreign-${index}`, "another-parent");
  }
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir: path.join(root, "agent"),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [path.resolve("src/extension/index.ts")],
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const { session } = await createAgentSession({
    cwd: root,
    agentDir: path.join(root, "agent"),
    settingsManager,
    resourceLoader,
    sessionManager: manager,
    noTools: "builtin",
  });
  t.after(async () => {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  });
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    for (const id of [
      runId,
      ...Array.from({ length: foreignCount }, (_, index) => `${prefix}-foreign-${index}`),
    ]) {
      fs.rmSync(getRunMetadataDir(id), { recursive: true, force: true });
    }
  });
  const open = fs.openSync;
  let foreignReads = 0,
    running = true,
    input: NodeJS.Immediate;
  const readsAtInput: number[] = [];
  t.mock.method(fs, "openSync", (...args: Readonly<Parameters<typeof fs.openSync>>) => {
    if (
      String(args[0]).includes(`${prefix}-foreign-`) &&
      String(args[0]).endsWith("question-owner.json")
    ) {
      foreignReads++;
    }
    return Reflect.apply(open, fs, args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const serviceInput = () => {
    readsAtInput.push(foreignReads);
    if (running) {
      input = setImmediate(serviceInput);
    }
  };
  input = setImmediate(serviceInput);
  const errors: unknown[] = [];
  try {
    await session.bindExtensions({
      mode: "print",
      onError: (error) => {
        errors.push(error);
      },
    });
  } finally {
    running = false;
    const defined5134_0 = input;
    assertDefined(defined5134_0);
    clearImmediate(defined5134_0);
  }
  assert.equal(foreignReads, foreignCount, "each unrelated owner is classified once");
  assert.ok(
    readsAtInput.some((count) => count > 0 && count < foreignCount),
    "input must run before the archive census finishes",
  );
  assert.deepEqual(errors, []);
  const defined5427_0 = session.agent.state.tools.find((tool) => tool.name === "agent_runs");
  assertDefined(defined5427_0);
  const controls = defined5427_0;
  assert.ok(Boolean(controls), "restored questions keep controls available");
  const listed = await controls.execute(
    "owned-list",
    { action: "list" },
    new AbortController().signal,
  );
  assert.deepEqual(
    records(record(listed.details).runs).map((entry) => entry.runId),
    [runId],
    "foreign archives cannot establish ownership",
  );
  const questions = await controls.execute(
    "owned-questions",
    { action: "questions" },
    new AbortController().signal,
  );
  assert.deepEqual(
    records(record(questions.details).questions).map((entry) => entry.questionId),
    [question.questionId],
  );
});

test("resuming legacy delivered runs parses old parent receipts once and never rehydrates unrelated output or resends completions", async (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "subagent-resume-cost-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = SessionManager.create(root, path.join(root, "sessions"));
  manager.appendMessage({
    role: "user",
    content: "Synthetic isolated session",
    timestamp: Date.now(),
  });
  const historicalIds = new Set<string>();
  for (let index = 0; index < 6; index++) {
    historicalIds.add(
      manager.appendMessage({
        role: "toolResult",
        isError: false,
        toolName: "subagent",
        toolCallId: `old-${index}`,
        timestamp: Date.now(),
        content: [{ type: "text", text: "historical result" }],
        details: { blob: "x".repeat(256 * 1024) },
      }),
    );
  }
  const runs = new Map<string, TrackedOwnedRun>(),
    usage = {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
  for (let index = 0; index < 8; index++) {
    const runId = `resume-${path.basename(root)}-${index}`,
      completionId = `done-${index}`;
    t.after(() => fs.rmSync(getRunMetadataDir(runId), { recursive: true, force: true }));
    const run: TrackedOwnedRun = {
      runId,
      rootRunId: runId,
      ownerSessionId: manager.getSessionId(),
      source: "async",
      mode: "single",
      cwd: root,
      task: "Synthetic work",
      startedAt: Date.now(),
      children: [{ agent: "worker", index: 0 }],
      delivery: { notifiedAt: Date.now(), intercomDelivered: true },
    };
    manager.appendCustomEntry("subagent-run", run);
    manager.appendCustomMessageEntry("intercom_message", "Already delivered", true, {
      subagentCompletion: { runId, completionId },
    });
    saveAsyncRunResult(runId, {
      id: runId,
      completionId,
      mode: "single",
      sessionId: manager.getSessionId(),
      state: "complete",
      success: true,
      timestamp: Date.now(),
      results: [
        {
          agent: "worker",
          success: true,
          exitCode: 0,
          output: "Finished",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            turns: 1,
            contributions: [{ id: `native-${index}`, provider: "faux", model: "faux", usage }],
          },
        },
      ],
    });
    runs.set(runId, run);
  }
  const sessionFile = manager.getSessionFile();
  assertDefined(sessionFile);
  const fileBytes = fs.statSync(sessionFile).size;
  let parsedChars = 0,
    historicalLookups = 0,
    historicalBodyReads = 0,
    guardedHistoricalEntries = 0,
    ownerWrites = 0,
    sent = 0,
    ownerWritesAtInput: number | undefined;
  const write: unknown = Reflect.get(JsonProjection.prototype, "write");
  assert.ok(typeof write === "function");
  t.mock.method(
    JsonProjection.prototype,
    "write",
    function (this: InstanceType<typeof JsonProjection>, chunk: string | symbol) {
      if (typeof chunk === "string") {
        parsedChars += chunk.length;
      }
      Reflect.apply(write, this, [chunk]);
    },
  );
  const getEntry = manager.getEntry.bind(manager);
  const getEntries = manager.getEntries.bind(manager),
    guarded = new WeakMap<SessionEntry, SessionEntry>();
  const guard = (entry: SessionEntry | undefined) => {
    if (
      !entry ||
      !historicalIds.has(entry.id) ||
      !Object.getOwnPropertyDescriptor(entry, "message")?.get
    ) {
      return entry;
    }
    let proxy = guarded.get(entry);
    if (!proxy) {
      proxy = new Proxy(entry, {
        get(target, key, receiver) {
          if (key === "message") {
            historicalBodyReads++;
          }
          return Reflect.get(target, key, receiver);
        },
      });
      guarded.set(entry, proxy);
      guardedHistoricalEntries++;
    }
    return proxy;
  };
  t.mock.method(manager, "getEntries", () => getEntries().map(guard));
  t.mock.method(manager, "getEntry", (id: string) => {
    if (historicalIds.has(id)) {
      historicalLookups++;
    }
    return guard(getEntry(id));
  });
  const pi = {
    ...native.pi,
    events: createEventBus(),
    sendMessage() {
      sent++;
    },
  };
  const state = {
    ...createSubagentState(root),
    currentSessionId: manager.getSessionId(),
    ownedRuns: runs,
    foregroundRuns: new Map(),
    completionSeen: new Map(),
    lastUiContext: makeMinimalCtx(root, { sessionManager: manager }),
    persistOwnedRun(run: unknown) {
      ownerWrites++;
      if (ownerWrites === 1) {
        setImmediate(() => {
          ownerWritesAtInput = ownerWrites;
        });
      }
      manager.appendCustomEntry("subagent-run", run);
    },
  };
  const delivery = createCompletionDelivery(
    pi,
    state,
    registerParentUsage(pi, ["subagent", "delegate", "agent_runs"]),
  );
  try {
    delivery.start();
    const deadline = performance.now() + 5000;
    while (
      [...runs.values()].some(
        (run) => run.accounting?.state !== "pending" || !((run.delivery?.entryId ?? "").length > 0),
      )
    ) {
      assert.ok(performance.now() < deadline, "all legacy runs finish reconciliation");
      // Observe the owner publication before advancing this lifecycle transition.
      // oxlint-disable-next-line no-await-in-loop
      await delay(10);
    }
    delivery.stop();
    assert.equal(ownerWrites, 16, "each legacy run saves delivery identity and accounting once");
    assert.ok(
      ownerWritesAtInput !== undefined && ownerWritesAtInput < 16,
      "native input is serviced before the recovery batch finishes",
    );
    assert.equal(sent, 0, "published completions never queue another model turn");
    assert.ok(
      [...runs.values()].every((run) => run.accounting?.state === "pending"),
      "custom receipts never fabricate finalized tool-result billing",
    );
    assert.ok(
      parsedChars < fileBytes * 3,
      `${parsedChars} parsed characters: two compact indexes, not one full parse per run`,
    );
    assert.equal(
      historicalLookups,
      0,
      "published billing fields do not look up unrelated historical results",
    );
    if (guardedHistoricalEntries !== 0 && !Number.isNaN(guardedHistoricalEntries)) {
      assert.equal(
        guardedHistoricalEntries,
        historicalIds.size,
        "the lazy-host guard covers every unrelated historical result",
      );
      assert.equal(
        historicalBodyReads,
        0,
        "bulk native references and anchor checks do not hydrate lazy historical bodies",
      );
    } else {
      t.diagnostic("Host entries are eager; the lazy-body hydration check was not exercised.");
    }
    t.diagnostic(
      `${fileBytes} journal bytes; ${parsedChars} parsed characters; ${historicalLookups} historical result lookups; ${guardedHistoricalEntries} guarded lazy entries; ${historicalBodyReads} lazy body reads.`,
    );
    delivery.start();
    await delay(30);
    delivery.stop();
    assert.equal(ownerWrites, 16, "a second start does not migrate completed runs again");
    assert.equal(sent, 0);
  } finally {
    delivery.stop();
  }
});

test("unchanged completion hits share verified parent bytes only within each synchronous recovery batch", async (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "subagent-receipt-batch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = SessionManager.create(root, path.join(root, "sessions"));
  manager.appendMessage({
    role: "assistant",
    api: "faux",
    content: [{ type: "text", text: "x".repeat(1024 * 1024) }],
    provider: "faux",
    model: "faux",
    stopReason: "stop",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: 0,
  });
  const { RESULTS_DIR } = await import("../../src/shared/types.ts");
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const hints = Array.from({ length: 8 }, (_, index) => {
    const runId = `batch-${path.basename(root)}-${index}`;
    manager.appendMessage({
      role: "toolResult",
      isError: false,
      toolName: "delegate",
      toolCallId: runId,
      timestamp: 0,
      content: [{ type: "text", text: "Completed" }],
      details: { wait: { runId, status: "completed" } },
    });
    const file = path.join(RESULTS_DIR, `${runId}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify({
        id: runId,
        sessionId: manager.getSessionId(),
        success: true,
        summary: "Completed",
      }),
    );
    t.after(() => fs.rmSync(file, { force: true }));
    return file;
  });
  const defined14686_0 = manager.getSessionFile();
  assertDefined(defined14686_0);
  const parentFile = defined14686_0,
    parentStat = fs.statSync(parentFile),
    read = fs.readSync;
  // Full-suite processes share RESULTS_DIR. Measure this fixture's eight-hit
  // scan, not foreign hints that can legitimately split its four-file batches.
  const readDirectory = fs.readdirSync,
    hintNames = new Set(hints.map((file) => path.basename(file)));
  const listing = t.mock.method(fs, "readdirSync", (directory: fs.PathLike) => {
    const names = readDirectory(directory);
    return directory === RESULTS_DIR ? names.filter((name) => hintNames.has(name)) : names;
  });
  let parentBytes = 0,
    sent = 0;
  const mock = t.mock.method(
    fs,
    "readSync",
    (fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
      const count = read(fd, buffer, offset, length, position);
      const stat = fs.fstatSync(fd);
      if (stat.dev === parentStat.dev && stat.ino === parentStat.ino) {
        parentBytes += count;
      }
      return count;
    },
  );
  syncBuiltinESMExports();
  t.after(() => {
    mock.mock.restore();
    listing.mock.restore();
    syncBuiltinESMExports();
  });
  const pi = {
    ...native.pi,
    events: createEventBus(),
    sendMessage() {
      sent++;
    },
  };
  const state = {
    ...createSubagentState(root),
    currentSessionId: manager.getSessionId(),
    ownedRuns: new Map(),
    completionSeen: new Map(),
    lastUiContext: makeMinimalCtx(root, { sessionManager: manager }),
  };
  const delivery = createCompletionDelivery(pi, state, registerParentUsage(pi, []));
  try {
    delivery.start();
    const deadline = performance.now() + 5000;
    while (hints.some((file) => fs.existsSync(file))) {
      assert.ok(performance.now() < deadline, "published results retire all hints");
      // Observe the owner publication before advancing this lifecycle transition.
      // oxlint-disable-next-line no-await-in-loop
      await delay(10);
    }
    assert.equal(sent, 0);
    assert.ok(
      parentBytes <= parentStat.size * 3,
      `${parentBytes} bytes for eight hits: one initial parse/hash, then one hash per yielded batch`,
    );
    assert.ok(parentBytes >= parentStat.size * 2, "publication proof is not skipped");
    t.diagnostic(
      `${parentStat.size} parent bytes; ${parentBytes} bytes read for eight unchanged receipt hits`,
    );
  } finally {
    delivery.stop();
  }
});

test("awaited delivery refreshes verified receipts even when only external journal bytes changed", async (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "subagent-receipt-await-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = SessionManager.create(root, path.join(root, "sessions"));
  manager.appendMessage({
    role: "assistant",
    api: "faux",
    content: [{ type: "text", text: "Ready" }],
    provider: "faux",
    model: "faux",
    stopReason: "stop",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: 0,
  });
  const runId = `await-${path.basename(root)}`,
    completionId = `done-${runId}`,
    run: TrackedOwnedRun = {
      runId,
      rootRunId: runId,
      ownerSessionId: manager.getSessionId(),
      source: "async",
      mode: "single",
      cwd: root,
      task: "Done",
      startedAt: 0,
      children: [],
    };
  t.after(() => fs.rmSync(getRunMetadataDir(runId), { recursive: true, force: true }));
  saveAsyncRunResult(runId, {
    id: runId,
    sessionId: manager.getSessionId(),
    completionId,
    success: true,
    summary: "Done",
    results: [],
    intercomTarget: "parent",
  });
  const events = createEventBus();
  let relay: { requestId: string } | undefined,
    notices = 0;
  events.on("subagent:result-intercom", (request) => {
    const payload = record(request);
    relay = { requestId: text(payload.requestId) };
  });
  const pi = {
    ...native.pi,
    events,
    sendMessage() {
      notices++;
    },
  };
  const state = {
    ...createSubagentState(root),
    currentSessionId: manager.getSessionId(),
    ownedRuns: new Map([[runId, run]]),
    completionSeen: new Map(),
    lastUiContext: makeMinimalCtx(root, { sessionManager: manager }),
  };
  const delivery = createCompletionDelivery(pi, state, registerParentUsage(pi, []));
  try {
    delivery.start();
    const deadline = performance.now() + 5000;
    while (!relay) {
      assert.ok(performance.now() < deadline, "delivery enters its async tail");
      // Observe the owner publication before advancing this lifecycle transition.
      // oxlint-disable-next-line no-await-in-loop
      await delay(10);
    }
    const leaf = manager.getLeafId(),
      count = manager.getEntryCount();
    const file = manager.getSessionFile();
    assertDefined(file);
    fs.appendFileSync(
      file,
      JSON.stringify({
        type: "custom_message",
        id: "external-receipt",
        parentId: leaf,
        timestamp: new Date().toISOString(),
        customType: "intercom_message",
        details: { subagentCompletion: { runId, completionId } },
        content: "Done",
        display: false,
      }) + "\n",
    );
    assert.equal(
      manager.getEntryCount(),
      count,
      "external publication did not update the in-memory manager",
    );
    events.emit("subagent:result-intercom-delivery", {
      requestId: relay.requestId,
      delivered: true,
    });
    assertDefined(state.ownedRuns);
    while (state.ownedRuns.get(runId)?.delivery?.entryId === undefined) {
      assert.ok(performance.now() < deadline, "async resume observes the new receipt");
      // Observe the owner publication before advancing this lifecycle transition.
      // oxlint-disable-next-line no-await-in-loop
      await delay(10);
    }
    const defined20082_0 = state.ownedRuns.get(runId);
    assertDefined(defined20082_0);
    assert.equal(defined20082_0.delivery?.entryId, "external-receipt");
    assert.equal(notices, 0);
  } finally {
    delivery.stop();
  }
});

for (const change of [
  "partial tail",
  "changed prefix and growth",
  "same-size edit",
  "same-stamp edit",
  "replacement",
  "shrink",
  "malformed append",
]) {
  test(`published receipt cache validates ${change}`, (t) => {
    const root = fs.mkdtempSync(path.join(tmpdir(), "subagent-receipt-cache-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, "parent.jsonl"),
      header = '{"type":"session","id":"parent","version":3}\n';
    const receipt = (key: string) =>
      JSON.stringify({
        type: "custom_message",
        id: "receipt",
        customType: "subagent-notify",
        timestamp: "2026-01-01T00:00:00Z",
        details: { completion: { runId: "run", key } },
      });
    const before = header + receipt("completion:A") + "\n";
    fs.writeFileSync(file, before);
    const reader = createParentReceiptReader("live");
    assert.equal(reader.read(file).size, 1);
    if (change === "same-stamp edit") {
      const fixed = fs.statSync(file, { bigint: true }),
        fstat = fs.fstatSync;
      const mock = t.mock.method(
        fs,
        "fstatSync",
        (fd: number, options?: Readonly<fs.StatOptions>) => {
          const stat = fstat(fd, options);
          if (options?.bigint === true) {
            Object.defineProperties(stat, {
              mtimeNs: { value: fixed.mtimeNs },
              ctimeNs: { value: fixed.ctimeNs },
            });
          }
          return stat;
        },
      );
      syncBuiltinESMExports();
      t.after(() => {
        mock.mock.restore();
        syncBuiltinESMExports();
      });
    }
    const key = () => {
      const entry = record(reader.read(file).get("receipt"));
      return record(record(entry.details).completion).key;
    };
    if (change === "partial tail") {
      fs.appendFileSync(file, receipt("completion:B").replace('"receipt"', '"new"'));
      assert.equal(
        reader.read(file).has("new"),
        false,
        "complete JSON without LF is not published",
      );
      fs.appendFileSync(file, "\n");
      assert.equal(reader.read(file).has("new"), true);
      assert.equal(key(), "completion:A");
    } else if (change === "shrink") {
      fs.writeFileSync(file, header);
      assert.equal(
        reader.read(file).size,
        0,
        "truncated receipts cannot retain delivery authority",
      );
    } else if (change === "malformed append") {
      fs.appendFileSync(file, "{broken}\n");
      assert.throws(() => reader.read(file), /Invalid JSONL/);
      fs.writeFileSync(file, before + receipt("completion:B").replace('"receipt"', '"new"') + "\n");
      assert.equal(
        reader.read(file).has("new"),
        true,
        "failed scans never poison the next cache snapshot",
      );
    } else {
      const changed =
        header +
        receipt("completion:B") +
        "\n" +
        (change === "changed prefix and growth" ? '{"type":"custom","id":"extra"}\n' : "");
      if (change === "replacement") {
        fs.writeFileSync(`${file}.next`, changed);
        fs.renameSync(`${file}.next`, file);
      } else {
        fs.writeFileSync(file, changed);
      }
      assert.equal(key(), "completion:B", "cached authority follows the current verified bytes");
    }
  });
}
