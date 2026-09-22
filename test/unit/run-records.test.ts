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
		const { ownedRunStatusResult, ownedRunExecutionResult, ownedRunProgressResult, ownedRunView } = await import("../../src/runs/shared/run-records.ts");
		const { getRunMetadataDir, saveAsyncRunResult, saveRunStatus } = await import("../../src/runs/shared/supervisor-questions.ts");
		const { buildWorkflowGraphSnapshot, workflowAgentNodes } = await import("../../src/runs/shared/workflow-graph.ts");
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
			baseCwd: root, currentSessionId: run.ownerSessionId, asyncJobs: new Map(),
			cleanupTimers: new Map(), lastUiContext: null, poller: null,
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
		const execution = ownedRunExecutionResult(run, state);
		assert.deepEqual(execution.details.run?.children[1]?.result?.artifactPaths, legacyPaths, "bounded execution views must retain available legacy artifact references");
		assert.equal(execution.details.results[1]?.artifactPaths, undefined, "do not fabricate missing required artifact paths");

		const startingId = "starting-owner";
		const starting: OwnedRun = { ...run, runId: startingId, rootRunId: startingId, pid: process.pid, asyncDir: getRunMetadataDir(startingId) };
		const progressBeforeStatus = ownedRunProgressResult(starting, state);
		assert.deepEqual(progressBeforeStatus.details.progress?.map((child) => child.status), ["pending", "pending", "pending"], "an owner PID does not prove any child has started");
		assert.ok(ownedRunView(starting, state).children.every((child) => child.activity?.status === "pending"));
		saveRunStatus(startingId, { runtimeVersion: 2, runId: startingId, mode: "parallel", state: "running", pid: process.pid, startedAt: Date.now(),
			steps: starting.children.map((child, index) => ({ agent: child.agent, status: index < 2 ? "running" : "pending" })) });
		assert.deepEqual(ownedRunProgressResult(starting, state).details.progress?.map((child) => child.status), ["running", "running", "pending"], "observed activity preserves the owner's concurrency bound");

		const chainId = "logical-chain", chainDir = getRunMetadataDir(chainId);
		const graph = buildWorkflowGraphSnapshot({ runId: chainId, steps: [{ agent: "discover", task: "Find" },
			{ expand: { from: { output: "items", path: "/items" }, maxItems: 3 }, parallel: { agent: "worker", task: "Review {item}" }, collect: { as: "reviews" } }, { agent: "finish", task: "Finish" }],
			dynamicChildren: { 1: ["a", "b", "c"].map((itemKey, index) => ({ agent: "worker", flatIndex: index + 1, itemKey })) },
			stepStatuses: ["complete", "running", "running", "running", "pending"].map((status) => ({ status })), currentFlatIndex: 2 });
		const chain: OwnedRun = { ...starting, runId: chainId, rootRunId: chainId, mode: "chain", asyncDir: chainDir,
			children: workflowAgentNodes(graph).map((node, index) => ({ index, agent: node.agent!, workflowNodeId: node.id, task: `Assignment ${index}` })) };
		saveRunStatus(chainId, { runtimeVersion: 2, runId: chainId, mode: "chain", state: "running", pid: process.pid, startedAt: Date.now(), chainStepCount: 3, currentStep: 2, workflowGraph: graph,
			steps: chain.children.map((child, index) => ({ agent: child.agent, status: index === 0 ? "complete" : index === 4 ? "pending" : "running" })) });
		const chainProgress = ownedRunProgressResult(chain, state);
		assert.equal(chainProgress.details.progress?.length, 5);
		assert.equal(chainProgress.details.totalSteps, 3, "expanded agents do not become extra logical steps");
		assert.equal(chainProgress.details.currentStepIndex, 1, "the third physical child is still in logical step two");
		assert.equal(chainProgress.details.chainAgents?.length, 3);
		graph.nodes[0]!.status = "completed";
		graph.nodes[1]!.status = "failed"; graph.nodes[1]!.error = "Invalid collection";
		for (const child of graph.nodes[1]!.children!) child.status = "completed";
		saveAsyncRunResult(chainId, { runtimeVersion: 2, id: chainId, state: "failed", error: "Invalid collection", workflowGraph: graph,
			results: chain.children.slice(0, 4).map((child) => ({ agent: child.agent, task: child.task, success: true, exitCode: 0, output: "Done" })) });
		const chainResult = ownedRunExecutionResult(chain, state);
		assert.equal(chainResult.isError, true);
		assert.equal(chainResult.details.results.length, 4);
		assert.equal(chainResult.details.totalSteps, 3);
		assert.equal(chainResult.details.currentStepIndex, 1, "the failed group retains its logical step in the final card");
		assert.equal(chainResult.details.chainAgents?.length, 3);

		// Workflow failures belong to the group, including an empty expansion; no physical child failed.
		for (const childCount of [0, 2]) {
			const runId = `collection-failure-${childCount}`;
			const children = Array.from({ length: childCount }, (_, index) => ({ agent: "worker", index, workflowNodeId: `step-0-item-${index}`, task: `Physical assignment ${index}` }));
			const failedRun: OwnedRun = { ...run, runId, rootRunId: runId, mode: "chain", children };
			const error = "Collected output does not match the required schema";
			saveAsyncRunResult(runId, { runtimeVersion: 2, id: runId, state: "failed", timestamp: 300, error,
				results: children.map((child) => ({ agent: child.agent, task: child.task, output: `Result ${child.index}`, success: true, exitCode: 0 })) });
			const failed = ownedRunStatusResult(failedRun, state);
			assert.equal(failed.details.run?.state, "failed");
			assert.equal(failed.details.run?.diagnosis, error);
			assert.deepEqual(failed.details.run?.children.map((child) => ({ task: child.task, state: child.state })), children.map((child) => ({ task: child.task, state: "completed" })));
			assert.match(failed.content[0]!.text, /Collected output does not match/);
			assert.doesNotMatch(failed.content[0]!.text, /Original child assignment unavailable/);
			const result = ownedRunExecutionResult(failedRun, state);
			assert.equal(result.isError, true);
			assert.equal(result.details.results.length, childCount, "workflow failure never fabricates a resumable child");
			assert.match(result.content[0]!.text, /Collected output does not match/);
		}
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousTempRoot === undefined) delete process.env.PI_SUBAGENT_TEMP_ROOT;
		else process.env.PI_SUBAGENT_TEMP_ROOT = previousTempRoot;
		fs.rmSync(root, { recursive: true, force: true });
	}
});
