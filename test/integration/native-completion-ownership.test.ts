import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { after, test, type TestContext } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  AgentSession,
  CreateAgentSessionRuntimeFactory,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { AsyncResultFile, SubagentState } from "../../src/shared/types.ts";
import type { ReadonlyDeep } from "type-fest";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { nativeSdkRoot } from "../support/native-sdk.ts";
import { assertDefined, record, json, text, readJson } from "../support/assertions.ts";
import { Type } from "typebox";

async function until(check: () => boolean, reason: string) {
  const deadline = performance.now() + 5_000;
  while (!check()) {
    assert.ok(performance.now() < deadline, reason);
    // Wait for the real native lifecycle/publication boundary before the next operation.
    // oxlint-disable-next-line no-await-in-loop
    await delay(10);
  }
}

const root = fs.mkdtempSync(path.join(tmpdir(), "native-completion-ownership-"));
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
process.env.PI_SUBAGENT_TEMP_ROOT = path.join(root, "pi-subagents-runtime");
process.env.PI_OFFLINE = "1";
after(() => fs.rmSync(root, { recursive: true, force: true }));
const sdkRoot = nativeSdkRoot(process.env.PI_INTERCOM_TEST_SDK);
process.env.PI_PACKAGE_DIR = sdkRoot;
const sdk = await import("@earendil-works/pi-coding-agent");
const ai = await import("@earendil-works/pi-ai");
const {
  getRunMetadataDir,
  saveQuestionOwner,
  saveRunStatus,
  saveAsyncRunResult,
  createSupervisorQuestion,
  saveQuestionAnswer,
  recordQuestionDelivery,
  saveQuestionContract,
} = await import("../../src/runs/shared/supervisor-questions.ts");
const { RESULTS_DIR } = await import("../../src/shared/types.ts");
const { default: registerRoot } = await import("../../src/extension/index.ts");
const { default: registerChild } = await import("../../src/extension/fanout-child.ts");
const { createCompletionDelivery } =
  await import("../../src/runs/background/completion-delivery.ts");
const { registerParentUsage } = await import("../../src/runs/shared/parent-usage.ts");
function sessionFile(manager: SessionManager): string {
  const file = manager.getSessionFile();
  assertDefined(file);
  return file;
}
function deliveryState(cwd: string): SubagentState {
  return {
    baseCwd: cwd,
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
      clear() {
        // This independent native controller registers admission lifecycle only, not a file coalescer.
      },
    },
  };
}

