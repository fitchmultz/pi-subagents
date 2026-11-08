import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { describe as nodeDescribe, it as nodeIt, type TestContext } from "node:test";
import {
  attachChildProcessLifecycle,
  trySignalChildTree,
} from "../../src/shared/post-exit-stdio-guard.ts";

function makeChild() {
  return Object.assign(new ChildProcess(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => false,
  });
}

function enableTimers(t: TestContext): void {
  t.mock.timers.enable({ apis: ["setTimeout"] });
}

async function startSignalChild(t: TestContext) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `process.on("SIGTERM", () => process.send("term"));
       process.on("message", () => process.exit(0));
       process.send("ready");`,
    ],
    { detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  const lifecycle = attachChildProcessLifecycle(child);
  const closed = once(child, "close");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      trySignalChildTree(child, "SIGKILL");
    }
    await closed;
  });
  assert.deepEqual(await once(child, "message"), ["ready", undefined]);
  enableTimers(t);
  return { child, lifecycle, closed };
}

nodeDescribe("child process lifecycle", () => {
  for (const accepted of [false, true]) {
    nodeIt(
      `cancellation overrides ${accepted ? "accepted" : "pending"} settlement cleanup`,
      { skip: process.platform === "win32", timeout: 10_000 },
      async (t) => {
        const { child, lifecycle, closed } = await startSignalChild(t);
        const terminated = once(child, "message");
        lifecycle.observeEvent("agent_settled");
        t.mock.timers.tick(accepted ? 1000 : 999);
        assert.equal(lifecycle.settledCleanup, accepted);
        if (accepted) {
          assert.deepEqual(await terminated, ["term", undefined]);
        }

        lifecycle.terminate();
        assert.equal(lifecycle.stopping, true);
        assert.equal(lifecycle.settledCleanup, false);
        if (!accepted) {
          assert.deepEqual(await terminated, ["term", undefined]);
        }
        lifecycle.observeEvent("agent_start");
        lifecycle.observeEvent("agent_settled");
        t.mock.timers.tick(1000);
        assert.equal(lifecycle.settledCleanup, false);
        child.send("exit");
        await closed;
        assert.equal(lifecycle.stopping, true);
        lifecycle.terminate();
        assert.equal(lifecycle.settledCleanup, false);
      },
    );
  }

  nodeIt(
    "a spawn error closes cleanup without leader exit and cannot rearm",
    { timeout: 10_000 },
    async (t) => {
      const child = spawn(`${process.execPath}-missing`, [], { stdio: "pipe" });
      const lifecycle = attachChildProcessLifecycle(child);
      const failed = once(child, "error");
      const closed = new Promise<void>((resolve) => {
        child.once("close", () => resolve());
      });
      await failed;
      await closed;
      assert.equal(lifecycle.agentProcessExit, undefined);
      enableTimers(t);
      lifecycle.observeEvent("agent_start");
      lifecycle.observeEvent("agent_settled");
      t.mock.timers.tick(8000);
      lifecycle.terminate();
      assert.equal(lifecycle.stopping, false);
      assert.equal(lifecycle.settledCleanup, false);
    },
  );

  nodeIt(
    "activity cancels settlement delay; leader exit and close cannot rearm it",
    { skip: process.platform === "win32", timeout: 10_000 },
    async (t) => {
      const { child, lifecycle, closed } = await startSignalChild(t);
      lifecycle.observeEvent("agent_settled");
      t.mock.timers.tick(999);
      lifecycle.observeEvent("message_start");
      t.mock.timers.tick(1000);
      assert.equal(lifecycle.stopping, false);
      assert.equal(lifecycle.settledCleanup, false);
      assert.equal(child.kill(0), true);

      const exited = once(child, "exit");
      child.once("exit", () => {
        const exit = lifecycle.agentProcessExit;
        assert.ok(exit !== undefined);
        assert.equal(exit.pid, child.pid);
        assert.equal(exit.code, 0);
        assert.equal(exit.signal, null);
        lifecycle.observeEvent("agent_settled");
        t.mock.timers.tick(1000);
        assert.equal(lifecycle.stopping, false);
      });
      child.send("exit");
      await exited;
      await closed;
      lifecycle.observeEvent("agent_start");
      lifecycle.observeEvent("agent_settled");
      t.mock.timers.tick(8000);
      assert.equal(lifecycle.stopping, false);
      assert.equal(lifecycle.settledCleanup, false);
      assert.equal(lifecycle.agentProcessExit?.code, 0);
    },
  );

  nodeIt("reports whether a termination signal was actually delivered", () => {
    assert.equal(trySignalChildTree({ kill: () => true }, "SIGTERM"), true);
    assert.equal(trySignalChildTree({ kill: () => false }, "SIGTERM"), false);
    assert.equal(
      trySignalChildTree(
        {
          kill: () => {
            throw new Error("gone");
          },
        },
        "SIGTERM",
      ),
      false,
    );
  });

  nodeIt("falls back to signaling the child when no process group exists", () => {
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    assert.equal(
      trySignalChildTree(
        {
          pid: 2_147_483_647,
          kill: (signal) => {
            signals.push(signal);
            return true;
          },
        },
        "SIGTERM",
      ),
      true,
    );
    assert.deepEqual(signals, ["SIGTERM"]);
  });

  nodeIt("cancels cleanup after a clean close", (t) => {
    enableTimers(t);
    const child = makeChild();
    attachChildProcessLifecycle(child);

    child.emit("exit", 0, null);
    child.emit("close", 0, null);
    t.mock.timers.tick(8000);

    assert.equal(child.stdout.destroyed, false);
    assert.equal(child.stderr.destroyed, false);
  });

  nodeIt("destroys silent stdio at the idle deadline", (t) => {
    enableTimers(t);
    const child = makeChild();
    attachChildProcessLifecycle(child);

    child.emit("exit", 0, null);
    t.mock.timers.tick(1999);
    assert.equal(child.stdout.destroyed, false);
    assert.equal(child.stderr.destroyed, false);

    t.mock.timers.tick(1);
    assert.equal(child.stdout.destroyed, true);
    assert.equal(child.stderr.destroyed, true);
  });

  nodeIt("destroys chatty stdio at the hard deadline", (t) => {
    enableTimers(t);
    const child = makeChild();
    attachChildProcessLifecycle(child);

    child.emit("exit", 0, null);
    for (let tick = 0; tick < 5; tick++) {
      t.mock.timers.tick(1500);
      child.stdout.emit("data", Buffer.from("tick"));
    }
    t.mock.timers.tick(499);
    assert.equal(child.stdout.destroyed, false);
    assert.equal(child.stderr.destroyed, false);

    t.mock.timers.tick(1);
    assert.equal(child.stdout.destroyed, true);
    assert.equal(child.stderr.destroyed, true);
  });
});
