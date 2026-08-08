import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAttachment, isMessage, isSessionRegistration, normalizeSessionInfo } from "../../src/pi-intercom/types.ts";

const message = { id: "m1", timestamp: 1, content: { text: "hello" } };

describe("pi-intercom wire validation", () => {
	it("accepts the current session registration shape", () => {
		assert.equal(isSessionRegistration({ cwd: "/repo", model: "model", projectId: "a".repeat(64), lastSeen: 1, lastIntercomActivity: 2, pendingAsks: 0, acceptsAsks: true }), true);
		assert.equal(isSessionRegistration({ cwd: "/repo", model: 1 }), false);
		assert.equal(isSessionRegistration({ cwd: "/repo", model: "model", projectId: "not-a-project-id" }), false);
		assert.equal(isSessionRegistration({ cwd: "/repo", model: "model", pendingAsks: "0" }), false);
	});

	it("drops malformed project ids from older broker session info", () => {
		assert.deepEqual(normalizeSessionInfo({ id: "session-1", cwd: "/repo", model: "model", projectId: "malformed" }), { id: "session-1", cwd: "/repo", model: "model" });
		assert.equal(normalizeSessionInfo({ id: "session-1", cwd: 1, model: "model", projectId: "malformed" }), null);
	});

	it("rejects control characters and non-finite numbers", () => {
		assert.equal(isMessage({ ...message, id: "m\n1" }), false);
		assert.equal(isMessage({ ...message, timestamp: Number.NaN }), false);
		assert.equal(isMessage({ ...message, content: { text: "bad\u0000text" } }), false);
		assert.equal(isMessage({ ...message, delivery: "queue", queueMode: "replace", threadId: "bad\nthread" }), false);
		assert.equal(isAttachment({ type: "file", name: "bad\nname", content: "ok" }), false);
	});

	it("rejects invalid session counters and labels", () => {
		assert.equal(isSessionRegistration({ cwd: "/tmp", model: "test", pendingAsks: -1 }), false);
		assert.equal(isSessionRegistration({ cwd: "/tmp", model: "test", lastSeen: Number.POSITIVE_INFINITY }), false);
		assert.equal(isSessionRegistration({ cwd: "/tmp", model: "bad\nmodel" }), false);
	});
});
