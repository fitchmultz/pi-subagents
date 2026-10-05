import { hasErrorCode } from "../../src/shared/unknown.ts";
import { createSubagentState } from "../support/background-fixtures.ts";
import { readChildCall } from "../support/child-process-receipts.ts";
import { assertDefined, parseJson, textAt, record, numberValue } from "../support/assertions.ts";
import "../support/isolated-home.ts";
/** Parallel execution through the public executor. */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  INTERCOM_DETACH_REQUEST_EVENT,
  SUBAGENT_ASYNC_STARTED_EVENT,
  type SubagentExecutionResult,
} from "../../src/shared/types.ts";
import { parseAsyncStatus, parseAsyncStartedEvent } from "../../src/runs/background/run-schemas.ts";
import { getRunMetadataDir } from "../../src/runs/shared/supervisor-questions.ts";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import {
  type MockPi,
  createEventBus,
  createMockPi,
  createTempDir,
  events,
  makeAgent,
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

  function git(cwd: string, args: readonly string[]): string {
    const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
    if (result.status !== 0) {
      const stderr = result.stderr.trim();
      const stdout = result.stdout.trim();
      const message =
        [stderr, stdout].find((text) => text !== "") ?? `git ${args.join(" ")} failed`;
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

  function removePreservedWorktree(repoDir: string, worktreePath: string, branch: string): void {
    git(repoDir, ["worktree", "remove", "--force", worktreePath]);
    git(repoDir, ["branch", "-D", branch]);
  }

  function makeExecutor(
    agents = [makeAgent("echo")],
    artifactsDir = tempDir,
    eventBus = createEventBus(),
  ) {
    return createSubagentExecutor({
      pi: {
        events: eventBus,
        getSessionName: () => {
          /* The fixture does not need getSessionName side effects. */
        },
      },
      state: {
        ...createSubagentState(tempDir),
        baseCwd: tempDir,
        currentSessionId: null,
        asyncJobs: new Map(),
      },
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
    assert.ok(Boolean(callFile), "expected a recorded mock pi call");
    assertDefined(callFile);
    return readChildCall(path.join(mockPi.dir, callFile)).args;
  }

  it("top-level foreground parallel timeout returns completed and timed-out children", async () => {
    mockPi.onCall({ output: "Fast result" });
    mockPi.onCall({ delay: 10000 });
    const executor = makeExecutor([makeAgent("fast"), makeAgent("slow")]);

    const start = Date.now();
    const result = await executor.execute({
      toolCallId: "parallel-timeout",
      params: {
        tasks: [
          { agent: "fast", task: "Finish quickly" },
          { agent: "slow", task: "Run too long" },
        ],
        concurrency: 1,
        timeoutMs: 1000,
      },
      signal: new AbortController().signal,
      ctx: makeMinimalCtx(tempDir),
    });
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 5000, `should time out early, took ${elapsed}ms`);
    assert.equal(result.isError, true);
    assert.match(textAt(result.content), /Parallel run timed out/);
    assert.equal(result.details.results.length, 2);
    assert.equal(result.details.results[0].exitCode, 0);
    assert.equal(result.details.results[0].timedOut, undefined);
    assert.equal(result.details.results[1].exitCode, 124);
    assert.equal(result.details.results[1].timedOut, true);
  });

  it("extends a top-level foreground parallel timeout", async (t) => {
    const release = path.join(tempDir, "release-child");
    const clockFile = path.join(tempDir, "runner-clock.json");
    const savedEnv = {
      NODE_OPTIONS: process.env.NODE_OPTIONS,
      PI_TEST_RUNNER_CLOCK: process.env.PI_TEST_RUNNER_CLOCK,
    };
    const preload = new URL("../fixtures/runner-clock.mjs", import.meta.url).href;
    mockPi.onCall({ waitForFile: release, delay: 450, output: "Slow result" });
    mockPi.onCall({ output: "Second result" });
    const bus = createEventBus();
    let runId: string | undefined;
    let launcherPid: number | undefined;
    let runnerPid: number | undefined;
    bus.on(SUBAGENT_ASYNC_STARTED_EVENT, (event) => {
      const started = parseAsyncStartedEvent(event);
      runId = started.id;
      launcherPid = started.pid;
    });
    const executor = makeExecutor([makeAgent("slow"), makeAgent("second")], tempDir, bus);
    let resultPromise: Promise<SubagentExecutionResult> | undefined;
    let result: SubagentExecutionResult | undefined;
    let completed = false;
    let sequence = 0;
    const readEvidence = (name: string) => {
      if (runId === undefined) {
        return;
      }
      const file = path.join(getRunMetadataDir(runId), name);
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
    };
    const status = () => {
      const saved = readEvidence("status.json");
      return saved === undefined ? undefined : parseAsyncStatus(parseJson(saved));
    };
    const waitFor = async (check: () => boolean, message: string) => {
      const deadline = Date.now() + 5_000;
      while (!check()) {
        assert.ok(Date.now() < deadline, message);
        // Observe the owner publication before advancing this lifecycle transition.
        // oxlint-disable-next-line no-await-in-loop
        await new Promise((resolve) => {
          setTimeout(resolve, 5);
        });
      }
    };
    const clockCommand = (command: { readonly tick: number } | { readonly resume: true }) => {
      fs.writeFileSync(`${clockFile}.tmp`, JSON.stringify({ sequence: ++sequence, ...command }));
      fs.renameSync(`${clockFile}.tmp`, clockFile);
    };
    const tick = async (amount: number) => {
      clockCommand({ tick: amount });
      await waitFor(
        () =>
          fs.existsSync(`${clockFile}.ack`) &&
          record(parseJson(fs.readFileSync(`${clockFile}.ack`, "utf8"))).sequence === sequence,
        "owner clock advances",
      );
      return numberValue(record(parseJson(fs.readFileSync(`${clockFile}.ack`, "utf8"))).now);
    };
    const alive = (pid: number | undefined) => {
      if (!((pid ?? 0) !== 0 && !Number.isNaN(pid))) {
        return false;
      }
      try {
        assertDefined(pid);
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (hasErrorCode(error, "ESRCH")) {
          return false;
        }
        throw error;
      }
    };
    const stopOwner = () => {
      try {
        if (runnerPid !== undefined && alive(runnerPid)) {
          process.kill(runnerPid, "SIGTERM");
        } else if (launcherPid !== undefined && alive(launcherPid)) {
          process.kill(-launcherPid, "SIGTERM");
        }
      } catch (error) {
        if (!hasErrorCode(error, "ESRCH")) {
          throw error;
        }
      }
    };
    const failures: unknown[] = [];
    try {
      process.env.NODE_OPTIONS = `${savedEnv.NODE_OPTIONS ?? ""} --import=${preload}`;
      process.env.PI_TEST_RUNNER_CLOCK = clockFile;
      resultPromise = executor
        .execute({
          toolCallId: "parallel-extend",
          params: {
            tasks: [
              { agent: "slow", task: "Need more time" },
              { agent: "second", task: "Starts after extension" },
            ],
            concurrency: 1,
            timeoutMs: 250,
          },
          signal: new AbortController().signal,
          ctx: makeMinimalCtx(tempDir),
        })
        .then((value) => {
          result = value;
          return value;
        });
      await waitFor(() => {
        const current = status();
        runnerPid = current?.pid ?? runnerPid;
        return (
          current?.runtimeVersion === 2 &&
          current.state === "running" &&
          current.timeoutAt !== undefined &&
          current.timeoutAt !== 0 &&
          mockPi.callCount() === 1
        );
      }, "actual owner deadline and first child are ready");
      const initial = status();
      assertDefined(initial);
      const initialTimeout = initial.timeoutAt;
      const initialStart = initial.startedAt;
      assertDefined(initialTimeout);
      assertDefined(initialStart);
      assert.equal(initialTimeout - initialStart, 250);
      const extension = await executor.execute({
        toolCallId: "parallel-extend-control",
        params: { action: "extend", id: runId, extendMs: 1500 },
        signal: new AbortController().signal,
        ctx: makeMinimalCtx(tempDir),
      });
      assert.equal(extension.isError, undefined, JSON.stringify(extension));
      assert.match(textAt(extension.content), /Requested 1500ms more for run/);
      await tick(100);
      await waitFor(
        () =>
          status()?.timeoutAt === initialTimeout + 1500 &&
          (readEvidence("events.jsonl") ?? "")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => record(parseJson(line)))
            .some(
              (event) =>
                event.type === "subagent.run.extended" &&
                event.runId === runId &&
                event.timeoutAt === initialTimeout + 1500,
            ),
        "owner applies the requested extension",
      );
      assert.equal(
        await tick(350),
        initialStart + 450,
        "owner crosses the original 250ms deadline",
      );
      assert.equal(status()?.state, "running");
      assert.equal(status()?.timedOut, undefined);
      assert.equal(mockPi.callCount(), 1, "queued second child has not started");
      fs.writeFileSync(release, "go");
      await waitFor(
        () => result !== undefined,
        "parallel result settles after both real child exits",
      );
      await resultPromise;
      assertDefined(result);
      assert.equal(result.isError, undefined, JSON.stringify(result));
      assertDefined(result);
      assert.equal(result.details.results.length, 2);
      assertDefined(result);
      for (const child of result.details.results) {
        assert.equal(child.exitCode, 0);
        assert.equal(child.agentProcessExit?.code, 0, "actual child process exited successfully");
      }
      assert.equal(mockPi.callCount(), 2);
      completed = true;
    } catch (error) {
      failures.push(error);
    }
    try {
      fs.writeFileSync(release, "cleanup");
      if (!completed) {
        // Switch back to native timers for cancellation if a clock assertion failed.
        clockCommand({ resume: true });
        stopOwner();
      }
      await waitFor(
        () => !alive(launcherPid === undefined ? undefined : -launcherPid) && !alive(runnerPid),
        "owned launcher group and runner exit before fixture teardown",
      );
      await waitFor(() => result !== undefined, "foreground wait settles after owner exit");
      await resultPromise;
    } catch (error) {
      failures.push(error);
    } finally {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
    if (failures.length > 0) {
      t.diagnostic(JSON.stringify({ cleanupFailures: failures.slice(1) }));
      throw new Error(
        `Parallel extension failed: ${JSON.stringify({
          result,
          status: readEvidence("status.json"),
          events: readEvidence("events.jsonl"),
          runnerErrors: readEvidence("runner-error.log"),
        })}`,
        { cause: failures[0] },
      );
    }
  });

  it("keeps a detached child's worktree until that child exits", async () => {
    initGitRepo(tempDir);
    const release = path.join(tempDir, "release-child");
    mockPi.onCall({
      steps: [
        {
          jsonl: [
            events.toolStart("contact_supervisor", {
              reason: "need_decision",
              message: "Need input",
            }),
          ],
        },
        { waitForFile: release, jsonl: [events.assistantMessage("finished in worktree")] },
      ],
    });
    const bus = createEventBus();
    const executor = createSubagentExecutor({
      pi: {
        events: bus,
        getSessionName: () => {
          /* The fixture does not need getSessionName side effects. */
        },
      },
      state: {
        ...createSubagentState(tempDir),
        baseCwd: tempDir,
        currentSessionId: null,
        asyncJobs: new Map(),
      },
      config: {},
      asyncByDefault: false,
      tempArtifactsDir: tempDir,
      getSubagentSessionRoot: () => tempDir,
      expandTilde: (value: string) => value,
      discoverAgents: () => ({ agents: [makeAgent("worker")] }),
    });
    let detached = false;

    const result = await executor.execute({
      toolCallId: "detached-worktree",
      params: { tasks: [{ agent: "worker", task: "Wait for input" }], worktree: true },
      signal: new AbortController().signal,
      onUpdate: (update) => {
        if (
          detached ||
          !(
            update.details.progress?.some((entry) => entry.currentTool === "contact_supervisor") ===
            true
          )
        ) {
          return;
        }
        detached = true;
        bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "detached-worktree" });
      },
      ctx: makeMinimalCtx(tempDir),
    });
    assert.match(textAt(result.content), /Released the wait for an incoming Intercom message/i);
    const callFile = fs.readdirSync(mockPi.dir).find((name) => name.startsWith("call-"));
    assert.ok(Boolean(callFile));
    assertDefined(callFile);
    const worktreeCwd = readChildCall(path.join(mockPi.dir, callFile)).cwd;
    assert.notEqual(worktreeCwd, tempDir);
    assert.equal(
      fs.existsSync(worktreeCwd),
      true,
      "worktree must remain while the detached child is active",
    );
    fs.writeFileSync(
      path.join(worktreeCwd, "tracked.txt"),
      "edit after top-level detachment\n",
      "utf-8",
    );
    fs.writeFileSync(release, "");
    const deadline = Date.now() + 5_000;
    while (fs.existsSync(worktreeCwd) && Date.now() < deadline) {
      // Observe the owner publication before advancing this lifecycle transition.
      // oxlint-disable-next-line no-await-in-loop
      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });
    }
    assert.equal(
      fs.existsSync(worktreeCwd),
      false,
      "worktree should be cleaned after detached completion",
    );
    assertDefined(result.details.wait);
    const patch = fs.readFileSync(
      path.join(
        getRunMetadataDir(result.details.wait.runId),
        "worktree-diffs",
        "step-0",
        "task-0-worker.patch",
      ),
      "utf-8",
    );
    assert.match(patch, /edit after top-level detachment/);
  });

  it("top-level foreground parallel timeout preserves worktrees when diff capture setup fails", async () => {
    initGitRepo(tempDir);
    const sessionRoot = createTempDir();
    const sessionFile = path.join(sessionRoot, "session.jsonl");
    fs.writeFileSync(sessionFile, "", "utf-8");
    const artifactsDir = path.join(sessionRoot, "subagent-artifacts");
    fs.mkdirSync(artifactsDir, { recursive: true });
    const eventBus = createEventBus();
    eventBus.on(SUBAGENT_ASYNC_STARTED_EVENT, (event) => {
      const started = parseAsyncStartedEvent(event);
      assert.ok(
        started.asyncDir !== undefined && started.asyncDir.length > 0,
        "owner must publish its artifact directory",
      );
      assertDefined(started.asyncDir);
      fs.writeFileSync(path.join(started.asyncDir, "worktree-diffs"), "not a directory\n", "utf-8");
    });
    mockPi.onCall({ output: "Fast result" });
    mockPi.onCall({ delay: 10000 });
    const executor = makeExecutor([makeAgent("fast"), makeAgent("slow")], artifactsDir, eventBus);
    let preservedWorktree = "";
    let preservedBranch = "";
    try {
      const ctx = makeMinimalCtx(tempDir);
      ctx.sessionManager.getSessionFile = () => sessionFile;
      const result = await executor.execute({
        toolCallId: "parallel-timeout-worktree-diff-failure",
        params: {
          tasks: [
            { agent: "fast", task: "Finish quickly" },
            { agent: "slow", task: "Run too long" },
          ],
          concurrency: 1,
          timeoutMs: 1500,
          worktree: true,
        },
        signal: new AbortController().signal,
        ctx: ctx,
      });

      const text = textAt(result.content);
      assert.equal(result.isError, true);
      assert.match(text, /Parallel run timed out/);
      assert.match(text, /Diff capture failed:/);
      assert.match(text, /Preserved worktree:/);
      preservedWorktree = text.match(/Preserved worktree: (.+)/)?.[1]?.trim() ?? "";
      preservedBranch = text.match(/Preserved branch: (.+)/)?.[1]?.trim() ?? "";
      assert.ok(Boolean(preservedWorktree), "expected preserved worktree path in result text");
      assert.ok(Boolean(preservedBranch), "expected preserved branch in result text");
      assert.equal(fs.existsSync(preservedWorktree), true, "worktree should remain for recovery");
    } finally {
      if (Boolean(preservedWorktree) && Boolean(preservedBranch)) {
        removePreservedWorktree(tempDir, preservedWorktree, preservedBranch);
      }
      removeTempDir(sessionRoot);
    }
  });

  it("top-level parallel explicit output paths persist in the workspace", async () => {
    mockPi.onCall({ output: "Saved report" });
    const executor = makeExecutor();

    const result = await executor.execute({
      toolCallId: "parallel-output",
      params: { tasks: [{ agent: "echo", task: "Write report", output: "parallel-output.md" }] },
      signal: new AbortController().signal,
      ctx: makeMinimalCtx(tempDir),
    });

    const outputPath = path.join(tempDir, "parallel-output.md");
    assert.equal(result.isError, undefined);
    assert.equal(fs.readFileSync(outputPath, "utf-8"), "Saved report");
    assert.equal(result.details.results[0].savedOutputPath, outputPath);
    assert.equal(result.details.results[0].outputCleanup, undefined);
    assert.match(result.details.results[0].finalOutput ?? "", /Saved report/);
  });

  it("top-level parallel tasks support outputSchema", async () => {
    mockPi.onCall({
      output: "structured report",
      structuredOutput: { summary: "ok", counts: { files: 1 }, files_to_edit: [] },
    });
    const executor = makeExecutor();

    const result = await executor.execute({
      toolCallId: "parallel-output-schema",
      params: {
        tasks: [
          {
            agent: "echo",
            task: "Return structured",
            outputSchema: {
              type: "object",
              properties: {
                summary: { type: "string" },
                counts: { type: "object" },
                files_to_edit: { type: "array" },
              },
              required: ["summary", "counts", "files_to_edit"],
            },
          },
        ],
      },
      signal: new AbortController().signal,
      ctx: makeMinimalCtx(tempDir),
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(result.details.results[0].structuredOutput, {
      summary: "ok",
      counts: { files: 1 },
      files_to_edit: [],
    });
  });

  it("top-level parallel file-only output aggregates concise file references", async () => {
    mockPi.onCall({ output: "Parallel full report\nwith details" });
    const executor = makeExecutor();

    const result = await executor.execute({
      toolCallId: "parallel-file-only-output",
      params: {
        tasks: [
          {
            agent: "echo",
            task: "Write report",
            output: "parallel-file-only.md",
            outputMode: "file-only",
          },
        ],
      },
      signal: new AbortController().signal,
      ctx: makeMinimalCtx(tempDir),
    });

    const outputPath = path.join(tempDir, "parallel-file-only.md");
    const text = textAt(result.content);
    assert.equal(result.isError, undefined);
    assert.match(text, /Output saved to:/);
    assert.match(text, /2 lines/);
    assert.doesNotMatch(text, /Parallel full report/);
    assert.match(result.details.results[0].finalOutput ?? "", /Output saved to:/);
    assert.doesNotMatch(result.details.results[0].finalOutput ?? "", /Parallel full report/);
    assert.equal(fs.readFileSync(outputPath, "utf-8"), "Parallel full report\nwith details");
  });

  for (const outputMode of ["inline", "file-only"] as const) {
    it(`preserves ignored worktree reports without debug artifacts (${outputMode})`, async () => {
      fs.writeFileSync(path.join(tempDir, ".gitignore"), ".scratchpad/\n");
      initGitRepo(tempDir);
      const release = path.join(tempDir, "release");
      mockPi.onCall({ waitForFile: release, output: "Report written." });
      const pending = makeExecutor().execute({
        toolCallId: "worktree-report",
        params: {
          tasks: [
            {
              agent: "echo",
              task: "Write the requested report",
              output: ".scratchpad/report.md",
              outputMode,
            },
          ],
          worktree: true,
          artifacts: false,
          async: false,
        },
        signal: new AbortController().signal,
        ctx: makeMinimalCtx(tempDir),
      });
      let callFile: string | undefined;
      const deadline = Date.now() + 10_000;
      while (
        !(
          ((callFile = fs.readdirSync(mockPi.dir).find((name) => name.startsWith("call-"))) ?? "")
            .length > 0
        )
      ) {
        assert.ok(Date.now() < deadline, "worktree child starts");
        // Observe the owner publication before advancing this lifecycle transition.
        // oxlint-disable-next-line no-await-in-loop
        await new Promise((resolve) => {
          setTimeout(resolve, 25);
        });
      }
      assertDefined(callFile);
      const childCwd = readChildCall(path.join(mockPi.dir, callFile)).cwd;
      const report = "ONLY_COPY_OF_THE_REQUESTED_REPORT\n";
      const outputPath = path.join(childCwd, ".scratchpad/report.md");
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, report);
      fs.writeFileSync(release, "go");
      const result = await pending;
      const child = result.details.results[0];
      assert.equal(child.exitCode, 0);
      assert.equal(fs.existsSync(childCwd), false, "successful worktree cleanup still runs");
      assert.ok(Boolean(child.savedOutputPath));
      assertDefined(child.savedOutputPath);
      assert.equal(fs.readFileSync(child.savedOutputPath, "utf8"), report);
      assert.equal(child.outputReference?.path, child.savedOutputPath);
      assert.equal(child.artifactPaths, undefined);
      if (outputMode === "file-only") {
        assertDefined(child.finalOutput);
        assertDefined(child.savedOutputPath);
        assert.ok(child.finalOutput.includes(child.savedOutputPath));
        assertDefined(child.savedOutputPath);
        assert.ok(textAt(result.content).includes(child.savedOutputPath));
      }
    });
  }

  it("rejects top-level parallel file-only output without an output path", async () => {
    const executor = makeExecutor();

    const result = await executor.execute({
      toolCallId: "parallel-file-only-missing-output",
      params: { tasks: [{ agent: "echo", task: "Write report", outputMode: "file-only" }] },
      signal: new AbortController().signal,
      ctx: makeMinimalCtx(tempDir),
    });

    assert.equal(result.isError, true);
    assert.match(textAt(result.content), /outputMode: "file-only"/);
    assert.equal(mockPi.callCount(), 0);
  });

  it("rejects wrong-mode worktree and ignored chain fields before launch", async () => {
    const executor = makeExecutor([makeAgent("worker")]);
    const signal = new AbortController().signal;
    const ctx = makeMinimalCtx(tempDir);
    const single = await executor.execute({
      toolCallId: "wrong-mode-single-worktree",
      params: { agent: "worker", task: "work", worktree: true },
      signal: signal,
      ctx: ctx,
    });
    const chain = await executor.execute({
      toolCallId: "wrong-mode-chain-worktree",
      params: { chain: [{ agent: "worker", task: "work" }], worktree: true },
      signal: signal,
      ctx: ctx,
    });
    const flattened = await executor.execute({
      toolCallId: "ignored-parallel-field",
      params: { chain: [{ parallel: [{ agent: "worker", task: "work" }], output: "ignored.md" }] },
      signal: signal,
      ctx: ctx,
    });
    const emptyTask = await executor.execute({
      toolCallId: "empty-parallel-task",
      params: { tasks: [{ agent: "worker", task: "" }] },
      signal: signal,
      ctx: ctx,
    });

    assert.match(textAt(single.content), /worktree.*tasks parallel mode/i);
    assert.match(textAt(chain.content), /worktree.*tasks parallel mode/i);
    assert.match(textAt(flattened.content), /fields are not supported.*output/i);
    assert.match(textAt(emptyTask.content), /task must be a non-empty string/i);
    assert.equal(mockPi.callCount(), 0);
  });

  it("rejects duplicate top-level parallel output paths", async () => {
    const executor = makeExecutor();

    const result = await executor.execute({
      toolCallId: "parallel-duplicate-output",
      params: {
        tasks: [
          { agent: "echo", task: "Write A", output: "same.md" },
          { agent: "echo", task: "Write B", output: "same.md" },
        ],
      },
      signal: new AbortController().signal,
      ctx: makeMinimalCtx(tempDir),
    });

    assert.equal(result.isError, true);
    assert.match(textAt(result.content), /same path/);
    assert.equal(mockPi.callCount(), 0);
  });

  it("materializes duplicate agent-default parallel outputs to unique artifact paths", async () => {
    mockPi.onCall({ output: "Report A" });
    mockPi.onCall({ output: "Report B" });
    const artifactsDir = path.join(tempDir, "artifacts");
    const executor = makeExecutor([makeAgent("scout", { output: "context.md" })], artifactsDir);

    const result = await executor.execute({
      toolCallId: "parallel-default-output-artifacts",
      params: {
        tasks: [
          { agent: "scout", task: "Write A" },
          { agent: "scout", task: "Write B" },
        ],
        concurrency: 2,
      },
      signal: new AbortController().signal,
      ctx: makeMinimalCtx(tempDir),
    });

    const details = result.details;
    const paths = details.results
      .map((child) => child.outputReference?.path)
      .filter((value): value is string => value !== undefined && value.length > 0);
    assert.equal(result.isError, undefined);
    assert.equal(mockPi.callCount(), 2);
    assert.equal(fs.existsSync(path.join(tempDir, "context.md")), false);
    assert.equal(paths.length, 2);
    assert.notEqual(paths[0], paths[1]);
    assert.ok(paths.every((p: string) => p.includes(`${path.sep}requested-outputs${path.sep}`)));
    assert.ok(paths.some((p: string) => /[a-f0-9]{8}_scout_0_context\.md$/.test(p)));
    assert.ok(paths.some((p: string) => /[a-f0-9]{8}_scout_1_context\.md$/.test(p)));
    assert.ok(details.results.every((child) => child.outputCleanup?.action === "deleted"));
  });

  it("treats string false as disabled output in top-level parallel runs", async () => {
    mockPi.onCall({ output: "Review done" });
    const executor = makeExecutor();

    const result = await executor.execute({
      toolCallId: "parallel-string-false-output",
      params: {
        tasks: [
          { agent: "echo", task: "Review A", output: "false" },
          { agent: "echo", task: "Review B", output: "false" },
        ],
      },
      signal: new AbortController().signal,
      ctx: makeMinimalCtx(tempDir),
    });

    assert.equal(result.isError, undefined);
    assert.equal(mockPi.callCount(), 2);
    assert.equal(fs.existsSync(path.join(tempDir, "false")), false);
  });

  it("top-level parallel reads are injected once with chain-style prefix", async () => {
    mockPi.onCall({ output: "Read done" });
    const executor = makeExecutor();

    await executor.execute({
      toolCallId: "parallel-reads",
      params: { tasks: [{ agent: "echo", task: "Inspect", reads: ["a.md", "b.md"] }] },
      signal: new AbortController().signal,
      ctx: makeMinimalCtx(tempDir),
    });

    const args = readLastCallArgs();
    const taskArg = args.at(-1) ?? "";
    assert.ok(
      taskArg.startsWith(`Task: [Read from: ${path.join(tempDir, "a.md")}, ${path.join(tempDir, "b.md")}]

Inspect`),
    );
    assert.doesNotMatch(taskArg, /## Acceptance Contract/);
  });

  it("top-level parallel progress emits the existing progress instruction style", async () => {
    mockPi.onCall({ output: "Progress done" });
    const executor = makeExecutor();

    await executor.execute({
      toolCallId: "parallel-progress",
      params: { tasks: [{ agent: "echo", task: "Track work", progress: true }] },
      signal: new AbortController().signal,
      ctx: makeMinimalCtx(tempDir),
    });

    const args = readLastCallArgs();
    assert.ok(
      (args.at(-1) ?? "").includes(`Update progress at: ${path.join(tempDir, "progress.md")}`),
    );
    assert.equal(fs.existsSync(path.join(tempDir, "progress.md")), true);
  });

  it("top-level parallel suppresses progress when the task is review-only", async () => {
    mockPi.onCall({ output: "Review done" });
    const executor = makeExecutor([makeAgent("reviewer", { defaultProgress: true })]);

    await executor.execute({
      toolCallId: "parallel-read-only-progress",
      params: {
        tasks: [{ agent: "reviewer", task: "Review-only. Do not edit files. Return findings." }],
      },
      signal: new AbortController().signal,
      ctx: makeMinimalCtx(tempDir),
    });

    const taskArg = readLastCallArgs().at(-1) ?? "";
    assert.doesNotMatch(taskArg, /progress\.md/);
    assert.equal(fs.existsSync(path.join(tempDir, "progress.md")), false);
  });
});
