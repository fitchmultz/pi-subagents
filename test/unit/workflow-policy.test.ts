import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { addAbortListener } from "node:events";
import { describe, it } from "node:test";
import {
  evaluateAcceptance,
  resolveEffectiveAcceptance,
} from "../../src/runs/shared/acceptance.ts";
import { renderChainTask, resolveOutputReferences } from "../../src/runs/shared/chain-outputs.ts";
import { materializeDynamicParallelStep } from "../../src/runs/shared/dynamic-fanout.ts";
import { isFailFastAbort } from "../../src/runs/shared/parallel-utils.ts";
import { completeWorkflowStep, runParallelTasks } from "../../src/runs/shared/workflow-policy.ts";

import type { ReadonlyInput } from "../../src/shared/types/inputs.ts";

const success = { agent: "worker", output: "Evidence", exitCode: 0 };

describe("workflow policy", () => {
  it("bounds parallel work and returns input order, not completion order", async () => {
    const gates: readonly { readonly promise: Promise<void>; readonly resolve: () => void }[] = [
      Promise.withResolvers(),
      Promise.withResolvers(),
      Promise.withResolvers(),
    ];
    const started: number[] = [];
    const pending = runParallelTasks({
      tasks: gates,
      concurrency: 2,
      runTask: async (gate, index) => {
        started.push(index);
        await gate.promise;
        return { ...success, output: String(index) };
      },
      stoppedTask: (): ReadonlyInput<typeof success> => {
        throw new Error("No task should stop");
      },
    });
    assert.deepEqual(started, [0, 1]);
    gates[1].resolve();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    assert.deepEqual(started, [0, 1, 2]);
    gates[2].resolve();
    gates[0].resolve();
    assert.deepEqual(
      (await pending).map((result) => result.output),
      ["0", "1", "2"],
    );
  });

  it("fail-fast interrupts running siblings with its own reason and skips queued work", async () => {
    const first = Promise.withResolvers<{ exitCode: number }>();
    const started: number[] = [];
    const pending = runParallelTasks({
      tasks: [0, 1, 2],
      concurrency: 2,
      failFast: true,
      runTask: async (_, index, signal) => {
        started.push(index);
        if (index === 0) {
          return first.promise;
        }
        return new Promise<{ exitCode: number }>((resolve) => {
          addAbortListener(signal, () => {
            assert.equal(isFailFastAbort(signal), true);
            resolve({ exitCode: -1 });
          });
        });
      },
      stoppedTask: (_, index, reason) => {
        assert.equal(index, 2);
        assert.equal(reason, "fail-fast");
        return { exitCode: -1 };
      },
    });
    first.resolve({ exitCode: 1 });
    assert.deepEqual(
      (await pending).map((result) => result.exitCode),
      [1, -1, -1],
    );
    assert.deepEqual(started, [0, 1]);
  });

  it("pause, detach and cancellation stop queued work without becoming fail-fast", async () => {
    await Promise.all(
      ["interrupted", "detached", "cancelled"].map(async (reason) => {
        const cancellation = new AbortController();
        const interruption = new AbortController();
        const started: number[] = [];
        const results = await runParallelTasks({
          tasks: [0, 1],
          concurrency: 1,
          failFast: true,
          signal: cancellation.signal,
          interruptSignal: interruption.signal,
          runTask: async (_, index, failFastSignal) => {
            started.push(index);
            assert.equal(failFastSignal.aborted, false);
            if (reason === "cancelled") {
              cancellation.abort();
            }
            if (reason === "interrupted") {
              interruption.abort();
            }
            return { ...success, ...(reason === "cancelled" ? {} : { [reason]: true }) };
          },
          stoppedTask: (_, index, stopped) => {
            assert.equal(index, 1);
            assert.equal(stopped, reason);
            return { ...success, exitCode: -1 };
          },
        });
        assert.deepEqual(started, [0]);
        assert.equal(results[1].exitCode, -1);
      }),
    );
  });

  it("a selected-child stop leaves queued and running independent siblings alone, even with fail-fast", async () => {
    const started: number[] = [];
    const results = await runParallelTasks({
      tasks: [0, 1, 2],
      concurrency: 1,
      failFast: true,
      runTask: async (_, index, signal) => {
        started.push(index);
        assert.equal(signal.aborted, false);
        return { ...success, interrupted: index === 0 };
      },
      stoppedTask: () => {
        throw new Error("Independent sibling was skipped");
      },
    });
    assert.deepEqual(started, [0, 1, 2]);
    assert.equal(
      completeWorkflowStep({ stepIndex: 0, stepCount: 2, results, previousOutput: "" }).advance,
      false,
    );
  });

  it("retains successful sibling outputs but cannot advance from any stopped group", () => {
    for (const stopped of [
      { exitCode: 1 },
      { exitCode: -1 },
      { exitCode: 0, interrupted: true },
      { exitCode: 0, detached: true },
      { exitCode: 124, timedOut: true },
    ]) {
      const completion = completeWorkflowStep({
        stepIndex: 0,
        stepCount: 2,
        previousOutput: "Before",
        parallel: true,
        results: [success, { ...success, ...stopped }],
        outputNames: ["evidence", "unfinished"],
      });
      assert.equal(completion.outputs.evidence.text, "Evidence");
      assert.equal(completion.outputs.unfinished, undefined);
      assert.equal(completion.previousOutput, "Before");
      assert.equal(completion.advance, false);
      assert.equal(completion.complete, false);
    }
    const mixed = completeWorkflowStep({
      stepIndex: 0,
      stepCount: 1,
      previousOutput: "",
      results: [success, { ...success, exitCode: 1 }, { ...success, detached: true }],
    });
    assert.deepEqual(mixed.failedIndices, [1]);
    assert.equal(mixed.detachedIndex, 2);
  });

  it("a human-blocked child keeps independent siblings alive but cannot advance dependent work", async () => {
    const acceptance = await evaluateAcceptance({
      acceptance: resolveEffectiveAcceptance({ explicit: { criteria: ["Authenticate"] } }),
      cwd: process.cwd(),
      output:
        '```acceptance-report\n{"criteriaSatisfied":[{"id":"criterion-1","status":"blocked","evidence":"Touch ID prompt is visible","humanAction":"Complete Touch ID"}]}\n```',
    });
    const started: number[] = [];
    const results = await runParallelTasks({
      tasks: [0, 1],
      concurrency: 1,
      failFast: true,
      runTask: async (_, index, signal) => {
        started.push(index);
        assert.equal(signal.aborted, false);
        return { ...success, ...(index === 0 ? { acceptance } : {}) };
      },
      stoppedTask: () => {
        throw new Error("Blocked authentication must not stop an independent sibling");
      },
    });
    assert.deepEqual(started, [0, 1]);
    const group = completeWorkflowStep({
      stepIndex: 0,
      stepCount: 2,
      results,
      previousOutput: "",
      outputNames: ["blocked", "completed"],
    });
    assert.equal(group.status, "blocked");
    assert.equal(group.advance, false);
    assert.equal(group.outputs.blocked, undefined);
    assert.equal(group.outputs.completed.text, "Evidence");
    assert.equal(
      completeWorkflowStep({
        stepIndex: 0,
        stepCount: 2,
        results: [results[0], { ...success, exitCode: 1 }],
        previousOutput: "",
      }).status,
      "failed",
    );
  });

  it("a successful prefix is not a completed workflow", () => {
    const prefix = completeWorkflowStep({
      stepIndex: 0,
      stepCount: 2,
      results: [success],
      previousOutput: "",
    });
    assert.equal(prefix.advance, true);
    assert.equal(prefix.complete, false);
    const last = completeWorkflowStep({
      stepIndex: 1,
      stepCount: 2,
      results: [success],
      previousOutput: prefix.previousOutput,
    });
    assert.equal(last.complete, true);
  });

  for (const mode of ["sequential", "dynamic"]) {
    it(`publishes ${mode} __proto__ as an own output without changing the map prototype`, () => {
      const step = {
        expand: { from: { output: "items", path: "/items" }, maxItems: 1 },
        parallel: { agent: "worker", task: "{item}" },
        collect: { as: "__proto__" },
      };
      const completion =
        mode === "sequential"
          ? completeWorkflowStep({
              stepIndex: 0,
              stepCount: 1,
              results: [success],
              previousOutput: "",
              outputNames: ["__proto__"],
            })
          : completeWorkflowStep({
              stepIndex: 1,
              stepCount: 2,
              results: [success],
              previousOutput: "",
              dynamic: {
                step,
                items: materializeDynamicParallelStep(
                  step,
                  {
                    items: {
                      agent: "producer",
                      stepIndex: 0,
                      text: "",
                      structured: { items: ["a"] },
                    },
                  },
                  1,
                ).items,
              },
            });
      const expectedText =
        mode === "sequential"
          ? "Evidence"
          : '[{"key":"0","index":0,"item":"a","agent":"worker","exitCode":0,"text":"Evidence"}]';
      assert.equal(completion.complete, true);
      assert.equal(Object.hasOwn(completion.outputs, "__proto__"), true);
      assert.equal(Object.getPrototypeOf(completion.outputs), Object.prototype);
      assert.equal(completion.outputs["__proto__"].text, expectedText);
      assert.equal(
        resolveOutputReferences("{outputs.__proto__}", completion.outputs),
        expectedText,
      );
    });
  }

  it("rejects inherited output names that no workflow step published", () => {
    const outputs = {};
    const prototype = { inherited: { text: "Not produced", agent: "parent", stepIndex: 0 } };
    Object.setPrototypeOf(outputs, prototype);
    assert.equal(Object.hasOwn(outputs, "inherited"), false);
    assert.equal(Object.getPrototypeOf(outputs), prototype);
    assert.throws(
      () => resolveOutputReferences("{outputs.inherited}", outputs),
      /Unknown chain output reference/,
    );
  });

  it("publishes dynamic collections only after every child and the aggregate schema succeed", () => {
    const step = {
      expand: { from: { output: "items", path: "/items" }, maxItems: 2 },
      parallel: { agent: "worker", task: "{item}" },
      collect: { as: "answers", outputSchema: { type: "array", minItems: 2 } },
    };
    const items = materializeDynamicParallelStep(
      step,
      { items: { agent: "producer", stepIndex: 0, text: "", structured: { items: ["a", "b"] } } },
      1,
    ).items;
    const complete = (results: readonly ReadonlyInput<typeof success>[], collect = step.collect) =>
      completeWorkflowStep({
        stepIndex: 1,
        stepCount: 2,
        results,
        previousOutput: "Before",
        dynamic: { step: { ...step, collect }, items },
      });
    const structured: unknown = complete([success, success]).outputs.answers.structured;
    assert.ok(Array.isArray(structured));
    assert.deepEqual(
      structured.map((item: unknown) => {
        assert.ok(item !== null && typeof item === "object" && "key" in item);
        return item.key;
      }),
      ["0", "1"],
    );
    for (const completion of [
      complete([success]),
      complete([success, { ...success, exitCode: 1 }]),
      complete([success, success], {
        ...step.collect,
        outputSchema: { type: "array", minItems: 3 },
      }),
    ]) {
      assert.equal(completion.advance, false);
      assert.equal(completion.outputs.answers, undefined);
      assert.equal(completion.previousOutput, "Before");
    }
    const empty = completeWorkflowStep({
      stepIndex: 1,
      stepCount: 2,
      results: [],
      previousOutput: "Before",
      dynamic: { step: { ...step, collect: { as: "answers" } }, items: [] },
    });
    assert.equal(empty.complete, true);
    assert.deepEqual(empty.outputs.answers.structured, []);
  });

  it("renders all template inputs as literal data in one pass", () => {
    const literal = "$& $` $' {task} {previous} {outputs.unknown} {item.value}";
    const values = {
      originalTask: literal,
      previousOutput: literal,
      chainDir: literal,
      outputs: { evidence: { text: literal, agent: "worker", stepIndex: 0 } },
      item: { name: "item", value: { value: literal } },
    };
    assert.equal(
      renderChainTask("{task}|{previous}|{outputs.evidence}|{chain_dir}|{item.value}", values),
      Array(5).fill(literal).join("|"),
    );
    assert.equal(
      renderChainTask("Continue", { previousOutput: literal }),
      `Continue\n\n---\nPrevious step output:\n${literal}`,
    );
    assert.equal(
      renderChainTask("{previous}", { item: { name: "previous", value: literal } }),
      literal,
    );
  });
});
