import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, describe, it } from "node:test";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { createResultWatcher } from "../../src/runs/background/result-watcher.ts";
import { createAsyncJobTracker } from "../../src/runs/background/async-job-tracker.ts";
import { OWNED_RUN_ENTRY, restoreOwnedRuns } from "../../src/runs/shared/run-records.ts";
import { getRunMetadataDir } from "../../src/runs/shared/supervisor-questions.ts";
import { ASYNC_DIR, RESULTS_DIR, INTERCOM_DETACH_REQUEST_EVENT, type SubagentState } from "../../src/shared/types.ts";
import { createEventBus, createMockPi, createTempDir, events, makeAgent, makeMinimalCtx, removeTempDir } from "../support/helpers.ts";

const sdkRoot = process.env.PI_OWNERSHIP_TEST_PACKAGE_ROOT ?? path.dirname(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const { SessionManager } = await import(pathToFileURL(path.join(sdkRoot, "dist/core/session-manager.js")).href);
const failureReason = "MIXED_BAD: required evidence was rejected";
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, `Timed out waiting for ${label}`);
		await delay(20);
	}
}

describe("mixed sibling host outcomes", { timeout: 90_000 }, () => {
	const mock = createMockPi();
	before(() => mock.install());
	after(() => mock.uninstall());

	for (const shape of ["parallel", "static-chain", "dynamic-chain"] as const) {
		for (const host of ["foreground", "background"] as const) {
			for (const stop of host === "background" ? ["interrupt"] as const : ["interrupt", "detach", "detach-queued", "timeout"] as const) {
				for (const failed of stop === "timeout" ? [true] : [true, false]) {
					it(`${host} ${shape}: ${failed ? "failed + successful" : "successful"} + ${stop}`, async () => {
						mock.reset();
						const detaching = stop.startsWith("detach");
						const aggregateFailed = failed || stop === "detach-queued";
						const cwd = createTempDir("mixed-siblings-");
						const parentFile = path.join(cwd, "parent.jsonl");
						fs.writeFileSync(parentFile, `${JSON.stringify({ type: "session", version: 3, id: randomUUID(), cwd, timestamp: new Date().toISOString() })}\n`);
						let parent = SessionManager.open(parentFile);
						const state = {
							baseCwd: cwd, currentSessionId: parentFile, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null,
							ownedRuns: new Map(), completionSeen: new Map(), cleanupTimers: new Map(), persistOwnedRun: (run) => parent.appendCustomEntry(OWNED_RUN_ENTRY, run),
						} as SubagentState;
						const ctx = { ...makeMinimalCtx(cwd), sessionManager: parent };
						const bus = createEventBus();
						const notifications: any[] = [];
						bus.on("subagent:result-intercom", (message: any) => {
							notifications.push(message);
							bus.emit("subagent:result-intercom-delivery", { requestId: message.requestId, delivered: true });
						});
						const pi = { events: bus, getSessionName: () => "mixed-parent" };
						const tracker = createAsyncJobTracker(pi, state, ASYNC_DIR);
						bus.on("subagent:async-started", tracker.handleStarted);
						bus.on("subagent:async-complete", tracker.handleComplete);
						const executor = createSubagentExecutor({
							pi, state, config: {}, asyncByDefault: false, tempArtifactsDir: cwd,
							getSubagentSessionRoot: () => path.join(cwd, "sessions"), expandTilde: (value) => value,
							discoverAgents: () => ({ agents: [makeAgent("worker", { completionGuard: false })] }),
						});
						const invoke = (params, onUpdate?) => executor.execute(randomUUID(), params, new AbortController().signal, onUpdate, ctx);
						const watcher = createResultWatcher(pi, state, RESULTS_DIR, 60_000);
						// One active child makes completion order deterministic; failures cannot stop the wait child.
						const tokens = ["MIXED_OK", ...(failed ? ["MIXED_BAD"] : []), "MIXED_WAIT", ...(stop === "detach" ? [] : ["MIXED_QUEUED"])];
						const prefixCount = shape === "parallel" ? 0 : 1;
						const waitIndex = prefixCount + tokens.indexOf("MIXED_WAIT");
						mock.onCall({ matchArgsIncludes: "MIXED_SOURCE", output: "PREFIX_EVIDENCE", structuredOutput: { items: tokens } });
						mock.onCall({ matchArgsIncludes: "MIXED_OK", output: "SUCCESSFUL_SIBLING_EVIDENCE" });
						mock.onCall({ matchArgsIncludes: "MIXED_BAD", stderr: failureReason, exitCode: 1 });
						mock.onCall({ matchArgsIncludes: "MIXED_WAIT", steps: [
							{ jsonl: [events.toolStart(detaching ? "contact_supervisor" : "bash", detaching ? { reason: "need_decision" } : { command: "controlled wait" })] },
							{ delay: detaching ? 1_000 : 20_000, jsonl: [events.assistantMessage("DETACHED_CHILD_FINISHED")] },
						] });
						const tasks = tokens.map((task) => ({ agent: "worker", task, output: false }));
						const prefix = { agent: "worker", task: "MIXED_SOURCE", as: "targets", output: false, outputSchema: { type: "object" } };
						const downstream = { agent: "worker", task: "MIXED_DOWNSTREAM", output: false };
						const group = shape === "dynamic-chain" ? {
							expand: { from: { output: "targets", path: "/items" }, maxItems: tokens.length },
							parallel: { agent: "worker", task: "{item}", output: false }, collect: { as: "collected" }, concurrency: 1, failFast: false,
						} : { parallel: tasks.map((task, index) => ({ ...task, ...(index === 0 ? { as: "evidence" } : {}) })), concurrency: 1, failFast: false };
						let ready = false, runId: string | undefined;
						let pending: ReturnType<typeof invoke> | undefined;
						try {
							pending = invoke({
								...(shape === "parallel" ? { tasks, concurrency: 1 } : { chain: [prefix, group, downstream] }),
								async: host === "background", context: "fresh", artifacts: false,
								...(stop === "timeout" ? { timeoutMs: 3_000 } : {}),
							}, (update) => {
								if (update.details?.progress?.some((progress) => progress.currentTool === (detaching ? "contact_supervisor" : "bash"))) ready = true;
							});
							await waitFor(() => state.ownedRuns!.size === 1, "owned run registration");
							runId = [...state.ownedRuns!.keys()][0]!;
							const metadata = getRunMetadataDir(runId);
							await waitFor(() => host === "foreground" ? ready : fs.existsSync(path.join(metadata, "status.json")) && readJson(path.join(metadata, "status.json")).steps[waitIndex]?.currentTool === "bash", "wait child after successful/failed siblings");
							if (stop === "interrupt") {
								const interrupted = await invoke({ action: "interrupt", id: runId });
								assert.equal(interrupted.isError, undefined, JSON.stringify(interrupted));
							} else if (detaching) bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: randomUUID() });
							const response = await pending;
							const initial = JSON.parse(JSON.stringify(response));
							let terminal = initial.details;
							if (host === "background") {
								await waitFor(() => fs.existsSync(path.join(metadata, "result.json")), "durable background result");
								terminal = readJson(path.join(metadata, "result.json"));
								watcher.primeExistingResults();
								await waitFor(() => notifications.some((entry) => entry.runId === runId), "grouped background completion");
							}
							const beforeSettlement = await invoke({ action: "status", id: runId });
							if (detaching) await waitFor(() => !state.foregroundControls.has(runId!), "detached child completion");
							parent = SessionManager.open(parentFile);
							ctx.sessionManager = parent;
							state.foregroundRuns = new Map();
							restoreOwnedRuns(state, ctx);
							const inspection = await invoke({ action: "status", id: runId });
							const calls = fs.readdirSync(mock.dir).filter((file) => file.startsWith("call-")).sort().map((file) => readJson(path.join(mock.dir, file)));
							const receipt = { host, shape, stop, failed, aggregateFailed, initial, terminal, beforeSettlement, inspection, notifications, calls };
							if (process.env.PI_MIXED_SIBLING_EVIDENCE_DIR) {
								fs.mkdirSync(process.env.PI_MIXED_SIBLING_EVIDENCE_DIR, { recursive: true });
								fs.writeFileSync(path.join(process.env.PI_MIXED_SIBLING_EVIDENCE_DIR, `${host}-${shape}-${stop}-${failed ? "mixed" : "pure"}.json`), JSON.stringify(receipt, null, 2));
							}
							const results = terminal.results;
							assert.equal(calls.length, waitIndex + 1, "queued/downstream children must never launch");
							assert.deepEqual(calls.map((call) => call.expandedArgs.at(-1).match(/MIXED_(SOURCE|OK|BAD|WAIT|QUEUED|DOWNSTREAM)/)?.[0]), [ ...(prefixCount ? ["MIXED_SOURCE"] : []), ...tokens.slice(0, tokens.indexOf("MIXED_WAIT") + 1) ]);
							assert.equal(results[prefixCount].finalOutput ?? results[prefixCount].output, "SUCCESSFUL_SIBLING_EVIDENCE");
							if (failed) assert.equal(results[prefixCount + 1].error, failureReason);
							if (stop === "interrupt") {
								assert.equal(results[waitIndex].interrupted, true);
								assert.equal(results[waitIndex + 1].interrupted, true, "queued child stays paused");
							} else assert.equal(results[waitIndex][detaching ? "detached" : "timedOut"], true);
							if (stop === "detach-queued") {
								assert.equal(results[waitIndex + 1].exitCode, -1);
								assert.equal(results[waitIndex + 1].error, "Skipped due to detached");
							}
							if (shape === "static-chain") assert.equal(terminal.outputs.evidence.text, "SUCCESSFUL_SIBLING_EVIDENCE");
							if (shape === "dynamic-chain") assert.equal(terminal.outputs.collected, undefined, "stopped collections must not publish");
							const saved = inspection.details.run!;
							assert.equal(saved.state, aggregateFailed ? "failed" : detaching ? "completed" : "paused");
							assert.equal(saved.children[prefixCount].state, "completed");
							assert.equal(saved.children[prefixCount].result?.finalOutput, "SUCCESSFUL_SIBLING_EVIDENCE");
							if (failed) assert.equal(saved.children[prefixCount + 1].state, "failed");
							assert.equal(saved.children[waitIndex].state, stop === "interrupt" ? "paused" : detaching ? "completed" : "failed");
							if (shape !== "parallel") assert.equal(terminal.workflowGraph.nodes[1].status, aggregateFailed ? "failed" : detaching ? "detached" : "paused");
							if (host === "foreground") {
								assert.equal(initial.isError, aggregateFailed ? true : undefined, "aggregate failure must survive a control-state return");
								const text = initial.content.map((part) => part.text).join("\n");
								if (failed) assert.ok(text.includes(failureReason), `Missing failed-child reason: ${text}`);
								if (stop === "detach-queued") assert.match(text, /Skipped due to detached/, "an unstarted task needs its skip reason, not an executed failure");
								assert.match(text, stop === "interrupt" ? /paused after interrupt/i : detaching ? /detached for intercom coordination/i : /timed out/i);
							} else {
								assert.equal(terminal.success, false);
								assert.equal(terminal.state, failed ? "failed" : "paused");
								const notification = notifications.find((entry) => entry.runId === runId);
								assert.equal(notification.status, failed ? "failed" : "paused");
								assert.equal(notification.children[waitIndex].status, "paused");
								assert.match(notification.message, /SUCCESSFUL_SIBLING_EVIDENCE/);
								if (failed) assert.ok(notification.message.includes(failureReason));
							}
						} finally {
							watcher.stopResultWatcher();
							if (runId && (state.foregroundControls.has(runId) || host === "background" && !fs.existsSync(path.join(getRunMetadataDir(runId), "result.json")))) {
								await invoke({ action: "interrupt", id: runId });
								await waitFor(() => host === "foreground" ? !state.foregroundControls.has(runId!) : fs.existsSync(path.join(getRunMetadataDir(runId!), "result.json")), "owned test run cleanup");
							}
							await pending;
							tracker.resetJobs();
							if (runId) {
								removeTempDir(path.join(ASYNC_DIR, runId));
								fs.rmSync(path.join(RESULTS_DIR, `${runId}.json`), { force: true });
								removeTempDir(getRunMetadataDir(runId));
							}
							removeTempDir(cwd);
						}
					});
				}
			}
		}
	}
});
