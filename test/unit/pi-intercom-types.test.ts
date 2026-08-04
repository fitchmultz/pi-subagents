import test from "node:test";
import assert from "node:assert/strict";
import { isSessionRegistration, normalizeSessionInfo } from "../../src/pi-intercom/types.ts";

test("session registration validates the reduced protocol shape", () => {
  assert.equal(isSessionRegistration({ cwd: "/repo", model: "model", projectId: "a".repeat(64), lastSeen: 1, lastIntercomActivity: 2, pendingAsks: 0, acceptsAsks: true }), true);
  assert.equal(isSessionRegistration({ cwd: "/repo", model: 1 }), false);
  assert.equal(isSessionRegistration({ cwd: "/repo", model: "model", projectId: "not-a-project-id" }), false);
  assert.equal(isSessionRegistration({ cwd: "/repo", model: "model", pendingAsks: "0" }), false);
});

test("session info drops malformed project ids from older brokers", () => {
  const normalized = normalizeSessionInfo({ id: "session-1", cwd: "/repo", model: "model", projectId: "malformed" });
  assert.deepEqual(normalized, { id: "session-1", cwd: "/repo", model: "model" });
  assert.equal(normalizeSessionInfo({ id: "session-1", cwd: 1, model: "model", projectId: "malformed" }), null);
});
