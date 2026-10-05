import { parseHistoryPage } from "../../src/runs/background/run-schemas.ts";
import { readRunStatus } from "../support/run-publications.ts";
import {
  assertDefined,
  record as objectRecord,
  records as unknownRecords,
  text as stringValue,
  numberValue,
} from "../support/assertions.ts";
import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fork } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { syncBuiltinESMExports } from "node:module";
import { readSavedOutput } from "../../src/history/canonical-result.ts";
import { HistoryStore, hash } from "../../src/history/store.ts";
import { SourceIngest } from "../../src/history/ingest.ts";
import { entryRow } from "../../src/history/rows.ts";
import { validateRecord } from "../../src/history/selected-record.ts";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import {
  SubagentHistoryIndex,
  type OwnedRun,
  type OwnedRunView,
  type HistoryOwner,
} from "../../src/history/index.ts";
import {
  createSupervisorQuestion,
  saveQuestionOwner,
} from "../../src/runs/shared/supervisor-questions.ts";

const timestamp = "2026-09-30T12:00:00.000Z";
const header = (id = "native-child", version = 3) => ({
  type: "session",
  version,
  id,
  timestamp,
  cwd: "/synthetic",
});
const message = (id: string, text: string, role = "user") => ({
  type: "message",
  id,
  parentId: null,
  timestamp,
  message: { role, content: [{ type: "text", text }] },
});
const lines = (records: readonly unknown[]) =>
  records.map((record) => JSON.stringify(record)).join("\n") + "\n";
function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "history-index-")),
    agentDir = path.join(root, "agent");
  fs.mkdirSync(agentDir);
  let index = new SubagentHistoryIndex(agentDir);
  t.after(async () => {
    await index.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    agentDir,
    get index() {
      return index;
    },
    async restart() {
      await index.close();
      index = new SubagentHistoryIndex(agentDir);
    },
    file(name: string, records: readonly unknown[]) {
      const file = path.join(root, name);
      fs.writeFileSync(file, lines(records), { mode: 0o600 });
      return file;
    },
  };
}
function run(id: string, sessionFile?: string, agent = "worker"): OwnedRun {
  return {
    runId: id,
    rootRunId: id,
    ownerSessionId: "parent",
    source: "foreground",
    mode: "single",
    cwd: "/synthetic",
    task: `Task ${id}`,
    startedAt: 100,
    children: [{ agent, index: 0, ...((sessionFile ?? "").length > 0 ? { sessionFile } : {}) }],
  };
}
function seed(
  f: Readonly<Pick<ReturnType<typeof fixture>, "agentDir" | "file">>,
  id: string,
  state: OwnedRunView["state"],
  attention: readonly string[],
  updatedAt: number,
  agent = "worker",
): OwnedRun {
  const directory = path.join(f.agentDir, "sessions", "subagent-runs"),
    root = path.join(directory, id);
  fs.mkdirSync(root, { recursive: true });
  const ownedRun = {
    ...run(id, undefined, agent),
    ...(attention.length > 0 || state === "live"
      ? {}
      : { review: { decision: "accepted" as const, reviewedAt: updatedAt } }),
  };
  if (state === "live") {
    ownedRun.source = "async";
    ownedRun.asyncDir = root;
    fs.writeFileSync(
      path.join(root, "status.json"),
      JSON.stringify({
        runtimeVersion: 2,
        runId: id,
        mode: "single",
        state: "running",
        pid: process.pid,
        startedAt: 100,
        lastUpdate: updatedAt,
        steps: [{ agent, status: "running" }],
      }),
    );
  } else {
    fs.writeFileSync(
      path.join(root, "foreground.json"),
      JSON.stringify({
        runId: id,
        mode: "single",
        cwd: "/synthetic",
        updatedAt,
        children: [
          {
            agent,
            index: 0,
            status: state,
            result: {
              agent,
              task: ownedRun.task,
              exitCode: state === "completed" ? 0 : 1,
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
            },
          },
        ],
      }),
    );
  }
  if (attention.includes("awaiting_input")) {
    const sessionFile = f.file(`${id}.jsonl`, [header()]);
    saveQuestionOwner(id, "parent", directory);
    createSupervisorQuestion(
      {
        runId: id,
        agent,
        index: 0,
        ownerTarget: "parent",
        childSessionId: "child",
        childTarget: "child",
        sessionFile,
        cwd: "/synthetic",
        pid: process.pid,
        reason: "need_decision",
        message: "Choose the approved path.",
      },
      directory,
    );
  }
  return ownedRun;
}
async function owned(
  index: Readonly<Pick<SubagentHistoryIndex, "setOwner" | "refresh">>,
  runs: readonly OwnedRun[],
  extra: Readonly<Partial<HistoryOwner>> = {},
) {
  await index.setOwner({ ownerSessionId: "parent", runs: [...runs], ...extra });
  await index.refresh();
}
const code = (value: string) => (error: unknown) => objectRecord(error).code === value;

