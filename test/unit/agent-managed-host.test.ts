import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test as nodeTest, type TestContext } from "node:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import agents from "../../src/agent/index.ts";
import type { BackgroundWork } from "../../src/agent/background-work.ts";
import { attachmentSchema, type Launch, type Result } from "../../src/agent/contracts.ts";
import { ownIdentity } from "../../src/agent/process.ts";
import {
  conversation,
  ownerDirectory,
  read,
  runDirectory,
  write,
} from "../../src/agent/storage.ts";
import { getPiAgentDir } from "../../src/pi-intercom/agent-dir.ts";
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
