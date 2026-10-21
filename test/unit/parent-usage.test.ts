import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { JsonObject, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { createNativeSessionFixture } from "../support/native-session.ts";
import { registerUsage } from "../../src/agent/usage.ts";

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
const a = { id: "child:a", provider: "provider", model: "actual-response", usage };
const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()));
});

async function harness() {
  const manager = SessionManager.inMemory(process.cwd(), { id: "parent" });
  const native = await createNativeSessionFixture({
    cwd: process.cwd(),
    agentDir: process.env.HOME ?? process.cwd(),
    sessionManager: manager,
    bindExtensions: false,
    configure: registerUsage,
  });
  disposals.push(native.dispose);
  const errors: string[] = [];
  native.session.extensionRunner.onError((error) => {
    errors.push(error.error);
  });
  const finalize = async (agentUsage: JsonObject[]) => {
    const message: ToolResultMessage = {
      role: "toolResult",
      toolName: "agent_runs",
      toolCallId: "wait",
      isError: false,
      timestamp: 0,
      content: [{ type: "text", text: "done" }],
      details: { agentUsage },
    };
    const finalized =
      (await native.session.extensionRunner.emitMessageEnd({ type: "message_end", message })) ??
      message;
    assert.equal(finalized.role, "toolResult");
    return finalized;
  };
  return {
    manager,
    errors,
    finalize,
    persist: (message: Message) => manager.appendMessage(message),
  };
}

test("details alone, custom messages and mismatched top-level usage are not portable receipts", async () => {
  const h = await harness();
  h.persist({ ...(await h.finalize([a])), usage: undefined });
  h.manager.appendCustomMessageEntry("agent-notify", "done", false, { agentUsage: [a] });
  h.persist({ ...(await h.finalize([a])), usage: { ...usage, output: 999 } });
  assert.deepEqual((await h.finalize([a])).usage, usage);
  h.persist(await h.finalize([a]));
  assert.equal((await h.finalize([a])).usage, undefined);
  assert.deepEqual(h.errors, []);
});

test("conflicting and empty native IDs cannot publish accounting; optional fields survive JSON receipts", async () => {
  const h = await harness();
  assert.deepEqual(
    (await h.finalize([a, a])).usage,
    usage,
    "identical contributions in one result charge once",
  );
  assert.equal((await h.finalize([a, { ...a, model: "other" }])).usage, undefined);
  assert.match(h.errors.pop() ?? "", /Conflicting native usage/);
  assert.equal((await h.finalize([{ ...a, id: "" }])).usage, undefined);
  assert.notEqual(
    h.errors.pop(),
    undefined,
    "native dispatch exposes invalid contribution instead of charging",
  );
  const { reasoning: _reasoning, cacheWrite1h: _cacheWrite1h, ...basic } = usage;
  const optional = { ...a, usage: basic };
  h.persist(await h.finalize([optional]));
  assert.equal((await h.finalize([optional])).usage, undefined);
  assert.equal((await h.finalize([a])).usage, undefined);
  assert.match(h.errors.pop() ?? "", /Conflicting native usage/);
  assert.deepEqual(h.errors, []);
});
