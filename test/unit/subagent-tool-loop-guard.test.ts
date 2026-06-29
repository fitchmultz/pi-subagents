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

	it("resets when another tool starts", () => {
		const state = createRepeatedSubagentListGuardState();
		for (let i = 0; i < 4; i++) {
			recordToolStartForSubagentListLoopGuard({ state, toolName: "subagent", args: { action: "list" } });
		}
		recordToolStartForSubagentListLoopGuard({ state, toolName: "read", args: { path: "file.ts" } });
		assert.equal(recordToolStartForSubagentListLoopGuard({ state, toolName: "subagent", args: { action: "list" } }), undefined);
	});
});
