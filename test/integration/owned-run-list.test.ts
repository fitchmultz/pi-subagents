import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as path from "node:path";
import { after, test } from "node:test";
import { createTempDir, removeTempDir } from "../support/helpers.ts";
import type { OwnedRun, SubagentState } from "../../src/shared/types.ts";

const root = createTempDir("owned-list-");
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
process.env.PI_SUBAGENT_TEMP_ROOT = path.join(root, "pi-subagents-runtime");
const { ownedRunList, ownedRunStatusResult, rememberOwnedRun, saveForegroundRun } = await import("../../src/runs/shared/run-records.ts");
const { createSupervisorQuestion, getRunMetadataDir, LEGACY_QUESTIONS_DIR, QUESTIONS_DIR, recordQuestionDelivery, saveAsyncRunResult, saveQuestionAnswer, saveQuestionContract, saveQuestionOwner, saveRunStatus } = await import("../../src/runs/shared/supervisor-questions.ts");
after(() => removeTempDir(root));

test("owned pages skip unchanged off-page results/contracts while keeping fresh attention, questions, review and lineage", (t) => {
	const state: SubagentState = {
		baseCwd: root, currentSessionId: "parent", ownedRuns: new Map(), asyncJobs: new Map(), foregroundControls: new Map(),
		lastForegroundControlId: null, cleanupTimers: new Map(), lastUiContext: null, poller: null, completionSeen: new Map(), watcher: null,
		watcherRestartTimer: null, resultFileCoalescer: { schedule: () => false, clear() {} },
	};
	const sessionFile = path.join(root, "child.jsonl");
	fs.writeFileSync(sessionFile, "");
	for (let index = 0; index < 65; index++) {
		const runId = `page-${String(index).padStart(2, "0")}`;
		const run: OwnedRun = { runId, rootRunId: index >= 60 ? "page-00" : runId, ownerSessionId: "parent", source: index === 1 ? "foreground" : "async",
			mode: "single", cwd: root, task: `Work ${index}`, startedAt: index + 1, children: [{ agent: "worker", index: 0, sessionFile }],
			...(index >= 3 ? { review: { decision: "accepted", reviewedAt: index } } : {}),
			...(index >= 60 ? { predecessorRunId: index === 60 ? "page-00" : `page-${index - 1}`, predecessorIndex: 0 } : {}),
			...(index === 1 ? { legacy: true } : {}),
		};
		rememberOwnedRun(state, run);
		saveQuestionOwner(runId, "parent");
		saveQuestionContract(runId, 0, { sessionFile, ...(index === 2 ? { pid: process.pid } : {}) });
		if (index === 2) saveRunStatus(runId, { runId, mode: "single", state: "running", startedAt: 3, lastUpdate: 3, pid: process.pid, steps: [{ agent: "worker", status: "running", sessionFile }] });
		else if (index === 1) saveForegroundRun({ runId, mode: "single", cwd: root, results: [{ agent: "worker", task: run.task, exitCode: 0, sessionFile, finalOutput: "Legacy saved foreground evidence", messages: [], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 } }] });
		else saveAsyncRunResult(runId, { id: runId, state: index === 0 ? "failed" : "complete", success: index !== 0, timestamp: index + 1,
			results: [{ agent: "worker", success: index !== 0, exitCode: index === 0 ? 1 : 0, sessionFile, output: `Result ${index}: ${"evidence ".repeat(500)}` }] });
	}
	// A live pre-update waiter can still write its answer to the legacy directory.
	saveQuestionOwner("page-03", "parent", LEGACY_QUESTIONS_DIR);
	const question = createSupervisorQuestion({ runId: "page-03", ownerTarget: "parent", agent: "worker", index: 0, childSessionId: "child", childTarget: "child", sessionFile, cwd: root, pid: process.pid, reason: "need_decision", message: "Which path?" }, LEGACY_QUESTIONS_DIR);
	const reads = new Map<string, number>();
	let metadataScans = 0, migrationScans = 0;
	const readFile = fs.readFileSync, readDirectory = fs.readdirSync;
	t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
		const value = Reflect.apply(readFile, fs, args);
		const file = String(args[0]);
		if (file.startsWith(QUESTIONS_DIR)) reads.set(file, (reads.get(file) ?? 0) + 1);
		return value;
	});
	t.mock.method(fs, "readdirSync", (...args: Parameters<typeof fs.readdirSync>) => {
		if (String(args[0]) === QUESTIONS_DIR) metadataScans++;
		if (String(args[0]) === LEGACY_QUESTIONS_DIR) migrationScans++;
		return Reflect.apply(readDirectory, fs, args);
	});
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	const page = () => ownedRunList(state, { limit: 2 });
	assert.deepEqual(page().details.runs?.map((run) => run.runId), ["page-03", "page-00"]);
	reads.clear(); metadataScans = 0; migrationScans = 0;
	assert.deepEqual(page().details.runs?.map((run) => run.runId), ["page-03", "page-00"]);
	const offPageReads = [...reads].filter(([file]) => /\/(?:result|foreground)\.json$|\/contracts\//.test(file)
		&& !["page-03", "page-00", "page-02"].some((id) => file.startsWith(`${getRunMetadataDir(id)}/`)));
	assert.equal(offPageReads.length, 0, "unchanged off-page results and launch contracts must not be reloaded");
	assert.ok(metadataScans <= 1, `metadata root scanned ${metadataScans} times`);
	assert.equal(migrationScans, 1, "legacy migration is shared by the page, not repeated per run");
	t.diagnostic(`65 retained runs; unchanged off-page result/contract reads: ${offPageReads.length}; metadata scans: ${metadataScans}; migration scans: ${migrationScans}.`);

	saveAsyncRunResult("page-02", { id: "page-02", state: "failed", success: false, timestamp: Date.now(), results: [{ agent: "worker", success: false, exitCode: 1, output: "Fresh child failure", sessionFile }] });
	assert.deepEqual(page().details.runs?.map((run) => run.runId), ["page-03", "page-02"], "a newly finished child must move into attention immediately");
	saveQuestionAnswer(question, "Use the native path", LEGACY_QUESTIONS_DIR);
	assert.equal(page().details.runs?.[0]?.runId, "page-03", "saved but undelivered answers still need attention");
	recordQuestionDelivery(question, { kind: "live", runId: "page-03", deliveredAt: Date.now() }, LEGACY_QUESTIONS_DIR);
	assert.deepEqual(page().details.runs?.map((run) => run.runId), ["page-02", "page-00"]);
	rememberOwnedRun(state, { ...state.ownedRuns!.get("page-00")!, review: { decision: "accepted", reviewedAt: Date.now() } });
	assert.deepEqual(page().details.runs?.map((run) => run.runId), ["page-02", "page-01"], "review changes reorder without replacing execution outcomes");
	assert.match(page().content[0]!.text, /Legacy saved foreground evidence/);
	fs.unlinkSync(sessionFile);
	assert.ok(!page().details.managementControls?.find((control) => control.runId === "page-01")?.capabilities.includes("resume"), "selected controls must notice a removed session file");
	fs.writeFileSync(sessionFile, "restored context");
	assert.ok(page().details.managementControls?.find((control) => control.runId === "page-01")?.capabilities.includes("resume"));

	const all: string[] = [];
	for (let offset = 0; offset < 65; offset += 7) {
		const result = ownedRunList(state, { offset, limit: 7 });
		assert.equal(result.details.runList?.total, 65);
		all.push(...result.details.runs!.map((run) => run.runId));
	}
	assert.equal(new Set(all).size, 65, "paging does not cap history or repeat runs");
	assert.equal(ownedRunStatusResult(state.ownedRuns!.get("page-64")!, state).details.run?.children[0]?.result?.finalOutput?.startsWith("Result 64:"), true);
	assert.deepEqual(ownedRunStatusResult(state.ownedRuns!.get("page-00")!, state).details.run?.continuations.map((run) => run.runId), ["page-60", "page-61", "page-62", "page-63", "page-64"]);
});
