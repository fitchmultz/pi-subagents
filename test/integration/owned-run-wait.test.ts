import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { test, type TestContext } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ReadonlyDeep } from "type-fest";
import type { SubagentParamsLike } from "../../src/runs/foreground/subagent-params.ts";
import type { SequentialStep } from "../../src/shared/settings.ts";
import { createNativeSessionFixture } from "../support/native-session.ts";
import { createSubagentState, readResult } from "../support/background-fixtures.ts";
import {
  assertArray,
  assertDefined,
  record,
  records,
  readJson,
  text,
  textAt,
} from "../support/assertions.ts";
import { nativeSdkRoot, nativeCli } from "../support/native-sdk.ts";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  createMockPi,
  createTempDir,
  events,
  makeAgent,
  makeMinimalCtx,
} from "../support/helpers.ts";
import { waitForOwnedRun } from "../../src/runs/foreground/wait-run.ts";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { createAsyncJobTracker } from "../../src/runs/background/async-job-tracker.ts";
import {
  OWNED_RUN_ENTRY,
  ownedRunView,
  saveForegroundRun,
} from "../../src/runs/shared/run-records.ts";
import { interruptAsyncRun } from "../../src/runs/foreground/foreground-control.ts";
import { createNestedRoute } from "../../src/runs/shared/nested-events.ts";
import {
  createSupervisorQuestion,
  getRunMetadataDir,
  readQuestionState,
  readQuestionContract,
  questionProcessAlive,
  recordQuestionDelivery,
  saveAsyncRunResult,
  saveRunStatus,
  saveQuestionContract,
  saveQuestionOwner,
} from "../../src/runs/shared/supervisor-questions.ts";
import {
  ASYNC_DIR,
  INTERCOM_DETACH_REQUEST_EVENT,
  POLL_INTERVAL_MS,
  type TrackedOwnedRun,
  type AsyncStatus,
  type SubagentExecutionResult,
} from "../../src/shared/types.ts";

async function until(check: () => boolean, reason: string) {
  const end = Date.now() + 10_000;
  while (!check()) {
    assert.ok(Date.now() < end, reason);
    // Readiness must be observed after each polling interval.
    // oxlint-disable-next-line no-await-in-loop
    await delay(20);
  }
}
async function setup(t: TestContext, allowLaunch = false) {
  const cwd = createTempDir("wait-owned-"),
    runId = randomUUID(),
    sessionFile = path.join(cwd, "session.jsonl");
  fs.writeFileSync(
    sessionFile,
    JSON.stringify({
      type: "session",
      version: 3,
      id: randomUUID(),
      cwd,
      timestamp: new Date().toISOString(),
    }) + "\n",
  );
  const agent = makeAgent("worker", { model: "fixture/original", completionGuard: false });
  const run: TrackedOwnedRun = {
    runId,
    rootRunId: runId,
    ownerSessionId: "session-123",
    source: "foreground",
    mode: "single",
    cwd,
    task: "Original task",
    startedAt: 1,
    children: [{ agent: "worker", index: 0, sessionFile }],
  };
  const state = createSubagentState(cwd);
  state.currentSessionId = "session-123";
  state.ownedRuns = new Map([[runId, run]]);
  const native = await createNativeSessionFixture({
    cwd,
    agentDir: path.join(cwd, "native-agent"),
    sessionManager: SessionManager.inMemory(cwd, { id: "session-123" }),
  });
  native.pi.setSessionName("wait-parent");
  saveForegroundRun({
    ...run,
    results: [
      {
        agent: "worker",
        task: run.task,
        exitCode: 0,
        sessionFile,
        finalOutput: "Previous result",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
      },
    ],
  });
  saveQuestionOwner(runId, run.ownerSessionId);
  saveQuestionContract(runId, 0, {
    sessionFile,
    launch: {
      agent,
      systemPrompt: "Saved exact launch",
      skills: [],
      model: "fixture/original",
      modelCandidates: ["fixture/original"],
      cwd,
      context: "fresh",
      artifacts: false,
      output: false,
      outputMode: "inline",
      share: false,
    },
  });
  const pi = native.pi;
  const bus = pi.events;
  const tracker = createAsyncJobTracker(pi, state, ASYNC_DIR);
  bus.on("subagent:async-started", tracker.handleStarted);
  const deps = {
    pi,
    state,
    config: {},
    asyncByDefault: true,
    tempArtifactsDir: cwd,
    getSubagentSessionRoot: () => cwd,
    expandTilde: (value: string) => value,
    discoverAgents: () => {
      if (allowLaunch) {
        return { agents: [agent] };
      }
      throw new Error("Saved continuation must not rediscover current profiles");
    },
  };
  const executor = createSubagentExecutor(deps);
  const mock = createMockPi();
  mock.install();
  t.after(async () => {
    if (state.poller) {
      clearInterval(state.poller);
    }
    for (const timer of state.cleanupTimers.values()) {
      clearTimeout(timer);
    }
    mock.uninstall();
    await native.dispose();
  });
  return {
    cwd,
    runId,
    state,
    events: bus,
    mock,
    deps,
    invoke: (
      params: ReadonlyDeep<SubagentParamsLike>,
      signal?: AbortSignal,
      update?: (result: ReadonlyDeep<SubagentExecutionResult>) => void,
    ) =>
      executor.execute({
        toolCallId: randomUUID(),
        params,
        signal,
        onUpdate: update,
        ctx: makeMinimalCtx(cwd),
      }),
    native,
  };
}

