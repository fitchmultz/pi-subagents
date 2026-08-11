import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { ASYNC_DIR, TEMP_ROOT_DIR } from "../../src/shared/types.ts";
import { cleanupOldRunStorage } from "../../src/shared/temp-root.ts";

const NESTED_EVENTS_DIR = path.join(TEMP_ROOT_DIR, "nested-subagent-events");
const OLD = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);

function makeRoute(rootRunId: string, old: boolean): string {
	const routeRoot = path.join(NESTED_EVENTS_DIR, `${rootRunId}-token`);
	fs.mkdirSync(routeRoot, { recursive: true });
	fs.writeFileSync(path.join(routeRoot, "route.json"), `${JSON.stringify({ rootRunId, capabilityToken: "token" })}\n`);
	if (old) fs.utimesSync(routeRoot, OLD, OLD);
	return routeRoot;
}

function makeRun(id: string, state: string, old: boolean): void {
	const dir = path.join(ASYNC_DIR, id);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ state }));
	if (old) fs.utimesSync(dir, OLD, OLD);
}

describe("cleanupOldRunStorage nested events", () => {
	it("removes stale routes whose root run is gone", () => {
		const route = makeRoute("test-cleanup-gone", true);
		cleanupOldRunStorage();
		assert.equal(fs.existsSync(route), false);
	});

	it("removes stale routes with malformed route metadata", () => {
		for (const [name, content] of [["junk", "not json"], ["null", "null"]] as const) {
			const routeRoot = path.join(NESTED_EVENTS_DIR, `test-cleanup-${name}-token`);
			fs.mkdirSync(routeRoot, { recursive: true });
			fs.writeFileSync(path.join(routeRoot, "route.json"), content);
			fs.utimesSync(routeRoot, OLD, OLD);
			cleanupOldRunStorage();
			assert.equal(fs.existsSync(routeRoot), false);
		}
	});

	it("keeps stale routes while the root run is active", () => {
		makeRun("test-cleanup-live", "running", true);
		const route = makeRoute("test-cleanup-live", true);
		cleanupOldRunStorage();
		assert.equal(fs.existsSync(route), true);
	});

	it("keeps fresh routes even when the root run is gone", () => {
		const route = makeRoute("test-cleanup-fresh", false);
		cleanupOldRunStorage();
		assert.equal(fs.existsSync(route), true);
	});

	it("keeps stale routes while writes still land inside them", () => {
		makeRun("test-cleanup-terminal", "complete", false);
		const route = makeRoute("test-cleanup-terminal", true);
		// Nested descendants can outlive a terminal root, and foreground roots have no
		// async status at all: recent event writes are the only liveness signal.
		fs.mkdirSync(path.join(route, "events"), { recursive: true });
		cleanupOldRunStorage();
		assert.equal(fs.existsSync(route), true);
	});

	it("removes stale runs whose status is not a JSON object", () => {
		const dir = path.join(ASYNC_DIR, "test-cleanup-nullstatus");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "status.json"), "null");
		fs.utimesSync(dir, OLD, OLD);
		cleanupOldRunStorage();
		assert.equal(fs.existsSync(dir), false);
	});

	it("fails closed when route metadata cannot be read", { skip: process.platform === "win32" }, () => {
		const route = makeRoute("test-cleanup-eacces", true);
		const routeFile = path.join(route, "route.json");
		fs.chmodSync(routeFile, 0o000);
		try {
			cleanupOldRunStorage();
			assert.equal(fs.existsSync(route), true);
		} finally {
			fs.chmodSync(routeFile, 0o600);
		}
	});
});
