import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createRepeatedSubagentCallGuardState,
	recordToolEndForSubagentLoopGuard,
	recordToolStartForSubagentLoopGuard,
} from "../../src/runs/shared/subagent-tool-loop-guard.ts";

for (const [toolName, action] of [["subagent", "list"], ["agent_runs", "profiles"]]) describe(`${toolName} discovery loop guard`, () => {
	it("fails after five discovery calls", () => {
		const state = createRepeatedSubagentCallGuardState();
		for (let i = 0; i < 4; i++) {
			assert.equal(recordToolStartForSubagentLoopGuard({ state, toolName, args: { action } }), undefined);
		}
		assert.equal(
			recordToolStartForSubagentLoopGuard({ state, toolName, args: { action } }),
			`Child appears stuck repeating ${toolName}({ action: "${action}" }) 5 times. Stopping to avoid a tool loop.`,
		);
	});

	it("catches non-consecutive list ping-pong within the recent window", () => {
		const state = createRepeatedSubagentCallGuardState();
		for (let i = 0; i < 4; i++) {
			assert.equal(recordToolStartForSubagentLoopGuard({ state, toolName, args: { action } }), undefined);
			recordToolStartForSubagentLoopGuard({ state, toolName: "read", args: { path: "file.ts" } });
		}
		assert.equal(
			recordToolStartForSubagentLoopGuard({ state, toolName, args: { action } }),
			`Child appears stuck repeating ${toolName}({ action: "${action}" }) 5 times. Stopping to avoid a tool loop.`,
		);
	});
});

for (const toolName of ["subagent", "delegate", "agent_runs"]) describe(`${toolName} failed call loop guard`, () => {
	it("fails after repeated rejected delegation calls", () => {
		const state = createRepeatedSubagentCallGuardState();
		const args = { agent: "delegate", task: "nested work", async: false };
		let failure: string | undefined;
		for (let i = 0; i < 5; i++) {
			const toolCallId = `call-${i}`;
			assert.equal(recordToolStartForSubagentLoopGuard({ state, toolCallId, toolName, args }), undefined);
			failure = recordToolEndForSubagentLoopGuard({ state, toolCallId, toolName, isError: true });
			if (i < 4) assert.equal(failure, undefined);
		}
		assert.equal(failure, `Child appears stuck repeating the same failed ${toolName} call 5 times. Stopping to avoid a tool loop.`);
	});

	it("keeps failed-call history across unrelated tools", () => {
		const state = createRepeatedSubagentCallGuardState();
		const args = { agent: "delegate", task: "nested work", async: false };
		let failure: string | undefined;
		for (let i = 0; i < 5; i++) {
			const toolCallId = `call-${i}`;
			recordToolStartForSubagentLoopGuard({ state, toolCallId, toolName, args });
			failure = recordToolEndForSubagentLoopGuard({ state, toolCallId, toolName, isError: true });
			if (i < 4) assert.equal(failure, undefined);
			recordToolStartForSubagentLoopGuard({ state, toolName: "read", args: { path: "one.ts" } });
			recordToolStartForSubagentLoopGuard({ state, toolName: "read", args: { path: "two.ts" } });
		}
		assert.equal(failure, `Child appears stuck repeating the same failed ${toolName} call 5 times. Stopping to avoid a tool loop.`);
	});

	it("matches failed calls regardless of argument key order", () => {
		const state = createRepeatedSubagentCallGuardState();
		let failure: string | undefined;
		for (let i = 0; i < 5; i++) {
			const toolCallId = `call-${i}`;
			const args = i % 2
				? { task: "nested work", async: false, agent: "delegate" }
				: { agent: "delegate", task: "nested work", async: false };
			recordToolStartForSubagentLoopGuard({ state, toolCallId, toolName, args });
			failure = recordToolEndForSubagentLoopGuard({ state, toolCallId, toolName, isError: true });
			if (i < 4) assert.equal(failure, undefined);
		}
		assert.equal(failure, `Child appears stuck repeating the same failed ${toolName} call 5 times. Stopping to avoid a tool loop.`);
	});

	it("matches a failed end when only the end includes a tool call id", () => {
		const state = createRepeatedSubagentCallGuardState();
		const args = { agent: "delegate", task: "nested work" };
		let failure: string | undefined;
		for (let i = 0; i < 5; i++) {
			recordToolStartForSubagentLoopGuard({ state, toolName, args });
			failure = recordToolEndForSubagentLoopGuard({ state, toolCallId: `call-${i}`, toolName, isError: true });
		}
		assert.equal(failure, `Child appears stuck repeating the same failed ${toolName} call 5 times. Stopping to avoid a tool loop.`);
	});

	it("ignores arguments that cannot be canonicalized", () => {
		const state = createRepeatedSubagentCallGuardState();
		const args: Record<string, unknown> = { agent: "delegate" };
		args.self = args;
		assert.doesNotThrow(() => recordToolStartForSubagentLoopGuard({ state, toolName, args }));
		assert.equal(state.recentSubagentCalls.length, 0);
	});

	it("allows repeated successful delegation calls", () => {
		const state = createRepeatedSubagentCallGuardState();
		const args = { agent: "delegate", task: "repeat sample", async: false };
		for (let i = 0; i < 6; i++) {
			const toolCallId = `call-${i}`;
			assert.equal(recordToolStartForSubagentLoopGuard({ state, toolCallId, toolName, args }), undefined);
			assert.equal(recordToolEndForSubagentLoopGuard({ state, toolCallId, toolName, isError: false }), undefined);
		}
	});

	it("expires failed calls after nine tracked starts", () => {
		const state = createRepeatedSubagentCallGuardState();
		for (let i = 0; i < 10; i++) {
			recordToolStartForSubagentLoopGuard({ state, toolName, args: { task: i < 4 || i === 9 ? "same" : `other-${i}` } });
			assert.equal(recordToolEndForSubagentLoopGuard({ state, toolName, isError: true }), undefined);
		}
		assert.equal(state.recentSubagentCalls.length, 9);
	});

	it("matches tool call IDs without counting duplicate or unknown failed ends", () => {
		const state = createRepeatedSubagentCallGuardState();
		for (let i = 0; i < 5; i++) {
			recordToolStartForSubagentLoopGuard({ state, toolName, toolCallId: `call-${i}`, args: { task: "same" } });
		}
		assert.equal(recordToolEndForSubagentLoopGuard({ state, toolName, toolCallId: "unknown", isError: true }), undefined);
		for (let i = 4; i > 0; i--) {
			assert.equal(recordToolEndForSubagentLoopGuard({ state, toolName, toolCallId: `call-${i}`, isError: true }), undefined);
			assert.equal(recordToolEndForSubagentLoopGuard({ state, toolName, toolCallId: `call-${i}`, isError: true }), undefined);
		}
		assert.match(recordToolEndForSubagentLoopGuard({ state, toolName, toolCallId: "call-0", isError: true }) ?? "", /5 times/);
	});
});