for (const outcome of ["completed", "cancelled", "yielded", "unavailable", "background"]) {
  test(`owned-run liveness without a host reference: ${outcome}`, () => {
    const cwd = createTempDir("wait-liveness-");
    const child = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../fixtures/owned-run-wait-liveness.mjs", import.meta.url)),
        cwd,
        outcome,
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    const errorDetail = [child.stderr, child.error?.message].find(
      (value) => value !== undefined && value.length > 0,
    );
    assert.equal(child.status, 0, errorDetail ?? `Process exited before ${outcome} settled`);
    if (outcome !== "background") {
      assert.equal(child.stdout.trim(), outcome);
    }
  });
}

test("removed wait action is rejected without starting or attaching to work", async (t) => {
  const f = await setup(t);
  const result = await f.invoke({ action: "wait", id: f.runId });
  assert.equal(result.isError, true);
  assert.match(textAt(result.content), /Unknown action: wait/);
  assert.equal(result.details.wait, undefined);
  assert.equal(f.mock.callCount(), 0);
});

test("native session disposal settles an already registered wait without stopping its producer", async (t) => {
  const f = await setup(t);
  const original = f.state.ownedRuns.get(f.runId);
  assertDefined(original);
  const asyncDir = getRunMetadataDir(f.runId);
  fs.rmSync(path.join(asyncDir, "foreground.json"), { force: true });
  f.state.ownedRuns.set(f.runId, { ...original, source: "async", asyncDir, pid: process.pid });
  saveRunStatus(f.runId, {
    runtimeVersion: 2,
    runId: f.runId,
    mode: "single",
    state: "running",
    pid: process.pid,
    startedAt: 1,
    steps: [{ agent: "worker", status: "running" }],
  });
  t.mock.timers.enable({ apis: ["setInterval"] });
  const polling = t.mock.method(globalThis, "setInterval");
  const controller = new AbortController();
  const pending = waitForOwnedRun({
    id: f.runId,
    deps: f.deps,
    ctx: f.native.context,
    signal: controller.signal,
  });
  assert.equal(polling.mock.callCount(), 1, "the actual wait owner registered its native timer");
  assert.equal(polling.mock.calls[0].arguments[1], POLL_INTERVAL_MS);
  assert.equal(f.state.waitingRuns?.has(f.runId), true);
  f.native.session.dispose();
  try {
    assert.throws(() => f.native.context.sessionManager.getSessionId(), /stale|disposed/i);
    assert.doesNotThrow(() => t.mock.timers.tick(POLL_INTERVAL_MS));
    const result = await pending;
    assert.equal(result.isError, true);
    assert.equal(result.details.wait?.status, "unavailable");
    assert.match(textAt(result.content), /stale|disposed/i);
    assert.equal(f.state.waitingRuns.has(f.runId), false);
    assert.equal(questionProcessAlive({ pid: process.pid }), true);
    assert.equal(fs.existsSync(path.join(asyncDir, "control-request.json")), false);
    assert.equal(f.mock.callCount(), 0, "losing the session cannot start a child");
  } finally {
    controller.abort();
    await pending;
    t.mock.timers.reset();
  }
});

test("wait registration failure releases ownership and returns the native listener error", async (t) => {
  const f = await setup(t);
  const failure = new Error("native listener registration failed");
  t.mock.method(f.events, "on", () => {
    throw failure;
  });
  const result = await waitForOwnedRun({
    id: f.runId,
    deps: f.deps,
    ctx: makeMinimalCtx(f.cwd),
  });
  assert.equal(result.isError, true);
  assert.equal(result.details.wait?.status, "unavailable");
  assert.match(textAt(result.content), /native listener registration failed/);
  assert.equal(f.state.waitingRuns?.has(f.runId), false);
  assert.equal(f.mock.callCount(), 0);
});

