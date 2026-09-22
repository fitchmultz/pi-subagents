import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as path from "node:path";
import { describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createAsyncJobTracker } from "../../src/runs/background/async-job-tracker.ts";
import { restoreOwnedRuns } from "../../src/runs/shared/run-records.ts";
import { getRunMetadataDir, saveQuestionOwner, saveRunStatus } from "../../src/runs/shared/supervisor-questions.ts";
import { resolveAsyncRunLocation } from "../../src/runs/background/async-resume.ts";
import { createNestedRoute, NESTED_EVENTS_DIR, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";
import { ASYNC_DIR, RESULTS_DIR, SLASH_RESULT_TYPE, TEMP_ROOT_DIR } from "../../src/shared/types.ts";
import { buildWidgetLines } from "../../src/tui/render.ts";
import { createTempDir, removeTempDir } from "../support/helpers.ts";

function createState() {
	return {
		baseCwd: "/repo",
		currentSessionId: null,
		asyncJobs: new Map(),
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: {
			schedule: () => false,
			clear: () => {},
		},
	};
}

function createEventRecorder() {
	const events: Array<{ channel: string; data: unknown }> = [];
	return {
		pi: {
			events: {
				emit: (channel: string, data: unknown) => {
					events.push({ channel, data });
				},
			},
		},
		events,
	};
}

function pidGone(): never {
	const error = new Error("missing") as NodeJS.ErrnoException;
	error.code = "ESRCH";
	throw error;
}

function createUiContext() {
	const widgets: unknown[] = [];
	let renderRequests = 0;
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			theme: {
				fg: (_theme: string, text: string) => text,
			},
			getToolsExpanded: () => false,
			setWidget: (_key: string, value: unknown) => {
				widgets.push(value);
			},
			requestRender: () => {
				renderRequests += 1;
			},
		},
	};
	return {
		ctx,
		get widgets() {
			return widgets;
		},
		get renderRequests() {
			return renderRequests;
		},
	};
}

