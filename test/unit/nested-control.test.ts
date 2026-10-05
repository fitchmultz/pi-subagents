import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it, mock } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ReadonlyDeep } from "type-fest";
import { makeAgent, makeMinimalCtx } from "../support/helpers.ts";
import {
  createNativeSessionFixture,
  type NativeSessionFixture,
} from "../support/native-session.ts";
import { assertDefined, assertRecord, readJson } from "../support/assertions.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";
import registerFanoutChildSubagentExtension from "../../src/extension/fanout-child.ts";
import {
  getRunMetadataDir,
  saveQuestionOwner,
  saveRunStatus,
} from "../../src/runs/shared/supervisor-questions.ts";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import {
  createNestedRoute,
  projectNestedEvents,
  readNestedControlRequests,
  readNestedControlResults,
  writeNestedControlRequest,
  writeNestedControlResult,
  writeNestedEvent,
} from "../../src/runs/shared/nested-events.ts";
import {
  SUBAGENT_CHILD_ENV,
  SUBAGENT_FANOUT_CHILD_ENV,
  SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV,
  SUBAGENT_PARENT_CHILD_INDEX_ENV,
  SUBAGENT_PARENT_CONTROL_INBOX_ENV,
  SUBAGENT_PARENT_EVENT_SINK_ENV,
  SUBAGENT_PARENT_ROOT_RUN_ID_ENV,
  SUBAGENT_PARENT_RUN_ID_ENV,
} from "../../src/runs/shared/pi-args.ts";
import {
  ASYNC_DIR,
  SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT,
  SUBAGENT_RESULT_INTERCOM_EVENT,
  TEMP_ROOT_DIR,
  type SubagentState,
} from "../../src/shared/types.ts";

const routeRoots: string[] = [];
const fanoutHosts: NativeSessionFixture[] = [];
const replies: NodeJS.Timeout[] = [];
const executorHost = await createNativeSessionFixture({
  cwd: process.cwd(),
  agentDir: os.tmpdir(),
});
after(() => executorHost.dispose());

async function startFanout() {
  const fixture = await createNativeSessionFixture({
    cwd: process.cwd(),
    agentDir: os.tmpdir(),
    configure: registerFanoutChildSubagentExtension,
  });
  fanoutHosts.push(fixture);
  return fixture;
}
const savedEnv = {
  [SUBAGENT_CHILD_ENV]: process.env[SUBAGENT_CHILD_ENV],
  [SUBAGENT_FANOUT_CHILD_ENV]: process.env[SUBAGENT_FANOUT_CHILD_ENV],
  [SUBAGENT_PARENT_EVENT_SINK_ENV]: process.env[SUBAGENT_PARENT_EVENT_SINK_ENV],
  [SUBAGENT_PARENT_CONTROL_INBOX_ENV]: process.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV],
  [SUBAGENT_PARENT_ROOT_RUN_ID_ENV]: process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV],
  [SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV]: process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV],
  [SUBAGENT_PARENT_RUN_ID_ENV]: process.env[SUBAGENT_PARENT_RUN_ID_ENV],
  [SUBAGENT_PARENT_CHILD_INDEX_ENV]: process.env[SUBAGENT_PARENT_CHILD_INDEX_ENV],
};

