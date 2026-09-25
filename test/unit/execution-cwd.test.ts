import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveExecutionCwd } from "../../src/shared/execution-cwd.ts";
import { createEventBus, makeMinimalCtx } from "../support/helpers.ts";

test("delegation captures the active owner directory by manager identity", () => {
	const events = createEventBus(), ctx = makeMinimalCtx("/native");
	let reads = 0;
	events.on("pi-change-working-dir:resolve-execution-cwd", (request) => {
		assert.equal(request.sessionManager, ctx.sessionManager);
		reads++;
		request.result = { cwd: "/selected" };
	});
	assert.equal(resolveExecutionCwd({ events }, ctx), "/selected");
	assert.equal(reads, 1);
});

test("directory errors propagate and an absent owner uses native cwd", () => {
	const events = createEventBus(), ctx = makeMinimalCtx("/native");
	assert.equal(resolveExecutionCwd({ events }, ctx), "/native");
	events.on("pi-change-working-dir:resolve-execution-cwd", (request) => { request.result = { cwd: "/gone", error: "Selected directory unavailable" }; });
	assert.throws(() => resolveExecutionCwd({ events }, ctx), /Selected directory unavailable/);
});

test("an incompatible owner cannot silently launch at the native directory", () => {
	const pi = { events: createEventBus(), getAllTools: () => [], getCommands: () => [{ name: "cwd", source: "extension", sourceInfo: { source: "extension", path: "/fixtures/pi-change-working-dir/index.ts" } }] };
	assert.throws(() => resolveExecutionCwd(pi, makeMinimalCtx("/native")), /did not resolve/);
});