test(
  "an already observed native watch hint preserves completed degraded history without queuing another ingest",
  { timeout: 10_000 },
  async (t) => {
    const f = fixture(t),
      directory = path.join(f.root, "native-source");
    fs.mkdirSync(directory);
    const file = f.file("native-source/delayed-watch.jsonl", [
      header(),
      message("first", "originalword"),
    ]);
    const worker = fork(
      new URL("../../src/history/worker.ts", import.meta.url),
      [f.agentDir, file],
      {
        execArgv: ["--import", new URL("../fixtures/history-watch-hint.mjs", import.meta.url).href],
        env: { ...process.env, PI_CODING_AGENT_DIR: f.agentDir },
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      },
    );
    const exited = once(worker, "exit");
    t.after(async () => {
      if (worker.exitCode === null && worker.signalCode === null) {
        worker.kill("SIGKILL");
      }
      await exited;
    });
    let sequence = 0;
    const requests = new Map<
      number,
      Readonly<{ resolve: (value: unknown) => void; reject: (error: Readonly<Error>) => void }>
    >();
    const observed = new Set<string>(),
      waiting = new Map<string, () => void>();
    const directories: string[] = [];
    worker.on("message", (received: unknown) => {
      const response = objectRecord(received);
      if (typeof response.watchDirectory === "string") {
        directories.push(response.watchDirectory);
        return;
      }
      if (typeof response.watchHint === "string") {
        observed.add(response.watchHint);
        waiting.get(response.watchHint)?.();
        waiting.delete(response.watchHint);
        return;
      }
      if (response.changed === true) {
        return;
      }
      const id = numberValue(response.id);
      const request = requests.get(id);
      if (!request) {
        return;
      }
      requests.delete(id);
      if (response.error !== undefined) {
        const failure = objectRecord(response.error);
        request.reject(
          Object.assign(new Error(stringValue(failure.message)), {
            code: stringValue(failure.code),
          }),
        );
      } else {
        request.resolve(response.value);
      }
    });
    const hint = (name: string) =>
      observed.has(name)
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            waiting.set(name, resolve);
          });
    const request = (method: string, input: Readonly<Record<string, unknown>> = {}) =>
      new Promise<unknown>((resolve, reject) => {
        const id = ++sequence;
        requests.set(id, { resolve, reject });
        worker.send({ id, method, input });
      });
    try {
      await request("setOwner", { ownerSessionId: "parent", runs: [run("delayed-watch", file)] });
      await request("refresh");
      fs.appendFileSync(
        file,
        '{broken "secret-no-log"}\n' + lines([message("later", "afterbroken")]),
      );
      await hint("observed");
      await assert.rejects(request("refresh", { runId: "delayed-watch" }), code("DEGRADED"));
      const before = parseHistoryPage(
        await request("historyPage", { runId: "delayed-watch", index: 0 }),
      );
      assert.equal(before.sourceState, "degraded");
      assert.equal(before.freshness.state, "degraded");
      worker.send({ watchHint: "deliver" });
      await hint("delivered");
      const after = parseHistoryPage(
        await request("historyPage", { runId: "delayed-watch", index: 0 }),
      );
      assert.deepEqual(
        after.entries.map((entry) => entry.id),
        ["first", "later"],
      );
      assert.equal(after.sourceState, "degraded");
      assert.equal(
        after.freshness.state,
        "degraded",
        "an unchanged native hint cannot turn acknowledged indexing into pending work",
      );
      assert.equal(after.freshness.pending, 0);
      observed.clear();
      fs.appendFileSync(file, lines([message("newest", "genuine new publication")]));
      await hint("observed");
      worker.send({ watchHint: "deliver" });
      await hint("delivered");
      const changed = parseHistoryPage(
        await request("historyPage", { runId: "delayed-watch", index: 0 }),
      );
      assert.equal(
        changed.freshness.state,
        "catching-up",
        "a genuinely changed source still queues work",
      );
      assert.ok(numberValue(changed.freshness.pending) > 0);
      worker.send({ watchHint: "drain" });
      await assert.rejects(request("refresh", { runId: "delayed-watch" }), code("DEGRADED"));
      const reconciled = parseHistoryPage(
        await request("historyPage", { runId: "delayed-watch", index: 0 }),
      );
      assert.deepEqual(
        reconciled.entries.map((entry) => entry.id),
        ["first", "later", "newest"],
      );
      assert.equal(reconciled.freshness.state, "degraded");
      observed.clear();
      fs.rmSync(directory, { recursive: true });
      fs.mkdirSync(directory);
      fs.writeFileSync(file, lines([header(), message("replacement", "recreated source")]));
      await hint("observed");
      worker.send({ watchHint: "deliver" });
      await hint("delivered");
      worker.send({ watchHint: "drain" });
      const ready = async (id: string) => {
        const deadline = Date.now() + 3000;
        for (;;) {
          const page = parseHistoryPage(
            // Observe the worker publication before retrying this lifecycle check.
            // oxlint-disable-next-line no-await-in-loop
            await request("historyPage", { runId: "delayed-watch", index: 0 }),
          );
          if (
            page.sourceState === "current" &&
            page.freshness.pending === 0 &&
            page.entries.at(-1)?.id === id
          ) {
            return;
          }
          assert.ok(
            Date.now() < deadline,
            `native watch publishes ${id} after source-parent recreation`,
          );
        }
      };
      await ready("replacement");
      const physical = fs.statSync(directory, { bigint: true }),
        currentDirectory = `${physical.dev}:${physical.ino}`;
      t.diagnostic(
        `Physical directory ${currentDirectory}; native registrations ${directories.join(",")}`,
      );
      worker.send({ watchHint: "automatic" });
      await hint("automatic");
      fs.appendFileSync(
        file,
        lines([message("replacement-append", "second native publication after recreation")]),
      );
      await ready("replacement-append");
      assert.ok(
        directories.includes(currentDirectory),
        "native readiness includes a watch on the recreated physical source parent",
      );
    } finally {
      worker.send({ watchHint: "drain" });
      await request("status");
      worker.disconnect();
      assert.deepEqual(await exited, [0, null]);
    }
  },
);

test("owned compact run ordering, filtering and seek pagination do not adopt orphan files or walk sources on warm queries", async (t) => {
  const f = fixture(t);
  const views = [
    seed(f, "run-z", "completed", ["unreviewed"], 200),
    seed(f, "run-b", "failed", ["failed"], 300),
    seed(f, "run-a", "failed", ["failed"], 300),
    seed(f, "run-input", "completed", ["awaiting_input"], 1),
    seed(f, "run-live", "live", [], 600),
    seed(f, "run-accepted", "completed", [], 900, "other"),
  ];
  assert.equal(
    await f.index
      .setOwner({ ownerSessionId: "parent", runs: [views[5]] })
      .then(() => f.index.needsControls()),
    false,
    "reviewed inert history stays hidden even before transcript backfill",
  );
  await f.index.setOwner({ ownerSessionId: "parent", runs: views });
  assert.equal(
    await f.index.needsControls(),
    true,
    "run metadata alone enables actionable controls",
  );
  f.file("orphan.jsonl", [header("orphan"), message("orphan-entry", "orphanword")]);
  await owned(f.index, views);
  const first = await f.index.listRuns({ limit: 2 });
  assert.deepEqual(
    first.rows.map((row) => row.runId),
    ["run-input", "run-a"],
  );
  assert.equal(first.total, 6);
  assert.equal(first.freshness.authoritative, false);
  assert.deepEqual(
    (await f.index.listRuns({ cursor: first.nextCursor, limit: 2 })).rows.map((row) => row.runId),
    ["run-b", "run-live"],
  );
  assert.deepEqual(
    (await f.index.listRuns({ offset: 4, limit: 2 })).rows.map((row) => row.runId),
    ["run-z", "run-accepted"],
  );
  assert.deepEqual(
    (await f.index.listRuns({ state: "completed", agent: "other", limit: 1 })).rows.map(
      (row) => row.runId,
    ),
    ["run-accepted"],
    "filters must precede page limit",
  );
  assert.deepEqual(
    (await f.index.listRuns({ text: "accepted", limit: 1 })).rows.map((row) => row.runId),
    ["run-accepted"],
  );
  assert.equal(
    (await f.index.listRuns({ sort: "newest", limit: 1 })).rows[0].runId,
    "run-accepted",
  );
  assert.equal((await f.index.listRuns({ sort: "oldest", limit: 1 })).rows[0].runId, "run-input");
  await assert.rejects(
    f.index.listRuns({ cursor: first.nextCursor, agent: "other" }),
    code("STALE_CURSOR"),
  );
  await assert.rejects(f.index.search({ query: "orphanword", runId: "orphan" }), code("OWNERSHIP"));
  assert.equal((await f.index.search({ query: "orphanword" })).matches.length, 0);
  await assert.rejects(
    f.index.setOwner({ ownerSessionId: "fork", runs: views }),
    code("OWNERSHIP"),
  );
  assert.equal(
    (await f.index.listRuns()).total,
    6,
    "rejected admission must not change current owner",
  );
  const before = await f.index.status();
  for (let page = 0; page < 12; page++) {
    // Each scenario owns shared fixture state; complete it before starting the next one.
    // oxlint-disable-next-line no-await-in-loop
    await f.index.listRuns({ limit: 1 });
    // Each scenario owns shared fixture state; complete it before starting the next one.
    // oxlint-disable-next-line no-await-in-loop
    await f.index.search({ query: "miss" });
  }
  const after = await f.index.status();
  assert.deepEqual({ ...after.operations, queries: 0 }, { ...before.operations, queries: 0 });
  assert.equal(after.operations.queries - before.operations.queries, 24);
  await f.index.updateRun({ ...views[5], review: { decision: "needs_changes", reviewedAt: 901 } });
  await f.index.refresh("run-accepted");
  await assert.rejects(f.index.listRuns({ cursor: first.nextCursor }), code("STALE_CURSOR"));
  await f.index.setOwner({ ownerSessionId: "fork", runs: [] });
  assert.equal((await f.index.listRuns()).total, 0);
});

