import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import childProcess from "node:child_process";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import * as path from "node:path";
import { after, test } from "node:test";
import { createTempDir, removeTempDir } from "../support/helpers.ts";
import type { OwnedRun, SubagentState } from "../../src/shared/types.ts";
import { assertDefined } from "../support/assertions.ts";
import { createSubagentState, toolText } from "../support/background-fixtures.ts";

const root = createTempDir("owned-list-");
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
process.env.PI_SUBAGENT_TEMP_ROOT = path.join(root, "pi-subagents-runtime");
const { ownedRunList, ownedRunStatusResult, rememberOwnedRun, saveForegroundRun } =
  await import("../../src/runs/shared/run-records.ts");
const { closeRunHistory, runHistoryIndex } = await import("../../src/runs/shared/history-index.ts");
const {
  createSupervisorQuestion,
  getRunMetadataDir,
  LEGACY_QUESTIONS_DIR,
  QUESTIONS_DIR,
  migrateSupervisorQuestions,
  recordQuestionDelivery,
  saveAsyncRunResult,
  saveQuestionAnswer,
  saveQuestionContract,
  saveQuestionOwner,
  saveRunStatus,
} = await import("../../src/runs/shared/supervisor-questions.ts");
after(() => removeTempDir(root));

function ownerState(currentSessionId = "parent"): SubagentState {
  const state = createSubagentState(root);
  state.currentSessionId = currentSessionId;
  return state;
}

function seedRetainedRuns(sessionFile: string): SubagentState {
  const state = ownerState();
  for (let index = 0; index < 65; index++) {
    const runId = `page-${String(index).padStart(2, "0")}`;
    const run: OwnedRun = {
      runId,
      rootRunId: index >= 60 ? "page-00" : runId,
      ownerSessionId: "parent",
      source: index === 1 ? "foreground" : "async",
      mode: "single",
      cwd: root,
      task: `Work ${index}`,
      startedAt: index + 1,
      children: [{ agent: "worker", index: 0, sessionFile }],
      ...(index >= 3 ? { review: { decision: "accepted", reviewedAt: index } } : {}),
      ...(index >= 60
        ? { predecessorRunId: index === 60 ? "page-00" : `page-${index - 1}`, predecessorIndex: 0 }
        : {}),
      ...(index === 1 ? { legacy: true } : {}),
    };
    rememberOwnedRun(state, run);
    saveQuestionOwner(runId, "parent");
    saveQuestionContract(runId, 0, { sessionFile, ...(index === 2 ? { pid: process.pid } : {}) });
    if (index === 2) {
      saveRunStatus(runId, {
        runId,
        mode: "single",
        state: "running",
        startedAt: 3,
        lastUpdate: 3,
        pid: process.pid,
        steps: [{ agent: "worker", status: "running", sessionFile }],
      });
    } else if (index === 1) {
      saveForegroundRun({
        runId,
        mode: "single",
        cwd: root,
        results: [
          {
            agent: "worker",
            task: run.task,
            exitCode: 0,
            sessionFile,
            finalOutput: "Legacy saved foreground evidence",
            messages: [],
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
          },
        ],
      });
    } else {
      saveAsyncRunResult(runId, {
        id: runId,
        state: index === 0 ? "failed" : "complete",
        success: index !== 0,
        timestamp: index + 1,
        results: [
          {
            agent: "worker",
            success: index !== 0,
            exitCode: index === 0 ? 1 : 0,
            sessionFile,
            output: `Result ${index}: ${"evidence ".repeat(500)}`,
          },
        ],
      });
    }
  }
  return state;
}