for (const fault of ["listener", "abort"] as const) {
  test(
    `native wait ${fault} teardown failure settles instead of stranding completion`,
    { timeout: 2_000 },
    async (t) => {
      const f = await setup(t);
      saveAsyncRunResult(f.runId, {
        runId: f.runId,
        state: "complete",
        success: true,
        results: [{ agent: "worker", exitCode: 0, output: "Previous result" }],
      });
      const on = f.events.on.bind(f.events);
      let released = false;
      let abortDetached = false;
      const controller = new AbortController();
      const nativeRemove = controller.signal.removeEventListener.bind(controller.signal);
      const remove: typeof controller.signal.removeEventListener = (...args) => {
        nativeRemove(...args);
        abortDetached = true;
        if (fault === "abort") {
          throw new Error("native abort teardown failed");
        }
      };
      t.mock.method(controller.signal, "removeEventListener", remove);
      t.mock.method(f.events, "on", (name: string, listener: (data: unknown) => void) => {
        const unsubscribe = on(name, listener);
        return () => {
          unsubscribe();
          released = true;
          if (fault === "listener") {
            throw new Error("native listener teardown failed");
          }
        };
      });
      const result = await waitForOwnedRun({
        id: f.runId,
        deps: f.deps,
        ctx: makeMinimalCtx(f.cwd),
        executionResult: true,
        signal: controller.signal,
      });
      assert.equal(released, true);
      assert.equal(
        abortDetached,
        true,
        "one cleanup failure must not prevent releasing other native registrations",
      );
      assert.equal(result.isError, true);
      assert.equal(result.details.wait?.status, "unavailable");
      assert.match(textAt(result.content), new RegExp(`native ${fault} teardown failed`));
      assert.equal(f.state.waitingRuns?.has(f.runId), false);
    },
  );
}

test("an ambiguous native owner acknowledgement keeps the revival claim after real process handoff", async (t) => {
  const f = await setup(t);
  const contract = readQuestionContract(f.runId, 0);
  assertDefined(contract);
  const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  assert.equal(exited.status, 0);
  assert.equal(questionProcessAlive({ pid: exited.pid }), false);
  const question = createSupervisorQuestion({
    runId: f.runId,
    index: 0,
    agent: "worker",
    ownerTarget: "fixture-parent",
    childTarget: "fixture-child",
    childSessionId: "fixture-session",
    sessionFile: text(contract.sessionFile),
    cwd: f.cwd,
    pid: exited.pid,
    reason: "need_decision",
    message: "May I continue the saved work?",
  });
  const release = path.join(f.cwd, "release-ambiguous-revival");
  f.mock.onCall({ output: "Actual claimed successor finished", waitForFile: release });
  const manager = f.native.session.sessionManager;
  const append = manager.appendCustomEntry.bind(manager);
  f.state.persistOwnedRun = (run) => {
    manager.appendCustomEntry(OWNED_RUN_ENTRY, run);
  };
  let handedOffId: string | undefined;
  t.mock.method(manager, "appendCustomEntry", (kind: string, data: unknown) => {
    const entry = append(kind, data);
    if (kind === OWNED_RUN_ENTRY) {
      const runId = text(record(data).runId);
      if (runId !== f.runId && fs.existsSync(path.join(getRunMetadataDir(runId), "launch.json"))) {
        handedOffId = runId;
        throw new Error("owner acknowledgement failed after native append");
      }
    }
    return entry;
  });
  try {
    const first = await f.invoke({
      action: "answer",
      id: f.runId,
      questionId: question.questionId,
      message: "Continue once",
    });
    assert.equal(first.isError, true);
    assert.match(textAt(first.content), /owner acknowledgement failed after native append/);
    assertDefined(handedOffId);
    await until(() => f.mock.callCount() === 1, "the claimed successor must actually start");
    assert.equal(readQuestionState(question).revival?.runId, handedOffId);
    assert.ok(
      manager
        .getEntries()
        .some(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === OWNED_RUN_ENTRY &&
            record(entry.data).runId === handedOffId,
        ),
      "the actual native owner accepted the successor before acknowledgement failed",
    );
    const retry = await f.invoke({
      action: "answer",
      id: f.runId,
      questionId: question.questionId,
      message: "Continue once",
    });
    assert.match(textAt(retry.content), /already requested|already have launched|already answered/);
    assert.equal(readQuestionState(question).revival?.runId, handedOffId);
    assert.equal(f.mock.callCount(), 1, "retry must not launch a second child");
  } finally {
    t.mock.restoreAll();
    fs.writeFileSync(release, "");
    if (handedOffId !== undefined) {
      const resultPath = path.join(getRunMetadataDir(handedOffId), "result.json");
      await until(() => fs.existsSync(resultPath), "the real claimed successor must finish");
      assert.equal(readResult(resultPath).results[0]?.output, "Actual claimed successor finished");
      const pid = f.state.ownedRuns.get(handedOffId)?.pid;
      assertDefined(pid);
      await until(() => !questionProcessAlive({ pid }), "the claimed successor launcher must exit");
    }
  }
});