test("a full Agents page retains deep native branch configuration within the history process deadline", async (t) => {
  const f = fixture(t),
    depth = 2500;
  const records = [
    {
      type: "model_change",
      id: "model",
      parentId: null,
      timestamp,
      provider: "synthetic",
      modelId: "selected",
    },
    {
      type: "thinking_level_change",
      id: "thinking",
      parentId: "model",
      timestamp,
      thinkingLevel: "high",
    },
    ...Array.from({ length: depth }, (_, index) => ({
      ...message(`deep-${index}`, `Native history ${index}`),
      parentId: index !== 0 && !Number.isNaN(index) ? `deep-${index - 1}` : "thinking",
    })),
    {
      type: "model_change",
      id: "other-branch",
      parentId: "model",
      timestamp,
      provider: "synthetic",
      modelId: "not-selected",
    },
  ];
  const file = f.file("deep.jsonl", [header(), ...records]),
    terminal = `deep-${depth - 1}`;
  const runs = Array.from({ length: 50 }, (_, index) => run(`deep-run-${index}`, file));
  await owned(f.index, runs, {
    foregroundRuns: runs.map((entry) => ({
      runId: entry.runId,
      mode: "single",
      cwd: "/synthetic",
      updatedAt: Date.parse(timestamp),
      children: [
        {
          index: 0,
          agent: "worker",
          status: "completed",
          sessionFile: file,
          result: {
            agent: "worker",
            task: entry.task,
            exitCode: 0,
            terminalEntryId: terminal,
            terminalLeafId: terminal,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
          },
        },
      ],
    })),
  });
  const page = await f.index.listRuns({ limit: 50, latestTasksOnly: true });
  assert.equal(page.total, 50);
  assert.equal(page.rows.length, 50);
  assert.equal(page.nextCursor, undefined);
  assert.deepEqual(
    new Set(page.rows.map((row) => row.runId)),
    new Set(runs.map((entry) => entry.runId)),
  );
  for (const row of page.rows) {
    assert.deepEqual(row.matchedChildIndexes, [0]);
    assert.deepEqual(row.children[0].nativeConfiguration, {
      model: "synthetic/selected",
      modelRecordedAt: Date.parse(timestamp),
      thinking: "high",
    });
  }
  const history = await f.index.historyPage({
    runId: runs[0].runId,
    index: 0,
    terminalEntryId: terminal,
    leaf: terminal,
    limit: 1,
  });
  assert.equal(history.count, depth + 2);
  assert.equal(history.entries[0].id, terminal);
  assert.deepEqual(history.configuration, page.rows[0].children[0].nativeConfiguration);
});

test("canonical foreground summaries stay compact, while physical archive pages retain >100 entries and tool pairs", async (t) => {
  const f = fixture(t),
    records: unknown[] = Array.from({ length: 235 }, (_, number) =>
      message(`entry-${number}`, `retained entry ${number}`),
    );
  records[4] = {
    type: "message",
    id: "entry-4",
    parentId: null,
    timestamp,
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-one",
          name: "synthetic",
          arguments: { payload: "arguments-secret" },
        },
      ],
    },
  };
  records[150] = {
    type: "message",
    id: "entry-150",
    parentId: null,
    timestamp,
    message: {
      role: "toolResult",
      toolCallId: "call-one",
      toolName: "synthetic",
      content: [{ type: "text", text: "paired visible result" }],
    },
  };
  const file = f.file("native.jsonl", [header(), ...records]);
  const ownedRun = run("archive", file);
  await owned(f.index, [ownedRun], {
    foregroundRuns: [
      {
        runId: "archive",
        mode: "single",
        cwd: "/synthetic",
        updatedAt: 777,
        children: [
          {
            index: 0,
            agent: "worker",
            status: "completed",
            sessionFile: file,
            result: {
              agent: "worker",
              task: "task",
              exitCode: 0,
              usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
              messages: [
                { role: "user", content: [{ type: "text", text: "private-provider-blob" }] },
              ],
              finalOutput: "x".repeat(30_000),
              terminalEntryId: "entry-50",
            },
          },
        ],
      },
    ],
  });
  const row = (await f.index.listRuns()).rows[0];
  assert.equal(row.state, "completed");
  assert.equal(row.updatedAt, 777);
  const defined18575_0 = row.children[0].result;
  assertDefined(defined18575_0);
  assert.equal(defined18575_0.messages, undefined);
  assertDefined(row.children[0].result);
  assertDefined(row.children[0].result.finalOutput);
  const defined18636_0 = row.children[0].result.finalOutput;
  assertDefined(defined18636_0);
  assert.ok(defined18636_0.length <= 1024);
  const latest = await f.index.historyPage({ runId: "archive", index: 0, limit: 100 });
  assert.equal(latest.count, 235);
  assert.equal(latest.entries[0].id, "entry-135");
  const defined18876_0 = latest.entries.at(-1);
  assertDefined(defined18876_0);
  assert.equal(defined18876_0.id, "entry-234");
  assert.equal(latest.hasMore, true);
  const middle = await f.index.historyPage({
    runId: "archive",
    index: 0,
    cursor: latest.previousCursor,
    limit: 100,
  });
  const oldest = await f.index.historyPage({
    runId: "archive",
    index: 0,
    before: middle.previousBefore,
    limit: 100,
  });
  assert.equal(oldest.entries.length, 35);
  assert.equal(oldest.hasMore, false);
  assert.deepEqual(
    [...oldest.entries, ...middle.entries, ...latest.entries].map((entry) => entry.id),
    records.map((entry) => objectRecord(entry).id),
  );
  const forward = await f.index.historyPage({
    runId: "archive",
    index: 0,
    after: oldest.nextAfter,
    limit: 100,
  });
  assert.deepEqual(
    forward.entries.map((entry) => entry.id),
    middle.entries.map((entry) => entry.id),
  );
  const bounded = await f.index.historyPage({
    runId: "archive",
    index: 0,
    terminalEntryId: "entry-50",
    limit: 100,
  });
  assert.equal(bounded.count, 51);
  const defined19900_0 = bounded.entries.at(-1);
  assertDefined(defined19900_0);
  assert.equal(defined19900_0.id, "entry-50");
  await assert.rejects(
    f.index.historyPage({ runId: "archive", index: 0, terminalEntryId: "not-indexed" }),
    code("BOUNDARY_UNAVAILABLE"),
  );
  const call = await f.index.entry({
    runId: "archive",
    index: 0,
    toolCallId: "call-one",
    kind: "call",
  });
  const result = await f.index.entry({
    runId: "archive",
    index: 0,
    toolCallId: "call-one",
    kind: "result",
  });
  const defined20362_0 = call;
  assertDefined(defined20362_0);
  assert.equal(defined20362_0.id, "entry-4");
  const defined20399_0 = result;
  assertDefined(defined20399_0);
  assert.equal(defined20399_0.id, "entry-150");
  const defined20440_0 = call;
  assertDefined(defined20440_0);
  assert.equal(
    objectRecord(
      objectRecord(
        unknownRecords(objectRecord(objectRecord(defined20440_0.entry).message).content)[0],
      ).arguments,
    ).payload,
    "arguments-secret",
    "argument previews remain bounded, not searchable",
  );
  assert.equal(
    await f.index.entry({
      runId: "archive",
      index: 0,
      toolCallId: "call-one",
      kind: "result",
      terminalEntryId: "entry-50",
    }),
    null,
    "pair lookup must not leak successor output through a predecessor boundary",
  );
  assert.equal(
    await f.index.entry({
      runId: "archive",
      index: 0,
      entryId: "entry-150",
      endedAt: Date.parse(timestamp) - 1,
    }),
    null,
  );
  const defined21043_0 = call;
  assertDefined(defined21043_0);
  const selectedRecord = await f.index.record({
    runId: "archive",
    index: 0,
    ref: defined21043_0.ref,
  });
  assert.equal(
    objectRecord(
      objectRecord(unknownRecords(objectRecord(objectRecord(selectedRecord).message).content)[0])
        .arguments,
    ).payload,
    "arguments-secret",
  );
  assert.equal(
    (await f.index.search({ query: "paired visible result", runId: "archive", index: 0, limit: 1 }))
      .matches.length,
    0,
    "search applies the finished attempt boundary before paging",
  );
  await f.index.updateRun(run("successor", file));
  await f.index.refresh("successor");
  const successor = await f.index.search({ query: "paired visible result", limit: 1 });
  assert.equal(
    successor.matches[0].runId,
    "successor",
    "shared physical history cannot attribute successor text to its predecessor",
  );
});

