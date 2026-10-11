import "../support/isolated-home.ts";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  flattenSteps,
  aggregateParallelOutputs,
  MAX_PARALLEL_CONCURRENCY,
  type RunnerStep,
} from "../../src/runs/shared/parallel-utils.ts";

describe("flattenSteps", () => {
  it("returns sequential steps unchanged", () => {
    const steps: RunnerStep[] = [
      { agent: "a", task: "t1", inheritProjectContext: false, inheritSkills: false },
      { agent: "b", task: "t2", inheritProjectContext: false, inheritSkills: false },
    ];
    const flat = flattenSteps(steps);
    assert.equal(flat.length, 2);
    assert.equal(flat[0].agent, "a");
    assert.equal(flat[1].agent, "b");
  });

  it("expands parallel groups into individual steps", () => {
    const steps: RunnerStep[] = [
      { agent: "scout", task: "find info", inheritProjectContext: false, inheritSkills: false },
      {
        parallel: [
          {
            agent: "reviewer-a",
            task: "review part 1",
            inheritProjectContext: false,
            inheritSkills: false,
          },
          {
            agent: "reviewer-b",
            task: "review part 2",
            inheritProjectContext: false,
            inheritSkills: false,
          },
        ],
      },
      { agent: "summarizer", task: "combine", inheritProjectContext: false, inheritSkills: false },
    ];
    const flat = flattenSteps(steps);
    assert.equal(flat.length, 4);
    assert.deepEqual(
      flat.map((s) => s.agent),
      ["scout", "reviewer-a", "reviewer-b", "summarizer"],
    );
  });

  it("handles empty parallel group", () => {
    const steps: RunnerStep[] = [
      { agent: "before", task: "x", inheritProjectContext: false, inheritSkills: false },
      { parallel: [] },
      { agent: "after", task: "y", inheritProjectContext: false, inheritSkills: false },
    ];
    const flat = flattenSteps(steps);
    assert.equal(flat.length, 2);
    assert.deepEqual(
      flat.map((s) => s.agent),
      ["before", "after"],
    );
  });
});

describe("aggregateParallelOutputs", () => {
  it("aggregates successful outputs with headers", () => {
    const result = aggregateParallelOutputs([
      { agent: "reviewer-a", output: "Looks good", exitCode: 0 },
      { agent: "reviewer-b", output: "Needs fixes", exitCode: 0 },
    ]);
    assert.ok(result.includes("=== Parallel Task 1 (reviewer-a) ==="));
    assert.ok(result.includes("Looks good"));
    assert.ok(result.includes("=== Parallel Task 2 (reviewer-b) ==="));
    assert.ok(result.includes("Needs fixes"));
  });

  it("marks empty output", () => {
    for (const output of ["", "   \n  "]) {
      const result = aggregateParallelOutputs([{ agent: "agent-a", output, exitCode: 0 }]);
      assert.ok(result.includes("EMPTY OUTPUT"));
    }
  });
});

describe("MAX_PARALLEL_CONCURRENCY", () => {
  it("is 4", () => {
    assert.equal(MAX_PARALLEL_CONCURRENCY, 4);
  });
});
