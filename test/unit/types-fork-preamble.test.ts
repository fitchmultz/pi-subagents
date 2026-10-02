import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { wrapForkTask } from "../../src/shared/types.ts";

describe("wrapForkTask", () => {
	it("wraps task with default preamble", () => {
		const wrapped = wrapForkTask("analyze diff");
		assert.match(wrapped, /fork of the parent session/);
		assert.match(wrapped, /inherited conversation as reference-only context/);
		assert.match(wrapped, /Do not continue or answer prior messages/);
		assert.match(wrapped, /subagent/);
		assert.match(wrapped, /\n\nTask:\nanalyze diff$/);
	});

	it("returns task unchanged when disabled", () => {
		const task = "analyze diff";
		assert.equal(wrapForkTask(task, false), task);
	});

	it("is idempotent for already wrapped tasks", () => {
		const once = wrapForkTask("analyze diff");
		const twice = wrapForkTask(once);
		assert.equal(twice, once);
	});
});
