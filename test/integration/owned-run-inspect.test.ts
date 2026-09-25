import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, test } from "node:test";
import { createEventBus, createTempDir, makeMinimalCtx, removeTempDir } from "../support/helpers.ts";
import type { AsyncStatus, OwnedRun, SubagentState } from "../../src/shared/types.ts";

const root = createTempDir("owned-inspect-");
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
process.env.PI_SUBAGENT_TEMP_ROOT = path.join(root, "pi-subagents-runtime");
const { ASYNC_DIR } = await import("../../src/shared/types.ts");
const { readAsyncControlRequests } = await import("../../src/runs/background/async-control.ts");
const { createSubagentExecutor } = await import("../../src/runs/foreground/subagent-executor.ts");
const { getRunMetadataDir, saveAsyncRunResult, saveQuestionContract } = await import("../../src/runs/shared/supervisor-questions.ts");
after(() => removeTempDir(root));

for (const durable of [true, false]) test(`owned ${durable ? "durable" : "legacy async"} inspect has one report and keeps runtime evidence and controls`, async () => {
	const runId = `inspect-${durable}`;
	const sessionFile = path.join(root, `${runId}.jsonl`);
	fs.writeFileSync(sessionFile, "");
	const run: OwnedRun = {
		runId, rootRunId: runId, ownerSessionId: "session-123", source: "async", mode: "single", cwd: root,
		task: "Check the approved behavior", startedAt: 100, children: [{ agent: "worker", index: 0, sessionFile }],
		asyncDir: durable ? getRunMetadataDir(runId) : path.join(ASYNC_DIR, runId), pid: process.pid,
	};
	const state: SubagentState = {
		baseCwd: root, currentSessionId: run.ownerSessionId, ownedRuns: new Map([[runId, run]]),
		asyncJobs: new Map(),
		cleanupTimers: new Map(), lastUiContext: null, poller: null, completionSeen: new Map(), watcher: null,
		watcherRestartTimer: null, resultFileCoalescer: { schedule: () => false, clear() {} },
	};
	saveQuestionContract(runId, 0, { sessionFile, pid: process.pid, launch: {
		agent: { name: "worker", description: "Fixture", source: "project", filePath: "/fixture/worker.md", systemPrompt: "Keep details", systemPromptMode: "replace", inheritProjectContext: true, inheritSkills: false },
		systemPrompt: "Keep details", skills: [], model: "fixture/original", modelCandidates: ["fixture/original"], thinking: "high",
		cwd: root, context: "fresh", output: false, outputMode: "inline", artifacts: true, share: false,
		maxOutput: { bytes: 200_000, lines: 5_000 },
	} });
	let status: AsyncStatus | undefined;
	{
		fs.mkdirSync(run.asyncDir!, { recursive: true });
		status = { ...(durable ? { runtimeVersion: 2 as const, timeoutAt: Date.now() + 60_000, controlRequestFiles: true, indexedControl: true } : {}), runId, sessionId: run.ownerSessionId, mode: "single", state: "running", pid: process.pid, startedAt: Date.now() - 100, lastUpdate: Date.now(),
			lastActivityAt: Date.now(), currentStep: 0, outputFile: "output-0.log", sessionFile,
			steps: [{ agent: "worker", label: "Actual work", phase: "Implementation", status: "running", model: "fixture/fallback", thinking: "medium", sessionFile, currentTool: "bash", currentPath: "/fixture/changed.ts", tokens: { input: 100, output: 23, total: 123 }, turnCount: 2, toolCount: 3, lastActivityAt: Date.now() }],
		};
		fs.writeFileSync(path.join(run.asyncDir!, "status.json"), JSON.stringify(status));
		fs.writeFileSync(path.join(run.asyncDir!, "output-0.log"), "Unique legacy output tail\nRun: this is user output, not a report heading");
		fs.writeFileSync(path.join(run.asyncDir!, `subagent-log-${runId}.md`), "log");
		fs.writeFileSync(path.join(run.asyncDir!, "events.jsonl"), "");
	}
	const events = createEventBus();
	events.on("subagent:intercom-health-request", (request) => {
		const { requestId, targets } = request as { requestId: string; targets: string[] };
		events.emit("subagent:intercom-health-response", { requestId, health: targets.map((target) => ({ target, status: "registered", sessionStatus: "tool:bash" })) });
	});
	const executor = createSubagentExecutor({ pi: { events, getSessionName: () => "parent" }, state, config: {}, asyncByDefault: false,
		tempArtifactsDir: root, getSubagentSessionRoot: () => root, expandTilde: (value) => value, discoverAgents: () => ({ agents: [] }) });
	const inspect = () => executor.execute("inspect", { action: "status", id: runId }, undefined, undefined, makeMinimalCtx(root));
	const live = await inspect();
	assert.equal(live.isError, undefined);
	const text = live.content.map((part) => part.text).join("\n");
	for (const heading of ["Run", "State", "Mode"]) assert.equal(text.match(new RegExp(`^${heading}:`, "gm"))?.length, 1, `${heading} must appear once`);
	assert.equal(live.content.length, 1, "one coherent report, not two content blocks");
	for (const detail of ["Task: Check the approved behavior", "Root:", "Parent review (not sent to child):", "Notification:", "configuration: saved launch snapshot", "Effective model: fixture/original", "Activity:", "Intercom: registered", "Nudge (preferred", "Ask (blocking"]) assert.ok(text.includes(detail), detail);
	assert.equal(live.details.run?.children[0]?.launch?.agent.filePath, "/fixture/worker.md", "full profile provenance remains stored");
	assert.ok(live.details.managementControl?.capabilities.includes("nudge"));
	assert.ok(live.details.managementControl?.capabilities.includes("resume"));
	assert.ok(live.details.managementControl?.capabilities.includes("interrupt"));
	for (const detail of ["123 tokens", "/fixture/changed.ts", "2 turns", "3 tools"]) assert.ok(text.includes(detail), detail);
	if (durable) {
		for (const detail of ["Timeout:", "Extend:"]) assert.ok(text.includes(detail), detail);
		assert.ok(live.details.managementControl?.capabilities.includes("extend"));
		const extended = await executor.execute("extend", { action: "extend", id: runId, extendMs: 1000 }, undefined, undefined, makeMinimalCtx(root));
		assert.equal(extended.isError, undefined);
		assert.deepEqual(readAsyncControlRequests(run.asyncDir!, runId).map(({ action, extendMs, index }) => ({ action, extendMs, index })), [{ action: "extend", extendMs: 1000, index: undefined }]);
		let nudged: { to: string; message: string } | undefined;
		events.on("subagent:live-intercom", (request) => { nudged = request; events.emit("subagent:live-intercom-delivery", { requestId: request.requestId, delivered: true }); });
		const nudge = await executor.execute("nudge", { action: "nudge", message: "Keep the API" }, undefined, undefined, makeMinimalCtx(root));
		assert.equal(nudge.isError, undefined);
		assert.equal(nudged?.to, `subagent-worker-${runId}-1`);
		assert.match(nudged!.message, /Keep the API/);
		const stopped = await executor.execute("selected-stop", { action: "interrupt", id: runId, index: 0 }, undefined, undefined, makeMinimalCtx(root));
		assert.equal(stopped.isError, undefined);
		assert.deepEqual(readAsyncControlRequests(run.asyncDir!, runId).map(({ action, index }) => ({ action, index })), [{ action: "interrupt", index: 0 }]);
	}
	{
		for (const detail of ["Progress:", "Started:", "Updated:", "Dir:", "Output:", "Implementation", "fallback · thinking medium", "Log:", "Events:"]) assert.ok(text.includes(detail), detail);
		status!.state = "complete";
		status!.steps![0]!.status = "complete";
		fs.writeFileSync(path.join(run.asyncDir!, "status.json"), JSON.stringify(status));
		saveAsyncRunResult(runId, { id: runId, state: "complete", success: true, timestamp: 300, results: [{ agent: "worker", success: true, exitCode: 0, sessionFile, output: "Saved result", modelAttempts: [{ model: "fixture/fallback", success: true, exitCode: 0, usage: { input: 23, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.25, turns: 1 } }] }] });
		const completed = await inspect();
		const completedText = completed.content.map((part) => part.text).join("\n");
		assert.equal(completedText.match(/^Run:/gm)?.length, 1);
		assert.match(completedText, /Unique legacy output tail/);
		assert.match(completedText, /  Run: this is user output/);
		assert.match(completedText, /Saved result/);
		assert.equal(completed.details.run?.children[0]?.result?.usage.input, 23);
		assert.ok(completed.details.managementControl?.capabilities.includes("review"));
		assert.ok(completed.details.managementControl?.capabilities.includes("resume"));
		assert.ok(!completed.details.managementControl?.capabilities.includes("nudge"));
	}
});
