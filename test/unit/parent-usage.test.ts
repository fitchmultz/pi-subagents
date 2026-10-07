import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { JsonObject, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { createNativeSessionFixture } from "../support/native-session.ts";
import { record } from "../support/assertions.ts";
import type { ReadonlyInput } from "../../src/shared/types/inputs.ts";
import type {
  OwnedRunView,
  SubagentExecutionResult,
  UsageContribution,
} from "../../src/shared/types.ts";
import { finalizedChildUsage, registerParentUsage } from "../../src/runs/shared/parent-usage.ts";

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
const a: UsageContribution = {
  id: "child:a",
  provider: "provider",
  model: "actual-response",
  usage,
};
const b: UsageContribution = { id: "child:b", usage };
const result = (): SubagentExecutionResult => ({
  content: [{ type: "text", text: "done" }],
  details: { mode: "management", results: [] },
});

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()));
});

function receiptDetails(value: ReadonlyInput<SubagentExecutionResult>): JsonObject {
  const pending = value.details.parentUsage;
  return {
    mode: "management",
    results: [],
    ...(pending === undefined
      ? {}
      : {
          parentUsage: {
            contributions: pending.contributions.map((c) => {
              const counters: JsonObject = {};
              for (const [key, counter] of Object.entries<
                number | UsageContribution["usage"]["cost"]
              >(c.usage)) {
                if (typeof counter === "number") {
                  counters[key] = counter;
                } else if (counter !== undefined) {
                  const cost: JsonObject = {};
                  for (const [costKey, costValue] of Object.entries<number | undefined>(counter)) {
                    if (costValue !== undefined) {
                      cost[costKey] = costValue;
                    }
                  }
                  counters[key] = cost;
                }
              }
              const contribution: JsonObject = { id: c.id, usage: counters };
              if (c.provider !== undefined) {
                contribution.provider = c.provider;
              }
              if (c.model !== undefined) {
                contribution.model = c.model;
              }
              return contribution;
            }),
          },
        }),
  };
}

async function harness() {
  let adapter: ReturnType<typeof registerParentUsage> | undefined;
  const manager = SessionManager.inMemory(process.cwd(), { id: "parent" });
  const native = await createNativeSessionFixture({
    cwd: process.cwd(),
    agentDir: process.env.HOME ?? process.cwd(),
    sessionManager: manager,
    bindExtensions: false,
    configure(pi) {
      adapter = registerParentUsage(pi, ["delegate", "agent_runs"]);
    },
  });
  disposals.push(native.dispose);
  assert.ok(adapter);
  // Native initialization writes model/thinking selection before accounting starts.
  // Observe newly persisted evidence, leaving the actual manager's baseline intact.
  const baseline = new Set(manager.getEntries().map((entry) => entry.id));
  const finalize = async (value: ReadonlyInput<SubagentExecutionResult>) => {
    const message: ToolResultMessage = {
      role: "toolResult",
      toolName: "agent_runs",
      toolCallId: "wait",
      isError: false,
      timestamp: 0,
      content: [{ type: "text", text: "done" }],
      details: receiptDetails(value),
      ...(value.usage === undefined ? {} : { usage: value.usage }),
    };
    const final =
      (await native.session.extensionRunner.emitMessageEnd({ type: "message_end", message })) ??
      message;
    assert.equal(final.role, "toolResult");
    return final;
  };
  const persist = (message: Message) => {
    manager.appendMessage(message);
  };
  return {
    adapter,
    ctx: native.context,
    manager,
    get entries() {
      return manager.getEntries().filter((entry) => !baseline.has(entry.id));
    },
    finalize,
    persist,
  };
}

