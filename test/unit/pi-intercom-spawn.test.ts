import "../support/isolated-home.ts";
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { brokerPidRecord, isBrokerPidReused } from "../../src/pi-intercom/broker/pid.ts";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  getBrokerLaunchSpec,
  getBrokerSpawnOptions,
  stopUnhealthyBrokerBeforeSpawn,
} from "../../src/pi-intercom/broker/spawn.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("legacy PID alias to a real Linux thread cannot be a broker process", { skip: process.platform !== "linux" }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-intercom-tid-"));
  const pidPath = path.join(dir, "broker.pid");
  const worker = new Worker(`
    const { parentPort } = require("node:worker_threads");
    const status = require("node:fs").readFileSync("/proc/thread-self/status", "utf8");
    parentPort.once("message", () => parentPort.close());
    parentPort.postMessage({
      tid: Number(/^Pid:\\s+(\\d+)/m.exec(status)[1]),
      tgid: Number(/^Tgid:\\s+(\\d+)/m.exec(status)[1]),
    });
  `, { eval: true });
  try {
    const [identity] = await once(worker, "message");
    assert.equal(identity.tgid, process.pid);
    assert.notEqual(identity.tid, process.pid);
    process.kill(identity.tid, 0); // Native signal-0 succeeds for this non-process TID.
    writeFileSync(pidPath, String(identity.tid));
    await stopUnhealthyBrokerBeforeSpawn(pidPath, async () => false);
    assert.equal(readFileSync(pidPath, "utf8"), String(identity.tid));
    process.kill(identity.tid, 0); // Guard neither signals nor removes the alias.
  } finally {
    const exited = once(worker, "exit");
    worker.postMessage("normal exit");
    assert.deepEqual(await exited, [0]);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy numeric live process remains ambiguous and blocking", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-intercom-live-"));
  const pidPath = path.join(dir, "broker.pid");
  try {
    writeFileSync(pidPath, String(process.pid));
    await assert.rejects(stopUnhealthyBrokerBeforeSpawn(pidPath, async () => false), /refusing to spawn a second broker/);
    assert.equal(readFileSync(pidPath, "utf8"), String(process.pid));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("native PID identity preserves a live process and only disproves comparable identities", { skip: process.platform !== "linux" }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-intercom-identity-"));
  const pidPath = path.join(dir, "broker.pid");
  try {
    const record = brokerPidRecord();
    assert.equal(Number.parseInt(record, 10), process.pid, "legacy reader compatibility");
    const [pid, line] = record.trim().split("\n");
    const [version, boot, namespace, clock, start] = line.split(" ");
    assert.equal(version, "linux-v1");
    assert.equal(boot, readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim());
    assert.equal(namespace, fs.readlinkSync("/proc/self/ns/pid"));
    assert.equal(clock, fs.readlinkSync("/proc/self/ns/time"));
    const stat = readFileSync("/proc/self/stat", "utf8");
    assert.equal(start, stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19]);
    writeFileSync(pidPath, record);
    await assert.rejects(stopUnhealthyBrokerBeforeSpawn(pidPath, async () => false), /refusing to spawn a second broker/);
    assert.equal(readFileSync(pidPath, "utf8"), record);
    assert.equal(isBrokerPidReused(process.pid, record), false);
    // Format/decision controls against real proc metadata, not simulated procfs.
    assert.equal(isBrokerPidReused(process.pid, `${pid}\nlinux-v2 ${boot} ${namespace} ${clock} ${start}\n`), false);
    assert.equal(isBrokerPidReused(process.pid, `${pid}\nlinux-v1 broken\n`), false);
    assert.equal(isBrokerPidReused(process.pid, `${pid}\nlinux-v1 ${boot} pid:[0] ${clock} ${start}\nunknown\n`), false);
    assert.equal(isBrokerPidReused(process.pid, `${pid}\nlinux-v1 ${boot} ${namespace} ${clock} ${BigInt(start) + 1n}\n`), true);
    assert.equal(isBrokerPidReused(process.pid, `${pid}\nlinux-v1 ${boot} ${namespace} time:[0] ${BigInt(start) + 1n}\n`), false, "different clock view cannot disprove start identity");
    assert.equal(isBrokerPidReused(process.pid, `${pid}\nlinux-v1 ${boot} pid:[0] ${clock} ${start}\n`), true);
    const otherBoot = `${boot[0] === "0" ? "1" : "0"}${boot.slice(1)}`;
    assert.equal(isBrokerPidReused(process.pid, `${pid}\nlinux-v1 ${otherBoot} ${namespace} ${clock} ${start}\n`), true);
    const denied = (() => { throw Object.assign(new Error("not permitted"), { code: "EPERM" }); }) as typeof process.kill;
    writeFileSync(pidPath, `${pid}\nlinux-v1 ${otherBoot} ${namespace} ${clock} ${start}\n`);
    await assert.rejects(stopUnhealthyBrokerBeforeSpawn(pidPath, async () => false, denied), /refusing to spawn a second broker/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unreadable or mismatched procfs views cannot disprove a live PID", { skip: process.platform !== "linux" }, () => {
  // A stale-looking record still cannot override an unreadable native identity.
  const record = brokerPidRecord().replace(/(\d+)\n$/, (_match, ticks) => `${BigInt(ticks) + 1n}\n`);
  const read = fs.readFileSync;
  try {
    for (const view of ["denied", "ancestor", "missing-stat"] as const) {
      const mocked = mock.method(fs, "readFileSync", (...args: Parameters<typeof read>) => {
        if (String(args[0]) === "/proc/self/status") {
          if (view === "denied") throw Object.assign(new Error("not permitted"), { code: "EACCES" });
          if (view === "ancestor") return `NStgid:\t99999\t${process.pid}\n`;
        }
        if (view === "missing-stat" && String(args[0]).endsWith("/stat")) throw Object.assign(new Error("gone"), { code: "ENOENT" });
        return read(...args);
      });
      syncBuiltinESMExports();
      assert.equal(isBrokerPidReused(process.pid, record), false);
      assert.equal(brokerPidRecord(), `${process.pid}\n`);
      mocked.mock.restore();
    }
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("non-Linux PID records remain numeric without procfs", { skip: process.platform === "linux" }, () => {
  assert.equal(brokerPidRecord(), `${process.pid}\n`);
  assert.equal(isBrokerPidReused(process.pid, String(process.pid)), false);
});

test("bundled broker resolves the package root", () => {
  assert.equal(getBrokerSpawnOptions().cwd, projectRoot);
});

test("getBrokerLaunchSpec maps the legacy tsx default to native Node", () => {
  const spec = getBrokerLaunchSpec("/repo/broker.ts", "npx", ["--no-install", "tsx"], "/usr/bin/node");
  assert.equal(spec.command, "/usr/bin/node");
  assert.deepEqual(spec.args, ["/repo/broker.ts"]);
});

test("getBrokerLaunchSpec uses custom broker command", () => {
  const spec = getBrokerLaunchSpec("/repo/broker.ts", "bun", [], "/usr/bin/node");
  assert.equal(spec.command, "bun");
  assert.deepEqual(spec.args, ["/repo/broker.ts"]);
});

test("getBrokerSpawnOptions detaches the broker with no inherited stdio", () => {
  const options = getBrokerSpawnOptions("/repo");
  assert.equal(options.detached, true);
  assert.equal(options.stdio, "ignore");
  assert.equal(options.cwd, "/repo");
});

test("spawn guard fails loud instead of killing a live unhealthy broker PID", async () => {
  const intercomDir = mkdtempSync(path.join(tmpdir(), "pi-intercom-"));
  const pidPath = path.join(intercomDir, "broker.pid");
  const signals: Array<NodeJS.Signals | 0> = [];
  const kill = ((_: number, signal?: NodeJS.Signals | 0) => {
    signals.push(signal ?? "SIGTERM");
    return true;
  }) as typeof process.kill;

  try {
    await import("node:fs").then(({ writeFileSync }) => writeFileSync(pidPath, "12345"));
    await assert.rejects(
      () => stopUnhealthyBrokerBeforeSpawn(pidPath, async () => false, kill),
      /refusing to spawn a second broker/,
    );
    assert.deepEqual(signals, [0]);
  } finally {
    rmSync(intercomDir, { recursive: true, force: true });
  }
});

test("spawn guard treats EPERM as a live unhealthy broker PID and fails loud", async () => {
  const intercomDir = mkdtempSync(path.join(tmpdir(), "pi-intercom-"));
  const pidPath = path.join(intercomDir, "broker.pid");
  const kill = ((_: number) => {
    const error = new Error("alive but not owned") as NodeJS.ErrnoException;
    error.code = "EPERM";
    throw error;
  }) as typeof process.kill;

  try {
    await import("node:fs").then(({ writeFileSync }) => writeFileSync(pidPath, "12345"));
    await assert.rejects(
      () => stopUnhealthyBrokerBeforeSpawn(pidPath, async () => false, kill),
      /refusing to spawn a second broker/,
    );
  } finally {
    rmSync(intercomDir, { recursive: true, force: true });
  }
});
