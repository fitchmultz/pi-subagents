import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { IntercomClient } from "../../src/pi-intercom/broker/client.ts";
import {
  createMessageReader,
  MAX_FRAME_SIZE_BYTES,
  writeMessage,
} from "../../src/pi-intercom/broker/framing.ts";
import { prepareBrokerSocketPath } from "../../src/pi-intercom/broker/paths.ts";
import { array, assertDefined, record, text } from "../support/assertions.ts";

function isolatedAgent(t: TestContext): void {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const directory = mkdtempSync(path.join(text(process.env.HOME), "broker-"));
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previous;
    }
    rmSync(directory, { recursive: true, force: true });
  });
}

function topic(name: string, body = "current state", revision = 1) {
  return { topic: name, text: body, event: "update", revision, updatedAt: 1 };
}

test("broker restores transactionally with exact cached frame limits and ordered records", async (t) => {
  isolatedAgent(t);
  const broker = spawn(process.execPath, ["src/pi-intercom/broker/broker.ts"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(broker, "exit");
  t.after(async () => {
    broker.kill("SIGTERM");
    await exited;
  });
  await new Promise<void>((resolve, reject) => {
    broker.once("error", reject);
    broker.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("broker started")) {
        resolve();
      }
    });
    broker.once("exit", () => reject(new Error("Broker exited before readiness")));
  });
  const socket = net.connect(prepareBrokerSocketPath());
  socket.on("error", () => {
    // Protocol failures are asserted through responses and client disconnection below.
  });
  t.after(() => socket.destroy());
  await once(socket, "connect");
  const received = new EventEmitter();
  socket.on(
    "data",
    createMessageReader(
      (value) => {
        received.emit("packet", value);
      },
      (error) => {
        socket.destroy(error);
      },
    ),
  );
  const request = async (value: unknown) => {
    const response = once(received, "packet");
    writeMessage(socket, value);
    const packets: unknown = await response;
    return record(array(packets)[0]);
  };
  const initial = [
    topic("duplicate", "first"),
    topic("duplicate", "last"),
    topic("largest", "日".repeat(1000)),
  ];
  const registered = await request({
    type: "register",
    requestedId: "restore-owner",
    topicFrames: true,
    session: { cwd: "/synthetic", model: "synthetic", topics: initial, subscriptions: [] },
  });
  assert.equal(registered.sessionId, "restore-owner");
  const observer = new IntercomClient();
  observer.on("error", (error: Error) => assert.fail(error.message));
  await observer.connect({ cwd: "/observer", model: "synthetic" });
  t.after(() => observer.disconnect());
  const observed = async () => {
    const row = (await observer.listSessions()).find((info) => info.id === "restore-owner");
    assertDefined(row);
    return row;
  };
  assert.deepEqual(
    (await observed()).topics,
    initial,
    "registration preserves original rows until mutation",
  );
  const restore = (change: unknown, requestId = "restore-request") =>
    request({ type: "list", requestId, stream: true, change });
  const ack = await restore({ action: "restore", topic: topic("new", "new state") });
  assert.deepEqual(ack.sessions, [], "restore acknowledgements never echo the registry");
  assert.equal(ack.more, false);
  assert.deepEqual((await observed()).topics, [initial[1], initial[2], topic("new", "new state")]);
  await restore({ action: "restore", topic: topic("duplicate", "stale", 1) });
  await restore({ action: "restore", topic: topic("duplicate", "newer", 3) });
  await restore({ action: "restore", subscription: { topic: "new", awaitRelease: true } });
  const before = await observed();
  assert.deepEqual(before.topics, [
    topic("duplicate", "newer", 3),
    initial[2],
    topic("new", "new state"),
  ]);
  assert.deepEqual(before.subscriptions, [{ topic: "new", awaitRelease: true }]);

  // The incoming request fits, but its long escaped ID makes an existing topic's reply too large.
  const longRequestId = '"'.repeat((MAX_FRAME_SIZE_BYTES - 1024) / 2);
  const denied = await restore({ action: "restore", topic: topic("not-committed") }, longRequestId);
  assert.match(text(denied.error), /message too large/);
  assert.deepEqual((await observed()).topics, before.topics);
  assert.deepEqual((await observed()).subscriptions, before.subscriptions);

  // Replacing the largest row must lower the cached maximum, not retain a false rejection.
  const correction = await restore(
    { action: "restore", topic: topic("largest", "small", 2) },
    longRequestId,
  );
  assert.equal(correction.error, undefined);
  const invalid = await restore({ action: "restore", topic: { ...topic("invalid"), revision: 0 } });
  assert.match(text(invalid.error), /Invalid topic change/);
  const final = await observed();
  assert.deepEqual(final.topics, [
    topic("duplicate", "newer", 3),
    topic("largest", "small", 2),
    topic("new", "new state"),
  ]);
  assert.deepEqual(final.subscriptions, before.subscriptions);

  writeMessage(socket, { type: "presence", status: "idle" });
  await request({ type: "list", requestId: "presence-barrier" });
  const identityUpdate = await observed();
  assert.equal(identityUpdate.status, "idle");
  assert.deepEqual(identityUpdate.topics, final.topics);
  assert.deepEqual(identityUpdate.subscriptions, final.subscriptions);

  // Explicit presence replacements must invalidate the byte cache for either record kind.
  const replacement = topic("replacement", "日".repeat(1000));
  writeMessage(socket, { type: "presence", topics: [replacement] });
  const topicLimit = await restore(
    { action: "restore", topic: topic("not-committed") },
    longRequestId,
  );
  assert.match(text(topicLimit.error), /message too large/);
  assert.deepEqual((await observed()).topics, [replacement]);
  await restore({ action: "restore", topic: topic("replacement", "small", 2) });
  const subscription = { topic: "s".repeat(3000), awaitRelease: true };
  writeMessage(socket, { type: "presence", subscriptions: [subscription] });
  const subscriptionLimit = await restore(
    { action: "restore", topic: topic("not-committed") },
    longRequestId,
  );
  assert.match(text(subscriptionLimit.error), /message too large/);
  const afterPresence = await observed();
  assert.deepEqual(afterPresence.topics, [topic("replacement", "small", 2)]);
  assert.deepEqual(afterPresence.subscriptions, [subscription]);
});