test("indexed owned pages skip off-page filesystem work while keeping fresh selected controls, questions, review and lineage", async (t) => {
  const sessionFile = path.join(root, "child.jsonl");
  const nativeHeader =
    JSON.stringify({
      type: "session",
      version: 3,
      id: "child",
      timestamp: new Date().toISOString(),
      cwd: root,
    }) + "\n";
  fs.writeFileSync(sessionFile, nativeHeader);
  const state = seedRetainedRuns(sessionFile);
  t.after(() => closeRunHistory(state));
  // A live pre-update waiter can still write its answer to the legacy directory.
  saveQuestionOwner("page-03", "parent", LEGACY_QUESTIONS_DIR);
  const question = createSupervisorQuestion(
    {
      runId: "page-03",
      ownerTarget: "parent",
      agent: "worker",
      index: 0,
      childSessionId: "child",
      childTarget: "child",
      sessionFile,
      cwd: root,
      pid: process.pid,
      reason: "need_decision",
      message: "Which path?",
    },
    LEGACY_QUESTIONS_DIR,
  );
  migrateSupervisorQuestions("parent");
  const index = await runHistoryIndex(state);
  await index.refresh();
  const reads = new Map<string, number>();
  let metadataScans = 0,
    migrationScans = 0,
    offPageStats = 0;
  const readFile = fs.readFileSync,
    readDirectory = fs.readdirSync,
    stat = fs.statSync;
  t.mock.method(
    fs,
    "statSync",
    (...args: readonly [file: fs.PathLike, options?: Readonly<fs.StatSyncOptions>]) => {
      const file = String(args[0]);
      if (
        file.startsWith(`${QUESTIONS_DIR}/`) &&
        !["page-03", "page-00"].some((id) => file.startsWith(`${getRunMetadataDir(id)}/`))
      ) {
        offPageStats++;
      }
      return stat(...args);
    },
  );
  t.mock.method(
    fs,
    "readFileSync",
    (input: fs.PathOrFileDescriptor, ...args: readonly unknown[]) => {
      const value: unknown = Reflect.apply(readFile, fs, [input, ...args]);
      assert.ok(typeof value === "string" || Buffer.isBuffer(value));
      const file = String(input);
      if (file.startsWith(QUESTIONS_DIR)) {
        reads.set(file, (reads.get(file) ?? 0) + 1);
      }
      return value;
    },
  );
  t.mock.method(
    fs,
    "readdirSync",
    (
      ...args: readonly [file: fs.PathLike, options: Readonly<Parameters<typeof fs.readdirSync>[1]>]
    ) => {
      if (String(args[0]) === QUESTIONS_DIR) {
        metadataScans++;
      }
      if (String(args[0]) === LEGACY_QUESTIONS_DIR) {
        migrationScans++;
      }
      return readDirectory(...args);
    },
  );
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const page = () => ownedRunList(state, { limit: 2 });
  const pageIds = async () => {
    const runs = (await page()).details.runs;
    assertDefined(runs);
    return runs.map((run) => run.runId);
  };
  assert.deepEqual(await pageIds(), ["page-03", "page-00"]);
  reads.clear();
  metadataScans = 0;
  migrationScans = 0;
  offPageStats = 0;
  assert.deepEqual(await pageIds(), ["page-03", "page-00"]);
  const offPageReads = [...reads].filter(
    ([file]) =>
      /\/(?:result|foreground)\.json$|\/contracts\//.test(file) &&
      !["page-03", "page-00", "page-02"].some((id) => file.startsWith(`${getRunMetadataDir(id)}/`)),
  );
  assert.equal(
    offPageReads.length,
    0,
    "unchanged off-page results and launch contracts must not be reloaded",
  );
  assert.ok(metadataScans <= 1, `metadata root scanned ${metadataScans} times`);
  assert.equal(migrationScans, 0, "warm indexed pages must not census the legacy root");
  assert.equal(offPageStats, 0, "warm pages must not stat every saved owner before limiting");
  t.diagnostic(
    `65 retained runs; off-page reads/stats: ${offPageReads.length}/${offPageStats}; metadata/migration scans: ${metadataScans}/${migrationScans}.`,
  );

  saveAsyncRunResult("page-02", {
    id: "page-02",
    state: "failed",
    success: false,
    timestamp: Date.now(),
    results: [
      { agent: "worker", success: false, exitCode: 1, output: "Fresh child failure", sessionFile },
    ],
  });
  await index.refresh("page-02");
  assert.deepEqual(
    await pageIds(),
    ["page-03", "page-02"],
    "a caught-up child completion moves into attention",
  );
  saveQuestionAnswer(question, "Use the native path", LEGACY_QUESTIONS_DIR);
  await index.refresh("page-03");
  assert.equal(
    (await page()).details.runs?.[0]?.runId,
    "page-03",
    "saved but undelivered answers still need attention",
  );
  recordQuestionDelivery(
    question,
    { kind: "live", runId: "page-03", deliveredAt: Date.now() },
    LEGACY_QUESTIONS_DIR,
  );
  await index.refresh("page-03");
  assert.deepEqual(await pageIds(), ["page-02", "page-00"]);
  assertDefined(state.ownedRuns);
  const firstRun = state.ownedRuns.get("page-00");
  assertDefined(firstRun);
  rememberOwnedRun(state, {
    ...firstRun,
    review: { decision: "accepted", reviewedAt: Date.now() },
  });
  await state.historyReady;
  await index.refresh("page-00");
  assert.deepEqual(
    await pageIds(),
    ["page-02", "page-01"],
    "review changes reorder without replacing execution outcomes",
  );
  assert.match(toolText((await page()).content), /Legacy saved foreground evidence/);
  fs.unlinkSync(sessionFile);
  assert.notEqual(
    (await page()).details.managementControls
      ?.find((control) => control.runId === "page-01")
      ?.capabilities.includes("resume"),
    true,
    "selected controls must notice a removed session file even before index catch-up",
  );
  fs.writeFileSync(sessionFile, nativeHeader);
  assert.equal(
    (await page()).details.managementControls
      ?.find((control) => control.runId === "page-01")
      ?.capabilities.includes("resume"),
    true,
  );

  const all: string[] = [];
  for (let offset = 0; offset < 65; offset += 7) {
    // Pages are observed in offset order to detect repeated or missing history rows.
    // oxlint-disable-next-line no-await-in-loop
    const result = await ownedRunList(state, { offset, limit: 7 });
    assert.equal(result.details.runList?.total, 65);
    assertDefined(result.details.runs);
    all.push(...result.details.runs.map((run) => run.runId));
  }
  assert.equal(new Set(all).size, 65, "paging does not cap history or repeat runs");
  const lastRun = state.ownedRuns.get("page-64");
  assertDefined(lastRun);
  assert.equal(
    ownedRunStatusResult(lastRun, state).details.run?.children[0]?.result?.finalOutput?.startsWith(
      "Result 64:",
    ),
    true,
  );
  assert.deepEqual(
    ownedRunStatusResult(firstRun, state).details.run?.continuations.map((run) => run.runId),
    ["page-60", "page-61", "page-62", "page-63", "page-64"],
  );
});

