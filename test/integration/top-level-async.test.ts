import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyForceTopLevelAsyncOverride } from "../../src/runs/background/top-level-async.ts";

describe("force top-level async helper", () => {
  it("forces top-level calls async and disables clarify", () => {
    for (const [depth, enabled, expectedAsync, expectedClarify] of [
      [0, true, true, false],
      [1, true, false, true],
      [0, false, false, true],
    ] as const) {
      const params = { async: false, clarify: true, agent: "worker" };
      const next = applyForceTopLevelAsyncOverride(params, depth, enabled);
      assert.deepEqual(next, { async: expectedAsync, clarify: expectedClarify, agent: "worker" });
      assert.deepEqual(params, { async: false, clarify: true, agent: "worker" });
    }
  });
});