test(
  "a terminal filesystem projection failure settles the wait after native listener cleanup",
  { timeout: 2_000 },
  async (t) => {
    const f = await setup(t);
    const resultPath = path.join(getRunMetadataDir(f.runId), "result.json");
    saveAsyncRunResult(f.runId, {
      runId: f.runId,
      state: "complete",
      success: true,
      completionId: "terminal-projection",
      results: [{ agent: "worker", exitCode: 0, output: "Previous result" }],
    });
    const on = f.events.on.bind(f.events);
    const open = fs.openSync;
    const failure = new Error("terminal result filesystem unavailable");
    let listenerReleased = false;
    let failedReads = 0;
    t.mock.method(f.events, "on", (name: string, listener: (data: unknown) => void) => {
      const unsubscribe = on(name, listener);
      return () => {
        unsubscribe();
        listenerReleased = true;
      };
    });
    t.mock.method(fs, "openSync", (...args: Readonly<Parameters<typeof fs.openSync>>) => {
      if (listenerReleased && args[0] === resultPath) {
        failedReads++;
        throw failure;
      }
      return open(...args);
    });
    syncBuiltinESMExports();
    try {
      const result = await waitForOwnedRun({
        id: f.runId,
        deps: f.deps,
        ctx: makeMinimalCtx(f.cwd),
        executionResult: true,
      });
      assert.equal(listenerReleased, true, "the native wait listener was actually released");
      assert.ok(failedReads > 0, "the real terminal result read reached the filesystem fault");
      assert.equal(result.isError, true);
      assert.equal(result.details.wait?.status, "unavailable");
      assert.match(textAt(result.content), /terminal result filesystem unavailable/);
      assert.equal(f.state.waitingRuns?.has(f.runId), false);
      assert.equal(f.mock.callCount(), 0);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  },
);

test("continue async:false waits for the new saved-launch result, not the original completed handle", async (t) => {
  const f = await setup(t);
  f.mock.onCall({ output: "ACTUAL-CONTINUATION-RESULT", delay: 250 });
  let returned = false;
  const pending = f
    .invoke({ action: "resume", id: f.runId, message: "Continue with saved choices", async: false })
    .then((result) => {
      returned = true;
      return result;
    });
  await delay(40);
  assert.equal(returned, false);
  const result = await pending;
  assert.equal(result.details.wait?.status, "completed", textAt(result.content));
  assert.notEqual(result.details.wait.runId, f.runId);
  assert.match(textAt(result.content), /ACTUAL-CONTINUATION-RESULT/);
  assert.equal(result.details.run?.children[0]?.launch?.systemPrompt, "Saved exact launch");
  assert.equal(f.mock.callCount(), 1);
});

test("important steering releases a foreground continuation without stopping it or requiring reattachment", async (t) => {
  const f = await setup(t);
  f.mock.onCall({ output: "CHILD-CONTINUED", delay: 600 });
  const pending = f.invoke({ action: "resume", id: f.runId, message: "Continue", async: false });
  await until(() => f.mock.callCount() > 0, "continuation must start");
  const run = [...f.state.ownedRuns.values()].find((candidate) => candidate.runId !== f.runId);
  assertDefined(run);
  f.events.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: randomUUID(), reason: "attention" });
  const detached = await pending;
  assert.equal(detached.details.wait?.status, "yielded");
  assert.match(textAt(detached.content), /end the turn; completion will arrive automatically/);
  assert.doesNotMatch(textAt(detached.content), /use wait|reattach/);
  assertDefined(run.asyncDir);
  assert.equal(
    fs.existsSync(path.join(run.asyncDir, "control-request.json")),
    false,
    "steering cannot stop the child",
  );
  await until(
    () => fs.existsSync(path.join(getRunMetadataDir(run.runId), "result.json")),
    "continuation publishes its result after yielding",
  );
  const done = await f.invoke({ action: "status", id: run.runId });
  assert.match(textAt(done.content), /CHILD-CONTINUED/);
  assert.equal(f.mock.callCount(), 1);
});

test("cancelling only a newly launched async:false continuation requests runner cancellation", async (t) => {
  const f = await setup(t),
    controller = new AbortController();
  f.mock.onCall({ output: "Too late", delay: 10_000 });
  const updates: string[] = [];
  const pending = f.invoke(
    { action: "resume", id: f.runId, message: "New work", async: false },
    controller.signal,
    (result) => {
      updates.push(textAt(result.content));
    },
  );
  await until(() => f.mock.callCount() > 0, "new child must start");
  const successor = [...f.state.ownedRuns.values()].find(
    (candidate) => candidate.runId !== f.runId,
  );
  assertDefined(successor);
  controller.abort();
  const receipt = await pending;
  assert.equal(receipt.details.wait?.status, "cancelled");
  assert.match(textAt(receipt.content), /newly launched/);
  assert.ok(
    updates.some((content) =>
      /Cancelling requests cancellation of this newly launched run/.test(content),
    ),
  );
  assert.ok(updates.every((content) => !/leaves existing work alive/.test(content)));
  const finalFile = path.join(getRunMetadataDir(successor.runId), "result.json");
  await until(() => fs.existsSync(finalFile), "cancelled continuation must settle");
  const final = readResult(finalFile);
  assert.equal(final.success, false);
  assert.match(text(final.results[0].error), /cancelled/i);
  assert.equal(f.state.ownedRuns.size, 2, "launch lineage survives cancellation");
});

