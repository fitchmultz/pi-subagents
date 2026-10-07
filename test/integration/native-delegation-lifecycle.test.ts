import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { after, test, type TestContext } from "node:test";
import { type ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ReadonlyDeep } from "type-fest";
import type {
  SubagentState,
  OwnedRun,
  ExtensionConfig,
  AsyncStatus,
} from "../../src/shared/types.ts";
import type { SubagentParamsLike } from "../../src/runs/foreground/subagent-params.ts";
import { record, text, textAt, assertDefined } from "../support/assertions.ts";
import { createNativeSessionFixture, createMockPi, events, makeAgent } from "../support/helpers.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-delegation-"));
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
process.env.PI_SUBAGENT_TEMP_ROOT = path.join(root, "pi-subagents-runtime");
const { createSubagentExecutor } = await import("../../src/runs/foreground/subagent-executor.ts");
const { waitForOwnedRun } = await import("../../src/runs/foreground/wait-run.ts");
const { createCompletionDelivery } =
  await import("../../src/runs/background/completion-delivery.ts");
const { registerParentUsage } = await import("../../src/runs/shared/parent-usage.ts");
const { rememberOwnedRun, restoreOwnedRuns } = await import("../../src/runs/shared/run-records.ts");
const {
  getRunMetadataDir,
  createSupervisorQuestion,
  saveQuestionOwner,
  saveRunStatus,
  saveAsyncRunResult,
  saveQuestionContract,
} = await import("../../src/runs/shared/supervisor-questions.ts");
const { createNestedRoute, writeNestedEvent, readNestedControlRequests, writeNestedControlResult } =
  await import("../../src/runs/shared/nested-events.ts");
const { createResultWatcher } = await import("../../src/runs/background/result-watcher.ts");
const {
  INTERCOM_DETACH_REQUEST_EVENT,
  INTERCOM_DETACH_RESPONSE_EVENT,
  SUBAGENT_LIVE_INTERCOM_EVENT,
  SUBAGENT_LIVE_INTERCOM_DELIVERY_EVENT,
  RESULTS_DIR,
} = await import("../../src/shared/types.ts");
after(() => fs.rmSync(root, { recursive: true, force: true }));

async function until(check: () => boolean, message: string) {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, message);
    // Observe the native child/result boundary before performing the next lifecycle operation.
    // oxlint-disable-next-line no-await-in-loop
    await delay(20);
  }
}

async function setup(
  t: TestContext,
  config: ReadonlyDeep<ExtensionConfig> = {},
  asyncByDefault = true,
) {
  const cwd = fs.mkdtempSync(path.join(root, "case-"));
  const manager = SessionManager.create(cwd, path.join(cwd, "parent"));
  manager.appendMessage(events.assistantMessage("Delegate a bounded task").message);
  const native = await createNativeSessionFixture({
    cwd,
    agentDir: path.join(cwd, "agent"),
    sessionManager: manager,
  });
  const ctx = native.context;
  const pi = native.pi;
  const bus = pi.events;
  const state: SubagentState & { ownedRuns: Map<string, OwnedRun> } = {
    baseCwd: cwd,
    currentSessionId: null,
    ownedRuns: new Map(),
    foregroundRuns: new Map(),
    asyncJobs: new Map(),
    cleanupTimers: new Map(),
    completionSeen: new Map(),
    lastUiContext: ctx,
    poller: null,
    watcher: null,
    watcherRestartTimer: null,
    persistOwnedRun: (run) => {
      manager.appendCustomEntry("subagent-run", run);
    },
    resultFileCoalescer: {
      schedule: () => false,
      clear() {
        // These direct lifecycle tests explicitly prime the result watcher, not a file coalescer.
      },
    },
  };
  const deps = {
    pi,
    state,
    config,
    asyncByDefault,
    tempArtifactsDir: cwd,
    getSubagentSessionRoot: () => path.join(cwd, "children"),
    expandTilde: (value: string) => value,
    discoverAgents: () => ({
      agents: [makeAgent("worker", { model: "fixture/child", completionGuard: false })],
    }),
  };
  const executor = createSubagentExecutor(deps);
  const mock = createMockPi();
  mock.install();
  t.after(async () => {
    for (const run of state.ownedRuns.values()) {
      if (
        run.asyncDir !== undefined &&
        run.asyncDir !== "" &&
        !fs.existsSync(path.join(getRunMetadataDir(run.runId), "result.json"))
      ) {
        // Stop each owned child before removing its independent fixture runtime.
        // oxlint-disable-next-line no-await-in-loop
        await executor.execute({
          toolCallId: randomUUID(),
          params: { action: "interrupt", id: run.runId },
          ctx,
        });
        // Its real persisted terminal result is the teardown barrier.
        // oxlint-disable-next-line no-await-in-loop
        await until(
          () => fs.existsSync(path.join(getRunMetadataDir(run.runId), "result.json")),
          "fixture child must exit before cleanup",
        );
      }
    }
    mock.uninstall();
    await native.dispose();
  });
  return {
    cwd,
    manager,
    ctx,
    bus,
    pi,
    state,
    executor,
    mock,
    invoke: (id: string, params: ReadonlyDeep<SubagentParamsLike>, signal?: AbortSignal) =>
      executor.execute({ toolCallId: id, params, signal, ctx }),
    wait: (id: string, index?: number, signal?: AbortSignal, includeProgress?: boolean) =>
      waitForOwnedRun({
        id,
        index,
        signal,
        includeProgress,
        executionResult: true,
        ctx,
        deps,
      }),
  };
}

