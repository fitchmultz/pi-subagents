import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyForceTopLevelAsyncOverride } from "../../src/runs/background/top-level-async.ts";

describe("force top-level async helper", () => {
	it("forces top-level calls async and disables clarify", () => {
		const params = { async: false, clarify: true, agent: "worker" };
		const next = applyForceTopLevelAsyncOverride(params, 0, true);
		assert.notEqual(next, params);
		assert.equal(next.async, true);
		assert.equal(next.clarify, false);
		assert.equal(next.agent, "worker");
	});

	it("leaves nested calls unchanged", () => {
		const params = { async: false, clarify: true };
		const next = applyForceTopLevelAsyncOverride(params, 1, true);
		assert.equal(next, params);
	});

	it("leaves top-level calls unchanged when the feature is off", () => {
		const params = { async: false, clarify: true };
		const next = applyForceTopLevelAsyncOverride(params, 0, false);
		assert.equal(next, params);
	});
});
