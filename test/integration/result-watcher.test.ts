import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { createResultWatcher } from "../../src/runs/background/result-watcher.ts";
import { reconcileAsyncRun } from "../../src/runs/background/stale-run-reconciler.ts";
import { createNestedRoute, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";
import type { SubagentState } from "../../src/shared/types.ts";
import { createEventBus } from "../support/helpers.ts";
import { getRunMetadataDir } from "../../src/runs/shared/supervisor-questions.ts";
import { randomUUID } from "node:crypto";

async function waitFor(check: () => boolean, message: string) {
  const deadline = performance.now() + 5_000;
  while (!check()) {
    assert.ok(performance.now() < deadline, message);
    await delay(5);
  }
}

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function createState(): SubagentState {
  return {
    baseCwd: "/repo",
    currentSessionId: null,
    asyncJobs: new Map(),
    cleanupTimers: new Map(),
    lastUiContext: null,
    poller: null,
    completionSeen: new Map(),
    watcher: null,
    watcherRestartTimer: null,
    resultFileCoalescer: {
      schedule: () => false,
      clear: () => {},
    },
  };
}

function observeReads(t: TestContext) {
  const reads = new Map<string, number>();
  const open = fs.openSync;
  t.mock.method(fs, "openSync", function (file, ...args) {
    const fd = Reflect.apply(open, fs, [file, ...args]);
    if (args[0] === "r") {
      reads.set(String(file), (reads.get(String(file)) ?? 0) + 1);
    }
    return fd;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return async (watcher: ReturnType<typeof createResultWatcher>, file: string, count = 1) => {
    await waitFor(() => (reads.get(file) ?? 0) >= count, `watcher must read ${file}`);
    await watcher.joinInFlight();
  };
}

describe("result watcher", () => {
  it("does not reread unchanged foreign results or probe delivered run files, but retries changed identity and ownership", async (t) => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-cost-"));
    const state = createState(),
      events = createEventBus(),
      emitted: unknown[] = [];
    state.currentSessionId = "parent";
    state.ownedRuns = new Map(
      Array.from({ length: 500 }, (_, index) => {
        const runId = `delivered-${index}`;
        return [
          runId,
          {
            runId,
            rootRunId: runId,
            ownerSessionId: "parent",
            source: "async" as const,
            mode: "single" as const,
            cwd: "/repo",
            task: "Done",
            startedAt: 1,
            children: [],
            accounting: { state: "complete" as const },
            delivery: { notifiedAt: 1, intercomDelivered: false, entryId: `receipt-${index}` },
          },
        ];
      }),
    );
    let reads = 0,
      completedProbes = 0,
      stamps = 0;
    events.on("subagent:async-complete", (data) => emitted.push(data));
    const open = fs.openSync,
      exists = fs.existsSync,
      stat = fs.statSync;
    t.mock.method(fs, "openSync", function (...args) {
      if (args[1] === "r") {
        reads++;
      }
      return Reflect.apply(open, fs, args);
    });
    t.mock.method(fs, "existsSync", function (file) {
      if (String(file).includes("delivered-")) {
        completedProbes++;
      }
      return exists(file);
    });
    t.mock.method(fs, "statSync", function (...args) {
      stamps++;
      return Reflect.apply(stat, fs, args);
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    const watcher = createResultWatcher({ events }, state, resultsDir);
    const file = path.join(resultsDir, "foreign.json");
    const write = (sessionId: string) =>
      fs.writeFileSync(
        file,
        JSON.stringify({ id: "foreign", sessionId, success: true, summary: "Saved output" }),
      );
    const scan = async (decoded = false) => {
      const before = stamps,
        priorReads = reads;
      watcher.primeExistingResults();
      await waitFor(
        () => (decoded ? reads > priorReads : stamps > before),
        "result scan must observe the actual file identity",
      );
      await watcher.joinInFlight();
    };
    try {
      write("other");
      for (let index = 0; index < 3; index++) {
        await scan(index === 0);
      }
      assert.equal(reads, 1, "foreign content is decoded once, not on every safety poll");
      assert.equal(completedProbes, 0, "delivered and billed runs do not need filesystem probes");
      assert.equal(emitted.length, 0);
      write("parent");
      await scan(true);
      assert.equal(emitted.length, 1, "a changed result is validated and delivered");
      write("other");
      await scan(true);
      state.ownedRuns.set("foreign", {
        runId: "foreign",
        rootRunId: "foreign",
        ownerSessionId: "parent",
        source: "async",
        mode: "single",
        cwd: "/repo",
        task: "Recovered work",
        startedAt: 1,
        children: [],
      });
      state.completionSeen.clear();
      await scan(true);
      assert.equal(
        emitted.length,
        2,
        "new genuine ownership invalidates the foreign classification",
      );
      assert.equal(fs.existsSync(file), false);
    } finally {
      watcher.stopResultWatcher();
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("stopping recovery cancels queued starts while preserving files for the next start", async () => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-stop-"));
    const state = createState(),
      reconciled: string[] = [];
    state.currentSessionId = "parent";
    for (const id of ["first", "second"]) {
      fs.writeFileSync(
        path.join(resultsDir, `${id}.json`),
        JSON.stringify({ id, sessionId: "parent", success: true, summary: "Done" }),
      );
    }
    const watcher = createResultWatcher({ events: createEventBus() }, state, resultsDir, {
      reconcileDelivery(runId) {
        reconciled.push(runId);
        if (reconciled.length === 1) {
          watcher.stopResultWatcher();
        }
        return true;
      },
    });
    try {
      watcher.primeExistingResults();
      await waitFor(() => reconciled.length === 1, "first recovery must reconcile");
      await watcher.joinInFlight();
      assert.deepEqual(reconciled, ["first"], "queued work cannot mutate after stop");
      assert.equal(
        fs.existsSync(path.join(resultsDir, "first.json")),
        false,
        "already-started work finishes normally",
      );
      assert.equal(fs.existsSync(path.join(resultsDir, "second.json")), true);
      watcher.startResultWatcher();
      watcher.primeExistingResults();
      await waitFor(() => reconciled.length === 2, "second recovery must reconcile");
      await watcher.joinInFlight();
      assert.deepEqual(reconciled, ["first", "second"], "the next start rediscovers retained work");
      assert.equal(fs.existsSync(path.join(resultsDir, "second.json")), false);
    } finally {
      watcher.stopResultWatcher();
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("recovers an owned canonical result once even when its disposable hint is corrupt, unreadable, or has another identity", async (t) => {
    for (const hintKind of ["corrupt", "unreadable", "wrong-identity", "valid"]) {
      const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-canonical-")),
        runId = randomUUID();
      const canonical = path.join(getRunMetadataDir(runId), "result.json"),
        hint = path.join(resultsDir, `${runId}.json`);
      const state = createState(),
        events = createEventBus(),
        completed: unknown[] = [];
      state.currentSessionId = "parent";
      state.ownedRuns = new Map([
        [
          runId,
          {
            runId,
            rootRunId: runId,
            ownerSessionId: "parent",
            source: "async",
            mode: "single",
            cwd: "/repo",
            task: "Done",
            startedAt: 1,
            children: [],
          },
        ],
      ]);
      const result = {
        runtimeVersion: 2,
        id: runId,
        sessionId: "parent",
        success: true,
        summary: "Canonical output",
        results: [],
      };
      fs.mkdirSync(getRunMetadataDir(runId), { recursive: true });
      fs.writeFileSync(canonical, JSON.stringify(result));
      fs.writeFileSync(
        hint,
        hintKind === "corrupt"
          ? "{"
          : JSON.stringify({ ...result, id: hintKind === "wrong-identity" ? "other" : runId }),
      );
      let canonicalReads = 0;
      const open = fs.openSync;
      t.mock.method(fs, "openSync", function (file, ...args) {
        if (file === canonical) {
          canonicalReads++;
        }
        if (file === hint && hintKind === "unreadable") {
          throw errno("EACCES");
        }
        return Reflect.apply(open, fs, [file, ...args]);
      });
      syncBuiltinESMExports();
      const watcher = createResultWatcher({ events }, state, resultsDir);
      events.on("subagent:async-complete", (event) => completed.push(event));
      try {
        watcher.primeExistingResults();
        await waitFor(() => completed.length === 1, "canonical recovery must publish");
        await watcher.joinInFlight();
        assert.equal(completed.length, 1, hintKind);
        assert.equal((completed[0] as { summary: string }).summary, "Canonical output");
        assert.equal(
          canonicalReads,
          1,
          "canonical and hint candidates must not duplicate decoding",
        );
        assert.equal(fs.existsSync(canonical), true, "canonical result remains durable");
        assert.equal(
          fs.existsSync(hint),
          false,
          "successful recovery consumes the disposable hint",
        );
      } finally {
        watcher.stopResultWatcher();
        t.mock.restoreAll();
        syncBuiltinESMExports();
        fs.rmSync(getRunMetadataDir(runId), { recursive: true, force: true });
        fs.rmSync(resultsDir, { recursive: true, force: true });
      }
    }
  });

  it("live durable polls avoid parent receipt scans until an actual result exists", async () => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-live-")),
      runId = randomUUID();
    const state = createState(),
      events = createEventBus(),
      completed: unknown[] = [];
    state.currentSessionId = "parent";
    state.ownedRuns = new Map([
      [
        runId,
        {
          runId,
          rootRunId: runId,
          ownerSessionId: "parent",
          source: "async",
          mode: "single",
          cwd: "/repo",
          task: "Running",
          startedAt: 1,
          children: [],
        },
      ],
    ]);
    let scans = 0;
    state.isRunResultConsumed = () => {
      scans++;
      return false;
    };
    events.on("subagent:async-complete", (event) => completed.push(event));
    const watcher = createResultWatcher({ events }, state, resultsDir);
    try {
      watcher.primeExistingResults();
      watcher.primeExistingResults();
      assert.equal(scans, 0, "live polls perform no parent receipt I/O");
      fs.mkdirSync(getRunMetadataDir(runId), { recursive: true });
      fs.writeFileSync(
        path.join(getRunMetadataDir(runId), "result.json"),
        JSON.stringify({
          runtimeVersion: 2,
          id: runId,
          sessionId: "parent",
          success: true,
          summary: "Done",
          results: [],
        }),
      );
      watcher.primeExistingResults();
      await waitFor(() => completed.length === 1, "saved result must complete");
      await watcher.joinInFlight();
      assert.ok(scans > 0, "completed work still checks parent receipts");
      assert.equal(completed.length, 1);
    } finally {
      watcher.stopResultWatcher();
      fs.rmSync(getRunMetadataDir(runId), { recursive: true, force: true });
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("processes deferred session-scoped results after session identity is restored", async (t) => {
    const processed = observeReads(t);
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-session-"));
    try {
      const emitted: Array<{ event: string; data: unknown }> = [];
      const pi = {
        events: {
          on: () => () => {},
          emit(event: string, data: unknown) {
            emitted.push({ event, data });
          },
        },
      };
      const state = createState();
      const resultPath = path.join(resultsDir, "session-run.json");
      fs.writeFileSync(
        resultPath,
        JSON.stringify({
          id: "session-run",
          sessionId: "session-current",
          success: true,
          summary: "done",
        }),
        "utf-8",
      );

      const watcher = createResultWatcher(pi, state, resultsDir);
      try {
        watcher.primeExistingResults();
        await processed(watcher, resultPath);
        assert.equal(emitted.length, 0);
        assert.equal(fs.existsSync(resultPath), true);

        state.currentSessionId = "session-current";
        watcher.primeExistingResults();
        await processed(watcher, resultPath, 2);
      } finally {
        watcher.stopResultWatcher();
      }

      assert.equal(emitted.filter((entry) => entry.event === "subagent:async-complete").length, 1);
      assert.equal(fs.existsSync(resultPath), false);
    } finally {
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("resolves the current intercom identity only after the saved parent ownership gate", async (t) => {
    const processed = observeReads(t);
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-restarted-owner-"));
    const events = createEventBus();
    const deliveries: Array<{ to: string; requestId: string }> = [];
    const completions: unknown[] = [];
    let identityRequests = 0;
    events.on("subagent:intercom-identity-request", (payload) => {
      identityRequests++;
      events.emit("subagent:intercom-identity-response", {
        requestId: (payload as { requestId: string }).requestId,
        sessionId: "current-owner-runtime",
      });
    });
    events.on("subagent:result-intercom", (payload) => {
      const delivery = payload as { to: string; requestId: string };
      deliveries.push(delivery);
      events.emit("subagent:result-intercom-delivery", {
        requestId: delivery.requestId,
        delivered: true,
      });
    });
    events.on("subagent:async-complete", (payload) => completions.push(payload));
    const state = createState();
    state.currentSessionId = "different-parent";
    state.ownedRuns = new Map([
      [
        "restarted-owner",
        {
          runId: "restarted-owner",
          ownerSessionId: "saved-parent",
          source: "async",
          mode: "single",
          cwd: "/repo",
          task: "Saved work",
          startedAt: 100,
          rootRunId: "restarted-owner",
          children: [],
        },
      ],
    ]);
    const watcher = createResultWatcher({ events }, state, resultsDir);
    const resultPath = path.join(resultsDir, "restarted-owner.json");
    try {
      fs.writeFileSync(
        resultPath,
        JSON.stringify({
          id: "restarted-owner",
          sessionId: "saved-parent",
          cwd: "/repo",
          success: true,
          summary: "Saved child evidence",
          intercomTarget: "previous-owner-runtime",
        }),
      );
      watcher.primeExistingResults();
      await processed(watcher, resultPath);
      assert.equal(fs.existsSync(resultPath), true);
      assert.equal(
        identityRequests,
        0,
        "matching cwd or a copied run cannot bypass an explicit different owner",
      );
      assert.deepEqual(deliveries, []);
      assert.deepEqual(completions, []);

      state.currentSessionId = "saved-parent";
      watcher.primeExistingResults();
      await processed(watcher, resultPath, 2);
      assert.deepEqual(
        deliveries.map((delivery) => delivery.to),
        ["current-owner-runtime"],
      );
      assert.equal(identityRequests, 1);
      assert.equal(completions.length, 1);
      assert.equal(fs.existsSync(resultPath), false);
    } finally {
      watcher.stopResultWatcher();
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("requires saved ownership rather than matching cwd when delivering a stale legacy run", async (t) => {
    const processed = observeReads(t);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-stale-legacy-"));
    const resultsDir = path.join(root, "results");
    const asyncDir = path.join(root, "runs", "legacy-stale");
    try {
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify({
          runId: "legacy-stale",
          mode: "single",
          state: "running",
          pid: 12345,
          cwd: "/repo-current",
          startedAt: 100,
          lastUpdate: 100,
          steps: [{ agent: "reviewer", status: "running", startedAt: 100 }],
        }),
        "utf-8",
      );
      const repair = reconcileAsyncRun(asyncDir, {
        resultsDir,
        kill: () => {
          throw errno("ESRCH");
        },
        now: () => 200,
      });
      assert.equal(repair.repaired, true);
      const resultPath = path.join(resultsDir, "legacy-stale.json");
      assert.equal(JSON.parse(fs.readFileSync(resultPath, "utf-8")).cwd, "/repo-current");

      const emitted: Array<{ event: string; data: unknown }> = [];
      const pi = {
        events: {
          on: () => () => {},
          emit(event: string, data: unknown) {
            emitted.push({ event, data });
          },
        },
      };
      const foreignState = createState();
      foreignState.baseCwd = "/repo-foreign";
      const foreignWatcher = createResultWatcher(pi, foreignState, resultsDir);
      try {
        foreignWatcher.primeExistingResults();
        await processed(foreignWatcher, resultPath);
      } finally {
        foreignWatcher.stopResultWatcher();
      }
      assert.equal(emitted.length, 0);
      assert.equal(fs.existsSync(resultPath), true);

      const currentState = createState();
      currentState.baseCwd = "/repo-current";
      const currentWatcher = createResultWatcher(pi, currentState, resultsDir);
      try {
        currentWatcher.primeExistingResults();
        await processed(currentWatcher, resultPath, 2);
        assert.equal(emitted.length, 0, "same cwd is not an ownership receipt");
        currentState.ownedRuns = new Map([
          [
            "legacy-stale",
            {
              runId: "legacy-stale",
              ownerSessionId: "parent",
              source: "async",
              mode: "single",
              cwd: "/repo-current",
              task: "Recovered work",
              startedAt: 100,
              rootRunId: "legacy-stale",
              children: [],
            },
          ],
        ]);
        currentWatcher.primeExistingResults();
        await processed(currentWatcher, resultPath, 3);
      } finally {
        currentWatcher.stopResultWatcher();
      }
      assert.equal(emitted.filter((entry) => entry.event === "subagent:async-complete").length, 1);
      assert.equal(fs.existsSync(resultPath), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not repeat changed results within the TTL and prunes expired transient completions", async (t) => {
    const processed = observeReads(t);
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-corrected-"));
    try {
      const emitted: Array<{ event: string; data: { success?: boolean; summary?: string } }> = [];
      const pi = {
        events: {
          on: () => () => {},
          emit(event: string, data: { success?: boolean; summary?: string }) {
            emitted.push({ event, data });
          },
        },
      };
      const state = createState();
      state.currentSessionId = "parent";
      const watcher = createResultWatcher(pi, state, resultsDir);
      try {
        fs.writeFileSync(
          path.join(resultsDir, "run-same.json"),
          JSON.stringify({
            id: "run-same",
            sessionId: "parent",
            cwd: "/repo",
            success: false,
            summary: "old",
          }),
          "utf-8",
        );
        watcher.primeExistingResults();
        await processed(watcher, path.join(resultsDir, "run-same.json"));
        fs.writeFileSync(
          path.join(resultsDir, "run-same.json"),
          JSON.stringify({
            id: "run-same",
            sessionId: "parent",
            cwd: "/repo",
            success: true,
            summary: "corrected",
          }),
          "utf-8",
        );
        watcher.primeExistingResults();
        await processed(watcher, path.join(resultsDir, "run-same.json"), 2);
        assert.equal(state.completionSeen.size, 1);
        t.mock.timers.tick(11 * 60_000);
        fs.writeFileSync(
          path.join(resultsDir, "run-next.json"),
          JSON.stringify({ id: "run-next", sessionId: "parent", success: true, summary: "next" }),
          "utf-8",
        );
        watcher.primeExistingResults();
        await processed(watcher, path.join(resultsDir, "run-next.json"));
        assert.deepEqual(
          [...state.completionSeen.keys()],
          ["completion:legacy:run-next:unknown"],
          "a new transient completion retires expired keys instead of retaining every finished run",
        );
      } finally {
        watcher.stopResultWatcher();
      }

      const completes = emitted.filter((entry) => entry.event === "subagent:async-complete");
      assert.deepEqual(
        completes.map((entry) => entry.data.summary),
        ["old", "next"],
      );
      assert.deepEqual(
        completes.map((entry) => entry.data.success),
        [false, true],
      );
    } finally {
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("logs malformed result files instead of swallowing them silently", async () => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-"));
    try {
      fs.writeFileSync(path.join(resultsDir, "bad.json"), "{bad-json", "utf-8");
      const emitted: unknown[] = [];
      const pi = {
        events: {
          on: () => () => {},
          emit(_event: string, data: unknown) {
            emitted.push(data);
          },
        },
      };
      const state = createState();
      const watcher = createResultWatcher(pi, state, resultsDir);
      const originalError = console.error;
      const logged: unknown[][] = [];
      console.error = (...args: unknown[]) => {
        logged.push(args);
      };
      try {
        watcher.primeExistingResults();
        await waitFor(() => logged.length > 0, "malformed input must reach watcher diagnostics");
        await watcher.joinInFlight();
      } finally {
        console.error = originalError;
        watcher.stopResultWatcher();
      }

      assert.equal(emitted.length, 0);
      assert.ok(
        logged.some((entry) =>
          /Failed to process subagent result file/.test(String(entry[0] ?? "")),
        ),
        "expected watcher error to be logged",
      );
    } finally {
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("periodically scans result files when fs.watch stays quiet", async (t) => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-quiet-"));
    try {
      const emitted: Array<{ event: string; data: unknown }> = [];
      const pi = {
        events: {
          on: () => () => {},
          emit(event: string, data: unknown) {
            emitted.push({ event, data });
          },
        },
      };
      const state = createState();
      state.currentSessionId = "session-1";
      const fakeWatcher = {
        on() {
          return fakeWatcher;
        },
        close() {},
        unref() {},
      } as fs.FSWatcher;
      t.mock.method(fs, "watch", () => fakeWatcher);
      syncBuiltinESMExports();
      t.after(() => {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      });
      t.mock.timers.enable({ apis: ["setInterval"] });
      const watcher = createResultWatcher(pi, state, resultsDir);
      try {
        watcher.startResultWatcher();
        assert.equal(state.watcher, fakeWatcher);

        fs.writeFileSync(
          path.join(resultsDir, "missed.json"),
          JSON.stringify({
            id: "missed",
            sessionId: "session-1",
            success: true,
            state: "complete",
            summary: "done despite a missed watch event",
          }),
          "utf-8",
        );
        t.mock.timers.tick(3_000);
        await waitFor(
          () => emitted.some((entry) => entry.event === "subagent:async-complete"),
          "native safety poll must publish the result",
        );
        await watcher.joinInFlight();
      } finally {
        watcher.stopResultWatcher();
      }

      assert.equal(emitted.filter((entry) => entry.event === "subagent:async-complete").length, 1);
      assert.equal(fs.existsSync(path.join(resultsDir, "missed.json")), false);
    } finally {
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("falls back to polling when fs.watch throws EMFILE and preserves grouped intercom delivery", async (t) => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-"));
    try {
      const emitted: Array<{ event: string; data: unknown }> = [];
      const listeners = new Map<string, Set<(payload: unknown) => void>>();
      const pi = {
        events: {
          on(event: string, handler: (payload: unknown) => void) {
            const eventListeners = listeners.get(event) ?? new Set();
            eventListeners.add(handler);
            listeners.set(event, eventListeners);
            return () => eventListeners.delete(handler);
          },
          emit(event: string, data: unknown) {
            emitted.push({ event, data });
            for (const handler of listeners.get(event) ?? []) {
              handler(data);
            }
            if (event === "subagent:result-intercom") {
              const requestId =
                data && typeof data === "object"
                  ? (data as { requestId?: unknown }).requestId
                  : undefined;
              if (typeof requestId === "string") {
                setImmediate(() =>
                  pi.events.emit("subagent:result-intercom-delivery", {
                    requestId,
                    delivered: true,
                  }),
                );
              }
            }
          },
        },
      };
      const state = createState();
      state.currentSessionId = "session-1";
      const emfile = new Error("too many open files") as NodeJS.ErrnoException;
      emfile.code = "EMFILE";
      t.mock.method(fs, "watch", () => {
        throw emfile;
      });
      syncBuiltinESMExports();
      t.after(() => {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      });
      t.mock.timers.enable({ apis: ["setInterval"] });
      const watcher = createResultWatcher(pi, state, resultsDir);
      const originalError = console.error;
      const childSessionPath = path.join(resultsDir, "a-session.jsonl");
      console.error = () => {};
      try {
        watcher.startResultWatcher();
        assert.equal(state.watcher, null);
        assert.notEqual(state.watcherRestartTimer, null);

        fs.writeFileSync(childSessionPath, "", "utf-8");
        fs.writeFileSync(
          path.join(resultsDir, "async-fallback.json"),
          JSON.stringify({
            id: "async-fallback",
            runId: "run-fallback",
            agent: "parallel:a+b",
            mode: "parallel",
            success: true,
            state: "complete",
            summary: "Combined summary",
            results: [
              {
                agent: "a",
                output: "Result from a",
                success: true,
                sessionFile: childSessionPath,
                intercomTarget: "subagent-a-run-fallback-1",
              },
              {
                agent: "b",
                output: "Result from b",
                success: false,
                error: "B failed",
                intercomTarget: "subagent-b-run-fallback-2",
              },
            ],
            sessionId: "session-1",
            intercomTarget: "subagent-chat-main",
          }),
          "utf-8",
        );
        t.mock.timers.tick(3_000);
        await waitFor(
          () => emitted.some((entry) => entry.event === "subagent:async-complete"),
          "native safety poll must publish the result",
        );
        await watcher.joinInFlight();
      } finally {
        console.error = originalError;
        watcher.stopResultWatcher();
      }

      const intercomEvents = emitted.filter((entry) => entry.event === "subagent:result-intercom");
      assert.equal(intercomEvents.length, 1);
      assert.equal(
        emitted.some((entry) => entry.event === "subagent:async-complete"),
        true,
      );
      assert.equal(fs.existsSync(path.join(resultsDir, "async-fallback.json")), false);
      const payload = intercomEvents[0]?.data as {
        mode?: string;
        status?: string;
        message?: string;
        children?: Array<{ status?: string; summary?: string; sessionPath?: string }>;
      };
      const completion = emitted.find((entry) => entry.event === "subagent:async-complete")
        ?.data as
        | { results?: Array<{ status?: string; summary?: string; sessionPath?: string }> }
        | undefined;
      assert.equal(payload.mode, "parallel");
      assert.equal(payload.status, "failed");
      assert.match(String(payload.message ?? ""), /Run: run-fallback/);
      assert.match(String(payload.message ?? ""), /Children: 1 completed, 1 failed/);
      assert.equal(payload.children?.[0]?.sessionPath, childSessionPath);
      assert.equal(completion?.results?.[0]?.sessionPath, childSessionPath);
      assert.equal(payload.children?.[1]?.status, "failed");
      assert.equal(completion?.results?.[1]?.status, "failed");
      assert.equal(payload.children?.[1]?.summary, "B failed\n\nOutput:\nResult from b");
      assert.equal(completion?.results?.[1]?.summary, "B failed\n\nOutput:\nResult from b");
    } finally {
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("falls back to polling when an active fs.watch emits ENOSPC", async (t) => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-"));
    try {
      const emitted: Array<{ event: string; data: unknown }> = [];
      const pi = {
        events: {
          on: () => () => {},
          emit(event: string, data: unknown) {
            emitted.push({ event, data });
          },
        },
      };
      const state = createState();
      state.currentSessionId = "session-1";
      let emitWatcherError: ((error: NodeJS.ErrnoException) => void) | undefined;
      const fakeWatcher = {
        on(event: string, handler: (error: NodeJS.ErrnoException) => void) {
          if (event === "error") {
            emitWatcherError = handler;
          }
          return fakeWatcher;
        },
        close() {},
        unref() {},
      } as fs.FSWatcher;
      t.mock.method(fs, "watch", () => fakeWatcher);
      syncBuiltinESMExports();
      t.after(() => {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      });
      t.mock.timers.enable({ apis: ["setInterval"] });
      const watcher = createResultWatcher(pi, state, resultsDir);
      const originalError = console.error;
      console.error = () => {};
      try {
        watcher.startResultWatcher();
        assert.equal(state.watcher, fakeWatcher);
        const enospc = new Error("inotify limit reached") as NodeJS.ErrnoException;
        enospc.code = "ENOSPC";
        emitWatcherError?.(enospc);
        assert.equal(state.watcher, null);
        assert.notEqual(state.watcherRestartTimer, null);

        fs.writeFileSync(
          path.join(resultsDir, "done.json"),
          JSON.stringify({ sessionId: "session-1", summary: "done" }),
          "utf-8",
        );
        t.mock.timers.tick(3_000);
        await waitFor(
          () => emitted.some((entry) => entry.event === "subagent:async-complete"),
          "ENOSPC fallback must publish the result",
        );
        await watcher.joinInFlight();
      } finally {
        console.error = originalError;
        watcher.stopResultWatcher();
      }

      assert.equal(emitted.filter((entry) => entry.event === "subagent:async-complete").length, 1);
      assert.equal(fs.existsSync(path.join(resultsDir, "done.json")), false);
    } finally {
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("emits async completion plus one grouped intercom result event when an intercom target is present", async () => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-"));
    try {
      const emitted: Array<{ event: string; data: unknown }> = [];
      const listeners = new Map<string, Set<(payload: unknown) => void>>();
      const pi = {
        events: {
          on(event: string, handler: (payload: unknown) => void) {
            const eventListeners = listeners.get(event) ?? new Set();
            eventListeners.add(handler);
            listeners.set(event, eventListeners);
            return () => eventListeners.delete(handler);
          },
          emit(event: string, data: unknown) {
            emitted.push({ event, data });
            for (const handler of listeners.get(event) ?? []) {
              handler(data);
            }
            if (event === "subagent:result-intercom") {
              const requestId =
                data && typeof data === "object"
                  ? (data as { requestId?: unknown }).requestId
                  : undefined;
              if (typeof requestId === "string") {
                setImmediate(() =>
                  pi.events.emit("subagent:result-intercom-delivery", {
                    requestId,
                    delivered: true,
                  }),
                );
              }
            }
          },
        },
      };
      const state = createState();
      state.currentSessionId = "session-1";
      const watcher = createResultWatcher(pi, state, resultsDir);
      const firstSession = path.join(resultsDir, "a-session.jsonl");
      const missingSession = path.join(resultsDir, "b-session.jsonl");
      try {
        fs.writeFileSync(firstSession, "", "utf-8");
        fs.writeFileSync(
          path.join(resultsDir, "async-1.json"),
          JSON.stringify({
            id: "async-1",
            runId: "run-123",
            agent: "parallel:a+b",
            mode: "parallel",
            success: true,
            state: "complete",
            summary: "Combined summary",
            results: [
              {
                agent: "a",
                output: "Result from a",
                success: true,
                sessionFile: firstSession,
                artifactPaths: { outputPath: "/tmp/a-output.md" },
                intercomTarget: "subagent-a-run-123-1",
              },
              {
                agent: "b",
                output: "Result from b",
                success: false,
                sessionFile: missingSession,
                artifactPaths: { outputPath: "/tmp/b-output.md" },
                intercomTarget: "subagent-b-run-123-2",
              },
            ],
            sessionId: "session-1",
            sessionFile: "/tmp/session.jsonl",
            asyncDir: "/tmp/async-1",
            intercomTarget: "subagent-chat-main",
          }),
          "utf-8",
        );
        watcher.primeExistingResults();
        await waitFor(
          () => emitted.some((entry) => entry.event === "subagent:async-complete"),
          "watcher must publish completion",
        );
        await watcher.joinInFlight();
      } finally {
        watcher.stopResultWatcher();
      }

      const intercomEvents = emitted.filter((entry) => entry.event === "subagent:result-intercom");
      assert.equal(intercomEvents.length, 1);
      const eventData = intercomEvents[0]?.data as {
        message?: string;
        mode?: string;
        status?: string;
      };
      assert.equal(eventData.mode, "parallel");
      assert.equal(eventData.status, "failed");
      const message = String(eventData.message ?? "");
      assert.match(
        message,
        /Continue child: agent_runs\(\{ action: "continue", id: "async-1", index: 0, message: "\.\.\." \}\)/,
      );
      assert.ok(message.includes(`Session: ${firstSession}`));
      assert.equal(message.includes(missingSession), false);
      const completion = emitted.find((entry) => entry.event === "subagent:async-complete")
        ?.data as { intercomResultDelivered?: boolean } | undefined;
      assert.equal(completion?.intercomResultDelivered, true);
    } finally {
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("enriches async completion and intercom payloads with nested registry children before deletion", async () => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-nested-"));
    const route = createNestedRoute("async-nested-root");
    try {
      writeNestedEvent(route, {
        type: "subagent.nested.completed",
        ts: Date.now(),
        parentRunId: "async-nested-root",
        parentStepIndex: 0,
        child: {
          id: "nested-child",
          parentRunId: "async-nested-root",
          parentStepIndex: 0,
          depth: 1,
          path: [{ runId: "async-nested-root", stepIndex: 0 }],
          state: "complete",
          agent: "nested-reviewer",
          sessionFile: path.join(resultsDir, "nested-child.jsonl"),
        },
      });
      const emitted: Array<{ event: string; data: unknown }> = [];
      const listeners = new Map<string, Set<(payload: unknown) => void>>();
      const pi = {
        events: {
          on(event: string, handler: (payload: unknown) => void) {
            const eventListeners = listeners.get(event) ?? new Set();
            eventListeners.add(handler);
            listeners.set(event, eventListeners);
            return () => eventListeners.delete(handler);
          },
          emit(event: string, data: unknown) {
            emitted.push({ event, data });
            for (const handler of listeners.get(event) ?? []) {
              handler(data);
            }
            if (event === "subagent:result-intercom") {
              const requestId =
                data && typeof data === "object"
                  ? (data as { requestId?: unknown }).requestId
                  : undefined;
              if (typeof requestId === "string") {
                setImmediate(() =>
                  pi.events.emit("subagent:result-intercom-delivery", {
                    requestId,
                    delivered: true,
                  }),
                );
              }
            }
          },
        },
      };
      const state = createState();
      state.currentSessionId = "session-1";
      const watcher = createResultWatcher(pi, state, resultsDir);
      const resultPath = path.join(resultsDir, "async-nested-root.json");
      try {
        fs.writeFileSync(
          resultPath,
          JSON.stringify({
            id: "async-nested-root",
            runId: "async-nested-root",
            agent: "owner",
            mode: "single",
            success: true,
            state: "complete",
            summary: "owner done",
            results: [{ agent: "owner", output: "owner done", success: true }],
            sessionId: "session-1",
            intercomTarget: "subagent-chat-main",
          }),
          "utf-8",
        );
        watcher.primeExistingResults();
        await waitFor(
          () => emitted.some((entry) => entry.event === "subagent:async-complete"),
          "watcher must publish completion",
        );
        await watcher.joinInFlight();
      } finally {
        watcher.stopResultWatcher();
      }

      assert.equal(fs.existsSync(resultPath), false);
      const intercomPayload = emitted.find((entry) => entry.event === "subagent:result-intercom")
        ?.data as
        | {
            children?: Array<{
              children?: Array<{ id?: string; controlInbox?: string; capabilityToken?: string }>;
            }>;
            message?: string;
          }
        | undefined;
      assert.equal(intercomPayload?.children?.[0]?.children?.[0]?.id, "nested-child");
      assert.equal(intercomPayload?.children?.[0]?.children?.[0]?.controlInbox, undefined);
      assert.equal(intercomPayload?.children?.[0]?.children?.[0]?.capabilityToken, undefined);
      assert.match(String(intercomPayload?.message ?? ""), /Nested subagents:/);
      const completion = emitted.find((entry) => entry.event === "subagent:async-complete")
        ?.data as
        | {
            nestedChildren?: Array<{ id?: string }>;
            results?: Array<{ children?: Array<{ id?: string }> }>;
          }
        | undefined;
      assert.equal(completion?.nestedChildren?.[0]?.id, "nested-child");
      assert.equal(completion?.results?.[0]?.children?.[0]?.id, "nested-child");
    } finally {
      fs.rmSync(resultsDir, { recursive: true, force: true });
      fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
    }
  });

  it("filters malformed explicit nested children in result files before compacting", async () => {
    const resultsDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-result-watcher-nested-malformed-"),
    );
    try {
      const emitted: Array<{ event: string; data: unknown }> = [];
      const listeners = new Map<string, Set<(payload: unknown) => void>>();
      const pi = {
        events: {
          on(event: string, handler: (payload: unknown) => void) {
            const eventListeners = listeners.get(event) ?? new Set();
            eventListeners.add(handler);
            listeners.set(event, eventListeners);
            return () => eventListeners.delete(handler);
          },
          emit(event: string, data: unknown) {
            emitted.push({ event, data });
            for (const handler of listeners.get(event) ?? []) {
              handler(data);
            }
            if (event === "subagent:result-intercom") {
              const requestId =
                data && typeof data === "object"
                  ? (data as { requestId?: unknown }).requestId
                  : undefined;
              if (typeof requestId === "string") {
                setImmediate(() =>
                  pi.events.emit("subagent:result-intercom-delivery", {
                    requestId,
                    delivered: true,
                  }),
                );
              }
            }
          },
        },
      };
      const state = createState();
      state.currentSessionId = "session-1";
      const watcher = createResultWatcher(pi, state, resultsDir);
      const resultPath = path.join(resultsDir, "async-explicit-nested.json");
      const originalError = console.error;
      const logged: unknown[][] = [];
      console.error = (...args: unknown[]) => {
        logged.push(args);
      };
      try {
        fs.writeFileSync(
          resultPath,
          JSON.stringify({
            id: "async-explicit-nested",
            runId: "async-explicit-nested",
            agent: "owner",
            mode: "single",
            success: true,
            state: "complete",
            summary: "owner done",
            results: [
              {
                agent: "owner",
                output: "owner done",
                success: true,
                children: [
                  {
                    id: "child-explicit-good",
                    parentRunId: "async-explicit-nested",
                    depth: 1,
                    path: [{ runId: "async-explicit-nested" }],
                    state: "complete",
                    agent: "child-good",
                  },
                  { id: "child-explicit-bad", path: "not-an-array" },
                ],
              },
            ],
            nestedChildren: [
              {
                id: "top-explicit-good",
                parentRunId: "async-explicit-nested",
                parentStepIndex: 0,
                depth: 1,
                path: [{ runId: "async-explicit-nested", stepIndex: 0 }],
                state: "complete",
                agent: "top-good",
              },
              { id: "top-explicit-bad", path: "not-an-array" },
            ],
            sessionId: "session-1",
            intercomTarget: "subagent-chat-main",
          }),
          "utf-8",
        );
        watcher.primeExistingResults();
        await waitFor(
          () => emitted.some((entry) => entry.event === "subagent:async-complete"),
          "watcher must publish completion",
        );
        await watcher.joinInFlight();
      } finally {
        console.error = originalError;
        watcher.stopResultWatcher();
      }

      assert.equal(fs.existsSync(resultPath), false);
      assert.ok(
        logged.some(
          (entry) =>
            String(entry[0] ?? "").includes(resultPath) &&
            /invalid nested child record/.test(String(entry[0] ?? "")),
        ),
      );
      const intercomPayload = emitted.find((entry) => entry.event === "subagent:result-intercom")
        ?.data as { children?: Array<{ children?: Array<{ id?: string }> }> } | undefined;
      const intercomNestedIds =
        intercomPayload?.children?.[0]?.children?.map((child) => child.id) ?? [];
      assert.deepEqual(
        intercomNestedIds.sort(),
        ["child-explicit-good", "top-explicit-good"].sort(),
      );
      const completion = emitted.find((entry) => entry.event === "subagent:async-complete")
        ?.data as
        | {
            results?: Array<{ children?: Array<{ id?: string }> }>;
            nestedChildren?: Array<{ id?: string }>;
          }
        | undefined;
      assert.deepEqual(
        completion?.nestedChildren?.map((child) => child.id),
        ["top-explicit-good"],
      );
      assert.deepEqual(
        completion?.results?.[0]?.children?.map((child) => child.id)?.sort(),
        ["child-explicit-good", "top-explicit-good"].sort(),
      );
    } finally {
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("retries and delivers result files after nested registry enrichment recovers", async () => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-nested-retry-"));
    const route = createNestedRoute("async-nested-retry");
    try {
      const registryPath = path.join(path.dirname(route.eventSink), "registry.json");
      fs.writeFileSync(registryPath, "{", "utf-8");
      writeNestedEvent(route, {
        type: "subagent.nested.completed",
        ts: 100,
        parentRunId: "async-nested-retry",
        parentStepIndex: 0,
        child: {
          id: "nested-retry-child",
          parentRunId: "async-nested-retry",
          parentStepIndex: 0,
          depth: 1,
          path: [{ runId: "async-nested-retry", stepIndex: 0 }],
          state: "complete",
          agent: "child",
        },
      });
      const emitted: Array<{ event: string; data: unknown }> = [];
      const listeners = new Map<string, Set<(payload: unknown) => void>>();
      const pi = {
        events: {
          on(event: string, listener: (payload: unknown) => void) {
            const set = listeners.get(event) ?? new Set();
            set.add(listener);
            listeners.set(event, set);
            return () => set.delete(listener);
          },
          emit(event: string, data: unknown) {
            emitted.push({ event, data });
            for (const listener of listeners.get(event) ?? []) {
              listener(data);
            }
          },
        },
      };
      const state = createState();
      state.currentSessionId = "session-1";
      const watcher = createResultWatcher(pi, state, resultsDir);
      const resultPath = path.join(resultsDir, "async-nested-retry.json");
      const originalError = console.error;
      const logged: unknown[][] = [];
      console.error = (...args: unknown[]) => {
        logged.push(args);
      };
      try {
        fs.writeFileSync(
          resultPath,
          JSON.stringify({
            id: "async-nested-retry",
            runId: "async-nested-retry",
            agent: "owner",
            success: true,
            state: "complete",
            summary: "owner done",
            sessionId: "session-1",
            intercomTarget: "subagent-chat-main",
          }),
          "utf-8",
        );
        watcher.primeExistingResults();
        await waitFor(
          () => logged.some((entry) => /will retry later/.test(String(entry[0]))),
          "nested enrichment failure must be processed",
        );
        await watcher.joinInFlight();

        assert.equal(fs.existsSync(resultPath), true);
        assert.equal(emitted.length, 0);
        assert.ok(
          logged.some((entry) => /will retry later/.test(String(entry[0] ?? ""))),
          "expected nested enrichment retry warning to be logged",
        );

        fs.rmSync(registryPath, { force: true });
        watcher.primeExistingResults();
        await waitFor(
          () => emitted.some((entry) => entry.event === "subagent:async-complete"),
          "recovered registry must publish",
        );
        await watcher.joinInFlight();
      } finally {
        console.error = originalError;
        watcher.stopResultWatcher();
      }

      assert.equal(fs.existsSync(resultPath), false);
      const completion = emitted.find((entry) => entry.event === "subagent:async-complete")
        ?.data as { nestedChildren?: Array<{ id?: string }> } | undefined;
      assert.deepEqual(
        completion?.nestedChildren?.map((child) => child.id),
        ["nested-retry-child"],
      );
      const intercomPayload = emitted.find((entry) => entry.event === "subagent:result-intercom")
        ?.data as { children?: Array<{ children?: Array<{ id?: string }> }> } | undefined;
      assert.deepEqual(
        intercomPayload?.children?.[0]?.children?.map((child) => child.id),
        ["nested-retry-child"],
      );
    } finally {
      fs.rmSync(resultsDir, { recursive: true, force: true });
      fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
    }
  });

  it("does not advertise indexed revive from only a top-level async session file", async () => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-"));
    try {
      const emitted: Array<{ event: string; data: unknown }> = [];
      const listeners = new Map<string, Set<(payload: unknown) => void>>();
      const pi = {
        events: {
          emit: (event: string, data: unknown) => {
            emitted.push({ event, data });
            for (const listener of listeners.get(event) ?? []) {
              listener(data);
            }
            return true;
          },
          on: (event: string, listener: (payload: unknown) => void) => {
            const set = listeners.get(event) ?? new Set();
            set.add(listener);
            listeners.set(event, set);
            return () => set.delete(listener);
          },
        },
      };
      const state = createState();
      state.currentSessionId = "session-1";
      const watcher = createResultWatcher(pi, state, resultsDir);
      try {
        fs.writeFileSync(
          path.join(resultsDir, "async-top-session.json"),
          JSON.stringify({
            id: "async-top-session",
            mode: "parallel",
            success: false,
            state: "failed",
            results: [
              { agent: "a", output: "A", success: true },
              { agent: "b", output: "B", success: false },
            ],
            sessionId: "session-1",
            sessionFile: "/tmp/top-session.jsonl",
            intercomTarget: "subagent-chat-main",
          }),
          "utf-8",
        );
        watcher.primeExistingResults();
        await waitFor(
          () => emitted.some((entry) => entry.event === "subagent:async-complete"),
          "watcher must publish completion",
        );
        await watcher.joinInFlight();
      } finally {
        watcher.stopResultWatcher();
      }

      const eventData = emitted.find((entry) => entry.event === "subagent:result-intercom")
        ?.data as { message?: string } | undefined;
      assert.ok(eventData);
      assert.doesNotMatch(String(eventData.message ?? ""), /Revive child:/);
      assert.match(
        String(eventData.message ?? ""),
        /Resume: unavailable; no child session file was persisted/,
      );
    } finally {
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("preserves child outcomes when a grouped async result is paused", async () => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-"));
    try {
      const emitted: Array<{ event: string; data: unknown }> = [];
      const listeners = new Map<string, Set<(payload: unknown) => void>>();
      const pi = {
        events: {
          on(event: string, handler: (payload: unknown) => void) {
            const eventListeners = listeners.get(event) ?? new Set();
            eventListeners.add(handler);
            listeners.set(event, eventListeners);
            return () => eventListeners.delete(handler);
          },
          emit(event: string, data: unknown) {
            emitted.push({ event, data });
            for (const handler of listeners.get(event) ?? []) {
              handler(data);
            }
            if (event === "subagent:result-intercom") {
              const requestId =
                data && typeof data === "object"
                  ? (data as { requestId?: unknown }).requestId
                  : undefined;
              if (typeof requestId === "string") {
                setImmediate(() =>
                  pi.events.emit("subagent:result-intercom-delivery", {
                    requestId,
                    delivered: true,
                  }),
                );
              }
            }
          },
        },
      };
      const state = createState();
      state.currentSessionId = "session-1";
      const watcher = createResultWatcher(pi, state, resultsDir);
      try {
        fs.writeFileSync(
          path.join(resultsDir, "async-paused.json"),
          JSON.stringify({
            id: "async-paused",
            runId: "run-paused",
            agent: "chain:a->b",
            mode: "chain",
            success: false,
            state: "paused",
            summary: "Paused after interrupt. Waiting for explicit next action.",
            results: [
              {
                agent: "a",
                output: "Result from a",
                success: true,
                intercomTarget: "subagent-a-run-paused-1",
              },
              {
                agent: "b",
                output: "Paused after interrupt",
                success: false,
                interrupted: true,
                intercomTarget: "subagent-b-run-paused-2",
              },
              {
                agent: "c",
                output: "Failed before interrupt",
                success: false,
                error: "C failed",
                intercomTarget: "subagent-c-run-paused-3",
              },
            ],
            sessionId: "session-1",
            intercomTarget: "subagent-chat-main",
          }),
          "utf-8",
        );
        watcher.primeExistingResults();
        await waitFor(
          () => emitted.some((entry) => entry.event === "subagent:async-complete"),
          "watcher must publish completion",
        );
        await watcher.joinInFlight();
      } finally {
        watcher.stopResultWatcher();
      }

      const intercomEvents = emitted.filter((entry) => entry.event === "subagent:result-intercom");
      assert.equal(intercomEvents.length, 1);
      const payload = intercomEvents[0]?.data as {
        mode?: string;
        status?: string;
        message?: string;
        children?: Array<{ status?: string; summary?: string }>;
      };
      const completion = emitted.find((entry) => entry.event === "subagent:async-complete")
        ?.data as
        | { state?: string; results?: Array<{ status?: string; summary?: string }> }
        | undefined;
      assert.equal(payload.mode, "chain");
      assert.equal(payload.status, "failed");
      assert.equal(completion?.state, "paused");
      assert.deepEqual(
        payload.children?.map((child) => child.status),
        ["completed", "paused", "failed"],
      );
      assert.deepEqual(
        completion?.results?.map((child) => child.status),
        ["completed", "paused", "failed"],
      );
      assert.equal(payload.children?.[2]?.summary, "C failed\n\nOutput:\nFailed before interrupt");
      assert.match(String(payload.message ?? ""), /Status: failed/);
      assert.match(String(payload.message ?? ""), /Children: 1 completed, 1 failed, 1 paused/);
      assert.match(String(payload.message ?? ""), /1\. a — completed/);
      assert.match(String(payload.message ?? ""), /2\. b — paused/);
      assert.match(String(payload.message ?? ""), /3\. c — failed/);
    } finally {
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("claims a result before awaiting intercom delivery", async (t) => {
    const processed = observeReads(t);
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-race-"));
    try {
      const emitted: Array<{ event: string; data: unknown }> = [];
      const listeners = new Map<string, Set<(payload: unknown) => void>>();
      const pi = {
        events: {
          on(event: string, handler: (payload: unknown) => void) {
            const handlers = listeners.get(event) ?? new Set();
            handlers.add(handler);
            listeners.set(event, handlers);
            return () => handlers.delete(handler);
          },
          emit(event: string, data: unknown) {
            emitted.push({ event, data });
            for (const handler of listeners.get(event) ?? []) {
              handler(data);
            }
          },
        },
      };
      const resultPath = path.join(resultsDir, "async-race.json");
      fs.writeFileSync(
        resultPath,
        JSON.stringify({
          id: "async-race",
          sessionId: "parent",
          cwd: "/repo",
          success: true,
          summary: "done",
          intercomTarget: "parent",
        }),
        "utf-8",
      );
      const state = createState();
      state.currentSessionId = "parent";
      const watcher = createResultWatcher(pi, state, resultsDir);
      const originalError = console.error;
      console.error = () => {};
      try {
        watcher.primeExistingResults();
        await waitFor(
          () => emitted.some((entry) => entry.event === "subagent:result-intercom"),
          "first delivery must be in flight",
        );
        watcher.primeExistingResults();
        await processed(watcher, resultPath, 2);
        await waitFor(
          () => emitted.some((entry) => entry.event === "subagent:async-complete"),
          "claimed delivery must settle",
        );
      } finally {
        console.error = originalError;
        watcher.stopResultWatcher();
      }
      assert.equal(emitted.filter((entry) => entry.event === "subagent:result-intercom").length, 1);
      assert.equal(emitted.filter((entry) => entry.event === "subagent:async-complete").length, 1);
      assert.equal(fs.existsSync(resultPath), false);
    } finally {
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("keeps an unacknowledged grouped async delivery quiet and emits one fallback completion", async () => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-"));
    try {
      const emitted: Array<{ event: string; data: unknown }> = [];
      const pi = {
        events: {
          on(_event: string, _handler: (payload: unknown) => void) {
            return () => {};
          },
          emit(event: string, data: unknown) {
            emitted.push({ event, data });
          },
        },
      };
      const state = createState();
      state.currentSessionId = "session-1";
      const watcher = createResultWatcher(pi, state, resultsDir);
      const originalError = console.error;
      const logged: unknown[][] = [];
      console.error = (...args: unknown[]) => {
        logged.push(args);
      };
      try {
        fs.writeFileSync(
          path.join(resultsDir, "async-2.json"),
          JSON.stringify({
            id: "async-2",
            runId: "run-456",
            agent: "worker",
            success: true,
            state: "complete",
            summary: "Worker summary",
            sessionId: "session-1",
            intercomTarget: "orchestrator",
          }),
          "utf-8",
        );
        watcher.primeExistingResults();
        const deadline = Date.now() + 1000;
        while (true) {
          const sawCompletion = emitted.some((entry) => entry.event === "subagent:async-complete");
          if (sawCompletion || Date.now() > deadline) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      } finally {
        console.error = originalError;
        watcher.stopResultWatcher();
      }

      assert.equal(emitted.filter((entry) => entry.event === "subagent:result-intercom").length, 1);
      const completion = emitted.find((entry) => entry.event === "subagent:async-complete")
        ?.data as { intercomResultDelivered?: boolean } | undefined;
      assert.equal(completion?.intercomResultDelivered, false);
      assert.equal(emitted.filter((entry) => entry.event === "subagent:async-complete").length, 1);
      assert.equal(fs.existsSync(path.join(resultsDir, "async-2.json")), false);
      assert.deepEqual(logged, [], "ordinary fallback must not write over the editor");
    } finally {
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });
});