test("select finalized siblings by their actual index and read only their own native delta", () => {
  const child = (
    index: number,
    state: OwnedRunView["children"][number]["state"],
    contributions: readonly UsageContribution[],
  ) => ({
    index,
    state,
    agent: "worker",
    configuration: "legacy-partial" as const,
    result: {
      agent: "worker",
      task: "work",
      exitCode: 0,
      usage: {
        input: 1000,
        output: 1000,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 1000,
        turns: 1,
        contributions,
      },
      modelAttempts: [
        {
          model: "fallback",
          success: true,
          usage: {
            input: 999,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 9,
            turns: 1,
            contributions: [a],
          },
        },
      ],
    },
  });
  const children = [
    child(7, "completed", [a]),
    child(2, "live", [b]),
    child(4, "failed", [b]),
    child(0, "unknown", [a]),
  ];
  const before = structuredClone(children);
  assert.deepEqual(
    finalizedChildUsage(children, 4),
    [b],
    "filtered result array position is not the child slot",
  );
  assert.deepEqual(
    finalizedChildUsage(children),
    [a, b],
    "failed work still costs; attempts and nested rollups are not counted again",
  );
  assert.deepEqual(finalizedChildUsage(children, 2), []);
  assert.deepEqual(children, before, "inspection/selection is pure");
});

test("portable final usage preserves every native counter and sums subsets only once", async () => {
  const h = await harness();
  const prepared = h.adapter.attach(result(), [a, a, b], h.ctx);
  assert.equal(prepared.usage, undefined, "preparation is intent, not a charge");
  assert.equal(h.entries.length, 0);
  const message = await h.finalize(prepared);
  assert.equal(message.role, "toolResult");
  assert.deepEqual(message.usage, {
    input: 20,
    output: 40,
    cacheRead: 60,
    cacheWrite: 80,
    reasoning: 10,
    cacheWrite1h: 30,
    totalTokens: 200,
    cost: { input: 2, output: 4, cacheRead: 6, cacheWrite: 8, total: 20 },
  });
  assert.deepEqual(record(record(message.details).parentUsage).contributions, [a, b]);
  assert.equal(
    h.entries.length,
    0,
    "even message_end is not a receipt until native stores the message",
  );
  assert.deepEqual(
    (await h.finalize(prepared)).usage,
    message.usage,
    "a dropped persistence attempt remains chargeable",
  );
  h.persist(message);
  assert.equal(
    (await h.finalize(prepared)).usage,
    undefined,
    "replayed completion sees the persisted receipt",
  );
  assert.equal(h.adapter.attach(result(), [a, b], h.ctx).details.parentUsage, undefined);
});

test("details alone, custom messages and mismatched top-level usage are not portable receipts", async () => {
  const h = await harness();
  const prepared = h.adapter.attach(result(), [a], h.ctx);
  h.persist({ ...(await h.finalize(prepared)), usage: undefined });
  h.manager.appendCustomMessageEntry("subagent-notify", "done", false, { result: prepared });
  h.persist({ ...(await h.finalize(prepared)), usage: { ...usage, output: 999 } });
  assert.deepEqual((await h.finalize(prepared)).usage, usage);
  h.persist(await h.finalize(prepared));
  assert.equal((await h.finalize(prepared)).usage, undefined);
});

test("legacy native usage and finalized portable receipts deduplicate new finalized results", async () => {
  const h = await harness();
  h.persist(await h.finalize(h.adapter.attach(result(), [a], h.ctx)));
  const legacyEntry = h.manager.appendUsage("subagent", "unattributed", "unattributed", usage);
  // Older hosts attached this accounting ID to the native usage entry they persisted.
  Object.assign(legacyEntry, { contributionId: "subagent:child:b" });
  assert.equal(h.adapter.attach(result(), [a, b], h.ctx).details.parentUsage, undefined);
  assert.equal(
    h.adapter.isRecorded([a, b], h.ctx, new Map(h.entries.map((entry) => [entry.id, entry]))),
    true,
  );
});

test("conflicting repeated native IDs fail before accounting and optional undefined fields survive JSON receipts", async () => {
  const h = await harness();
  assert.throws(
    () => h.adapter.attach(result(), [a, { ...a, model: "other" }], h.ctx),
    /conflict/i,
  );
  assert.throws(
    () => h.adapter.attach(result(), [{ ...a, id: "" }], h.ctx),
    /stable native contribution ID/,
  );
  const optional = { ...a, usage: { ...usage, reasoning: undefined, cacheWrite1h: undefined } };
  h.persist(await h.finalize(h.adapter.attach(result(), [optional], h.ctx)));
  assert.equal(h.adapter.attach(result(), [optional], h.ctx).details.parentUsage, undefined);
  assert.throws(() => h.adapter.attach(result(), [a], h.ctx), /conflict/i);
});
