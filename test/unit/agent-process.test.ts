import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import childProcess, { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  alive,
  ensureActor,
  observeAlive,
  ownIdentity,
  shells,
  signalProcess,
} from "../../src/agent/process.ts";
import { write } from "../../src/agent/storage.ts";
import { usageLaunch } from "../support/agent-launch.ts";

test("native shell inventory reads publications once and ignores unpublished backing files", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-shell-records-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  t.mock.method(fs, "linkSync", () => {
    throw Object.assign(new Error("Hard links are denied"), { code: "EACCES" });
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const launch = usageLaunch(path.join(base, "child.jsonl"));
  const identity = { pid: 12345, identity: "native-birth", token: "shell-token" };
  const file = path.join(base, "run", "shells", identity.token, "shell.json");
  write(file, identity, true);
  const inventory = () =>
    shells(base, launch, identity.token).map(({ pid, identity: birth, token }) => ({
      pid,
      identity: birth,
      token,
    }));
  assert.deepEqual(inventory(), [identity]);
  fs.writeFileSync(`${file}.abandoned.data`, '{"pid":');
  fs.writeFileSync(`${file}.abandoned.tmp`, '{"pid":');
  assert.deepEqual(inventory(), [identity]);
});

test("ambiguous actor liveness cannot reclaim its claim or authorize a stop signal", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-actor-liveness-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const launch = usageLaunch(path.join(base, "child.jsonl"));
  const identity = { ...ownIdentity(), token: "original-token" };
  const lock = path.join(base, "run", "actor.lock");
  const file = path.join(lock, "process.json");
  write(file, identity);
  const original = fs.readFileSync(file, "utf8");
  const signals: Array<string | number | undefined> = [];
  t.mock.method(process, "kill", (_pid: number, signal?: string | number) => {
    signals.push(signal);
    throw Object.assign(new Error("Permission denied"), { code: "EPERM" });
  });
  await ensureActor(base, launch);
  assert.equal(fs.readFileSync(file, "utf8"), original);
  assert.deepEqual(
    fs.readdirSync(lock),
    ["process.json"],
    "no replacement claim or process was published",
  );
  assert.throws(() => signalProcess(identity, "SIGTERM"), /liveness is ambiguous/);
  assert.deepEqual(signals, [0, 0], "only liveness probes, never termination signals");
});

test(
  "routine liveness reads births without blocking and reaches signal-time verdicts",
  { skip: process.platform === "android" && "Android replacement needs a native clock bound" },
  async (t) => {
    const sleeper = () => spawn("/bin/sleep", ["600"], { detached: true, stdio: "ignore" });
    const children = Array.from({ length: 5 }, sleeper);
    t.after(() => {
      for (const { pid } of children) {
        // A failed spawn has no PID; never signal the runner's own group.
        if (pid === undefined || pid <= 0) {
          continue;
        }
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // Already reaped.
        }
      }
    });
    await Promise.all(children.map((child) => once(child, "spawn")));
    const claims = children.map((child) => {
      assert.ok(child.pid !== undefined);
      const claim = { ...ownIdentity(child.pid), published: Date.now() };
      assert.notEqual(claim.identity, "unverified", "detached sleepers lead their groups");
      return claim;
    });
    const [first, second, third, dead, reused] = claims;
    const exited = new Promise((resolve) => {
      children[3]?.once("exit", resolve);
    });
    process.kill(-dead.pid, "SIGKILL");
    await exited;
    const earlier =
      process.platform === "linux"
        ? reused.identity.replace(/\d+$/, (ticks) => String(BigInt(ticks) + 1n))
        : reused.identity.replace(/\d{4} (\d+)$/, "2000 $1");
    const cases = [
      [first, true],
      [second, true],
      [third, true],
      [dead, false],
      // A different birth recorded before this PID's birth proves replacement.
      [{ ...reused, identity: earlier, published: 0 }, false],
      // An incomparable legacy birth stays possibly owned.
      [{ ...reused, identity: "legacy-birth" }, true],
    ] as const;
    const blocking = t.mock.method(childProcess, "execFileSync");
    const batched = t.mock.method(childProcess, "execFile");
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    const ps = (calls: ReadonlyArray<{ arguments: readonly unknown[] }>) =>
      calls.filter((call) => call.arguments[0] === "ps").length;
    const verdicts = await observeAlive(cases.map(([claim]) => claim));
    assert.deepEqual(
      verdicts,
      cases.map(([, expected]) => expected),
    );
    assert.equal(ps(blocking.mock.calls), 0, "routine observation never waits on a sync ps");
    assert.equal(
      ps(batched.mock.calls),
      process.platform === "linux" ? 0 : 5,
      "one single-PID birth read per comparable live claim, plus one UTC read for the changed birth",
    );
    assert.deepEqual(
      cases.map(([claim]) => alive(claim)),
      verdicts,
      "the synchronous owner reaches the same verdicts",
    );
  },
);
