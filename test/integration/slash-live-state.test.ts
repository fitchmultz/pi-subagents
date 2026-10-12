import "../support/isolated-home.ts";
import { textAt } from "../support/assertions.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applySlashUpdate,
  buildSlashInitialResult,
  clearSlashSnapshots,
  getSlashRenderableSnapshot,
} from "../../src/slash/slash-live-state.ts";

describe("slash live state", () => {
  it("shows a dynamic template agent before expansion and streams actual child progress", () => {
    clearSlashSnapshots();
    const details = buildSlashInitialResult("dynamic-preview", {
      chain: [
        {
          expand: { from: { output: "targets", path: "/items" }, maxItems: 2 },
          parallel: { agent: "reviewer", task: "Review {item}" },
          collect: { as: "reviews" },
        },
      ],
    });
    const initial = getSlashRenderableSnapshot(details);
    assert.equal(initial.result.details.results[0]?.agent, "reviewer");
    assert.equal(initial.result.details.results[0]?.task, "Review {item}");
    assert.deepEqual(initial.result.details.chainAgents, ["[reviewer]"]);
    assert.match(textAt(initial.result.content), /reviewer/);
    applySlashUpdate("dynamic-preview", {
      requestId: "dynamic-preview",
      progress: ["alpha", "beta"].map((item, index) => ({
        index,
        agent: "reviewer",
        status: "running",
        task: `Review ${item}`,
        currentTool: index === 0 ? "read" : "grep",
        recentTools: [],
        recentOutput: index === 0 ? ["src/index.ts", "src/render.ts"] : [`Inspecting ${item}`],
        toolCount: 1,
        tokens: 5,
        durationMs: 10,
      })),
    });
    const expanded = getSlashRenderableSnapshot(details);
    assert.deepEqual(
      expanded.result.details.progress?.map(({ task, currentTool }) => ({
        task,
        currentTool,
      })),
      [
        { task: "Review alpha", currentTool: "read" },
        { task: "Review beta", currentTool: "grep" },
      ],
    );
    assert.equal(expanded.result.details.results[0]?.progress?.task, "Review alpha");
    assert.equal(expanded.result.details.results[0]?.progress?.currentTool, "read");
    assert.deepEqual(expanded.result.details.results[0]?.progress?.recentOutput, [
      "src/index.ts",
      "src/render.ts",
    ]);
    assert.ok(expanded.version > initial.version);
  });
});
