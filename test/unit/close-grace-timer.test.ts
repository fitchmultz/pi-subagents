import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it, type TestContext } from "node:test";
import { attachPostExitStdioGuard, trySignalChild } from "../../src/shared/post-exit-stdio-guard.ts";

type GuardChild = Parameters<typeof attachPostExitStdioGuard>[0];

function makeChild(): GuardChild & EventEmitter {
	return Object.assign(new EventEmitter(), {
		stdout: new PassThrough(),
		stderr: new PassThrough(),
	}) as GuardChild & EventEmitter;
}

function enableTimers(t: TestContext): void {
	t.mock.timers.enable({ apis: ["setTimeout"] });
}

describe("attachPostExitStdioGuard", () => {
	it("reports whether a termination signal was actually delivered", () => {
		assert.equal(trySignalChild({ kill: () => true }, "SIGTERM"), true);
		assert.equal(trySignalChild({ kill: () => false }, "SIGTERM"), false);
		assert.equal(trySignalChild({ kill: () => { throw new Error("gone"); } }, "SIGTERM"), false);
	});

	it("cancels cleanup after a clean close", (t) => {
		enableTimers(t);
		const child = makeChild();
		attachPostExitStdioGuard(child, { idleMs: 50, hardMs: 100 });

		child.emit("exit", 0, null);
		child.emit("close", 0, null);
		t.mock.timers.tick(100);

		assert.equal(child.stdout?.destroyed, false);
		assert.equal(child.stderr?.destroyed, false);
	});

	it("destroys silent stdio at the idle deadline", (t) => {
		enableTimers(t);
		const child = makeChild();
		attachPostExitStdioGuard(child, { idleMs: 50, hardMs: 500 });

		child.emit("exit", 0, null);
		t.mock.timers.tick(49);
		assert.equal(child.stdout?.destroyed, false);
		assert.equal(child.stderr?.destroyed, false);

		t.mock.timers.tick(1);
		assert.equal(child.stdout?.destroyed, true);
		assert.equal(child.stderr?.destroyed, true);
	});

	it("destroys chatty stdio at the hard deadline", (t) => {
		enableTimers(t);
		const child = makeChild();
		attachPostExitStdioGuard(child, { idleMs: 50, hardMs: 100 });

		child.emit("exit", 0, null);
		t.mock.timers.tick(40);
		child.stdout?.emit("data", Buffer.from("tick"));
		t.mock.timers.tick(40);
		child.stdout?.emit("data", Buffer.from("tick"));
		t.mock.timers.tick(19);
		assert.equal(child.stdout?.destroyed, false);
		assert.equal(child.stderr?.destroyed, false);

		t.mock.timers.tick(1);
		assert.equal(child.stdout?.destroyed, true);
		assert.equal(child.stderr?.destroyed, true);
	});
});