test("full child filters and latest-attempt paging retain unsuperseded siblings without repeating continuation chains", async (t) => {
  const f = fixture(t),
    original = {
      ...run("original"),
      mode: "parallel" as const,
      task: "Parallel assignments",
      children: [
        { index: 0, agent: "alpha", task: "Original alpha task" },
        { index: 1, agent: "beta", task: "padding ".repeat(900) + "savedneedle at the end" },
      ],
    };
  const first = {
    ...run("continuation-one"),
    startedAt: 200,
    rootRunId: original.runId,
    predecessorRunId: original.runId,
    predecessorIndex: 0,
    children: [{ index: 0, agent: "alpha", task: "Continue alpha task" }],
  };
  const latest = {
    ...first,
    runId: "continuation-two",
    startedAt: 300,
    predecessorRunId: first.runId,
  };
  await owned(f.index, [original, first, latest]);
  const filtered = await f.index.listRuns({ text: "savedneedle", limit: 1 });
  assert.deepEqual(
    filtered.rows.map((row) => [row.runId, row.matchedChildIndexes]),
    [["original", [1]]],
  );
  const defined22844_0 = filtered.rows[0].children[1].task;
  assertDefined(defined22844_0);
  assert.ok(
    defined22844_0.length <= 1024,
    "filtering uses full assignments, not their display preview",
  );
  assert.equal(
    (await f.index.listRuns({ agent: "alpha", text: "savedneedle" })).total,
    0,
    "agent and text must match the same child",
  );
  const page = await f.index.listRuns({ latestTasksOnly: true, sort: "oldest", limit: 1 });
  assert.equal(page.total, 2);
  assert.deepEqual(
    page.rows.map((row) => [row.runId, row.matchedChildIndexes]),
    [["original", [1]]],
  );
  const next = await f.index.listRuns({
    latestTasksOnly: true,
    sort: "oldest",
    limit: 1,
    cursor: page.nextCursor,
  });
  assert.deepEqual(
    next.rows.map((row) => [row.runId, row.matchedChildIndexes]),
    [["continuation-two", [0]]],
  );
  assert.equal(next.nextCursor, undefined);
  assert.equal(
    (await f.index.listRuns()).total,
    3,
    "attempt-level history is not deleted or capped",
  );
});

test("conversation metadata spans unloaded pages and matches the exact sanitized full answer within its terminal boundary", async (t) => {
  const f = fixture(t),
    answer = "long exact answer ".repeat(1800),
    file = f.file("metadata.jsonl", [
      header(),
      {
        type: "model_change",
        id: "model-first",
        parentId: null,
        timestamp,
        provider: "synthetic",
        modelId: "first",
      },
      {
        type: "thinking_level_change",
        id: "thinking",
        parentId: "model-first",
        timestamp,
        thinkingLevel: "high",
      },
      {
        type: "custom_message",
        id: "human",
        parentId: "thinking",
        timestamp,
        customType: "subagent-human-message",
        details: { message: { id: "outgoing-one" }, bodyText: "human direction" },
      },
      {
        ...message(
          "answer",
          `\x1b[31m${answer}\x1b[0m\n\n\`\`\`acceptance-report\n{}\n\`\`\``,
          "assistant",
        ),
        parentId: "human",
        message: {
          role: "assistant",
          provider: "synthetic",
          model: "first",
          content: [
            { type: "thinking", thinking: "brief reasoning" },
            {
              type: "text",
              text: `\x1b[31m${answer}\x1b[0m\n\n\`\`\`acceptance-report\n{}\n\`\`\``,
            },
          ],
        },
      },
      ...Array.from({ length: 130 }, (_, index) => ({
        ...message(`later-${index}`, `later activity ${index}`),
        parentId: index !== 0 && !Number.isNaN(index) ? `later-${index - 1}` : "answer",
      })),
      {
        ...message("similar-preview", answer.slice(0, 512) + " different full ending", "assistant"),
        parentId: "later-129",
      },
      {
        type: "model_change",
        id: "successor-model",
        parentId: "similar-preview",
        timestamp,
        provider: "synthetic",
        modelId: "second",
      },
      {
        type: "custom_message",
        id: "later-human",
        parentId: "successor-model",
        timestamp,
        customType: "subagent-human-message",
        details: { message: { id: "outgoing-two" }, bodyText: "later unanswered direction" },
      },
      {
        type: "message",
        id: "thinking-only",
        parentId: "later-human",
        timestamp,
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "Considering the direction" }],
        },
      },
      {
        type: "message",
        id: "tool-only",
        parentId: "thinking-only",
        timestamp,
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "" },
            { type: "toolCall", id: "still-working", name: "check", arguments: {} },
          ],
        },
      },
    ]);
  const fullOutputPath = path.join(f.root, "full-answer.txt");
  fs.writeFileSync(fullOutputPath, answer.trim());
  await owned(f.index, [run("metadata", file)], {
    foregroundRuns: [
      {
        runId: "metadata",
        mode: "single",
        cwd: "/synthetic",
        updatedAt: Date.parse(timestamp),
        children: [
          {
            index: 0,
            agent: "worker",
            status: "completed",
            sessionFile: file,
            result: {
              agent: "worker",
              task: "task",
              exitCode: 0,
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
              finalOutput: answer.slice(-8192),
              fullOutputPath,
            },
          },
        ],
      },
    ],
  });
  const page = await f.index.historyPage({
    runId: "metadata",
    index: 0,
    limit: 10,
    leaf: "thinking",
    messageIds: ["outgoing-one", "outgoing-two", "not-delivered"],
    readThrough: "human",
  });
  assert.equal(
    page.entries.some((entry) => entry.id === "human" || entry.id === "answer"),
    false,
  );
  assert.deepEqual(page.configuration, {
    model: "synthetic/first",
    thinking: "high",
    modelRecordedAt: Date.parse(timestamp),
  });
  assert.deepEqual(page.deliveredMessages, [
    ["outgoing-one", true],
    ["outgoing-two", false],
  ]);
  assert.equal(page.latestEntryId, "tool-only:1");
  assert.equal(page.unreadAfter, true);
  assert.equal(page.finalResultId, "answer:0", "same bounded preview is not an exact answer match");
  assert.deepEqual(await f.index.result({ runId: "metadata", index: 0 }), {
    text: answer.trim(),
    timestamp: Date.parse(timestamp),
    finalResultId: "answer:0",
  });
  const bounded = await f.index.historyPage({
    runId: "metadata",
    index: 0,
    terminalEntryId: "answer",
    leaf: "answer",
    messageIds: ["outgoing-one", "outgoing-two"],
    readThrough: "answer:1",
  });
  assert.deepEqual(bounded.deliveredMessages, [["outgoing-one", true]]);
  assert.equal(bounded.latestEntryId, "answer:1");
  assert.equal(bounded.unreadAfter, false);
  assert.equal(bounded.finalResultId, "answer:0");
  assert.ok(bounded.terminalSequence !== undefined);
  const human = await f.index.entry({ runId: "metadata", index: 0, entryId: "human" });
  const defined28950_0 = human;
  assertDefined(defined28950_0);
  assert.equal(objectRecord(objectRecord(defined28950_0.entry.details).message).id, "outgoing-one");
  const savedAnswer = await f.index.entry({ runId: "metadata", index: 0, entryId: "answer" });
  const defined29110_0 = savedAnswer;
  assertDefined(defined29110_0);
  assert.equal(
    unknownRecords(objectRecord(defined29110_0.entry.message).content)[0]?.thinking,
    "brief reasoning",
  );
  assert.equal(
    (await f.index.historyPage({ runId: "metadata", index: 0, readThrough: "tool-only:1" }))
      .unreadAfter,
    false,
  );
});

