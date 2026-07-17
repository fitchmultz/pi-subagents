import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { handleSubagentControlNotice } from "../../src/extension/control-notices.ts";
import registerSubagentNotify from "../../src/runs/background/notify.ts";
import {
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_CONTROL_EVENT,
	type SubagentState,
} from "../../src/shared/types.ts";

function makeState(): SubagentState {
	return {
		baseCwd: "/tmp/project",
		currentSessionId: null,
		asyncJobs: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

describe("completion-guard terminal wakeup", () => {
	it("emits one automatic trigger while keeping both completion and actionable control information visible", () => {
		const events = new EventEmitter();
		const sent: Array<{ message: { customType?: string; content?: string }; options: { triggerTurn?: boolean } }> = [];
		const pi = {
			events,
			sendMessage(message: { customType?: string; content?: string }, options: { triggerTurn?: boolean }) {
				sent.push({ message, options });
			},
		};
		const state = makeState();
		events.on(SUBAGENT_CONTROL_EVENT, (details) => handleSubagentControlNotice({
			pi,
			state,
			visibleControlNotices: new Set(),
			details,
		}));
		registerSubagentNotify(pi as never);

		events.emit(SUBAGENT_CONTROL_EVENT, {
			source: "async",
			event: {
				type: "needs_attention",
				to: "needs_attention",
				ts: 1,
				runId: "resume-run",
				agent: "worker",
				index: 0,
				message: "worker completed without making edits for an implementation task",
				reason: "completion_guard",
			},
		});
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "resume-run",
			agent: "worker",
			success: false,
			summary: "Subagent completed without making edits for an implementation task.",
			timestamp: 2,
		});

		assert.equal(sent.length, 2);
		assert.equal(sent.filter((entry) => entry.options.triggerTurn === true).length, 1);
		assert.deepEqual(sent.map((entry) => [entry.message.customType, entry.options.triggerTurn]), [
			["subagent_control_notice", false],
			["subagent-notify", true],
		]);
		assert.match(sent[0]?.message.content ?? "", /Next: read the output artifact or session/);
		assert.match(sent[1]?.message.content ?? "", /Background task failed/);
	});
});
