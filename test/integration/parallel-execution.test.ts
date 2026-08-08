/**
 * Integration tests for parallel execution.
 *
 * Tests parallel agent spawning via runSync.
 * The top-level parallel mode (params.tasks) lives in index.ts.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { INTERCOM_DETACH_REQUEST_EVENT } from "../../src/shared/types.ts";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { mapConcurrent } from "../../src/shared/utils.ts";
import type { MockPi } from "../support/helpers.ts";
import {
	createEventBus,
	createMockPi,
	createTempDir,
	events,
	makeAgent,
	makeAgentConfigs,
	makeMinimalCtx,
	removeTempDir,
} from "../support/helpers.ts";

describe("parallel agent execution", () => {
	let tempDir: string;
	let mockPi: MockPi;

	before(() => {
		mockPi = createMockPi();
		mockPi.install();
	});

	after(() => {
		mockPi.uninstall();
	});

	beforeEach(() => {
		tempDir = createTempDir();
		mockPi.reset();
	});

	afterEach(() => {
		removeTempDir(tempDir);
	});

	function git(cwd: string, args: string[]): string {
		const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
		if (result.status !== 0) {
			const message = result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`;
			throw new Error(message);
		}
		return result.stdout.trim();
	}

	function initGitRepo(cwd: string): void {
		git(cwd, ["init"]);
		git(cwd, ["config", "user.email", "tests@example.com"]);
		git(cwd, ["config", "user.name", "Parallel Tests"]);
		fs.writeFileSync(path.join(cwd, "tracked.txt"), "initial\n", "utf-8");
		git(cwd, ["add", "-A"]);
		git(cwd, ["commit", "-m", "initial commit"]);
	}

	function bestEffortRemovePreservedWorktree(repoDir: string, worktreePath: string, branch: string): void {
		try { spawnSync("git", ["-C", repoDir, "worktree", "remove", "--force", worktreePath], { encoding: "utf-8" }); } catch {}
		try { spawnSync("git", ["-C", repoDir, "branch", "-D", branch], { encoding: "utf-8" }); } catch {}
		try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch {}
	}

	function makeExecutor(agents = [makeAgent("echo")], artifactsDir = tempDir) {
		return createSubagentExecutor({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
			config: {},
			asyncByDefault: false,
			tempArtifactsDir: artifactsDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (value: string) => value,
			discoverAgents: () => ({ agents }),
		});
	}

	function readLastCallArgs(): string[] {
		const callFile = fs.readdirSync(mockPi.dir).find((name) => name.startsWith("call-"));
		assert.ok(callFile, "expected a recorded mock pi call");
		return JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")).args as string[];
	}

	it("runs multiple agents concurrently via mapConcurrent + runSync", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = makeAgentConfigs(["agent-a", "agent-b", "agent-c"]);
		const tasks = ["Task A", "Task B", "Task C"];

		const results = await mapConcurrent(
			tasks.map((task, i) => ({ agent: agents[i].name, task, index: i })),
			3,
			async ({ agent, task, index }: any) => {
				return runSync(tempDir, agents, agent, task, { index });
			},
		);

		assert.equal(results.length, 3);
		assert.ok(results.every((r: any) => r.exitCode === 0));
		assert.equal(results[0].agent, "agent-a");
		assert.equal(results[1].agent, "agent-b");
		assert.equal(results[2].agent, "agent-c");
	});

	it("all agents get independent results", async () => {
		mockPi.onCall({ output: "Result" });
		const agents = makeAgentConfigs(["a", "b"]);

		const results = await mapConcurrent(
			[
				{ agent: "a", task: "Task A" },
				{ agent: "b", task: "Task B" },
			],
			2,
			async ({ agent, task }: any, i: number) => runSync(tempDir, agents, agent, task, { index: i }),
		);

		assert.equal(results.length, 2);
		assert.equal(results[0].agent, "a");
		assert.equal(results[1].agent, "b");
		const ok = results.filter((r: any) => r.exitCode === 0).length;
		assert.equal(ok, 2);
	});

	it("top-level foreground parallel timeout returns completed and timed-out children", async () => {
		mockPi.onCall({ output: "Fast result" });
		mockPi.onCall({ delay: 10000 });
		const executor = makeExecutor([makeAgent("fast"), makeAgent("slow")]);

		const start = Date.now();
		const result = await executor.execute(
			"parallel-timeout",
			{
				tasks: [
					{ agent: "fast", task: "Finish quickly" },
					{ agent: "slow", task: "Run too long" },
				],
				concurrency: 1,
				timeoutMs: 250,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		) as any;
		const elapsed = Date.now() - start;

		assert.ok(elapsed < 5000, `should time out early, took ${elapsed}ms`);
		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Parallel run timed out/);
		assert.equal(result.details.results.length, 2);
		assert.equal(result.details.results[0].exitCode, 0);
		assert.equal(result.details.results[0].timedOut, undefined);
		assert.equal(result.details.results[1].exitCode, 124);
		assert.equal(result.details.results[1].timedOut, true);
	});

	it("extends a top-level foreground parallel timeout", async () => {
		mockPi.onCall({ delay: 450, output: "Slow result" });
		mockPi.onCall({ output: "Second result" });
		const executor = makeExecutor([makeAgent("slow"), makeAgent("second")]);

		const resultPromise = executor.execute(
			"parallel-extend",
			{
				tasks: [
					{ agent: "slow", task: "Need more time" },
					{ agent: "second", task: "Starts after extension" },
				],
				concurrency: 1,
				timeoutMs: 250,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		) as Promise<any>;
		await new Promise((resolve) => setTimeout(resolve, 75));
		const extension = await executor.execute(
			"parallel-extend-control",
			{ action: "extend", extendMs: 1500 },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		) as any;
		const result = await resultPromise;

		assert.equal(extension.isError, undefined, JSON.stringify(extension));
		assert.match(extension.content[0]?.text ?? "", /Extended foreground run/);
		assert.equal(result.isError, undefined);
		assert.equal(result.details.results.length, 2);
		assert.equal(result.details.results[0].exitCode, 0);
		assert.equal(result.details.results[1].exitCode, 0);
	});

	it("keeps a detached child's worktree until that child exits", async () => {
		initGitRepo(tempDir);
		mockPi.onCall({ steps: [
			{ jsonl: [events.toolStart("contact_supervisor", { reason: "progress_update", message: "Need input" })] },
			{ delay: 500, jsonl: [events.assistantMessage("finished in worktree")] },
		] });
		const bus = createEventBus();
		const executor = createSubagentExecutor({
			pi: { events: bus, getSessionName: () => undefined },
			state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
			config: {},
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (value: string) => value,
			discoverAgents: () => ({ agents: [makeAgent("worker")] }),
		});
		let detached = false;

		const result = await executor.execute(
			"detached-worktree",
			{ tasks: [{ agent: "worker", task: "Wait for input" }], worktree: true },
			new AbortController().signal,
			(update: { details?: { progress?: Array<{ currentTool?: string }> } }) => {
				if (detached || !update.details?.progress?.some((entry) => entry.currentTool === "contact_supervisor")) return;
				detached = true;
				bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "detached-worktree" });
			},
			makeMinimalCtx(tempDir),
		);
		assert.match(result.content[0]?.text ?? "", /detached for intercom coordination/i);
		const callFile = fs.readdirSync(mockPi.dir).find((name) => name.startsWith("call-"));
		assert.ok(callFile);
		const worktreeCwd = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")).cwd as string;
		assert.notEqual(worktreeCwd, tempDir);
		assert.equal(fs.existsSync(worktreeCwd), true, "worktree must remain while the detached child is active");
		const deadline = Date.now() + 5_000;
		while (fs.existsSync(worktreeCwd) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
		assert.equal(fs.existsSync(worktreeCwd), false, "worktree should be cleaned after detached completion");
	});

	it("top-level foreground parallel timeout preserves worktrees when diff capture setup fails", async () => {
		initGitRepo(tempDir);
		const sessionRoot = createTempDir();
		const sessionFile = path.join(sessionRoot, "session.jsonl");
		fs.writeFileSync(sessionFile, "", "utf-8");
		const artifactsDir = path.join(sessionRoot, "subagent-artifacts");
		fs.mkdirSync(artifactsDir, { recursive: true });
		fs.writeFileSync(path.join(artifactsDir, "worktree-diffs"), "not a directory\n", "utf-8");
		mockPi.onCall({ output: "Fast result" });
		mockPi.onCall({ delay: 10000 });
		const executor = makeExecutor([makeAgent("fast"), makeAgent("slow")], artifactsDir);
		let preservedWorktree = "";
		let preservedBranch = "";
		try {
			const ctx = makeMinimalCtx(tempDir);
			ctx.sessionManager.getSessionFile = () => sessionFile;
			const result = await executor.execute(
				"parallel-timeout-worktree-diff-failure",
				{
					tasks: [
						{ agent: "fast", task: "Finish quickly" },
						{ agent: "slow", task: "Run too long" },
					],
					concurrency: 1,
					timeoutMs: 1500,
					worktree: true,
				},
				new AbortController().signal,
				undefined,
				ctx,
			) as any;

			const text = result.content[0]?.text ?? "";
			assert.equal(result.isError, true);
			assert.match(text, /Parallel run timed out/);
			assert.match(text, /Diff capture failed:/);
			assert.match(text, /Preserved worktree:/);
			preservedWorktree = text.match(/Preserved worktree: (.+)/)?.[1]?.trim() ?? "";
			preservedBranch = text.match(/Preserved branch: (.+)/)?.[1]?.trim() ?? "";
			assert.ok(preservedWorktree, "expected preserved worktree path in result text");
			assert.ok(preservedBranch, "expected preserved branch in result text");
			assert.equal(fs.existsSync(preservedWorktree), true, "worktree should remain for recovery");
		} finally {
			if (preservedWorktree && preservedBranch) bestEffortRemovePreservedWorktree(tempDir, preservedWorktree, preservedBranch);
			removeTempDir(sessionRoot);
		}
	});

	it("top-level parallel explicit output paths persist in the workspace", async () => {
		mockPi.onCall({ output: "Saved report" });
		const executor = makeExecutor();

		const result = await executor.execute(
			"parallel-output",
			{ tasks: [{ agent: "echo", task: "Write report", output: "parallel-output.md" }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const outputPath = path.join(tempDir, "parallel-output.md");
		assert.equal(result.isError, undefined);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "Saved report");
		assert.equal(result.details?.results?.[0]?.savedOutputPath, outputPath);
		assert.equal(result.details?.results?.[0]?.outputCleanup, undefined);
		assert.match(result.details?.results?.[0]?.finalOutput ?? "", /Saved report/);
	});

	it("top-level parallel tasks support outputSchema", async () => {
		mockPi.onCall({ output: "structured report", structuredOutput: { summary: "ok", counts: { files: 1 }, files_to_edit: [] } });
		const executor = makeExecutor();

		const result = await executor.execute(
			"parallel-output-schema",
			{ tasks: [{ agent: "echo", task: "Return structured", outputSchema: { type: "object", properties: { summary: { type: "string" }, counts: { type: "object" }, files_to_edit: { type: "array" } }, required: ["summary", "counts", "files_to_edit"] } }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.deepEqual(result.details?.results?.[0]?.structuredOutput, { summary: "ok", counts: { files: 1 }, files_to_edit: [] });
	});

	it("top-level parallel file-only output aggregates concise file references", async () => {
		mockPi.onCall({ output: "Parallel full report\nwith details" });
		const executor = makeExecutor();

		const result = await executor.execute(
			"parallel-file-only-output",
			{ tasks: [{ agent: "echo", task: "Write report", output: "parallel-file-only.md", outputMode: "file-only" }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const outputPath = path.join(tempDir, "parallel-file-only.md");
		const text = result.content[0]?.text ?? "";
		assert.equal(result.isError, undefined);
		assert.match(text, /Output saved to:/);
		assert.match(text, /2 lines/);
		assert.doesNotMatch(text, /Parallel full report/);
		assert.match(result.details?.results?.[0]?.finalOutput ?? "", /Output saved to:/);
		assert.doesNotMatch(result.details?.results?.[0]?.finalOutput ?? "", /Parallel full report/);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "Parallel full report\nwith details");
	});

	it("rejects top-level parallel file-only output without an output path", async () => {
		const executor = makeExecutor();

		const result = await executor.execute(
			"parallel-file-only-missing-output",
			{ tasks: [{ agent: "echo", task: "Write report", outputMode: "file-only" }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /outputMode: "file-only"/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("rejects duplicate top-level parallel output paths", async () => {
		const executor = makeExecutor();

		const result = await executor.execute(
			"parallel-duplicate-output",
			{
				tasks: [
					{ agent: "echo", task: "Write A", output: "same.md" },
					{ agent: "echo", task: "Write B", output: "same.md" },
				],
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /same path/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("materializes duplicate agent-default parallel outputs to unique artifact paths", async () => {
		mockPi.onCall({ output: "Report A" });
		mockPi.onCall({ output: "Report B" });
		const artifactsDir = path.join(tempDir, "artifacts");
		const executor = makeExecutor([makeAgent("scout", { output: "context.md" })], artifactsDir);

		const result = await executor.execute(
			"parallel-default-output-artifacts",
			{
				tasks: [
					{ agent: "scout", task: "Write A" },
					{ agent: "scout", task: "Write B" },
				],
				concurrency: 2,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const details = (result as any).details;
		const paths = details?.results?.map((r: any) => r.outputReference?.path).filter(Boolean) ?? [];
		assert.equal(result.isError, undefined);
		assert.equal(mockPi.callCount(), 2);
		assert.equal(fs.existsSync(path.join(tempDir, "context.md")), false);
		assert.equal(paths.length, 2);
		assert.notEqual(paths[0], paths[1]);
		assert.ok(paths.every((p: string) => p.includes(`${path.sep}requested-outputs${path.sep}`)));
		assert.ok(paths.some((p: string) => /[a-f0-9]{8}_scout_0_context\.md$/.test(p)));
		assert.ok(paths.some((p: string) => /[a-f0-9]{8}_scout_1_context\.md$/.test(p)));
		assert.ok(details?.results?.every((r: any) => r.outputCleanup?.action === "deleted"));
	});

	it("treats string false as disabled output in top-level parallel runs", async () => {
		mockPi.onCall({ output: "Review done" });
		const executor = makeExecutor();

		const result = await executor.execute(
			"parallel-string-false-output",
			{
				tasks: [
					{ agent: "echo", task: "Review A", output: "false" },
					{ agent: "echo", task: "Review B", output: "false" },
				],
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.equal(mockPi.callCount(), 2);
		assert.equal(fs.existsSync(path.join(tempDir, "false")), false);
	});

	it("top-level parallel reads are injected once with chain-style prefix", async () => {
		mockPi.onCall({ output: "Read done" });
		const executor = makeExecutor();

		await executor.execute(
			"parallel-reads",
			{ tasks: [{ agent: "echo", task: "Inspect", reads: ["a.md", "b.md"] }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const args = readLastCallArgs();
		const taskArg = args.at(-1) ?? "";
		assert.ok(taskArg.startsWith(`Task: [Read from: ${path.join(tempDir, "a.md")}, ${path.join(tempDir, "b.md")}]

Inspect`));
		assert.doesNotMatch(taskArg, /## Acceptance Contract/);
	});

	it("top-level parallel progress emits the existing progress instruction style", async () => {
		mockPi.onCall({ output: "Progress done" });
		const executor = makeExecutor();

		await executor.execute(
			"parallel-progress",
			{ tasks: [{ agent: "echo", task: "Track work", progress: true }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const args = readLastCallArgs();
		assert.ok((args.at(-1) ?? "").includes(`Update progress at: ${path.join(tempDir, "progress.md")}`));
		assert.equal(fs.existsSync(path.join(tempDir, "progress.md")), true);
	});

	it("top-level parallel suppresses progress when the task is review-only", async () => {
		mockPi.onCall({ output: "Review done" });
		const executor = makeExecutor([makeAgent("reviewer", { defaultProgress: true })]);

		await executor.execute(
			"parallel-read-only-progress",
			{ tasks: [{ agent: "reviewer", task: "Review-only. Do not edit files. Return findings." }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const taskArg = readLastCallArgs().at(-1) ?? "";
		assert.doesNotMatch(taskArg, /progress\.md/);
		assert.equal(fs.existsSync(path.join(tempDir, "progress.md")), false);
	});
});
