import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { ensureActor, ownIdentity, shells, signalProcess } from "../../src/agent/process.ts";
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
