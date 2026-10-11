import "../support/isolated-home.ts";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  checkSubagentDepth,
  getSubagentDepthEnv,
  normalizeMaxSubagentDepth,
  resolveTopLevelParallelConcurrency,
  resolveTopLevelParallelMaxTasks,
  resolveChildMaxSubagentDepth,
  resolveCurrentMaxSubagentDepth,
} from "../../src/shared/types.ts";

let savedDepth: string | undefined;
let savedMaxDepth: string | undefined;

beforeEach(() => {
  savedDepth = process.env.PI_SUBAGENT_DEPTH;
  savedMaxDepth = process.env.PI_SUBAGENT_MAX_DEPTH;
});

afterEach(() => {
  if (savedDepth === undefined) {
    delete process.env.PI_SUBAGENT_DEPTH;
  } else {
    process.env.PI_SUBAGENT_DEPTH = savedDepth;
  }
  if (savedMaxDepth === undefined) {
    delete process.env.PI_SUBAGENT_MAX_DEPTH;
  } else {
    process.env.PI_SUBAGENT_MAX_DEPTH = savedMaxDepth;
  }
});

describe("normalizeMaxSubagentDepth", () => {
  it("accepts nonnegative integers and rejects other depths", () => {
    assert.equal(normalizeMaxSubagentDepth(0), 0);
    assert.equal(normalizeMaxSubagentDepth(3), 3);
    assert.equal(normalizeMaxSubagentDepth("4"), 4);
    assert.equal(normalizeMaxSubagentDepth(-1), undefined);
    assert.equal(normalizeMaxSubagentDepth(1.5), undefined);
    assert.equal(normalizeMaxSubagentDepth("garbage"), undefined);
  });
});

describe("resolveCurrentMaxSubagentDepth", () => {
  it("uses env when present", () => {
    process.env.PI_SUBAGENT_MAX_DEPTH = "5";
    assert.equal(resolveCurrentMaxSubagentDepth(1), 5);
  });

  it("falls back to default when neither env nor config is valid", () => {
    delete process.env.PI_SUBAGENT_MAX_DEPTH;
    assert.equal(resolveCurrentMaxSubagentDepth(undefined), 1);
    assert.equal(resolveCurrentMaxSubagentDepth(-1), 1);
  });
});

describe("top-level parallel config helpers", () => {
  it("resolves maxTasks from config or falls back to the default", () => {
    assert.equal(resolveTopLevelParallelMaxTasks(12), 12);
    assert.equal(resolveTopLevelParallelMaxTasks(undefined), 8);
    assert.equal(resolveTopLevelParallelMaxTasks(0), 8);
    assert.equal(resolveTopLevelParallelMaxTasks("oops"), 8);
  });

  it("resolves concurrency from per-call override, config, or default", () => {
    assert.equal(resolveTopLevelParallelConcurrency(2, 6), 2);
    assert.equal(resolveTopLevelParallelConcurrency(undefined, 6), 6);
    assert.equal(resolveTopLevelParallelConcurrency(0, 6), 6);
    assert.equal(resolveTopLevelParallelConcurrency(undefined, 0), 4);
  });
});

describe("resolveChildMaxSubagentDepth", () => {
  it("keeps the inherited max when agent override is absent", () => {
    assert.equal(resolveChildMaxSubagentDepth(3, undefined), 3);
  });

  it("tightens to the lower per-agent max", () => {
    assert.equal(resolveChildMaxSubagentDepth(3, 1), 1);
    assert.equal(resolveChildMaxSubagentDepth(2, 0), 0);
  });
});

describe("checkSubagentDepth", () => {
  it("uses config max depth when env is absent", () => {
    process.env.PI_SUBAGENT_DEPTH = "1";
    delete process.env.PI_SUBAGENT_MAX_DEPTH;
    const result = checkSubagentDepth(2);
    assert.equal(result.blocked, false);
    assert.equal(result.maxDepth, 2);
  });

  it("enforces depth bounds and fails closed on invalid depth", () => {
    for (const [depth, maxDepth, blocked, expectedDepth] of [
      ["0", "2", false, 0],
      ["2", "2", true, 2],
      ["3", "2", true, 3],
      ["0", "0", true, 0],
      ["garbage", "2", true, 2],
    ] as const) {
      process.env.PI_SUBAGENT_DEPTH = depth;
      process.env.PI_SUBAGENT_MAX_DEPTH = maxDepth;
      const result = checkSubagentDepth();
      assert.equal(result.blocked, blocked, `depth=${depth}, max=${maxDepth}`);
      assert.equal(result.depth, expectedDepth);
      assert.equal(result.maxDepth, Number(maxDepth));
    }
  });

  it("allows the parent and blocks nested delegation by default", () => {
    delete process.env.PI_SUBAGENT_DEPTH;
    delete process.env.PI_SUBAGENT_MAX_DEPTH;
    assert.deepEqual(checkSubagentDepth(), { blocked: false, depth: 0, maxDepth: 1 });

    process.env.PI_SUBAGENT_DEPTH = "1";
    assert.deepEqual(checkSubagentDepth(), { blocked: true, depth: 1, maxDepth: 1 });
  });
});

describe("getSubagentDepthEnv", () => {
  it("increments depth while preserving the inherited cap and invalid-depth block", () => {
    for (const [depth, maxDepth, expectedDepth, expectedMax] of [
      ["0", undefined, "1", "1"],
      ["1", undefined, "2", "1"],
      ["0", "5", "1", "5"],
      ["not-a-number", undefined, "1", "1"],
    ] as const) {
      process.env.PI_SUBAGENT_DEPTH = depth;
      if (maxDepth === undefined) {
        delete process.env.PI_SUBAGENT_MAX_DEPTH;
      } else {
        process.env.PI_SUBAGENT_MAX_DEPTH = maxDepth;
      }
      const env = getSubagentDepthEnv();
      assert.equal(env.PI_SUBAGENT_DEPTH, expectedDepth);
      assert.equal(env.PI_SUBAGENT_MAX_DEPTH, expectedMax);
    }
  });
});