for (const background of [undefined, true, false]) {
  test(`background launch returns a receipt before completion (${background === false ? "forced" : (background ?? "default")})`, async (t) => {
    const f = await setup(t, { forceTopLevelAsync: background === false });
    f.mock.onCall({ delay: 700, output: "APPENDED_COMPLETION" });
    const receipt = await f.invoke("native-receipt", {
      agent: "worker",
      task: "Do bounded work",
      async: background,
    });
    const runId = text(receipt.details.asyncId);
    assert.ok(runId.length > 0);
    assert.equal(receipt.details.wait, undefined);
    assert.equal(
      fs.existsSync(path.join(getRunMetadataDir(runId), "result.json")),
      false,
      "receipt precedes completion",
    );
    const notices: Array<{
      message: Parameters<ExtensionAPI["sendMessage"]>[0];
      options: Parameters<ExtensionAPI["sendMessage"]>[1];
    }> = [];
    const send = f.pi.sendMessage.bind(f.pi);
    f.pi.sendMessage = (message, options) => {
      notices.push({ message, options });
      send(message, options);
    };
    const { default: registerNotify } = await import("../../src/runs/background/notify.ts");
    registerNotify(f.pi);
    const watcher = createResultWatcher(f.pi, f.state, RESULTS_DIR);
    t.after(() => watcher.stopResultWatcher());
    await until(
      () => fs.existsSync(path.join(getRunMetadataDir(runId), "result.json")),
      "child completes independently",
    );
    watcher.primeExistingResults();
    await until(() => notices.length === 1, "completion appends a wake-up message");
    assert.equal(notices[0].message.customType, "subagent-notify");
    assert.match(text(notices[0].message.content), /APPENDED_COMPLETION/);
    assert.equal(notices[0].options?.triggerTurn, true);
    watcher.primeExistingResults();
    await watcher.joinInFlight();
    assert.equal(notices.length, 1);
  });
}

for (const action of ["resume", "answer"]) {
  for (const background of [undefined, true]) {
    test(`${action} returns its receipt without waiting (${background ?? "default"})`, async (t) => {
      const f = await setup(t);
      f.mock.onCall({ delay: 900, output: "LATER_RESULT" });
      const launch = await f.invoke("launch", { agent: "worker", task: "Keep working" });
      const runId = text(launch.details.asyncId);
      await until(() => f.mock.callCount() === 1, "child starts");
      f.bus.on(SUBAGENT_LIVE_INTERCOM_EVENT, (request) => {
        f.bus.emit(SUBAGENT_LIVE_INTERCOM_DELIVERY_EVENT, {
          requestId: text(record(request).requestId),
          delivered: true,
        });
      });
      const question =
        action === "answer"
          ? createSupervisorQuestion({
              runId,
              ownerTarget: "parent",
              agent: "worker",
              index: 0,
              childSessionId: "child",
              childTarget: "child",
              sessionFile: path.join(f.cwd, "child.jsonl"),
              cwd: f.cwd,
              pid: process.pid,
              reason: "need_decision",
              message: "Proceed?",
            })
          : undefined;
      const receipt = await f.invoke("control", {
        action,
        id: runId,
        message: "Proceed",
        async: background,
        questionId: question?.questionId,
      });
      assert.notEqual(receipt.isError, true);
      assert.equal(receipt.details.wait, undefined);
      assert.equal(
        fs.existsSync(path.join(getRunMetadataDir(runId), "result.json")),
        false,
        "control returns while the child is still running",
      );
      if (question) {
        assertDefined(receipt.details.questions);
        assertDefined(receipt.details.questions[0].answer);
        assert.equal(receipt.details.questions[0].answer.message, "Proceed");
      } else {
        assert.equal(record(receipt.details.managementControl).runId, runId);
      }
    });
  }
}