for (const background of [false, true]) {
  test(`${background ? "background" : "foreground"} status reads a finished child before its sibling; selected stop still runs queued siblings`, async (t) => {
    const f = await setup(t, true);
    f.mock.onCall({ matchArgsIncludes: "FIRST_CHILD", output: "FIRST_SAVED_RESULT" });
    f.mock.onCall({
      matchArgsIncludes: "HELD_CHILD",
      steps: [
        { jsonl: [events.toolStart("bash", { command: "held child work" })] },
        { delay: 10_000, jsonl: [events.assistantMessage("Should be stopped")] },
      ],
    });
    f.mock.onCall({ matchArgsIncludes: "QUEUED_CHILD", output: "QUEUED_SIBLING_COMPLETED" });
    const pending = f.invoke(
      {
        tasks: ["FIRST_CHILD", "HELD_CHILD", "QUEUED_CHILD"].map((task) => ({
          agent: "worker",
          task,
          output: false,
        })),
        concurrency: 1,
        async: background,
        artifacts: false,
      },
      undefined,
      () => {
        // This case observes progress through status reads instead of callback output.
      },
    );
    await until(() => f.state.ownedRuns.size === 2, "new owned workflow");
    const run = [...f.state.ownedRuns.values()].find((candidate) => candidate.runId !== f.runId);
    assertDefined(run);
    try {
      await until(
        () => ownedRunView(run, f.state).children[1]?.activity?.currentTool === "bash",
        "second child must be running",
      );
      const first = await f.invoke({ action: "status", id: run.runId });
      assert.match(textAt(first.content), /FIRST_SAVED_RESULT/);
      assert.equal(
        first.details.run?.state,
        "live",
        "inspection does not await unrelated siblings",
      );
      assert.equal(f.mock.callCount(), 2, "third child is still queued");
      const stopped = await f.invoke({ action: "interrupt", id: run.runId, index: 1 });
      assert.equal(stopped.isError, undefined, textAt(stopped.content));
      assert.match(textAt(stopped.content), /child 1 only/);
      await pending;
      if (background) {
        await until(
          () => fs.existsSync(path.join(getRunMetadataDir(run.runId), "result.json")),
          "workflow publishes its result",
        );
      }
      const completed = await f.invoke({ action: "status", id: run.runId });
      assert.deepEqual(
        completed.details.run?.children.map((child) => child.state),
        ["completed", "paused", "completed"],
      );
      assert.match(textAt(completed.content), /QUEUED_SIBLING_COMPLETED/);
      assert.equal(f.mock.callCount(), 3);
    } finally {
      await f.invoke({ action: "interrupt", id: run.runId });
      await pending;
    }
  });
}

