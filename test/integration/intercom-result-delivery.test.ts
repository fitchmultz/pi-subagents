import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import {
  textAt,
  assertDefined,
  record,
  records,
  strings,
  text as requireText,
  json,
} from "../support/assertions.ts";
import type { ReadonlyInput } from "../../src/shared/types/inputs.ts";
import {
  createNativeSessionFixture,
  type NativeSessionFixture,
} from "../support/native-session.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  createSupervisorQuestion,
  getRunMetadataDir,
  saveRunStatus,
  questionProcessAlive,
  saveQuestionOwner,
} from "../../src/runs/shared/supervisor-questions.ts";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createNestedRoute, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { createResultWatcher } from "../../src/runs/background/result-watcher.ts";
import { rememberOwnedRun } from "../../src/runs/shared/run-records.ts";
import { closeRunHistory } from "../../src/runs/shared/history-index.ts";
import {
  type SubagentState,
  type AcceptanceConfig,
  ASYNC_DIR,
  INTERCOM_DETACH_REQUEST_EVENT,
  RESULTS_DIR,
  TEMP_ROOT_DIR,
} from "../../src/shared/types.ts";
import {
  type MockPi,
  createMockPi,
  createTempDir,
  events as mockEvents,
  makeAgent,
  makeMinimalCtx,
  removeTempDir,
} from "../support/helpers.ts";

function createRecordingEventBus(
  options: {
    readonly acknowledgeResults?: boolean;
    readonly acknowledgeLive?: boolean;
    readonly health?: readonly Readonly<Record<string, unknown>>[];
    readonly identity?: string;
  } = {},
) {
  const identity = options.identity ?? "";
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const emitted: Array<{ channel: string; payload: Record<string, unknown> }> = [];
  const bus = {
    emitted,
    on(channel: string, handler: (payload: unknown) => void) {
      const channelListeners = listeners.get(channel) ?? new Set();
      channelListeners.add(handler);
      listeners.set(channel, channelListeners);
      return () => {
        channelListeners.delete(handler);
        if (channelListeners.size === 0) {
          listeners.delete(channel);
        }
      };
    },
    emit(channel: string, payload: unknown) {
      emitted.push({ channel, payload: record(payload) });
      for (const handler of listeners.get(channel) ?? []) {
        handler(payload);
      }
      if (identity.length > 0 && channel === "subagent:intercom-identity-request") {
        const requestId = record(payload).requestId;
        if (typeof requestId === "string") {
          bus.emit("subagent:intercom-identity-response", {
            requestId,
            sessionId: options.identity,
          });
        }
      }
      if (options.acknowledgeResults === true && channel === "subagent:result-intercom") {
        const requestId = record(payload).requestId;
        if (typeof requestId === "string") {
          setImmediate(() =>
            bus.emit("subagent:result-intercom-delivery", { requestId, delivered: true }),
          );
        }
      }
      if (options.acknowledgeLive === true && channel === "subagent:live-intercom") {
        const requestId = record(payload).requestId;
        if (typeof requestId === "string") {
          setImmediate(() =>
            bus.emit("subagent:live-intercom-delivery", { requestId, delivered: true }),
          );
        }
      }
      if (options.health && channel === "subagent:intercom-health-request") {
        const requestId = record(payload).requestId;
        if (typeof requestId === "string") {
          setImmediate(() =>
            bus.emit("subagent:intercom-health-response", { requestId, health: options.health }),
          );
        }
      }
    },
  };
  return bus;
}