for (const foreground of [false, undefined]) {
  test(`foreground delegation waits for the actual result (${foreground === false ? "explicit" : "configured"})`, async (t) => {
    const f = await setup(t, {}, false);
    f.mock.onCall({ delay: 350, output: "ORIGINAL_CALL_RESULT" });
    let finished = false;
    const resultPromise = f
      .invoke("native-launch", { agent: "worker", task: "Do bounded work", async: foreground })
      .then((result) => {
        finished = true;
        return result;
      });
    await until(() => f.mock.callCount() === 1, "native child starts");
    assert.equal(finished, false, "a launch receipt cannot settle a foreground call");
    const runId = [...f.state.ownedRuns.keys()][0];
    assert.ok(runId.length > 0, "list exposes the durable handle while the foreground call waits");
    const result = await resultPromise;
    assert.equal(record(result.details.wait).status, "completed");
    assert.equal(record(result.details.wait).runId, runId);
    assert.match(textAt(result.content), /ORIGINAL_CALL_RESULT/);
    assert.equal(f.mock.callCount(), 1);
  });
}

test("aborting an existing wait preserves the child; restoring owned work does not relaunch", async (t) => {
  const f = await setup(t);
  f.mock.onCall({ delay: 450, output: "AFTER_REATTACH" });
  const receipt = await f.invoke("launch", { agent: "worker", task: "Keep running" });
  const runId = text(receipt.details.asyncId);
  await until(() => f.mock.callCount() === 1, "child starts");
  const abort = new AbortController();
  const waiting = f.wait(runId, undefined, abort.signal);
  abort.abort();
  assert.equal(record((await waiting).details.wait).status, "cancelled");
  assert.equal(fs.existsSync(path.join(getRunMetadataDir(runId), "control-requests")), false);
  f.state.ownedRuns.clear();
  restoreOwnedRuns(f.state, f.ctx);
  const result = await f.wait(runId, undefined, undefined, true);
  assert.equal(record(result.details.wait).status, "completed");
  assert.match(textAt(result.content), /AFTER_REATTACH/);
  assert.equal(result.details.progress?.[0]?.task, "Keep running");
  assert.equal(f.mock.callCount(), 1);
});

test("Intercom attention releases the foreground wait without stopping existing work", async (t) => {
  const f = await setup(t);
  f.mock.onCall({ delay: 350, output: "AFTER_STEER" });
  const receipt = await f.invoke("launch", { agent: "worker", task: "Finish" });
  await until(() => f.mock.callCount() === 1, "child starts");
  const waiting = f.wait(text(receipt.details.asyncId));
  let accepted = false;
  f.bus.on(INTERCOM_DETACH_RESPONSE_EVENT, (response) => {
    assert.equal(typeof record(response).accepted, "boolean");
    accepted = record(response).accepted === true;
  });
  f.bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "attention", reason: "attention" });
  assert.equal(accepted, true);
  assert.equal(record((await waiting).details.wait).status, "yielded");
  assert.match(textAt((await f.wait(text(receipt.details.asyncId))).content), /AFTER_STEER/);
});

