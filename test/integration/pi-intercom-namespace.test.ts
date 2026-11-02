import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { fork, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test as nodeTest } from "node:test";
import { assertRecord, records, text } from "../support/assertions.ts";

const repo = process.cwd();

function message(child: ChildProcess, match: (value: Record<string, unknown>) => boolean) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("Peer IPC timeout")), 10000);
    const onMessage = (value: unknown) => {
      assertRecord(value);
      if (match(value)) {
        finish(undefined, value);
      }
    };
    const onExit = () => finish(new Error("Peer exited before IPC reply"));
    function finish(error?: Error, value?: Record<string, unknown>) {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("exit", onExit);
      if (error) {
        reject(error);
      } else {
        assert.ok(value);
        resolve(value);
      }
    }
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

async function request(child: ChildProcess, action: string, params = {}) {
  const reply = message(child, (value) => value.request === action);
  child.send({ request: action, action, ...params });
  const result = await reply;
  assert.equal(result.error, undefined);
  return result.result;
}

nodeTest(
  "shared runtime routes across agent directories/cwds/temp roots without taking over old brokers",
  async () => {
    const home = text(process.env.HOME);
    const runtime = text(process.env.PI_INTERCOM_RUNTIME_DIR);
    const agentA = path.join(home, "agent-a");
    const agentB = path.join(home, "agent-b");
    const cwdA = path.join(home, "project-a");
    const cwdB = path.join(home, "project-b");
    const tmpA = path.join(home, "tmp-a");
    const tmpB = path.join(home, "tmp-b");
    for (const directory of [agentA, agentB, cwdA, cwdB, tmpA, tmpB]) {
      mkdirSync(directory, { recursive: true });
    }
    // Construct the previous release's path independently of the new path implementation.
    const digest = createHash("sha256")
      .update(`${process.getuid?.() ?? "unsupported"}:${agentA}`)
      .digest("hex")
      .slice(0, 16);
    const preferred = path.join(tmpA, `pi-intercom-${digest}`, "broker.sock");
    const oldSocket =
      Buffer.byteLength(preferred) <= 100
        ? preferred
        : path.join("/tmp", `pi-intercom-${digest}`, "broker.sock");
    mkdirSync(path.dirname(oldSocket), { recursive: true });
    const oldServer = net.createServer((socket) => {
      socket.destroy();
    });
    oldServer.listen(oldSocket);
    await once(oldServer, "listening");
    const oldIdentity = lstatSync(oldSocket);
    const peers: ChildProcess[] = [];
    let brokerPid: number | undefined;
    let warnings = "";
    try {
      const start = (agentDir: string, cwd: string, tmp: string, session: string) => {
        const child = fork(path.join(repo, "test/fixtures/intercom-namespace-peer.ts"), [session], {
          cwd,
          env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, TMPDIR: tmp, TMP: tmp, TEMP: tmp },
          execArgv: [],
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          warnings += chunk.toString();
        });
        peers.push(child);
        return child;
      };
      const first = start(agentA, cwdA, tmpA, "native-session-a");
      const firstReady = message(first, (value) => value.event === "ready");
      const second = start(agentB, cwdB, tmpB, "native-session-b");
      const [readyA, readyB] = await Promise.all([
        firstReady,
        message(second, (value) => value.event === "ready"),
      ]);
      brokerPid = Number.parseInt(readFileSync(path.join(runtime, "broker.pid"), "utf8"), 10);
      const expectedId = (session: string) =>
        `pi-${createHash("sha256").update(session).digest("hex").slice(0, 32)}`;
      assert.equal(readyA.id, expectedId("native-session-a"));
      assert.equal(readyB.id, expectedId("native-session-b"));
      const sessions = records(await request(first, "list"));
      assert.deepEqual(new Set(sessions.map((peer) => peer.id)), new Set([readyA.id, readyB.id]));
      assert.deepEqual(
        new Set(sessions.map((peer) => peer.cwd)),
        new Set([realpathSync(cwdA), realpathSync(cwdB)]),
      );
      const ambiguous = await request(first, "send", { to: "duplicate-worker", text: "ambiguous" });
      assertRecord(ambiguous);
      assert.equal(ambiguous.accepted, false);
      assert.match(text(ambiguous.reason), /Multiple sessions named/);
      const received = message(second, (value) => value.event === "received");
      const receipt = await request(first, "send", { to: readyB.id, text: "exact native peer" });
      assertRecord(receipt);
      assert.equal(receipt.accepted, true);
      assert.equal(receipt.delivered, true);
      const delivery = await received;
      assertRecord(delivery.from);
      assert.equal(delivery.from.id, readyA.id);
      assertRecord(delivery.message);
      assertRecord(delivery.message.content);
      assert.equal(delivery.message.content.text, "exact native peer");
      assert.match(warnings, /peers are not part of shared same-user discovery until they reload/);
      assert.equal(lstatSync(oldSocket).ino, oldIdentity.ino);
      assert.equal(lstatSync(oldSocket).mode, oldIdentity.mode);
      assert.equal(lstatSync(path.join(runtime, "broker.sock")).mode & 0o777, 0o600);

      const duplicate = spawn(
        process.execPath,
        [path.join(repo, "src/pi-intercom/broker/broker.ts")],
        {
          env: { ...process.env, PI_CODING_AGENT_DIR: agentB },
          stdio: "pipe",
        },
      );
      let duplicateError = "";
      duplicate.stderr.on("data", (chunk: Buffer) => {
        duplicateError += chunk.toString();
      });
      assert.deepEqual(await once(duplicate, "exit"), [1, null]);
      assert.match(duplicateError, /already running; refusing to replace/);
      await request(first, "list");
      assert.equal(
        Number.parseInt(readFileSync(path.join(runtime, "broker.pid"), "utf8"), 10),
        brokerPid,
      );
      // The owner is known live and has processed traffic before its socket becomes unreachable.
      unlinkSync(path.join(runtime, "broker.sock"));
      const refused = start(agentB, cwdB, tmpB, "cannot-take-over");
      assert.deepEqual(await once(refused, "exit"), [1, null]);
      assert.match(warnings, /may still own accepted work.*refusing to spawn a second broker/);
      assert.equal(
        Number.parseInt(readFileSync(path.join(runtime, "broker.pid"), "utf8"), 10),
        brokerPid,
      );
      process.kill(brokerPid, 0);
      await request(first, "list");
      assert.equal(lstatSync(oldSocket).ino, oldIdentity.ino);
    } finally {
      await Promise.all(
        peers.map(async (child) => {
          if (child.exitCode === null) {
            const exited = once(child, "exit");
            child.kill("SIGTERM");
            await exited;
          }
        }),
      );
      if (brokerPid !== undefined) {
        process.kill(brokerPid, "SIGTERM");
        const deadline = Date.now() + 5000;
        while (true) {
          try {
            process.kill(brokerPid, 0);
          } catch {
            break;
          }
          assert.ok(Date.now() < deadline, "owned broker did not exit");
          // Poll actual process exit before removing its runtime directory.
          // oxlint-disable-next-line no-await-in-loop
          await delay(10);
        }
      }
      oldServer.close();
      await once(oldServer, "close");
      rmSync(path.dirname(oldSocket), { recursive: true, force: true });
      rmSync(runtime, { recursive: true, force: true });
    }
  },
);