test("a published native record replaced by malformed same-size bytes reports SOURCE_CHANGED and closes its descriptor", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "history-selected-race-"));
  const file = path.join(root, "native.jsonl");
  const prefix = lines([header()]);
  const nativeRecord = lines([message("selected", "Retained native content")]);
  fs.writeFileSync(file, prefix + nativeRecord);
  const store = new HistoryStore(root, "owner");
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const id = hash(file);
  store.run("INSERT INTO sources(id,path) VALUES (?,?)", id, file);
  const source = store.source(id);
  assertDefined(source);
  const ingest = new SourceIngest(store, source, true);
  while (!ingest.step()) {
    // Select only after actual incremental ingestion has published the native row.
  }
  const row = entryRow(store.require("SELECT * FROM entries WHERE published=1"));
  const indexedSource = store.source(id);
  assertDefined(indexedSource);
  assert.equal(row.end, Buffer.byteLength(prefix + nativeRecord));
  const originalRead = fs.readSync;
  let selectedFd: number | undefined;
  let mutated = false;
  t.mock.method(
    fs,
    "readSync",
    (fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
      if (!mutated && position === row.start) {
        mutated = true;
        selectedFd = fd;
        fs.writeFileSync(
          file,
          prefix + "broken".padEnd(Buffer.byteLength(nativeRecord) - 1, "x") + "\n",
        );
      }
      return originalRead(fd, buffer, offset, length, position);
    },
  );
  syncBuiltinESMExports();
  try {
    assert.throws(() => validateRecord(indexedSource, row, true), code("SOURCE_CHANGED"));
    assert.equal(mutated, true);
    const closedFd = selectedFd;
    assertDefined(closedFd);
    assert.throws(() => fs.fstatSync(closedFd), code("EBADF"));
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("selected canonical result details select sparse child indices, retain full reports and refuse oversized output", async (t) => {
  const f = fixture(t),
    directory = path.join(f.agentDir, "sessions", "subagent-runs", "legacy-result");
  fs.mkdirSync(directory, { recursive: true });
  const answer = "saved report ".repeat(2200),
    file = path.join(directory, "foreground.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      runId: "legacy-result",
      mode: "parallel",
      cwd: "/synthetic",
      updatedAt: 500,
      children: [
        {
          agent: "other",
          index: 4,
          status: "completed",
          result: {
            agent: "other",
            task: "independent saved task",
            exitCode: 0,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
            finalOutput: "unrelated",
            messages: [{ secret: "private payload" }],
          },
        },
        {
          agent: "worker",
          index: 9,
          status: "completed",
          result: {
            agent: "worker",
            task: "task",
            exitCode: 0,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
            finalOutput: answer,
          },
        },
      ],
    }),
  );
  await owned(f.index, [
    {
      ...run("legacy-result"),
      mode: "parallel",
      children: [
        { agent: "other", index: 4 },
        { agent: "worker", index: 9 },
      ],
    },
  ]);
  const preview = (await f.index.listRuns()).rows[0].children.find((child) => child.index === 9);
  assertDefined(preview);
  assertDefined(preview.result);
  assertDefined(preview.result.finalOutput);
  const defined30753_0 = preview.result.finalOutput;
  assertDefined(defined30753_0);
  assert.ok(defined30753_0.length <= 1024);
  assert.deepEqual(await f.index.result({ runId: "legacy-result", index: 9 }), {
    text: answer,
    timestamp: 500,
    finalResultId: undefined,
  });
  await assert.rejects(f.index.result({ runId: "legacy-result", index: 0 }), code("OWNERSHIP"));
  fs.writeFileSync(
    file,
    JSON.stringify({
      runId: "legacy-result",
      mode: "single",
      cwd: "/synthetic",
      updatedAt: 501,
      children: [
        {
          agent: "worker",
          index: 9,
          status: "completed",
          result: {
            agent: "worker",
            task: "task",
            exitCode: 0,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
            finalOutput: "x".repeat(16 * 1024 * 1024 + 1),
          },
        },
      ],
    }),
  );
  await assert.rejects(
    f.index.result({ runId: "legacy-result", index: 9 }),
    code("RECORD_TOO_LARGE"),
  );
  const growing = path.join(f.root, "growing.txt");
  fs.writeFileSync(growing, "small");
  const read = fs.readSync;
  let selectedBytes = 0,
    grew = false;
  t.mock.method(
    fs,
    "readSync",
    (fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
      if (!grew) {
        grew = true;
        fs.appendFileSync(growing, Buffer.alloc(17 * 1024 * 1024, 120));
      }
      selectedBytes += length;
      return read(fd, buffer, offset, length, position);
    },
  );
  syncBuiltinESMExports();
  try {
    assert.throws(() => readSavedOutput(growing), code("SOURCE_CHANGED"));
    assert.equal(
      selectedBytes,
      5,
      "concurrent growth cannot cause an allocation/read beyond the validated snapshot",
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("FTS indexes only visible text, validates grammar, respects owner filters and preserves phrases across chunks", async (t) => {
  const f = fixture(t);
  const large =
    "padding ".repeat(255) +
    "crossboundary" +
    " ".repeat(20_000) +
    "exactphrase" +
    " suffix".repeat(1800);
  const file = f.file("visible.jsonl", [
    header("same-native"),
    message("user", "uniqueword bright amber fox"),
    {
      type: "message",
      id: "assistant",
      timestamp,
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "thinkingsecret" },
          { type: "text", text: "assistantvisible" },
          { type: "toolCall", id: "call", name: "tool", arguments: { text: "argumentsecret" } },
        ],
        providerData: "providersecret",
      },
    },
    {
      type: "message",
      id: "tool",
      timestamp,
      message: {
        role: "toolResult",
        content: [
          { type: "text", text: "toolvisible" },
          { type: "image", data: "imagesecret", text: "imagefieldsecret" },
        ],
        details: { raw: "detailssecret" },
      },
    },
    { type: "custom", id: "hidden", timestamp, data: { text: "customdatasecret" } },
    { type: "custom_message", id: "notice", timestamp, display: true, content: "customvisible" },
    {
      type: "custom_message",
      id: "hidden-notice",
      timestamp,
      display: false,
      content: "hiddennoticesecret",
    },
    { type: "compaction", id: "summary", timestamp, summary: "summaryvisible" },
    message("long", large),
  ]);
  const archive = f.file("archive.jsonl", [
    header("same-native"),
    message("duplicate-id", "archivevisible uniqueword"),
  ]);
  await owned(f.index, [run("visible", file), run("archive", archive, "other")]);
  for (const query of [
    "uniqueword",
    '"bright amber fox"',
    "assistantvisible",
    "toolvisible",
    "customvisible",
    "summaryvisible",
    '"crossboundary exactphrase"',
  ]) {
    // Each scenario owns shared fixture state; complete it before starting the next one.
    // oxlint-disable-next-line no-await-in-loop
    assert.ok(Boolean((await f.index.search({ query, runId: "visible" })).matches.length), query);
  }
  for (const query of [
    "thinkingsecret",
    "argumentsecret",
    "providersecret",
    "imagesecret",
    "imagefieldsecret",
    "detailssecret",
    "customdatasecret",
    "hiddennoticesecret",
  ]) {
    // Each scenario owns shared fixture state; complete it before starting the next one.
    // oxlint-disable-next-line no-await-in-loop
    assert.equal((await f.index.search({ query })).matches.length, 0, query);
  }
  assert.equal(
    (await f.index.search({ query: "unique" })).matches.length,
    0,
    "token search is not substring search",
  );
  for (const query of ["word OR another", "word*", '"unterminated', "a-b", ""]) {
    // Each scenario owns shared fixture state; complete it before starting the next one.
    // oxlint-disable-next-line no-await-in-loop
    await assert.rejects(f.index.search({ query }), code("INVALID_QUERY"));
  }
  const filtered = await f.index.search({ query: "uniqueword", agent: "other", limit: 1 });
  assert.equal(filtered.matches[0].runId, "archive");
  assert.ok(filtered.matches[0].preview.length <= 512);
  const page = await f.index.search({ query: "uniqueword", sort: "newest", limit: 1 });
  const second = await f.index.search({
    query: "uniqueword",
    sort: "newest",
    limit: 1,
    cursor: page.nextCursor,
  });
  assert.notEqual(page.matches[0].runId, second.matches[0].runId);
  assert.notEqual(
    page.matches[0].ref.sourceId,
    second.matches[0].ref.sourceId,
    "logical UUID does not collapse physical archives",
  );
  await assert.rejects(
    f.index.search({ query: "uniqueword", sort: "relevance", cursor: page.nextCursor }),
    code("STALE_CURSOR"),
  );
  assert.equal((await f.index.status()).physicalSources, 2);
});

