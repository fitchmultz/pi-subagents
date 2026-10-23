import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { read, runDirectory, write } from "../../src/agent/storage.ts";
import { Type } from "../../src/agent/typebox.ts";
import { observeReads } from "../support/runtime-fs.ts";

it("native agent storage creates private files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-atomic-json-"));
  try {
    const file = path.join(dir, "status.json");
    write(file, { ok: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf-8")), { ok: true });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("exclusive records remain complete and cannot be replaced when hard links are denied", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-atomic-exclusive-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  t.mock.method(fs, "linkSync", () => {
    throw Object.assign(new Error("Hard links are denied"), { code: "EACCES" });
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const file = path.join(dir, "launch.json");
  const value = { prompt: "雪🦄".repeat(20_000) };
  write(file, value, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), value);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const publishedFiles = fs.readdirSync(dir).sort();
  assert.throws(() => write(file, { prompt: "loser" }, true), { code: "EEXIST" });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), value);
  assert.deepEqual(
    fs.readdirSync(dir).sort(),
    publishedFiles,
    "failed publication leaves no orphan files",
  );
});

it("exclusive record failures do not publish data or hide unrelated filesystem errors", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-atomic-failure-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const failure = Object.assign(new Error("I/O failure"), { code: "EIO" });
  t.mock.method(fs, "linkSync", () => {
    throw failure;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  assert.throws(() => write(path.join(dir, "launch.json"), { prompt: "lost" }, true), failure);
  assert.deepEqual(fs.readdirSync(dir), []);
});

function writer(file: string, id: number, gate?: string) {
  const fixture = fileURLToPath(new URL("../fixtures/atomic-record-writer.mjs", import.meta.url));
  const child = spawn(process.execPath, [fixture, file, String(id), ...(gate ? [gate] : [])], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  return {
    child,
    ready: once(child, "message").then(([message]: readonly unknown[]) => message),
    exit: once(child, "exit"),
  };
}

it(
  "exclusive fallback admits one complete winner across independent writer processes",
  { timeout: 15_000 },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-atomic-race-"));
    const file = path.join(dir, "launch.json");
    const writers = Array.from({ length: 4 }, (_, id) => writer(file, id));
    t.after(async () => {
      writers.forEach(({ child }) => child.kill("SIGKILL"));
      await Promise.all(writers.map(({ exit }) => exit));
      fs.rmSync(dir, { recursive: true, force: true });
    });
    assert.deepEqual(await Promise.all(writers.map(({ ready }) => ready)), [
      "ready",
      "ready",
      "ready",
      "ready",
    ]);
    const outcomes = writers.map(({ child }) => once(child, "message"));
    writers.forEach(({ child }) => child.send("publish"));
    const results = await Promise.all(outcomes);
    const winner = results.findIndex(([status]) => status === "published");
    assert.notEqual(winner, -1);
    assert.deepEqual(results.map(([status]) => status).sort(), [
      "exists",
      "exists",
      "exists",
      "published",
    ]);
    for (const { exit } of writers) {
      // The published backing must remain readable after every producer exits.
      // oxlint-disable-next-line no-await-in-loop
      assert.deepEqual(await exit, [0, null]);
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
      winner,
      body: "P".repeat(200_000),
    });
  },
);

it(
  "a writer killed after fsync cannot expose or reserve an unpublished exclusive record",
  { timeout: 15_000 },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-atomic-crash-"));
    const file = path.join(dir, "launch.json");
    const gate = path.join(dir, "publication");
    const { child, ready, exit } = writer(file, 0, gate);
    t.after(async () => {
      child.kill("SIGKILL");
      await exit;
      fs.rmSync(dir, { recursive: true, force: true });
    });
    assert.equal(await ready, "ready");
    child.send("publish");
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(`${gate}.ready`)) {
      assert.ok(Date.now() < deadline && child.exitCode === null, "writer reaches actual fsync");
      // The real fsync publication establishes the owner processed its input before this check.
      // oxlint-disable-next-line no-await-in-loop
      await delay(10);
    }
    assert.equal(fs.existsSync(file), false);
    child.kill("SIGKILL");
    assert.deepEqual(await exit, [null, "SIGKILL"]);
    write(file, { prompt: "recovered" }, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { prompt: "recovered" });
  },
);

it("native run paths reject traversal and separators before accessing storage", () => {
  for (const id of [
    "",
    ".",
    "..",
    "../foreign",
    "/tmp/foreign",
    "run/child",
    "run\\child",
    "a".repeat(129),
  ]) {
    assert.throws(() => runDirectory("/owned", id), /Invalid run\/session ID/);
  }
  assert.equal(runDirectory("/owned", "run_12-abc"), path.join("/owned", "run_12-abc"));
});

it("saved owner reads preserve values with snapshot-sized reads and a 64 KiB ceiling", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-owner-read-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "question-owner.json");
  const schema = Type.Object({ sessionId: Type.String() });
  const lengths: number[] = [];
  observeReads(t, ({ length }) => {
    lengths.push(length);
  });
  const owner = '{"sessionId":"owner-🦄"}';
  fs.writeFileSync(file, owner);
  assert.deepEqual(read(file, schema), { sessionId: "owner-🦄" });
  assert.deepEqual(lengths, [Buffer.byteLength(owner)]);
  lengths.length = 0;
  fs.writeFileSync(file, '{"sessionId":"owner"}'.padEnd(70_000));
  assert.deepEqual(read(file, schema), { sessionId: "owner" });
  assert.deepEqual(lengths, [65_536, 4_464]);
});
