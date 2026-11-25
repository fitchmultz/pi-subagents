import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test as nodeTest, type TestContext } from "node:test";
import {
  createFauxCore,
  createProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import agents from "../../src/agent/index.ts";
import type { BackgroundWork } from "../../src/agent/background-work.ts";
import { attachmentSchema, type Launch, type Result } from "../../src/agent/contracts.ts";
import { prepareLaunch, type LaunchContext } from "../../src/agent/launch.ts";
import { ownIdentity } from "../../src/agent/process.ts";
import {
  conversation,
  list,
  ownerDirectory,
  read,
  runDirectory,
  write,
} from "../../src/agent/storage.ts";
import { getPiAgentDir } from "../../src/pi-intercom/agent-dir.ts";
import { textAt } from "../support/assertions.ts";
import { until } from "../support/observation-child.ts";

function isBackgroundWork(value: unknown): value is BackgroundWork {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "description" in value &&
    typeof value.description === "string" &&
    "cancel" in value &&
    typeof value.cancel === "function"
  );
}

// Drives the extension through the same events the native fork emits for a managed worker:
// session_start with ctx.managedHost, then session_shutdown with a disposition.
async function worker(
  t: TestContext,
  sessionId: string,
  managedHost?: { owner: { pid: number }; ready: Promise<boolean> },
) {
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getPiAgentDir(),
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [agents],
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions.at(0);
  assert.ok(extension !== undefined);
  const { handlers } = extension;
  const sessionFile = path.join(getPiAgentDir(), `${sessionId}.jsonl`);
  const ctx = {
    mode: "print",
    managedHost,
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => sessionFile,
    },
  };
  const emit = async (name: string, event: object) => {
    return Promise.all(
      (handlers.get(name) ?? []).map((handler) => handler({ type: name, ...event }, ctx)),
    );
  };
  let open = false;
  // A failed assertion must not leave the scanner timer or a pending attachment behind.
  t.after(async () => {
    if (open) {
      await emit("session_shutdown", { reason: "quit", disposition: "release" });
    }
  });
  return {
    sessionFile,
    start: () => {
      open = true;
      return emit("session_start", { reason: "startup" });
    },
    shutdown: (disposition?: string) => {
      open = false;
      return emit("session_shutdown", { reason: "quit", disposition });
    },
    backgroundWork: async (): Promise<BackgroundWork[]> => {
      const results = await emit("background_work", {});
      const items: BackgroundWork[] = [];
      for (const result of results) {
        if (
          typeof result === "object" &&
          result !== null &&
          "work" in result &&
          Array.isArray(result.work)
        ) {
          for (const entry of result.work) {
            if (isBackgroundWork(entry)) {
              items.push(entry);
            }
          }
        }
      }
      return items;
    },
  };
}
const attachment = (sessionId: string) =>
  read(
    path.join(getPiAgentDir(), "sessions", "agent-runs", sessionId, "attachment.json"),
    attachmentSchema,
  );
function writeLaunch(base: string, owner: string, id: string, name?: string): Launch {
  const dir = runDirectory(base, id);
  const launch: Launch = {
    version: 1,
    id,
    rootId: id,
    owner,
    cwd: process.cwd(),
    agentDir: getPiAgentDir(),
    sdk: process.cwd(),
    entry: path.join(process.cwd(), "src/agent/index.ts"),
    sessionFile: path.join(dir, "child.jsonl"),
    sessionId: `child-${id}`,
    prompt: "test run",
    context: "fresh",
    provider: "test",
    model: "test-model",
    thinking: "off",
    trusted: true,
    ...(name !== undefined ? { name } : {}),
    createdAt: Date.now(),
  };
  write(path.join(dir, "launch.json"), launch);
  return launch;
}
function writeSettledResult(base: string, launch: Launch): void {
  const result: Result = {
    id: launch.id,
    owner: launch.owner,
    status: "completed",
    endedAt: launch.createdAt + 10,
  };
  write(path.join(runDirectory(base, launch.id), "result.json"), result);
}

