import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createRepeatedSubagentCallGuardState,
	recordToolStartForSubagentLoopGuard,
} from "../../src/runs/shared/subagent-tool-loop-guard.ts";

describe("subagent tool loop guard", () => {
	it("fails after repeated subagent list calls", () => {
		const state = createRepeatedSubagentCallGuardState();
		for (let i = 0; i < 4; i++) {
			assert.equal(recordToolStartForSubagentLoopGuard({ state, toolName: "subagent", args: { action: "list" } }), undefined);
		}
		assert.match(
			recordToolStartForSubagentLoopGuard({ state, toolName: "subagent", args: { action: "list" } }) ?? "",
			/stuck repeating the same subagent call 5 times/,
		);
	});

	it("catches non-consecutive list ping-pong within the recent window", () => {
		const state = createRepeatedSubagentCallGuardState();
		for (let i = 0; i < 4; i++) {
			assert.equal(recordToolStartForSubagentLoopGuard({ state, toolName: "subagent", args: { action: "list" } }), undefined);
			recordToolStartForSubagentLoopGuard({ state, toolName: "read", args: { path: "file.ts" } });
		}
		assert.match(
			recordToolStartForSubagentLoopGuard({ state, toolName: "subagent", args: { action: "list" } }) ?? "",
			/stuck repeating the same subagent call 5 times/,
		);
	});

	it("fails after repeated rejected delegation calls", () => {
		const state = createRepeatedSubagentCallGuardState();
		const args = { agent: "delegate", task: "nested work", async: false };
		for (let i = 0; i < 4; i++) {
			assert.equal(recordToolStartForSubagentLoopGuard({ state, toolName: "subagent", args }), undefined);
		}
		assert.match(
			recordToolStartForSubagentLoopGuard({ state, toolName: "subagent", args }) ?? "",
			/stuck repeating the same subagent call 5 times/,
		);
	});
});