test("a stopped browse worker stays unavailable through background requests until explicit retry", async (t) => {
  const state = ownerState("stopped-worker"),
    fork = childProcess.fork;
  const children: childProcess.ChildProcess[] = [];
  const starts = t.mock.method(childProcess, "fork", (...args: readonly unknown[]) => {
    const child: unknown = Reflect.apply(fork, childProcess, args);
    assert.ok(child instanceof childProcess.ChildProcess);
    children.push(child);
    return child;
  });
  syncBuiltinESMExports();
  t.after(async () => {
    await closeRunHistory(state);
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const index = await runHistoryIndex(state);
  assert.equal((await index.listRuns()).total, 0);
  const child = children[0];
  assertDefined(child);
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  for (let update = 0; update < 3; update++) {
    // Each failed background request observes the same stopped worker before retry.
    // oxlint-disable-next-line no-await-in-loop
    await assert.rejects(async () => (await runHistoryIndex(state)).listRuns(), {
      code: "UNAVAILABLE",
    });
  }
  await assert.rejects(
    index.listRuns(),
    { code: "UNAVAILABLE" },
    "cached queries must not bypass the failure",
  );
  const remembered: OwnedRun = {
    runId: "remembered-during-outage",
    rootRunId: "remembered-during-outage",
    ownerSessionId: "stopped-worker",
    source: "foreground",
    mode: "single",
    cwd: root,
    task: "New work recorded while history is unavailable",
    startedAt: 1,
    children: [{ agent: "worker", index: 0 }],
  };
  rememberOwnedRun(state, remembered);
  assertDefined(state.historyReady);
  await assert.rejects(state.historyReady, { code: "UNAVAILABLE" });
  assert.equal(starts.mock.callCount(), 1);
  const recovered = await (await runHistoryIndex(state, true)).listRuns();
  assert.deepEqual(
    recovered.rows.map((run) => [run.runId, run.task]),
    [[remembered.runId, remembered.task]],
    "explicit retry admits work recorded during the outage",
  );
  assert.equal(starts.mock.callCount(), 2);
});

for (const failed of [false, true]) {
  for (const boundary of ["owner change", "shutdown"]) {
    test(`${failed ? "failed" : "healthy"} history retry cannot cross ${boundary}`, async (t) => {
      const state = ownerState("previous-owner");
      t.after(() => closeRunHistory(state));
      const index = await runHistoryIndex(state);
      await index.listRuns();
      if (failed) {
        index.cancel();
      }
      const pending = runHistoryIndex(state, true);
      if (boundary === "owner change") {
        state.currentSessionId = "replacement-owner";
      }
      const closing = closeRunHistory(state);
      const replacement = boundary === "owner change" ? runHistoryIndex(state) : undefined;
      await assert.rejects(pending, /Owning session changed|History index is closed/);
      await closing;
      if (replacement) {
        assert.equal((await (await replacement).listRuns()).total, 0);
      } else {
        assert.equal(state.historyIndex, undefined, "cleanup must not admit another worker");
      }
    });
  }
}
