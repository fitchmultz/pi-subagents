import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { test as nodeTest } from "node:test";
import {
  isChildProcessReplaced,
  observeChildProcessReplaced,
  readChildProcessIdentity,
} from "../../src/shared/post-exit-stdio-guard.ts";

nodeTest(
  "macOS process birth and replacement proof do not depend on PATH",
  {
    skip: process.platform !== "darwin",
  },
  async () => {
    const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
    });
    await once(child, "spawn");
    const exited = once(child, "exit");
    const previousPath = process.env.PATH;
    try {
      assert.ok(child.pid !== undefined);
      const expected = execFileSync(
        "/bin/ps",
        ["-p", String(child.pid), "-o", "lstart=", "-o", "pgid="],
        {
          encoding: "utf8",
          env: { ...process.env, LC_ALL: "C" },
        },
      )
        .trim()
        .replace(/\s+/g, " ");
      assert.match(expected, new RegExp(` ${child.pid}$`));
      const earlier = expected.replace(/\d{4} (\d+)$/, "2000 $1");
      assert.notEqual(earlier, expected);
      process.env.PATH = "/dev/null";
      assert.equal(readChildProcessIdentity(child.pid), expected);
      assert.equal(isChildProcessReplaced(child.pid, earlier, 0), true);
      assert.equal(await observeChildProcessReplaced(child.pid, expected, 0), false);
      assert.equal(await observeChildProcessReplaced(child.pid, earlier, 0), true);
    } finally {
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
      child.stdin.end();
      await exited;
    }
  },
);
