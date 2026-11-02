import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import * as path from "node:path";
import { test as nodeTest, type TestContext } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import agents from "../../src/agent/index.ts";
import { attachmentSchema } from "../../src/agent/contracts.ts";
import { read } from "../../src/agent/storage.ts";
import { getPiAgentDir } from "../../src/pi-intercom/agent-dir.ts";
import { until } from "../support/observation-child.ts";

// Drives the extension through the same events the native fork emits for a managed worker:
// session_start with ctx.managedHost, then session_shutdown with a disposition.
type Handler = (event: object, ctx: object) => unknown;
function worker(
  t: TestContext,
  sessionId: string,
  managedHost?: { owner: { pid: number }; ready: Promise<boolean> },
) {
  const handlers = new Map<string, Handler[]>();
  const registered: unknown[] = [];
  const pi = {
    on: (name: string, handler: Handler) =>
      handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerTool: (tool: unknown) => registered.push(tool),
    registerMessageRenderer: (type: string) => registered.push(type),
    sendMessage: (message: unknown) => registered.push(message),
    // Cross-extension parking events have no publisher in this unit.
    events: { on: (name: string) => registered.push(name) },
  };
  // Only the members the agent runtime touches for these events are provided.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  agents(pi as unknown as ExtensionAPI);
  const ctx = {
    mode: "print",
    managedHost,
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => path.join(getPiAgentDir(), `${sessionId}.jsonl`),
    },
  };
  const emit = async (name: string, event: object) => {
    await Promise.all(
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
    start: () => {
      open = true;
      return emit("session_start", { reason: "startup" });
    },
    shutdown: (disposition?: string) => {
      open = false;
      return emit("session_shutdown", { reason: "quit", disposition });
    },
  };
}
const attachment = (sessionId: string) =>
  read(
    path.join(getPiAgentDir(), "sessions", "agent-runs", sessionId, "attachment.json"),
    attachmentSchema,
  );

nodeTest(
  "official Pi without a managed host attaches the current process at session_start",
  async (t) => {
    const official = worker(t, "official");
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
    const first = worker(t, "handoff", { owner, ready: ready.promise });
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
    const provisional = worker(t, "handoff", { owner, ready: Promise.resolve(false) });
    await provisional.start();
    await provisional.shutdown("provisional");
    assert.deepEqual(
      { attached: attachment("handoff")?.attached, generation: attachment("handoff")?.generation },
      { attached: true, generation },
    );

    // Another unready replacement whose user quits releases the launcher-owned children.
    const quitting = worker(t, "handoff", { owner, ready: Promise.resolve(false) });
    await quitting.start();
    await quitting.shutdown("release");
    assert.deepEqual(
      { attached: attachment("handoff")?.attached, generation: attachment("handoff")?.generation },
      { attached: false, generation },
    );
  },
);
