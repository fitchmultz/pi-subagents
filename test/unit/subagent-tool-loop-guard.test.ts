import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createRepeatedSubagentCallGuardState,
	recordToolEndForSubagentLoopGuard,
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
			/stuck repeating subagent\(\{ action: "list" \}\) 5 times/,
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
			/stuck repeating subagent\(\{ action: "list" \}\) 5 times/,
		);
	});

	it("fails after repeated rejected delegation calls", () => {
		const state = createRepeatedSubagentCallGuardState();
		const args = { agent: "delegate", task: "nested work", async: false };
		let failure: string | undefined;
		for (let i = 0; i < 5; i++) {
			const toolCallId = `call-${i}`;
			assert.equal(recordToolStartForSubagentLoopGuard({ state, toolCallId, toolName: "subagent", args }), undefined);
			failure = recordToolEndForSubagentLoopGuard({ state, toolCallId, toolName: "subagent", isError: true });
		}
		assert.match(failure ?? "", /stuck repeating the same failed subagent call 5 times/);
	});

	it("matches failed calls regardless of argument key order", () => {
		const state = createRepeatedSubagentCallGuardState();
		let failure: string | undefined;
		for (let i = 0; i < 5; i++) {
			const toolCallId = `call-${i}`;
			const args = i % 2
				? { task: "nested work", async: false, agent: "delegate" }
				: { agent: "delegate", task: "nested work", async: false };
			recordToolStartForSubagentLoopGuard({ state, toolCallId, toolName: "subagent", args });
			failure = recordToolEndForSubagentLoopGuard({ state, toolCallId, toolName: "subagent", isError: true });
		}
		assert.match(failure ?? "", /stuck repeating the same failed subagent call 5 times/);
	});

	it("allows repeated successful delegation calls", () => {
		const state = createRepeatedSubagentCallGuardState();
		const args = { agent: "delegate", task: "repeat sample", async: false };
		for (let i = 0; i < 6; i++) {
			const toolCallId = `call-${i}`;
			assert.equal(recordToolStartForSubagentLoopGuard({ state, toolCallId, toolName: "subagent", args }), undefined);
			assert.equal(recordToolEndForSubagentLoopGuard({ state, toolCallId, toolName: "subagent", isError: false }), undefined);
		}
	});
});