test("search tokenizes visible text after streaming terminal-sequence removal", async (t) => {
  const f = fixture(t);
  const file = f.file("terminal-search.jsonl", [
    header(),
    message(
      "colored",
      "\x1b[31mredneedle\x1b[0m re\x1b[32mdjoined\x1b[0m \x1b]8;;https://hiddenurl\x1b\\linkneedle\x1b]8;;\x1b\\",
    ),
    message(
      "split-controls",
      "padding ".repeat(8190) +
        "\x1b]" +
        "hiddenpayload ".repeat(6000) +
        "\x1b\\splitneedle \x9b31mc1needle\x9b0m",
    ),
    {
      ...message("field-isolation", ""),
      message: {
        role: "user",
        content: [
          { type: "text", text: "\x1b]unterminated" },
          { type: "text", text: "fieldneedle" },
        ],
      },
    },
    message("record-isolation", "recordneedle"),
  ]);
  await owned(f.index, [run("terminal-records", file)]);
  for (const query of [
    "redneedle",
    "redjoined",
    "linkneedle",
    "splitneedle",
    "c1needle",
    "fieldneedle",
    "recordneedle",
  ]) {
    // Each scenario owns shared fixture state; complete it before starting the next one.
    // oxlint-disable-next-line no-await-in-loop
    assert.equal((await f.index.search({ query })).matches.length, 1, query);
  }
  for (const query of ["31mredneedle", "hiddenurl", "hiddenpayload", "unterminated"]) {
    // Each scenario owns shared fixture state; complete it before starting the next one.
    // oxlint-disable-next-line no-await-in-loop
    assert.equal((await f.index.search({ query })).matches.length, 0, query);
  }
});

test("multiword search matches whole native records before ranking and pagination", async (t) => {
  const f = fixture(t);
  const file = f.file("record-search.jsonl", [
    header(),
    message("far-apart", "firstneedle " + "padding ".repeat(600) + "lastneedle"),
    {
      ...message("separate-fields", ""),
      message: {
        role: "user",
        content: [
          { type: "text", text: "firstneedle" },
          { type: "text", text: "lastneedle" },
        ],
      },
    },
    message("only-first", "firstneedle"),
    message("only-last", "lastneedle"),
  ]);
  await owned(f.index, [run("search-records", file)]);
  for (const sort of ["relevance", "newest"] as const) {
    // Each scenario owns shared fixture state; complete it before starting the next one.
    // oxlint-disable-next-line no-await-in-loop
    const first = await f.index.search({ query: "firstneedle lastneedle", sort, limit: 1 });
    assert.equal(first.matches.length, 1);
    assert.ok(Boolean(first.nextCursor));
    // Each scenario owns shared fixture state; complete it before starting the next one.
    // oxlint-disable-next-line no-await-in-loop
    const second = await f.index.search({
      query: "firstneedle lastneedle",
      sort,
      limit: 1,
      cursor: first.nextCursor,
    });
    assert.deepEqual([first.matches[0].entryId, second.matches[0].entryId].sort(), [
      "far-apart",
      "separate-fields",
    ]);
    assert.equal(second.nextCursor, undefined);
  }
  assert.equal(
    (await f.index.search({ query: '"firstneedle lastneedle"' })).matches.length,
    0,
    "phrases cannot jump windows or text fields",
  );
  assert.equal(
    (await f.index.search({ query: "padding", runId: "search-records" })).matches.length,
    1,
    "overlapping windows do not duplicate native-record results",
  );
});

for (const interrupted of [false, true]) {
  test(`concurrent workers preserve staged entries when the first writer ${interrupted ? "is killed" : "finishes"}`, async (t) => {
    const f = fixture(t),
      file = f.file("concurrent.jsonl", [header()]),
      runs = [run("concurrent", file)];
    await owned(f.index, runs);
    await f.index.close();
    fs.appendFileSync(
      file,
      lines([
        {
          type: "model_change",
          id: "configuration",
          parentId: null,
          timestamp,
          provider: "synthetic",
          modelId: "concurrent",
        },
        {
          ...message("retained", "concurrentneedle " + "padding ".repeat(9000)),
          parentId: "configuration",
        },
      ]),
    );
    const original = fs.readFileSync(file);
    const start = async (pause: "staged" | "opened") => {
      const worker = fork(
        new URL("../fixtures/history-staged-writer.ts", import.meta.url),
        [f.agentDir, pause],
        { stdio: ["ignore", "ignore", "inherit", "ipc"] },
      );
      const exited = once(worker, "exit");
      t.after(async () => {
        if (worker.exitCode === null && worker.signalCode === null) {
          worker.kill("SIGKILL");
        }
        await exited;
      });
      assert.deepEqual((await once(worker, "message"))[0], { ready: true });
      return {
        worker,
        exited,
        async finish() {
          const finished = once(worker, "message");
          worker.send("finish");
          assert.deepEqual((await finished)[0], { finished: true });
          await exited;
        },
      };
    };
    const first = await start("staged");
    if (interrupted) {
      await f.restart();
      await f.index.setOwner({ ownerSessionId: "parent", runs });
      const refresh = f.index.refresh();
      // The public worker keeps serving IPC while waiting for another writer.
      for (let request = 0; request < 8; request++) {
        // Each scenario owns shared fixture state; complete it before starting the next one.
        // oxlint-disable-next-line no-await-in-loop
        await f.index.listRuns();
      }
      first.worker.kill("SIGKILL");
      await first.exited;
      await refresh;
    } else {
      // Open the second ingest before the first publishes, but don't let it
      // replay yet: this deterministically exposed deletion of shared staging.
      const second = await start("opened");
      await first.finish();
      await second.finish();
      await f.restart();
      await owned(f.index, runs);
    }
    const page = await f.index.historyPage({ runId: "concurrent", index: 0 });
    assert.deepEqual(
      page.entries.map((entry) => entry.id),
      ["configuration", "retained"],
    );
    assert.equal(page.configuration.model, "synthetic/concurrent");
    assert.equal(page.freshness.state, "current");
    assert.equal((await f.index.search({ query: "concurrentneedle" })).matches.length, 1);
    assert.deepEqual(fs.readFileSync(file), original);
    await f.restart();
    await owned(f.index, runs);
    assert.equal((await f.index.historyPage({ runId: "concurrent", index: 0 })).count, 2);
  });
}

