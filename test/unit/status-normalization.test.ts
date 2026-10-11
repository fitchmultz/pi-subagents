import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { readStatus } from "../../src/shared/utils.ts";
import {
  flatToLogicalStepIndex,
  normalizeParallelGroups,
} from "../../src/runs/background/parallel-groups.ts";
import { sanitizeNestedPath } from "../../src/runs/shared/nested-path.ts";

describe("persisted run metadata normalization", () => {
  it("readStatus restores only the legacy finalization default without rewriting persisted evidence", () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "pi-subagents-legacy-status-"));
    const criterion = {
      id: "criterion-1",
      must: "Keep original acceptance",
      evidence: [],
      severity: "required",
    };
    const effectiveAcceptance = {
      level: "checked",
      explicit: true,
      inferredReason: ["explicit acceptance contract"],
      criteria: [criterion],
      evidence: [],
      verify: [],
      stopRules: ["Do not publish"],
    };
    const acceptance = {
      status: "rejected",
      explicit: true,
      effectiveAcceptance,
      inferredReason: ["explicit acceptance contract"],
      criteria: [criterion],
      runtimeChecks: [],
      verifyRuns: [],
    };
    const status = {
      runId: "legacy-acceptance",
      mode: "single",
      state: "complete",
      startedAt: 1,
      cwd: "/original-owner",
      steps: [{ agent: "worker", status: "complete", acceptance }],
    };
    const file = path.join(dir, "status.json");
    try {
      const original = JSON.stringify(status);
      fs.writeFileSync(file, original);
      const parsed = readStatus(dir);
      assert.ok(parsed);
      assert.equal(parsed.cwd, "/original-owner");
      assert.deepEqual(parsed.steps?.[0]?.acceptance, {
        ...acceptance,
        effectiveAcceptance: {
          ...effectiveAcceptance,
          finalization: { mode: "self-review-loop", maxTurns: 3 },
        },
      });
      assert.equal(readStatus(dir), parsed, "normalized snapshots retain cache identity");
      assert.equal(fs.readFileSync(file, "utf-8"), original);

      for (const invalid of [
        { ...status, runtimeVersion: 2 },
        { ...status, runtimeVersion: 3 },
        { ...status, cwd: 42 },
        {
          ...status,
          steps: [
            {
              agent: "worker",
              status: "complete",
              acceptance: { ...acceptance, criteria: undefined },
            },
          ],
        },
        ...[
          { finalization: null },
          { finalization: { mode: "self-review-loop", maxTurns: "3" } },
          { stopRules: [42] },
          { criteria: [{ ...criterion, severity: "optional" }] },
        ].map((fields) =>
          Object.assign({}, status, {
            steps: [
              {
                agent: "worker",
                status: "complete",
                acceptance: {
                  ...acceptance,
                  effectiveAcceptance: Object.assign({}, effectiveAcceptance, fields),
                },
              },
            ],
          }),
        ),
      ]) {
        const bytes = JSON.stringify(invalid);
        fs.writeFileSync(file, bytes);
        assert.throws(() => readStatus(dir), /Failed to parse async status file/);
        assert.equal(fs.readFileSync(file, "utf-8"), bytes);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps only nonnegative integer nested step indexes", () => {
    assert.deepEqual(
      sanitizeNestedPath([
        { runId: "a", stepIndex: -1 },
        { runId: "b", stepIndex: 1.5 },
        { runId: "c", stepIndex: 2 },
      ]),
      [{ runId: "a" }, { runId: "b" }, { runId: "c", stepIndex: 2 }],
    );
  });

  it("keeps empty logical groups at child boundaries without accepting invalid counts", () => {
    const groups = [
      { start: 0, count: 0, stepIndex: 0 },
      { start: 0, count: 2, stepIndex: 1 },
      { start: 2, count: 0, stepIndex: 2 },
      { start: 2, count: 1, stepIndex: 3 },
      { start: 3, count: 0, stepIndex: 4 },
    ];
    const normalized = normalizeParallelGroups(
      [
        ...groups,
        { start: 1, count: 0, stepIndex: 2 }, // Inside another group's children, not a boundary.
        { start: 3, count: 0, stepIndex: 4 }, // Duplicate logical group.
        { start: 4, count: 0, stepIndex: 4 }, // Beyond the last child boundary.
        ...[-1, 0.5, NaN, Infinity, "0"].map((count) => ({ start: 3, count, stepIndex: 4 })),
      ],
      3,
      5,
    );
    assert.deepEqual(normalized, groups);
    assert.deepEqual(
      [0, 1, 2].map((index) => flatToLogicalStepIndex(index, 5, normalized)),
      [1, 1, 3],
    );
  });

  it("drops overlapping and duplicate logical parallel groups", () => {
    assert.deepEqual(
      normalizeParallelGroups(
        [
          { start: 0, count: 2, stepIndex: 0 },
          { start: 1, count: 2, stepIndex: 1 },
          { start: 3, count: 1, stepIndex: 0 },
          { start: 3, count: 1, stepIndex: 2 },
        ],
        4,
        3,
      ),
      [
        { start: 0, count: 2, stepIndex: 0 },
        { start: 3, count: 1, stepIndex: 2 },
      ],
    );
  });
});