afterEach(async () => {
  for (const reply of replies.splice(0)) {
    clearInterval(reply);
  }
  await Promise.all(
    fanoutHosts.splice(0).map(async (fixture) => {
      await fixture.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      await fixture.dispose();
    }),
  );
  mock.restoreAll();
  for (const root of routeRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

function createState(): SubagentState {
  return {
    baseCwd: "",
    currentSessionId: null,
    asyncJobs: new Map(),
    foregroundRuns: new Map(),
    ownedRuns: new Map(),
    cleanupTimers: new Map(),
    lastUiContext: null,
    poller: null,
    completionSeen: new Map(),
    watcher: null,
    watcherRestartTimer: null,
    resultFileCoalescer: {
      schedule: () => false,
      clear: () => {
        /* No queued file work in this direct-executor fixture. */
      },
    },
  };
}

function createExecutor(
  state = createState(),
  agents: ReadonlyDeep<AgentConfig[]> = [],
  allowMutatingManagementActions = true,
  events = executorHost.pi.events,
) {
  return createSubagentExecutor({
    pi: { ...executorHost.pi, events, getSessionName: () => "parent" },
    state,
    config: { maxSubagentDepth: 2, control: {} },
    asyncByDefault: false,
    tempArtifactsDir: os.tmpdir(),
    getSubagentSessionRoot: (parentSessionFile) =>
      parentSessionFile !== null
        ? path.join(path.dirname(parentSessionFile), path.basename(parentSessionFile, ".jsonl"))
        : os.tmpdir(),
    expandTilde: (value) => value,
    discoverAgents: () => ({ agents: [...agents] }),
    allowMutatingManagementActions,
  });
}

function ctx(root: string, sessionFile: string | null = null) {
  const manager = SessionManager.inMemory(root, { id: "session" });
  manager.getSessionFile = () => sessionFile ?? undefined;
  return makeMinimalCtx(root, { sessionManager: manager, isProjectTrusted: () => true });
}

function createNestedRun(
  id = "nested-live",
  state: "running" | "complete" | "failed" | "paused" = "running",
  extras: Readonly<Record<string, unknown>> = {},
) {
  const route = createNestedRoute("root-control");
  routeRoots.push(path.dirname(route.eventSink));
  writeNestedEvent(route, {
    type: state === "running" ? "subagent.nested.updated" : "subagent.nested.completed",
    ts: 100,
    parentRunId: "root-control",
    parentStepIndex: 0,
    child: {
      id,
      parentRunId: "root-control",
      parentStepIndex: 0,
      depth: 1,
      path: [{ runId: "root-control", stepIndex: 0 }],
      state,
      agent: "worker",
      ownerState: state === "running" ? "live" : "gone",
      ...extras,
    },
  });
  return route;
}

function stateWithNestedRoute(
  route: Readonly<ReturnType<typeof createNestedRoute>>,
): SubagentState {
  const state = createState();
  assertDefined(state.ownedRuns);
  state.ownedRuns.set(route.rootRunId, {
    runId: route.rootRunId,
    rootRunId: route.rootRunId,
    ownerSessionId: "session",
    mode: "single",
    source: "async",
    startedAt: 1,
    cwd: "",
    task: "Nested owner",
    children: [],
  });
  return state;
}

function setNestedRouteEnv(
  route: Readonly<ReturnType<typeof createNestedRoute>>,
  parentRunId = route.rootRunId,
) {
  process.env[SUBAGENT_PARENT_EVENT_SINK_ENV] = route.eventSink;
  process.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV] = route.controlInbox;
  process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV] = route.rootRunId;
  process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV] = route.capabilityToken;
  process.env[SUBAGENT_PARENT_RUN_ID_ENV] = parentRunId;
  process.env[SUBAGENT_PARENT_CHILD_INDEX_ENV] = "0";
}

function text(
  result: Pick<
    ReadonlyDeep<Awaited<ReturnType<ReturnType<typeof createExecutor>["execute"]>>>,
    "content"
  >,
): string {
  const part = result.content.at(0);
  assertDefined(part);
  assert.ok(part.type === "text", "management results must contain text");
  return part.text;
}

function controlRequest(asyncDir: string): Readonly<Record<string, unknown>> {
  const request = readJson(path.join(asyncDir, "control-request.json"));
  assertRecord(request);
  return request;
}

function scheduleNestedReply(
  route: ReadonlyDeep<ReturnType<typeof createNestedRoute>>,
  reply: (request: ReadonlyDeep<ReturnType<typeof readNestedControlRequests>[number]>) => void,
): void {
  const timer = setInterval(() => {
    const request = readNestedControlRequests(route).at(0);
    if (request === undefined) {
      return;
    }
    clearInterval(timer);
    reply(request);
  }, 10);
  replies.push(timer);
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    // Observe the journal publication/result, yielding between independent reads.
    // oxlint-disable-next-line no-await-in-loop
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  assert.equal(predicate(), true);
}

