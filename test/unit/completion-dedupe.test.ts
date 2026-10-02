import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCompletionKey, getGlobalSeenMap, markSeenWithTtl } from "../../src/runs/background/completion-dedupe.ts";

describe("buildCompletionKey", () => {
	it("uses id plus payload digest as canonical key when present", () => {
		const key = buildCompletionKey({ id: "run-123", agent: "reviewer", timestamp: 123 }, "fallback");
		assert.match(key, /^id:run-123:[a-f0-9]{16}$/);
	});

	it("does not collapse corrected payloads with the same id", () => {
		const first = buildCompletionKey({ id: "run-123", success: false, timestamp: 123 }, "fallback");
		const corrected = buildCompletionKey({ id: "run-123", success: true, timestamp: 123 }, "fallback");
		assert.notEqual(first, corrected);
	});

	it("builds deterministic fallback key when id is missing", () => {
		const data = { agent: "reviewer", timestamp: 123, taskIndex: 1, totalTasks: 2, success: true };
		assert.equal(buildCompletionKey(data, "x"), "meta:no-session:reviewer:123:1:2:1:x");
		assert.equal(buildCompletionKey({ ...data, sessionId: "parent" }, "x"), "meta:parent:reviewer:123:1:2:1:x");
		assert.equal(buildCompletionKey({ ...data, taskIndex: 0 }, "x"), "meta:no-session:reviewer:123:0:2:1:x");
		assert.equal(buildCompletionKey(data, "result"), "meta:no-session:reviewer:123:1:2:1:result");
	});
});

describe("markSeenWithTtl", () => {
	it("returns true only for duplicates within ttl", () => {
		const seen = new Map<string, number>();
		const ttlMs = 1000;
		assert.equal(markSeenWithTtl(seen, "k", 100, ttlMs), false);
		assert.equal(markSeenWithTtl(seen, "k", 200, ttlMs), true);
		assert.equal(markSeenWithTtl(seen, "k", 1201, ttlMs), false);
	});
});

describe("getGlobalSeenMap", () => {
	it("returns the same map for the same global store key", () => {
		const storeKey = `__test_seen_${process.pid}__`;
		try {
			const a = getGlobalSeenMap(storeKey);
			a.set("x", 1);
			const b = getGlobalSeenMap(storeKey);
			assert.equal(b.get("x"), 1);
			assert.equal(a, b);
		} finally {
			Reflect.deleteProperty(globalThis, storeKey);
		}
	});
});
