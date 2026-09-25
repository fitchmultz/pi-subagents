import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleSubagentControlNotice } from "../../src/extension/control-notices.ts";
import type { ControlEvent } from "../../src/shared/types.ts";

function needsAttentionEvent(overrides: Partial<ControlEvent> = {}): ControlEvent {
	return { type: "needs_attention", to: "needs_attention", ts: 1, runId: "run-1", agent: "worker", index: 0, message: "worker needs attention", reason: "idle", ...overrides };
}

function makeRecorder() {
	const sent: Array<{ message: unknown; options: unknown }> = [];
	return { sent, pi: { sendMessage(message: unknown, options: unknown) { sent.push({ message, options }); } } };
}

describe("subagent control notice delivery", () => {
	it("delivers owner needs-attention notices immediately", () => {
		const recorder = makeRecorder();
		handleSubagentControlNotice({ pi: recorder.pi, visibleControlNotices: new Set(), details: { source: "async", event: needsAttentionEvent() } });
		assert.equal(recorder.sent.length, 1);
		assert.deepEqual(recorder.sent[0]?.options, { triggerTurn: true });
	});

	it("keeps owner completion-guard notices visible without a second automatic wakeup", () => {
		const recorder = makeRecorder();
		handleSubagentControlNotice({ pi: recorder.pi, visibleControlNotices: new Set(), details: { source: "async", event: needsAttentionEvent({ reason: "completion_guard" }) } });
		assert.equal(recorder.sent.length, 1);
		assert.deepEqual(recorder.sent[0]?.options, { triggerTurn: false });
		assert.match(String((recorder.sent[0]?.message as { content?: unknown })?.content ?? ""), /Subagent failed: worker/);
	});

	it("deduplicates the same owner event without hiding another child's attention", () => {
		const recorder = makeRecorder(), visibleControlNotices = new Set<string>();
		const details = { source: "async" as const, event: needsAttentionEvent(), childIntercomTarget: "worker-0" };
		for (let attempt = 0; attempt < 2; attempt++) handleSubagentControlNotice({ pi: recorder.pi, visibleControlNotices, details });
		assert.equal(recorder.sent.length, 1);
		handleSubagentControlNotice({ pi: recorder.pi, visibleControlNotices, details: { ...details, event: needsAttentionEvent({ index: 1 }), childIntercomTarget: "worker-1" } });
		assert.equal(recorder.sent.length, 2);
		assert.deepEqual(recorder.sent[1]?.options, { triggerTurn: true });
	});
});
