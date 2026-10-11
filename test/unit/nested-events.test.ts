import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { AsyncJobState } from "../../src/shared/types.ts";
import {
  createNestedRoute,
  hasLiveNestedDescendants,
  nestedSummaryFromAsyncStatus,
  projectNestedEvents,
  readNestedControlResults,
  resolveNestedParentAddressFromEnv,
  resolveNestedRouteFromEnv,
  updateAsyncJobNestedProjection,
  writeNestedEvent,
  writeNestedControlResult,
} from "../../src/runs/shared/nested-events.ts";
import {
  SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV,
  SUBAGENT_PARENT_CHILD_INDEX_ENV,
  SUBAGENT_PARENT_CONTROL_INBOX_ENV,
  SUBAGENT_PARENT_DEPTH_ENV,
  SUBAGENT_PARENT_EVENT_SINK_ENV,
  SUBAGENT_PARENT_PATH_ENV,
  SUBAGENT_PARENT_ROOT_RUN_ID_ENV,
  SUBAGENT_PARENT_RUN_ID_ENV,
} from "../../src/runs/shared/pi-args.ts";

const routes: Array<{ eventSink: string }> = [];
const savedEnv = {
  [SUBAGENT_PARENT_EVENT_SINK_ENV]: process.env[SUBAGENT_PARENT_EVENT_SINK_ENV],
  [SUBAGENT_PARENT_CONTROL_INBOX_ENV]: process.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV],
  [SUBAGENT_PARENT_ROOT_RUN_ID_ENV]: process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV],
  [SUBAGENT_PARENT_RUN_ID_ENV]: process.env[SUBAGENT_PARENT_RUN_ID_ENV],
  [SUBAGENT_PARENT_CHILD_INDEX_ENV]: process.env[SUBAGENT_PARENT_CHILD_INDEX_ENV],
  [SUBAGENT_PARENT_DEPTH_ENV]: process.env[SUBAGENT_PARENT_DEPTH_ENV],
  [SUBAGENT_PARENT_PATH_ENV]: process.env[SUBAGENT_PARENT_PATH_ENV],
  [SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV]: process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV],
};

afterEach(() => {
  for (const route of routes.splice(0)) {
    fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

function trackRoute(rootRunId = "root-run") {
  const route = createNestedRoute(rootRunId);
  routes.push(route);
  return route;
}

function child(
  id: string,
  state: "queued" | "running" | "complete" | "failed" | "paused",
  ts: number,
  parentRunId = "root-run",
) {
  return {
    id,
    parentRunId,
    parentStepIndex: 1,
    depth: 1,
    path: [{ runId: parentRunId, stepIndex: 1 }],
    mode: "single" as const,
    state,
    agent: "reviewer",
    agents: ["reviewer"],
    startedAt: 10,
    lastUpdate: ts,
    steps: [
      { agent: "leaf", status: state === "running" ? ("running" as const) : ("complete" as const) },
    ],
  };
}

describe("nested event route validation", () => {
  it("resolves nested parent addresses with full inherited path", () => {
    process.env[SUBAGENT_PARENT_RUN_ID_ENV] = "nested-parent";
    process.env[SUBAGENT_PARENT_CHILD_INDEX_ENV] = "2";
    process.env[SUBAGENT_PARENT_DEPTH_ENV] = "3";
    process.env[SUBAGENT_PARENT_PATH_ENV] = JSON.stringify([
      { runId: "root-run", stepIndex: 0, agent: "root-agent" },
      { runId: "../unsafe", stepIndex: 1, agent: "bad" },
      { runId: "nested-parent", stepIndex: 2, agent: "nested-agent" },
    ]);

    assert.deepEqual(resolveNestedParentAddressFromEnv(), {
      parentRunId: "nested-parent",
      parentStepIndex: 2,
      depth: 3,
      path: [
        { runId: "root-run", stepIndex: 0, agent: "root-agent" },
        { runId: "nested-parent", stepIndex: 2, agent: "nested-agent" },
      ],
    });
  });

  it("ignores unsafe nested parent ids from env", () => {
    process.env[SUBAGENT_PARENT_RUN_ID_ENV] = "../unsafe";
    process.env[SUBAGENT_PARENT_CHILD_INDEX_ENV] = "2";

    assert.equal(resolveNestedParentAddressFromEnv(), undefined);
  });

  it("resolves only matching contained routes from env", () => {
    const route = trackRoute();
    process.env[SUBAGENT_PARENT_EVENT_SINK_ENV] = route.eventSink;
    process.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV] = route.controlInbox;
    process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV] = route.rootRunId;
    process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV] = route.capabilityToken;

    assert.deepEqual(resolveNestedRouteFromEnv(), route);

    process.env[SUBAGENT_PARENT_EVENT_SINK_ENV] = path.resolve(
      route.eventSink,
      "../../../../outside-events",
    );
    assert.throws(() => resolveNestedRouteFromEnv(), /outside the subagent nested event root/);
    process.env[SUBAGENT_PARENT_EVENT_SINK_ENV] = route.eventSink;
    process.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV] = path.join(
      path.dirname(route.eventSink),
      "..",
      "different-route",
      "controls",
    );
    assert.throws(() => resolveNestedRouteFromEnv(), /share one route root/);
    process.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV] = route.controlInbox;
    process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV] = "different-root";
    assert.throws(() => resolveNestedRouteFromEnv(), /provided root id/);
    process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV] = route.rootRunId;
    process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV] = "wrong-token";
    assert.throws(() => resolveNestedRouteFromEnv(), /capability token/);
  });
});

