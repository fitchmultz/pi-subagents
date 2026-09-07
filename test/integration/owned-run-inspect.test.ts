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
const { createSubagentExecutor } = await import("../../src/runs/foreground/subagent-executor.ts");
const { saveAsyncRunResult, saveQuestionContract } = await import("../../src/runs/shared/supervisor-questions.ts");
after(() => removeTempDir(root));

for (const source of ["async", "foreground"] as const) test(`owned ${source} inspect has one report and keeps runtime evidence and controls`, async () => {
	const runId = `inspect-${source}`;
	const sessionFile = path.join(root, `${runId}.jsonl`);
	fs.writeFileSync(sessionFile, "");
	const run: OwnedRun = {
		runId, rootRunId: runId, ownerSessionId: "session-123", source, mode: "single", cwd: root,
		task: "Check the approved behavior", startedAt: 100, children: [{ agent: "worker", index: 0, sessionFile }],
		...(source === "async" ? { asyncDir: path.join(ASYNC_DIR, runId), pid: process.pid } : {}),
	};
	const state: SubagentState = {
		baseCwd: root, currentSessionId: run.ownerSessionId, ownedRuns: new Map([[runId, run]]),
		asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null,
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
	if (source === "async") {
		fs.mkdirSync(run.asyncDir!, { recursive: true });
		status = { runId, sessionId: run.ownerSessionId, mode: "single", state: "running", pid: process.pid, startedAt: Date.now() - 100, lastUpdate: Date.now(),
			lastActivityAt: Date.now(), currentStep: 0, outputFile: "output-0.log", sessionFile,
			steps: [{ agent: "worker", label: "Actual work", phase: "Implementation", status: "running", model: "fixture/fallback", thinking: "medium", sessionFile }],
		};
		fs.writeFileSync(path.join(run.asyncDir!, "status.json"), JSON.stringify(status));
		fs.writeFileSync(path.join(run.asyncDir!, "output-0.log"), "Unique legacy output tail\nRun: this is user output, not a report heading");
		fs.writeFileSync(path.join(run.asyncDir!, `subagent-log-${runId}.md`), "log");
		fs.writeFileSync(path.join(run.asyncDir!, "events.jsonl"), "");
		state.asyncJobs.set(runId, { asyncId: runId, asyncDir: run.asyncDir!, status: "running", pid: process.pid });
	} else {
		state.foregroundControls.set(runId, { runId, mode: "single", startedAt: 100, updatedAt: 200, currentAgent: "worker", currentIndex: 0,
			currentTool: "bash", currentPath: "/fixture/changed.ts", tokens: 123, turnCount: 2, toolCount: 3, lastActivityAt: Date.now(),
			timeoutAt: Date.now() + 60_000, extendTimeout: () => ({ ok: true, message: "extended" }), interrupt: () => true,
		});
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
	if (source === "foreground") {
		for (const detail of ["123 tokens", "path /fixture/changed.ts", "Timeout:", "Extend:"]) assert.ok(text.includes(detail), detail);
		assert.ok(live.details.managementControl?.capabilities.includes("extend"));
	} else {
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