describe("nested control routing", () => {
  for (const exact of [true, false]) {
    for (const index of [undefined, 1]) {
      it(`routes ${index === undefined ? "whole-run" : "selected-child"} control by ${exact ? "exact ID" : "prefix"} through the authorized nested owner despite its canonical v2 directory`, async () => {
        const id = `canonical-nested-${index ?? "all"}`,
          asyncDir = getRunMetadataDir(id),
          requested = exact ? id : id.slice(0, -1);
        routeRoots.push(asyncDir);
        saveRunStatus(id, {
          runtimeVersion: 2,
          runId: id,
          mode: "parallel",
          state: "running",
          pid: process.pid,
          startedAt: Date.now(),
          indexedControl: true,
          controlRequestFiles: true,
          steps: [
            { agent: "worker", status: "running" },
            { agent: "reviewer", status: "running" },
          ],
        });
        const route = createNestedRun(id, "running", {
          asyncDir,
          mode: "parallel",
          indexedControl: true,
          agents: ["worker", "reviewer"],
        });
        const state = stateWithNestedRoute(route),
          executor = createExecutor(state);
        let received: ReturnType<typeof readNestedControlRequests>[number] | undefined;
        const reply = setInterval(() => {
          const request = readNestedControlRequests(route).at(0);
          if (!request || received) {
            return;
          }
          received = request;
          writeNestedControlResult(route, {
            ts: Date.now(),
            requestId: request.requestId,
            targetRunId: id,
            ok: true,
            message: "Nested owner accepted control",
          });
        }, 10);
        try {
          const result = await executor.execute({
            toolCallId: "canonical-stop",
            params: {
              action: "interrupt",
              id: requested,
              ...(index === undefined ? {} : { index }),
            },
            ctx: ctx(asyncDir),
          });
          assert.equal(result.isError, undefined, text(result));
          assert.match(text(result), /Nested owner accepted control/);
          assert.equal(received?.targetRunId, id);
          assert.equal(received.targetChildIndex, 0, "outer owner address is retained");
          assert.equal(received.index, index, "inner selected-child index remains separate");
          assert.equal(
            fs.existsSync(path.join(asyncDir, "control-requests")),
            false,
            "the root never adopts an unowned global runner",
          );
          const inspected = await executor.execute({
            toolCallId: "canonical-inspect",
            params: { action: "status", id: requested },
            ctx: ctx(asyncDir),
          });
          assert.equal(inspected.isError, undefined, text(inspected));
          assert.match(text(inspected), new RegExp(`Nested run: ${id}`));
          assert.match(text(inspected), /Root: root-control/);
          assert.deepEqual([...(state.ownedRuns ?? new Map()).keys()], [route.rootRunId]);
        } finally {
          clearInterval(reply);
        }
      });
    }
  }

  it("canonical directories do not authorize another child scope or an unrelated global run", async () => {
    const route = createNestedRun("scope-authorized"),
      executor = createExecutor(createState(), [], false);
    setNestedRouteEnv(route);
    for (const id of ["scope-sibling", "scope-unrelated"]) {
      const asyncDir = getRunMetadataDir(id);
      routeRoots.push(asyncDir);
      saveRunStatus(id, {
        runtimeVersion: 2,
        runId: id,
        mode: "single",
        state: "running",
        pid: process.pid,
        startedAt: Date.now(),
        controlRequestFiles: true,
        steps: [{ agent: "worker", status: "running" }],
      });
      if (id === "scope-sibling") {
        writeNestedEvent(route, {
          type: "subagent.nested.updated",
          ts: Date.now(),
          parentRunId: route.rootRunId,
          parentStepIndex: 1,
          child: {
            id,
            parentRunId: route.rootRunId,
            parentStepIndex: 1,
            depth: 1,
            path: [{ runId: route.rootRunId, stepIndex: 1 }],
            state: "running",
            agent: "worker",
            asyncDir,
            indexedControl: true,
          },
        });
      }
      for (const requested of [id, id.slice(0, -1)]) {
        // Check each scope against the same owner before inspecting its control inbox.
        // oxlint-disable-next-line no-await-in-loop
        const result = await executor.execute({
          toolCallId: "excluded-stop",
          params: { action: "interrupt", id: requested },
          ctx: ctx(asyncDir),
        });
        assert.equal(result.isError, true);
        assert.match(text(result), /No interrupt-capable run/);
      }
      assert.equal(fs.existsSync(path.join(asyncDir, "control-requests")), false);
    }
    assert.deepEqual(readNestedControlRequests(route), []);
  });

  it("routes interrupt to an explicit nested id through the control inbox", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-control-"));
    try {
      const route = createNestedRun();
      const executor = createExecutor(stateWithNestedRoute(route));
      scheduleNestedReply(route, (request) => {
        writeNestedControlResult(route, {
          ts: Date.now(),
          requestId: request.requestId,
          targetRunId: request.targetRunId,
          ok: true,
          message: "nested interrupt accepted",
        });
      });

      const result = await executor.execute({
        toolCallId: "interrupt",
        params: { action: "interrupt", id: "nested-live" },
        signal: new AbortController().signal,
        ctx: ctx(root),
      });
      assert.equal(result.isError, undefined);
      assert.match(text(result), /nested interrupt accepted/);
      assert.deepEqual(result.details.managementControl?.capabilities, [
        "status",
        "resume",
        "interrupt",
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  for (const supported of [false, true]) {
    it(`selected nested stop ${supported ? "preserves the inner child index" : "refuses an older index-ignorant owner"}`, async () => {
      const route = createNestedRun("nested-selected", "running", {
        mode: "parallel",
        indexedControl: supported,
        agents: ["worker", "reviewer"],
      });
      if (supported) {
        scheduleNestedReply(route, (request) => {
          assert.equal(
            request.targetChildIndex,
            0,
            "outer owner routing is separate from inner selection",
          );
          assert.equal(request.index, 1);
          writeNestedControlResult(route, {
            ts: Date.now(),
            requestId: request.requestId,
            targetRunId: request.targetRunId,
            ok: true,
            message: "Selected child stop requested",
          });
        });
      }
      const result = await createExecutor(stateWithNestedRoute(route)).execute({
        toolCallId: "stop",
        params: { action: "interrupt", id: "nested-selected", index: 1 },
        ctx: ctx(path.dirname(route.eventSink)),
      });
      if (supported) {
        assert.equal(result.isError, undefined);
      } else {
        assert.equal(result.isError, true);
        assert.equal(readNestedControlRequests(route).length, 0);
        assert.match(text(result), /No stop was sent/);
      }
    });
  }

  it("advertises only status and interrupt after a direct nested async interrupt", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-direct-interrupt-"));
    const asyncDir = path.join(
      TEMP_ROOT_DIR,
      "nested-subagent-runs",
      "root-control",
      "nested-direct",
    );
    try {
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify({ runId: "nested-direct", state: "running", pid: 12345 }),
        "utf-8",
      );
      const route = createNestedRun("nested-direct", "running", {
        asyncDir,
        intercomTarget: "nested-target",
      });
      scheduleNestedReply(route, (request) => {
        writeNestedControlResult(route, {
          ts: Date.now(),
          requestId: request.requestId,
          targetRunId: request.targetRunId,
          ok: false,
          message: "foreground owner does not own async run",
        });
      });
      const kill = mock.method(process, "kill", () => true);
      const result = await createExecutor(stateWithNestedRoute(route)).execute({
        toolCallId: "interrupt",
        params: { action: "interrupt", id: "nested-direct" },
        signal: new AbortController().signal,
        ctx: ctx(root),
      });

      assert.equal(result.isError, undefined);
      assert.ok(
        kill.mock.calls.every((call) => call.arguments[1] === 0),
        "live runners may only be probed for liveness",
      );
      const request = controlRequest(asyncDir);
      assert.equal(request.runId, "nested-direct");
      assert.equal(request.action, "interrupt");
      assert.deepEqual(result.details.managementControl?.capabilities, ["status", "interrupt"]);
    } finally {
      mock.restoreAll();
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(asyncDir, { recursive: true, force: true });
    }
  });

  it("advertises only status immediately after a top-level async interrupt", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-interrupt-"));
    const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-interrupt-run-"));
    try {
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify({ runId: "async-live", state: "running", pid: 12345 }),
        "utf-8",
      );
      const state = createState();
      state.asyncJobs.set("async-live", {
        asyncId: "async-live",
        asyncDir,
        status: "running",
        updatedAt: 1,
      });
      mock.method(process, "kill", () => true);
      const result = await createExecutor(state).execute({
        toolCallId: "interrupt",
        params: { action: "interrupt", id: "async-live" },
        signal: new AbortController().signal,
        ctx: ctx(root),
      });

      assert.equal(result.isError, undefined);
      assert.equal(controlRequest(asyncDir).runId, "async-live");
      assert.deepEqual(result.details.managementControl?.capabilities, ["status"]);
    } finally {
      mock.restoreAll();
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(asyncDir, { recursive: true, force: true });
    }
  });

  it("rejects async status that does not belong to the targeted run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-interrupt-invalid-"));
    const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-interrupt-invalid-run-"));
    try {
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify({ runId: "another-run", state: "running", pid: -1 }),
        "utf-8",
      );
      const state = createState();
      state.asyncJobs.set("async-invalid", {
        asyncId: "async-invalid",
        asyncDir,
        status: "running",
        updatedAt: 1,
      });
      const kill = mock.method(process, "kill", () => true);
      const result = await createExecutor(state).execute({
        toolCallId: "interrupt",
        params: { action: "interrupt", id: "async-invalid" },
        signal: new AbortController().signal,
        ctx: ctx(root),
      });
      assert.equal(result.isError, true);
      assert.match(text(result), /No running async run with a matching control channel/);
      assert.equal(kill.mock.callCount(), 0);
      assert.equal(fs.existsSync(path.join(asyncDir, "control-request.json")), false);
    } finally {
      mock.restoreAll();
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(asyncDir, { recursive: true, force: true });
    }
  });

  it("renders nested children from the durable owner's status output", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-foreground-status-"));
    try {
      const route = createNestedRun("nested-foreground");
      const state = stateWithNestedRoute(route);
      const run = state.ownedRuns?.get(route.rootRunId);
      assertDefined(run);
      run.asyncDir = getRunMetadataDir(run.runId);
      routeRoots.push(run.asyncDir);
      saveRunStatus(run.runId, {
        runtimeVersion: 2,
        runId: run.runId,
        mode: "single",
        state: "running",
        pid: process.pid,
        startedAt: Date.now(),
        steps: [{ agent: "orchestrator", status: "running" }],
      });

      const result = await createExecutor(state).execute({
        toolCallId: "status",
        params: { action: "status", id: "root-control" },
        signal: new AbortController().signal,
        ctx: ctx(root),
      });

      assert.equal(result.isError, undefined);
      assert.match(text(result), /Run: root-control/);
      assert.match(text(result), /↳ worker \[nested-foreground\] running/);
      assert.match(
        text(result),
        /Status: agent_runs\(\{ action: "inspect", id: "nested-foreground" \}\)/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("scopes child-safe nested status lookup to the inherited route and child address", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-child-scope-"));
    try {
      const allowedRoute = createNestedRun("shared-nested");
      setNestedRouteEnv(allowedRoute, "root-control");
      const outsideRoute = createNestedRoute("root-outside");
      routeRoots.push(path.dirname(outsideRoute.eventSink));
      writeNestedEvent(outsideRoute, {
        type: "subagent.nested.updated",
        ts: 100,
        parentRunId: "root-outside",
        parentStepIndex: 0,
        child: {
          id: "shared-nested",
          parentRunId: "root-outside",
          parentStepIndex: 0,
          depth: 1,
          path: [{ runId: "root-outside", stepIndex: 0 }],
          state: "running",
          agent: "outside",
        },
      });

      const result = await createExecutor(createState(), [], false).execute({
        toolCallId: "status",
        params: { action: "status", id: "shared-nested" },
        signal: new AbortController().signal,
        ctx: ctx(root),
      });

      assert.equal(result.isError, undefined);
      assert.match(text(result), /Nested run: shared-nested/);
      assert.match(text(result), /Root: root-control/);
      assert.doesNotMatch(text(result), /root-outside/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires an id for child-safe status instead of listing unrelated top-level async runs", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-child-safe-status-"));
    const runId = `child-safe-unrelated-${Date.now().toString(36)}`;
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
            pid: 12345,
            startedAt: 100,
            lastUpdate: 100,
            steps: [{ agent: "outside", status: "running", startedAt: 100 }],
          },
          null,
          2,
        ),
        "utf-8",
      );

      const result = await createExecutor(createState(), [], false).execute({
        toolCallId: "status",
        params: { action: "status" },
        signal: new AbortController().signal,
        ctx: ctx(root),
      });

      assert.equal(result.isError, true);
      assert.match(text(result), /requires a run id/);
      assert.doesNotMatch(text(result), new RegExp(runId));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(asyncDir, { recursive: true, force: true });
    }
  });

  it("does not let bare interrupt target hidden nested descendants", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-bare-interrupt-"));
    try {
      createNestedRun("nested-only");
      const result = await createExecutor().execute({
        toolCallId: "interrupt",
        params: { action: "interrupt" },
        signal: new AbortController().signal,
        ctx: ctx(root),
      });
      assert.equal(result.isError, true);
      assert.match(text(result), /No interrupt-capable run found/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("times out owner-gone nested control and ignores late results", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-timeout-"));
    try {
      const route = createNestedRun("nested-timeout");
      const executor = createExecutor(stateWithNestedRoute(route));
      const result = await executor.execute({
        toolCallId: "interrupt",
        params: { action: "interrupt", id: "nested-timeout" },
        signal: new AbortController().signal,
        ctx: ctx(root),
      });
      assert.equal(result.isError, true);
      assert.match(text(result), /owner is not reachable/);
      const request = readNestedControlRequests(route).at(0);
      assertDefined(request);
      writeNestedControlResult(route, {
        ts: Date.now(),
        requestId: request.requestId,
        targetRunId: request.targetRunId,
        ok: true,
        message: "late success",
      });
      assert.ok(
        readNestedControlResults(route).some(
          (entry) => entry.requestId === request.requestId && entry.ok,
        ),
      );
      assert.equal(result.isError, true, "late publication cannot change the timed-out receipt");
      assert.doesNotMatch(text(result), /late success/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("routes resume for live nested runs through the control inbox", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-live-resume-"));
    try {
      const emitted: Array<{ name: string; payload: unknown }> = [];
      const events = {
        emit(name: string, payload: unknown) {
          emitted.push({ name, payload });
        },
        on() {
          return () => {
            /* This collector has no subscribed listeners. */
          };
        },
      };
      const route = createNestedRun("nested-live-resume", "running", {
        intercomTarget: "attacker-target",
        leafIntercomTarget: "attacker-leaf",
      });
      const executor = createExecutor(stateWithNestedRoute(route), [], true, events);
      scheduleNestedReply(route, (request) => {
        assert.equal(request.action, "resume");
        assert.equal(request.message, "continue please");
        writeNestedControlResult(route, {
          ts: Date.now(),
          requestId: request.requestId,
          targetRunId: request.targetRunId,
          ok: true,
          message: "nested resume accepted",
        });
      });

      const result = await executor.execute({
        toolCallId: "resume",
        params: {
          action: "resume",
          id: "nested-live-resume",
          message: "continue please",
          acceptance: { criteria: ["New contract"] },
        },
        signal: new AbortController().signal,
        ctx: ctx(root),
      });

      assert.equal(result.isError, undefined);
      assert.match(text(result), /nested resume accepted/);
      assert.match(text(result), /Acceptance override applies only to revive and was not applied/);
      assert.equal(
        emitted.some((event) => {
          const payload = event.payload;
          assertRecord(payload);
          return payload.to === "attacker-target" || payload.to === "attacker-leaf";
        }),
        false,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to the advertised leaf target when a nested async owner rejects resume routing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-resume-fallback-"));
    try {
      const listeners = new Map<string, Set<(payload: unknown) => void>>();
      const emitted: Array<{ name: string; payload: unknown }> = [];
      const events = {
        on(name: string, listener: (payload: unknown) => void) {
          const set = listeners.get(name) ?? new Set();
          set.add(listener);
          listeners.set(name, set);
          return () => {
            set.delete(listener);
          };
        },
        emit(name: string, payload: unknown) {
          emitted.push({ name, payload });
          if (name === SUBAGENT_RESULT_INTERCOM_EVENT) {
            assertRecord(payload);
            assert.ok(typeof payload.requestId === "string");
            const requestId = payload.requestId;
            queueMicrotask(() =>
              listeners
                .get(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT)
                ?.forEach((listener) => listener({ requestId, delivered: true })),
            );
          }
          listeners.get(name)?.forEach((listener) => listener(payload));
        },
      };
      const route = createNestedRun("nested-resume-fallback", "running", {
        leafIntercomTarget: "nested-leaf-target",
      });
      const executor = createExecutor(stateWithNestedRoute(route), [], true, events);
      scheduleNestedReply(route, (request) => {
        writeNestedControlResult(route, {
          ts: Date.now(),
          requestId: request.requestId,
          targetRunId: request.targetRunId,
          ok: false,
          message: "owner does not have this async job",
        });
      });

      const result = await executor.execute({
        toolCallId: "resume",
        params: { action: "resume", id: "nested-resume-fallback", message: "continue directly" },
        signal: new AbortController().signal,
        ctx: ctx(root),
      });
      assert.equal(result.isError, undefined);
      assert.match(text(result), /Delivered follow-up directly/);
      const delivery = emitted.find(
        (entry) => entry.name === SUBAGENT_RESULT_INTERCOM_EVENT,
      )?.payload;
      assertRecord(delivery);
      assert.ok(typeof delivery.message === "string");
      assert.equal(delivery.to, "nested-leaf-target");
      assert.match(delivery.message, /continue directly/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("validates terminal nested resume session files before revive", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-terminal-resume-"));
    try {
      const route = createNestedRun("nested-terminal-resume", "complete", {
        sessionFile: path.join(root, "missing-session.jsonl"),
      });

      const result = await createExecutor(stateWithNestedRoute(route), [
        makeAgent("worker", { description: "Worker", systemPrompt: "Do work" }),
      ]).execute({
        toolCallId: "resume",
        params: { action: "resume", id: "nested-terminal-resume", message: "continue" },
        signal: new AbortController().signal,
        ctx: ctx(root),
      });

      assert.equal(result.isError, true);
      assert.match(text(result), /session file does not exist/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects terminal nested resume session files outside trusted roots", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-terminal-untrusted-"));
    try {
      const parentSessionFile = path.join(root, "parent.jsonl");
      const attackerSessionFile = path.join(root, "outside", "session.jsonl");
      fs.mkdirSync(path.dirname(attackerSessionFile), { recursive: true });
      fs.writeFileSync(parentSessionFile, "");
      fs.writeFileSync(attackerSessionFile, "");
      const route = createNestedRun("nested-untrusted-resume", "complete", {
        sessionFile: attackerSessionFile,
      });

      const result = await createExecutor(stateWithNestedRoute(route), [
        makeAgent("worker", { description: "Worker", systemPrompt: "Do work" }),
      ]).execute({
        toolCallId: "resume",
        params: { action: "resume", id: "nested-untrusted-resume", message: "continue" },
        signal: new AbortController().signal,
        ctx: ctx(root, parentSessionFile),
      });

      assert.equal(result.isError, true);
      assert.match(text(result), /outside trusted nested session roots/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects terminal nested resume session files from sibling run directories", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-terminal-sibling-"));
    try {
      const parentSessionFile = path.join(root, "parent.jsonl");
      const siblingSessionFile = path.join(root, "parent", "other-run", "run-0", "session.jsonl");
      fs.mkdirSync(path.dirname(siblingSessionFile), { recursive: true });
      fs.writeFileSync(parentSessionFile, "");
      fs.writeFileSync(siblingSessionFile, "");
      const route = createNestedRun("nested-sibling-resume", "complete", {
        sessionFile: siblingSessionFile,
      });

      const result = await createExecutor(stateWithNestedRoute(route), [
        makeAgent("worker", { description: "Worker", systemPrompt: "Do work" }),
      ]).execute({
        toolCallId: "resume",
        params: { action: "resume", id: "nested-sibling-resume", message: "continue" },
        signal: new AbortController().signal,
        ctx: ctx(root, parentSessionFile),
      });

      assert.equal(result.isError, true);
      assert.match(text(result), /not under that nested run's session directory/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports admission failure without inventing a nested start", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-foreground-throw-"));
    try {
      const route = createNestedRoute("root-parent");
      routeRoots.push(path.dirname(route.eventSink));
      setNestedRouteEnv(route, "root-parent");
      const throwingCtx = ctx(root);
      mock.method(throwingCtx.modelRegistry, "getAvailable", () => {
        throw new Error("model registry exploded");
      });

      const state = createState();
      const result = await createExecutor(state, [
        makeAgent("worker", { description: "Worker", systemPrompt: "Do work" }),
      ]).execute({
        toolCallId: "run",
        params: { agent: "worker", task: "go" },
        signal: new AbortController().signal,
        ctx: throwingCtx,
      });

      assert.equal(result.isError, true);
      assert.match(text(result), /model registry exploded/);
      const registry = projectNestedEvents(route);
      assert.deepEqual(
        registry.children,
        [],
        "admission failed before the owner started; no phantom live or completed child",
      );
      assert.equal(
        state.ownedRuns?.size,
        0,
        "a rejected launch must not retain phantom owned children",
      );
      assert.equal(
        result.details.runId ?? result.details.asyncId,
        undefined,
        "no execution owner was launched",
      );
      assert.equal(state.asyncJobs.size, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the fanout child control listener alive after control inbox polling errors", async () => {
    const route = createNestedRoute("root-poll-error");
    routeRoots.push(path.dirname(route.eventSink));
    setNestedRouteEnv(route, "root-poll-error");
    process.env[SUBAGENT_CHILD_ENV] = "1";
    process.env[SUBAGENT_FANOUT_CHILD_ENV] = "1";

    fs.rmSync(route.controlInbox, { recursive: true, force: true });
    fs.writeFileSync(route.controlInbox, "not a directory", "utf-8");
    const originalError = console.error;
    const logged: Array<readonly unknown[]> = [];
    console.error = (...args: readonly unknown[]) => {
      logged.push(args);
    };
    try {
      await startFanout();
      await waitFor(() =>
        logged.some(
          (entry) =>
            typeof entry[0] === "string" &&
            entry[0].includes(route.controlInbox) &&
            entry[0].includes("root-poll-error"),
        ),
      );

      fs.rmSync(route.controlInbox, { force: true });
      fs.mkdirSync(route.controlInbox, { recursive: true });
      const requestPath = writeNestedControlRequest(route, {
        ts: Date.now(),
        requestId: "poll-error-recovers",
        targetRunId: "missing-run",
        action: "interrupt",
      });

      await waitFor(() =>
        readNestedControlResults(route).some(
          (result) => result.requestId === "poll-error-recovers" && !result.ok,
        ),
      );
      assert.equal(fs.existsSync(requestPath), false);
    } finally {
      console.error = originalError;
    }
  });

  it("retains child control requests during restoration and executes them once ownership is ready", async (t) => {
    const route = createNestedRoute("root-restoring-child");
    routeRoots.push(path.dirname(route.eventSink));
    setNestedRouteEnv(route);
    process.env[SUBAGENT_CHILD_ENV] = "1";
    process.env[SUBAGENT_FANOUT_CHILD_ENV] = "1";
    const runId = "restoring-child-owned",
      owner = "restoring-child-session",
      asyncDir = getRunMetadataDir(runId);
    routeRoots.push(asyncDir);
    saveQuestionOwner(runId, owner);
    saveRunStatus(runId, {
      runtimeVersion: 2,
      runId,
      sessionId: owner,
      mode: "single",
      state: "running",
      pid: process.pid,
      startedAt: 1,
      steps: [{ agent: "worker", status: "running" }],
    });
    const run = {
      runId,
      rootRunId: runId,
      ownerSessionId: owner,
      source: "async",
      mode: "single",
      cwd: asyncDir,
      task: "Retain live nested work",
      startedAt: 1,
      asyncDir,
      children: [{ agent: "worker", index: 0 }],
    };
    const manager = SessionManager.inMemory(asyncDir, { id: owner });
    for (let index = 0; index < 63; index++) {
      manager.appendCustomEntry("fixture", {});
    }
    manager.appendCustomEntry("subagent-run", run);
    const scan: PromiseWithResolvers<void> = Promise.withResolvers();
    const lifecycle = { starting: false };
    const getEntries = manager.getEntries.bind(manager);
    t.mock.method(manager, "getEntries", () => {
      const entries = getEntries();
      if (lifecycle.starting) {
        scan.resolve();
      }
      return entries;
    });
    const interval = globalThis.setInterval;
    let poll: (() => void) | undefined;
    t.mock.method(globalThis, "setInterval", (callback: () => void, ms?: number) => {
      if (ms === 200) {
        poll = callback;
        return interval(() => {
          /* Drive the polling callback explicitly at recovery boundaries. */
        }, ms);
      }
      return interval(callback, ms);
    });
    const request = writeNestedControlRequest(route, {
      ts: Date.now() - 1000,
      requestId: "during-restoration",
      targetRunId: runId,
      action: "interrupt",
    });
    const restoring = createNativeSessionFixture({
      cwd: asyncDir,
      agentDir: os.tmpdir(),
      sessionManager: manager,
      configure(pi) {
        pi.on("session_start", () => {
          lifecycle.starting = true;
        });
        registerFanoutChildSubagentExtension(pi);
      },
    });
    try {
      await scan.promise;
      assertDefined(poll);
      poll();
      assert.deepEqual(
        readNestedControlResults(route),
        [],
        "partial ownership cannot reject or acknowledge the request",
      );
      assert.equal(fs.existsSync(request), true);
      assert.equal(
        fs.existsSync(`${request}.claimed`),
        false,
        "recovery must finish before claiming controls",
      );
      const fixture = await restoring;
      fanoutHosts.push(fixture);
      poll();
      const results = readNestedControlResults(route);
      assert.equal(results.length, 1);
      assert.equal(results[0].ok, true, results[0].message);
      assert.equal(controlRequest(asyncDir).action, "interrupt");
      assert.equal(fs.existsSync(request), false);
    } finally {
      const fixture = await restoring;
      if (!fanoutHosts.includes(fixture)) {
        fanoutHosts.push(fixture);
      }
    }
  });

  it("keeps fanout child control requests when result writing fails and retries after recovery", async () => {
    const route = createNestedRoute("root-result-write-fails");
    routeRoots.push(path.dirname(route.eventSink));
    setNestedRouteEnv(route, "root-result-write-fails");
    process.env[SUBAGENT_CHILD_ENV] = "1";
    process.env[SUBAGENT_FANOUT_CHILD_ENV] = "1";

    fs.rmSync(route.eventSink, { recursive: true, force: true });
    fs.writeFileSync(route.eventSink, "not a directory", "utf-8");
    const requestPath = writeNestedControlRequest(route, {
      ts: Date.now(),
      requestId: "result-write-fails",
      targetRunId: "missing-run",
      action: "interrupt",
    });
    const originalError = console.error;
    const logged: Array<readonly unknown[]> = [];
    console.error = (...args: readonly unknown[]) => {
      logged.push(args);
    };
    try {
      await startFanout();
      await waitFor(() =>
        logged.some(
          (entry) =>
            typeof entry[0] === "string" &&
            entry[0].includes("result-write-fails") &&
            /keeping request for retry/.test(entry[0]),
        ),
      );
      assert.equal(fs.existsSync(requestPath), true);

      fs.rmSync(route.eventSink, { force: true });
      fs.mkdirSync(route.eventSink, { recursive: true });
      await waitFor(() =>
        readNestedControlResults(route).some(
          (result) => result.requestId === "result-write-fails" && !result.ok,
        ),
      );
      assert.equal(fs.existsSync(requestPath), false);
    } finally {
      console.error = originalError;
    }
  });

  it("refuses to replay a nested control request that was durably claimed", async () => {
    const route = createNestedRoute("root-claimed-request");
    routeRoots.push(path.dirname(route.eventSink));
    setNestedRouteEnv(route, "root-claimed-request");
    process.env[SUBAGENT_CHILD_ENV] = "1";
    process.env[SUBAGENT_FANOUT_CHILD_ENV] = "1";

    const requestPath = writeNestedControlRequest(route, {
      ts: Date.now(),
      requestId: "already-claimed",
      targetRunId: "unknown-original-owner",
      action: "interrupt",
    });
    fs.writeFileSync(`${requestPath}.claimed`, "already-claimed\n", "utf-8");

    await startFanout();
    await waitFor(() =>
      readNestedControlResults(route).some((result) => result.requestId === "already-claimed"),
    );
    const result = readNestedControlResults(route).find(
      (entry) => entry.requestId === "already-claimed",
    );
    assert.equal(result?.ok, false);
    assert.match(result.message, /refusing to execute it again/);
    assert.equal(fs.existsSync(requestPath), false);
    assert.equal(fs.existsSync(`${requestPath}.claimed`), false);
  });

  it("negatively acknowledges ownerless fanout child control requests and removes them", async () => {
    const route = createNestedRoute("root-ownerless");
    routeRoots.push(path.dirname(route.eventSink));
    setNestedRouteEnv(route, "root-ownerless");
    process.env[SUBAGENT_CHILD_ENV] = "1";
    process.env[SUBAGENT_FANOUT_CHILD_ENV] = "1";

    const requestPath = writeNestedControlRequest(route, {
      ts: Date.now(),
      requestId: "ownerless-request",
      targetRunId: "missing-run",
      action: "interrupt",
    });

    await startFanout();
    await waitFor(() =>
      readNestedControlResults(route).some(
        (result) => result.requestId === "ownerless-request" && !result.ok,
      ),
    );

    assert.equal(fs.existsSync(requestPath), false);
    const result = readNestedControlResults(route).find(
      (item) => item.requestId === "ownerless-request",
    );
    assert.match(result?.message ?? "", /not active/);
  });

  it("clears the nested control inbox interval on reload and shutdown", async (t) => {
    const route = createNestedRoute("root-inbox-cleanup");
    routeRoots.push(path.dirname(route.eventSink));
    setNestedRouteEnv(route, "root-inbox-cleanup");
    process.env[SUBAGENT_CHILD_ENV] = "1";
    process.env[SUBAGENT_FANOUT_CHILD_ENV] = "1";

    const interval = globalThis.setInterval;
    const handles: NodeJS.Timeout[] = [];
    t.mock.method(globalThis, "setInterval", (callback: () => void, ms?: number) => {
      const handle = interval(callback, ms);
      if (ms === 200) {
        handles.push(handle);
      }
      return handle;
    });
    const cleared = t.mock.method(globalThis, "clearInterval");
    await startFanout();
    assert.equal(handles.length, 1, "registration owns one control polling interval");
    const reloaded = await startFanout();
    assert.equal(handles.length, 2, "reload creates a replacement interval");
    assert.ok(
      cleared.mock.calls.some((call) => call.arguments[0] === handles[0]),
      "reload clears the previous native timer",
    );
    await reloaded.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    assert.ok(
      cleared.mock.calls.some((call) => call.arguments[0] === handles[1]),
      "shutdown clears the replacement native timer",
    );
  });
});