describe("intercom result delivery cutover", () => {
  let tempDir: string;
  let mockPi: MockPi;
  const states = new Set<SubagentState>();
  const nativeFixtures: NativeSessionFixture[] = [];

  before(() => {
    mockPi = createMockPi();
    mockPi.install();
  });

  after(() => {
    mockPi.uninstall();
  });

  beforeEach(() => {
    tempDir = createTempDir("pi-subagent-intercom-result-");
    mockPi.reset();
  });

  afterEach(async () => {
    await Promise.all([...states].map(closeRunHistory));
    states.clear();
    await Promise.all(nativeFixtures.splice(0).map((fixture) => fixture.dispose()));
    removeTempDir(tempDir);
  });

  async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate() && Date.now() < deadline) {
      // The next assertion probe must observe the previous filesystem/process transition first.
      // oxlint-disable-next-line no-await-in-loop
      await sleep(25);
    }
    assert.equal(predicate(), true, "timed out waiting for condition");
  }

  async function readMockCallArgs(index: number): Promise<string[]> {
    const deadline = Date.now() + 10_000;
    let callFile: string | undefined;
    while (callFile === undefined) {
      callFile = fs
        .readdirSync(mockPi.dir)
        .filter((name) => name.startsWith("call-") && name.endsWith(".json"))
        .sort()
        .at(index);
      if (callFile !== undefined || Date.now() > deadline) {
        break;
      }
      // A child publishes its call record before later call indexes can be read.
      // oxlint-disable-next-line no-await-in-loop
      await sleep(50);
    }
    assert.ok(
      callFile !== undefined && callFile.length > 0,
      `expected mock pi call at index ${index}`,
    );
    const call = json(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8"));
    return [...strings(call.expandedArgs ?? call.args)];
  }

  async function makeExecutor(
    options: ReadonlyInput<{
      agents?: ReturnType<typeof makeAgent>[];
      acknowledgeResults?: boolean;
      acknowledgeLive?: boolean;
      health?: Record<string, unknown>[];
      identity?: string;
    }> = {},
  ) {
    const events = createRecordingEventBus({
      acknowledgeResults: options.acknowledgeResults ?? true,
      acknowledgeLive: options.acknowledgeLive,
      health: options.health,
      identity: options.identity,
    });
    const state: SubagentState & Required<Pick<SubagentState, "foregroundRuns">> = {
      baseCwd: tempDir,
      currentSessionId: null,
      asyncJobs: new Map(),
      foregroundRuns: new Map(),
      cleanupTimers: new Map(),
      lastUiContext: null,
      poller: null,
      completionSeen: new Map(),
      watcher: null,
      watcherRestartTimer: null,
      resultFileCoalescer: {
        schedule: () => false,
        clear: () => {
          /* No scheduled result files belong to this recording fixture. */
        },
      },
    };
    states.add(state);
    const native = await createNativeSessionFixture({
      cwd: tempDir,
      agentDir: path.join(tempDir, "agent"),
      bindExtensions: false,
    });
    nativeFixtures.push(native);
    const executor = createSubagentExecutor({
      pi: { ...native.pi, events, getSessionName: () => "orchestrator" },
      state,
      config: {},
      asyncByDefault: false,
      tempArtifactsDir: tempDir,
      getSubagentSessionRoot: () => tempDir,
      expandTilde: (value: string) => value,
      discoverAgents: () => ({
        agents: options.agents?.map((agent) => makeAgent(agent.name, agent)) ?? [
          makeAgent("worker"),
        ],
      }),
    });
    return { executor, events, state };
  }

  it("passes the exact connected orchestrator identity to child supervisor metadata", async () => {
    mockPi.onCall({ echoEnv: ["PI_SUBAGENT_ORCHESTRATOR_TARGET"] });
    const { executor } = await makeExecutor({ identity: "exact-parent-session-id" });

    const result = await executor.execute({
      toolCallId: "exact-parent",
      params: { agent: "worker", task: "Contact supervisor" },
      signal: new AbortController().signal,
      onUpdate: undefined,
      ctx: makeMinimalCtx(tempDir),
    });

    assert.equal(result.isError, undefined, textAt(result.content));
    assert.deepEqual(json(requireText(result.details.results[0]?.finalOutput)), {
      PI_SUBAGENT_ORCHESTRATOR_TARGET: "exact-parent-session-id",
    });
  });

  for (const mode of ["single", "parallel", "chain"] as const) {
    for (const failed of [false, true]) {
      it(`${mode} owner results retain evidence and deliver one truthful grouped completion (${failed ? "failed" : "completed"})`, async () => {
        mockPi.onCall({ matchArgsIncludes: "FIRST", output: "FIRST_EVIDENCE" });
        mockPi.onCall({
          matchArgsIncludes: "LAST",
          output: "LAST_EVIDENCE",
          ...(failed ? { exitCode: 1, stderr: "Expected last-child failure" } : {}),
        });
        const { executor, events: bus, state } = await makeExecutor();
        const tasks = [
          { agent: "worker", task: "FIRST" },
          { agent: "worker", task: "LAST" },
        ];
        const result = await executor.execute({
          toolCallId: "grouped",
          params: {
            ...(mode === "single" ? tasks[1] : {}),
            ...(mode === "parallel" ? { tasks, concurrency: 1 } : {}),
            ...(mode === "chain" ? { chain: tasks } : {}),
          },
          signal: undefined,
          onUpdate: undefined,
          ctx: makeMinimalCtx(tempDir),
        });
        assert.equal(result.isError, failed || undefined, textAt(result.content));
        assert.match(textAt(result.content), /LAST_EVIDENCE/);
        assert.equal(record(result.details.results.at(-1)).finalOutput, "LAST_EVIDENCE");
        const watcher = createResultWatcher({ events: bus }, state, RESULTS_DIR);
        try {
          watcher.primeExistingResults();
          watcher.primeExistingResults();
          await waitFor(() =>
            bus.emitted.some(
              (entry) =>
                entry.channel === "subagent:async-complete" &&
                entry.payload.runId === result.details.runId,
            ),
          );
          const delivered = bus.emitted.filter(
            (entry) =>
              entry.channel === "subagent:result-intercom" &&
              entry.payload.runId === result.details.runId,
          );
          assert.equal(delivered.length, 1);
          const payload = delivered[0].payload;
          assert.equal(payload.mode, mode);
          assert.equal(payload.status, failed ? "failed" : "completed");
          assert.deepEqual(
            records(payload.children).map((child) => child.index),
            mode === "single" ? [0] : [0, 1],
          );
          assert.deepEqual(
            records(payload.children).map((child) => child.status),
            mode === "single"
              ? [failed ? "failed" : "completed"]
              : ["completed", failed ? "failed" : "completed"],
          );
          if (failed && mode !== "single") {
            assert.match(requireText(payload.summary), /1 completed, 1 failed/);
          }
          assert.match(
            requireText(record(records(payload.children).at(-1)).summary),
            /LAST_EVIDENCE/,
          );
          assert.equal(
            payload.resultPath,
            path.join(getRunMetadataDir(requireText(result.details.runId)), "result.json"),
          );
          assert.ok(
            fs.existsSync(requireText(record(records(payload.children).at(-1)).metadataPath)),
          );
          const status = await executor.execute({
            toolCallId: "inspect",
            params: { action: "status", id: result.details.runId },
            signal: undefined,
            onUpdate: undefined,
            ctx: makeMinimalCtx(tempDir),
          });
          assert.match(textAt(status.content), /LAST_EVIDENCE/);
          assert.equal(mockPi.callCount(), mode === "single" ? 1 : 2);
        } finally {
          watcher.stopResultWatcher();
        }
      });
    }
  }

  it("an unacknowledged owner completion retains its saved output and publishes one fallback event", async () => {
    mockPi.onCall({ output: "UNACKNOWLEDGED_EVIDENCE" });
    const { executor, events: bus, state } = await makeExecutor({ acknowledgeResults: false });
    const result = await executor.execute({
      toolCallId: "unacknowledged",
      params: { agent: "worker", task: "Report" },
      signal: undefined,
      onUpdate: undefined,
      ctx: makeMinimalCtx(tempDir),
    });
    const watcher = createResultWatcher({ events: bus }, state, RESULTS_DIR);
    try {
      watcher.primeExistingResults();
      await waitFor(() =>
        bus.emitted.some(
          (entry) =>
            entry.channel === "subagent:async-complete" &&
            entry.payload.runId === result.details.runId,
        ),
      );
      const completed = bus.emitted.filter(
        (entry) =>
          entry.channel === "subagent:async-complete" &&
          entry.payload.runId === result.details.runId,
      );
      assert.equal(completed.length, 1);
      assert.equal(completed[0].payload.intercomResultDelivered, false);
      assert.match(textAt(result.content), /UNACKNOWLEDGED_EVIDENCE/);
      const saved = json(
        fs.readFileSync(
          path.join(getRunMetadataDir(requireText(result.details.runId)), "result.json"),
          "utf8",
        ),
      );
      assert.equal(record(records(saved.results)[0]).finalOutput, "UNACKNOWLEDGED_EVIDENCE");
    } finally {
      watcher.stopResultWatcher();
    }
  });

  it("releasing the wait leaves indexed siblings, downstream work and one grouped completion with the owner", async () => {
    const release = path.join(tempDir, "release-child");
    mockPi.onCall({ matchArgsIncludes: "FIRST", output: "FIRST_EVIDENCE" });
    mockPi.onCall({
      matchArgsIncludes: "WAIT",
      steps: [
        { jsonl: [mockEvents.toolStart("contact_supervisor", { reason: "need_decision" })] },
        { waitForFile: release, jsonl: [mockEvents.assistantMessage("WAIT_FINISHED")] },
      ],
    });
    mockPi.onCall({ matchArgsIncludes: "DOWNSTREAM", output: "DEPENDENT_EVIDENCE" });
    const { executor, events: bus, state } = await makeExecutor();
    let yielded = false;
    const initial = await executor.execute({
      toolCallId: "released",
      params: {
        chain: [
          {
            parallel: [
              { agent: "worker", task: "FIRST" },
              { agent: "worker", task: "WAIT" },
            ],
            concurrency: 1,
          },
          { agent: "worker", task: "DOWNSTREAM" },
        ],
        artifacts: false,
      },
      signal: undefined,
      onUpdate: (update) => {
        if (
          !yielded &&
          update.details.progress?.some((child) => child.currentTool === "contact_supervisor") ===
            true
        ) {
          yielded = true;
          bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "release" });
        }
      },
      ctx: makeMinimalCtx(tempDir),
    });
    assertDefined(initial.details.wait);
    assert.equal(initial.details.wait.status, "yielded");
    const runId = initial.details.wait.runId;
    fs.writeFileSync(release, "");
    await waitFor(() => fs.existsSync(path.join(getRunMetadataDir(runId), "result.json")));
    const durable = json(
      fs.readFileSync(path.join(getRunMetadataDir(runId), "result.json"), "utf8"),
    );
    assert.deepEqual(
      records(durable.results).map((child) => child.finalOutput),
      ["FIRST_EVIDENCE", "WAIT_FINISHED", "DEPENDENT_EVIDENCE"],
    );
    assert.equal(durable.state, "complete");
    const watcher = createResultWatcher({ events: bus }, state, RESULTS_DIR);
    try {
      watcher.primeExistingResults();
      await waitFor(() =>
        bus.emitted.some(
          (entry) => entry.channel === "subagent:async-complete" && entry.payload.runId === runId,
        ),
      );
      assert.equal(
        bus.emitted.filter(
          (entry) => entry.channel === "subagent:result-intercom" && entry.payload.runId === runId,
        ).length,
        1,
      );
      assert.equal(
        initial.details.wait.status,
        "yielded",
        "the released wait receipt is immutable",
      );
    } finally {
      watcher.stopResultWatcher();
    }
  });

  it("resume action sends a follow-up to a live async child when the target is registered", async () => {
    const runId = `resume-live-${Date.now()}`;
    const asyncDir = path.join(ASYNC_DIR, runId);
    try {
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(
          {
            runId,
            mode: "single",
            state: "running",
            startedAt: 100,
            lastUpdate: 100,
            steps: [{ agent: "worker", status: "running" }],
          },
          null,
          2,
        ),
        "utf-8",
      );
      const { executor, events } = await makeExecutor();

      const result = await executor.execute({
        toolCallId: "resume-live",
        params: {
          action: "resume",
          id: runId,
          message: "Can you clarify the last change?",
          acceptance: { criteria: ["New contract"] },
        },
        signal: new AbortController().signal,
        onUpdate: undefined,
        ctx: makeMinimalCtx(tempDir),
      });

      assert.equal(result.isError, undefined);
      assert.match(textAt(result.content), /Delivered follow-up to live async child/);
      assert.match(
        textAt(result.content),
        /Acceptance override applies only to revive and was not applied/,
      );
      const payload = events.emitted.find(
        (entry) => entry.channel === "subagent:result-intercom",
      )?.payload;
      assert.equal(payload?.to, `subagent-worker-${runId}-1`);
      assert.match(requireText(payload.message), /Can you clarify the last change\?/);
    } finally {
      fs.rmSync(asyncDir, { recursive: true, force: true });
    }
  });

  it("nudge action sends a steered message to a live async child", async () => {
    const runId = `nudge-live-${Date.now()}`;
    const asyncDir = path.join(ASYNC_DIR, runId);
    try {
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(
          {
            runId,
            mode: "single",
            state: "running",
            startedAt: 100,
            lastUpdate: 100,
            steps: [{ agent: "worker", status: "running" }],
          },
          null,
          2,
        ),
        "utf-8",
      );
      const { executor, events } = await makeExecutor({ acknowledgeLive: true });

      const result = await executor.execute({
        toolCallId: "nudge-live",
        params: { action: "nudge", id: runId, message: "What is blocking you?" },
        signal: new AbortController().signal,
        onUpdate: undefined,
        ctx: makeMinimalCtx(tempDir),
      });

      assert.equal(result.isError, undefined);
      assert.match(textAt(result.content), /Nudge delivered to live subagent/);
      const payload = events.emitted.find(
        (entry) => entry.channel === "subagent:live-intercom",
      )?.payload;
      assert.equal(payload?.to, `subagent-worker-${runId}-1`);
      assert.equal(payload.delivery, "steer");
      assert.match(requireText(payload.message), /What is blocking you\?/);
    } finally {
      fs.rmSync(asyncDir, { recursive: true, force: true });
    }
  });

  it("nudge action returns completed work with evidence and exact resume and status targets", async () => {
    const runId = `nudge-complete-${Date.now()}`;
    const asyncDir = path.join(ASYNC_DIR, runId);
    const sessionFile = path.join(tempDir, `${runId}.jsonl`);
    try {
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.writeFileSync(sessionFile, "", "utf-8");
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(
          {
            runId,
            mode: "single",
            state: "complete",
            startedAt: 100,
            lastUpdate: 200,
            outputFile: "output-0.log",
            steps: [{ agent: "worker", status: "complete", sessionFile }],
          },
          null,
          2,
        ),
        "utf-8",
      );
      fs.writeFileSync(path.join(asyncDir, "output-0.log"), "Verified completed outcome", "utf-8");
      const { executor, events } = await makeExecutor();
      const result = await executor.execute({
        toolCallId: "nudge-complete",
        params: { action: "nudge", id: runId },
        signal: new AbortController().signal,
        onUpdate: undefined,
        ctx: makeMinimalCtx(tempDir),
      });
      const text = textAt(result.content);
      assert.equal(result.isError, undefined);
      assert.match(text, /Nudge not sent: run is already completed/);
      assert.match(text, /Verified completed outcome/);
      assert.ok(text.includes(path.join(asyncDir, "output-0.log")));
      assert.equal(events.emitted.length, 0, "no child launch or intercom delivery");
      assert.match(text, new RegExp(`action: "continue", id: "${runId}"`));
      assert.match(text, new RegExp(`action: "inspect", id: "${runId}"`));
      assert.equal(result.details.managementControl?.state, "completed");
      assert.equal(result.details.managementControl.capabilities.includes("nudge"), false);
    } finally {
      fs.rmSync(asyncDir, { recursive: true, force: true });
    }
  });

  it("nudge completion race returns terminal evidence without a saved session or another launch", async () => {
    const runId = `nudge-race-${Date.now()}`;
    const asyncDir = path.join(ASYNC_DIR, runId);
    try {
      fs.mkdirSync(asyncDir, { recursive: true });
      const writeStatus = (state: string) =>
        fs.writeFileSync(
          path.join(asyncDir, "status.json"),
          JSON.stringify({
            runId,
            mode: "single",
            state,
            startedAt: 100,
            lastUpdate: 200,
            outputFile: "output-0.log",
            steps: [{ agent: "worker", status: state }],
          }),
        );
      writeStatus("running");
      const { executor, events } = await makeExecutor();
      events.on("subagent:live-intercom", (payload) => {
        writeStatus("failed");
        fs.writeFileSync(path.join(asyncDir, "output-0.log"), "Check failed: useful diagnosis");
        events.emit("subagent:live-intercom-delivery", {
          requestId: requireText(record(payload).requestId),
          delivered: false,
          reason: "Session not found",
        });
      });
      const result = await executor.execute({
        toolCallId: "nudge-race",
        params: { action: "nudge", id: runId },
        signal: new AbortController().signal,
        onUpdate: undefined,
        ctx: makeMinimalCtx(tempDir),
      });
      assert.equal(result.isError, undefined);
      assert.equal(result.details.managementControl?.state, "failed");
      assert.match(textAt(result.content), /already failed/);
      assert.match(textAt(result.content), /Check failed: useful diagnosis/);
      assert.equal(result.details.managementControl.capabilities.includes("resume"), false);
      const late = await executor.execute({
        toolCallId: "nudge-after-race",
        params: { action: "nudge", id: runId },
        signal: new AbortController().signal,
        onUpdate: undefined,
        ctx: makeMinimalCtx(tempDir),
      });
      assert.equal(
        late.isError,
        undefined,
        "terminal inspection must not require a resumable child",
      );
      assert.equal(
        events.emitted.filter((event) => event.channel === "subagent:live-intercom").length,
        1,
      );
      assert.equal(
        fs.readdirSync(mockPi.dir).filter((name) => /^call-.*\.json$/.test(name)).length,
        0,
      );
    } finally {
      fs.rmSync(asyncDir, { recursive: true, force: true });
    }
  });

  it("status lists completed owned runs while another durable owner is active", async () => {
    mockPi.onCall({ output: "Saved foreground evidence" });
    const { executor, state, events } = await makeExecutor();
    const ctx = makeMinimalCtx(tempDir);
    ctx.sessionManager.getSessionId = () => `owned-parent-${path.basename(tempDir)}`;
    const completed = await executor.execute({
      toolCallId: "completed-foreground",
      params: { agent: "worker", task: "Report status" },
      signal: new AbortController().signal,
      onUpdate: undefined,
      ctx,
    });
    saveRunStatus("another-live-run", {
      runtimeVersion: 2,
      runId: "another-live-run",
      mode: "single",
      state: "running",
      pid: process.pid,
      startedAt: Date.now(),
      steps: [{ agent: "worker", status: "running" }],
    });
    rememberOwnedRun(state, {
      runId: "another-live-run",
      asyncDir: getRunMetadataDir("another-live-run"),
      ownerSessionId: ctx.sessionManager.getSessionId(),
      source: "async",
      mode: "single",
      cwd: tempDir,
      task: "Active work",
      startedAt: 100,
      rootRunId: "another-live-run",
      children: [{ agent: "worker", index: 0 }],
    });
    const runId = `owned-recent-${Date.now()}`;
    const asyncDir = path.join(ASYNC_DIR, runId);
    try {
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify({
          runId,
          sessionId: state.currentSessionId,
          cwd: path.join(tempDir, "other-worktree"),
          mode: "single",
          state: "complete",
          startedAt: 100,
          lastUpdate: 200,
          steps: [{ agent: "worker", status: "complete" }],
        }),
      );
      rememberOwnedRun(state, {
        runId,
        ownerSessionId: ctx.sessionManager.getSessionId(),
        source: "async",
        mode: "single",
        cwd: path.join(tempDir, "other-worktree"),
        task: "Background work",
        startedAt: 100,
        rootRunId: runId,
        asyncDir,
        children: [{ agent: "worker", index: 0 }],
      });
      const emitted = events.emitted.length;
      const status = await executor.execute({
        toolCallId: "discover-owned",
        params: { action: "status" },
        signal: new AbortController().signal,
        onUpdate: undefined,
        ctx,
      });
      const text = status.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      assert.equal(status.isError, undefined);
      assert.match(text, /another-live-run/);
      assert.match(text, /Saved foreground evidence/);
      assert.ok(text.includes(requireText(completed.details.runId)));
      assert.ok(text.includes(runId));
      assert.equal(status.details.managementControls?.length, 3);
      assert.equal(
        status.details.managementControl?.runId,
        "another-live-run",
        "keep the existing primary control field",
      );
      assert.ok(
        events.emitted
          .slice(emitted)
          .every((event) => event.channel === "subagent:intercom-health-request"),
        "discovery only reads health; it does not redeliver or adopt runs",
      );
    } finally {
      fs.rmSync(asyncDir, { recursive: true, force: true });
    }
  });

  it("nudge action rejects child indexes with no live owner child", async () => {
    const { executor, state } = await makeExecutor({ acknowledgeLive: true });
    saveRunStatus("fg-nudge", {
      runtimeVersion: 2,
      runId: "fg-nudge",
      mode: "parallel",
      state: "running",
      pid: process.pid,
      startedAt: Date.now(),
      steps: [{ agent: "worker", status: "running" }],
    });
    rememberOwnedRun(state, {
      runId: "fg-nudge",
      rootRunId: "fg-nudge",
      asyncDir: getRunMetadataDir("fg-nudge"),
      ownerSessionId: "session-123",
      source: "async",
      mode: "parallel",
      cwd: tempDir,
      task: "Active work",
      startedAt: 100,
      children: [{ agent: "worker", index: 0 }],
    });

    const result = await executor.execute({
      toolCallId: "nudge-foreground-wrong-index",
      params: { action: "nudge", id: "fg-nudge", index: 1, message: "ping" },
      signal: new AbortController().signal,
      onUpdate: undefined,
      ctx: makeMinimalCtx(tempDir),
    });

    assert.equal(result.isError, true);
    assert.match(textAt(result.content), /has 0 matching live children/);
  });

  it("status action includes live intercom health when the bridge responds", async () => {
    const runId = `health-live-${Date.now()}`;
    const asyncDir = path.join(ASYNC_DIR, runId);
    const target = `subagent-worker-${runId}-1`;
    try {
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(
          {
            runId,
            mode: "single",
            state: "running",
            startedAt: 100,
            lastUpdate: 100,
            steps: [{ agent: "worker", status: "running" }],
          },
          null,
          2,
        ),
        "utf-8",
      );
      const { executor, events } = await makeExecutor({
        health: [
          {
            target,
            status: "registered",
            sessionStatus: "idle",
            acceptsAsks: true,
            pendingAsks: 0,
          },
        ],
      });

      const result = await executor.execute({
        toolCallId: "status-health",
        params: { action: "status", id: runId },
        signal: new AbortController().signal,
        onUpdate: undefined,
        ctx: makeMinimalCtx(tempDir),
      });

      assert.equal(result.isError, undefined);
      assert.match(
        textAt(result.content),
        /Intercom: registered, idle, accepts_asks:true, pending_asks:0/,
      );
      assert.equal(
        events.emitted.some((entry) => entry.channel === "subagent:intercom-health-request"),
        true,
      );
    } finally {
      fs.rmSync(asyncDir, { recursive: true, force: true });
    }
  });

  it("status action includes durable owner intercom health without a host tracker", async () => {
    const target = "subagent-worker-fg-health-1";
    const { executor, state, events } = await makeExecutor({
      health: [
        {
          target,
          status: "registered",
          sessionStatus: "tool:edit",
          acceptsAsks: false,
          pendingAsks: 1,
        },
      ],
    });
    saveRunStatus("fg-health", {
      runtimeVersion: 2,
      runId: "fg-health",
      mode: "single",
      state: "running",
      pid: process.pid,
      startedAt: Date.now(),
      steps: [{ agent: "worker", status: "running" }],
    });
    rememberOwnedRun(state, {
      runId: "fg-health",
      rootRunId: "fg-health",
      asyncDir: getRunMetadataDir("fg-health"),
      ownerSessionId: "session-123",
      source: "async",
      mode: "single",
      cwd: tempDir,
      task: "Active work",
      startedAt: 100,
      children: [{ agent: "worker", index: 0 }],
    });

    const result = await executor.execute({
      toolCallId: "status-foreground-health",
      params: { action: "status", id: "fg-health" },
      signal: new AbortController().signal,
      onUpdate: undefined,
      ctx: makeMinimalCtx(tempDir),
    });

    assert.equal(result.isError, undefined);
    assert.match(
      textAt(result.content),
      /Intercom: registered, tool:edit, accepts_asks:false, pending_asks:1/,
    );
    assert.equal(
      events.emitted.some((entry) => entry.channel === "subagent:intercom-health-request"),
      true,
    );
  });

  it("resume action revives completed multi-child async runs by index", async () => {
    mockPi.onCall({ output: "revived async child b" });
    const runId = `resume-revive-multi-${Date.now()}`;
    const asyncDir = path.join(ASYNC_DIR, runId);
    const firstSession = path.join(tempDir, "child-a.jsonl");
    const secondSession = path.join(tempDir, "child-b.jsonl");
    const effectiveAcceptance = {
      level: "checked",
      explicit: true,
      inferredReason: ["explicit acceptance contract"],
      criteria: [
        {
          id: "criterion-1",
          must: "Original async acceptance",
          evidence: [],
          severity: "required",
        },
      ],
      evidence: [],
      verify: [],
      stopRules: [],
      finalization: { mode: "self-review-loop", maxTurns: 1 },
    };
    try {
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.writeFileSync(firstSession, "", "utf-8");
      fs.writeFileSync(secondSession, "", "utf-8");
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(
          {
            runId,
            mode: "parallel",
            state: "complete",
            startedAt: 100,
            lastUpdate: 200,
            cwd: tempDir,
            steps: [
              { agent: "a", status: "complete", sessionFile: firstSession },
              {
                agent: "b",
                status: "complete",
                sessionFile: secondSession,
                acceptance: {
                  status: "rejected",
                  explicit: true,
                  effectiveAcceptance,
                  inferredReason: effectiveAcceptance.inferredReason,
                  criteria: effectiveAcceptance.criteria,
                  runtimeChecks: [],
                  verifyRuns: [],
                },
              },
            ],
          },
          null,
          2,
        ),
        "utf-8",
      );
      const { executor } = await makeExecutor({ agents: [makeAgent("a"), makeAgent("b")] });

      const result = await executor.execute({
        toolCallId: "resume-revive-multi",
        params: { action: "resume", id: runId, index: 1, agent: "b", message: "What did b find?" },
        signal: new AbortController().signal,
        onUpdate: undefined,
        ctx: makeMinimalCtx(tempDir),
      });

      assert.equal(result.isError, undefined, textAt(result.content));
      assert.match(textAt(result.content), /Revived async subagent from/);
      assert.match(textAt(result.content), /Agent: b/);
      assert.match(
        textAt(result.content),
        new RegExp(secondSession.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
      const args = await readMockCallArgs(0);
      assert.equal(args[args.indexOf("--session") + 1], secondSession);
      assert.equal(
        args.some((arg) => arg.includes("Original async acceptance")),
        true,
      );
      const revivedId = result.details.asyncId;
      assert.ok(revivedId !== undefined && revivedId.length > 0, "expected revived async id");
      const resultPath = path.join(RESULTS_DIR, `${revivedId}.json`);
      await waitFor(() => fs.existsSync(resultPath), 10_000);
    } finally {
      fs.rmSync(asyncDir, { recursive: true, force: true });
    }
  });

  it("nested resume inherits the acceptance contract persisted by its async child", async () => {
    const acceptedReport = `done\n\`\`\`acceptance-report\n${JSON.stringify({ criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "done" }], residualRisks: [] })}\n\`\`\``;
    const receiptPath = path.join(tempDir, "nested-native-receipt.json");
    mockPi.onCall({
      nativeReport: {
        scenario: "single",
        initialReport: "nested initial output",
        report: acceptedReport,
        receiptPath,
      },
    });
    const rootRunId = `nested-root-${Date.now().toString(36)}`;
    const nestedRunId = `nested-resume-${Date.now().toString(36)}`;
    const asyncDir = path.join(TEMP_ROOT_DIR, "nested-subagent-runs", rootRunId, nestedRunId);
    const sessionFile = path.join(tempDir, nestedRunId, "session.jsonl");
    const parentSessionFile = path.join(tempDir, "parent.jsonl");
    const route = createNestedRoute(rootRunId);
    const effectiveAcceptance = {
      level: "checked",
      explicit: true,
      inferredReason: ["explicit acceptance contract"],
      criteria: [
        {
          id: "criterion-1",
          must: "Nested inherited criterion",
          evidence: [],
          severity: "required",
        },
      ],
      evidence: [],
      verify: [],
      stopRules: ["Do not publish"],
      finalization: { mode: "self-review-loop", maxTurns: 1 },
    };
    try {
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
      fs.writeFileSync(sessionFile, "", "utf-8");
      fs.writeFileSync(parentSessionFile, "", "utf-8");
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify({
          runId: nestedRunId,
          mode: "single",
          state: "complete",
          startedAt: 100,
          lastUpdate: 200,
          steps: [
            {
              agent: "worker",
              status: "complete",
              sessionFile,
              acceptance: {
                status: "checked",
                explicit: true,
                effectiveAcceptance,
                inferredReason: effectiveAcceptance.inferredReason,
                criteria: effectiveAcceptance.criteria,
                runtimeChecks: [],
                verifyRuns: [],
              },
            },
          ],
        }),
        "utf-8",
      );
      writeNestedEvent(route, {
        type: "subagent.nested.completed",
        ts: Date.now(),
        parentRunId: rootRunId,
        parentStepIndex: 0,
        child: {
          id: nestedRunId,
          parentRunId: rootRunId,
          parentStepIndex: 0,
          depth: 1,
          path: [{ runId: rootRunId, stepIndex: 0 }],
          state: "complete",
          agent: "worker",
          ownerState: "gone",
          asyncDir,
          sessionFile,
        },
      });
      const { executor, state } = await makeExecutor({ acknowledgeResults: false });
      rememberOwnedRun(state, {
        runId: rootRunId,
        rootRunId,
        ownerSessionId: "session-123",
        source: "async",
        mode: "single",
        cwd: tempDir,
        task: "Nested owner",
        startedAt: 1,
        children: [],
      });
      const testCtx = makeMinimalCtx(tempDir);
      testCtx.sessionManager.getSessionFile = () => parentSessionFile;

      const result = await executor.execute({
        toolCallId: "nested-resume-inherits-acceptance",
        params: {
          action: "resume",
          id: nestedRunId,
          agent: "worker",
          message: "Finish the nested work",
        },
        signal: new AbortController().signal,
        onUpdate: undefined,
        ctx: testCtx,
      });

      assert.equal(result.isError, undefined);
      const args = await readMockCallArgs(0);
      assert.equal(
        args.some((arg) => arg.includes("Nested inherited criterion")),
        true,
      );
      assert.equal(
        args.some((arg) => arg.includes("Do not publish")),
        true,
      );
      const revivedId = result.details.asyncId;
      assert.ok(
        revivedId !== undefined && revivedId.length > 0,
        "expected revived nested async id",
      );
      const resultPath = path.join(RESULTS_DIR, `${revivedId}.json`);
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(resultPath)) {
        if (Date.now() > deadline) {
          assert.fail(`Timed out waiting for revived nested result file: ${resultPath}`);
        }
        // This result is published atomically by the resumed child; poll publication before reading it.
        // oxlint-disable-next-line no-await-in-loop
        await sleep(50);
      }
      const payload = json(fs.readFileSync(resultPath, "utf-8"));
      const savedResult = record(records(payload.results)[0]);
      const savedAcceptance = record(savedResult.acceptance);
      const savedEffectiveAcceptance = record(savedAcceptance.effectiveAcceptance);
      assert.equal(payload.success, true);
      assert.equal(savedAcceptance.status, "checked");
      assert.equal(
        record(records(savedEffectiveAcceptance.criteria)[0]).must,
        "Nested inherited criterion",
      );
      assert.deepEqual(savedEffectiveAcceptance.stopRules, ["Do not publish"]);
      assert.equal(record(savedEffectiveAcceptance.finalization).maxTurns, 1);
      assert.equal(mockPi.callCount(), 1);
      const receipt = json(fs.readFileSync(receiptPath, "utf-8"));
      assert.equal(receipt.providerCalls, 2);
      assert.equal(fs.realpathSync(requireText(receipt.sessionFile)), fs.realpathSync(sessionFile));
      assert.equal(receipt.networkRequests, 0);
      assert.deepEqual(receipt.extensionErrors, []);
    } finally {
      fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
      fs.rmSync(asyncDir, { recursive: true, force: true });
    }
  });

  for (const asyncMode of [false, true]) {
    it(`questions preserve launch-time acceptance through ${asyncMode ? "background" : "foreground"} child death and answer revival`, async () => {
      mockPi.onCall({ delay: 60_000, output: "unfinished" });
      const report =
        '```acceptance-report\n{"criteriaSatisfied":[{"id":"criterion-1","status":"satisfied","evidence":"fixture"}]}\n```';
      mockPi.onCall({
        nativeReport: {
          scenario: "single",
          initialReport: `Answered with original acceptance\n${report}`,
          report: `Final validation\n${report}`,
          publicOutput: { answer: "stable" },
          finalAnswer: { answer: "stable" },
          receiptPath: path.join(tempDir, "native.json"),
        },
      });
      const ctx = makeMinimalCtx(tempDir);
      const parentSession = path.join(tempDir, "supervisor.jsonl");
      fs.writeFileSync(parentSession, "");
      ctx.sessionManager.getSessionFile = () => parentSession;
      const { executor } = await makeExecutor();
      const outputPath = path.join(tempDir, "required-report.md");
      const outputSchema = {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
      };
      const running = executor.execute({
        toolCallId: "launch-contract",
        params: {
          agent: "worker",
          task: "Wait for a decision",
          async: asyncMode,
          output: outputPath,
          outputSchema,
          outputMode: "file-only",
          acceptance: {
            criteria: ["Keep the original contract"],
            verify: [{ id: "must-fail", command: "exit 23" }],
            maxFinalizationTurns: 1,
          },
        },
        signal: undefined,
        onUpdate: undefined,
        ctx,
      });
      const args = await readMockCallArgs(0);
      const callFile = fs.readdirSync(mockPi.dir).find((name) => /^call-.*\.json$/.test(name));
      assertDefined(callFile);
      const match = callFile.match(/^call-\d+-(\d+)-/);
      assertDefined(match);
      const pid = Number(match[1]);
      const sessionFile = args[args.indexOf("--session") + 1];
      const runId = path.basename(path.dirname(path.dirname(sessionFile)));
      assert.ok(runId.length > 0, sessionFile);
      const question = createSupervisorQuestion({
        runId,
        ownerTarget: "orchestrator",
        agent: "worker",
        index: 0,
        childSessionId: "contract-child",
        childTarget: "contract-child",
        sessionFile,
        cwd: tempDir,
        pid,
        reason: "need_decision",
        message: "Which API?",
      });
      try {
        assert.equal(question.effectiveAcceptance?.verify[0]?.command, "exit 23");
        assert.equal(question.ownerSessionId, ctx.sessionManager.getSessionId());
        assert.equal(question.output, outputPath);
        assert.deepEqual(question.outputSchema, outputSchema);
      } finally {
        process.kill(pid, "SIGTERM");
        await waitFor(() => !questionProcessAlive(question));
        await running;
      }
      const { executor: reloaded } = await makeExecutor();
      const answer = await reloaded.execute({
        toolCallId: "answer-contract",
        params: {
          action: "answer",
          id: runId,
          questionId: question.questionId,
          message: "Use stable.",
        },
        signal: undefined,
        onUpdate: undefined,
        ctx,
      });
      assert.equal(answer.isError, undefined, textAt(answer.content));
      const resultPath = path.join(RESULTS_DIR, `${requireText(answer.details.asyncId)}.json`);
      await waitFor(() => fs.existsSync(resultPath), 10_000);
      const result = json(fs.readFileSync(resultPath, "utf8"));
      const savedResult = record(records(result.results)[0]);
      const savedAcceptance = record(savedResult.acceptance);
      const savedEffectiveAcceptance = record(savedAcceptance.effectiveAcceptance);
      assert.equal(result.success, false);
      assert.equal(
        record(records(savedEffectiveAcceptance.criteria)[0]).must,
        "Keep the original contract",
      );
      assert.equal(record(records(savedAcceptance.verifyRuns)[0]).exitCode, 23);
      assert.deepEqual(savedResult.structuredOutput, { answer: "stable" });
      assert.equal(fs.readFileSync(outputPath, "utf8"), '{"answer":"stable"}');
      assert.equal(
        json(fs.readFileSync(requireText(record(savedResult.artifactPaths).metadataPath), "utf8"))
          .initialOutput,
        "Answered with original acceptance",
      );
    });
  }

  for (const registered of [false, true]) {
    it(`continue recovers a pre-launch answer claim and refuses an uncertain launch (${registered ? "registered" : "missing"} original run)`, async () => {
      const ctx = makeMinimalCtx(tempDir);
      const runId = `claim-recovery-${Date.now()}`;
      const sessionFile = path.join(tempDir, "claim-session.jsonl");
      fs.writeFileSync(sessionFile, "");
      saveQuestionOwner(runId, ctx.sessionManager.getSessionId());
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
      });
      assert.ok(child.pid !== undefined && child.pid > 0);
      const question = createSupervisorQuestion({
        runId,
        ownerTarget: "orchestrator",
        agent: "worker",
        index: 0,
        childSessionId: "claim-child",
        childTarget: "claim-child",
        sessionFile,
        cwd: tempDir,
        pid: child.pid,
        reason: "need_decision",
        message: "Which API?",
      });
      const exited = once(child, "exit");
      child.kill();
      await exited;
      const moduleUrl = new URL("../../src/runs/shared/supervisor-questions.ts", import.meta.url)
        .href;
      const claimed = spawnSync(process.execPath, [
        "--input-type=module",
        "-e",
        `const q = await import(${JSON.stringify(moduleUrl)}); q.saveQuestionAnswer(${JSON.stringify(question)}, "Stable API"); q.claimQuestionRevival(${JSON.stringify(question)});`,
      ]);
      assert.equal(claimed.status, 0, claimed.stderr.toString());
      // executeAsyncSingle can create an empty run directory before a launch exists.
      const continuationDir = path.join(ASYNC_DIR, `answer-${question.questionId}`);
      fs.mkdirSync(continuationDir, { recursive: true });
      if (registered) {
        fs.mkdirSync(path.join(ASYNC_DIR, runId), { recursive: true });
        fs.writeFileSync(
          path.join(ASYNC_DIR, runId, "status.json"),
          JSON.stringify({
            runId,
            mode: "single",
            state: "failed",
            startedAt: 1,
            lastUpdate: 2,
            cwd: tempDir,
            sessionFile,
            steps: [{ agent: "worker", status: "failed", sessionFile }],
          }),
        );
      }
      const { executor } = await makeExecutor();
      const repeat = await executor.execute({
        toolCallId: "claim-repeat",
        params: {
          action: "answer",
          id: runId,
          questionId: question.questionId,
          message: "Stable API",
        },
        signal: undefined,
        onUpdate: undefined,
        ctx,
      });
      assert.equal(
        fs.readdirSync(mockPi.dir).some((name) => name.startsWith("call-")),
        false,
      );
      fs.writeFileSync(
        path.join(continuationDir, "status.json"),
        JSON.stringify({ runId: `answer-${question.questionId}`, state: "running" }),
      );
      const uncertain = await executor.execute({
        toolCallId: "uncertain-continue",
        params: { action: "resume", id: runId, message: "Continue with the saved answer." },
        signal: undefined,
        onUpdate: undefined,
        ctx,
      });
      assert.equal(uncertain.isError, true, "uncertain continuation must not launch again");
      assert.match(textAt(uncertain.content), /may already have launched/);
      assert.equal(mockPi.callCount(), 0);
      fs.rmSync(path.join(continuationDir, "status.json"));
      const continued = await executor.execute({
        toolCallId: "claim-continue",
        params: {
          action: "resume",
          id: runId,
          agent: "worker",
          message: "Continue with the saved answer.",
        },
        signal: undefined,
        onUpdate: undefined,
        ctx,
      });
      assert.equal(continued.isError, undefined, textAt(continued.content));
      assert.match(textAt(repeat.content), /action: "continue"/);
      await waitFor(
        () =>
          fs.existsSync(path.join(RESULTS_DIR, `${requireText(continued.details.asyncId)}.json`)),
        10_000,
      );
      assert.ok((await readMockCallArgs(0)).some((arg) => arg.includes("Stable API")));
    });
  }

  it("durable question survives a fresh supervisor and child exit, then answers via one saved-session revival", async () => {
    mockPi.onCall({ output: "continued with the saved answer" });
    const ctx = makeMinimalCtx(tempDir);
    const runId = `question-revive-${Date.now()}`;
    const sessionFile = path.join(tempDir, "question-child.jsonl");
    fs.writeFileSync(
      sessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: "saved-question-child", cwd: tempDir })}\n`,
    );
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    assert.ok(child.pid !== undefined && child.pid > 0);
    saveQuestionOwner(runId, ctx.sessionManager.getSessionId());
    const question = createSupervisorQuestion({
      runId,
      ownerTarget: "orchestrator",
      agent: "worker",
      index: 0,
      childSessionId: "saved-question-child",
      childTarget: `subagent-worker-${runId}-1`,
      sessionFile,
      cwd: tempDir,
      pid: child.pid,
      reason: "need_decision",
      message: "Which API should I use?",
    });
    const exited = once(child, "exit");
    child.kill();
    await exited;
    const { executor } = await makeExecutor();
    const listed = await executor.execute({
      toolCallId: "after-reload",
      params: { action: "status" },
      signal: undefined,
      onUpdate: undefined,
      ctx,
    });
    assert.equal(
      listed.details.questions?.find((entry) => entry.questionId === question.questionId)?.state,
      "awaiting_input",
    );
    const inspected = await executor.execute({
      toolCallId: "inspect-question",
      params: { action: "status", id: runId },
      signal: undefined,
      onUpdate: undefined,
      ctx,
    });
    assert.equal(inspected.isError, false);
    assert.match(JSON.stringify(inspected.content), /awaiting_input/);
    const answerParams = {
      action: "answer",
      id: runId,
      agent: "worker",
      questionId: question.questionId,
      message: "Use the stable API.",
    };
    const first = await executor.execute({
      toolCallId: "answer-question",
      params: answerParams,
      signal: undefined,
      onUpdate: undefined,
      ctx,
    });
    assert.equal(first.isError, undefined, textAt(first.content));
    const revivedId = first.details.asyncId;
    assert.ok(revivedId !== undefined && revivedId.length > 0);
    const { executor: reloaded } = await makeExecutor();
    const repeated = await reloaded.execute({
      toolCallId: "repeat-answer",
      params: answerParams,
      signal: undefined,
      onUpdate: undefined,
      ctx,
    });
    assert.match(textAt(repeated.content), /already answered; no new work/);
    assert.equal(repeated.details.questions?.[0]?.delivery?.runId, revivedId);
    await waitFor(() => fs.existsSync(path.join(RESULTS_DIR, `${revivedId}.json`)), 10_000);
    const args = await readMockCallArgs(0);
    assert.equal(args[args.indexOf("--session") + 1], sessionFile);
    assert.ok(
      args.some((arg) => arg.includes(question.questionId) && arg.includes("Use the stable API.")),
    );
    assert.equal(
      fs.readdirSync(mockPi.dir).filter((name) => /^call-.*\.json$/.test(name)).length,
      1,
    );
    const cancelledQuestion = createSupervisorQuestion({
      ...question,
      message: "Another decision?",
    });
    const stopped = await reloaded.execute({
      toolCallId: "stop-exited-question",
      params: { action: "interrupt", id: runId },
      signal: undefined,
      onUpdate: undefined,
      ctx,
    });
    assert.equal(stopped.isError, undefined);
    assert.equal(stopped.details.questions?.[0]?.state, "cancelled");
    const cancelledAnswer = await reloaded.execute({
      toolCallId: "answer-stopped",
      params: { ...answerParams, questionId: cancelledQuestion.questionId },
      signal: undefined,
      onUpdate: undefined,
      ctx,
    });
    assert.equal(cancelledAnswer.isError, true);
    assert.match(textAt(cancelledAnswer.content), /cancelled/);
  });

  it("resume action revives completed async runs with no-poll handoff guidance", async () => {
    mockPi.onCall({ output: "revived answer" });
    const runId = `resume-revive-${Date.now()}`;
    const asyncDir = path.join(ASYNC_DIR, runId);
    const sessionFile = path.join(tempDir, "child-session.jsonl");
    try {
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.writeFileSync(sessionFile, "", "utf-8");
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(
          {
            runId,
            mode: "single",
            state: "complete",
            startedAt: 100,
            lastUpdate: 200,
            cwd: tempDir,
            sessionFile,
            steps: [{ agent: "worker", status: "complete" }],
          },
          null,
          2,
        ),
        "utf-8",
      );
      const { executor } = await makeExecutor();

      const result = await executor.execute({
        toolCallId: "resume-revive",
        params: {
          action: "resume",
          id: runId,
          agent: "worker",
          message: "What changed?",
          acceptance: { criteria: ["Resume override contract"] },
        },
        signal: new AbortController().signal,
        onUpdate: undefined,
        ctx: makeMinimalCtx(tempDir),
      });

      assert.equal(result.isError, undefined);
      assert.match(textAt(result.content), /Revived async subagent from/);
      assert.match(textAt(result.content), /Do not run sleep timers or polling loops/);
      assert.match(textAt(result.content), /end your turn now/);
      assert.match(textAt(result.content), /Status if needed: agent_runs\(\{ action: "inspect"/);
      assert.match(textAt(result.content), new RegExp(`Run mapping: ${runId} ->`));
      assert.match(textAt(result.content), /Prior pending-reply context .* is invalid/);
      assert.doesNotMatch(textAt(result.content), /Follow:/);
      const revivedId = result.details.asyncId;
      assert.equal(result.details.managementControl?.revivedFromRunId, runId);
      assert.equal(result.details.managementControl.pendingReplyContextValid, false);
      assert.deepEqual(result.details.managementControl.capabilities, ["status", "interrupt"]);
      assert.ok(revivedId !== undefined && revivedId.length > 0, "expected revived async id");
      const resultPath = path.join(RESULTS_DIR, `${revivedId}.json`);
      await waitFor(() => fs.existsSync(resultPath), 10_000);
      const args = await readMockCallArgs(0);
      assert.equal(
        args.some((arg) => arg.includes("Resume override contract")),
        true,
      );
      const payload = json(fs.readFileSync(resultPath, "utf-8"));
      const savedResult = record(records(payload.results)[0]);
      const savedAcceptance = record(savedResult.acceptance);
      const savedEffectiveAcceptance = record(savedAcceptance.effectiveAcceptance);
      assert.equal(savedEffectiveAcceptance.explicit, true);
      assert.notEqual(savedAcceptance.status, "not-required");
    } finally {
      fs.rmSync(asyncDir, { recursive: true, force: true });
    }
  });

  it("status action reports remembered foreground runs after child completion", async () => {
    const session = path.join(tempDir, "remembered-foreground.jsonl");
    fs.writeFileSync(session, "", "utf-8");
    const { executor, state } = await makeExecutor({
      acknowledgeResults: false,
      agents: [makeAgent("a"), makeAgent("b")],
    });
    state.foregroundRuns.set("remembered-status-run", {
      runId: "remembered-status-run",
      mode: "parallel",
      cwd: tempDir,
      updatedAt: Date.parse("2026-06-16T12:00:00.000Z"),
      children: [
        { agent: "a", index: 0, status: "completed", sessionFile: session },
        {
          agent: "b",
          index: 1,
          status: "timed-out",
          sessionFile: session,
          summary: "Detached child timed out",
        },
      ],
    });

    const result = await executor.execute({
      toolCallId: "remembered-foreground-status",
      params: { action: "status", id: "remembered-status" },
      signal: new AbortController().signal,
      onUpdate: undefined,
      ctx: makeMinimalCtx(tempDir),
    });

    assert.equal(result.isError, undefined);
    const text = textAt(result.content);
    assert.match(text, /Run: remembered-status-run/);
    assert.match(text, /State: remembered foreground/);
    assert.match(text, /1\. a completed, session:/);
    assert.match(text, /2\. b timed-out, session: .*final: Detached child timed out/);
    assert.match(
      text,
      /Continue child: agent_runs\(\{ action: "continue", id: "remembered-status-run", index: 0, message: "\.\.\." \}\)/,
    );
    assert.doesNotMatch(text, /Async run not found/);
    assert.equal(result.details.managementControl?.state, "failed");
    assert.equal(result.details.managementControl.capabilities.includes("nudge"), false);

    const nudge = await executor.execute({
      toolCallId: "remembered-foreground-nudge",
      params: { action: "nudge", id: "remembered-status-run" },
      signal: new AbortController().signal,
      onUpdate: undefined,
      ctx: makeMinimalCtx(tempDir),
    });
    assert.equal(nudge.isError, undefined);
    assert.match(textAt(nudge.content), /already failed/);
    assert.match(textAt(nudge.content), /Detached child timed out/);
    assert.match(
      textAt(nudge.content),
      /action: "continue", id: "remembered-status-run", index: 0/,
    );
    assert.match(textAt(nudge.content), /action: "inspect", id: "remembered-status-run"/);
    assert.equal(nudge.details.managementControl?.capabilities.includes("nudge"), false);
  });

  it("status never infers detached completion from an earlier assistant answer", async () => {
    const session = path.join(tempDir, "remembered-detached-complete.jsonl");
    fs.writeFileSync(
      session,
      [
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                name: "contact_supervisor",
                arguments: { reason: "need_decision", message: "Pick one" },
              },
            ],
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "UPDATED_DETACH_SMOKE_DONE reply=alpha" }],
          },
        }),
      ].join("\n"),
      "utf-8",
    );
    const { executor, state } = await makeExecutor({
      acknowledgeResults: false,
      agents: [makeAgent("a")],
    });
    state.foregroundRuns.set("detached-complete-run", {
      runId: "detached-complete-run",
      mode: "single",
      cwd: tempDir,
      updatedAt: Date.parse("2026-06-16T12:00:00.000Z"),
      children: [{ agent: "a", index: 0, status: "detached", sessionFile: session }],
    });

    const result = await executor.execute({
      toolCallId: "remembered-detached-complete-status",
      params: { action: "status", id: "detached-complete" },
      signal: new AbortController().signal,
      onUpdate: undefined,
      ctx: makeMinimalCtx(tempDir),
    });

    assert.equal(result.isError, undefined);
    const text = textAt(result.content);
    assert.match(text, /1\. a detached, session:/);
    assert.doesNotMatch(text, /final: UPDATED_DETACH_SMOKE_DONE/);
    assert.equal(result.details.managementControl?.state, "unknown");
    assert.match(text, /Completion unconfirmed/);
    assert.match(text, /action: "questions"/);
  });

  it("status action accepts latest alias for remembered foreground runs", async () => {
    const session = path.join(tempDir, "remembered-latest.jsonl");
    fs.writeFileSync(session, "", "utf-8");
    const { executor, state } = await makeExecutor({
      acknowledgeResults: false,
      agents: [makeAgent("a")],
    });
    state.foregroundRuns.set("older-foreground", {
      runId: "older-foreground",
      mode: "single",
      cwd: tempDir,
      updatedAt: 100,
      children: [{ agent: "a", index: 0, status: "completed", sessionFile: session }],
    });
    state.foregroundRuns.set("newer-foreground", {
      runId: "newer-foreground",
      mode: "single",
      cwd: tempDir,
      updatedAt: 200,
      children: [{ agent: "a", index: 0, status: "completed", sessionFile: session }],
    });

    const result = await executor.execute({
      toolCallId: "remembered-foreground-latest-status",
      params: { action: "status", id: "latest" },
      signal: new AbortController().signal,
      onUpdate: undefined,
      ctx: makeMinimalCtx(tempDir),
    });

    assert.equal(result.isError, undefined);
    assert.match(textAt(result.content), /Run: newer-foreground/);
  });

  it("resume action revives a completed foreground child by index", async () => {
    mockPi.onCall({ output: "first child done" });
    mockPi.onCall({ output: "second child done" });
    mockPi.onCall({ output: "revived foreground answer" });
    const { executor } = await makeExecutor({
      acknowledgeResults: false,
      agents: [makeAgent("a"), makeAgent("b")],
    });

    const original = await executor.execute({
      toolCallId: "foreground-resume-original",
      params: {
        tasks: [
          { agent: "a", task: "task-a" },
          { agent: "b", task: "task-b" },
        ],
      },
      signal: new AbortController().signal,
      onUpdate: undefined,
      ctx: makeMinimalCtx(tempDir),
    });
    const runId = original.details.runId;
    assert.ok(runId !== undefined && runId.length > 0, "expected foreground run id");

    const revived = await executor.execute({
      toolCallId: "foreground-resume",
      params: { action: "resume", id: runId, index: 1, message: "Follow up with b" },
      signal: new AbortController().signal,
      onUpdate: undefined,
      ctx: makeMinimalCtx(tempDir),
    });

    assert.equal(revived.isError, undefined);
    assert.match(textAt(revived.content), /Revived async subagent from/);
    assert.match(textAt(revived.content), /Agent: b/);
    const reviveArgs = await readMockCallArgs(2);
    const selectedSession = original.details.results.at(1)?.sessionFile;
    assert.ok(
      selectedSession !== undefined && selectedSession.length > 0,
      "expected selected child session file",
    );
    assert.equal(reviveArgs[reviveArgs.indexOf("--session") + 1], selectedSession);
    const revivedId = revived.details.asyncId;
    assert.ok(revivedId !== undefined && revivedId.length > 0, "expected revived async id");
    const resultPath = path.join(RESULTS_DIR, `${revivedId}.json`);
    await waitFor(() => fs.existsSync(resultPath), 10_000);
  });

  it("timeout resume preserves acceptance and accepts a validation-only continuation", async () => {
    mockPi.onCall({
      steps: [
        {
          jsonl: [
            mockEvents.toolStart("edit", { path: "src/incident.ts" }),
            mockEvents.toolEnd("edit"),
            mockEvents.toolResult("edit", "applied prior work"),
          ],
        },
        { delay: 10_000, jsonl: [mockEvents.assistantMessage("late completion")] },
      ],
    });
    const report =
      '```acceptance-report\n{"criteriaSatisfied":[{"id":"criterion-1","status":"satisfied","evidence":"validated existing work"}],"changedFiles":["src/incident.ts"]}\n```';
    mockPi.onCall({
      nativeReport: {
        scenario: "single",
        initialReport: `Validated prior edits without a new edit.\n${report}`,
        report: `Validation complete.\n${report}`,
        receiptPath: path.join(tempDir, "native.json"),
      },
    });
    const { executor } = await makeExecutor({ acknowledgeResults: false });
    const acceptance: AcceptanceConfig = {
      criteria: [{ id: "criterion-1", must: "Validate and finish the implementation" }],
      evidence: ["changed-files"],
      verify: [
        {
          id: "resume-verify",
          command: `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
        },
      ],
      maxFinalizationTurns: 1,
    };

    const original = await executor.execute({
      toolCallId: "foreground-timeout-resume-original",
      params: { agent: "worker", task: "Implement the incident fix", timeoutMs: 1_000, acceptance },
      signal: new AbortController().signal,
      onUpdate: undefined,
      ctx: makeMinimalCtx(tempDir),
    });
    const originalChild = original.details.results[0];
    assertDefined(originalChild);
    assertDefined(originalChild.acceptance);
    const runId = original.details.runId;
    assert.ok(runId !== undefined && runId.length > 0, "expected foreground run id");
    assert.equal(originalChild.timedOut, true);
    assert.notEqual(originalChild.acceptance.status, "not-required");
    assert.equal(originalChild.acceptance.effectiveAcceptance.explicit, true);
    assert.deepEqual(
      originalChild.acceptance.effectiveAcceptance.verify.map((entry) => entry.id),
      ["resume-verify"],
    );

    const resumed = await executor.execute({
      toolCallId: "foreground-timeout-resume",
      params: {
        action: "resume",
        id: runId,
        message: "Format, validate, and commit the work already created before timeout.",
      },
      signal: new AbortController().signal,
      onUpdate: undefined,
      ctx: makeMinimalCtx(tempDir),
    });
    assert.equal(resumed.isError, undefined);
    const revivedId = resumed.details.asyncId;
    assert.ok(revivedId !== undefined && revivedId.length > 0, "expected revived async id");
    const resultPath = path.join(RESULTS_DIR, `${revivedId}.json`);
    await waitFor(() => fs.existsSync(resultPath), 10_000);
    const payload = json(fs.readFileSync(resultPath, "utf-8"));
    const savedResult = record(records(payload.results)[0]);
    const savedAcceptance = record(savedResult.acceptance);
    const savedEffectiveAcceptance = record(savedAcceptance.effectiveAcceptance);
    assert.equal(payload.success, true);
    assert.equal(record(records(payload.results)[0]).success, true);
    assert.notEqual(savedAcceptance.status, "not-required");
    assert.equal(savedEffectiveAcceptance.explicit, true);
    assert.deepEqual(
      records(savedEffectiveAcceptance.verify).map((entry) => entry.id),
      ["resume-verify"],
    );
    assert.doesNotMatch(
      requireText(record(records(payload.results)[0]).error ?? ""),
      /completed without making edits/,
    );
    const resumedArgs = await readMockCallArgs(1);
    assert.equal(
      resumedArgs.some((arg) => arg.includes("## Acceptance Contract")),
      true,
    );
    assert.doesNotMatch(
      fs.readFileSync(path.join(getRunMetadataDir(revivedId), "events.jsonl"), "utf-8"),
      /"reason":"completion_guard"/,
    );
  });

  it("exhausted self-review persists the full contract and resume runs the inherited verify", async () => {
    const failingReport = [
      "still not done",
      "```acceptance-report",
      JSON.stringify({
        criteriaSatisfied: [{ id: "criterion-1", status: "not-satisfied", evidence: "missing" }],
        changedFiles: ["src/incident.ts"],
        residualRisks: ["not finished"],
      }),
      "```",
    ].join("\n");
    mockPi.onCall({
      nativeReport: {
        scenario: "single",
        initialReport: failingReport,
        report: failingReport,
        receiptPath: path.join(tempDir, "native-failed.json"),
      },
    });
    const successfulReport = failingReport.replaceAll("not-satisfied", "satisfied");
    mockPi.onCall({
      nativeReport: {
        scenario: "single",
        initialReport: successfulReport,
        report: successfulReport,
        receiptPath: path.join(tempDir, "native-resumed.json"),
      },
    });
    const { executor } = await makeExecutor({ acknowledgeResults: false });
    const acceptance: AcceptanceConfig = {
      criteria: [{ id: "criterion-1", must: "Finish the incident fix" }],
      evidence: ["changed-files"],
      verify: [
        {
          id: "exhaust-verify",
          command: `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
        },
      ],
      maxFinalizationTurns: 1,
    };

    const original = await executor.execute({
      toolCallId: "foreground-exhaust-original",
      params: { agent: "worker", task: "Implement the incident fix", acceptance },
      signal: new AbortController().signal,
      onUpdate: undefined,
      ctx: makeMinimalCtx(tempDir),
    });
    const originalChild = original.details.results[0];
    assertDefined(originalChild);
    assertDefined(originalChild.acceptance);
    const runId = original.details.runId;
    assert.ok(runId !== undefined && runId.length > 0, "expected foreground run id");
    assert.equal(originalChild.exitCode, 1);
    assert.equal(originalChild.acceptance.status, "rejected");
    assert.equal(originalChild.acceptance.finalization?.status, "failed");
    assert.equal(originalChild.acceptance.effectiveAcceptance.explicit, true);
    assert.deepEqual(
      originalChild.acceptance.effectiveAcceptance.verify.map((entry) => entry.id),
      ["exhaust-verify"],
    );
    assert.equal(originalChild.acceptance.effectiveAcceptance.finalization.maxTurns, 1);

    const resumed = await executor.execute({
      toolCallId: "foreground-exhaust-resume",
      params: {
        action: "resume",
        id: runId,
        message: "Repair the remaining criterion and finish.",
      },
      signal: new AbortController().signal,
      onUpdate: undefined,
      ctx: makeMinimalCtx(tempDir),
    });
    assert.equal(resumed.isError, undefined);
    const revivedId = resumed.details.asyncId;
    assert.ok(revivedId !== undefined && revivedId.length > 0, "expected revived async id");
    const resultPath = path.join(RESULTS_DIR, `${revivedId}.json`);
    await waitFor(() => fs.existsSync(resultPath), 10_000);
    const payload = json(fs.readFileSync(resultPath, "utf-8"));
    const savedResult = record(records(payload.results)[0]);
    const savedAcceptance = record(savedResult.acceptance);
    const savedEffectiveAcceptance = record(savedAcceptance.effectiveAcceptance);
    assert.equal(payload.success, true);
    assert.equal(savedAcceptance.status, "verified");
    assert.deepEqual(
      records(savedEffectiveAcceptance.verify).map((entry) => entry.id),
      ["exhaust-verify"],
    );
    const verifyRun = records(savedAcceptance.verifyRuns).find(
      (run) => run.id === "exhaust-verify",
    );
    assert.equal(verifyRun?.status, "passed");
    const resumedArgs = await readMockCallArgs(1);
    assert.equal(
      resumedArgs.some((arg) => arg.includes("## Acceptance Contract")),
      true,
    );
  });

  it("resume-supplied acceptance overrides a persisted inherited contract", async () => {
    mockPi.onCall({ output: "override initial output" });
    mockPi.onCall({ output: "override self-review output" });
    const runId = `resume-override-stored-${Date.now()}`;
    const asyncDir = path.join(ASYNC_DIR, runId);
    const sessionFile = path.join(tempDir, "override-child-session.jsonl");
    const storedAcceptance = {
      level: "verified",
      explicit: true,
      inferredReason: ["explicit acceptance contract"],
      criteria: [
        {
          id: "criterion-1",
          must: "Original inherited criterion",
          evidence: [],
          severity: "required",
        },
      ],
      evidence: [],
      verify: [
        {
          id: "original-verify",
          command: `${JSON.stringify(process.execPath)} -e "process.exit(7)"`,
        },
      ],
      stopRules: [],
      finalization: { mode: "self-review-loop", maxTurns: 1 },
    };
    try {
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.writeFileSync(sessionFile, "", "utf-8");
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(
          {
            runId,
            mode: "single",
            state: "complete",
            startedAt: 100,
            lastUpdate: 200,
            cwd: tempDir,
            sessionFile,
            steps: [
              {
                agent: "worker",
                status: "complete",
                sessionFile,
                acceptance: {
                  status: "rejected",
                  explicit: true,
                  effectiveAcceptance: storedAcceptance,
                  inferredReason: storedAcceptance.inferredReason,
                  criteria: storedAcceptance.criteria,
                  runtimeChecks: [],
                  verifyRuns: [],
                },
              },
            ],
          },
          null,
          2,
        ),
        "utf-8",
      );
      const { executor } = await makeExecutor();

      const result = await executor.execute({
        toolCallId: "resume-override-stored",
        params: {
          action: "resume",
          id: runId,
          agent: "worker",
          message: "Redo with new contract",
          acceptance: { criteria: ["Override resume contract"] },
        },
        signal: new AbortController().signal,
        onUpdate: undefined,
        ctx: makeMinimalCtx(tempDir),
      });

      assert.equal(result.isError, undefined);
      const revivedId = result.details.asyncId;
      assert.ok(revivedId !== undefined && revivedId.length > 0, "expected revived async id");
      const resultPath = path.join(RESULTS_DIR, `${revivedId}.json`);
      await waitFor(() => fs.existsSync(resultPath), 10_000);
      const args = await readMockCallArgs(0);
      assert.equal(
        args.some((arg) => arg.includes("Override resume contract")),
        true,
      );
      assert.equal(
        args.some((arg) => arg.includes("Original inherited criterion")),
        false,
      );
      const payload = json(fs.readFileSync(resultPath, "utf-8"));
      const savedResult = record(records(payload.results)[0]);
      const savedAcceptance = record(savedResult.acceptance);
      const savedEffectiveAcceptance = record(savedAcceptance.effectiveAcceptance);
      const revivedAcceptance = savedAcceptance;
      assert.equal(savedEffectiveAcceptance.explicit, true);
      assert.equal(
        record(records(savedEffectiveAcceptance.criteria)[0]).must,
        "Override resume contract",
      );
      assert.deepEqual(savedEffectiveAcceptance.verify, []);
      assert.equal(
        records(revivedAcceptance.verifyRuns).some((run) => run.id === "original-verify"),
        false,
      );
      assert.notEqual(revivedAcceptance.status, "rejected");
    } finally {
      fs.rmSync(asyncDir, { recursive: true, force: true });
    }
  });

  it("malformed persisted acceptance resumes with defaults instead of a TypeError", async () => {
    const receiptPath = path.join(tempDir, "legacy-native-receipt.json");
    mockPi.onCall({
      nativeReport: {
        scenario: "single",
        initialReport: "malformed-recovery initial output",
        report:
          'malformed-recovery self-review output\n```acceptance-report\n{"criteriaSatisfied":[{"id":"criterion-1","status":"satisfied","evidence":"recovered"}]}\n```',
        receiptPath,
      },
    });
    const runId = `resume-malformed-acceptance-${Date.now()}`;
    const asyncDir = path.join(ASYNC_DIR, runId);
    const sessionFile = path.join(tempDir, "malformed-child-session.jsonl");
    try {
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.writeFileSync(sessionFile, "", "utf-8");
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(
          {
            runId,
            mode: "single",
            state: "complete",
            startedAt: 100,
            lastUpdate: 200,
            cwd: tempDir,
            sessionFile,
            steps: [
              {
                agent: "worker",
                status: "complete",
                sessionFile,
                acceptance: {
                  status: "rejected",
                  explicit: true,
                  // Corrupted persisted contract: finalization is missing entirely.
                  effectiveAcceptance: {
                    level: "checked",
                    explicit: true,
                    inferredReason: ["explicit acceptance contract"],
                    criteria: [
                      {
                        id: "criterion-1",
                        must: "Recovered criterion",
                        evidence: [],
                        severity: "required",
                      },
                    ],
                    evidence: [],
                    verify: [],
                    stopRules: [],
                  },
                  inferredReason: ["explicit acceptance contract"],
                  criteria: [
                    {
                      id: "criterion-1",
                      must: "Recovered criterion",
                      evidence: [],
                      severity: "required",
                    },
                  ],
                  runtimeChecks: [],
                  verifyRuns: [],
                },
              },
            ],
          },
          null,
          2,
        ),
        "utf-8",
      );
      const { executor } = await makeExecutor();

      const result = await executor.execute({
        toolCallId: "resume-malformed-acceptance",
        params: { action: "resume", id: runId, agent: "worker", message: "Continue the work" },
        signal: new AbortController().signal,
        onUpdate: undefined,
        ctx: makeMinimalCtx(tempDir),
      });

      assert.equal(result.isError, undefined);
      const revivedId = result.details.asyncId;
      assert.ok(revivedId !== undefined && revivedId.length > 0, "expected revived async id");
      const resultPath = path.join(RESULTS_DIR, `${revivedId}.json`);
      await waitFor(() => fs.existsSync(resultPath), 10_000);
      const payload = json(fs.readFileSync(resultPath, "utf-8"));
      const savedResult = record(records(payload.results)[0]);
      const savedAcceptance = record(savedResult.acceptance);
      const savedEffectiveAcceptance = record(savedAcceptance.effectiveAcceptance);
      assert.equal(savedEffectiveAcceptance.explicit, true);
      assert.equal(
        record(records(savedEffectiveAcceptance.criteria)[0]).must,
        "Recovered criterion",
      );
      assert.equal(payload.success, true);
      assert.equal(savedAcceptance.status, "checked");
      assert.equal(record(savedEffectiveAcceptance.finalization).maxTurns, 3);
      assert.equal(mockPi.callCount(), 1);
      const receipt = json(fs.readFileSync(receiptPath, "utf-8"));
      assert.equal(receipt.providerCalls, 2);
      assert.equal(fs.realpathSync(requireText(receipt.sessionFile)), fs.realpathSync(sessionFile));
      assert.equal(receipt.networkRequests, 0);
      assert.deepEqual(receipt.extensionErrors, []);
    } finally {
      fs.rmSync(asyncDir, { recursive: true, force: true });
    }
  });

  it("resume steers a live detached foreground child without starting another process", async () => {
    const release = path.join(tempDir, "release-child");
    mockPi.onCall({
      steps: [
        {
          jsonl: [
            mockEvents.toolStart("contact_supervisor", {
              reason: "need_decision",
              message: "Need a decision",
            }),
          ],
        },
        { waitForFile: release, jsonl: [mockEvents.assistantMessage("after reply")] },
      ],
    });
    const { executor, events: bus } = await makeExecutor({
      acknowledgeLive: true,
      agents: [makeAgent("a", { systemPrompt: "Intercom orchestration channel:" })],
    });
    let detachEmitted = false;
    const original = await executor.execute({
      toolCallId: "foreground-detached-original",
      params: { agent: "a", task: "ask supervisor" },
      signal: new AbortController().signal,
      onUpdate: (
        update: ReadonlyInput<{ details?: { progress?: Array<{ currentTool?: string }> } }>,
      ) => {
        if (detachEmitted) {
          return;
        }
        if (
          update.details?.progress?.some((entry) => entry.currentTool === "contact_supervisor") !==
          true
        ) {
          return;
        }
        detachEmitted = true;
        bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "single-detached" });
      },
      ctx: makeMinimalCtx(tempDir),
    });
    assert.equal(detachEmitted, true);
    const runId = original.details.wait?.runId;
    assert.ok(runId !== undefined && runId.length > 0, "expected foreground run id");

    const resumed = await executor.execute({
      toolCallId: "foreground-detached-resume",
      params: { action: "resume", id: runId, message: "Follow up" },
      signal: new AbortController().signal,
      onUpdate: undefined,
      ctx: makeMinimalCtx(tempDir),
    });

    assert.equal(resumed.isError, undefined);
    assert.match(textAt(resumed.content), /Nudge delivered to live subagent/);
    assert.equal(mockPi.callCount(), 1);
    fs.writeFileSync(release, "");
    await waitFor(() => fs.existsSync(path.join(getRunMetadataDir(runId), "result.json")));
  });

  it("resume action keeps exact foreground validation errors over async prefix matches", async () => {
    const base = `exact-invalid-${Date.now()}`;
    const asyncSession = path.join(tempDir, "async-exact-prefix.jsonl");
    fs.writeFileSync(asyncSession, "", "utf-8");
    const asyncDir = path.join(ASYNC_DIR, `${base}-async`);
    try {
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(
          {
            runId: `${base}-async`,
            mode: "single",
            state: "complete",
            startedAt: 100,
            lastUpdate: 200,
            cwd: tempDir,
            steps: [{ agent: "a", status: "complete", sessionFile: asyncSession }],
          },
          null,
          2,
        ),
        "utf-8",
      );
      const { executor, state } = await makeExecutor({
        acknowledgeResults: false,
        agents: [makeAgent("a")],
      });
      state.foregroundRuns.set(base, {
        runId: base,
        mode: "single",
        cwd: tempDir,
        updatedAt: Date.now(),
        children: [{ agent: "a", index: 0, status: "completed" }],
      });

      const result = await executor.execute({
        toolCallId: "resume-exact-invalid-foreground",
        params: { action: "resume", id: base, message: "Follow up" },
        signal: new AbortController().signal,
        onUpdate: undefined,
        ctx: makeMinimalCtx(tempDir),
      });

      assert.equal(result.isError, true);
      assert.match(
        textAt(result.content),
        /Foreground run '.+' child 0 does not have a persisted session file/,
      );
      assert.equal(mockPi.callCount(), 0);
    } finally {
      fs.rmSync(asyncDir, { recursive: true, force: true });
    }
  });

  it("resume action keeps exact async validation errors over foreground prefix matches", async () => {
    const base = `exact-invalid-async-${Date.now()}`;
    const foregroundSession = path.join(tempDir, "foreground-exact-prefix.jsonl");
    fs.writeFileSync(foregroundSession, "", "utf-8");
    const asyncDir = path.join(ASYNC_DIR, base);
    try {
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(
          {
            runId: base,
            mode: "single",
            state: "complete",
            startedAt: 100,
            lastUpdate: 200,
            cwd: tempDir,
            steps: [{ agent: "a", status: "complete" }],
          },
          null,
          2,
        ),
        "utf-8",
      );
      const { executor, state } = await makeExecutor({
        acknowledgeResults: false,
        agents: [makeAgent("a")],
      });
      state.foregroundRuns.set(`${base}-foreground`, {
        runId: `${base}-foreground`,
        mode: "single",
        cwd: tempDir,
        updatedAt: Date.now(),
        children: [{ agent: "a", index: 0, status: "completed", sessionFile: foregroundSession }],
      });

      const result = await executor.execute({
        toolCallId: "resume-exact-invalid-async",
        params: { action: "resume", id: base, message: "Follow up" },
        signal: new AbortController().signal,
        onUpdate: undefined,
        ctx: makeMinimalCtx(tempDir),
      });

      assert.equal(result.isError, true);
      assert.match(
        textAt(result.content),
        /Async run '.+' child 0 does not have a persisted session file/,
      );
      assert.equal(mockPi.callCount(), 0);
    } finally {
      fs.rmSync(asyncDir, { recursive: true, force: true });
    }
  });

  it("resume action reports async ambiguity even when foreground has one prefix match", async () => {
    const base = `namespace-ambiguous-${Date.now()}`;
    const foregroundSession = path.join(tempDir, "foreground-prefix.jsonl");
    const firstAsyncSession = path.join(tempDir, "async-a.jsonl");
    const secondAsyncSession = path.join(tempDir, "async-b.jsonl");
    fs.writeFileSync(foregroundSession, "", "utf-8");
    fs.writeFileSync(firstAsyncSession, "", "utf-8");
    fs.writeFileSync(secondAsyncSession, "", "utf-8");
    const firstAsyncDir = path.join(ASYNC_DIR, `${base}-async-a`);
    const secondAsyncDir = path.join(ASYNC_DIR, `${base}-async-b`);
    try {
      for (const [asyncDir, runId, sessionFile] of [
        [firstAsyncDir, `${base}-async-a`, firstAsyncSession],
        [secondAsyncDir, `${base}-async-b`, secondAsyncSession],
      ] as const) {
        fs.mkdirSync(asyncDir, { recursive: true });
        fs.writeFileSync(
          path.join(asyncDir, "status.json"),
          JSON.stringify(
            {
              runId,
              mode: "single",
              state: "complete",
              startedAt: 100,
              lastUpdate: 200,
              cwd: tempDir,
              steps: [{ agent: "a", status: "complete", sessionFile }],
            },
            null,
            2,
          ),
          "utf-8",
        );
      }
      const { executor, state } = await makeExecutor({
        acknowledgeResults: false,
        agents: [makeAgent("a")],
      });
      state.foregroundRuns.set(`${base}-foreground`, {
        runId: `${base}-foreground`,
        mode: "single",
        cwd: tempDir,
        updatedAt: Date.now(),
        children: [{ agent: "a", index: 0, status: "completed", sessionFile: foregroundSession }],
      });

      const result = await executor.execute({
        toolCallId: "ambiguous-async-prefix-resume",
        params: { action: "resume", id: base, message: "Follow up" },
        signal: new AbortController().signal,
        onUpdate: undefined,
        ctx: makeMinimalCtx(tempDir),
      });

      assert.equal(result.isError, true);
      assert.match(textAt(result.content), /Ambiguous subagent run id prefix/);
    } finally {
      fs.rmSync(firstAsyncDir, { recursive: true, force: true });
      fs.rmSync(secondAsyncDir, { recursive: true, force: true });
    }
  });

  it("resume action reports ambiguous ids across remembered foreground and async runs", async () => {
    const base = `ambiguous-${Date.now()}`;
    const foregroundSession = path.join(tempDir, "foreground.jsonl");
    const asyncSession = path.join(tempDir, "async.jsonl");
    const asyncId = `${base}-async`;
    const foregroundId = `${base}-foreground`;
    const asyncDir = path.join(ASYNC_DIR, asyncId);
    fs.writeFileSync(foregroundSession, "", "utf-8");
    fs.writeFileSync(asyncSession, "", "utf-8");
    try {
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(
          {
            runId: asyncId,
            mode: "single",
            state: "complete",
            startedAt: 100,
            lastUpdate: 200,
            cwd: tempDir,
            steps: [{ agent: "a", status: "complete", sessionFile: asyncSession }],
          },
          null,
          2,
        ),
        "utf-8",
      );
      const { executor, state } = await makeExecutor({
        acknowledgeResults: false,
        agents: [makeAgent("a")],
      });
      state.foregroundRuns.set(foregroundId, {
        runId: foregroundId,
        mode: "single",
        cwd: tempDir,
        updatedAt: Date.now(),
        children: [{ agent: "a", index: 0, status: "completed", sessionFile: foregroundSession }],
      });

      const result = await executor.execute({
        toolCallId: "ambiguous-resume",
        params: { action: "resume", id: base, message: "Follow up" },
        signal: new AbortController().signal,
        onUpdate: undefined,
        ctx: makeMinimalCtx(tempDir),
      });

      assert.equal(result.isError, true);
      assert.match(textAt(result.content), /ambiguous between foreground run/);
    } finally {
      fs.rmSync(asyncDir, { recursive: true, force: true });
    }
  });
});
