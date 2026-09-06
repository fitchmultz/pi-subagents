import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  getBrokerLaunchSpec,
  getBrokerSpawnOptions,
  stopUnhealthyBrokerBeforeSpawn,
} from "../../src/pi-intercom/broker/spawn.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

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
