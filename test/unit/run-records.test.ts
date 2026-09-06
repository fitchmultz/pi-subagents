import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import type { ArtifactPaths, AsyncResultFile, OwnedRun, SubagentState } from "../../src/shared/types.ts";

it("owned inspection retains persisted background attempt usage and full, partial, or absent artifact paths", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-owned-evidence-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousTempRoot = process.env.PI_SUBAGENT_TEMP_ROOT;
	process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
	process.env.PI_SUBAGENT_TEMP_ROOT = path.join(root, "pi-subagents-runtime");
	try {
		const { ownedRunStatusResult } = await import("../../src/runs/shared/run-records.ts");
		const { getRunMetadataDir, saveAsyncRunResult } = await import("../../src/runs/shared/supervisor-questions.ts");
		const { readAsyncResultFile } = await import("../../src/runs/background/async-result-file.ts");
		const artifactPaths: ArtifactPaths = {
			inputPath: path.join(root, "input.md"), outputPath: path.join(root, "output.md"), metadataPath: path.join(root, "metadata.json"),
		};
		const legacyPaths = { outputPath: path.join(root, "legacy-output.md") };
		for (const file of [...Object.values(artifactPaths), legacyPaths.outputPath]) fs.writeFileSync(file, "Recorded background evidence.\n");
		const run: OwnedRun = {
			runId: "owned-background", rootRunId: "owned-background", ownerSessionId: "parent", source: "async", mode: "parallel",
			cwd: root, task: "Inspect saved evidence", startedAt: 100,
			children: [{ agent: "worker", index: 0 }, { agent: "legacy", index: 1 }, { agent: "no-artifacts", index: 2 }],
		};
		const persisted: AsyncResultFile = {
			id: run.runId, sessionId: run.ownerSessionId, cwd: root, mode: run.mode, state: "complete", success: true, timestamp: 200,
			results: [
				{
					agent: "worker", output: "Completed after fallback", success: true, exitCode: 0, artifactPaths,
					modelAttempts: [
						{ model: "provider/first", success: false, exitCode: 1, error: "quota exceeded", usage: { input: 11, output: 3, cacheRead: 7, cacheWrite: 5, cost: 0.125, turns: 1 } },
						{ model: "provider/fallback", success: true, exitCode: 0, usage: { input: 29, output: 8, cacheRead: 13, cacheWrite: 17, cost: 0.375, turns: 2 } },
					],
				},
				{ agent: "legacy", output: "Legacy output only", success: true, exitCode: 0, artifactPaths: legacyPaths },
				{ agent: "no-artifacts", output: "No saved artifacts", success: true, exitCode: 0 },
			],
		};
		saveAsyncRunResult(run.runId, persisted);
		const resultPath = path.join(getRunMetadataDir(run.runId), "result.json");
		const decoded = readAsyncResultFile(resultPath);
		assert.equal(decoded.terminalState, "complete");
		assert.deepEqual(decoded.results, persisted.results, "the background writer and reader retain the recorded evidence");
		const state: SubagentState = {
			baseCwd: root, currentSessionId: run.ownerSessionId, asyncJobs: new Map(), foregroundControls: new Map(),
			lastForegroundControlId: null, cleanupTimers: new Map(), lastUiContext: null, poller: null,
			completionSeen: new Map(), watcher: null, watcherRestartTimer: null, resultFileCoalescer: { schedule: () => false, clear() {} },
		};
		const inspected = ownedRunStatusResult(run, state);
		const view = inspected.details.run;
		assert.ok(view);
		assert.equal(view.resultPath, resultPath);
		assert.equal(view.state, "completed");
		const noRecordedUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
		assert.deepEqual(view.children.map(({ result }) => ({ usage: result?.usage, artifactPaths: result?.artifactPaths })), [
			{ usage: { input: 40, output: 11, cacheRead: 20, cacheWrite: 22, cost: 0.5, turns: 3 }, artifactPaths },
			{ usage: noRecordedUsage, artifactPaths: legacyPaths },
			{ usage: noRecordedUsage, artifactPaths: undefined },
		], "owned inspection must not erase recorded usage or paths, or invent missing paths");
		const artifactLines = inspected.content.flatMap((part) => part.type === "text" ? part.text.split("\n").filter((line) => line.startsWith("  Artifact: ")) : []);
		assert.deepEqual(artifactLines, [`  Artifact: ${artifactPaths.outputPath}`, `  Artifact: ${legacyPaths.outputPath}`]);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousTempRoot === undefined) delete process.env.PI_SUBAGENT_TEMP_ROOT;
		else process.env.PI_SUBAGENT_TEMP_ROOT = previousTempRoot;
		fs.rmSync(root, { recursive: true, force: true });
	}
});
