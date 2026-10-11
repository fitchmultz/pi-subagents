import "../support/isolated-home.ts";
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs, {
  readFileSync,
  rmSync,
  writeFileSync,
  type PathOrFileDescriptor,
  type ReadFileSyncOptions,
} from "node:fs";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { syncBuiltinESMExports } from "node:module";
import { brokerPidRecord, isBrokerPidReused } from "../../src/pi-intercom/broker/pid.ts";
import { fileURLToPath } from "node:url";
import { assertRecord } from "../support/assertions.ts";
import {
  getBrokerLaunchSpec,
  getBrokerSpawnOptions,
  stopUnhealthyBrokerBeforeSpawn,
} from "../../src/pi-intercom/broker/spawn.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const { getPiAgentDir } = await import("../../src/pi-intercom/agent-dir.ts");
const pidDir = path.join(getPiAgentDir(), "intercom");

test(
  "legacy PID alias to a real Linux thread cannot be a broker process",
  { skip: process.platform !== "linux" },
  async () => {
    const dir = pidDir;
    fs.mkdirSync(dir, { recursive: true });
    const pidPath = path.join(dir, "broker.pid");
    const worker = new Worker(
      `
    const { parentPort } = require("node:worker_threads");
    const status = require("node:fs").readFileSync("/proc/thread-self/status", "utf8");
    parentPort.once("message", () => parentPort.close());
    parentPort.postMessage({
      tid: Number(/^Pid:\\s+(\\d+)/m.exec(status)[1]),
      tgid: Number(/^Tgid:\\s+(\\d+)/m.exec(status)[1]),
    });
  `,
      { eval: true },
    );
    try {
      const payload: readonly unknown[] = await once(worker, "message");
      const identity = payload[0];
      assertRecord(identity);
      assert.ok(typeof identity.tgid === "number" && typeof identity.tid === "number");
      assert.equal(identity.tgid, process.pid);
      assert.notEqual(identity.tid, process.pid);
      process.kill(identity.tid, 0); // Native signal-0 succeeds for this non-process TID.
      writeFileSync(pidPath, String(identity.tid));
      await stopUnhealthyBrokerBeforeSpawn();
      assert.equal(readFileSync(pidPath, "utf8"), String(identity.tid));
      process.kill(identity.tid, 0); // Guard neither signals nor removes the alias.
    } finally {
      const exited = once(worker, "exit");
      worker.postMessage("normal exit", []);
      assert.deepEqual(await exited, [0]);
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("legacy numeric live process remains ambiguous and blocking", async () => {
  const dir = pidDir;
  fs.mkdirSync(dir, { recursive: true });
  const pidPath = path.join(dir, "broker.pid");
  try {
    writeFileSync(pidPath, String(process.pid));
    await assert.rejects(stopUnhealthyBrokerBeforeSpawn(), /refusing to spawn a second broker/);
    assert.equal(readFileSync(pidPath, "utf8"), String(process.pid));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "native PID identity preserves a live process and only disproves comparable identities",
  { skip: process.platform !== "linux" },
  async (t) => {
    const dir = pidDir;
    fs.mkdirSync(dir, { recursive: true });
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
      await assert.rejects(stopUnhealthyBrokerBeforeSpawn(), /refusing to spawn a second broker/);
      assert.equal(readFileSync(pidPath, "utf8"), record);
      assert.equal(isBrokerPidReused(process.pid, record), false);
      // Format/decision controls against real proc metadata, not simulated procfs.
      assert.equal(
        isBrokerPidReused(process.pid, `${pid}\nlinux-v2 ${boot} ${namespace} ${clock} ${start}\n`),
        false,
      );
      assert.equal(isBrokerPidReused(process.pid, `${pid}\nlinux-v1 broken\n`), false);
      assert.equal(
        isBrokerPidReused(
          process.pid,
          `${pid}\nlinux-v1 ${boot} pid:[0] ${clock} ${start}\nunknown\n`,
        ),
        false,
      );
      assert.equal(
        isBrokerPidReused(
          process.pid,
          `${pid}\nlinux-v1 ${boot} ${namespace} ${clock} ${BigInt(start) + 1n}\n`,
        ),
        true,
      );
      assert.equal(
        isBrokerPidReused(
          process.pid,
          `${pid}\nlinux-v1 ${boot} ${namespace} time:[0] ${BigInt(start) + 1n}\n`,
        ),
        false,
        "different clock view cannot disprove start identity",
      );
      assert.equal(
        isBrokerPidReused(process.pid, `${pid}\nlinux-v1 ${boot} pid:[0] ${clock} ${start}\n`),
        true,
      );
      const otherBoot = `${boot[0] === "0" ? "1" : "0"}${boot.slice(1)}`;
      assert.equal(
        isBrokerPidReused(
          process.pid,
          `${pid}\nlinux-v1 ${otherBoot} ${namespace} ${clock} ${start}\n`,
        ),
        true,
      );
      t.mock.method(process, "kill", () => {
        throw Object.assign(new Error("not permitted"), { code: "EPERM" });
      });
      writeFileSync(pidPath, `${pid}\nlinux-v1 ${otherBoot} ${namespace} ${clock} ${start}\n`);
      await assert.rejects(stopUnhealthyBrokerBeforeSpawn(), /refusing to spawn a second broker/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "unreadable or mismatched procfs views cannot disprove a live PID",
  { skip: process.platform !== "linux" },
  () => {
    // A stale-looking record still cannot override an unreadable native identity.
    const record = brokerPidRecord().replace(
      /(\d+)\n$/,
      (_match: string, ticks: string) => `${BigInt(ticks) + 1n}\n`,
    );
    const read = fs.readFileSync;
    try {
      for (const view of ["denied", "ancestor", "missing-stat"] as const) {
        const mocked = mock.method(
          fs,
          "readFileSync",
          (
            file: PathOrFileDescriptor,
            options?: Readonly<ReadFileSyncOptions> | BufferEncoding | null,
          ) => {
            if (String(file) === "/proc/self/status") {
              if (view === "denied") {
                throw Object.assign(new Error("not permitted"), { code: "EACCES" });
              }
              if (view === "ancestor") {
                return `NStgid:\t99999\t${process.pid}\n`;
              }
            }
            if (view === "missing-stat" && String(file).endsWith("/stat")) {
              throw Object.assign(new Error("gone"), { code: "ENOENT" });
            }
            if (typeof options === "string") {
              return read(file, options);
            }
            if (options === undefined || options === null) {
              return read(file);
            }
            return read(file, options);
          },
        );
        syncBuiltinESMExports();
        assert.equal(isBrokerPidReused(process.pid, record), false);
        assert.equal(brokerPidRecord(), `${process.pid}\n`);
        mocked.mock.restore();
      }
    } finally {
      mock.restoreAll();
      syncBuiltinESMExports();
    }
  },
);

test(
  "non-Linux PID records remain numeric without procfs",
  { skip: process.platform === "linux" },
  () => {
    assert.equal(brokerPidRecord(), `${process.pid}\n`);
    assert.equal(isBrokerPidReused(process.pid, String(process.pid)), false);
  },
);

test("bundled broker resolves the package root", () => {
  assert.equal(getBrokerSpawnOptions().cwd, projectRoot);
});

test("getBrokerLaunchSpec maps the legacy tsx default to native Node", () => {
  const spec = getBrokerLaunchSpec("/repo/broker.ts", "npx", ["--no-install", "tsx"]);
  assert.equal(spec.command, process.execPath);
  assert.deepEqual(spec.args, ["/repo/broker.ts"]);
});

test("getBrokerLaunchSpec uses custom broker command", () => {
  const spec = getBrokerLaunchSpec("/repo/broker.ts", "bun", []);
  assert.equal(spec.command, "bun");
  assert.deepEqual(spec.args, ["/repo/broker.ts"]);
});

test("getBrokerSpawnOptions detaches the broker with no inherited stdio", () => {
  const options = getBrokerSpawnOptions();
  assert.equal(options.detached, true);
  assert.equal(options.stdio, "ignore");
  assert.equal(options.cwd, projectRoot);
});

test("spawn guard fails loud instead of killing a live unhealthy broker PID", async (t) => {
  const intercomDir = pidDir;
  fs.mkdirSync(intercomDir, { recursive: true });
  const pidPath = path.join(intercomDir, "broker.pid");
  const signals: Array<NodeJS.Signals | 0> = [];
  t.mock.method(process, "kill", (_: number, signal?: NodeJS.Signals | 0) => {
    signals.push(signal ?? "SIGTERM");
    return true;
  });

  try {
    writeFileSync(pidPath, "12345");
    await assert.rejects(
      () => stopUnhealthyBrokerBeforeSpawn(),
      /refusing to spawn a second broker/,
    );
    assert.deepEqual(signals, [0]);
  } finally {
    rmSync(intercomDir, { recursive: true, force: true });
  }
});

test("spawn guard treats EPERM as a live unhealthy broker PID and fails loud", async (t) => {
  const intercomDir = pidDir;
  fs.mkdirSync(intercomDir, { recursive: true });
  const pidPath = path.join(intercomDir, "broker.pid");
  t.mock.method(process, "kill", () => {
    throw Object.assign(new Error("alive but not owned"), { code: "EPERM" });
  });

  try {
    writeFileSync(pidPath, "12345");
    await assert.rejects(
      () => stopUnhealthyBrokerBeforeSpawn(),
      /refusing to spawn a second broker/,
    );
  } finally {
    rmSync(intercomDir, { recursive: true, force: true });
  }
});