function setChildMode(t: TestContext, childSafe: boolean): void {
  const previous = {
    PI_SUBAGENT_CHILD: process.env.PI_SUBAGENT_CHILD,
    PI_SUBAGENT_FANOUT_CHILD: process.env.PI_SUBAGENT_FANOUT_CHILD,
  };
  process.env.PI_SUBAGENT_CHILD = childSafe ? "1" : "0";
  process.env.PI_SUBAGENT_FANOUT_CHILD = childSafe ? "1" : "0";
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

function archivePendingChildren(
  manager: SessionManager,
  cwd: string,
  count: number,
  unowned: boolean,
): string[] {
  const runIds = Array.from({ length: count }, () => randomUUID());
  if (!unowned) {
    for (const id of runIds) {
      manager.appendCustomEntry("subagent-run", {
        runId: id,
        rootRunId: id,
        ownerSessionId: manager.getSessionId(),
        source: "async",
        mode: "single",
        cwd,
        task: "Bounded work",
        startedAt: Date.now(),
        asyncDir: getRunMetadataDir(id),
        children: [{ agent: "worker", index: 0 }],
      });
      saveQuestionOwner(id, manager.getSessionId());
    }
  }
  return runIds;
}

function completedChildResult(
  manager: SessionManager,
  runId: string,
  unowned: boolean,
): AsyncResultFile {
  return {
    runtimeVersion: unowned ? undefined : 2,
    id: runId,
    mode: "single",
    sessionId: unowned ? manager.getSessionId() : sessionFile(manager),
    state: "complete",
    success: true,
    timestamp: Date.now(),
    summary: "QUEUED_RESULT",
    results: [{ agent: "worker", success: true, exitCode: 0, output: "QUEUED_RESULT" }],
  };
}

function publishChildCompletions(
  manager: SessionManager,
  cwd: string,
  runIds: readonly string[],
  unowned: boolean,
  result: ReadonlyDeep<AsyncResultFile>,
): void {
  for (const id of runIds) {
    if (!unowned) {
      saveRunStatus(id, {
        runtimeVersion: 2,
        runId: id,
        mode: "single",
        sessionId: sessionFile(manager),
        state: "complete",
        startedAt: Date.now(),
        lastUpdate: Date.now(),
        cwd,
        steps: [{ agent: "worker", status: "complete" }],
      });
    }
    const completion = { ...result, id };
    if (unowned) {
      fs.writeFileSync(path.join(RESULTS_DIR, `${id}.json`), JSON.stringify(completion));
    } else {
      saveAsyncRunResult(id, completion);
    }
  }
}

async function createQueuedOwner(
  t: TestContext,
  manager: SessionManager,
  cwd: string,
  childSafe: boolean,
  interruptReload: boolean,
) {
  const sent: Array<Parameters<ExtensionAPI["sendMessage"]>[0]> = [];
  const errors: unknown[] = [];
  const lifetime: { factoryRuns: number; release?: () => void; context?: ExtensionContext } = {
    factoryRuns: 0,
  };
  const settingsManager = sdk.SettingsManager.inMemory({
    retry: { enabled: false },
    compaction: { enabled: false },
    cacheWarming: "off",
  });
  const loader = new sdk.DefaultResourceLoader({
    cwd,
    agentDir: path.join(root, "agent"),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    noThemes: true,
    noPromptTemplates: true,
    extensionFactories: [
      (pi) => {
        lifetime.factoryRuns++;
        const send = pi.sendMessage.bind(pi);
        const observedSend: ExtensionAPI["sendMessage"] = (message, options) => {
          if (message.customType === "subagent-notify") {
            sent.push(message);
          }
          send(message, options);
        };
        t.mock.method(pi, "sendMessage", observedSend);
        (childSafe ? registerChild : registerRoot)(pi);
        pi.on("session_start", (_event, context) => {
          lifetime.context = context;
        });
        pi.registerTool({
          name: "hold_turn",
          label: "Hold",
          description: "Hold this fixture turn",
          parameters: Type.Object({}),
          async execute(_id, _params, signal) {
            await new Promise<void>((resolve) => {
              lifetime.release = resolve;
              signal?.addEventListener("abort", () => resolve(), { once: true });
            });
            return { content: [{ type: "text", text: "Released" }], details: {} };
          },
        });
      },
    ],
  });
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const faux = ai.fauxProvider({ provider: "queued-completion-fixture", tokensPerSecond: 1000000 });
  faux.setResponses([
    interruptReload
      ? async (_context, options) => {
          await new Promise<void>((resolve) => {
            lifetime.release = resolve;
            options?.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          return ai.fauxAssistantMessage("Held response");
        }
      : ai.fauxAssistantMessage(ai.fauxToolCall("hold_turn", {}, { id: "hold" }), {
          stopReason: "toolUse",
        }),
    ai.fauxAssistantMessage("Finished held turn"),
    ai.fauxAssistantMessage("Completion received"),
  ]);
  const modelRuntime = await sdk.ModelRuntime.create({
    credentials: new ai.InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const { session } = await sdk.createAgentSession({
    cwd,
    agentDir: path.join(root, "agent"),
    settingsManager,
    resourceLoader: loader,
    sessionManager: manager,
    modelRuntime,
    model: faux.getModel(),
  });
  return {
    session,
    sent,
    errors,
    faux,
    settingsManager,
    lifetime,
    context: () => {
      assertDefined(lifetime.context);
      return lifetime.context;
    },
  };
}

async function verifyIndependentController(
  t: TestContext,
  manager: SessionManager,
  first: AgentSession,
  recreateNotice: () => void,
  expectedCount: number,
  observedCount: () => number,
): Promise<void> {
  const cwd = fs.mkdtempSync(path.join(root, "other-controller-"));
  const settingsManager = sdk.SettingsManager.inMemory({
    retry: { enabled: false },
    compaction: { enabled: false },
    cacheWarming: "off",
  });
  const errors: unknown[] = [];
  const loader = new sdk.DefaultResourceLoader({
    cwd,
    agentDir: path.join(root, "agent"),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    noThemes: true,
    noPromptTemplates: true,
    extensionFactories: [
      (pi) => {
        // An independent admission controller must not stop the first root's watcher.
        createCompletionDelivery(pi, deliveryState(cwd), registerParentUsage(pi, []));
      },
    ],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const faux = ai.fauxProvider({ provider: "other-controller-fixture", tokensPerSecond: 1000000 });
  faux.setResponses([ai.fauxAssistantMessage("Other controller settled")]);
  const modelRuntime = await sdk.ModelRuntime.create({
    credentials: new ai.InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const { session } = await sdk.createAgentSession({
    cwd,
    agentDir: path.join(root, "agent"),
    settingsManager,
    resourceLoader: loader,
    modelRuntime,
    model: faux.getModel(),
    sessionManager: sdk.SessionManager.create(cwd, path.join(cwd, "sessions")),
  });
  try {
    await session.bindExtensions({
      mode: "json",
      onError: (error) => {
        errors.push(error);
      },
    });
    await session.prompt("Settle this independent native controller");
    await session.waitForIdle();
    assert.equal(
      first.agent.hasQueuedMessages(),
      true,
      "the first controller's actual custom queue is still pending",
    );
    const nativeReads = t.mock.method(manager, "getSessionFile");
    nativeReads.mock.resetCalls();
    recreateNotice();
    t.mock.timers.tick(11 * 60_000);
    await until(
      () => nativeReads.mock.callCount() > 0,
      "the original owner reconciles the replay against its native receipt source",
    );
    nativeReads.mock.restore();
    assert.equal(
      observedCount(),
      expectedCount,
      "another controller's turn/settlement cannot retire the pending identity and admit a duplicate",
    );
    assert.deepEqual(errors, []);
  } finally {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
}

function assertPublishedCompletions(manager: SessionManager, runIds: readonly string[]): void {
  const published = fs
    .readFileSync(sessionFile(manager), "utf8")
    .trim()
    .split("\n")
    .map(json)
    .filter((entry) => entry.type === "custom_message" && entry.customType === "subagent-notify");
  assert.equal(
    published.length,
    runIds.length,
    "each completion has exactly one physical native journal notice",
  );
  assert.deepEqual(
    published
      .map((entry) => text(record(record(entry.details).completion).runId))
      .sort((a, b) => a.localeCompare(b)),
    [...runIds].sort((a, b) => a.localeCompare(b)),
  );
  assert.equal(
    new Set(published.map((entry) => text(record(record(entry.details).completion).key))).size,
    runIds.length,
  );
}

test("legacy-only completion survives a native queued crash and fresh-process recovery without replay or fabricated ownership", () => {
  const proofRoot = fs.mkdtempSync(path.join(root, "cold-"));
  const run = (mode: string) =>
    spawnSync(
      process.execPath,
      [
        path.resolve("test/fixtures/native-legacy-completion.mjs"),
        mode,
        proofRoot,
        process.cwd(),
        sdkRoot,
      ],
      { encoding: "utf8", timeout: 15_000 },
    );
  const readProof = (mode: string) => readJson(path.join(proofRoot, `${mode}-proof.json`));
  const queued = run("queue");
  assert.equal(queued.error, undefined);
  assert.equal(queued.signal, "SIGKILL", queued.stderr);
  assert.deepEqual(
    readProof("queue"),
    {
      mode: "queue",
      hintExists: true,
      canonicalExists: false,
      queued: true,
      persistedNotices: 0,
      ownedEntries: 0,
      sent: 1,
      calls: 1,
      errors: [],
    },
    "accepted native steering retains the sole legacy result until publication",
  );
  for (const mode of ["reopen", "again"]) {
    const result = run(mode);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readProof(mode), {
      mode,
      ...(mode === "reopen" ? { hintExists: false } : {}),
      sent: mode === "reopen" ? 1 : 0,
      calls: mode === "reopen" ? 1 : 0,
      persistedNotices: 1,
      ownedEntries: 0,
      errors: [],
    });
  }
});

for (const childSafe of [false, true]) {
  for (const drop of [false, true]) {
    for (const unowned of [false, true]) {
      const interruptReload = !childSafe && !drop;
      test(`${childSafe ? "child-safe" : "root"} ${unowned ? "unowned legacy" : "owned"} queued completion ${drop ? "retries once after being dropped" : "survives streaming beyond the TTL"}${interruptReload ? " and abort/reload" : ""}`, async (t) => {
        setChildMode(t, childSafe);
        const cwd = fs.mkdtempSync(path.join(root, "queued-"));
        const manager = sdk.SessionManager.create(cwd, path.join(cwd, "sessions"));
        manager.appendMessage(ai.fauxAssistantMessage("Delegate bounded work"));
        const queuedCount = interruptReload ? 2 : 1;
        const runIds = archivePendingChildren(manager, cwd, queuedCount, unowned),
          runId = runIds[0];
        const { session, sent, errors, faux, lifetime, context } = await createQueuedOwner(
          t,
          manager,
          cwd,
          childSafe,
          interruptReload,
        );
        const notices = () =>
          manager
            .getEntries()
            .filter(
              (entry) => entry.type === "custom_message" && entry.customType === "subagent-notify",
            );
        const scans = t.mock.method(manager, "getSessionFile");
        const delivered = () =>
          manager
            .getEntries()
            .some(
              (entry) =>
                entry.type === "custom" &&
                entry.customType === "subagent-run" &&
                record(entry.data).runId === runId &&
                Boolean(record(entry.data).delivery),
            );
        // Until extension binding completes there is no active native parent turn to join.
        let prompt: Promise<void> = Promise.resolve();
        try {
          await session.bindExtensions({
            mode: "json",
            onError: (error) => {
              errors.push(error);
            },
          });
          prompt = session.prompt("Hold the parent turn while its child completes");
          await until(() => lifetime.release !== undefined, "native parent turn starts");
          assert.equal(context().isIdle(), false);
          const result = completedChildResult(manager, runId, unowned);
          const notice = path.join(RESULTS_DIR, `${runId}.json`);
          const recreateNotice = () => {
            scans.mock.resetCalls();
            fs.writeFileSync(notice, JSON.stringify(result));
          };
          const awaitHintReconciliation = async (reason: string) => {
            if (unowned) {
              await until(() => scans.mock.callCount() > 0, reason);
              assert.ok(
                fs.existsSync(notice),
                "a queued legacy-only result stays recoverable until its actual published receipt",
              );
            } else {
              await until(() => !fs.existsSync(notice), reason);
            }
          };
          publishChildCompletions(manager, cwd, runIds, unowned, result);
          t.mock.timers.tick(3000);
          await until(() => sent.length === queuedCount, "completions reach the real host queue");
          assert.equal(notices().length, 0);
          assert.equal(delivered(), false, "queued is not durably delivered");
          assert.equal(session.agent.hasQueuedMessages(), true);
          if (drop) {
            session.clearQueue();
            assert.equal(
              session.agent.hasQueuedMessages(),
              false,
              "the real host dropped the queued wake-up",
            );
            if (unowned) {
              recreateNotice();
            }
          } else {
            for (let scan = 0; scan < 2; scan++) {
              if (unowned) {
                recreateNotice();
              }
              scans.mock.resetCalls();
              t.mock.timers.tick(11 * 60_000);
              // This owner must inspect the preceding queue/receipt before the next TTL advance.
              // oxlint-disable-next-line no-await-in-loop
              await until(
                () => scans.mock.callCount() > 0,
                "native receipt source observes the streaming TTL scan",
              );
              assert.equal(
                sent.length,
                queuedCount,
                "streaming past TTL must not queue another wake-up",
              );
            }
          }
          if (unowned && interruptReload) {
            await verifyIndependentController(
              t,
              manager,
              session,
              recreateNotice,
              queuedCount,
              () => sent.length,
            );
          }
          if (interruptReload) {
            recreateNotice();
            t.mock.timers.tick(3000);
            await awaitHintReconciliation("the first watcher remains active before abort/reload");
            assert.equal(sent.length, queuedCount);
            await session.abort();
            await prompt;
            assert.equal(context().isIdle(), true);
            assert.equal(
              session.agent.hasQueuedMessages(),
              true,
              "abort settles without consuming the native custom queue",
            );
            recreateNotice();
            t.mock.timers.tick(11 * 60_000);
            await awaitHintReconciliation(
              "the active aborted owner's watcher reconciles recreated input",
            );
            assert.equal(
              sent.length,
              queuedCount,
              "an idle aborted parent must not duplicate either still-pending custom message",
            );
            assert.equal(
              notices().length,
              0,
              "a watcher scan must not start a recovery turn while native completions remain queued",
            );
            assert.equal(lifetime.factoryRuns, 1);
            await session.reload();
            assert.equal(
              lifetime.factoryRuns,
              2,
              "native reload replaces the extension controller",
            );
            recreateNotice();
            t.mock.timers.tick(11 * 60_000);
            await awaitHintReconciliation(
              "the replacement watcher actively reconciles recreated input",
            );
            await session.waitForIdle();
            assert.equal(
              sent.length,
              queuedCount,
              "reload preserves all actual pending admissions rather than sending another notice",
            );
            assert.equal(
              notices().length,
              0,
              "native reload has not consumed the pending completion",
            );
            assert.equal(session.agent.hasQueuedMessages(), true);
            prompt = session.prompt("Resume the parent and consume its pending completion");
          }
          assertDefined(lifetime.release);
          lifetime.release();
          await prompt;
          await session.waitForIdle();
          assert.equal(context().isIdle(), true);
          if (drop) {
            assert.equal(notices().length, 0);
            t.mock.timers.tick(3000);
            await until(
              () => sent.length === 2 && notices().length === 1,
              "idle owner receives one retry without waiting for the TTL",
            );
            await session.waitForIdle();
          }
          t.mock.timers.tick(3000);
          if (!unowned) {
            await until(delivered, "journal reconciliation records delivery");
          }
          t.mock.timers.tick(11 * 60_000);
          await delay(50);
          assert.equal(sent.length, drop ? 2 : queuedCount);
          assert.equal(notices().length, queuedCount);
          assertPublishedCompletions(manager, runIds);
          if (interruptReload) {
            assert.equal(
              faux.state.callCount,
              3,
              "only the aborted request and explicit two-completion continuation run",
            );
          }
          if (unowned) {
            assert.equal(
              delivered(),
              false,
              "native receipt authority does not fabricate an owned-run projection",
            );
            assert.equal(
              session.agent.hasQueuedMessages(),
              false,
              "the native owner has consumed or dropped every runless admission",
            );
          }
          assert.deepEqual(errors, []);
        } finally {
          lifetime.release?.();
          await session.abort();
          await prompt.catch(() => {
            // Teardown abort rejection is already reported by the awaited scenario operation.
          });
          await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
          session.dispose();
        }
      });
    }
  }
}

for (const scenario of [
  {
    name: "repeat native startup joins in-flight delivery before replacing the completion listeners",
    shutdown: false,
    childSafe: false,
    unowned: false,
    delivered: false,
  },
  {
    name: "native shutdown retains failed in-flight completion for session reopen",
    shutdown: true,
    childSafe: false,
    unowned: false,
    delivered: false,
  },
  {
    name: "child-safe native shutdown retains failed in-flight completion for session reopen",
    shutdown: true,
    childSafe: true,
    unowned: false,
    delivered: false,
  },
  {
    name: "native shutdown retains an unowned legacy completion for session reopen",
    shutdown: true,
    childSafe: false,
    unowned: true,
    delivered: false,
  },
  {
    name: "native shutdown preserves an acknowledged Intercom completion without fabricating a published receipt",
    shutdown: true,
    childSafe: false,
    unowned: false,
    delivered: true,
  },
]) {
  test(scenario.name, async (t) => {
    setChildMode(t, scenario.childSafe);
    const cwd = fs.mkdtempSync(path.join(root, "rebinding-"));
    const manager = sdk.SessionManager.create(cwd, path.join(cwd, "sessions"));
    manager.appendMessage(ai.fauxAssistantMessage("Retain saved child work"));
    for (let index = 0; index < 64; index++) {
      manager.appendCustomEntry("fixture", {});
    }
    const runId = randomUUID(),
      asyncDir = getRunMetadataDir(runId);
    if (!scenario.unowned) {
      manager.appendCustomEntry("subagent-run", {
        runId,
        rootRunId: runId,
        ownerSessionId: manager.getSessionId(),
        source: "async",
        mode: "single",
        cwd,
        task: "Bounded work",
        startedAt: 1,
        asyncDir,
        children: [{ agent: "worker", index: 0 }],
      });
      saveQuestionOwner(runId, manager.getSessionId());
      saveRunStatus(runId, {
        runtimeVersion: 2,
        runId,
        sessionId: manager.getSessionId(),
        mode: "single",
        state: "complete",
        startedAt: 1,
        endedAt: 2,
        steps: [{ agent: "worker", status: "complete" }],
      });
    }
    const result: AsyncResultFile = {
      runtimeVersion: scenario.unowned ? undefined : 2,
      id: runId,
      sessionId: manager.getSessionId(),
      mode: "single",
      state: "complete",
      success: true,
      timestamp: 2,
      summary: "Retained completion",
      intercomTarget: "fixture-parent",
      results: [{ agent: "worker", success: true, exitCode: 0, output: "Retained completion" }],
    };
    const hint = path.join(RESULTS_DIR, `${runId}.json`);
    if (scenario.unowned) {
      fs.mkdirSync(RESULTS_DIR, { recursive: true });
      fs.writeFileSync(hint, JSON.stringify(result));
    } else {
      saveAsyncRunResult(runId, result);
    }
    const bus = sdk.createEventBus(),
      errors: unknown[] = [];
    let request: { requestId: string } | undefined;
    bus.on("subagent:result-intercom", (data) => {
      request = { requestId: text(record(data).requestId) };
    });
    const settingsManager = sdk.SettingsManager.inMemory({
      retry: { enabled: false },
      compaction: { enabled: false },
      cacheWarming: "off",
    });
    const faux = ai.fauxProvider({
      provider: "rebinding-completion-fixture",
      tokensPerSecond: 1000000,
    });
    faux.setResponses([ai.fauxAssistantMessage("Completion received")]);
    const modelRuntime = await sdk.ModelRuntime.create({
      credentials: new ai.InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    const createRuntime: CreateAgentSessionRuntimeFactory = async ({ sessionManager }) => {
      const services = await sdk.createAgentSessionServices({
        cwd,
        agentDir: path.join(root, "agent"),
        settingsManager,
        modelRuntime,
        resourceLoaderOptions: {
          eventBus: bus,
          noExtensions: true,
          noSkills: true,
          noContextFiles: true,
          noThemes: true,
          noPromptTemplates: true,
          additionalExtensionPaths: [
            path.resolve(
              scenario.childSafe ? "src/extension/fanout-child.ts" : "src/extension/index.ts",
            ),
          ],
        },
      });
      assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
      return {
        ...(await sdk.createAgentSessionFromServices({
          services,
          sessionManager,
          model: faux.getModel(),
          tools: ["subagent", "agent_runs"],
        })),
        services,
        diagnostics: services.diagnostics,
      };
    };
    let runtime = await sdk.createAgentSessionRuntime(createRuntime, {
      cwd,
      agentDir: path.join(root, "agent"),
      sessionManager: manager,
    });
    let disposed = false;
    const notices = () =>
      runtime.session.sessionManager
        .getEntries()
        .filter(
          (entry) => entry.type === "custom_message" && entry.customType === "subagent-notify",
        );
    const projection = () => {
      const entry = runtime.session.sessionManager
        .getEntries()
        .findLast(
          (candidate) =>
            candidate.type === "custom" &&
            candidate.customType === "subagent-run" &&
            record(candidate.data).runId === runId,
        );
      return entry === undefined ? undefined : record(record(entry).data);
    };
    try {
      const bindings: NonNullable<Parameters<AgentSession["bindExtensions"]>[0]> = {
        mode: "json",
        onError: (error) => {
          errors.push(error);
        },
      };
      await runtime.session.bindExtensions(bindings);
      await until(() => request !== undefined, "the first watcher starts Intercom delivery");
      disposed = scenario.shutdown;
      const transition = scenario.shutdown
        ? runtime.dispose()
        : runtime.session.bindExtensions(bindings);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      bus.emit("subagent:result-intercom-delivery", {
        requestId: text(record(request).requestId),
        delivered: scenario.delivered,
      });
      await transition;
      if (scenario.shutdown) {
        assert.deepEqual(
          errors,
          [],
          "shutdown must not request a new native turn after ingress closes",
        );
        assert.equal(faux.state.callCount, 0);
        assert.equal(notices().length, 0);
        assert.equal(
          fs.existsSync(hint),
          scenario.unowned && !scenario.delivered,
          "unacknowledged legacy-only input remains available",
        );
        assert.equal(fs.existsSync(path.join(asyncDir, "result.json")), !scenario.unowned);
        assert.equal(
          projection()?.delivery,
          undefined,
          "acknowledgement alone is not a published parent receipt",
        );
        if (scenario.delivered) {
          assert.equal(record(record(projection()).completion).state, "queued");
          assert.equal(
            record(record(projection()).completion).channel,
            "intercom",
            "listeners retain the remote acknowledgement before stopping",
          );
          return;
        }
        assert.notEqual(
          projection()?.completion === undefined
            ? undefined
            : record(record(projection()).completion).state,
          "queued",
          "an undelivered result must remain eligible",
        );
        request = undefined;
        runtime = await sdk.createAgentSessionRuntime(createRuntime, {
          cwd,
          agentDir: path.join(root, "agent"),
          sessionManager: sdk.SessionManager.open(sessionFile(manager)),
        });
        disposed = false;
        await runtime.session.bindExtensions(bindings);
        await until(
          () => request !== undefined,
          "reopened session retries the retained completion",
        );
        bus.emit("subagent:result-intercom-delivery", {
          requestId: text(record(request).requestId),
          delivered: false,
        });
      }
      await until(
        () => notices().length > 0,
        "failed in-flight Intercom delivery publishes its fallback during startup or reopen",
      );
      await runtime.session.waitForIdle();
      assert.equal(notices().length, 1, "the retained result is delivered exactly once");
      if (!scenario.unowned) {
        await until(() => {
          const delivery = projection()?.delivery;
          return delivery !== undefined && Boolean(record(delivery).entryId);
        }, "the owner reconciles its published receipt");
        assert.equal(record(record(projection()).delivery).entryId, notices()[0].id);
      }
      if (scenario.unowned) {
        await until(
          () => !fs.existsSync(hint),
          "the published legacy receipt, not fallback queue admission, retires the sole result",
        );
      }
      assert.equal(fs.existsSync(hint), false);
      assert.equal(fs.existsSync(path.join(asyncDir, "result.json")), !scenario.unowned);
      assert.deepEqual(errors, []);
    } finally {
      if (!disposed) {
        await runtime.session.abort();
        await runtime.dispose();
      }
    }
  });
}

interface CompletionScenario {
  readonly name: string;
  readonly kind: "launch" | "answer" | "delivery";
  readonly index?: number;
  readonly finished: boolean;
  readonly suppress: boolean;
  readonly mode?: "single" | "parallel";
  readonly receipt?: boolean;
  readonly unowned?: boolean;
  readonly published?: boolean;
  readonly failed?: boolean;
}
const completionScenarios: readonly CompletionScenario[] = [
  {
    name: "unowned legacy completion",
    kind: "launch",
    index: undefined,
    finished: true,
    receipt: true,
    unowned: true,
    suppress: false,
  },
  {
    name: "background launch receipt",
    kind: "launch",
    index: undefined,
    finished: true,
    receipt: true,
    suppress: false,
  },
  { name: "completed child answer", kind: "answer", index: 1, finished: true, suppress: false },
  {
    name: "completed child follow-up",
    kind: "delivery",
    index: 1,
    finished: true,
    suppress: false,
  },
  { name: "pending child follow-up", kind: "delivery", index: 1, finished: false, suppress: false },
  {
    name: "obsolete detached whole-run launch",
    kind: "launch",
    index: undefined,
    finished: false,
    suppress: false,
  },
  {
    name: "obsolete detached single-child follow-up",
    kind: "delivery",
    index: 0,
    mode: "single",
    finished: false,
    suppress: false,
  },
  {
    name: "failed whole-run call",
    kind: "launch",
    index: undefined,
    finished: true,
    failed: true,
    suppress: false,
  },
  {
    name: "consumed whole-run call",
    kind: "launch",
    index: undefined,
    finished: true,
    suppress: true,
  },
  {
    name: "persisted notice before owner/accounting save",
    kind: "launch",
    index: undefined,
    finished: true,
    receipt: true,
    published: true,
    suppress: false,
  },
];
function appendHistoricalInvocation(
  manager: SessionManager,
  scenario: CompletionScenario,
  runId: string,
  cwd: string,
): void {
  let questionId: string | undefined;
  if (scenario.kind === "answer") {
    assertDefined(scenario.index);
    const question = createSupervisorQuestion({
      runId,
      ownerTarget: "parent",
      agent: "worker",
      index: scenario.index,
      childSessionId: "child",
      childTarget: "child",
      sessionFile: path.join(cwd, "child.jsonl"),
      cwd,
      pid: process.pid,
      reason: "need_decision",
      message: "Use this approach?",
    });
    saveQuestionAnswer(question, "Yes");
    recordQuestionDelivery(question, { kind: "live", runId, deliveredAt: Date.now() });
    questionId = question.questionId;
  }
  const callId = "native-call";
  if (scenario.finished && scenario.unowned !== true) {
    manager.appendMessage(
      ai.fauxAssistantMessage(
        ai.fauxToolCall(
          "agent_runs",
          {
            action: scenario.kind === "answer" ? "answer" : "resume",
            id: runId,
            ...(scenario.index === undefined ? {} : { index: scenario.index }),
          },
          { id: callId },
        ),
        { stopReason: "toolUse" },
      ),
    );
  }
  if (scenario.receipt !== true) {
    manager.appendCustomEntry("subagent-invocation", {
      toolCallId: callId,
      ownerSessionId: manager.getSessionId(),
      runId,
      index: scenario.index,
      kind: scenario.kind,
      accepted: true,
      ...(questionId === undefined ? {} : { questionId, answer: "Yes" }),
    });
  }
  if (!scenario.finished || scenario.unowned === true) {
    return;
  }
  let details: ToolResultMessage["details"] = {};
  if (scenario.receipt === true) {
    details = { mode: "single", results: [], asyncId: runId };
  } else if (scenario.failed !== true) {
    details = {
      mode: "management",
      results: [],
      wait: {
        runId,
        ...(scenario.index === undefined ? {} : { index: scenario.index }),
        status: "completed",
      },
    };
  }
  manager.appendMessage({
    role: "toolResult",
    toolName: "agent_runs",
    toolCallId: callId,
    content: [{ type: "text", text: "Call finished" }],
    timestamp: Date.now(),
    isError: scenario.failed === true,
    details,
  });
}

function archiveCompletion(t: TestContext, scenario: CompletionScenario) {
  const cwd = fs.mkdtempSync(path.join(root, "case-"));
  const manager = sdk.SessionManager.create(cwd, path.join(cwd, "sessions"));
  manager.appendMessage(ai.fauxAssistantMessage("Delegate work"));
  const runId = randomUUID();
  const asyncDir = getRunMetadataDir(runId);
  const sessionId = manager.getSessionId();
  const mode = scenario.mode ?? "parallel";
  const children = Array.from({ length: mode === "single" ? 1 : 2 }, (_, index) => ({
    agent: "worker",
    index,
  }));
  if (scenario.unowned === true) {
    t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
  } else {
    manager.appendCustomEntry("subagent-run", {
      runId,
      rootRunId: runId,
      ownerSessionId: sessionId,
      source: "async",
      mode,
      cwd,
      task: "Bounded work",
      startedAt: Date.now(),
      asyncDir,
      children,
    });
    saveQuestionOwner(runId, sessionId);
  }
  appendHistoricalInvocation(manager, scenario, runId, cwd);
  manager.appendMessage(ai.fauxAssistantMessage("Waiting for completion"));
  const final: AsyncResultFile = {
    runtimeVersion: scenario.unowned === true ? undefined : 2,
    id: runId,
    mode,
    sessionId: scenario.unowned === true ? sessionId : sessionFile(manager),
    state: "complete",
    success: true,
    timestamp: Date.now(),
    results: children.map(({ agent, index }) => ({
      agent,
      success: true,
      exitCode: 0,
      output: `CHILD_${index}_RESULT`,
    })),
  };
  if (scenario.unowned !== true) {
    saveRunStatus(runId, {
      runId,
      runtimeVersion: 2,
      mode,
      sessionId: sessionFile(manager),
      state: "complete",
      startedAt: Date.now(),
      lastUpdate: Date.now(),
      cwd,
      steps: children.map(({ agent }) => ({ agent, status: "complete" })),
    });
  }
  const saved = scenario.unowned === true ? final : saveAsyncRunResult(runId, final);
  if (scenario.published === true) {
    const broken = path.join(cwd, "broken-child.jsonl");
    fs.writeFileSync(
      broken,
      '{"type":"session","id":"child","version":3}\nmalformed billing record\n',
    );
    assertDefined(saved.results);
    const brokenResult = {
      ...saved,
      results: saved.results.map((child, index) =>
        index === 0
          ? {
              ...child,
              sessionFile: broken,
              terminalEntryId: "missing",
              accounting: { state: "incomplete" as const, error: "fixture billing unavailable" },
            }
          : child,
      ),
    };
    saveQuestionContract(runId, 0, {
      sessionFile: broken,
      attemptBaseline: ["child"],
      terminalEntryId: "missing",
    });
    saveAsyncRunResult(runId, brokenResult);
    assertDefined(saved.completionId);
    manager.appendCustomMessageEntry("subagent-notify", "Published before crash", true, {
      completion: {
        runId,
        completionId: saved.completionId,
        key: `completion:${saved.completionId}`,
      },
    });
  }
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const notice = path.join(RESULTS_DIR, `${runId}.json`);
  fs.writeFileSync(notice, JSON.stringify(final));
  return { cwd, manager, runId, asyncDir, final, notice };
}
type ArchivedCompletion = Readonly<Omit<ReturnType<typeof archiveCompletion>, "final">> & {
  readonly final: ReadonlyDeep<AsyncResultFile>;
};

async function createCompletionOwner(manager: SessionManager, cwd: string) {
  const bus = sdk.createEventBus();
  const completions: Array<Record<string, unknown>> = [];
  const errors: unknown[] = [];
  bus.on("subagent:async-complete", (event) => {
    completions.push(record(event));
  });
  const settingsManager = sdk.SettingsManager.inMemory({
    retry: { enabled: false },
    compaction: { enabled: false },
    cacheWarming: "off",
  });
  const loader = new sdk.DefaultResourceLoader({
    cwd,
    agentDir: path.join(root, "agent"),
    settingsManager,
    eventBus: bus,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    noThemes: true,
    noPromptTemplates: true,
    additionalExtensionPaths: [path.resolve("src/extension/index.ts")],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const faux = ai.fauxProvider({ provider: "completion-fixture", tokensPerSecond: 1000000 });
  faux.setResponses([ai.fauxAssistantMessage("Result received")]);
  const modelRuntime = await sdk.ModelRuntime.create({
    credentials: new ai.InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const { session } = await sdk.createAgentSession({
    cwd,
    agentDir: path.join(root, "agent"),
    settingsManager,
    resourceLoader: loader,
    sessionManager: manager,
    modelRuntime,
    model: faux.getModel(),
  });
  return { session, completions, errors };
}
function nativeNotices(manager: SessionManager) {
  return manager
    .getEntries()
    .filter((entry) => entry.type === "custom_message" && entry.customType === "subagent-notify");
}
async function verifyLegacyReceiptReplay(
  t: TestContext,
  archived: ArchivedCompletion,
  session: AgentSession,
): Promise<void> {
  t.mock.timers.tick(11 * 60_000);
  fs.writeFileSync(archived.notice, JSON.stringify(archived.final));
  t.mock.timers.tick(3000);
  await until(
    () => !fs.existsSync(archived.notice),
    "published legacy receipt must consume replayed input after TTL",
  );
  await session.waitForIdle();
  assert.equal(
    nativeNotices(session.sessionManager).length,
    1,
    "a published runless native receipt prevents replay of retained/recreated input past TTL",
  );
  assert.ok(
    !session.sessionManager
      .getEntries()
      .some(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === "subagent-run" &&
          record(entry.data).runId === archived.runId,
      ),
  );
  assert.equal(
    session.agent.hasQueuedMessages(),
    false,
    "a published legacy receipt leaves no native queue admission behind",
  );
}
async function verifyCompletionOwner(
  t: TestContext,
  scenario: CompletionScenario,
  archived: ArchivedCompletion,
  reopen: boolean,
): Promise<void> {
  if (scenario.unowned === true) {
    fs.writeFileSync(archived.notice, JSON.stringify(archived.final));
  }
  const manager = reopen
    ? sdk.SessionManager.open(sessionFile(archived.manager))
    : archived.manager;
  const { session, completions, errors } = await createCompletionOwner(manager, archived.cwd);
  try {
    await session.bindExtensions({
      mode: "json",
      onError: (error) => {
        errors.push(error);
      },
    });
    if (scenario.unowned === true && !reopen) {
      await until(
        () => completions.length > 0,
        "legacy completion must reach native publication before its hint is consumed",
      );
    } else {
      await until(
        () => !fs.existsSync(archived.notice),
        "startup watcher must process the recovery hint",
      );
    }
    if (!scenario.suppress) {
      await until(() => nativeNotices(manager).length > 0, "native completion must be published");
    }
    await session.waitForIdle();
    assert.equal(
      nativeNotices(manager).length,
      scenario.suppress ? 0 : 1,
      `reopen=${reopen}: whole-run completion is delivered exactly once`,
    );
    if (scenario.unowned === true) {
      await verifyLegacyReceiptReplay(t, archived, session);
    }
    if (reopen && !scenario.suppress) {
      assert.equal(
        completions.length,
        0,
        "saved delivery prevents replay independently of notification TTL dedupe",
      );
    }
    if (!reopen && !(scenario.finished && scenario.suppress) && scenario.published !== true) {
      assert.ok(completions.length > 0, "watcher scanned the result");
    }
    if (scenario.published === true) {
      assert.equal(
        completions.length,
        0,
        "a persisted identity prevents retry even when owner delivery was never saved and billing fails",
      );
      const projection = record(
        record(
          manager
            .getEntries()
            .findLast(
              (entry) =>
                entry.type === "custom" &&
                entry.customType === "subagent-run" &&
                record(entry.data).runId === archived.runId,
            ),
        ).data,
      );
      assert.equal(record(projection.completion).state, "journaled");
      assert.equal(record(projection.accounting).state, "incomplete");
    }
    assert.ok(
      completions.every((event) => Boolean(event.suppressNotification) === scenario.suppress),
    );
    assert.equal(
      fs.existsSync(archived.notice),
      false,
      "finalized receipts or published notification consume recovery hints, not obsolete call bindings",
    );
    assert.deepEqual(errors, []);
  } finally {
    const runner = session.extensionRunner;
    assertDefined(runner);
    await runner.emit({ type: "session_shutdown", reason: "quit" });
    await session.abort();
    session.dispose();
  }
}
for (const scenario of completionScenarios) {
  test(`registered extension routes completion after ${scenario.name}, including session reopen`, async (t) => {
    const archived = archiveCompletion(t, scenario);
    await verifyCompletionOwner(t, scenario, archived, false);
    await verifyCompletionOwner(t, scenario, archived, true);
  });
}