test("over-budget non-text structures degrade the index without assembling them or losing later published records", async (t) => {
  const f = fixture(t);
  let nested: unknown = "ignored";
  for (let depth = 0; depth < 80; depth++) {
    nested = { next: nested };
  }
  const file = f.file("structure.jsonl", [
    header(),
    {
      type: "message",
      id: "images",
      timestamp,
      message: {
        role: "toolResult",
        content: Array.from({ length: 10_000 }, () => ({ type: "image", mimeType: "image/png" })),
      },
    },
    { type: "custom", id: "nested", timestamp, data: nested },
    {
      type: "message",
      id: "long-key",
      timestamp,
      message: {
        role: "user",
        content: [{ type: "text", ["private".repeat(100)]: "not exposed" }],
      },
    },
    message("after-budget", "afterbudgetword"),
  ]);
  const before = fs.readFileSync(file);
  await f.index.setOwner({ ownerSessionId: "parent", runs: [run("structure", file)] });
  await assert.rejects(f.index.refresh(), code("DEGRADED"));
  const page = await f.index.historyPage({ runId: "structure", index: 0 });
  assert.deepEqual(
    page.entries.map((entry) => entry.id),
    ["after-budget"],
  );
  assert.equal(page.freshness.state, "degraded");
  const defined43032_0 = page.unavailable;
  assertDefined(defined43032_0);
  assert.match(defined43032_0, /3 exceeded bounded history structure\/text budgets/);
  assert.equal(
    (await f.index.search({ query: "afterbudgetword" })).matches[0].entryId,
    "after-budget",
  );
  assert.deepEqual(fs.readFileSync(file), before);
});

test("LF publication, malformed lines, append, replacement, truncation and deletion have explicit generation/freshness outcomes", async (t) => {
  const f = fixture(t),
    file = f.file("mutable.jsonl", [header(), message("first", "originalword")]);
  await owned(f.index, [run("mutable", file)]);
  const original = (await f.index.historyPage({ runId: "mutable", index: 0 })).entries[0];
  fs.appendFileSync(file, JSON.stringify(message("partial", "partialword")));
  await f.index.refresh("mutable");
  let page = await f.index.historyPage({ runId: "mutable", index: 0 });
  assert.equal(page.count, 1);
  assert.equal(page.sourceState, "partial");
  assert.equal((await f.index.search({ query: "partialword" })).matches.length, 0);
  fs.appendFileSync(file, "\n");
  await f.index.refresh("mutable");
  assert.equal((await f.index.historyPage({ runId: "mutable", index: 0 })).count, 2);
  fs.appendFileSync(file, '{broken "secret-no-log"}\n' + lines([message("third", "afterbroken")]));
  await assert.rejects(f.index.refresh("mutable"), code("DEGRADED"));
  page = await f.index.historyPage({ runId: "mutable", index: 0 });
  assert.equal(page.count, 3);
  assert.equal(page.freshness.state, "degraded");
  assert.equal(page.sourceState, "degraded");
  assertDefined(page.unavailable);
  assert.ok(Boolean(page.unavailable) && !page.unavailable.includes("secret-no-log"));
  assert.equal((await f.index.search({ query: "afterbroken" })).matches.length, 1);
  const replacement = f.file("replacement.jsonl", [header(), message("first", "rewrittenword")]);
  fs.renameSync(replacement, file);
  await assert.rejects(
    f.index.record({ runId: "mutable", index: 0, ref: original.ref }),
    code("SOURCE_CHANGED"),
  );
  await f.index.refresh("mutable");
  page = await f.index.historyPage({ runId: "mutable", index: 0 });
  const defined45079_0 = page.generation;
  assertDefined(defined45079_0);
  assert.ok(defined45079_0 > original.ref.generation);
  assert.equal(page.count, 1);
  assert.equal((await f.index.search({ query: "originalword" })).matches.length, 0);
  fs.writeFileSync(file, lines([header()]));
  await f.index.refresh("mutable");
  assert.equal((await f.index.historyPage({ runId: "mutable", index: 0 })).count, 0);
  fs.unlinkSync(file);
  await assert.rejects(f.index.refresh("mutable"), code("DEGRADED"));
  page = await f.index.historyPage({ runId: "mutable", index: 0 });
  assert.equal(page.sourceState, "missing");
  assert.equal(page.freshness.state, "degraded");
  assert.equal((await f.index.search({ query: "rewrittenword" })).matches.length, 0);
  fs.writeFileSync(file, lines([header(), message("restored", "restoredword")]));
  await f.index.refresh("mutable");
  assert.equal((await f.index.historyPage({ runId: "mutable", index: 0 })).count, 1);
});

