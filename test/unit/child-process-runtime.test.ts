import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import type { ChildProcess } from "node:child_process";
import type { ClaudeCodeInvocation } from "../../src/runs/shared/claude-code.ts";
import {
	createFinalDrain,
	FINAL_STOP_GRACE_MS,
	parseChildProcessEvent,
	stopChildWithEscalation,
} from "../../src/runs/shared/child-process-runtime.ts";

function useFakeTimeouts(t: TestContext): void {
	t.mock.timers.enable({ apis: ["setTimeout"] });
}

function signalRecorder(): { child: Pick<ChildProcess, "kill">; signals: NodeJS.Signals[] } {
	const signals: NodeJS.Signals[] = [];
	return {
		child: {
			kill(signal?: NodeJS.Signals | number) {
				if (typeof signal === "string") signals.push(signal);
				return true;
			},
		},
		signals,
	};
}

const claudeInvocation: ClaudeCodeInvocation = {
	command: "claude",
	args: [],
	env: {},
	sessionId: "session-1",
	resuming: false,
	model: {
		inputModel: "claude-code/sonnet",
		family: "sonnet",
		context: "300k",
		cliModel: "sonnet",
		autoCompactWindow: "300000",
	},
};

describe("child process event parsing", () => {
	it("returns undefined for invalid or non-object JSON and preserves valid Pi events", () => {
		assert.equal(parseChildProcessEvent("{bad-json"), undefined);
		for (const value of [null, true, 1, "event", []]) {
			assert.equal(parseChildProcessEvent(JSON.stringify(value)), undefined);
		}
		assert.deepEqual(parseChildProcessEvent(JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: "a.ts" } })), {
			type: "tool_execution_start",
			toolName: "read",
			args: { path: "a.ts" },
		});
	});

	it("normalizes Claude result events into Pi assistant messages", () => {
		const event = parseChildProcessEvent(JSON.stringify({
			type: "result",
			result: "finished",
			session_id: "session-2",
			total_cost_usd: 0.25,
			usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 3 },
			modelUsage: { "claude-sonnet-4-6": { contextWindow: 300000 } },
		}), { claudeCodeInvocation: claudeInvocation });

		assert.equal(event?.type, "message_end");
		assert.equal(event?.message?.role, "assistant");
		assert.deepEqual(event?.message?.content, [{ type: "text", text: "finished" }]);
		assert.equal(event?.message?.model, "claude-sonnet-4-6");
		assert.deepEqual(event?.message?.usage, {
			input: 12,
			output: 4,
			cacheRead: 3,
			cacheWrite: 0,
			cost: { total: 0.25 },
		});
	});
});

describe("child process timer and signal state", () => {
	it("starts once, escalates to SIGTERM, then hard-kills a child that stays alive", (t) => {
		useFakeTimeouts(t);
		const { child, signals } = signalRecorder();
		const forcedStops: boolean[] = [];
		const drain = createFinalDrain(child, () => false, (clean) => forcedStops.push(clean));

		drain.start(false);
		drain.start(true);
		t.mock.timers.tick(FINAL_STOP_GRACE_MS);
		assert.deepEqual(signals, ["SIGTERM"]);
		assert.deepEqual(forcedStops, [true]);
		assert.equal(drain.forcedTerminationSignal, true);
		assert.equal(drain.cleanTerminalStop, true);

		t.mock.timers.tick(3000);
		assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
	});

	it("does not signal after the child exits before the drain timeout", (t) => {
		useFakeTimeouts(t);
		const { child, signals } = signalRecorder();
		const drain = createFinalDrain(child, () => false, () => assert.fail("must not force an exited child"));

		drain.start(false);
		drain.markExited();
		t.mock.timers.tick(FINAL_STOP_GRACE_MS + 3000);
		assert.deepEqual(signals, []);
	});

	it("cancels pending drain and hard-kill timers when cleared", (t) => {
		useFakeTimeouts(t);
		const pending = signalRecorder();
		const pendingDrain = createFinalDrain(pending.child, () => false, () => {});
		pendingDrain.start(false);
		pendingDrain.clear();
		t.mock.timers.tick(FINAL_STOP_GRACE_MS);
		assert.deepEqual(pending.signals, []);

		const escalating = signalRecorder();
		const escalatingDrain = createFinalDrain(escalating.child, () => false, () => {});
		escalatingDrain.start(false);
		t.mock.timers.tick(FINAL_STOP_GRACE_MS);
		escalatingDrain.clear();
		t.mock.timers.tick(3000);
		assert.deepEqual(escalating.signals, ["SIGTERM"]);
	});

	it("sends SIGINT immediately and only escalates while the child is active", (t) => {
		useFakeTimeouts(t);
		const active = signalRecorder();
		stopChildWithEscalation(active.child, () => false);
		assert.deepEqual(active.signals, ["SIGINT"]);
		t.mock.timers.tick(1000);
		assert.deepEqual(active.signals, ["SIGINT", "SIGTERM"]);

		const stopped = signalRecorder();
		stopChildWithEscalation(stopped.child, () => true);
		t.mock.timers.tick(1000);
		assert.deepEqual(stopped.signals, ["SIGINT"]);
	});

	it("hard-kills an externally aborted child that ignores SIGTERM", (t) => {
		useFakeTimeouts(t);
		const { child, signals } = signalRecorder();
		stopChildWithEscalation(child, () => false, {
			initialSignal: "SIGTERM",
			escalationSignal: "SIGKILL",
			delayMs: 3000,
		});

		assert.deepEqual(signals, ["SIGTERM"]);
		t.mock.timers.tick(2999);
		assert.deepEqual(signals, ["SIGTERM"]);
		t.mock.timers.tick(1);
		assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
	});
});
