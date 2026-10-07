import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { interruptAsyncRun } from "../../src/runs/foreground/foreground-control.ts";
import { ownedRunView } from "../../src/runs/shared/run-records.ts";
import {
  getRunMetadataDir,
  readQuestionContract,
  saveQuestionContract,
} from "../../src/runs/shared/supervisor-questions.ts";
import { readStatus } from "../../src/shared/utils.ts";
import { createEventBus, createTempDir, makeAgent, makeMinimalCtx } from "../support/helpers.ts";
import { assertDefined } from "../support/assertions.ts";
import { createSubagentState, toolText } from "../support/background-fixtures.ts";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(check: () => boolean, message: string) {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, message);
    // Each readiness probe must follow the previous polling delay.
    // oxlint-disable-next-line no-await-in-loop
    await delay(20);
  }
}

function killOwnedProcess(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
    return;
  } catch (error) {
    assert.ok(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    assert.ok(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

for (const scenario of ["whole run", "selected child", "mismatched identity"] as const) {
  test(`Stop after runner crash: ${scenario}`, { timeout: 25_000 }, async (t) => {
    const cwd = createTempDir("orphan-stop-");
    const bin = path.join(cwd, "bin");
    fs.mkdirSync(bin);
    const ticker = path.join(cwd, "ticker.mjs");
    fs.writeFileSync(
      ticker,
      `import fs from 'node:fs'; import { spawn } from 'node:child_process';
const heartbeat = ${JSON.stringify(cwd)} + '/heartbeat-' + process.pid;
process.title = 'pi';
process.on('SIGTERM', () => {});
if (!process.argv.includes('--descendant')) {
 const child = spawn(process.execPath, [${JSON.stringify(ticker)}, '--descendant'], { stdio: 'ignore' });
 fs.writeFileSync(${JSON.stringify(cwd)} + '/descendant-' + process.pid, String(child.pid));
 console.log(JSON.stringify({ type: 'tool_execution_start', toolName: 'bash', args: { command: 'scratch heartbeat' } }));
}
setInterval(() => fs.appendFileSync(heartbeat, 'tick\\n'), 30);
`,
    );
    fs.writeFileSync(
      path.join(bin, "pi"),
      `#!/bin/sh\nunset NODE_OPTIONS\nexec '${process.execPath}' '${ticker}' "$@"\n`,
      { mode: 0o755 },
    );
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
    const state = createSubagentState(cwd);
    const executor = createSubagentExecutor({
      pi: { events: createEventBus(), getSessionName: () => "orphan-parent" },
      state,
      config: {},
      asyncByDefault: false,
      tempArtifactsDir: path.join(cwd, "artifacts"),
      getSubagentSessionRoot: () => path.join(cwd, "sessions"),
      expandTilde: (value) => value,
      discoverAgents: () => ({ agents: [makeAgent("worker", { completionGuard: false })] }),
    });
    const pids: number[] = [];
    const cleanup: { runId?: string } = {};
    t.after(async () => {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      for (const pid of pids) {
        killOwnedProcess(pid);
      }
      await delay(100);
      if (cleanup.runId !== undefined) {
        fs.rmSync(getRunMetadataDir(cleanup.runId), { recursive: true, force: true });
      }
      fs.rmSync(cwd, { recursive: true, force: true });
    });
    const started = await executor.execute({
      toolCallId: "start",
      params: {
        tasks: [
          { agent: "worker", task: "Scratch heartbeat", output: false },
          { agent: "worker", task: "Scratch heartbeat", output: false },
        ],
        async: true,
      },
      ctx: makeMinimalCtx(cwd),
    });
    assert.notEqual(started.isError, true, JSON.stringify(started));
    const id = started.details.asyncId;
    const dir = started.details.asyncDir;
    const asyncPid = started.details.asyncPid;
    assertDefined(id);
    assertDefined(dir);
    assertDefined(asyncPid);
    cleanup.runId = id;
    pids.push(asyncPid);
    await until(
      () =>
        readQuestionContract(id, 0)?.pid !== undefined &&
        readQuestionContract(id, 1)?.pid !== undefined,
      "children must start",
    );
    const children = [0, 1].map((index) => {
      const pid = readQuestionContract(id, index)?.pid;
      assertDefined(pid);
      return pid;
    });
    pids.push(...children);
    await until(
      () => children.every((pid) => fs.existsSync(path.join(cwd, `descendant-${pid}`))),
      "descendants must start",
    );
    const descendants = children.map((pid) =>
      Number(fs.readFileSync(path.join(cwd, `descendant-${pid}`), "utf8")),
    );
    pids.push(...descendants);
    await until(
      () =>
        [...children, ...descendants].every((pid) =>
          fs.existsSync(path.join(cwd, `heartbeat-${pid}`)),
        ),
      "heartbeats must start",
    );
    const runnerPid = readStatus(dir)?.pid;
    assertDefined(runnerPid);
    pids.push(runnerPid);
    process.kill(runnerPid, "SIGKILL");
    await until(() => !alive(runnerPid), "runner must exit");
    const heartbeat = path.join(cwd, `heartbeat-${children[0]}`);
    const before = fs.statSync(heartbeat).size;
    await until(
      () => fs.statSync(heartbeat).size > before,
      "child must still execute after the runner dies",
    );
    assertDefined(state.ownedRuns);
    const owned = state.ownedRuns.get(id);
    assertDefined(owned);
    assert.equal(
      ownedRunView(owned, state).canInterrupt,
      true,
      "Stop must remain available for live orphaned children",
    );
    if (scenario === "mismatched identity") {
      saveQuestionContract(id, 1, { processIdentity: "different process birth" });
    }
    const receipt = interruptAsyncRun(state, id, scenario === "selected child" ? 0 : undefined);
    assertDefined(receipt);
    if (scenario === "mismatched identity") {
      assert.equal(receipt.isError, true, "unverified PID ownership must reject Stop");
      assert.match(toolText(receipt.content), /ownership|session/i);
      assert.ok(children.every(alive), "unrelated process and sibling must survive");
      return;
    }
    assert.notEqual(receipt.isError, true, JSON.stringify(receipt));
    assert.match(toolText(receipt.content), /exit are not yet confirmed/);
    const stoppedStep = readStatus(dir)?.steps?.[0];
    assertDefined(stoppedStep);
    assert.equal(
      stoppedStep.agentProcessExit,
      undefined,
      "Stop must not fabricate an exit receipt",
    );
    const stopped =
      scenario === "whole run" ? [...children, ...descendants] : [children[0], descendants[0]];
    await until(() => stopped.every((pid) => !alive(pid)), "orphaned child and commands must stop");
    const stoppedSize = fs.statSync(heartbeat).size;
    await delay(100);
    assert.equal(fs.statSync(heartbeat).size, stoppedSize, "stopped child must stop writing");
    if (scenario === "selected child") {
      assert.ok(
        alive(children[1]) && alive(descendants[1]),
        "selected Stop must preserve sibling and its commands",
      );
      const wholeRunStop = interruptAsyncRun(state, id);
      assertDefined(wholeRunStop);
      assert.notEqual(
        wholeRunStop.isError,
        true,
        "whole-run Stop must also work after one child has exited",
      );
      await until(
        () => !alive(children[1]) && !alive(descendants[1]),
        "remaining sibling must stop",
      );
    }
    assert.equal(
      fs.existsSync(path.join(dir, "control-requests")),
      false,
      "dead runner must not receive an unread control request",
    );
  });
}
