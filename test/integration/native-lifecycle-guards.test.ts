import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { createNativeSessionFixture } from "../support/helpers.ts";
import { assertDefined, assertRecord } from "../support/assertions.ts";
import type { SubagentState } from "../../src/shared/types.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const root = realpathSync(mkdtempSync(path.join(tmpdir(), "native-lifecycle-")));
const agentDir = path.join(root, "agent");
for (const dir of [agentDir, path.join(root, "home")]) {
  mkdirSync(dir);
}
for (const key of Object.keys(process.env)) {
  if (
    key.startsWith("PI_SUBAGENT_") ||
    key.startsWith("PI_SESSION_") ||
    key.startsWith("PI_CHECKPOINT_SOCKET")
  ) {
    delete process.env[key];
  }
}
Object.assign(process.env, {
  HOME: path.join(root, "home"),
  PI_CODING_AGENT_DIR: agentDir,
  PI_SUBAGENT_TEMP_ROOT: path.join(root, "pi-subagents-runs"),
  PI_OFFLINE: "1",
});
const { IntercomClient } = await import("../../src/pi-intercom/broker/client.ts");
const broker = spawn(process.execPath, [path.join(repo, "src/pi-intercom/broker/broker.ts")], {
  cwd: root,
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: tmpdir(),
    PI_CODING_AGENT_DIR: agentDir,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let brokerLog = "";
broker.stdout.on("data", (c: Buffer) => {
  brokerLog += c.toString("utf8");
});
broker.stderr.on("data", (c: Buffer) => {
  brokerLog += c.toString("utf8");
});
async function waitFor(check: () => boolean | Promise<boolean>, label = "condition") {
  const deadline = Date.now() + 10000;
  // The previous native observation must settle before the next poll.
  // oxlint-disable-next-line no-await-in-loop
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `timed out: ${label}`);
    // Poll the process/socket boundary until its real readiness condition is observed.
    // oxlint-disable-next-line no-await-in-loop
    await sleep(10);
  }
}
const keeper = new IntercomClient();
before(async () => {
  await waitFor(() => brokerLog.includes("Intercom broker started"));
  await keeper.connect({ name: "keeper", cwd: root, model: "none" });
});
after(async () => {
  await keeper.disconnect();
  if (broker.exitCode === null) {
    const exited = once(broker, "exit");
    broker.kill("SIGTERM");
    await exited;
  }
  writeFileSync(path.join(root, "broker.log"), brokerLog);
  rmSync(root, { recursive: true, force: true });
});

test("real broker startup writes a backward-readable PID identity and stays protected", async (t) => {
  const { stopUnhealthyBrokerBeforeSpawn } = await import("../../src/pi-intercom/broker/spawn.ts");
  const pidPath = path.join(agentDir, "intercom/broker.pid");
  const record = readFileSync(pidPath, "utf8");
  assert.equal(Number.parseInt(record, 10), broker.pid);
  if (process.platform === "linux") {
    assert.match(record, /^\d+\nlinux-v1 /);
  }
  // An unhealthy-socket observation must not override a matching live identity.
  const probe = t.mock.method(net, "connect", () => {
    const socket = new net.Socket();
    queueMicrotask(() => {
      socket.emit("error", new Error("controlled unhealthy socket observation"));
    });
    return socket;
  });
  await assert.rejects(stopUnhealthyBrokerBeforeSpawn(), /refusing to spawn a second broker/);
  probe.mock.restore();
  assert.equal(readFileSync(pidPath, "utf8"), record);
  assert.equal(keeper.isConnected(), true);
  await keeper.listSessions();
});

// Kept as counterexamples to unsafe disconnect/stop approaches, not proposed fixes.
test("unchanged protocol: accepted replace delivery is lost on recipient disconnect", async () => {
  const recipient = new IntercomClient();
  let received = 0;
  recipient.on("message", () => {
    received++;
  });
  await recipient.connect({
    name: "queue-loss",
    cwd: root,
    model: "none",
    status: "idle",
    acceptsAsks: true,
  });
  const receipt = await keeper.send("queue-loss", {
    text: "accepted only in broker memory",
    delivery: "queue",
    queueMode: "replace",
    threadId: "proof",
  });
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.queued, true);
  assert.equal(received, 0);
  await recipient.disconnect();
  await recipient.connect({ name: "queue-loss", cwd: root, model: "none", status: "idle" });
  await sleep(1700);
  assert.equal(received, 0);
  await recipient.disconnect();
  writeFileSync(
    path.join(root, "accepted-queued-disconnect.json"),
    JSON.stringify({ receipt, received }),
  );
});

test("watcher stop retains an awaited relay without stale events and restart recovers its file", async (t) => {
  const { createResultWatcher } = await import("../../src/runs/background/result-watcher.ts");
  const dir = path.join(root, "watcher-tail");
  mkdirSync(dir);
  const native = await createNativeSessionFixture({ cwd: dir, agentDir: path.join(dir, "agent") });
  t.after(native.dispose);
  const events = native.pi.events;
  const state: SubagentState = {
    baseCwd: dir,
    currentSessionId: "owner",
    asyncJobs: new Map(),
    cleanupTimers: new Map(),
    lastUiContext: null,
    poller: null,
    completionSeen: new Map(),
    watcher: null,
    watcherRestartTimer: null,
    resultFileCoalescer: {
      schedule: () => false,
      clear() {
        // This fixture uses the owner's periodic/public priming scan instead of coalescing.
      },
    },
  };
  const watcher = createResultWatcher(native.pi, state, dir);
  t.after(() => watcher.stopResultWatcher());
  let relay: { requestId: string } | undefined;
  const currentRelay = () => {
    assertDefined(relay);
    return relay;
  };
  let completed = 0;
  events.on("subagent:result-intercom", (payload) => {
    assertRecord(payload);
    assert.equal(typeof payload.requestId, "string");
    assert.ok(typeof payload.requestId === "string");
    relay = { requestId: payload.requestId };
  });
  events.on("subagent:async-complete", () => {
    completed++;
  });
  watcher.startResultWatcher();
  const file = path.join(dir, "tail.json");
  writeFileSync(
    file,
    JSON.stringify({
      id: "tail",
      runId: "tail",
      sessionId: "owner",
      agent: "worker",
      summary: "done",
      success: true,
      timestamp: Date.now(),
      intercomTarget: "peer",
      nestedChildren: [],
    }),
  );
  await waitFor(() => relay !== undefined);
  watcher.stopResultWatcher();
  assert.equal(completed, 0);
  assert.equal(existsSync(file), true);
  events.emit("subagent:result-intercom-delivery", {
    requestId: currentRelay().requestId,
    delivered: true,
  });
  await watcher.joinInFlight();
  assert.equal(completed, 0, "a replaced runtime cannot emit through its old extension API");
  assert.equal(existsSync(file), true, "an old tail cannot retire its successor's recovery input");
  const oldRequest = currentRelay().requestId;
  watcher.startResultWatcher();
  watcher.primeExistingResults();
  await waitFor(() => currentRelay().requestId !== oldRequest);
  events.emit("subagent:result-intercom-delivery", {
    requestId: currentRelay().requestId,
    delivered: true,
  });
  await waitFor(() => completed === 1);
  assert.equal(existsSync(file), false);
  watcher.stopResultWatcher();
  writeFileSync(
    path.join(root, "watcher-tail.json"),
    JSON.stringify({ completedAfterRestart: completed, recovered: !existsSync(file) }),
  );
});