for (const includeProgress of [true, undefined]) {
  test(`live continuation waits and restores its own progress opt-in (${includeProgress ?? "default"})`, async (t) => {
    const f = await setup(t);
    f.mock.onCall({ delay: 650, output: "LIVE_CONTINUATION_RESULT" });
    const receipt = await f.invoke("portable-launch", {
      agent: "worker",
      task: "Wait for guidance",
      includeProgress: includeProgress !== true,
    });
    const runId = text(receipt.details.asyncId);
    await until(() => f.mock.callCount() === 1, "portable child starts");
    let deliveries = 0;
    f.bus.on(SUBAGENT_LIVE_INTERCOM_EVENT, (request) => {
      deliveries++;
      f.bus.emit(SUBAGENT_LIVE_INTERCOM_DELIVERY_EVENT, {
        requestId: text(record(request).requestId),
        delivered: true,
      });
    });
    const result = await f.invoke("native-continue", {
      action: "resume",
      id: runId,
      message: "Use this guidance",
      includeProgress,
      async: false,
    });
    assert.equal(record(result.details.wait).status, "completed");
    assert.match(textAt(result.content), /LIVE_CONTINUATION_RESULT/);
    assert.equal(
      result.details.progress?.[0]?.status,
      includeProgress === true ? "complete" : undefined,
      "the waiting continuation opts in independently of the original launch",
    );
    const recovered = await f.wait(runId, undefined, undefined, includeProgress);
    assert.deepEqual(recovered.details.progress, result.details.progress);
    assert.equal(deliveries, 1);
    assert.equal(f.mock.callCount(), 1);
    assert.equal(deliveries, 1);
  });
}

for (const selected of [undefined, 1]) {
  test(`nested continuation ${selected === undefined ? "whole-run" : "selected-child"} waits and recovers without adoption or redelivery`, async (t) => {
    const f = await setup(t),
      rootId = randomUUID(),
      runId = randomUUID(),
      callId = `native-nested-${selected ?? "all"}`;
    const childOwner = SessionManager.create(f.cwd, path.join(f.cwd, "child-owner"));
    const route = createNestedRoute(rootId),
      asyncDir = getRunMetadataDir(runId),
      mode = selected === undefined ? "single" : "parallel";
    rememberOwnedRun(f.state, {
      runId: rootId,
      rootRunId: rootId,
      ownerSessionId: f.manager.getSessionId(),
      source: "async",
      mode: "single",
      cwd: f.cwd,
      task: "Outer assignment",
      startedAt: Date.now(),
      children: [],
    });
    saveQuestionOwner(runId, childOwner.getSessionId());
    const steps: NonNullable<AsyncStatus["steps"]> = Array.from(
      { length: selected === undefined ? 1 : 2 },
      (_, index) => ({
        agent: "worker",
        status: "running",
        sessionFile: path.join(f.cwd, `nested-${index}.jsonl`),
      }),
    );
    for (const [index, step] of steps.entries()) {
      saveQuestionContract(runId, index, {
        task: `Nested assignment ${index}`,
        sessionFile: step.sessionFile,
      });
    }
    saveRunStatus(runId, {
      runtimeVersion: 2,
      runId,
      mode,
      state: "running",
      pid: process.pid,
      cwd: f.cwd,
      startedAt: Date.now(),
      indexedControl: true,
      controlRequestFiles: true,
      steps,
    });
    fs.writeFileSync(
      path.join(asyncDir, "launch.json"),
      JSON.stringify({
        runtimeVersion: 2,
        nestedRoute: route,
        nestedSelf: { parentRunId: rootId },
      }),
    );
    writeNestedEvent(route, {
      type: "subagent.nested.started",
      ts: Date.now(),
      parentRunId: rootId,
      parentStepIndex: 0,
      child: {
        id: runId,
        parentRunId: rootId,
        parentStepIndex: 0,
        depth: 1,
        path: [{ runId: rootId, stepIndex: 0 }],
        state: "running",
        mode,
        agent: "worker",
        ownerState: "live",
        asyncDir,
        indexedControl: true,
      },
    });
    let delivered = 0;
    const reply = setInterval(() => {
      const request = readNestedControlRequests(route).at(0);
      if (request === undefined || delivered !== 0) {
        return;
      }
      delivered++;
      writeNestedControlResult(route, {
        ts: Date.now(),
        requestId: text(record(request).requestId),
        targetRunId: runId,
        ok: true,
        message: "Guidance accepted",
      });
    }, 10);
    const abort = new AbortController();
    let settled = false;
    const pending = f
      .invoke(
        callId,
        {
          action: "resume",
          id: runId.slice(0, 12),
          async: false,
          ...(selected === undefined ? {} : { index: selected }),
          message: "Continue the authorized work",
        },
        abort.signal,
      )
      .then((result) => {
        settled = true;
        return result;
      });
    t.after(async () => {
      clearInterval(reply);
      abort.abort();
      await pending;
    });
    await until(() => delivered === 1, "nested owner receives guidance");
    await delay(120);
    assert.equal(
      settled,
      false,
      "accepted nested guidance must remain pending for the actual saved result",
    );
    assert.equal(readNestedControlRequests(route).at(0)?.index, selected);
    abort.abort();
    assert.equal(record((await pending).details.wait).status, "cancelled");
    assert.equal(
      fs.existsSync(path.join(asyncDir, "control-requests")),
      false,
      "cancelling a continuation wait never cancels the descendant",
    );
    assert.deepEqual([...f.state.ownedRuns.keys()], [rootId]);
    assert.equal(f.state.asyncJobs.size, 0);
    let recovered = false;
    const recovery = f.wait(runId, selected).then((result) => {
      recovered = true;
      return result;
    });
    await delay(30);
    assert.equal(
      recovered,
      false,
      "recovery waits on saved work rather than returning another receipt",
    );
    const childResult = {
      agent: "worker",
      task: `Nested assignment ${selected ?? 0}`,
      exitCode: 0,
      finalOutput: "NESTED_NATIVE_RESULT",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
    };
    if (selected === undefined) {
      saveAsyncRunResult(runId, {
        runtimeVersion: 2,
        id: runId,
        state: "complete",
        success: true,
        timestamp: Date.now(),
        results: [{ ...childResult, success: true }],
      });
    } else {
      saveQuestionContract(runId, selected, { result: childResult });
    }
    const result = await recovery;
    assert.equal(result.details.wait?.status, "completed");
    assert.match(textAt(result.content), /NESTED_NATIVE_RESULT/);
    assert.equal(
      record(result.details.run).ownerSessionId,
      childOwner.getSessionId(),
      "read-only projection retains the actual direct parent",
    );
    assert.equal(record(result.details.wait).index, selected);
    assert.equal(result.details.results.length, 1);
    assert.equal((await f.wait(runId, selected)).details.wait?.status, "completed");
    assert.equal(delivered, 1);
    assert.equal(f.mock.callCount(), 0);
    assert.deepEqual([...f.state.ownedRuns.keys()], [rootId]);
    f.state.ownedRuns.clear();
    assert.equal(
      (await f.wait(runId, selected)).isError,
      true,
      "saved work cannot bypass current route authorization",
    );
  });
}