for (const outcome of [
  "complete",
  "broker-error",
  "topic",
  "subscription",
  "receipt",
  "identity",
  "disconnect",
] as const) {
  test(`multipart client snapshots stay private through ${outcome}`, async (t) => {
    isolatedAgent(t);
    let socket: net.Socket | undefined;
    let requestId: unknown;
    const identity = { id: "stream-peer", cwd: "/synthetic", model: "synthetic" };
    const first = topic("first"),
      second = topic("second");
    const server = net.createServer((peer) => {
      socket = peer;
      peer.on("error", () => {
        // The malformed-response cases intentionally close this peer.
      });
      peer.on(
        "data",
        createMessageReader(
          (value) => {
            const input = record(value);
            if (input.type === "register") {
              writeMessage(peer, {
                type: "registered",
                sessionId: "client-session",
                topicsSupported: true,
                topicFrames: true,
              });
            } else if (input.type === "list") {
              requestId = input.requestId;
              writeMessage(peer, {
                type: "sessions",
                requestId,
                sessions: [{ ...identity, topics: [], subscriptions: [] }],
                more: true,
              });
              writeMessage(peer, {
                type: "sessions",
                requestId,
                sessions: [{ id: identity.id, topics: [first], status: "busy" }],
                more: true,
              });
              writeMessage(peer, {
                type: "message",
                from: identity,
                message: {
                  id: "barrier",
                  timestamp: 1,
                  content: { text: "processed prior frames" },
                },
              });
            } else if (input.type === "unregister") {
              peer.end();
            }
          },
          (error) => {
            peer.destroy(error);
          },
        ),
      );
    });
    const serverPath = prepareBrokerSocketPath();
    await new Promise<void>((resolve) => {
      server.listen(serverPath, resolve);
    });
    const client = new IntercomClient();
    const errors: Error[] = [];
    client.on("error", (error: Error) => {
      errors.push(error);
    });
    t.after(async () => {
      await client.disconnect();
      socket?.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    });
    await client.connect({ cwd: "/client", model: "synthetic" });
    const barrier = once(client, "message");
    let settled = false;
    const result = client.updateTopics({ action: "subscribe", subscription: { topic: "first" } });
    const settlement = result.then(
      () => {
        settled = true;
        return;
      },
      () => {
        settled = true;
        return;
      },
    );
    await barrier;
    assert.equal(
      settled,
      false,
      "actual following-message delivery proves partial rows were consumed privately",
    );
    assertDefined(socket);
    if (outcome === "disconnect") {
      socket.destroy();
    } else if (outcome === "broker-error") {
      writeMessage(socket, {
        type: "sessions",
        requestId,
        sessions: [],
        error: "snapshot rejected",
      });
    } else {
      const rows: unknown[] = [
        {
          id: identity.id,
          topics: [second],
          subscriptions: [{ topic: "first", awaitRelease: true }],
        },
      ];
      const receipts: unknown[] = [
        {
          to: "recipient",
          id: "message",
          accepted: true,
          delivered: false,
          queued: true,
          reason: "queued",
        },
      ];
      if (outcome === "topic") {
        rows.push({ id: identity.id, topics: [{ ...second, text: "bad\u0000text" }] });
      }
      if (outcome === "subscription") {
        rows.push({ id: identity.id, subscriptions: [{ topic: "first", awaitRelease: "yes" }] });
      }
      if (outcome === "identity") {
        rows.push({ id: identity.id, cwd: "" });
      }
      if (outcome === "receipt") {
        receipts.push({ to: "recipient", id: "bad", accepted: "yes", delivered: false });
      }
      writeMessage(socket, { type: "sessions", requestId, sessions: rows, receipts, more: false });
    }
    if (outcome === "complete") {
      assert.deepEqual(await result, {
        sessions: [
          {
            ...identity,
            status: "busy",
            topics: [first, second],
            subscriptions: [{ topic: "first", awaitRelease: true }],
          },
        ],
        receipts: [
          {
            to: "recipient",
            id: "message",
            accepted: true,
            delivered: false,
            queued: true,
            reason: "queued",
          },
        ],
      });
      assert.deepEqual(errors, []);
    } else {
      await assert.rejects(
        result,
        outcome === "broker-error" ? /snapshot rejected/ : /disconnected|protocol error/i,
      );
      assert.equal(errors.length, outcome === "broker-error" || outcome === "disconnect" ? 0 : 1);
    }
    await settlement;
    assert.equal(settled, true);
  });
}