for (const mode of ["single", "chain"] as const) {
  test(`a nested foreground ${mode} human blocker remains blocked after acknowledged Intercom delivery`, async (t) => {
    const f = await setup(t, true),
      route = createNestedRoute(randomUUID());
    const nestedEnv = {
      PI_SUBAGENT_PARENT_ROOT_RUN_ID: route.rootRunId,
      PI_SUBAGENT_PARENT_RUN_ID: route.rootRunId,
      PI_SUBAGENT_PARENT_CHILD_INDEX: "0",
      PI_SUBAGENT_PARENT_DEPTH: "1",
      PI_SUBAGENT_PARENT_EVENT_SINK: route.eventSink,
      PI_SUBAGENT_PARENT_CONTROL_INBOX: route.controlInbox,
      PI_SUBAGENT_PARENT_CAPABILITY_TOKEN: route.capabilityToken,
    };
    const sdkRoot = nativeSdkRoot(process.env.PI_INTERCOM_TEST_SDK);
    const bin = path.join(f.cwd, "native-bin"),
      input = path.join(f.cwd, "native-blocked.json"),
      receipt = path.join(f.cwd, "native-receipt.json");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, "pi"),
      `#!/bin/sh\nexec '${process.execPath}' '${nativeCli(sdkRoot)}' "$@"\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      input,
      JSON.stringify({
        scenario: "blocked",
        receiptPath: receipt,
        report: {
          criteriaSatisfied: [{ id: "deliver", status: "satisfied", evidence: "fixture" }],
        },
      }),
    );
    const runtimeEnv = {
      ...nestedEnv,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      PI_DRIVER_FIXTURE: input,
      PI_INTERCOM_TEST_SDK: sdkRoot,
    };
    const saved = Object.fromEntries(Object.keys(runtimeEnv).map((key) => [key, process.env[key]]));
    Object.assign(process.env, runtimeEnv);
    f.deps.discoverAgents = () => ({
      agents: [
        makeAgent("worker", {
          model: "driver-fixture/faux-1",
          completionGuard: false,
          extensions: [
            fileURLToPath(new URL("../fixtures/native-child-attempt.mjs", import.meta.url)),
          ],
        }),
      ],
    });
    try {
      f.events.on("subagent:result-intercom", (payload) =>
        f.events.emit("subagent:result-intercom-delivery", {
          requestId: text(record(payload).requestId),
          delivered: true,
        }),
      );
      const task = {
        agent: "worker",
        task: "Verify authenticated flow",
        output: false,
        acceptance: { criteria: [{ id: "deliver", must: "Verify sign-in" }] },
      } satisfies SequentialStep;
      const result = await f.invoke({
        ...(mode === "single"
          ? task
          : {
              chain: [
                task,
                { agent: "worker", task: "Dependent step must not run", output: false },
              ],
            }),
        async: false,
        artifacts: false,
      });
      assert.equal(result.isError, undefined);
      const terminal = fs
        .readdirSync(route.eventSink)
        .map((file) => record(readJson(path.join(route.eventSink, file))))
        .filter(
          (event) =>
            event.type === "subagent.nested.completed" &&
            record(event.child).id === result.details.runId,
        );
      assert.equal(terminal.length, 1);
      const terminalChild = record(terminal[0].child);
      const blockedStep = records(terminalChild.steps)[0];
      assert.equal(terminalChild.state, "blocked");
      assert.equal(blockedStep.status, "blocked");
      assert.match(text(blockedStep.error), /Complete Touch ID/);
      assert.match(text(terminalChild.error), /Complete Touch ID/);
      const native = record(readJson(receipt));
      assert.equal(native.calls, 1, "human-only blocker must not enter finalization");
      assert.equal(native.networkRequests, 0);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
}

for (const tracked of [false, true]) {
  test(`${tracked ? "tracked" : "restored"} owner Stop cancels an exited child's durable question without stopping its live sibling`, async (t) => {
    const f = await setup(t),
      id = randomUUID(),
      exited = spawnSync(process.execPath, ["-e", ""]);
    assert.equal(exited.status, 0);
    saveQuestionOwner(id, "session-123");
    const question = createSupervisorQuestion({
      runId: id,
      ownerTarget: "parent",
      agent: "worker",
      index: 0,
      childSessionId: "exited",
      childTarget: "child-a",
      sessionFile: path.join(f.cwd, "exited.jsonl"),
      cwd: f.cwd,
      pid: exited.pid,
      reason: "need_decision",
      message: "Should A proceed?",
    });
    const asyncDir = getRunMetadataDir(id);
    const status: AsyncStatus = {
      runtimeVersion: 2,
      runId: id,
      mode: "parallel",
      state: "running",
      pid: process.pid,
      startedAt: 1,
      indexedControl: false,
      controlRequestFiles: true,
      steps: [
        { agent: "worker", status: "failed" },
        { agent: "worker", status: "running" },
      ],
    };
    saveRunStatus(id, status);
    const original = f.state.ownedRuns.get(f.runId);
    assertDefined(original);
    assertDefined(status.steps);
    f.state.ownedRuns.set(id, {
      ...original,
      runId: id,
      rootRunId: id,
      source: "async",
      mode: "parallel",
      asyncDir,
      children: status.steps.map((step, index) => ({ agent: step.agent, index })),
    });
    if (tracked) {
      f.state.asyncJobs.set(id, { asyncId: id, asyncDir, status: "running" });
    }
    assert.equal(
      (await f.invoke({ action: "interrupt", id, index: 0 })).isError,
      true,
      "an unrelated unsupported-control error is retained",
    );
    assert.equal(readQuestionState(question).state, "awaiting_input");
    saveRunStatus(id, { ...status, indexedControl: true });
    const result = await f.invoke({ action: "interrupt", id, index: 0 });
    assert.equal(result.isError, undefined, textAt(result.content));
    assert.equal(readQuestionState(question).state, "cancelled");
    assert.equal(
      fs.existsSync(path.join(asyncDir, "control-requests")),
      false,
      "no sibling control request was sent",
    );
  });
}

test("answer async:false derives the answered question's child index rather than waiting on a sibling", async (t) => {
  const f = await setup(t),
    id = randomUUID();
  const original = f.state.ownedRuns.get(f.runId);
  assertDefined(original);
  const run: TrackedOwnedRun = {
    ...original,
    runId: id,
    rootRunId: id,
    mode: "parallel",
    source: "async",
    asyncDir: getRunMetadataDir(id),
    children: [
      { agent: "worker", index: 0 },
      { agent: "worker", index: 1 },
    ],
  };
  f.state.ownedRuns.set(id, run);
  saveRunStatus(id, {
    runtimeVersion: 2,
    runId: id,
    mode: "parallel",
    state: "running",
    pid: process.pid,
    startedAt: Date.now(),
    steps: run.children.map((child) => ({ agent: child.agent, status: "running" })),
  });
  saveQuestionOwner(id, "session-123");
  const questions = run.children.map((child) =>
    createSupervisorQuestion({
      runId: id,
      ownerTarget: "parent",
      agent: child.agent,
      index: child.index,
      childSessionId: `child-${child.index}`,
      childTarget: `child-${child.index}`,
      sessionFile: path.join(f.cwd, `${child.index}.jsonl`),
      cwd: f.cwd,
      pid: process.pid,
      reason: "need_decision",
      message: `Choose for ${child.index}`,
    }),
  );
  const pending = f.invoke(
    {
      action: "answer",
      id,
      questionId: questions[0].questionId,
      message: "Proceed A",
      async: false,
    },
    AbortSignal.timeout(2_000),
  );
  await until(
    () => f.state.waitingRuns?.has(id) === true,
    "the answered child's wait must be registered",
  );
  recordQuestionDelivery(questions[0], { kind: "live", runId: id, deliveredAt: Date.now() });
  saveQuestionContract(id, 0, {
    result: {
      agent: "worker",
      task: "A",
      exitCode: 0,
      finalOutput: "A_AFTER_ANSWER",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
    },
  });
  const result = await pending;
  assert.equal(result.details.wait?.index, 0);
  assertDefined(result.details.wait);
  assert.equal(result.details.wait.status, "completed");
  assert.match(textAt(result.content), /A_AFTER_ANSWER/);
  assert.equal(readQuestionState(questions[1]).state, "awaiting_input");
});

