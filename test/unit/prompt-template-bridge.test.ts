import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertArray, assertDefined, assertRecord } from "../support/assertions.ts";

import {
  PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT,
  PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT,
  PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT,
  PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT,
  PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT,
  registerPromptTemplateDelegationBridge,
  type PromptTemplateBridgeEvents,
} from "../../src/slash/prompt-template-bridge.ts";

class FakeEvents implements PromptTemplateBridgeEvents {
  private readonly handlers = new Map<string, Array<(data: unknown) => void>>();

  on(event: string, handler: (data: unknown) => void): () => void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return () => {
      const current = this.handlers.get(event) ?? [];
      this.handlers.set(
        event,
        current.filter((h) => h !== handler),
      );
    };
  }

  emit(event: string, data: unknown): void {
    const list = this.handlers.get(event) ?? [];
    for (const handler of list) {
      handler(data);
    }
  }
}

function once(
  events: { readonly on: (event: string, handler: (data: unknown) => void) => () => void },
  event: string,
): Promise<Readonly<Record<string, unknown>>> {
  return new Promise((resolve) => {
    const unsubscribe = events.on(event, (payload) => {
      unsubscribe();
      assertRecord(payload);
      resolve(payload);
    });
  });
}

function records(value: unknown): ReadonlyArray<Readonly<Record<string, unknown>>> {
  assertArray(value);
  const values: readonly unknown[] = value;
  return values.map((item) => {
    assertRecord(item);
    return item;
  });
}

