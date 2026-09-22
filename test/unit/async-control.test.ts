import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { readAsyncControlRequests, writeAsyncControlRequest } from "../../src/runs/background/async-control.ts";

test("commands issued before a durable owner's first status cannot overwrite each other", (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-control-startup-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	fs.writeFileSync(path.join(dir, "launch.json"), JSON.stringify({ runtimeVersion: 2 }));
	writeAsyncControlRequest(dir, "run", "extend", undefined, 500);
	writeAsyncControlRequest(dir, "run", "extend", undefined, 800);
	assert.equal(fs.existsSync(path.join(dir, "control-request.json")), false);
	assert.deepEqual(readAsyncControlRequests(dir, "run").map((request) => request.extendMs).sort(), [500, 800]);
});

test("durable controls retain each request and validate deadline extensions", (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-control-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ controlRequestFiles: true }));
	writeAsyncControlRequest(dir, "run", "interrupt", 1);
	writeAsyncControlRequest(dir, "run", "extend", undefined, 500);
	writeAsyncControlRequest(dir, "run", "extend", undefined, 800);
	assert.throws(() => writeAsyncControlRequest(dir, "run", "extend", undefined, -1), /positive integer/);
	fs.writeFileSync(path.join(dir, "control-requests", "invalid.json"), JSON.stringify({ requestId: "bad", runId: "run", action: "extend", extendMs: "500" }));
	const requests = readAsyncControlRequests(dir, "run");
	assert.deepEqual(requests.filter((request) => request.action === "extend").map((request) => request.extendMs).sort(), [500, 800]);
	assert.equal(requests.find((request) => request.action === "interrupt")?.index, 1);
	assert.equal(new Set(requests.map((request) => request.requestId)).size, 3);
	assert.deepEqual(readAsyncControlRequests(dir, "run"), [], "consumed commands must never execute again");
});