test("persistent replay publishes cursor and entries together; legacy missing identities remain visible and corrupt indexes rebuild", async (t) => {
  const f = fixture(t),
    file = f.file("legacy.jsonl", [
      header("legacy-child", 1),
      { type: "message", timestamp, message: { role: "user", content: "legacyvisible" } },
    ]);
  const runs = [run("legacy", file), run("unlinked")];
  await owned(f.index, runs);
  const old = await f.index.historyPage({ runId: "legacy", index: 0 });
  assert.equal(old.entries[0].nativeId, null);
  assert.match(
    old.entries[0].id,
    /^legacy-\d+$/,
    "legacy view IDs stay stable for saved read markers",
  );
  assert.equal((await f.index.historyPage({ runId: "unlinked", index: 0 })).sourceId, null);
  const status = await f.index.status();
  assert.ok(
    status.databaseFile.startsWith(path.join(fs.realpathSync(f.agentDir), "history-index")),
  );
  assert.equal(fs.statSync(path.dirname(status.databaseFile)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(status.databaseFile).mode & 0o777, 0o600);
  await f.restart();
  await owned(f.index, runs);
  assert.equal((await f.index.status()).databaseFile, status.databaseFile);
  assert.deepEqual(
    (await f.index.historyPage({ runId: "legacy", index: 0 })).entries.map((entry) => entry.id),
    old.entries.map((entry) => entry.id),
  );
  fs.appendFileSync(file, lines([message("append", "replayword")]));
  await f.index.refresh();
  await f.index.close();
  const db = new DatabaseSync(status.databaseFile);
  const defined47500_0 = db.prepare("PRAGMA quick_check").get();
  assertDefined(defined47500_0);
  assert.equal(defined47500_0.quick_check, "ok");
  const defined47575_0 = db.prepare("SELECT cursor FROM sources").get();
  assertDefined(defined47575_0);
  const cursor = defined47575_0.cursor;
  const publication = db.prepare("SELECT COUNT(*) AS count FROM entries WHERE published=1").get();
  assertDefined(publication);
  const published = publication.count;
  assert.equal(cursor, fs.statSync(file).size);
  assert.equal(published, 2);
  const defined47840_0 = db
    .prepare("SELECT COUNT(*) AS count FROM entries WHERE published=0")
    .get();
  assertDefined(defined47840_0);
  assert.equal(defined47840_0.count, 0);
  // The previous schema could mark a cursor current after losing an entry.
  // Upgrade must rebuild, not trust that apparently complete cursor.
  db.exec("DELETE FROM entries; PRAGMA user_version=4; PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  await f.restart();
  await owned(f.index, runs);
  const repaired = await f.index.status();
  assert.notEqual(repaired.databaseFile, status.databaseFile);
  assert.equal((await f.index.historyPage({ runId: "legacy", index: 0 })).count, 2);
  await f.index.close();
  fs.writeFileSync(repaired.databaseFile, "corrupted disposable SQLite");
  await f.restart();
  await owned(f.index, runs);
  assert.notEqual((await f.index.status()).databaseFile, repaired.databaseFile);
  assert.equal((await f.index.search({ query: "replayword" })).matches.length, 1);
});

test("canonical durable-run projection is read-only and never turns transcript presence into completion proof", async (t) => {
  const f = fixture(t),
    file = f.file("durable.jsonl", [header(), message("last", "saved context only")]);
  const root = path.join(f.agentDir, "sessions", "subagent-runs", "durable");
  fs.mkdirSync(root, { recursive: true });
  const statusFile = path.join(root, "status.json");
  const status = {
    runId: "durable",
    runtimeVersion: 2,
    mode: "single",
    state: "running",
    startedAt: 100,
    lastUpdate: 200,
    pid: 2_000_000_000,
    steps: [{ agent: "worker", status: "running", sessionFile: file }],
  };
  fs.writeFileSync(statusFile, JSON.stringify(status));
  const ownedRun = { ...run("durable", file), source: "async" as const, asyncDir: root };
  await owned(f.index, [ownedRun]);
  const row = (await f.index.listRuns()).rows[0];
  assert.equal(row.state, "unknown");
  assert.ok(row.diagnosis?.includes("unconfirmed") === true);
  assert.deepEqual(readRunStatus(statusFile), status);
  assert.equal(fs.existsSync(path.join(root, "result.json")), false);
  assert.equal(fs.existsSync(path.join(root, "events.jsonl")), false);
});

test("background catch-up leaves parent/query progress responsive and hard cancellation replays without orphan resources", async (t) => {
  const f = fixture(t),
    file = f.file("backfill.jsonl", [
      header(),
      ...Array.from({ length: 1200 }, (_, index) =>
        message(`backfill-${index}`, "heartbeatword " + "visible ".repeat(100)),
      ),
    ]),
    runs = [run("backfill", file)];
  const metadataRoot = path.join(f.agentDir, "sessions", "subagent-runs"),
    directory = path.join(metadataRoot, "backfill");
  fs.mkdirSync(directory, { recursive: true });
  let beats = 0,
    notifications = 0;
  const timer = setInterval(() => {
    beats++;
  }, 5);
  t.after(async () => clearInterval(timer));
  const unsubscribe = f.index.onChanged(() => {
    notifications++;
  });
  await f.index.setOwner({ ownerSessionId: "parent", runs });
  const before = await f.index.listRuns();
  assert.equal(before.total, 1);
  assert.equal(before.freshness.state, "catching-up");
  const controller = new AbortController();
  const backfill = f.index.refresh(undefined, { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(backfill, code("CANCELLED"));
  await assert.rejects(f.index.historyPage({ runId: "backfill", index: 0 }), code("CANCELLED"));
  assert.ok(beats > 0, "parent timers must run while parser/SQLite are busy");
  await f.index.refresh();
  assert.equal((await f.index.historyPage({ runId: "backfill", index: 0 })).count, 1200);
  for (let index = 0; index < 8000; index++) {
    fs.mkdirSync(path.join(metadataRoot, `foreign-${index}`));
  }
  assert.equal(
    (await f.index.status()).publishedEntries,
    1200,
    "foreign directory churn must not starve the history IPC deadline",
  );
  const observedTask = async (task: string) => {
    const deadline = Date.now() + 10_000;
    // Observe the owner publication before advancing this lifecycle transition.
    // oxlint-disable-next-line no-await-in-loop
    while ((await f.index.listRuns()).rows[0].children[0].task !== task) {
      assert.ok(
        Date.now() < deadline,
        `watch publishes nested owned task ${task} without refresh or census`,
      );
      // Observe the owner publication before advancing this lifecycle transition.
      // oxlint-disable-next-line no-await-in-loop
      await delay(10);
    }
  };
  const publishTask = (task: string) => {
    fs.mkdirSync(path.join(directory, "contracts"), { recursive: true });
    const temporary = path.join(directory, "contracts", "0.json.tmp");
    fs.writeFileSync(temporary, JSON.stringify({ task, sessionFile: file }));
    fs.renameSync(temporary, path.join(directory, "contracts", "0.json"));
  };
  publishTask("Nested owned publication");
  await observedTask("Nested owned publication");
  publishTask("Nested owned update");
  await observedTask("Nested owned update");
  fs.rmSync(directory, { recursive: true });
  await observedTask("Task backfill");
  publishTask("Recreated owned directory");
  await observedTask("Recreated owned directory");
  publishTask("Recreated nested update");
  await observedTask("Recreated nested update");
  fs.appendFileSync(file, lines([message("watched-append", "linked native source update")]));
  const sourceDeadline = Date.now() + 10_000;
  // Observe the owner publication before advancing this lifecycle transition.
  // oxlint-disable-next-line no-await-in-loop
  while ((await f.index.historyPage({ runId: "backfill", index: 0 })).count !== 1201) {
    assert.ok(
      Date.now() < sourceDeadline,
      "linked source parent watch publishes native append without refresh",
    );
    // Observe the owner publication before advancing this lifecycle transition.
    // oxlint-disable-next-line no-await-in-loop
    await delay(10);
  }
  const colocated = path.join(directory, "shared-native.jsonl");
  fs.writeFileSync(colocated, lines([header("shared-native")]));
  await f.index.updateRun(run("shared-native", colocated));
  await f.index.refresh("shared-native");
  fs.appendFileSync(
    colocated,
    lines([message("shared-append", "source inside another admitted metadata tree")]),
  );
  const sharedDeadline = Date.now() + 10_000;
  // Observe the owner publication before advancing this lifecycle transition.
  // oxlint-disable-next-line no-await-in-loop
  while ((await f.index.historyPage({ runId: "shared-native", index: 0 })).count !== 1) {
    assert.ok(
      Date.now() < sharedDeadline,
      "co-located metadata and linked-source watches retain both dirty queues",
    );
    // Observe the owner publication before advancing this lifecycle transition.
    // oxlint-disable-next-line no-await-in-loop
    await delay(10);
  }
  fs.rmSync(directory, { recursive: true });
  await observedTask("Task backfill");
  publishTask("Recreated shared source parent");
  fs.writeFileSync(
    colocated,
    lines([header("shared-native"), message("replacement", "recreated linked native source")]),
  );
  await observedTask("Recreated shared source parent");
  const recreatedSourceDeadline = Date.now() + 10_000;
  while (
    // Observe the owner publication before retrying this lifecycle check.
    // oxlint-disable-next-line no-await-in-loop
    (await f.index.historyPage({ runId: "shared-native", index: 0 })).entries[0]?.id !==
    "replacement"
  ) {
    assert.ok(
      Date.now() < recreatedSourceDeadline,
      "owned directory recreation catches up its co-located source without refresh",
    );
    // Observe the owner publication before advancing this lifecycle transition.
    // oxlint-disable-next-line no-await-in-loop
    await delay(10);
  }
  fs.appendFileSync(
    colocated,
    lines([message("replacement-append", "new source parent watch remains live")]),
  );
  // Observe the owner publication before advancing this lifecycle transition.
  // oxlint-disable-next-line no-await-in-loop
  while ((await f.index.historyPage({ runId: "shared-native", index: 0 })).count !== 2) {
    assert.ok(
      Date.now() < recreatedSourceDeadline,
      "owned directory recreation reinstalls its co-located source-parent watch",
    );
    // Observe the owner publication before advancing this lifecycle transition.
    // oxlint-disable-next-line no-await-in-loop
    await delay(10);
  }
  await f.index.refresh();
  assert.ok(notifications > 0);
  unsubscribe();
  const done = await f.index.status(),
    start = done.operations;
  for (let page = 0; page < 10; page++) {
    // Each scenario owns shared fixture state; complete it before starting the next one.
    // oxlint-disable-next-line no-await-in-loop
    await f.index.historyPage({ runId: "backfill", index: 0, limit: 10 });
  }
  const warm = await f.index.status();
  assert.equal(warm.operations.sourceChecks, start.sourceChecks);
  assert.equal(warm.operations.sourceBytesRead, start.sourceBytesRead);
  assert.equal(warm.operations.runProjections, start.runProjections);
  await f.index.close();
  await assert.rejects(f.index.listRuns(), code("CLOSED"));
  await f.restart();
  await owned(f.index, runs);
  assert.equal((await f.index.status()).publishedEntries, 1201);
});