describe("nested event parsing and projection", () => {
  it("never replays immutable events beyond 1000 and keeps durable recovery and control results", (t) => {
    const route = trackRoute();
    for (let ts = 1; ts <= 1001; ts++) {
      writeNestedEvent(route, {
        type: "subagent.nested.updated",
        ts,
        parentRunId: route.rootRunId,
        child: child("nested-a", "running", ts),
      });
    }
    writeNestedControlResult(route, {
      ts: 1002,
      requestId: "interrupt",
      targetRunId: "nested-a",
      ok: true,
      message: "Interrupted.",
    });
    const registry = projectNestedEvents(route);
    const reads = t.mock.method(fs, "readFileSync");
    syncBuiltinESMExports();
    try {
      const replay = projectNestedEvents(route);
      const eventReads = reads.mock.calls.filter((call) =>
        String(call.arguments[0]).startsWith(route.eventSink + path.sep),
      );
      assert.equal(
        eventReads.length,
        0,
        "already projected events must not be reread after the old dedup ceiling",
      );
      assert.deepEqual(replay, registry);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
    fs.unlinkSync(path.join(path.dirname(route.eventSink), "registry.json"));
    assert.deepEqual(
      projectNestedEvents(route),
      registry,
      "immutable event files can rebuild a lost sidecar",
    );
    assert.deepEqual(
      readNestedControlResults(route).map(({ requestId, ok }) => ({ requestId, ok })),
      [{ requestId: "interrupt", ok: true }],
    );
  });

  it("retains owner and child failure reasons in the shared status projection", () => {
    const summary = nestedSummaryFromAsyncStatus(
      {
        runId: "nested-failed",
        mode: "single",
        state: "failed",
        startedAt: 10,
        error: "Owner deadline expired",
        steps: [{ agent: "worker", status: "failed", error: "Child partial failure" }],
      },
      "/tmp/nested-failed",
      { id: "nested-failed", parentRunId: "root-run", depth: 1, ts: 20 },
    );
    assert.equal(summary.state, "failed");
    assert.equal(summary.error, "Owner deadline expired");
    assert.equal(summary.steps?.[0]?.error, "Child partial failure");
  });

  it("projects started, updated, and completed records into async and foreground parent state", () => {
    const route = trackRoute();
    writeNestedEvent(route, {
      type: "subagent.nested.started",
      ts: 100,
      parentRunId: "root-run",
      parentStepIndex: 1,
      child: child("nested-a", "running", 100),
    });
    writeNestedEvent(route, {
      type: "subagent.nested.updated",
      ts: 200,
      parentRunId: "root-run",
      parentStepIndex: 1,
      child: { ...child("nested-a", "running", 200), currentTool: "read" },
    });
    writeNestedEvent(route, {
      type: "subagent.nested.completed",
      ts: 300,
      parentRunId: "root-run",
      parentStepIndex: 1,
      child: child("nested-a", "complete", 300),
    });

    const registry = projectNestedEvents(route);
    assert.equal(registry.children.length, 1);
    assert.equal(registry.children[0]?.id, "nested-a");
    assert.equal(registry.children[0]?.state, "complete");
    assert.equal(registry.children[0]?.steps?.[0]?.agent, "leaf");

    const job: AsyncJobState = {
      asyncId: "root-run",
      asyncDir: "/tmp/root-run",
      status: "running",
      nestedRoute: route,
      steps: [
        { agent: "owner-0", status: "running", index: 0 },
        { agent: "owner-1", status: "running", index: 1 },
      ],
    };
    updateAsyncJobNestedProjection(job);
    assert.equal(job.nestedChildren?.[0]?.id, "nested-a");
    assert.equal(job.steps?.[1]?.children?.[0]?.id, "nested-a");
  });

  it("attaches root children to visible step slices by original step index", () => {
    const route = trackRoute();
    writeNestedEvent(route, {
      type: "subagent.nested.updated",
      ts: 100,
      parentRunId: "root-run",
      parentStepIndex: 3,
      child: {
        ...child("nested-visible", "running", 100),
        parentStepIndex: 3,
        path: [{ runId: "root-run", stepIndex: 3 }],
      },
    });
    const job: AsyncJobState = {
      asyncId: "root-run",
      asyncDir: "/tmp/root-run",
      status: "running",
      nestedRoute: route,
      steps: [
        { agent: "owner-2", status: "running", index: 2 },
        { agent: "owner-3", status: "running", index: 3 },
      ],
    };

    updateAsyncJobNestedProjection(job);

    assert.equal(job.steps?.[0]?.children, undefined);
    assert.equal(job.steps?.[1]?.children?.[0]?.id, "nested-visible");
  });

  it("ignores corrupt, partial, wrong-token, duplicate, and stale records while preserving terminal state", () => {
    const route = trackRoute();
    fs.writeFileSync(
      path.join(route.eventSink, "0000000000001-corrupt.json"),
      "{not json",
      "utf-8",
    );
    const partialFile = path.join(route.eventSink, "0000000000002-partial.jsonl");
    fs.writeFileSync(
      partialFile,
      `${JSON.stringify({
        type: "subagent.nested.started",
        ts: 50,
        rootRunId: route.rootRunId,
        parentRunId: "root-run",
        parentStepIndex: 1,
        capabilityToken: route.capabilityToken,
        child: child("partial-good", "running", 50),
      })}\n${JSON.stringify({
        type: "subagent.nested.started",
        ts: 51,
        rootRunId: route.rootRunId,
        parentRunId: "root-run",
        parentStepIndex: 1,
        capabilityToken: route.capabilityToken,
        child: child("valid-but-unpublished", "running", 51),
      })}`,
      "utf-8",
    );
    writeNestedEvent(route, {
      type: "subagent.nested.completed",
      ts: 300,
      parentRunId: "root-run",
      parentStepIndex: 1,
      child: child("nested-terminal", "complete", 300),
    });
    fs.writeFileSync(
      path.join(route.eventSink, "0000000000400-stale.json"),
      `${JSON.stringify({
        type: "subagent.nested.updated",
        ts: 400,
        rootRunId: route.rootRunId,
        parentRunId: "root-run",
        parentStepIndex: 1,
        capabilityToken: route.capabilityToken,
        child: child("nested-terminal", "running", 100),
      })}\n`,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(route.eventSink, "0000000000500-wrong-token.json"),
      `${JSON.stringify({
        type: "subagent.nested.started",
        ts: 500,
        rootRunId: route.rootRunId,
        parentRunId: "root-run",
        parentStepIndex: 1,
        capabilityToken: "wrong",
        child: child("wrong-token", "running", 500),
      })}\n`,
      "utf-8",
    );

    const registry = projectNestedEvents(route);
    assert.equal(registry.children.find((item) => item.id === "partial-good")?.state, "running");
    assert.equal(
      registry.children.some((item) => item.id === "valid-but-unpublished"),
      false,
      "valid JSON still requires a publication newline",
    );
    assert.equal(
      registry.children.find((item) => item.id === "nested-terminal")?.state,
      "complete",
    );
    assert.equal(
      registry.children.some((item) => item.id === "wrong-token"),
      false,
    );
    assert.equal(hasLiveNestedDescendants(registry.children), true);
    fs.appendFileSync(partialFile, "\n");
    // Event filenames are immutable; recover the now-published legacy file through a cold rebuild.
    fs.unlinkSync(path.join(path.dirname(route.eventSink), "registry.json"));
    const published = projectNestedEvents(route);
    assert.equal(
      published.children.find((item) => item.id === "valid-but-unpublished")?.state,
      "running",
    );
    assert.equal(
      published.children.find((item) => item.id === "nested-terminal")?.state,
      "complete",
    );
    assert.equal(
      published.children.some((item) => item.id === "wrong-token"),
      false,
    );
  });

  it("detects live descendants attached to terminal step children", () => {
    assert.equal(
      hasLiveNestedDescendants([
        {
          ...child("terminal-parent", "complete", 300),
          steps: [
            {
              agent: "owner-step",
              status: "complete",
              children: [
                {
                  ...child("running-step-child", "running", 310, "terminal-parent"),
                  parentStepIndex: 0,
                  path: [{ runId: "terminal-parent", stepIndex: 0 }],
                },
              ],
            },
          ],
        },
      ]),
      true,
    );
  });

  it("accepts only complete numeric token usage at the nested event boundary", () => {
    const route = trackRoute();
    writeNestedEvent(route, {
      type: "subagent.nested.updated",
      ts: 100,
      parentRunId: "root-run",
      parentStepIndex: 1,
      child: {
        ...child("nested-valid-tokens", "running", 100),
        totalTokens: { input: 10, output: 15, total: 25 },
      },
    });
    fs.writeFileSync(
      path.join(route.eventSink, "0000000000200-invalid-tokens.json"),
      `${JSON.stringify({
        type: "subagent.nested.updated",
        ts: 200,
        rootRunId: route.rootRunId,
        parentRunId: "root-run",
        parentStepIndex: 1,
        capabilityToken: route.capabilityToken,
        child: {
          ...child("nested-invalid-tokens", "running", 200),
          totalTokens: { input: 1, output: "bad", total: 1 },
        },
      })}\n`,
      "utf-8",
    );

    const registry = projectNestedEvents(route);

    assert.deepEqual(
      registry.children.find((item) => item.id === "nested-valid-tokens")?.totalTokens,
      { input: 10, output: 15, total: 25 },
    );
    assert.equal(
      registry.children.find((item) => item.id === "nested-invalid-tokens")?.totalTokens,
      undefined,
    );
  });
});
