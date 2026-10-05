import "../support/isolated-home.ts";
import { textAt } from "../support/assertions.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applySlashUpdate,
  buildSlashInitialResult,
  clearSlashSnapshots,
  finalizeSlashResult,
  getSlashRenderableSnapshot,
  restoreSlashFinalSnapshots,
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
        recentOutput: [`Inspecting ${item}`],
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
    assert.ok(expanded.version > initial.version);
  });

  it("streams progress updates into the visible slash snapshot", () => {
    clearSlashSnapshots();
    const details = buildSlashInitialResult("req-1", {
      agent: "scout",
      task: "scan codebase",
    });

    applySlashUpdate("req-1", {
      requestId: "req-1",
      currentTool: "find",
      toolCount: 2,
      progress: [
        {
          index: 0,
          agent: "scout",
          status: "running",
          task: "scan codebase",
          currentTool: "find",
          currentToolArgs: '{"pattern":"**/*.ts"}',
          recentTools: [{ tool: "ls", args: '{"path":"."}', endMs: 10 }],
          recentOutput: ["src/index.ts", "src/render.ts"],
          toolCount: 2,
          tokens: 120,
          durationMs: 400,
        },
      ],
    });

    const snapshot = getSlashRenderableSnapshot(details);
    const progress = snapshot.result.details.results[0].progress;
    assert.equal(progress?.currentTool, "find");
    assert.deepEqual(progress.recentOutput, ["src/index.ts", "src/render.ts"]);
    assert.equal(snapshot.version > 0, true);
  });

  it("prefers finalized snapshots and restores them from persisted custom messages", () => {
    clearSlashSnapshots();
    const details = buildSlashInitialResult("req-2", {
      agent: "scout",
      task: "scan codebase",
    });

    const finalDetails = finalizeSlashResult({
      requestId: "req-2",
      result: {
        content: [{ type: "text", text: "Done." }],
        details: {
          mode: "single",
          results: [
            {
              agent: "scout",
              task: "scan codebase",
              exitCode: 0,
              messages: [],
              usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
            },
          ],
        },
      },
      isError: false,
    });

    const liveFinal = getSlashRenderableSnapshot(details);
    assert.deepEqual(liveFinal.result.content[0], { type: "text", text: "Done." });

    clearSlashSnapshots();
    restoreSlashFinalSnapshots([
      {
        type: "custom_message",
        customType: "subagent-slash-result",
        display: true,
        details: finalDetails,
      },
    ]);

    const restored = getSlashRenderableSnapshot(details);
    assert.deepEqual(restored.result.content[0], { type: "text", text: "Done." });
  });
});