describe("prompt-template delegation bridge", () => {
  it("emits started/update/response on successful request", async () => {
    for (const recentOutput of [["line 1"], ["line 1", 123]]) {
      const events = new FakeEvents();
      let executeCalls = 0;
      let executeCwd: string | undefined;
      const bridge = registerPromptTemplateDelegationBridge({
        events,
        getContext: () => ({ cwd: "/actual" }),
        execute: async ({ onUpdate, request }) => {
          executeCwd = request.cwd;
          assertDefined(onUpdate);
          executeCalls++;
          onUpdate({
            details: {
              results: [{ agent: "worker", model: "openai/gpt-5-mini" }],
              progress: [
                {
                  index: 0,
                  agent: "worker",
                  currentTool: "read",
                  currentToolArgs: "src/extension/index.ts",
                  recentOutput,
                  recentTools: [{ tool: "read", args: '{"path":"src/extension/index.ts"}' }],
                  toolCount: 1,
                  durationMs: 10,
                  tokens: 42,
                },
              ],
            },
          });
          return {
            details: {
              results: [
                { messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }] },
              ],
            },
          };
        },
      });

      const startedPromise = once(events, PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT);
      const updatePromise = once(events, PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT);
      const responsePromise = once(events, PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT);

      events.emit(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, {
        requestId: "r1",
        agent: "worker",
        task: "do work",
        context: "fresh",
        model: "openai/gpt-5",
        cwd: "/repo",
      });

      // Finish this bridge's event sequence before installing the next output variant.
      // oxlint-disable-next-line no-await-in-loop
      const started = await startedPromise;
      assert.equal(started.requestId, "r1");

      // oxlint-disable-next-line no-await-in-loop
      const update = await updatePromise;
      assert.equal(update.requestId, "r1");
      assert.equal(update.currentTool, "read");
      assert.equal(update.toolCount, 1);
      assert.deepEqual(update.recentOutputLines, ["line 1"]);
      assert.equal(update.recentOutput, recentOutput.length === 1 ? "line 1" : undefined);
      assert.equal(
        records(update.taskProgress)[0].recentOutput,
        recentOutput.length === 1 ? "line 1" : undefined,
      );
      assert.deepEqual(records(update.taskProgress)[0].recentOutputLines, ["line 1"]);
      assert.deepEqual(update.recentTools, [
        { tool: "read", args: '{"path":"src/extension/index.ts"}' },
      ]);
      assert.equal(update.model, "openai/gpt-5-mini");
      assert.equal(records(update.taskProgress)[0].model, "openai/gpt-5-mini");

      // Complete this bridge's response before disposing it and installing the next row.
      // oxlint-disable-next-line no-await-in-loop
      const response = await responsePromise;
      assert.equal(response.requestId, "r1");
      assert.equal(response.isError, false);
      assert.equal(Array.isArray(response.messages), true);
      assert.equal(executeCalls, 1);
      assert.equal(executeCwd, "/repo");

      bridge.dispose();
    }
  });

  it("returns structured error when no active context", async () => {
    const events = new FakeEvents();
    const bridge = registerPromptTemplateDelegationBridge({
      events,
      getContext: () => null,
      execute: async () => ({ details: { results: [{ messages: [] }] } }),
    });

    const responsePromise = once(events, PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT);
    events.emit(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, {
      requestId: "r2",
      agent: "worker",
      task: "do work",
      context: "fresh",
      model: "openai/gpt-5",
      cwd: "/repo",
    });

    const response = await responsePromise;
    assert.equal(response.isError, true);
    assert.ok(typeof response.errorText === "string");
    assert.match(response.errorText, /No active extension context/);

    bridge.dispose();
  });

  it("applies pending cancel when cancel arrives before request", async () => {
    const events = new FakeEvents();
    let executeCalls = 0;
    const bridge = registerPromptTemplateDelegationBridge({
      events,
      getContext: () => ({ cwd: "/repo" }),
      execute: async () => {
        executeCalls++;
        return { details: { results: [{ messages: [] }] } };
      },
    });

    events.emit(PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT, { requestId: "r4" });
    const responsePromise = once(events, PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT);

    events.emit(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, {
      requestId: "r4",
      agent: "worker",
      task: "do work",
      context: "fresh",
      model: "openai/gpt-5",
      cwd: "/repo",
    });

    const response = await responsePromise;
    assert.equal(response.isError, true);
    assert.equal(response.errorText, "Delegated prompt cancelled.");
    assert.equal(executeCalls, 0);

    bridge.dispose();
  });

  it("cancels in-flight delegated execution", async () => {
    const events = new FakeEvents();
    const bridge = registerPromptTemplateDelegationBridge({
      events,
      getContext: () => ({ cwd: "/repo" }),
      execute: async ({ signal }) => {
        assertDefined(signal);
        return await new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    });

    const startedPromise = once(events, PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT);
    const responsePromise = once(events, PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT);

    events.emit(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, {
      requestId: "r5",
      agent: "worker",
      task: "do work",
      context: "fresh",
      model: "openai/gpt-5",
      cwd: "/repo",
    });

    await startedPromise;
    events.emit(PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT, { requestId: "r5" });

    const response = await responsePromise;
    assert.equal(response.isError, true);
    assert.ok(typeof response.errorText === "string");
    assert.match(response.errorText, /aborted/i);

    bridge.dispose();
  });

  it("accepts tasks payloads and emits parallelResults", async () => {
    for (const missing of [false, true]) {
      const events = new FakeEvents();
      let executeTasks:
        | ReadonlyArray<{
            readonly agent: string;
            readonly task: string;
            readonly model?: string;
            readonly cwd?: string;
          }>
        | undefined;
      const bridge = registerPromptTemplateDelegationBridge({
        events,
        getContext: () => ({ cwd: "/repo" }),
        execute: async ({ request }) => {
          executeTasks = request.tasks;
          return {
            details: {
              results: [
                {
                  agent: "worker-a",
                  messages: [{ role: "assistant", content: [{ type: "text", text: "a" }] }],
                  exitCode: 0,
                },
                ...(missing
                  ? []
                  : [{ agent: "worker-b", messages: [], exitCode: 1, error: "failed" }]),
              ],
            },
          };
        },
      });

      const responsePromise = once(events, PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT);
      events.emit(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, {
        requestId: "r6",
        tasks: [
          { agent: "worker-a", task: "A", model: "openai/gpt-5", cwd: "/repo/a" },
          {
            agent: "worker-b",
            task: "B",
            model: "anthropic/claude-sonnet-4-20250514",
            cwd: "/repo/b",
          },
        ],
        context: "fresh",
        model: "openai/gpt-5",
        cwd: "/repo",
      });

      // Complete this bridge's response before disposing it and installing the next row.
      // oxlint-disable-next-line no-await-in-loop
      const response = await responsePromise;
      const parallelResults = records(response.parallelResults);
      assertDefined(executeTasks);
      assert.equal(Array.isArray(executeTasks), true);
      assert.equal(executeTasks.length, 2);
      assert.equal(executeTasks[0].model, "openai/gpt-5");
      assert.equal(executeTasks[1].model, "anthropic/claude-sonnet-4-20250514");
      assert.equal(executeTasks[0].cwd, "/repo/a");
      assert.equal(executeTasks[1].cwd, "/repo/b");
      assert.equal(response.isError, false);
      assert.equal(parallelResults[0].agent, "worker-a");
      assert.equal(parallelResults[0].isError, false);
      assert.equal(parallelResults[1].agent, "worker-b");
      assert.equal(parallelResults[1].isError, true);
      if (missing) {
        assert.ok(typeof parallelResults[1].errorText === "string");
        assert.match(parallelResults[1].errorText, /missing result/i);
      } else {
        assert.equal(parallelResults[1].errorText, "failed");
      }

      bridge.dispose();
    }
  });
});
