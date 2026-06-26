import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildControlEvent,
	claimControlNotification,
	controlNotificationKey,
	deriveActivityState,
	formatControlIntercomMessage,
	formatControlNoticeMessage,
	resolveControlConfig,
	shouldNotifyControlEvent,
} from "../../src/runs/shared/subagent-control.ts";
import { nextLongRunningTrigger } from "../../src/runs/shared/long-running-guard.ts";

const config = resolveControlConfig(undefined, {
	needsAttentionAfterMs: 300,
});

describe("subagent control attention state", () => {
	it("marks a run as needing attention only after the idle threshold", () => {
		assert.equal(deriveActivityState({ config, startedAt: 0, lastActivityAt: 0, now: 50 }), undefined);
		assert.equal(deriveActivityState({ config, startedAt: 0, lastActivityAt: 0, now: 400 }), "needs_attention");
		assert.equal(deriveActivityState({ config, startedAt: 0, now: 400 }), "needs_attention");
	});


	it("builds compact needs-attention control events", () => {
		const event = buildControlEvent({
			to: "needs_attention",
			runId: "run-1",
			agent: "worker",
			index: 2,
			ts: 1_000,
			lastActivityAt: 100,
		});
		assert.deepEqual(event, {
			type: "needs_attention",
			to: "needs_attention",
			ts: 1_000,
			runId: "run-1",
			agent: "worker",
			index: 2,
			message: "worker needs attention (no observed activity for 0s)",
			reason: "idle",
			elapsedMs: 900,
		});
	});

	it("supports a specific attention message", () => {
		const event = buildControlEvent({
			to: "needs_attention",
			runId: "run-1",
			agent: "worker",
			message: "worker completed without making edits for an implementation task",
		});

		assert.equal(event.message, "worker completed without making edits for an implementation task");
	});

	it("builds terminal completion guard control events", () => {
		const event = buildControlEvent({
			to: "needs_attention",
			runId: "run-1",
			agent: "worker",
			message: "worker completed without making edits for an implementation task",
			reason: "completion_guard",
		});

		assert.equal(event.reason, "completion_guard");
	});

	it("defaults notifications to active-long-running and needs attention", () => {
		const event = buildControlEvent({ to: "needs_attention", runId: "run-1", agent: "worker" });
		const activeEvent = buildControlEvent({ type: "active_long_running", to: "active_long_running", runId: "run-1", agent: "worker" });
		assert.equal(shouldNotifyControlEvent(config, event), true);
		assert.equal(shouldNotifyControlEvent(config, activeEvent), true);
		assert.deepEqual(config.notifyOn, ["active_long_running", "needs_attention"]);
		assert.deepEqual(config.notifyChannels, ["event", "async", "intercom"]);
	});

	it("defaults active-long-running notices to elapsed time only", () => {
		const defaults = resolveControlConfig();

		assert.equal(defaults.activeNoticeAfterMs, 240_000);
		assert.equal(defaults.activeNoticeAfterTurns, undefined);
		assert.equal(defaults.activeNoticeAfterTokens, undefined);
		assert.equal(nextLongRunningTrigger(defaults, {
			startedAt: 0,
			now: 77_000,
			turns: 50,
			tokens: 800_000,
		}), undefined);
		assert.equal(nextLongRunningTrigger(defaults, {
			startedAt: 0,
			now: 240_000,
			turns: 1,
			tokens: 1,
		}), "time_threshold");
	});

	it("supports opt-in turn and token long-running thresholds", () => {
		const tokenBudget = resolveControlConfig(undefined, { activeNoticeAfterMs: 999_999, activeNoticeAfterTokens: 500_000 });
		const turnBudget = resolveControlConfig(undefined, { activeNoticeAfterMs: 999_999, activeNoticeAfterTurns: 5 });

		assert.equal(nextLongRunningTrigger(tokenBudget, {
			startedAt: 0,
			now: 77_000,
			turns: 1,
			tokens: 500_000,
		}), "token_threshold");
		assert.equal(nextLongRunningTrigger(turnBudget, {
			startedAt: 0,
			now: 77_000,
			turns: 5,
			tokens: 1,
		}), "turn_threshold");
	});

	it("resolves custom notification config", () => {
		const custom = resolveControlConfig(undefined, {
			needsAttentionAfterMs: 1234,
			activeNoticeAfterMs: 2345,
			activeNoticeAfterTurns: 7,
			activeNoticeAfterTokens: 8000,
			failedToolAttemptsBeforeAttention: 4,
			notifyOn: ["active_long_running", "needs_attention", "nope" as never],
			notifyChannels: ["event", "intercom", "bad" as never],
		});
		assert.equal(custom.needsAttentionAfterMs, 1234);
		assert.equal(custom.activeNoticeAfterMs, 2345);
		assert.equal(custom.activeNoticeAfterTurns, 7);
		assert.equal(custom.activeNoticeAfterTokens, 8000);
		assert.equal(custom.failedToolAttemptsBeforeAttention, 4);
		assert.deepEqual(custom.notifyOn, ["active_long_running", "needs_attention"]);
		assert.deepEqual(custom.notifyChannels, ["event", "intercom"]);
	});

	it("falls back to defaults for invalid non-empty notification arrays", () => {
		const custom = resolveControlConfig(undefined, {
			notifyOn: ["bogus" as never],
			notifyChannels: ["bogus" as never],
		});
		assert.deepEqual(custom.notifyOn, ["active_long_running", "needs_attention"]);
		assert.deepEqual(custom.notifyChannels, ["event", "async", "intercom"]);
	});

	it("allows empty notification arrays to disable notifications", () => {
		const custom = resolveControlConfig(undefined, {
			notifyOn: [],
			notifyChannels: [],
		});
		const event = buildControlEvent({ to: "needs_attention", runId: "run-1", agent: "worker" });
		assert.deepEqual(custom.notifyOn, []);
		assert.deepEqual(custom.notifyChannels, []);
		assert.equal(shouldNotifyControlEvent(custom, event), false);
	});

	it("formats control notices with a proactive hint and concrete commands", () => {
		const event = buildControlEvent({ to: "needs_attention", runId: "78f659a3", agent: "worker" });

		const message = formatControlNoticeMessage(event, "subagent-worker-78f659a3");

		assert.equal(message, [
			"Subagent needs attention: worker",
			"Run: 78f659a3",
			"Signal: worker needs attention",
			"Hint: Inspect status first unless the run is clearly blocked.",
			"Nudge: subagent({ action: \"nudge\", id: \"78f659a3\", message: \"What are you blocked on? Reply with the smallest next step, or state the exact decision you need.\" })",
			"Ask: intercom({ action: \"ask\", to: \"subagent-worker-78f659a3\", delivery: \"steer\", message: \"What are you blocked on? Reply with the smallest next step, or state the exact decision you need.\" })",
			"Status: subagent({ action: \"status\", id: \"78f659a3\" })",
			"Interrupt: subagent({ action: \"interrupt\", id: \"78f659a3\" })",
		].join("\n"));
	});

	it("formats active-long-running notices as informational", () => {
		const event = buildControlEvent({
			type: "active_long_running",
			to: "active_long_running",
			runId: "78f659a3",
			agent: "worker",
			turns: 15,
			tokens: 160000,
			toolCount: 42,
			currentTool: "edit",
			currentPath: "src/runs/background/async-status.ts",
			reason: "turn_threshold",
		});

		const message = formatControlNoticeMessage(event, "subagent-worker-78f659a3-1");

		assert.equal(message, [
			"Subagent active but long-running: worker",
			"Run: 78f659a3",
			"Signal: worker is still active but long-running",
			"Facts: 15 turns | 160000 tokens | 42 tools | tool edit | path src/runs/background/async-status.ts",
			"Hint: Inspect status, then nudge if the work seems stuck.",
			"Nudge: subagent({ action: \"nudge\", id: \"78f659a3\", message: \"What are you blocked on? Reply with the smallest next step, or state the exact decision you need.\" })",
			"Ask: intercom({ action: \"ask\", to: \"subagent-worker-78f659a3-1\", delivery: \"steer\", message: \"What are you blocked on? Reply with the smallest next step, or state the exact decision you need.\" })",
			"Status: subagent({ action: \"status\", id: \"78f659a3\" })",
			"Interrupt: subagent({ action: \"interrupt\", id: \"78f659a3\" })",
		].join("\n"));
	});

	it("formats terminal completion guard notices without live-run commands", () => {
		const event = buildControlEvent({
			to: "needs_attention",
			runId: "78f659a3",
			agent: "worker",
			index: 0,
			message: "worker completed without making edits for an implementation task",
			reason: "completion_guard",
		});

		const message = formatControlNoticeMessage(event, "subagent-worker-78f659a3-1");

		assert.match(message, /Subagent failed: worker/);
		assert.match(message, /read the output artifact or session/);
		assert.match(message, /Run intercom target \(may be inactive\): subagent-worker-78f659a3-1/);
		assert.doesNotMatch(message, /Status:/);
		assert.doesNotMatch(message, /Interrupt:/);
		assert.doesNotMatch(message, /What are you blocked on/);
	});

	it("formats intercom notifications with the same control commands", () => {
		const event = buildControlEvent({ to: "needs_attention", runId: "78f659a3", agent: "worker" });

		const message = formatControlIntercomMessage(event, "subagent-worker-78f659a3");

		assert.equal(message, [
			"subagent needs attention",
			"",
			"worker needs attention in run 78f659a3.",
			"",
			"Subagent needs attention: worker",
			"Run: 78f659a3",
			"Signal: worker needs attention",
			"Hint: Inspect status first unless the run is clearly blocked.",
			"Nudge: subagent({ action: \"nudge\", id: \"78f659a3\", message: \"What are you blocked on? Reply with the smallest next step, or state the exact decision you need.\" })",
			"Ask: intercom({ action: \"ask\", to: \"subagent-worker-78f659a3\", delivery: \"steer\", message: \"What are you blocked on? Reply with the smallest next step, or state the exact decision you need.\" })",
			"Status: subagent({ action: \"status\", id: \"78f659a3\" })",
			"Interrupt: subagent({ action: \"interrupt\", id: \"78f659a3\" })",
		].join("\n"));
	});

	it("dedupes notifications once per child target and attention state", () => {
		const event = buildControlEvent({ to: "needs_attention", runId: "run-1", agent: "worker", index: 0 });
		const seen = new Set<string>();

		assert.equal(controlNotificationKey(event, "subagent-worker-run-1-1"), "subagent-worker-run-1-1:needs_attention:idle");
		assert.equal(claimControlNotification(resolveControlConfig(), event, seen, "subagent-worker-run-1-1"), true);
		assert.equal(claimControlNotification(resolveControlConfig(), event, seen, "subagent-worker-run-1-1"), false);

		const terminalEvent = buildControlEvent({
			to: "needs_attention",
			runId: "run-1",
			agent: "worker",
			index: 0,
			message: "worker completed without making edits for an implementation task",
			reason: "completion_guard",
		});
		assert.equal(claimControlNotification(resolveControlConfig(), terminalEvent, seen, "subagent-worker-run-1-1"), true);
	});
});
