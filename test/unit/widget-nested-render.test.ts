import "../support/isolated-home.ts";
import { createPlainTheme } from "../support/ui.ts";
import type { ReadonlyDeep } from "type-fest";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildWidgetLines, widgetRenderKey } from "../../src/tui/render.ts";
import type { AsyncJobState, NestedRunSummary } from "../../src/shared/types.ts";

const theme = createPlainTheme();

function nested(
  id: string,
  parentRunId: string,
  state: NestedRunSummary["state"] = "running",
  extra: ReadonlyDeep<Partial<NestedRunSummary>> = {},
): NestedRunSummary {
  return {
    id,
    parentRunId,
    parentStepIndex: 0,
    depth: 1,
    path: [{ runId: parentRunId, stepIndex: 0 }],
    state,
    agent: id,
    lastUpdate: 1_000,
    ...extra,
  };
}

function job(child: ReadonlyDeep<NestedRunSummary>): AsyncJobState {
  return {
    asyncId: "root-run",
    asyncDir: "/tmp/root-run",
    status: "running",
    mode: "single",
    agents: ["owner"],
    startedAt: 0,
    updatedAt: 1_500,
    steps: [{ index: 0, agent: "owner", status: "running", children: [child] }],
    stepsTotal: 1,
    nestedChildren: [child],
  };
}

describe("nested widget rendering", () => {
  it("hides nested runs when collapsed and shows full child rows when expanded", () => {
    const child = nested("nested-reviewer", "root-run", "running", { currentTool: "read" });
    const collapsedLines = buildWidgetLines([job(child)], theme, 120, false);
    assert.equal(collapsedLines.length, 1, "a single collapsed run should cost one terminal line");
    assert.doesNotMatch(collapsedLines[0], /nested-reviewer/);

    const expanded = buildWidgetLines([job(child)], theme, 120, true).join("\n");
    assert.match(expanded, /↳ . nested-reviewer · running · read/);
  });

  it("collapses descendants beyond the nested depth budget", () => {
    const root = nested("nested-root", "root-run", "running", {
      children: [
        nested("nested-child", "nested-root", "running", {
          parentStepIndex: undefined,
          children: [
            nested("nested-grandchild", "nested-child", "running", {
              parentStepIndex: undefined,
              children: [nested("nested-great-grandchild", "nested-grandchild")],
            }),
          ],
        }),
      ],
    });
    const expanded = buildWidgetLines([job(root)], theme, 160, true).join("\n");
    assert.match(expanded, /nested-grandchild/);
    assert.match(expanded, /\+1 nested run \(1 running\)/);
    assert.doesNotMatch(expanded, /nested-great-grandchild · running/);
  });

  it("shows running descendants even after the parent step is complete", () => {
    const child = nested("still-running", "root-run", "running");
    const state = job(child);
    state.status = "complete";
    state.steps = [{ index: 0, agent: "owner", status: "complete", children: [child] }];
    const expanded = buildWidgetLines([state], theme, 120, true).join("\n");
    assert.match(expanded, /✓ Step 1\/1: owner · complete/);
    assert.match(expanded, /↳ . still-running · running/);
  });

  it("degrades stale child summaries to id and state", () => {
    const child = nested("missing-metadata", "root-run", "failed", {
      agent: undefined,
      error: "owner gone",
    });
    const expanded = buildWidgetLines([job(child)], theme, 120, true).join("\n");
    assert.match(expanded, /missing-metadata · failed · Failed · owner gone/);
  });

  it("rerenders when only nested state changes", () => {
    const first = job(nested("nested-reviewer", "root-run", "running"));
    const second = job(nested("nested-reviewer", "root-run", "complete"));
    assert.notEqual(widgetRenderKey(first), widgetRenderKey(second));
  });
});
