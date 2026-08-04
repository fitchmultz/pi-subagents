import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  getBrokerLaunchSpec,
  getBrokerSpawnOptions,
  getWindowsHiddenLauncherScript,
  getWindowsBrokerCommandLine,
  getWindowsHiddenLauncherPath,
  stopUnhealthyBrokerBeforeSpawn,
} from "../../src/pi-intercom/broker/spawn.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("bundled broker resolves the package root", () => {
  assert.equal(getBrokerSpawnOptions().cwd, projectRoot);
});

test("getWindowsHiddenLauncherPath points at the broker launcher script", () => {
  const launcherPath = getWindowsHiddenLauncherPath("C:/tmp/intercom");
  assert.equal(launcherPath, path.join("C:/tmp/intercom", "broker-launch.vbs"));
});

test("getWindowsBrokerCommandLine wraps node and the broker path", () => {
  const commandLine = getWindowsBrokerCommandLine(
    "C:/repo/broker.ts",
    "C:/Program Files/nodejs/node.exe",
  );
  assert.equal(commandLine, `"C:/Program Files/nodejs/node.exe" "C:/repo/broker.ts"`);
});

test("getWindowsHiddenLauncherScript runs the broker command without showing a console", () => {
  const script = getWindowsHiddenLauncherScript('"C:/Program Files/nodejs/node.exe" "C:/repo/broker.ts"');
  assert.match(script, /WshShell\.Run/);
  assert.match(script, /, 0, False/);
});

test("getBrokerLaunchSpec uses wscript launcher on Windows without writing files", () => {
  const intercomDir = mkdtempSync(path.join(tmpdir(), "pi-intercom-"));

  try {
    const spec = getBrokerLaunchSpec(
      "C:/repo/broker.ts",
      "npx",
      ["--no-install", "tsx"],
      "win32",
      intercomDir,
      "C:/Program Files/nodejs/node.exe",
    );
    assert.equal(spec.command, "wscript.exe");
    assert.deepEqual(spec.args, [path.join(intercomDir, "broker-launch.vbs")]);
    assert.equal(spec.kind, "windows-launcher");
    assert.equal(spec.launcherCommandLine, `"C:/Program Files/nodejs/node.exe" "C:/repo/broker.ts"`);
    assert.equal(existsSync(path.join(intercomDir, "broker-launch.vbs")), false);
  } finally {
    rmSync(intercomDir, { recursive: true, force: true });
  }
});

test("getBrokerLaunchSpec uses custom broker command on Windows", () => {
  const intercomDir = mkdtempSync(path.join(tmpdir(), "pi-intercom-"));

  try {
    const spec = getBrokerLaunchSpec("C:/repo/broker.ts", "bun", ["--smol"], "win32", intercomDir, "C:/Program Files/nodejs/node.exe");
    assert.equal(spec.command, "wscript.exe");
    assert.equal(spec.kind, "windows-launcher");
    assert.equal(spec.launcherCommandLine, `"bun" "--smol" "C:/repo/broker.ts"`);
  } finally {
    rmSync(intercomDir, { recursive: true, force: true });
  }
});

test("getBrokerLaunchSpec maps the legacy tsx default to native Node", () => {
  const spec = getBrokerLaunchSpec("C:/repo/broker.ts", "npx", ["--no-install", "tsx"], "linux", "/tmp/intercom", "/usr/bin/node");
  assert.equal(spec.command, "/usr/bin/node");
  assert.deepEqual(spec.args, ["C:/repo/broker.ts"]);
  assert.equal(spec.kind, "direct");
});

test("getBrokerLaunchSpec uses custom broker command on non-Windows", () => {
  const spec = getBrokerLaunchSpec("/repo/broker.ts", "bun", [], "linux", "/tmp/intercom", "/usr/bin/node");
  assert.equal(spec.command, "bun");
  assert.deepEqual(spec.args, ["/repo/broker.ts"]);
  assert.equal(spec.kind, "direct");
});

test("getBrokerSpawnOptions hides the broker console window on Windows", () => {
  const options = getBrokerSpawnOptions("C:/repo");
  assert.equal(options.windowsHide, true);
  assert.equal(options.detached, true);
  assert.equal(options.stdio, "ignore");
  assert.equal(options.cwd, "C:/repo");
});

test("getBrokerSpawnOptions keeps portable defaults on non-Windows platforms", () => {
  const options = getBrokerSpawnOptions("/repo");
  assert.equal(options.windowsHide, true);
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
