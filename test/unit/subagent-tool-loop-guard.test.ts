import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createRepeatedSubagentListGuardState,
	recordToolStartForSubagentListLoopGuard,
} from "../../src/runs/shared/subagent-tool-loop-guard.ts";

describe("subagent tool loop guard", () => {
	it("fails after repeated subagent list calls", () => {
		const state = createRepeatedSubagentListGuardState();
		for (let i = 0; i < 4; i++) {
			assert.equal(recordToolStartForSubagentListLoopGuard({ state, toolName: "subagent", args: { action: "list" } }), undefined);
		}
		assert.match(
			recordToolStartForSubagentListLoopGuard({ state, toolName: "subagent", args: { action: "list" } }) ?? "",
			/stuck repeating subagent\(\{ action: "list" \}\) 5 times/,
		);
	});

	it("catches non-consecutive list ping-pong within the recent window", () => {
		const state = createRepeatedSubagentListGuardState();
		for (let i = 0; i < 4; i++) {
			assert.equal(recordToolStartForSubagentListLoopGuard({ state, toolName: "subagent", args: { action: "list" } }), undefined);
			recordToolStartForSubagentListLoopGuard({ state, toolName: "read", args: { path: "file.ts" } });
		}
		assert.match(
			recordToolStartForSubagentListLoopGuard({ state, toolName: "subagent", args: { action: "list" } }) ?? "",
			/stuck repeating subagent\(\{ action: "list" \}\) 5 times/,
		);
	});
});