test("an older multi-child runner cannot receive an index it would ignore", async (t) => {
  const f = await setup(t),
    id = randomUUID(),
    asyncDir = path.join(f.cwd, "old-runner");
  fs.mkdirSync(asyncDir);
  fs.writeFileSync(
    path.join(asyncDir, "status.json"),
    JSON.stringify({
      runId: id,
      mode: "parallel",
      state: "running",
      startedAt: 1,
      pid: process.pid,
      steps: [
        { agent: "worker", status: "running" },
        { agent: "worker", status: "running" },
      ],
    }),
  );
  f.state.asyncJobs.set(id, { asyncId: id, asyncDir, status: "running" });
  const result = interruptAsyncRun(f.state, id, 0);
  assertDefined(result);
  assert.equal(result.isError, true);
  assert.match(textAt(result.content), /older runner.*selected-child stop/);
  assert.equal(fs.existsSync(path.join(asyncDir, "control-request.json")), false);
});

for (const terminalState of ["complete", "failed"] as const) {
  test(`waiting returns the durable ${terminalState} workflow result when no children materialized`, async (t) => {
    const f = await setup(t),
      id = randomUUID();
    const original = f.state.ownedRuns.get(f.runId);
    assertDefined(original);
    const run: TrackedOwnedRun = {
      ...original,
      runId: id,
      rootRunId: id,
      source: "async",
      mode: "chain",
      asyncDir: getRunMetadataDir(id),
      children: [],
    };
    f.state.ownedRuns.set(id, run);
    saveAsyncRunResult(id, {
      runtimeVersion: 2,
      id,
      state: terminalState,
      timestamp: Date.now(),
      results: [],
      ...(terminalState === "failed"
        ? { error: "Collection schema rejected the empty group" }
        : { summary: "Empty fanout completed" }),
    });
    const result = await waitForOwnedRun({
      id,
      deps: f.deps,
      ctx: makeMinimalCtx(f.cwd),
      executionResult: true,
    });
    assertDefined(result.details.wait);
    assert.equal(result.details.wait.status, "completed");
    assert.equal(result.isError, terminalState === "failed" ? true : undefined);
    assert.deepEqual(result.details.results, []);
    assert.match(
      textAt(result.content),
      terminalState === "failed" ? /Collection schema rejected/ : /Empty fanout completed/,
    );
    const child = await waitForOwnedRun({ id, index: 0, deps: f.deps, ctx: makeMinimalCtx(f.cwd) });
    assert.equal(
      child.details.wait?.status,
      "unavailable",
      "an explicit nonexistent child is never fabricated",
    );
  });
}

test("foreground result collection requires durable publication, not an early terminal status", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const poll = t.mock.method(globalThis, "setInterval");
  const f = await setup(t),
    id = randomUUID(),
    asyncDir = path.join(f.cwd, "write-gap");
  fs.mkdirSync(asyncDir);
  const original = f.state.ownedRuns.get(f.runId);
  assertDefined(original);
  f.state.ownedRuns.set(id, {
    ...original,
    runId: id,
    rootRunId: id,
    source: "async",
    asyncDir,
    pid: process.pid,
  });
  fs.writeFileSync(
    path.join(asyncDir, "status.json"),
    JSON.stringify({
      runId: id,
      mode: "single",
      state: "complete",
      startedAt: 1,
      pid: process.pid,
      steps: [{ agent: "worker", status: "complete" }],
    }),
  );
  let returned = false;
  const pending = waitForOwnedRun({ id, deps: f.deps, ctx: makeMinimalCtx(f.cwd) }).then(
    (result) => {
      returned = true;
      return result;
    },
  );
  assert.equal(poll.mock.callCount(), 1, "an early status must leave an active wait");
  assert.equal(poll.mock.calls[0].arguments[1], POLL_INTERVAL_MS);
  t.mock.timers.tick(POLL_INTERVAL_MS);
  await Promise.resolve();
  assert.equal(returned, false);
  fs.mkdirSync(getRunMetadataDir(id), { recursive: true });
  fs.writeFileSync(
    path.join(getRunMetadataDir(id), "result.json"),
    JSON.stringify({
      id,
      mode: "single",
      success: true,
      state: "complete",
      results: [{ agent: "worker", output: "DURABLE-AFTER-GAP", exitCode: 0, success: true }],
    }),
  );
  t.mock.timers.tick(POLL_INTERVAL_MS);
  assert.match(textAt((await pending).content), /DURABLE-AFTER-GAP/);
});

