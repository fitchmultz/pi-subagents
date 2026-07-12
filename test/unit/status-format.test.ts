import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aggregateStepStatus, buildManagementControl, formatActivityLabel, formatParallelOutcome } from "../../src/shared/status-format.ts";
import type { AsyncJobStep } from "../../src/shared/types.ts";

describe("status format helpers", () => {
	it("formats activity labels consistently", () => {
		assert.equal(formatActivityLabel(1_000, undefined, 1_500), "active now");
		assert.equal(formatActivityLabel(1_000, "needs_attention", 4_000), "no activity for 3s");
	});

	it("aggregates step status and parallel outcomes", () => {
		const steps = [{ status: "complete" }, { status: "running" }, { status: "failed" }] satisfies Array<Pick<AsyncJobStep, "status">>;
		assert.equal(aggregateStepStatus(steps), "running");
		assert.equal(formatParallelOutcome(steps, 3), "1 agent running · 1/3 succeeded · 1 failed");
		assert.equal(formatParallelOutcome(steps, 3, { showRunning: false }), "1/3 succeeded · 1 failed");
	});

	it("normalizes valid management actions for live and terminal states", () => {
		const unsupported = buildManagementControl({ state: "live", runId: "unsupported" });
		assert.deepEqual(unsupported.capabilities, ["status"]);

		const live = buildManagementControl({ state: "live", runId: "live-1", index: 2, intercomTarget: "child-target", canNudge: true, canResume: true, canInterrupt: true, canExtend: true });
		assert.deepEqual(live.capabilities, ["status", "nudge", "resume", "interrupt", "extend"]);
		assert.deepEqual(live.nextActions.find(({ action }) => action === "nudge"), { action: "nudge", runId: "live-1", index: 2, intercomTarget: "child-target" });

		for (const state of ["completed", "paused", "failed"] as const) {
			const terminal = buildManagementControl({ state, runId: `${state}-1`, canResume: true });
			assert.deepEqual(terminal.capabilities, ["status", "resume"]);
			assert.equal(terminal.capabilities.includes("nudge"), false);
		}
	});

	it("marks revived targets and invalidates prior pending replies", () => {
		const revived = buildManagementControl({ state: "live", runId: "new-1", canNudge: true, canResume: true, canInterrupt: true, revivedFromRunId: "old-1" });
		assert.equal(revived.revivedFromRunId, "old-1");
		assert.equal(revived.pendingReplyContextValid, false);
	});
});