nodeTest("native delegate and agent_runs tool calls explain how to recover", async (t) => {
  const cwd = process.cwd();
  const agentDir = getPiAgentDir();
  const sessionManager = SessionManager.create(cwd, agentDir);
  const owner = sessionManager.getSessionId();
  const base = ownerDirectory(agentDir, owner);
  const id = "12345678-1234-4234-8234-123456789abc";
  const shortId = "12345678";
  const foreignId = "23456789-1234-4234-8234-123456789abc";
  const settled = writeLaunch(base, owner, id);
  fs.writeFileSync(settled.sessionFile, "", { flag: "wx" });
  writeSettledResult(base, settled);
  sessionManager.appendCustomEntry("subagent-run", { runId: foreignId, ownerSessionId: "foreign" });

  const core = createFauxCore({
    api: "anthropic-messages",
    provider: "delegate-recovery",
    models: [{ id: "active-model", reasoning: true }],
  });
  const [model] = core.models;
  core.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("delegate", { prompt: "child", model: "null", thinking: "null" }),
        fauxToolCall("delegate", { prompt: "child", thinking: "NULL" }),
        fauxToolCall("delegate", { prompt: "child", model: "NULL" }),
        fauxToolCall("delegate", { prompt: "child", model: "delegate-recovery/missing" }),
        fauxToolCall("agent_runs", { action: "continue", id: shortId, prompt: "resume" }),
        fauxToolCall("agent_runs", { action: "continue", id: foreignId, prompt: "resume" }),
        fauxToolCall("agent_runs", { action: "continue", id }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Done"),
  ]);
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    settingsManager: SettingsManager.inMemory(),
    resourceLoaderOptions: {
      noExtensions: true,
      extensionFactories: [
        agents,
        (pi) => {
          pi.registerProvider(
            createProvider({
              id: core.provider,
              auth: { apiKey: { name: "Faux", resolve: async () => ({ auth: {} }) } },
              models: core.models,
              api: { stream: core.stream, streamSimple: core.streamSimple },
            }),
          );
          pi.on("tool_call", (event) => {
            if (event.toolName === "delegate" && event.input.model === undefined) {
              assert.deepEqual(event.input, { prompt: "child" });
              return { block: true, reason: "Recovered arguments reached the tool hook." };
            }
            return;
          });
        },
      ],
    },
  });
  const { session } = await createAgentSessionFromServices({ services, sessionManager, model });
  t.after(async () => {
    await session.abort();
    session.dispose();
  });
  await session.bindExtensions({ mode: "print" });
  await session.prompt("Try the recovery cases", { expandPromptTemplates: false });
  const results = session.messages.filter((message) => message.role === "toolResult");
  assert.deepEqual(
    results.map((result) => result.isError),
    Array.from({ length: 7 }, () => true),
  );
  const messages = results.map((result) => textAt(result.content));
  assert.equal(messages[0], "Recovered arguments reached the tool hook.");
  assert.match(messages[1] ?? "", /Validation failed for tool "delegate".*\n.*thinking/);
  assert.equal(messages[2], "model must be an exact provider/model ID.");
  assert.match(
    messages[3] ?? "",
    /Model delegate-recovery\/missing is unavailable; no fallback was used\./,
  );
  assert.match(messages[3] ?? "", /Omit model to inherit the session or Overseer default/);
  assert.match(messages[3] ?? "", /Available models: delegate-recovery\/active-model/);
  for (const [index, refused] of [shortId, foreignId].entries()) {
    const message = messages[index + 4] ?? "";
    assert.match(message, /Missing saved native owner or foreign legacy run; nothing was launched/);
    assert.ok(message.includes(refused));
    assert.match(message, /agent_runs with action: "list".*exact full run UUID/);
  }
  assert.match(messages[6] ?? "", /Pass prompt or use action: "inspect".*paused at a checkpoint/);
  assert.deepEqual(list(base), [id]);
});

