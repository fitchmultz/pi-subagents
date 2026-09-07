import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createEventBus, createTempDir, makeMinimalCtx, removeTempDir } from "../support/helpers.ts";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const importHome = createTempDir("pi-doctor-executor-import-home-");
process.env.HOME = importHome;
process.env.USERPROFILE = importHome;
let createSubagentExecutor: typeof import("../../src/runs/foreground/subagent-executor.ts").createSubagentExecutor;
try {
	({ createSubagentExecutor } = await import("../../src/runs/foreground/subagent-executor.ts"));
} finally {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalUserProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = originalUserProfile;
	removeTempDir(importHome);
}

function makeState(cwd: string) {
	return {
		baseCwd: cwd,
		currentSessionId: null,
		asyncJobs: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

describe("doctor action executor routing", () => {
	let tempDir = "";
	let tempHome = "";

	beforeEach(() => {
		tempDir = createTempDir("pi-doctor-executor-project-");
		tempHome = createTempDir("pi-doctor-executor-home-");
		process.env.HOME = tempHome;
		process.env.USERPROFILE = tempHome;
	});

	afterEach(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
		removeTempDir(tempDir);
		removeTempDir(tempHome);
	});

	it("returns a doctor report for the tool action", async () => {
		const sessionFile = path.join(tempDir, "sessions", "parent.jsonl");
		fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
		fs.writeFileSync(sessionFile, "");
		const executor = createSubagentExecutor({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state: makeState(tempDir),
			config: { defaultSessionDir: path.join(tempDir, "configured-sessions") },
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (value: string) => value,
			discoverAgents: () => ({ agents: [] }),
		});
		const ctx = makeMinimalCtx(tempDir);
		ctx.sessionManager.getSessionFile = () => sessionFile;
		ctx.sessionManager.getSessionId = () => "session-doctor";

		const result = await executor.execute(
			"doctor-id",
			{ action: "doctor" },
			new AbortController().signal,
			undefined,
			ctx,
		);

		assert.equal(result.isError, undefined);
		const text = result.content[0]?.text ?? "";
		assert.match(text, /^Subagents doctor report/);
		assert.match(text, /- configured session dir: .*configured-sessions/);
		assert.match(text, /- connection: unknown/);
		assert.match(text, /- bridge: unavailable/);
		assert.match(text, /- orchestrator target:/);
	});

	for (const connection of ["connected", "disconnected", "connecting", "unknown", "unavailable"] as const) it(`reports ${connection} from the live bridge, not the routing name`, async () => {
		const events = createEventBus();
		let requests = 0;
		if (connection !== "unavailable") events.on("subagent:intercom-health-request", (payload) => {
			requests++;
			const { requestId } = payload as { requestId: string };
			events.emit("subagent:intercom-health-response", { requestId, health: [], connection: { status: connection, ...(connection === "connected" ? { sessionId: "registered-parent" } : {}) } });
		});
		const executor = createSubagentExecutor({
			pi: { events, getSessionName: () => "looks-connected" }, state: makeState(tempDir), config: {}, asyncByDefault: false,
			tempArtifactsDir: tempDir, getSubagentSessionRoot: () => tempDir, expandTilde: (value) => value, discoverAgents: () => ({ agents: [] }),
		});
		const started = performance.now();
		const result = await executor.execute("doctor", { action: "doctor" }, undefined, undefined, makeMinimalCtx(tempDir));
		const text = result.content[0]?.text ?? "";
		assert.equal(result.isError, undefined);
		assert.ok(performance.now() - started < 2_000, "an unavailable bridge must not block diagnostics");
		assert.match(text, new RegExp(`- connection: ${connection === "unavailable" ? "unknown" : connection}`));
		assert.match(text, new RegExp(`- bridge: ${connection === "unavailable" ? "unavailable" : "responding"}`));
		assert.equal(requests, connection === "unavailable" ? 0 : 1);
		assert.ok(text.includes(`- Node: ${process.version}`));
		assert.ok(text.includes(`- process: ${process.pid} (${process.execPath})`));
		assert.match(text, /- loaded Pi version: \S+/);
		assert.match(text, /- Pi package directory:/);
		assert.match(text, /- native queue contract: not verified/);
		assert.match(text, /- loaded pi-subagents build: unknown \(unbuilt source\)/);
		assert.doesNotMatch(text, /wiring: active/);
	});

	it("reports session manager failures without failing the doctor action", async () => {
		const executor = createSubagentExecutor({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state: makeState(tempDir),
			config: {},
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (value: string) => value,
			discoverAgents: () => ({ agents: [] }),
		});
		const ctx = makeMinimalCtx(tempDir);
		ctx.sessionManager.getSessionFile = () => {
			throw new Error("session unavailable");
		};
		ctx.sessionManager.getSessionId = () => {
			throw new Error("session unavailable");
		};

		const result = await executor.execute(
			"doctor-id",
			{ action: "doctor" },
			new AbortController().signal,
			undefined,
			ctx,
		);

		assert.equal(result.isError, undefined);
		const text = result.content[0]?.text ?? "";
		assert.match(text, /^Subagents doctor report/);
		assert.match(text, /- session manager: failed — Error: session unavailable/);
		assert.match(text, /- current session file: not available/);
	});
});
