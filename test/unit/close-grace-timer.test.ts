import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
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

nodeDescribe("child process lifecycle", () => {
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
