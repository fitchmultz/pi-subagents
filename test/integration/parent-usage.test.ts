import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { importSelectedNative } from "../../src/shared/native-import.ts";
import { assertDefined, textAt, record, text } from "../support/assertions.ts";
import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import type { JsonObject } from "@earendil-works/pi-ai";
import {
  type ReadonlyInput,
  SUBAGENT_LIVE_INTERCOM_EVENT,
  SUBAGENT_LIVE_INTERCOM_DELIVERY_EVENT,
  SUBAGENT_RESULT_INTERCOM_EVENT,
  SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT,
  type SubagentExecutionResult,
  type UsageContribution,
  type Usage,
} from "../../src/shared/types.ts";
import { registerParentUsage } from "../../src/runs/shared/parent-usage.ts";
import { readNativeUsage, snapshotNativeUsage } from "../../src/runs/shared/native-usage.ts";
import registerSubagents from "../../src/extension/index.ts";
import registerFanoutSubagent from "../../src/extension/fanout-child.ts";
import {
  getRunMetadataDir,
  saveQuestionOwner,
  saveQuestionContract,
  saveRunStatus,
  saveAsyncRunResult,
} from "../../src/runs/shared/supervisor-questions.ts";
import {
  createNestedRoute,
  writeNestedEvent,
  readNestedControlRequests,
  writeNestedControlResult,
} from "../../src/runs/shared/nested-events.ts";

const defined1420_0 = findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url);
assertDefined(defined1420_0);
const sdkRoot = process.env.PI_PARENT_USAGE_TEST_SDK ?? path.dirname(defined1420_0);
const sdkEntry = pathToFileURL(path.join(sdkRoot, "dist/index.js"));
const sdk = await importSelectedNative(
  import.meta.url,
  "@earendil-works/pi-coding-agent",
  sdkEntry.href,
  () => import("@earendil-works/pi-coding-agent"),
);
const defined1674_0 = findPackageJSON("@earendil-works/pi-ai", sdkEntry);
assertDefined(defined1674_0);
const aiRoot = path.dirname(defined1674_0);
const { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore } =
  await importSelectedNative(
    import.meta.url,
    "@earendil-works/pi-ai",
    pathToFileURL(path.join(aiRoot, "dist/index.js")).href,
    () => import("@earendil-works/pi-ai"),
  );
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
const contribution: UsageContribution = {
  id: "child-session:assistant-entry",
  provider: "child-provider",
  model: "actual-response-model",
  usage,
};
const result = (): SubagentExecutionResult => ({
  content: [{ type: "text", text: "Saved child result" }],
  details: { mode: "management", results: [] },
});