test("obsolete saved native-call metadata cannot suppress durable completion notifications", async (t) => {
  const f = await setup(t),
    runId = randomUUID(),
    dir = getRunMetadataDir(runId);
  f.manager.appendCustomEntry("subagent-invocation", {
    toolCallId: "pending-native",
    ownerSessionId: f.manager.getSessionId(),
    runId,
    kind: "launch",
  });
  rememberOwnedRun(f.state, {
    runId,
    rootRunId: runId,
    ownerSessionId: f.manager.getSessionId(),
    source: "async",
    mode: "single",
    cwd: f.cwd,
    task: "Saved result",
    startedAt: 1,
    asyncDir: dir,
    children: [{ agent: "worker", index: 0 }],
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "result.json"),
    JSON.stringify({
      runtimeVersion: 2,
      id: runId,
      sessionId: f.manager.getSessionFile(),
      state: "complete",
      success: true,
      timestamp: 2,
      results: [
        { agent: "worker", success: true, exitCode: 0, output: "Original call owns this result" },
      ],
    }),
  );
  const file = f.manager.getSessionFile();
  assertDefined(file);
  f.state.currentSessionId = file;
  const completions: unknown[] = [];
  f.bus.on("subagent:async-complete", (event) => {
    completions.push(event);
  });
  const completion = createCompletionDelivery(f.pi, f.state, registerParentUsage(f.pi, []));
  try {
    completion.start();
    await until(
      () => completions.length > 0,
      "canonical result discovered despite obsolete pending-call metadata",
    );
    assert.ok(completions.every((event) => record(event).suppressNotification !== true));
    assert.equal(fs.existsSync(path.join(dir, "result.json")), true);
  } finally {
    completion.stop();
  }
});
