import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatDetachedIntercomGuidance } from "../../src/runs/shared/intercom-detach.ts";
import type { SingleResult } from "../../src/shared/types.ts";

describe("detached intercom guidance", () => {
	it("includes the child question and exact coordinator reply command", () => {
		const result = {
			agent: "delegate",
			messages: [{
				role: "assistant",
				content: [{
					type: "toolCall",
					name: "contact_supervisor",
					arguments: { reason: "need_decision", message: "Should I use the stable API?" },
				}],
			}],
		} as Pick<SingleResult, "agent" | "messages" | "toolCalls">;

		const text = formatDetachedIntercomGuidance({
			headline: "Detached for intercom coordination: delegate.",
			runId: "78f659a3",
			result,
			childIndex: 0,
		});

		assert.match(text, /Child is waiting on a parent\/coordinator reply/);
		assert.match(text, /Request: contact_supervisor need_decision/);
		assert.match(text, /Question: Should I use the stable API\?/);
		assert.match(text, /intercom\(\{ action: "pending" \}\)/);
		assert.match(text, /intercom\(\{ action: "reply", to: "subagent-delegate-78f659a3-1", message: "<answer>" \}\)/);
		assert.match(text, /subagent\(\{ action: "status", id: "78f659a3" \}\)/);
	});
});
