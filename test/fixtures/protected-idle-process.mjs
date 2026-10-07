// Local process orchestration fixture. Native guest operations below are NOT qualification proof.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { GuestBoundary } from "../../scripts/protected-macos-guest-bootstrap.mjs";
import { darwinSnapshot } from "../../scripts/compat-process-darwin.mjs";

const fixture = fileURLToPath(import.meta.url);
function publish(root, name, value) {
  const target = join(root, name);
  writeFileSync(`${target}.pending`, JSON.stringify(value), { mode: 0o600 });
  renameSync(`${target}.pending`, target);
}
function configuration(root) {
  return JSON.parse(readFileSync(join(root, "idle-fixture.json"), "utf8"));
}
function record(root, operation) {
  appendFileSync(join(root, "operations.ndjson"), JSON.stringify({ operation }) + "\n", {
    mode: 0o600,
  });
}
function checkpoint(root, method, inventory) {
  const observed = darwinSnapshot("", process.pid, Date.now() + 3000, true);
  assert.deepEqual(observed.uncertainties, []);
  assert.equal(observed.identities.length, 1);
  publish(root, "disposal-checkpoint.json", { method, inventory, owner: observed.identities[0] });
  process.exit(23);
}
function absent(root, name) {
  const saved = JSON.parse(readFileSync(join(root, name), "utf8"));
  const current = darwinSnapshot("", saved.pid, Date.now() + 3000, true);
  assert.deepEqual(current.uncertainties, []);
  assert.deepEqual(current.identities, []);
}
async function control(root, endpoint, command) {
  const socket = createConnection(join(root, endpoint));
  let text = "";
  await new Promise((resolveReply, reject) => {
    socket.once("error", reject);
    socket.once("connect", () => socket.end(command + "\n"));
    socket.on("data", (chunk) => {
      text += chunk.toString();
    });
    socket.once("end", resolveReply);
  });
  assert.equal(JSON.parse(text).accepted, true);
}
function server(root, endpoint, stop) {
  return createServer((socket) => {
    socket.once("data", (chunk) => {
      const command = chunk.toString().trim();
      assert.ok(["drain", "release"].includes(command));
      socket.end(JSON.stringify({ accepted: true, pid: process.pid }) + "\n");
      socket.once("close", () => stop(command));
    });
  }).listen(join(root, endpoint));
}
async function consumer(root) {
  const child = server(root, "c", () => child.close(() => process.exit(0)));
  await new Promise((resolveListen) => child.once("listening", resolveListen));
  const identity = darwinSnapshot("", process.pid, Date.now() + 3000, true);
  assert.deepEqual(identity.uncertainties, []);
  assert.equal(identity.identities.length, 1);
  publish(root, "consumer-ready.json", identity.identities[0]);
  process.send({ ready: true });
}
async function transport(root) {
  const child = childProcess.fork(fixture, ["consumer", root], {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  await new Promise((resolveReady) => child.once("message", resolveReady));
  const listener = server(root, "t", (command) => {
    publish(root, "transport-command.json", { command });
    listener.close(() => process.exit(0));
  });
  await new Promise((resolveListen) => listener.once("listening", resolveListen));
  publish(root, "transport-ready.json", { pid: process.pid });
  const lines = createInterface({ input: process.stdin });
  let count = 0;
  lines.on("line", () => {
    count++;
    if (count === 1) {
      console.log(`PROTECTED_LISTENER ${process.pid}`);
    }
    if (count === 2) {
      publish(root, "transport-input.json", { received: true });
    }
  });
}
function install(root) {
  const spawn = childProcess.spawn;
  mock.method(childProcess, "spawn", (command, args, options) => {
    if (command !== "/usr/bin/ssh") {
      return spawn(command, args, options);
    }
    const child = spawn(process.execPath, [fixture, "transport", root], options);
    child.once("exit", (code, signal) => {
      publish(root, "transport-exited.json", { pid: child.pid, code, signal });
    });
    return child;
  });
  syncBuiltinESMExports();
  const guest = GuestBoundary.prototype;
  mock.method(guest, "connect", () => {
    const inventory = configuration(root).inventory ?? "running";
    record(root, `connect:${inventory}`);
    assert.equal(inventory, "running", `Controlled ${inventory} guest is not connectable`);
    return "192.0.2.1";
  });
  mock.method(guest, "listenerLaunch", () => ({ args: [], password: "fixture-not-a-secret" }));
  mock.method(guest, "listener", (pid) => {
    const observed = darwinSnapshot("", pid, Date.now() + 3000, true);
    assert.deepEqual(observed.uncertainties, []);
    assert.equal(observed.identities.length, 1);
    return observed.identities[0];
  });
  mock.method(guest, "closeGate", () => {
    record(root, "close-gate");
    return { windowClosed: true };
  });
  mock.method(guest, "drainIdle", () => {
    record(root, "idle-drain");
    const config = configuration(root);
    if (config.rootVeto) {
      throw new Error("Controlled root idle veto; not native qualification");
    }
    if (config.firstAbsent || existsSync(join(root, "transport-exited.json"))) {
      return { idleListenerAbsent: true };
    }
    const result = childProcess.spawnSync(
      process.execPath,
      [fixture, "control", root, "t", "drain"],
      {
        encoding: "utf8",
        timeout: 5000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return { stoppedIdleListener: true };
  });
  mock.method(guest, "listenerAbsent", () => {
    record(root, "listener-absent");
    absent(root, "transport-ready.json");
    return { listenerAbsent: true, errno: "ESRCH" };
  });
  mock.method(guest, "settled", () => {
    record(root, "original-cut");
    absent(root, "consumer-ready.json");
    const config = configuration(root);
    return {
      ...config.cut,
      bootSeconds: config.cut.bootSeconds + (config.changedCut ? 1 : 0),
      stableEnumerations: 2,
      remaining: 0,
      uncertain: false,
    };
  });
  mock.method(guest, "logs", () => ({ totalBytes: 0, files: [] }));
  mock.method(guest, "status", () => configuration(root).inventory ?? "running");
  for (const [method, inventory] of [
    ["stop", "stopped"],
    ["delete", "absent"],
  ]) {
    mock.method(guest, method, () => {
      const config = configuration(root);
      assert.equal(config.inventory ?? "running", method === "stop" ? "running" : "stopped");
      if (method === "stop" && config.exitAfter === "before-stop") {
        publish(root, "idle-fixture.json", { ...config, exitAfter: undefined });
        checkpoint(root, "before-stop", "running");
      }
      record(root, method);
      publish(root, "idle-fixture.json", {
        ...config,
        inventory,
        exitAfter: config.exitAfter === method ? undefined : config.exitAfter,
      });
      if (config.exitAfter === method) {
        checkpoint(root, method, inventory);
      }
    });
  }
}
if (process.argv[1] === fixture) {
  const [role, root, endpoint, command] = process.argv.slice(2);
  if (role === "consumer") {
    await consumer(root);
  } else if (role === "transport") {
    await transport(root);
  } else {
    assert.equal(role, "control");
    await control(root, endpoint, command);
  }
} else {
  assert.ok(process.env.PROTECTED_IDLE_TEST_ROOT);
  install(process.env.PROTECTED_IDLE_TEST_ROOT);
}
