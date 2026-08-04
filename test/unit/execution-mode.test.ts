import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveAsyncExecutionMode } from "../../src/runs/foreground/subagent-executor.ts";

describe("async execution defaults", () => {
	it("preserves explicit modes and foreground-only intent", () => {
		assert.equal(resolveAsyncExecutionMode({}, true).effectiveAsync, true);
		assert.equal(resolveAsyncExecutionMode({}, false).effectiveAsync, false);
		assert.equal(resolveAsyncExecutionMode({ async: false }, true).effectiveAsync, false);
		assert.equal(resolveAsyncExecutionMode({ async: true }, false).effectiveAsync, true);
		assert.equal(resolveAsyncExecutionMode({ timeoutMs: 1 }, true).effectiveAsync, false);
		assert.equal(resolveAsyncExecutionMode({ maxRuntimeMs: 1 }, true).effectiveAsync, false);
		assert.deepEqual(resolveAsyncExecutionMode({ clarify: true }, true), {
			effectiveAsync: false,
			backgroundRequestedWhileClarifying: false,
		});
		assert.equal(resolveAsyncExecutionMode({ async: true, clarify: true }, true).backgroundRequestedWhileClarifying, true);
	});
});