test("waiting polls one fresh view without reading transcripts or enumerating unrelated questions", async (t) => {
  const f = await setup(t),
    id = randomUUID();
  const original = f.state.ownedRuns.get(f.runId);
  assertDefined(original);
  const sessionFile = original.children[0].sessionFile;
  assertDefined(sessionFile);
  fs.appendFileSync(
    sessionFile,
    JSON.stringify({
      type: "model_change",
      id: "model",
      parentId: null,
      provider: "fixture",
      modelId: "recorded",
      timestamp: new Date().toISOString(),
    }) + "\n",
  );
  const run: TrackedOwnedRun = {
    ...original,
    runId: id,
    rootRunId: id,
    source: "async",
    asyncDir: getRunMetadataDir(id),
    pid: process.pid,
  };
  f.state.ownedRuns.set(id, run);
  saveQuestionOwner(id, run.ownerSessionId);
  const originalContract = readQuestionContract(f.runId, 0);
  assertDefined(originalContract);
  saveQuestionContract(id, 0, originalContract);
  const asyncDir = run.asyncDir;
  assertDefined(asyncDir);
  const status: AsyncStatus = {
    runtimeVersion: 2,
    runId: id,
    mode: "single" as const,
    state: "running" as const,
    pid: process.pid,
    startedAt: Date.now(),
    steps: [
      { agent: "worker", status: "running" as const, sessionFile, model: "fixture/original" },
    ],
  };
  saveRunStatus(id, status);
  t.mock.timers.enable({ apis: ["setInterval"] });
  const waitIntervals = t.mock.method(globalThis, "setInterval");
  const tick = () => {
    t.mock.timers.tick(POLL_INTERVAL_MS);
  };
  const open = fs.openSync,
    readdir = fs.readdirSync;
  let transcriptReads = 0,
    contractReads = 0,
    globalListings = 0;
  t.mock.method(
    fs,
    "openSync",
    function (file: fs.PathLike, flags: fs.OpenMode, ...args: readonly unknown[]) {
      if (flags === "r" && String(file) === sessionFile) {
        transcriptReads++;
      }
      if (flags === "r" && String(file) === path.join(asyncDir, "contracts/0.json")) {
        contractReads++;
      }
      const fd: unknown = Reflect.apply(open, fs, [file, flags, ...args]);
      assert.ok(typeof fd === "number");
      return fd;
    },
  );
  t.mock.method(fs, "readdirSync", function (file: fs.PathLike, ...args: readonly unknown[]) {
    if (String(file) === path.dirname(asyncDir) || String(file).endsWith("/supervisor-questions")) {
      globalListings++;
    }
    const names: unknown = Reflect.apply(readdir, fs, [file, ...args]);
    assertArray(names);
    return names;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const controller = new AbortController();
  const updates: SubagentExecutionResult[] = [];
  t.after(() => controller.abort());
  const pending = waitForOwnedRun({
    id,
    deps: f.deps,
    ctx: makeMinimalCtx(f.cwd),
    signal: controller.signal,
    onUpdate: (result) => {
      updates.push(result);
    },
  });
  assert.equal(waitIntervals.mock.callCount(), 1, "the native polling owner registered its timer");
  assert.equal(waitIntervals.mock.calls[0].arguments[1], POLL_INTERVAL_MS);
  tick();
  assertDefined(status.steps);
  saveRunStatus(id, { ...status, steps: [{ ...status.steps[0], model: "fixture/fallback" }] });
  tick();
  assert.equal(contractReads, 3, "initial check and two ticks each project the run once");
  assert.equal(
    transcriptReads,
    0,
    "polling needs saved status, not native conversation configuration",
  );
  assert.equal(globalListings, 0, "an exact run never enumerates unrelated question directories");
  assert.equal(
    updates.length,
    2,
    "unchanged updates stay quiet and changed activity remains fresh",
  );
  assertDefined(updates[1].details.progress);
  assert.equal(updates[1].details.progress[0].model, "fixture/fallback");
  createSupervisorQuestion({
    runId: id,
    ownerTarget: "parent",
    agent: "worker",
    index: 0,
    childSessionId: "child",
    childTarget: "child",
    sessionFile,
    cwd: f.cwd,
    pid: process.pid,
    reason: "need_decision",
    message: "Choose now",
  });
  tick();
  const result = await pending;
  assert.equal(result.details.wait?.status, "awaiting_input");
  assertDefined(result.details.questions);
  assert.equal(result.details.questions[0].message, "Choose now");
  assert.equal(
    result.details.run?.children[0]?.launch?.model,
    "fixture/original",
    "returned launch preserves the captured selection",
  );
  assert.deepEqual(result.details.run.children[0]?.launch?.modelCandidates, ["fixture/original"]);
  assert.equal(f.mock.callCount(), 0, "polling never launches work");
});
