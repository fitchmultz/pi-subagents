import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeEverydayParams } from "../../src/extension/tool-input.ts";

test("verification environment pairs preserve values and reject duplicate names", () => {
	const params = { agent: "worker", task: "Check", acceptance: { verify: [{ id: "check", command: "check", env: [{ name: "EMPTY", value: "" }, { name: "VALUE", value: "a=b" }] }] } };
	assert.deepEqual(normalizeEverydayParams(params).acceptance, { verify: [{ id: "check", command: "check", env: { EMPTY: "", VALUE: "a=b" } }] });
	assert.throws(() => normalizeEverydayParams({ ...params, acceptance: { verify: [{ env: [{ name: "X", value: "1" }, { name: "X", value: "2" }] }] } }), /duplicate/);
	assert.ok(Array.isArray(params.acceptance.verify[0]!.env), "normalization must not mutate the admitted input");
});

test("closed control sampling retains action-specific validation before execution", () => {
	assert.throws(() => normalizeEverydayParams({ action: "review", id: "run" }, true), /Invalid agent_runs/);
	assert.throws(() => normalizeEverydayParams({ action: "review", decision: "accepted" }, true), /Invalid agent_runs/);
	assert.throws(() => normalizeEverydayParams({ action: "answer", id: "run", message: "Proceed" }, true), /Invalid agent_runs/);
	assert.throws(() => normalizeEverydayParams({ action: "inspect", id: "run", acceptance: { evidence: ["manual-notes"] } }, true), /Invalid agent_runs/);
	assert.throws(() => normalizeEverydayParams({ action: "stop", id: "run", full: true }, true), /Invalid agent_runs/);
	assert.deepEqual(normalizeEverydayParams({ action: "continue", id: "run", message: "Proceed", async: false }, true), { action: "continue", id: "run", message: "Proceed", async: false });
});