async function harness(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "parent-usage-"));
  const sessions = new Set<InstanceType<typeof sdk.AgentSession>>();
  async function close(session: InstanceType<typeof sdk.AgentSession>) {
    if (!sessions.delete(session)) {
      return;
    }
    await session.abort();
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
  t.after(async () => {
    for (const session of sessions) {
      // Each scenario owns shared fixture state; complete it before starting the next one.
      // oxlint-disable-next-line no-await-in-loop
      await close(session);
    }
    rmSync(root, { recursive: true, force: true });
  });
  const faux = fauxProvider({ provider: "parent-usage-fixture" });
  const modelRuntime = await sdk.ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  async function open(
    file?: string,
    delegation?: Readonly<{ tool: string; register: (pi: ExtensionAPI) => void }>,
  ) {
    let adapter!: ReturnType<typeof registerParentUsage>;
    let ctx!: ExtensionContext;
    let contributions: readonly UsageContribution[] = [contribution];
    const errors: unknown[] = [];
    const settingsManager = sdk.SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const loader = new sdk.DefaultResourceLoader({
      cwd: root,
      agentDir: root,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        (pi: ExtensionAPI) => {
          adapter = registerParentUsage(pi, ["usage_wait"]);
          pi.on("session_start", (_event, context) => {
            ctx = context;
          });
          pi.registerTool({
            name: "usage_wait",
            label: "Usage wait",
            description: "Read a finalized fixture child",
            parameters: Type.Object({
              discard: Type.Optional(Type.Boolean()),
              inspect: Type.Optional(Type.Boolean()),
            }),
            async execute(_id, params, signal, onUpdate, context) {
              onUpdate?.(result());
              if (params.inspect === true) {
                return result();
              }
              const final = adapter.attach(result(), contributions, context);
              if (params.discard === true) {
                context.abort();
                assert.equal(signal?.aborted, true);
                throw new DOMException("Wait aborted before returning its result", "AbortError");
              }
              return final;
            },
          });
          delegation?.register(pi);
        },
      ],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const { session } = await sdk.createAgentSession({
      cwd: root,
      agentDir: root,
      modelRuntime,
      model: faux.getModel(),
      settingsManager,
      resourceLoader: loader,
      sessionManager:
        file !== undefined && file.length > 0
          ? sdk.SessionManager.open(file)
          : sdk.SessionManager.create(root, path.join(root, "sessions")),
      tools: ["usage_wait", ...(delegation ? [delegation.tool] : [])],
    });
    sessions.add(session);
    await session.bindExtensions({
      mode: "print",
      onError: (error: unknown) => {
        errors.push(error);
      },
    });
    const invoke = async (tool: string, ...args: readonly ReadonlyInput<JsonObject>[]) => {
      faux.setResponses([
        fauxAssistantMessage(
          args.map((params) => fauxToolCall(tool, params)),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("Done"),
      ]);
      await session.prompt("Read saved child work");
      assert.deepEqual(errors, []);
    };
    return {
      session,
      adapter,
      ctx,
      invoke,
      wait: (...args: readonly ReadonlyInput<JsonObject>[]) => invoke("usage_wait", ...args),
      setContributions(value: readonly UsageContribution[]) {
        contributions = value;
      },
    };
  }
  return { open, close };
}

function toolMessages(session: AgentSession) {
  return session.sessionManager
    .getEntries()
    .flatMap((entry) =>
      entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : [],
    );
}

test("portable concurrent final waits charge once in native journal and survive a fresh session reader", async (t) => {
  const h = await harness(t);
  const first = await h.open();
  await first.wait({}, {});
  assert.equal(first.session.getSessionStats().cost, 10);
  assert.deepEqual(
    toolMessages(first.session).map((message) => message.usage),
    [usage, undefined],
  );
  const file = first.session.sessionManager.getSessionFile();
  assertDefined(file);
  assert.equal(
    readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.includes('"role":"toolResult"') && line.includes('"parentUsage"'))
      .length,
    1,
  );
  await h.close(first.session);
  const resumed = await h.open(file);
  await resumed.wait({});
  assert.equal(resumed.session.getSessionStats().cost, 10);
  const resumedResult = toolMessages(resumed.session).at(-1);
  assertDefined(resumedResult);
  assert.equal(resumedResult.usage, undefined);
  resumed.setContributions([contribution, { ...contribution, id: "child-session:resumed-entry" }]);
  await resumed.wait({});
  assert.equal(resumed.session.getSessionStats().cost, 20, "only resumed child work is new");
});

test("portable discarded result does not reserve usage; inspection and custom details never charge", async (t) => {
  const h = await harness(t);
  const { session, adapter, ctx, wait } = await h.open();
  const prepared = adapter.attach(result(), [contribution], ctx);
  session.sessionManager.appendCustomMessageEntry("subagent-notify", "finished", false, {
    result: prepared,
  });
  await wait({ inspect: true }, { discard: true });
  assert.equal(session.getSessionStats().cost, 0);
  assert.ok(toolMessages(session).every((message) => message.usage === undefined));
  await wait({}, {});
  assert.equal(session.getSessionStats().cost, 10);
  assert.deepEqual(
    toolMessages(session)
      .slice(-2)
      .map((message) => message.usage),
    [usage, undefined],
  );
});

for (const surface of ["parent", "child-advanced", "child-compact"]) {
  test(`${surface} nested continuation charges only the later direct-child journal delta`, async (t) => {
    const childSafe = surface !== "parent",
      advanced = surface === "child-advanced";
    const h = await harness(t),
      child = await h.open(),
      original = await h.open();
    await child.wait({ inspect: true });
    // Native journals buffer pre-response entries; persist the parent before reopening it.
    await original.wait({ inspect: true });
    const childFile = child.session.sessionManager.getSessionFile(),
      baseline = snapshotNativeUsage(childFile);
    const parentId = original.session.sessionManager.getSessionId();
    const rootId = randomUUID(),
      nestedId = randomUUID(),
      rootDir = getRunMetadataDir(rootId),
      nestedDir = getRunMetadataDir(nestedId),
      route = createNestedRoute(rootId);
    const cwd = child.ctx.cwd;
    const owner = {
      runId: rootId,
      rootRunId: rootId,
      ownerSessionId: parentId,
      source: "async",
      mode: "single",
      cwd,
      task: "Direct child",
      startedAt: Date.now(),
      asyncDir: rootDir,
      children: [{ agent: "worker", index: 0, sessionFile: childFile }],
    };
    original.session.sessionManager.appendCustomEntry("subagent-run", owner);
    const savedParentFile = original.session.sessionManager.getSessionFile();
    saveQuestionOwner(rootId, parentId);
    saveQuestionOwner(nestedId, child.session.sessionManager.getSessionId());
    for (const [id, sessionId] of [
      [rootId, savedParentFile],
      [nestedId, childFile],
    ] as const) {
      assertDefined(id);
      saveRunStatus(id, {
        runtimeVersion: 2,
        runId: id,
        sessionId,
        mode: "single",
        state: "running",
        pid: process.pid,
        startedAt: Date.now(),
        cwd,
        controlRequestFiles: true,
        steps: [
          {
            agent: "worker",
            status: "running",
            ...(id === rootId ? { sessionFile: childFile } : {}),
          },
        ],
      });
    }
    saveQuestionContract(rootId, 0, { task: "Direct child", sessionFile: childFile });
    saveQuestionContract(nestedId, 0, { task: "Grandchild work" });
    writeFileSync(
      path.join(nestedDir, "launch.json"),
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
        id: nestedId,
        parentRunId: rootId,
        parentStepIndex: 0,
        depth: 1,
        path: [{ runId: rootId, stepIndex: 0 }],
        state: "running",
        mode: "single",
        agent: "worker",
        asyncDir: nestedDir,
      },
    });
    const env = {
      PI_SUBAGENT_CHILD: "1",
      PI_SUBAGENT_FANOUT_CHILD: "1",
      PI_SUBAGENT_PARENT_ROOT_RUN_ID: rootId,
      PI_SUBAGENT_PARENT_RUN_ID: rootId,
      PI_SUBAGENT_PARENT_CHILD_INDEX: "0",
      PI_SUBAGENT_PARENT_EVENT_SINK: route.eventSink,
      PI_SUBAGENT_PARENT_CONTROL_INBOX: route.controlInbox,
      PI_SUBAGENT_PARENT_CAPABILITY_TOKEN: route.capabilityToken,
    };
    const savedEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    if (childSafe) {
      Object.assign(process.env, env);
    }
    await h.close(original.session);
    const direct: { usage: Usage | undefined } = { usage: undefined };
    const parent = await h.open(savedParentFile, {
      tool: advanced ? "subagent" : "agent_runs",
      register(pi) {
        (childSafe ? registerFanoutSubagent : registerSubagents)(pi);
        for (const [send, delivered] of [
          [SUBAGENT_LIVE_INTERCOM_EVENT, SUBAGENT_LIVE_INTERCOM_DELIVERY_EVENT],
          [SUBAGENT_RESULT_INTERCOM_EVENT, SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT],
        ] as const) {
          pi.events.on(send, (request) => {
            const payload = record(request);
            if (payload.runId !== rootId) {
              return;
            }
            saveAsyncRunResult(rootId, {
              runtimeVersion: 2,
              id: rootId,
              state: "complete",
              success: true,
              results: [
                {
                  agent: "worker",
                  success: true,
                  exitCode: 0,
                  output: "Direct child completed",
                  sessionFile: childFile,
                  usage: direct.usage,
                },
              ],
            });
            pi.events.emit(delivered, { requestId: text(payload.requestId), delivered: true });
          });
        }
      },
    });
    let delivered = false;
    const reply = setInterval(() => {
      const request = readNestedControlRequests(route).at(0);
      if (!request || delivered) {
        return;
      }
      delivered = true;
      saveAsyncRunResult(nestedId, {
        runtimeVersion: 2,
        id: nestedId,
        state: "complete",
        success: true,
        results: [
          {
            agent: "worker",
            success: true,
            exitCode: 0,
            output: "Grandchild completed",
            usage: {
              input: 10,
              output: 20,
              cacheRead: 30,
              cacheWrite: 40,
              cost: 10,
              turns: 1,
              contributions: [contribution],
            },
          },
        ],
      });
      writeNestedControlResult(route, {
        ts: Date.now(),
        requestId: request.requestId,
        targetRunId: nestedId,
        ok: true,
        message: "Nested guidance delivered",
      });
    }, 10);
    t.after(() => {
      clearInterval(reply);
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      for (const dir of [rootDir, nestedDir, path.dirname(route.eventSink)]) {
        rmSync(dir, { recursive: true, force: true });
      }
    });
    const tool = advanced ? "subagent" : "agent_runs",
      action = advanced ? "resume" : "continue";
    await parent.invoke(tool, { action, id: nestedId, message: "Finish grandchild", async: false });
    const nestedResult = toolMessages(parent.session).at(-1);
    assertDefined(nestedResult);
    assert.equal(nestedResult.isError, false, textAt(nestedResult.content));
    assertDefined(nestedResult);
    assert.match(textAt(nestedResult.content), /Grandchild completed/);
    assertDefined(nestedResult);
    assert.equal(
      record(record(nestedResult.details).run).ownerSessionId,
      child.session.sessionManager.getSessionId(),
    );
    assert.equal(
      parent.session.getSessionStats().cost,
      0,
      "observing a descendant must not charge it directly to the ancestor",
    );
    await child.wait({}, {});
    const nativeUsage = readNativeUsage(childFile, baseline);
    assertDefined(nativeUsage);
    const directUsage = nativeUsage[0];
    direct.usage = directUsage;
    assertDefined(directUsage);
    assert.equal(directUsage.cost, 10);
    assertDefined(directUsage.contributions);
    assert.ok(directUsage.contributions.every((item) => item.id !== contribution.id));
    await parent.invoke(tool, { action, id: rootId, message: "Finish direct child", async: false });
    const directResult = toolMessages(parent.session).at(-1);
    assertDefined(directResult);
    assert.match(textAt(directResult.content), /Direct child completed/);
    assert.equal(
      parent.session.getSessionStats().cost,
      10,
      "the direct child's native journal delta is charged exactly once",
    );
    await parent.invoke(tool, { action: advanced ? "status" : "inspect", id: rootId });
    assert.equal(parent.session.getSessionStats().cost, 10);
  });
}
