import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "../../src/shared/native-session.ts";
import { resolveRootSessionId } from "../../src/shared/session-identity.ts";
import { buildPiArgs } from "../../src/runs/shared/pi-args.ts";

test("root identity is a Pi ID, not cwd, transcript path, or ordinary fork ancestry", () => {
	const one = SessionManager.inMemory("/one", { id: "root-one" });
	const fork = SessionManager.inMemory("/one", { id: "root-fork", parentSession: "/one/root-one.jsonl" });
	assert.equal(resolveRootSessionId(one, {}), "root-one");
	assert.equal(resolveRootSessionId(fork, { PI_SUBAGENT_ROOT_SESSION_ID: "stale" }), "root-fork");
	const env = { PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_ROOT_SESSION_ID: "root-one" };
	assert.equal(resolveRootSessionId(fork, env), "root-one");
	assert.equal(resolveRootSessionId(SessionManager.inMemory("/other", { id: "grandchild" }), env), "root-one");
	one.newSession({ id: "root-new" });
	assert.equal(resolveRootSessionId(one, {}), "root-new");
});

test("independent launches carry root identity without changing parent environment", () => {
	const before = process.env.PI_SUBAGENT_ROOT_SESSION_ID;
	for (const id of ["root-one", "root-two"]) {
		const built = buildPiArgs({ baseArgs: [], task: "check", sessionEnabled: false, inheritProjectContext: false, inheritSkills: false, rootSessionId: id });
		assert.equal(built.env.PI_SUBAGENT_ROOT_SESSION_ID, id);
		assert.equal(built.env.PI_SUBAGENT_CHILD, "1");
	}
	assert.equal(process.env.PI_SUBAGENT_ROOT_SESSION_ID, before);
});