describe("async job tracker", () => {
	it("shares one selected-status decode and avoids established foreign payloads and repairs", (t) => {
		const owner = randomUUID(), other = randomUUID();
		const manager = SessionManager.inMemory("/repo", { id: owner });
		const state = createState(), ui = createUiContext(), recorder = createEventRecorder();
		const ctx = { ...ui.ctx, cwd: "/repo", sessionManager: manager };
		const tracker = createAsyncJobTracker(recorder.pi, state as never, ASYNC_DIR);
		const ids: string[] = [], selected: string[] = [], foreign: string[] = [];
		const seed = (name: string, sessionId: string, sidecar: string | undefined, durable = true, pid = process.pid) => {
			const id = `${owner}-${name}`; ids.push(id);
			const dir = durable ? getRunMetadataDir(id) : path.join(ASYNC_DIR, id);
			fs.mkdirSync(dir, { recursive: true });
			if (sidecar) saveQuestionOwner(id, sidecar);
			fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({
				_discoveryFixture: true, ...(durable ? { runtimeVersion: 2 } : {}), runId: id, sessionId,
				mode: "single", state: "running", pid, startedAt: Date.now(),
				steps: [{ agent: "worker", status: "running", currentToolArgs: "x".repeat(64_000) }],
			}));
			return id;
		};
		try {
			for (let index = 0; index < 55; index++) selected.push(seed(`own-${index}`, "/sessions/old-location.jsonl", owner));
			for (let index = 0; index < 64; index++) foreign.push(seed(`foreign-${index}`, other, other, index % 2 === 0, 2_147_483_647));
			selected.push(seed("missing-owner", owner, undefined, false));
			const malformed = seed("malformed-owner", owner, undefined, false); selected.push(malformed);
			fs.mkdirSync(getRunMetadataDir(malformed), { recursive: true });
			fs.writeFileSync(path.join(getRunMetadataDir(malformed), "question-owner.json"), "{");
			const receiptId = seed("receipt", other, other); selected.push(receiptId);
			manager.appendCustomEntry("subagent-run", { runId: receiptId, rootRunId: receiptId, ownerSessionId: owner, source: "async",
				mode: "single", cwd: "/repo", task: "Receipt overrides sidecar disagreement", startedAt: 1, review: { decision: "accepted" }, children: [] });
			const slashId = seed("slash-receipt", other, other); selected.push(slashId);
			manager.appendCustomMessageEntry(SLASH_RESULT_TYPE, "Saved slash receipt", false, {
				result: { details: { mode: "single", asyncId: slashId, results: [] } },
			});
			const canonical = selected[0]!;
			fs.mkdirSync(path.join(ASYNC_DIR, canonical), { recursive: true });
			fs.writeFileSync(path.join(ASYNC_DIR, canonical, "status.json"), "{", "utf8");
			const legacy = selected.find((id) => id.endsWith("-missing-owner"))!;
			saveRunStatus(legacy, { runId: legacy, sessionId: owner, mode: "single", state: "complete", startedAt: 1 });

			const parse = JSON.parse, decodes = new Map<string, number>();
			t.mock.method(JSON, "parse", (...args) => {
				const value = parse(...args);
				if (value?._discoveryFixture) decodes.set(value.runId, (decodes.get(value.runId) ?? 0) + 1);
				return value;
			});
			const reads = t.mock.method(fs, "readFileSync");
			const writes = t.mock.method(fs, "writeFileSync");
			syncBuiltinESMExports();
			const restoration = restoreOwnedRuns(state as never, ctx as never);
			tracker.restoreJobs(owner, ctx as never, restoration);
			const isForeignPayload = (file: unknown) => foreign.some((id) => String(file).includes(`${id}${path.sep}`)) && !String(file).endsWith("question-owner.json");
			assert.equal(reads.mock.calls.filter((call) => isForeignPayload(call.arguments[0])).length, 0, "established foreign owners must prevent full payload reads");
			assert.equal(writes.mock.calls.filter((call) => isForeignPayload(call.arguments[0])).length, 0, "restoration must not repair foreign execution records");
			assert.deepEqual([...state.ownedRuns.keys()].sort(), selected.sort());
			assert.equal(state.ownedRuns.get(receiptId).review.decision, "accepted");
			assert.equal(state.asyncJobs.size, selected.length, "receipt and UUID-owned live work must be ready together");
			assert.equal(state.ownedRuns.get(canonical).asyncDir, getRunMetadataDir(canonical));
			assert.equal(state.ownedRuns.get(legacy).asyncDir, path.join(ASYNC_DIR, legacy));
			assert.deepEqual([...decodes.values()], selected.map(() => 1), "more selected records than the global cache must still decode only once");
			const priorDecodes = [...decodes];
			assert.deepEqual(restoration.discover(), [], "the grace scan retries publications, not already restored history");
			assert.deepEqual([...decodes], priorDecodes);
			t.diagnostic(`Restored ${selected.length} selected statuses with one decode each; ${foreign.length} established foreign owners had zero payload reads/writes.`);
			t.mock.restoreAll(); syncBuiltinESMExports();
			assert.equal(JSON.parse(fs.readFileSync(path.join(getRunMetadataDir(receiptId), "question-owner.json"), "utf8")).sessionId, other, "receipt recovery must not transfer sidecar identity");
			assert.equal(JSON.parse(fs.readFileSync(path.join(getRunMetadataDir(slashId), "question-owner.json"), "utf8")).sessionId, other, "legacy receipts also leave established sidecar identity intact");
			const foreignId = foreign[0]!;
			assert.equal(resolveAsyncRunLocation({ id: foreignId }, ASYNC_DIR, RESULTS_DIR).resolvedId, foreignId, "explicit inspection remains available");
			assert.throws(() => resolveAsyncRunLocation({ id: `${owner}-foreign-` }, ASYNC_DIR, RESULTS_DIR), /Ambiguous async run id prefix/);
		} finally {
			t.mock.restoreAll(); syncBuiltinESMExports();
			tracker.resetJobs(); if (state.poller) clearInterval(state.poller);
			for (const id of ids) { removeTempDir(getRunMetadataDir(id)); removeTempDir(path.join(ASYNC_DIR, id)); fs.rmSync(path.join(RESULTS_DIR, `${id}.json`), { force: true }); }
		}
	});

	it("keeps the pre-discovery control boundary and retries missing owner/status publications through the final scan", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 10_000 });
		const owner = randomUUID(), ids = ["initial", "late-status", "late-owner"].map((name) => `${owner}-${name}`);
		const manager = SessionManager.inMemory("/repo", { id: owner });
		const state = createState(), ui = createUiContext(), recorder = createEventRecorder();
		const ctx = { ...ui.ctx, cwd: "/repo", sessionManager: manager };
		const tracker = createAsyncJobTracker(recorder.pi, state as never, ASYNC_DIR, { pollIntervalMs: 700 });
		const status = (id: string, sessionId = owner) => ({ runtimeVersion: 2, runId: id, sessionId, mode: "single" as const,
			state: "running" as const, pid: process.pid, startedAt: Date.now(), steps: [{ agent: "worker", status: "running" as const }] });
		const event = (id: string, ts: number, message: string) => `${JSON.stringify({ type: "subagent.control", channels: ["event"],
			event: { type: "needs_attention", to: "needs_attention", runId: id, agent: "worker", ts, message } })}\n`;
		try {
			saveQuestionOwner(ids[0]!, owner); saveRunStatus(ids[0]!, status(ids[0]!));
			saveQuestionOwner(ids[1]!, owner);
			saveRunStatus(ids[2]!, status(ids[2]!, "unresolved-legacy-path"));
			const eventsFile = path.join(getRunMetadataDir(ids[0]!), "events.jsonl");
			fs.writeFileSync(eventsFile, event(ids[0]!, 9_999, "historical"));
			const read = fs.readFileSync;
			let appended = false;
			t.mock.method(fs, "readFileSync", (...args) => {
				if (!appended && String(args[0]) === path.join(getRunMetadataDir(ids[0]!), "status.json")) {
					appended = true;
					fs.appendFileSync(eventsFile, event(ids[0]!, Date.now(), "during discovery"));
				}
				return read(...args);
			});
			syncBuiltinESMExports();
			const restoration = restoreOwnedRuns(state as never, ctx as never);
			assert.equal(appended, true);
			tracker.restoreJobs(owner, ctx as never, restoration);
			t.mock.timers.tick(1_999);
			assert.deepEqual(recorder.events.map(({ data }) => data.event.message), ["during discovery"]);
			const cursor = state.asyncJobs.get(ids[0]).controlEventCursor;
			restoreOwnedRuns(state as never, ctx as never, { strict: true });
			assert.equal(state.asyncJobs.get(ids[0]).controlEventCursor, cursor, "fresh checkpoint evidence must not reset delivery cursors");
			saveRunStatus(ids[1]!, status(ids[1]!));
			saveQuestionOwner(ids[2]!, owner);
			fs.writeFileSync(path.join(getRunMetadataDir(ids[1]!), "events.jsonl"), event(ids[1]!, Date.now(), "before late discovery"));
			t.mock.timers.tick(101);
			assert.deepEqual([...state.asyncJobs.keys()].sort(), [...ids].sort());
			assert.deepEqual([...state.ownedRuns.keys()].sort(), [...ids].sort(), "late job discovery also makes the owned handle available");
			assert.deepEqual(recorder.events.map(({ data }) => data.event.message), ["during discovery", "before late discovery"]);
			t.mock.timers.tick(700);
			assert.equal(recorder.events.length, 2, "attention is delivered once across the final grace scan and polling");
		} finally {
			t.mock.restoreAll(); syncBuiltinESMExports();
			tracker.resetJobs(); if (state.poller) clearInterval(state.poller);
			for (const id of ids) removeTempDir(getRunMetadataDir(id));
		}
	});

	it("removes completed jobs after retention and requests a rerender", async () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		try {
			const state = createState();
			const ui = createUiContext();
			const recorder = createEventRecorder();
			const tracker = createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				completionRetentionMs: 5,
			});
			tracker.resetJobs(ui.ctx as never);
			tracker.handleStarted({ id: "run-1", asyncDir: path.join(asyncRoot, "run-1"), agent: "worker" });
			tracker.handleComplete({ id: "run-1", success: true });

			assert.equal(state.asyncJobs.size, 1);
			await new Promise((resolve) => setTimeout(resolve, 40));

			assert.equal(state.asyncJobs.size, 0);
			assert.ok(ui.renderRequests > 0, "expected widget cleanup to request a rerender");
			assert.equal(ui.widgets.at(-1), undefined);
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("keeps paused completion events paused instead of failed", () => {
		const asyncRoot = createTempDir("pi-async-job-paused-complete-");
		try {
			const state = createState();
			const ui = createUiContext();
			const recorder = createEventRecorder();
			const tracker = createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				completionRetentionMs: 1_000,
			});
			tracker.resetJobs(ui.ctx as never);
			tracker.handleStarted({ id: "run-paused", asyncDir: path.join(asyncRoot, "run-paused"), agent: "worker" });
			tracker.handleComplete({ id: "run-paused", success: false, state: "paused", exitCode: 0 });

			assert.equal(state.asyncJobs.get("run-paused")?.status, "paused");
			assert.ok(ui.renderRequests > 0, "expected paused completion to request a rerender");
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("restores active jobs for the current session after reload or resume", async () => {
		const asyncRoot = createTempDir("pi-async-job-restore-");
		const currentSession = "/sessions/current.jsonl";
		const writeRun = (id: string, sessionId: string, state: "running" | "complete") => {
			const runDir = path.join(asyncRoot, id);
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: id,
				sessionId,
				mode: "chain",
				state,
				pid: 12345,
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now(),
				currentStep: 1,
				currentTool: "read",
				chainStepCount: 2,
				parallelGroups: [{ start: 1, count: 2, stepIndex: 1 }],
				steps: [
					{ agent: "scout", status: "complete" },
					{ agent: "reviewer", status: state === "running" ? "running" : "complete", currentTool: "read", currentToolArgs: "src/index.ts" },
					{ agent: "auditor", status: state === "running" ? "running" : "complete" },
				],
			}), "utf-8");
			return runDir;
		};
		const currentDir = writeRun("run-current", currentSession, "running");
		writeRun("run-other-session", "/sessions/other.jsonl", "running");
		writeRun("run-finished", currentSession, "complete");
		const malformedDir = path.join(asyncRoot, "run-malformed");
		fs.mkdirSync(malformedDir);
		fs.writeFileSync(path.join(malformedDir, "status.json"), "{", "utf-8");
		const invalidDir = path.join(asyncRoot, "run-invalid");
		fs.mkdirSync(invalidDir);
		fs.writeFileSync(path.join(invalidDir, "status.json"), JSON.stringify({
			runId: "run-invalid",
			sessionId: currentSession,
			mode: "single",
			state: "running",
			startedAt: Date.now(),
			steps: [{ agent: "broken", status: "failed", error: { message: "not a string" } }],
		}), "utf-8");
		const unsafeIndexDir = path.join(asyncRoot, "run-unsafe-index");
		fs.mkdirSync(unsafeIndexDir);
		fs.writeFileSync(path.join(unsafeIndexDir, "status.json"), JSON.stringify({
			runId: "run-unsafe-index",
			sessionId: currentSession,
			mode: "chain",
			state: "running",
			startedAt: Date.now(),
			currentStep: 1e12,
			chainStepCount: 1e12,
			steps: [{ agent: "broken", status: "running" }],
		}), "utf-8");
		const historicalControlEvent = `${JSON.stringify({
			type: "subagent.control",
			channels: ["event"],
			event: { type: "needs_attention", to: "needs_attention", ts: Date.now() - 1000, runId: "run-current", agent: "scout", message: "historical" },
		})}\n`;
		fs.writeFileSync(path.join(currentDir, "events.jsonl"), historicalControlEvent, "utf-8");

		const state = createState();
		const ui = createUiContext();
		const recorder = createEventRecorder();
		let eventsStatAttempts = 0;
		const tracker = createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
			pollIntervalMs: 10,
			kill: () => true,
			statSync: (file) => {
				if (String(file).endsWith("events.jsonl") && eventsStatAttempts++ === 0) {
					const error = new Error("temporarily unavailable") as NodeJS.ErrnoException;
					error.code = "EACCES";
					throw error;
				}
				return fs.statSync(file);
			},
		});
		const originalError = console.error;
		console.error = () => {};
		try {
			tracker.restoreJobs(currentSession, ui.ctx as never);

			assert.deepEqual([...state.asyncJobs.keys()], ["run-current"]);
			assert.equal(state.asyncJobs.get("run-current")?.pid, 12345);
			assert.equal(state.asyncJobs.get("run-current")?.currentTool, "read");
			assert.deepEqual(state.asyncJobs.get("run-current")?.agents, ["reviewer", "auditor"]);
			assert.deepEqual(state.asyncJobs.get("run-current")?.steps?.map((step) => step.index), [1, 2]);
			assert.match(buildWidgetLines([...state.asyncJobs.values()], ui.ctx.ui.theme, 80, true).join("\n"), /reviewer/);
			assert.notEqual(ui.widgets.at(-1), undefined);
			assert.notEqual(state.poller, null);
			fs.appendFileSync(path.join(currentDir, "events.jsonl"), `${JSON.stringify({
				type: "subagent.control",
				channels: ["event"],
				event: { type: "needs_attention", to: "needs_attention", ts: Date.now() + 1, runId: "run-current", agent: "scout", message: "new" },
			})}\n`, "utf-8");
			await new Promise((resolve) => setTimeout(resolve, 30));
			assert.equal(recorder.events.length, 1, "restoration should emit only post-boundary control events");
			assert.equal((recorder.events[0]?.data as { event?: { message?: string } }).event?.message, "new");
		} finally {
			console.error = originalError;
			tracker.resetJobs();
			if (state.poller) clearInterval(state.poller);
			removeTempDir(asyncRoot);
		}
	});

	it("skips unrelated nested state during restoration and the first poll while restoring matching jobs", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000 });
		const asyncRoot = createTempDir("pi-async-job-session-filter-");
		const currentSession = "/sessions/current.jsonl";
		const runId = path.basename(asyncRoot);
		const route = createNestedRoute(runId);
		const nestedRoot = path.join(TEMP_ROOT_DIR, "nested-subagent-runs", runId);
		const nestedDir = path.join(nestedRoot, "stale-child");
		const resultsDir = path.join(asyncRoot, "results");
		const writeRun = (id: string, sessionId: string, state: "running" | "queued" | "complete") => {
			const runDir = path.join(asyncRoot, id);
			fs.mkdirSync(runDir);
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: id, sessionId, mode: "single", state, startedAt: Date.now(),
				steps: [{ agent: "worker", status: state === "queued" ? "pending" : state }],
			}));
		};
		const state = createState();
		const ui = createUiContext();
		const recorder = createEventRecorder();
		const tracker = createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
			pollIntervalMs: 1_000, resultsDir, kill: pidGone,
		});
		const readDirectory = t.mock.method(fs, "readdirSync");
		const listingsOf = (dir: string) => readDirectory.mock.calls.filter((call) => String(call.arguments[0]) === dir).length;
		syncBuiltinESMExports();
		try {
			writeRun("foreign-a", "/sessions/other.jsonl", "complete");
			writeRun("foreign-b", "/sessions/other.jsonl", "complete");
			tracker.restoreJobs(currentSession, ui.ctx as never);
			assert.equal(state.asyncJobs.size, 0);
			const foreignNestedListings = [listingsOf(NESTED_EVENTS_DIR)];

			readDirectory.mock.resetCalls();
			t.mock.timers.tick(1_000);
			assert.ok(listingsOf(asyncRoot) > 0, "the first poll must discover persisted runs");
			assert.equal(state.asyncJobs.size, 0);
			foreignNestedListings.push(listingsOf(NESTED_EVENTS_DIR));

			writeRun(runId, currentSession, "running");
			writeRun("run-queued", currentSession, "queued");
			fs.mkdirSync(nestedDir, { recursive: true });
			fs.writeFileSync(path.join(nestedDir, "status.json"), JSON.stringify({
				runId: "stale-child", mode: "single", state: "running", pid: 12345, startedAt: Date.now(),
				steps: [{ agent: "reviewer", status: "running" }],
			}));
			writeNestedEvent(route, {
				type: "subagent.nested.started", ts: Date.now(), parentRunId: runId, parentStepIndex: 0,
				child: {
					id: "stale-child", parentRunId: runId, parentStepIndex: 0, depth: 1,
					path: [{ runId, stepIndex: 0 }], state: "running", asyncDir: nestedDir, agent: "reviewer",
				},
			});
			t.mock.timers.tick(1_000);
			assert.deepEqual([...state.asyncJobs.keys()].sort(), [runId, "run-queued"].sort());
			assert.equal(state.asyncJobs.get(runId)?.status, "running");
			assert.equal(state.asyncJobs.get("run-queued")?.status, "queued");
			assert.equal(state.asyncJobs.get(runId)?.steps?.[0]?.children?.[0]?.state, "failed");
			assert.equal(fs.existsSync(path.join(resultsDir, "nested", runId, "stale-child.json")), true);
			t.diagnostic(`Foreign nested listings at restore/first poll: ${foreignNestedListings.join("/")}; matching running/queued jobs restored with stale child repaired.`);
			assert.deepEqual(foreignNestedListings, [0, 0], "foreign sessions must not trigger nested discovery at startup or on the first poll");
		} finally {
			t.mock.restoreAll();
			syncBuiltinESMExports();
			tracker.resetJobs();
			if (state.poller) clearInterval(state.poller);
			removeTempDir(asyncRoot);
			removeTempDir(path.dirname(route.eventSink));
			removeTempDir(nestedRoot);
		}
	});

	it("rejects malformed status updates before they reach restored widget state", async () => {
		const asyncRoot = createTempDir("pi-async-job-restore-invalid-update-");
		const runDir = path.join(asyncRoot, "run-current");
		const statusPath = path.join(runDir, "status.json");
		fs.mkdirSync(runDir);
		const status = {
			runId: "run-current",
			sessionId: "/sessions/current.jsonl",
			mode: "single",
			state: "running",
			startedAt: Date.now(),
			steps: [{ agent: "worker", status: "running" }],
		};
		fs.writeFileSync(statusPath, JSON.stringify(status), "utf-8");
		const state = createState();
		const ui = createUiContext();
		const recorder = createEventRecorder();
		const tracker = createAsyncJobTracker(recorder.pi, state as never, asyncRoot, { pollIntervalMs: 10 });
		const originalError = console.error;
		console.error = () => {};
		try {
			tracker.restoreJobs(status.sessionId, ui.ctx as never);
			fs.writeFileSync(statusPath, JSON.stringify({
				...status,
				steps: [{ agent: "worker", status: "failed", error: { message: "not a string" } }],
			}), "utf-8");
			await new Promise((resolve) => setTimeout(resolve, 30));
			const job = state.asyncJobs.get("run-current");
			assert.equal(job?.status, "failed");
			assert.equal(job?.steps?.[0]?.error, undefined);
		} finally {
			console.error = originalError;
			tracker.resetJobs();
			if (state.poller) clearInterval(state.poller);
			removeTempDir(asyncRoot);
		}
	});

	it("discovers a runner whose initial status appears after restoration", async () => {
		const asyncRoot = createTempDir("pi-async-job-restore-delayed-");
		const runDir = path.join(asyncRoot, "run-delayed");
		fs.mkdirSync(runDir);
		const state = createState();
		const ui = createUiContext();
		const recorder = createEventRecorder();
		const tracker = createAsyncJobTracker(recorder.pi, state as never, asyncRoot, { pollIntervalMs: 10 });
		try {
			tracker.restoreJobs("/sessions/current.jsonl", ui.ctx as never);
			assert.equal(state.asyncJobs.size, 0);
			assert.notEqual(state.poller, null);

			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-delayed",
				sessionId: "/sessions/current.jsonl",
				mode: "single",
				state: "running",
				startedAt: Date.now(),
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "running" }],
			}), "utf-8");

			const deadline = Date.now() + 200;
			while (!state.asyncJobs.has("run-delayed") && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			assert.equal(state.asyncJobs.has("run-delayed"), true);
			assert.notEqual(ui.widgets.at(-1), undefined);
		} finally {
			tracker.resetJobs();
			if (state.poller) clearInterval(state.poller);
			removeTempDir(asyncRoot);
		}
	});

	it("does not adopt an unidentified status and retries it after its session identity is published", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000 });
		const asyncRoot = createTempDir("pi-async-job-unidentified-");
		const runDir = path.join(asyncRoot, randomUUID());
		fs.mkdirSync(runDir);
		const status = { runId: path.basename(runDir), mode: "single", state: "running", startedAt: Date.now(), steps: [] };
		fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify(status));
		const state = createState(), ui = createUiContext(), recorder = createEventRecorder();
		const tracker = createAsyncJobTracker(recorder.pi, state as never, asyncRoot, { pollIntervalMs: 700 });
		try {
			tracker.restoreJobs("/sessions/current.jsonl", ui.ctx as never);
			assert.equal(state.asyncJobs.size, 0, "missing identity is not a matching undefined UUID alias");
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({ ...status, sessionId: "/sessions/current.jsonl" }));
			t.mock.timers.tick(700);
			assert.equal(state.asyncJobs.has(status.runId), true);
		} finally {
			tracker.resetJobs(); if (state.poller) clearInterval(state.poller);
			removeTempDir(asyncRoot);
		}
	});

	it("stops restore discovery after its grace period", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"] });
		const asyncRoot = createTempDir("pi-async-job-restore-grace-");
		const state = createState();
		const ui = createUiContext();
		const recorder = createEventRecorder();
		const tracker = createAsyncJobTracker(recorder.pi, state as never, asyncRoot, { pollIntervalMs: 250 });
		try {
			tracker.restoreJobs("/sessions/current.jsonl", ui.ctx as never);
			t.mock.timers.tick(2_000);
			assert.equal(state.poller, null);
		} finally {
			tracker.resetJobs();
			if (state.poller) clearInterval(state.poller);
			removeTempDir(asyncRoot);
		}
	});

	it("performs a final discovery when the first post-deadline poll runs late", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"] });
		const asyncRoot = createTempDir("pi-async-job-restore-final-scan-");
		const runDir = path.join(asyncRoot, "run-late-tick");
		fs.mkdirSync(runDir);
		const state = createState();
		const ui = createUiContext();
		const recorder = createEventRecorder();
		const tracker = createAsyncJobTracker(recorder.pi, state as never, asyncRoot, { pollIntervalMs: 700 });
		try {
			tracker.restoreJobs("/sessions/current.jsonl", ui.ctx as never);
			t.mock.timers.tick(1_999);
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-late-tick",
				sessionId: "/sessions/current.jsonl",
				mode: "single",
				state: "running",
				startedAt: Date.now(),
				steps: [{ agent: "worker", status: "running" }],
			}), "utf-8");
			t.mock.timers.tick(101);
			assert.equal(state.asyncJobs.has("run-late-tick"), true);
		} finally {
			tracker.resetJobs();
			if (state.poller) clearInterval(state.poller);
			removeTempDir(asyncRoot);
		}
	});

	it("uses flattened async-start agents for initial parallel group widget state", () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		try {
			const state = createState();
			const recorder = createEventRecorder();
			const tracker = createAsyncJobTracker(recorder.pi, state as never, asyncRoot);

			tracker.handleStarted({
				id: "run-parallel-start",
				asyncDir: path.join(asyncRoot, "run-parallel-start"),
				agent: "scout",
				agents: ["scout", "reviewer", "worker", "writer"],
				chain: ["[scout+reviewer+worker]", "writer"],
				chainStepCount: 2,
				parallelGroups: [{ start: 0, count: 3, stepIndex: 0 }],
			});

			const job = state.asyncJobs.get("run-parallel-start");
			assert.deepEqual(job?.agents, ["scout", "reviewer", "worker"]);
			assert.equal(job?.chainStepCount, 2);
			assert.deepEqual(job?.parallelGroups, [{ start: 0, count: 3, stepIndex: 0 }]);
			assert.equal(job?.stepsTotal, 3);
			assert.equal(job?.activeParallelGroup, true);
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("adds flat step indexes to polled active parallel group steps", async () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		try {
			const runDir = path.join(asyncRoot, "run-chain");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-chain",
				mode: "chain",
				state: "running",
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now(),
				currentStep: 1,
				chainStepCount: 3,
				parallelGroups: [{ start: 1, count: 2, stepIndex: 1 }],
				steps: [
					{ agent: "scout", status: "complete" },
					{
						agent: "reviewer",
						status: "running",
						currentTool: "read",
						currentToolArgs: "src/tui/render.ts",
						recentTools: [{ tool: "grep", args: "async widget", endMs: Date.now() - 100 }],
						recentOutput: ["reviewer line"],
					},
					{ agent: "auditor", status: "running" },
					{ agent: "writer", status: "pending" },
				],
			}), "utf-8");

			const state = createState();
			const ui = createUiContext();
			const recorder = createEventRecorder();
			const tracker = createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				pollIntervalMs: 10,
			});
			tracker.resetJobs(ui.ctx as never);
			tracker.handleStarted({ id: "run-chain", asyncDir: runDir, mode: "chain", agents: ["scout", "reviewer", "auditor", "writer"] });

			await new Promise((resolve) => setTimeout(resolve, 50));

			const job = state.asyncJobs.get("run-chain");
			assert.deepEqual(job?.steps?.map((step: { index?: number }) => step.index), [1, 2]);
			assert.deepEqual(job?.agents, ["reviewer", "auditor"]);
			assert.equal(job?.steps?.[0]?.currentTool, "read");
			assert.equal(job?.steps?.[0]?.currentToolArgs, "src/tui/render.ts");
			assert.deepEqual(job?.steps?.[0]?.recentTools?.map((tool: { tool: string; args: string }) => ({ tool: tool.tool, args: tool.args })), [{ tool: "grep", args: "async widget" }]);
			assert.deepEqual(job?.steps?.[0]?.recentOutput, ["reviewer line"]);
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("rerenders changed polled status but not unchanged bookkeeping", async () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		try {
			const runDir = path.join(asyncRoot, "run-unchanged");
			fs.mkdirSync(runDir, { recursive: true });
			const writeStatus = (lastUpdate: number, toolCount?: number) => fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-unchanged",
				mode: "single",
				state: "running",
				startedAt: 1000,
				lastUpdate,
				...(toolCount !== undefined ? { toolCount } : {}),
				steps: [{ agent: "worker", status: "running", startedAt: 1000 }],
			}), "utf-8");
			writeStatus(2000);

			const state = createState();
			const ui = createUiContext();
			const recorder = createEventRecorder();
			const tracker = createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				pollIntervalMs: 10,
			});
			tracker.resetJobs(ui.ctx as never);
			tracker.handleStarted({ id: "run-unchanged", asyncDir: runDir, agent: "worker" });

			const requestsAfterStart = ui.renderRequests;
			await new Promise((resolve) => setTimeout(resolve, 35));
			assert.ok(ui.renderRequests > requestsAfterStart, "first status load should redraw the widget");

			const requestsAfterStatusLoaded = ui.renderRequests;
			fs.writeFileSync(path.join(runDir, "events.jsonl"), `${JSON.stringify({
				type: "subagent.control",
				channels: ["event"],
				event: {
					type: "needs_attention",
					to: "needs_attention",
					ts: 123,
					runId: "run-unchanged",
					agent: "worker",
					message: "worker needs attention",
				},
			})}\n`, "utf-8");
			await new Promise((resolve) => setTimeout(resolve, 40));
			assert.equal(recorder.events.some((event) => event.channel === "subagent:control-event"), true);
			assert.equal(ui.renderRequests, requestsAfterStatusLoaded, "unchanged status and control cursors should not request widget redraws");

			writeStatus(3000, 1);
			await new Promise((resolve) => setTimeout(resolve, 40));
			assert.ok(ui.renderRequests > requestsAfterStatusLoaded, "changed non-terminal status should redraw the widget");
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("schedules cleanup when polling observes a completed status without a completion event", async () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		try {
			const runDir = path.join(asyncRoot, "run-2");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-2",
				mode: "single",
				state: "complete",
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "complete" }],
			}), "utf-8");

			const state = createState();
			const ui = createUiContext();
			const recorder = createEventRecorder();
			const tracker = createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				completionRetentionMs: 5,
				pollIntervalMs: 10,
			});
			tracker.resetJobs(ui.ctx as never);
			tracker.handleStarted({ id: "run-2", asyncDir: runDir, agent: "worker" });

			await new Promise((resolve) => setTimeout(resolve, 80));

			assert.equal(state.asyncJobs.size, 0);
			assert.ok(ui.renderRequests > 0, "expected polling cleanup to request a rerender");
			assert.equal(ui.widgets.at(-1), undefined);
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("repairs stale running jobs during polling", async () => {
		const asyncRoot = createTempDir("pi-async-job-stale-");
		try {
			const resultsDir = path.join(asyncRoot, "results");
			const runDir = path.join(asyncRoot, "run-stale");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-stale",
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now() - 1000,
				steps: [{ agent: "worker", status: "running", startedAt: Date.now() - 1000 }],
			}), "utf-8");

			const state = createState();
			const ui = createUiContext();
			const recorder = createEventRecorder();
			const tracker = createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				completionRetentionMs: 5,
				pollIntervalMs: 10,
				resultsDir,
				kill: pidGone,
				now: () => Date.now(),
			});
			tracker.resetJobs(ui.ctx as never);
			tracker.handleStarted({ id: "run-stale", asyncDir: runDir, agent: "worker" });

			await new Promise((resolve) => setTimeout(resolve, 80));

			assert.equal(state.asyncJobs.size, 0);
			assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, "status.json"), "utf-8")).state, "failed");
			assert.equal(JSON.parse(fs.readFileSync(path.join(resultsDir, "run-stale.json"), "utf-8")).success, false);
			assert.ok(ui.renderRequests > 0, "expected stale repair cleanup to request a rerender");
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("repairs started jobs whose runner dies before writing status", async () => {
		const asyncRoot = createTempDir("pi-async-job-no-status-");
		try {
			const resultsDir = path.join(asyncRoot, "results");
			const runDir = path.join(asyncRoot, "run-no-status");
			const state = createState();
			const ui = createUiContext();
			const recorder = createEventRecorder();
			const tracker = createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				completionRetentionMs: 5,
				pollIntervalMs: 10,
				resultsDir,
				kill: pidGone,
				now: () => Date.now() + 2000,
			});
			tracker.resetJobs(ui.ctx as never);
			tracker.handleStarted({
				id: "run-no-status",
				asyncDir: runDir,
				pid: 12345,
				sessionId: "session-current",
				mode: "parallel",
				agents: ["scout", "reviewer", "worker"],
				chainStepCount: 1,
				parallelGroups: [{ start: 0, count: 3, stepIndex: 0 }],
			});

			await new Promise((resolve) => setTimeout(resolve, 80));

			assert.equal(state.asyncJobs.size, 0);
			const status = JSON.parse(fs.readFileSync(path.join(runDir, "status.json"), "utf-8"));
			const result = JSON.parse(fs.readFileSync(path.join(resultsDir, "run-no-status.json"), "utf-8"));
			assert.equal(status.state, "failed");
			assert.equal(status.sessionId, "session-current");
			assert.equal(status.mode, "parallel");
			assert.equal(status.currentStep, 0);
			assert.equal(status.chainStepCount, 1);
			assert.deepEqual(status.parallelGroups, [{ start: 0, count: 3, stepIndex: 0 }]);
			assert.deepEqual(status.steps.map((step: { agent: string; status: string }) => [step.agent, step.status]), [
				["scout", "failed"],
				["reviewer", "failed"],
				["worker", "failed"],
			]);
			assert.equal(result.success, false);
			assert.equal(result.sessionId, "session-current");
			assert.ok(ui.renderRequests > 0, "expected startup-crash repair cleanup to request a rerender");
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("cleans up jobs when status polling hits a terminal read error", async () => {
		const asyncRoot = createTempDir("pi-async-job-bad-status-");
		try {
			const runDir = path.join(asyncRoot, "run-bad-status");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), "{", "utf-8");
			const state = createState();
			const ui = createUiContext();
			const recorder = createEventRecorder();
			const tracker = createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				completionRetentionMs: 5,
				pollIntervalMs: 10,
			});
			tracker.resetJobs(ui.ctx as never);
			tracker.handleStarted({ id: "run-bad-status", asyncDir: runDir, agent: "worker" });

			await new Promise((resolve) => setTimeout(resolve, 80));

			assert.equal(state.asyncJobs.size, 0);
			assert.ok(ui.renderRequests > 0, "expected malformed status cleanup to request a rerender");
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("does not clean up a status-read failure while nested descendants are live", async () => {
		const asyncRoot = createTempDir("pi-async-job-bad-status-nested-");
		let tracker: ReturnType<typeof createAsyncJobTracker> | undefined;
		const originalError = console.error;
		console.error = () => {};
		try {
			const runDir = path.join(asyncRoot, "run-bad-status-nested");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), "{", "utf-8");
			const state = createState();
			const recorder = createEventRecorder();
			tracker = createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				completionRetentionMs: 5,
				pollIntervalMs: 10,
			});
			tracker.handleStarted({ id: "run-bad-status-nested", asyncDir: runDir, agent: "worker" });
			const job = state.asyncJobs.get("run-bad-status-nested");
			assert.ok(job);
			job.nestedChildren = [{
				id: "nested-live",
				parentRunId: "run-bad-status-nested",
				depth: 1,
				path: [{ runId: "run-bad-status-nested" }],
				state: "running",
				agent: "nested-worker",
			}];

			await new Promise((resolve) => setTimeout(resolve, 80));

			assert.equal(state.asyncJobs.has("run-bad-status-nested"), true);
			assert.equal(state.asyncJobs.get("run-bad-status-nested")?.status, "failed");
			assert.equal(state.cleanupTimers.has("run-bad-status-nested"), false);
		} finally {
			console.error = originalError;
			tracker?.resetJobs();
			removeTempDir(asyncRoot);
		}
	});

	it("keeps root jobs running when nested refresh fails during polling", async () => {
		const asyncRoot = createTempDir("pi-async-job-nested-refresh-um");
		let tracker: ReturnType<typeof createAsyncJobTracker> | undefined;
		const originalError = console.error;
		console.error = () => {};
		try {
			const runDir = path.join(asyncRoot, "run-nested-refresh");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-nested-refresh",
				mode: "single",
				state: "running",
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "running" }],
			}), "utf-8");

			const state = createState();
			const recorder = createEventRecorder();
			tracker = createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				completionRetentionMs: 5,
				pollIntervalMs: 10,
			});
			tracker.handleStarted({
				id: "run-nested-refresh",
				asyncDir: runDir,
				agent: "worker",
				nestedRoute: {
					rootRunId: "run-nested-refresh",
					eventSink: path.join(asyncRoot, "not-contained-events"),
					controlInbox: path.join(asyncRoot, "not-contained-controls"),
					capabilityToken: "bad-token",
				},
			});

			await new Promise((resolve) => setTimeout(resolve, 50));

			assert.equal(state.asyncJobs.get("run-nested-refresh")?.status, "running");
			assert.equal(state.cleanupTimers.has("run-nested-refresh"), false);
		} finally {
			console.error = originalError;
			tracker?.resetJobs();
			removeTempDir(asyncRoot);
		}
	});

	it("cancels cleanup timers when polling observes a non-terminal status", async () => {
		const asyncRoot = createTempDir("pi-async-job-cleanup-cancel-");
		let tracker: ReturnType<typeof createAsyncJobTracker> | undefined;
		try {
			const runDir = path.join(asyncRoot, "run-recovered");
			fs.mkdirSync(runDir, { recursive: true });
			const state = createState();
			const recorder = createEventRecorder();
			tracker = createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				completionRetentionMs: 1_000,
				pollIntervalMs: 10,
			});
			tracker.handleStarted({ id: "run-recovered", asyncDir: runDir, agent: "worker" });
			tracker.handleComplete({ id: "run-recovered", success: true });
			assert.equal(state.cleanupTimers.has("run-recovered"), true);

			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-recovered",
				mode: "single",
				state: "running",
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "running" }],
			}), "utf-8");

			const deadline = Date.now() + 200;
			while (Date.now() < deadline && state.cleanupTimers.has("run-recovered")) {
				await new Promise((resolve) => setTimeout(resolve, 20));
			}

			assert.equal(state.cleanupTimers.has("run-recovered"), false);
			assert.equal(state.asyncJobs.get("run-recovered")?.status, "running");
		} finally {
			tracker?.resetJobs();
			removeTempDir(asyncRoot);
		}
	});

	it("keeps incomplete async control event lines for the next poll", async () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		try {
			const runDir = path.join(asyncRoot, "run-partial");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-partial",
				mode: "single",
				state: "running",
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "running" }],
			}), "utf-8");
			const eventPath = path.join(runDir, "events.jsonl");
			const partialRecord = JSON.stringify({
				type: "subagent.control",
				channels: ["event"],
				event: {
					type: "needs_attention",
					to: "needs_attention",
					ts: 123,
					runId: "run-partial",
					agent: "worker",
					message: "worker needs attention",
				},
			});
			fs.writeFileSync(eventPath, partialRecord, "utf-8");

			const state = createState();
			const recorder = createEventRecorder();
			const tracker = createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				pollIntervalMs: 10,
			});
			tracker.handleStarted({ id: "run-partial", asyncDir: runDir, agent: "worker" });

			await new Promise((resolve) => setTimeout(resolve, 30));
			assert.equal(recorder.events.length, 0);

			fs.appendFileSync(eventPath, "\n", "utf-8");
			await new Promise((resolve) => setTimeout(resolve, 30));
			assert.equal(recorder.events.some((event) => event.channel === "subagent:control-event"), true);
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("clears transient current tool fields when status clears them", async () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		try {
			const runDir = path.join(asyncRoot, "run-clear-tool");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-clear-tool",
				mode: "single",
				state: "running",
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now(),
				currentTool: "edit",
				currentToolStartedAt: Date.now() - 100,
				currentPath: "src/runs/background/subagent-runner.ts",
				steps: [{ agent: "worker", status: "running" }],
			}), "utf-8");

			const state = createState();
			const recorder = createEventRecorder();
			const tracker = createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				pollIntervalMs: 10,
			});
			tracker.handleStarted({ id: "run-clear-tool", asyncDir: runDir, agent: "worker" });

			await new Promise((resolve) => setTimeout(resolve, 30));
			let job = state.asyncJobs.get("run-clear-tool");
			assert.equal(job?.currentTool, "edit");
			assert.equal(job?.currentPath, "src/runs/background/subagent-runner.ts");

			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-clear-tool",
				mode: "single",
				state: "running",
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "running" }],
			}), "utf-8");

			await new Promise((resolve) => setTimeout(resolve, 30));
			job = state.asyncJobs.get("run-clear-tool");
			assert.equal(job?.currentTool, undefined);
			assert.equal(job?.currentToolStartedAt, undefined);
			assert.equal(job?.currentPath, undefined);
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("honors async control notification channels", async () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		try {
			const runDir = path.join(asyncRoot, "run-channels");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-channels",
				mode: "single",
				state: "running",
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "running" }],
			}), "utf-8");
			fs.writeFileSync(path.join(runDir, "events.jsonl"), `${JSON.stringify({
				type: "subagent.control",
				channels: ["intercom"],
				event: {
					type: "needs_attention",
					to: "needs_attention",
					ts: 123,
					runId: "run-channels",
					agent: "worker",
					message: "worker needs attention",
				},
				intercom: { to: "main", message: "SUBAGENT NEEDS ATTENTION: worker in run run-channels." },
			})}\n`, "utf-8");

			const state = createState();
			const recorder = createEventRecorder();
			const tracker = createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				pollIntervalMs: 10,
			});
			tracker.handleStarted({ id: "run-channels", asyncDir: runDir, agent: "worker" });

			await new Promise((resolve) => setTimeout(resolve, 30));
			assert.equal(recorder.events.some((event) => event.channel === "subagent:control-event"), false);
			assert.equal(recorder.events.some((event) => event.channel === "subagent:control-intercom"), true);
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("ignores stale removed async control event types", async () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		try {
			const runDir = path.join(asyncRoot, "run-stale-active");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-stale-active",
				mode: "single",
				state: "running",
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "running" }],
			}), "utf-8");
			fs.writeFileSync(path.join(runDir, "events.jsonl"), `${JSON.stringify({
				type: "subagent.control",
				channels: ["event", "intercom"],
				event: {
					type: "active_long_running",
					to: "active_long_running",
					ts: 123,
					runId: "run-stale-active",
					agent: "worker",
					message: "stale active notice",
				},
				intercom: { to: "main", message: "stale active notice" },
			})}\n`, "utf-8");

			const state = createState();
			const recorder = createEventRecorder();
			const tracker = createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				pollIntervalMs: 10,
			});
			tracker.handleStarted({ id: "run-stale-active", asyncDir: runDir, agent: "worker" });

			await new Promise((resolve) => setTimeout(resolve, 30));
			assert.equal(recorder.events.some((event) => event.channel === "subagent:control-event"), false);
			assert.equal(recorder.events.some((event) => event.channel === "subagent:control-intercom"), false);
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("bridges async control events from events.jsonl to the parent event bus", async () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		try {
			const runDir = path.join(asyncRoot, "run-3");
			const noticeText = "Subagent needs attention: worker\nNudge (preferred live coordination): subagent({ action: \"nudge\", id: \"run-3\", index: 0, message: \"What are you blocked on? Reply with the smallest next step, or state the exact decision you need.\" })\nAsk (blocking wait only; parent must remain alive): intercom({ action: \"ask\", to: \"subagent-worker-run-3-1\", delivery: \"steer\", message: \"What are you blocked on? Reply with the smallest next step, or state the exact decision you need.\" })";
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-3",
				mode: "single",
				state: "running",
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "running" }],
			}), "utf-8");
			fs.writeFileSync(path.join(runDir, "events.jsonl"), `${JSON.stringify({
				type: "subagent.control",
				channels: ["event", "intercom"],
				childIntercomTarget: "subagent-worker-run-3-1",
				noticeText,
				event: {
					type: "needs_attention",
					to: "needs_attention",
					ts: 123,
					runId: "run-3",
					agent: "worker",
					message: "worker needs attention",
				},
				intercom: { to: "main", message: noticeText },
			})}\n`, "utf-8");

			const state = createState();
			const recorder = createEventRecorder();
			const tracker = createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				pollIntervalMs: 10,
			});
			tracker.handleStarted({ id: "run-3", asyncDir: runDir, agent: "worker" });

			await new Promise((resolve) => setTimeout(resolve, 40));

			const controlEvent = recorder.events.find((event) => event.channel === "subagent:control-event");
			assert.ok(controlEvent);
			assert.match((controlEvent.data as { noticeText?: string }).noticeText ?? "", /subagent-worker-run-3-1/);
			const intercomEvent = recorder.events.find((event) => event.channel === "subagent:control-intercom");
			assert.ok(intercomEvent);
			assert.match((intercomEvent.data as { message?: string }).message ?? "", /intercom\({ action: "ask", to: "subagent-worker-run-3-1", delivery: "steer"/);
		} finally {
			removeTempDir(asyncRoot);
		}
	});
});