nodeTest(
  "unavailable delegation model hints prefer the requested provider and stay bounded",
  async () => {
    const cwd = process.cwd();
    const agentDir = getPiAgentDir();
    const same = createFauxCore({
      api: "anthropic-messages",
      provider: "chosen",
      models: Array.from({ length: 9 }, (_, index) => ({ id: `model-${index}` })),
    }).models;
    const other = createFauxCore({
      api: "anthropic-messages",
      provider: "other",
      models: [{ id: "model-other" }],
    }).models;
    const models = [...other, ...same];
    const modelRegistry = {
      find: (provider: string, id: string) =>
        models.find((model) => model.provider === provider && model.id === id),
      getAll: () => models,
    };
    const run = (model: string, getAvailable?: LaunchContext["modelRegistry"]["getAvailable"]) =>
      prepareLaunch({
        input: { prompt: "child", model },
        context: {
          cwd,
          isProjectTrusted: () => true,
          model: undefined,
          modelRegistry: {
            ...modelRegistry,
            ...(getAvailable === undefined ? {} : { getAvailable }),
          },
          sessionManager: SessionManager.inMemory(cwd),
        },
        base: ownerDirectory(agentDir, "unused"),
        owner: "unused",
        agentDir,
        thinking: "off",
        executionCwd: cwd,
      });
    await assert.rejects(
      run("chosen/missing", () => models),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Available models: chosen\/model-0, chosen\/model-1/);
        assert.doesNotMatch(error.message, /other\/model-other|chosen\/model-8/);
        return true;
      },
    );
    await assert.rejects(
      run("unknown/missing", () => other),
      /Available models: other\/model-other/,
    );
    for (const available of [undefined, () => []]) {
      await assert.rejects(run("chosen/missing", available), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Omit model to inherit the session or Overseer default/);
        assert.doesNotMatch(error.message, /Available models:/);
        return true;
      });
    }
  },
);

nodeTest(
  "official Pi without a managed host attaches the current process at session_start",
  async (t) => {
    const official = await worker(t, "official");
    await official.start();
    assert.equal(attachment("official")?.pid, process.pid);
    await official.shutdown();
    assert.equal(attachment("official")?.attached, false);
  },
);

nodeTest(
  "a managed worker attaches its launcher only after readiness is accepted, and hands children off",
  async (t) => {
    const ready = Promise.withResolvers<boolean>();
    const owner = { pid: process.ppid };
    const first = await worker(t, "handoff", { owner, ready: ready.promise });
    await first.start();
    assert.equal(
      attachment("handoff"),
      undefined,
      "session_start never adopts children before readiness",
    );
    ready.resolve(true);
    // Attachment is asynchronous filesystem publication after readiness; observe it.
    await until(() => attachment("handoff") !== undefined, "attachment after readiness", 5_000);
    assert.deepEqual(
      { pid: attachment("handoff")?.pid, attached: attachment("handoff")?.attached },
      { pid: owner.pid, attached: true },
    );
    const generation = attachment("handoff")?.generation;
    await first.shutdown("handoff");
    assert.equal(
      attachment("handoff")?.attached,
      true,
      "a committed restart leaves children attached",
    );

    // The replacement retires before readiness: provisional keeps them for a rollback worker.
    const provisional = await worker(t, "handoff", { owner, ready: Promise.resolve(false) });
    await provisional.start();
    await provisional.shutdown("provisional");
    assert.deepEqual(
      { attached: attachment("handoff")?.attached, generation: attachment("handoff")?.generation },
      { attached: true, generation },
    );

    // Another unready replacement whose user quits releases the launcher-owned children.
    const quitting = await worker(t, "handoff", { owner, ready: Promise.resolve(false) });
    await quitting.start();
    await quitting.shutdown("release");
    assert.deepEqual(
      { attached: attachment("handoff")?.attached, generation: attachment("handoff")?.generation },
      { attached: false, generation },
    );
  },
);

