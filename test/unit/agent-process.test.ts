import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { ensureActor, ownIdentity, signalProcess } from "../../src/agent/process.ts";
import { write } from "../../src/agent/storage.ts";
import { usageLaunch } from "../support/agent-launch.ts";

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
