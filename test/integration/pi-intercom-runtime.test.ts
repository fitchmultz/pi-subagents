import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { test as nodeTest, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { IntercomClient } from "../../src/pi-intercom/broker/client.ts";
import { MAX_FRAME_SIZE_BYTES } from "../../src/pi-intercom/broker/framing.ts";
import type { Message, SessionInfo } from "../../src/pi-intercom/types.ts";
import { array, record } from "../support/assertions.ts";

// Native SDK delivery/lifecycle contracts live in pi-intercom-native-replay.test.ts.
// These remaining contracts belong to the broker process, without an SDK session.
async function brokerFixture(t: TestContext) {
  const directory = mkdtempSync("/tmp/intercom-retirement-");
  const previous = process.env.PI_INTERCOM_RUNTIME_DIR;
  process.env.PI_INTERCOM_RUNTIME_DIR = directory;
  const clients: IntercomClient[] = [];
  const broker = spawn(process.execPath, ["src/pi-intercom/broker/broker.ts"], {
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(broker, "exit");
  t.after(async () => {
    await Promise.all(clients.map((client) => client.disconnect()));
    if (broker.exitCode === null && broker.signalCode === null) {
      broker.kill("SIGTERM");
    }
    await exited;
    if (previous === undefined) {
      delete process.env.PI_INTERCOM_RUNTIME_DIR;
    } else {
      process.env.PI_INTERCOM_RUNTIME_DIR = previous;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    broker.once("error", reject);
    broker.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("Intercom broker started")) {
        resolve();
      }
    });
    broker.once("exit", () => reject(new Error("Broker exited before readiness")));
  });
  return {
    exited,
    async client(name: string, presence: Partial<Omit<SessionInfo, "id" | "name">> = {}) {
      const client = new IntercomClient();
      clients.push(client);
      await client.connect({ name, cwd: path.resolve("."), model: "fixture", ...presence });
      return client;
    },
  };
}

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  // Every observation finishes before the next readiness poll.
  // oxlint-disable-next-line no-await-in-loop
  while (!(await check())) {
    assert.ok(Date.now() < deadline, "broker did not publish the expected state");
    // Back off after the actual observation, not instead of it.
    // oxlint-disable-next-line no-await-in-loop
    await sleep(5);
  }
}

nodeTest("broker exits when no session ever registers", { timeout: 10000 }, async (t) => {
  const fixture = await brokerFixture(t);
  const [code] = array(await fixture.exited);
  assert.equal(code, 0);
});

nodeTest(
  "broker returns a clean delivery failure when forwarding would exceed the frame cap",
  async (t) => {
    const fixture = await brokerFixture(t);
    const sender = await fixture.client("large-sender", {
      cwd: "c".repeat(300_000),
      model: "m".repeat(100_000),
    });
    const receiver = await fixture.client("large-receiver");
    for (const delivery of ["steer", "queue"] as const) {
      // Both immediate forwarding and replace staging must validate the expanded frame.
      // oxlint-disable-next-line no-await-in-loop
      const result = await sender.send("large-receiver", {
        text: "x".repeat(MAX_FRAME_SIZE_BYTES - 350_000),
        delivery,
        ...(delivery === "queue"
          ? { queueMode: "replace", threadId: "oversize", expectsReply: true }
          : {}),
      });
      assert.equal(result.accepted, false);
      assert.equal(result.delivered, false);
      assert.equal(result.queued, undefined);
      assert.match(result.reason ?? "", /message too large/i);
    }
    const received = once(receiver, "message");
    assert.equal(
      (await sender.send("large-receiver", { text: "healthy after rejection" })).accepted,
      true,
    );
    const delivered = record(array(await received)[1]);
    assert.equal(record(delivered.content).text, "healthy after rejection");
  },
);

nodeTest("invalid presence updates cannot poison peer session lists", async (t) => {
  const fixture = await brokerFixture(t);
  const bad = await fixture.client("bad-presence-peer");
  const healthy = await fixture.client("healthy-presence-peer");
  const disconnected = once(bad, "disconnected");
  bad.updatePresence({ name: "bad\u0001name", pendingAsks: 0.5 });
  await disconnected;
  assert.equal(bad.isConnected(), false);
  assert.deepEqual(
    (await healthy.listSessions()).map((peer) => peer.name),
    ["healthy-presence-peer"],
  );
});

nodeTest(
  "broker delivers every unique replace-mode thread beyond the former sender cap",
  async (t) => {
    const fixture = await brokerFixture(t);
    const sender = await fixture.client("replace-sender");
    const receiver = await fixture.client("replace-receiver", {
      status: "idle",
      acceptsAsks: true,
    });
    const received: string[] = [];
    receiver.on("message", (_from: SessionInfo, message: Message) => {
      received.push(message.id);
    });
    for (let index = 0; index < 101; index++) {
      // Preserve admission order independently for every thread.
      // oxlint-disable-next-line no-await-in-loop
      const result = await sender.send("replace-receiver", {
        messageId: `thread-${index}`,
        text: `update ${index}`,
        delivery: "queue",
        queueMode: "replace",
        threadId: `unique-${index}`,
      });
      assert.equal(result.queued, true);
    }
    await waitFor(() => received.length === 101);
    assert.deepEqual(
      received,
      Array.from({ length: 101 }, (_, index) => `thread-${index}`),
    );
  },
);

for (const expectsReply of [false, true]) {
  nodeTest(
    `broker-staged replace ${expectsReply ? "asks are dropped" : "delivery survives"} when sender disconnects`,
    async (t) => {
      const fixture = await brokerFixture(t);
      const sender = await fixture.client("departing-sender");
      const receiver = await fixture.client("disconnect-receiver", {
        status: "idle",
        acceptsAsks: true,
      });
      const control = await fixture.client("surviving-sender");
      const received: string[] = [];
      receiver.on("message", (_from: SessionInfo, message: Message) => {
        received.push(message.id);
      });
      assert.equal(
        (
          await sender.send("disconnect-receiver", {
            messageId: "superseded-message",
            text: "Old idle update",
            expectsReply,
            delivery: "queue",
            queueMode: "replace",
            threadId: "disconnect-window",
          })
        ).queued,
        true,
      );
      assert.equal(
        (
          await sender.send("disconnect-receiver", {
            messageId: "departing-message",
            text: "Accepted before departure",
            expectsReply,
            delivery: "queue",
            queueMode: "replace",
            threadId: "disconnect-window",
          })
        ).queued,
        true,
      );
      await sender.disconnect();
      await waitFor(
        async () =>
          !(await control.listSessions()).some((peer) => peer.name === "departing-sender"),
      );
      assert.equal(
        (
          await control.send("disconnect-receiver", {
            messageId: "surviving-control",
            text: "Later replace window processed",
            delivery: "queue",
            queueMode: "replace",
            threadId: "disconnect-window",
          })
        ).queued,
        true,
      );
      await waitFor(() => received.includes("surviving-control"));
      assert.deepEqual(
        received,
        expectsReply ? ["surviving-control"] : ["departing-message", "surviving-control"],
      );
    },
  );
}
