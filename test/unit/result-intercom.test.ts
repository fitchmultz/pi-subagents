import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  buildSubagentResultIntercomPayload,
  resolveSubagentResultStatus,
} from "../../src/intercom/result-intercom.ts";

describe("result intercom formatter", () => {
  it("builds one grouped intercom payload with status counts and child sections", () => {
    const payload = buildSubagentResultIntercomPayload({
      to: "subagent-chat-main",
      runId: "run-123",
      mode: "chain",
      source: "foreground",
      chainSteps: 4,
      children: [
        {
          agent: "reviewer-a",
          status: "completed",
          summary: "Completed checks",
          artifactPath: "/tmp/a.md",
          sessionPath: "/tmp/a-session.jsonl",
          intercomTarget: "subagent-reviewer-a-run-123-1",
        },
        {
          agent: "reviewer-b",
          status: "failed",
          summary: "Failed checks",
          artifactPath: "/tmp/b.md",
        },
      ],
    });

    assert.equal(payload.status, "failed");
    assert.equal(payload.summary, "1 completed, 1 failed");
    assert.equal(payload.children.length, 2);
    assert.match(payload.message, /^subagent results/m);
    assert.match(payload.message, /Run: run-123/);
    assert.match(payload.message, /Mode: chain/);
    assert.match(payload.message, /Status: failed/);
    assert.match(payload.message, /Children: 1 completed, 1 failed/);
    assert.doesNotMatch(payload.message, /without relaunching the same call/);
    assert.match(payload.message, /Chain steps: 4/);
    assert.match(
      payload.message,
      /Intercom targets below identify child sessions used while they were running/,
    );
    assert.match(payload.message, /1\. reviewer-a — completed/);
    assert.match(payload.message, /Run intercom target: subagent-reviewer-a-run-123-1/);
    assert.match(payload.message, /2\. reviewer-b — failed/);
    assert.match(payload.message, /Output artifact: \/tmp\/a\.md/);
    assert.match(payload.message, /Session: \/tmp\/a-session\.jsonl/);
  });

  it("keeps a workflow failure or pause separate from successful child evidence", () => {
    for (const status of ["failed", "paused"] as const) {
      const error =
        status === "failed"
          ? "Collected output validation failed: root: Expected object"
          : undefined;
      const children = [
        { agent: "producer", status: "completed" as const, summary: "targets" },
        { agent: "reviewer", status: "completed" as const, summary: "reviewed" },
      ];
      const payload = buildSubagentResultIntercomPayload({
        to: "parent",
        runId: "workflow",
        mode: "chain",
        source: "async",
        status,
        error,
        children,
      });
      assert.equal(payload.status, status);
      assert.deepEqual(
        payload.children.map((child) => child.status),
        ["completed", "completed"],
      );
      assert.equal(payload.summary, "2 completed");
      assert.match(payload.message, new RegExp(`Status: ${status}`));
      if (error !== undefined) {
        assert.ok(payload.message.includes(error));
      }
    }
  });

  it("tells nested orchestrators not to relaunch completed foreground calls", () => {
    const payload = buildSubagentResultIntercomPayload({
      to: "orchestrator",
      runId: "run-complete",
      mode: "single",
      source: "foreground",
      children: [{ agent: "delegate", status: "completed", summary: "done" }],
    });

    assert.match(payload.message, /This completes the matching subagent call/);
    assert.match(payload.message, /without relaunching the same call/);
  });

  it("advertises async revive only for single-child results with an existing session", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-intercom-"));
    try {
      const sessionPath = path.join(root, "session.jsonl");
      fs.writeFileSync(sessionPath, "", "utf-8");
      const payload = buildSubagentResultIntercomPayload({
        to: "chat",
        runId: "run-single",
        mode: "single",
        source: "async",
        asyncId: "run-single",
        children: [{ agent: "worker", status: "completed", summary: "done", sessionPath }],
      });

      assert.match(
        payload.message,
        /Continue: agent_runs\(\{ action: "continue", id: "run-single", message: "\.\.\." \}\)/,
      );
      assert.doesNotMatch(payload.message, /unsupported for multi-child/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("advertises indexed revive for multi-child async results with existing child sessions", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-intercom-"));
    try {
      const firstSession = path.join(root, "a.jsonl");
      const secondSession = path.join(root, "b.jsonl");
      fs.writeFileSync(firstSession, "", "utf-8");
      fs.writeFileSync(secondSession, "", "utf-8");
      const payload = buildSubagentResultIntercomPayload({
        to: "chat",
        runId: "run-multi",
        mode: "parallel",
        source: "async",
        asyncId: "run-multi",
        children: [
          { agent: "a", status: "completed", summary: "done", sessionPath: firstSession },
          { agent: "b", status: "completed", summary: "done", sessionPath: secondSession },
        ],
      });

      assert.match(
        payload.message,
        /Continue child: agent_runs\(\{ action: "continue", id: "run-multi", index: 0, message: "\.\.\." \}\)/,
      );
      assert.doesNotMatch(payload.message, /unsupported for multi-child/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not advertise async revive for missing child session files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-intercom-"));
    try {
      const payload = buildSubagentResultIntercomPayload({
        to: "chat",
        runId: "run-missing-session",
        mode: "single",
        source: "async",
        asyncId: "run-missing-session",
        children: [
          {
            agent: "worker",
            status: "failed",
            summary: "failed",
            sessionPath: path.join(root, "missing.jsonl"),
          },
        ],
      });

      assert.match(payload.message, /Resume: unavailable; no child session file was persisted/);
      assert.doesNotMatch(payload.message, /Revive:|Continue(?: child)?:/);
      assert.doesNotMatch(payload.message, /agent_runs\(\{ action: "continue"/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves paused and detached statuses", () => {
    assert.equal(resolveSubagentResultStatus({ interrupted: true }), "paused");
    assert.equal(resolveSubagentResultStatus({ detached: true }), "detached");
    assert.equal(resolveSubagentResultStatus({ timedOut: true }), "timed-out");
    assert.equal(resolveSubagentResultStatus({ success: true }), "completed");
    assert.equal(resolveSubagentResultStatus({ exitCode: 1 }), "failed");
  });
});