nodeTest(
  "background_work reports running and undelivered subagent runs with host-accurate survivesRestart and stop cancellation",
  async (t) => {
    const sessionId = "bg-work-unmanaged";
    const base = ownerDirectory(getPiAgentDir(), sessionId);
    const host = await worker(t, sessionId);
    fs.writeFileSync(
      host.sessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: process.cwd() })}\n`,
    );
    await host.start();

    // Live child actor (disposable subprocess so stop verification stays real).
    const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    t.after(() => {
      if (sleeper.exitCode === null && sleeper.signalCode === null) {
        sleeper.kill("SIGKILL");
      }
    });
    assert.ok(sleeper.pid !== undefined);
    const running = writeLaunch(base, sessionId, "run-live", "worker-a");
    const actorDir = path.join(conversation(base, running), "actor.lock");
    write(path.join(actorDir, "process.json"), {
      ...ownIdentity(sleeper.pid),
      token: "tok-live",
    });

    // Interrupted run (no actor claim, no result): must never stall hosts.
    writeLaunch(base, sessionId, "run-dead", "dead-worker");

    // Settled run without a recorded completion receipt: must remain listed until published.
    const settled = writeLaunch(base, sessionId, "run-settled", "worker-b");
    writeSettledResult(base, settled);

    const beforeReceipt = await host.backgroundWork();
    assert.deepEqual(
      beforeReceipt.map(({ id, description, survivesRestart }) => ({
        id,
        description,
        survivesRestart,
      })),
      [
        { id: "run-live", description: "Subagent worker-a (run-live)", survivesRestart: false },
        {
          id: "run-settled",
          description: "Subagent worker-b (run-settled)",
          survivesRestart: false,
        },
      ],
    );

    // Recording the completion receipt removes the settled run while keeping the live run.
    fs.appendFileSync(
      host.sessionFile,
      `${JSON.stringify({
        type: "custom_message",
        id: "entry-settled-1",
        customType: "agent-completion",
        details: { owner: sessionId, id: "run-settled", completed: true },
      })}\n`,
    );
    const afterReceipt = await host.backgroundWork();
    assert.deepEqual(
      afterReceipt.map(({ id, survivesRestart }) => ({ id, survivesRestart })),
      [{ id: "run-live", survivesRestart: false }],
    );

    // Cancelling the live item enqueues a real stop command and stops the disposable actor.
    const liveItem = afterReceipt[0];
    assert.ok(liveItem !== undefined);
    await liveItem.cancel();
    const commandFiles = fs.readdirSync(path.join(conversation(base, running), "commands"));
    assert.equal(commandFiles.length, 1);
    await until(
      () => sleeper.exitCode !== null || sleeper.signalCode !== null,
      "disposable actor exits after cancel",
      5_000,
    );
    assert.deepEqual(await host.backgroundWork(), []);
    await host.shutdown();
  },
);

nodeTest(
  "background_work marks subagent runs survivesRestart: true under a managed fork host",
  async (t) => {
    const sessionId = "bg-work-managed";
    const base = ownerDirectory(getPiAgentDir(), sessionId);
    const ready = Promise.withResolvers<boolean>();
    const managed = await worker(t, sessionId, {
      owner: { pid: process.ppid },
      ready: ready.promise,
    });
    fs.writeFileSync(
      managed.sessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: process.cwd() })}\n`,
    );
    const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    t.after(() => {
      if (sleeper.exitCode === null && sleeper.signalCode === null) {
        sleeper.kill("SIGKILL");
      }
    });
    assert.ok(sleeper.pid !== undefined);
    const running = writeLaunch(base, sessionId, "run-managed");
    write(path.join(conversation(base, running), "actor.lock", "process.json"), {
      ...ownIdentity(sleeper.pid),
      token: "tok-managed",
    });

    await managed.start();
    // Even before readiness resolves, a managed host retains children across restart handoff.
    assert.deepEqual(
      (await managed.backgroundWork()).map(({ id, description, survivesRestart }) => ({
        id,
        description,
        survivesRestart,
      })),
      [{ id: "run-managed", description: "Subagent run-managed", survivesRestart: true }],
    );

    ready.resolve(true);
    await until(() => attachment(sessionId) !== undefined, "managed attachment", 5_000);
    assert.deepEqual(
      (await managed.backgroundWork()).map(({ id, survivesRestart }) => ({ id, survivesRestart })),
      [{ id: "run-managed", survivesRestart: true }],
    );

    await managed.shutdown("handoff");
  },
);

nodeTest(
  "background_work cancel() returns a rejected promise rather than throwing synchronously when stop refuses an unverified actor",
  async (t) => {
    const sessionId = "bg-work-unverified-cancel";
    const base = ownerDirectory(getPiAgentDir(), sessionId);
    const host = await worker(t, sessionId);
    fs.writeFileSync(
      host.sessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: process.cwd() })}\n`,
    );
    await host.start();

    const unverified = writeLaunch(base, sessionId, "run-unverified");
    write(path.join(conversation(base, unverified), "actor.lock", "process.json"), {
      pid: process.pid,
      identity: "unverified",
      token: "tok-unverified",
    });

    const items = await host.backgroundWork();
    assert.equal(items.length, 1);
    const item = items[0];
    assert.ok(item !== undefined);
    // Must not throw synchronously out of a caller's .map(item => item.cancel()).
    let returned: Promise<void> | undefined;
    assert.doesNotThrow(() => {
      returned = item.cancel();
    });
    assert.ok(returned instanceof Promise);
    await assert.rejects(returned, /Cannot verify actor process identity/);
    await host.shutdown();
  },
);