describe("mixed child tools", () => {
	it("shares the discovery window across legacy and compact names, but not run listing", () => {
		const state = createRepeatedSubagentCallGuardState();
		for (let i = 0; i < 4; i++) {
			assert.equal(recordToolStartForSubagentLoopGuard({ state, toolName: "subagent", args: { action: "list" } }), undefined);
			assert.equal(recordToolStartForSubagentLoopGuard({ state, toolName: "agent_runs", args: { action: "list" } }), undefined);
		}
		assert.match(recordToolStartForSubagentLoopGuard({ state, toolName: "agent_runs", args: { action: "profiles" } }) ?? "", /5 times/);
		for (let i = 0; i < 9; i++) {
			assert.equal(recordToolStartForSubagentLoopGuard({ state, toolName: "read", args: {} }), undefined);
		}
		assert.equal(recordToolStartForSubagentLoopGuard({ state, toolName: "agent_runs", args: { action: "profiles" } }), undefined);
		assert.equal(state.recentStarts.length, 9);
	});

	it("keeps identical arguments and missing-ID ends separate by tool name", () => {
		const state = createRepeatedSubagentCallGuardState();
		for (let i = 0; i < 4; i++) {
			recordToolStartForSubagentLoopGuard({ state, toolName: "delegate", args: { task: "same" } });
			assert.equal(recordToolEndForSubagentLoopGuard({ state, toolName: "delegate", isError: true }), undefined);
		}
		recordToolStartForSubagentLoopGuard({ state, toolName: "agent_runs", args: { task: "same" } });
		recordToolStartForSubagentLoopGuard({ state, toolName: "delegate", args: { task: "same" } });
		assert.equal(recordToolEndForSubagentLoopGuard({ state, toolName: "agent_runs", isError: true }), undefined);
		assert.equal(recordToolEndForSubagentLoopGuard({ state, toolName: "read", isError: true }), undefined);
		assert.match(recordToolEndForSubagentLoopGuard({ state, toolName: "delegate", isError: true }) ?? "", /failed delegate call 5 times/);
	});
});
