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
import { array, assertDefined, json, record, text } from "../support/assertions.ts";
import type {
  LastMessageQuery,
  Message,
  SessionInfo,
  TopicUpdate,
} from "../../src/pi-intercom/types.ts";
import { nativePeerId } from "../../src/pi-intercom/session-targets.ts";

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

function topic(name: string, body = "current state", revision = 1): TopicUpdate {
  return { topic: name, text: body, event: "update", revision, updatedAt: 1 };
}

async function startBroker(t: TestContext): Promise<void> {
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
}

test("broker restores transactionally with exact cached frame limits and ordered records", async (t) => {
  isolatedAgent(t);
  const observer = new IntercomClient();
  observer.on("error", (error: Error) => assert.fail(error.message));
  // After hooks run in registration order; disconnect before the broker shutdown below.
  t.after(() => observer.disconnect());
  await startBroker(t);
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
  await observer.connect({ cwd: "/observer", model: "synthetic" });
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
  const legacy = await request({ type: "list", requestId: "presence-barrier", stream: false });
  assert.equal(array(legacy.sessions).length, 2);
  for (const row of array(legacy.sessions)) {
    assert.equal(Object.hasOwn(record(row), "topics"), false);
    assert.equal(Object.hasOwn(record(row), "subscriptions"), false);
  }
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
    const identity = {
      ...record(json('{"__proto__":{"pendingAsks":99},"snapshotExtension":{"retained":true}}')),
      id: "stream-peer",
      cwd: "/synthetic",
      model: "synthetic",
    };
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
    if (outcome === "complete") {
      await assert.rejects(client.last("old-peer"), /does not support last-message reads/);
      await assert.rejects(
        client.send("old-peer", {
          messageId: "guarded-on-old-broker",
          text: "must not be sent without negotiation",
          expectsReply: false,
          guard: {
            peerId: "old-peer",
            rootSessionId: "old-root",
            incarnation: "old-context",
            applicationGuard: "consent-1",
          },
        }),
        /does not support guarded delivery/,
      );
    }
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
      const snapshot = await result;
      const session = snapshot.sessions[0];
      assert.equal(Object.getPrototypeOf(session), Object.prototype);
      assert.equal(Object.hasOwn(session, "__proto__"), true);
      assert.deepEqual(Object.getOwnPropertyDescriptor(session, "__proto__")?.value, {
        pendingAsks: 99,
      });
      assert.equal("pendingAsks" in session, false);
      assert.deepEqual(snapshot, {
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

test("last-message frames correlate concurrent pages without using direct-message delivery", async (t) => {
  isolatedAgent(t);
  await startBroker(t);
  const requester = new IntercomClient();
  const owner = new IntercomClient();
  const other = new IntercomClient();
  for (const client of [requester, owner, other]) {
    client.on("error", (error: Error) => assert.fail(error.message));
    client.on("message", () => assert.fail("A last read must not use the model delivery path"));
  }
  try {
    await requester.connect({ name: "reader", cwd: "/reader", model: "fixture" });
    const identity = { name: "owner", cwd: "/owner", model: "fixture", status: "thinking" };
    await owner.connect(identity);
    await other.connect({ name: "other", cwd: "/other", model: "fixture" });
    assertDefined(owner.sessionId);
    const session = { ...identity, id: owner.sessionId };
    const requests: Array<{ requestId: string; from: SessionInfo; query: LastMessageQuery }> = [];
    const forwarded = new EventEmitter();
    const bothForwarded = once(forwarded, "ready");
    owner.on("last_request", (request: (typeof requests)[number]) => {
      requests.push(request);
      if (requests.length === 2) {
        forwarded.emit("ready");
      }
    });
    const pending = [
      requester.last(owner.sessionId, { limit: 4 }),
      requester.last(owner.sessionId, { entryId: "entry-a", offset: 4, limit: 4 }),
    ];
    await bothForwarded;
    // An observed response on the forger's socket proves the broker processed its earlier forgery.
    other.respondLast(requests[1].requestId, { error: "forged response" });
    await other.listSessions();
    owner.respondLast(requests[1].requestId, {
      session,
      entryId: "entry-a",
      text: "tail",
      offset: 4,
      totalLength: 8,
    });
    owner.respondLast(requests[0].requestId, {
      session,
      entryId: "entry-a",
      text: "head",
      offset: 0,
      totalLength: 8,
      nextOffset: 4,
    });
    const [head, tail] = await Promise.all(pending);
    assert.deepEqual(head, {
      session,
      entryId: "entry-a",
      text: "head",
      offset: 0,
      totalLength: 8,
      nextOffset: 4,
    });
    assert.deepEqual(tail, {
      session,
      entryId: "entry-a",
      text: "tail",
      offset: 4,
      totalLength: 8,
    });
    assert.equal(requests.length, 2);
    assert.equal(requests[0].from.id, requester.sessionId);
    assert.notEqual(requests[0].requestId, requests[1].requestId);
    assert.deepEqual(await requester.last("missing"), { error: "Session not found" });
    assert.deepEqual(await requester.last(other.sessionId ?? ""), {
      error: "Recipient has no last-message reader.",
    });
    await assert.rejects(
      requester.last(owner.sessionId, { limit: 16385 }),
      /Invalid last-message query/,
    );

    owner.removeAllListeners("last_request");
    const escapedPage = "\0".repeat(16384);
    owner.on("last_request", (request: (typeof requests)[number]) => {
      owner.respondLast(request.requestId, {
        session,
        entryId: "escaped",
        text: escapedPage,
        offset: 0,
        totalLength: 16384,
      });
    });
    assert.deepEqual(await requester.last(owner.sessionId), {
      session,
      entryId: "escaped",
      text: escapedPage,
      offset: 0,
      totalLength: 16384,
    });

    owner.removeAllListeners("last_request");
    owner.on("last_request", (request: (typeof requests)[number]) => {
      owner.respondLast(request.requestId, {
        session,
        entryId: "wrong-entry",
        text: "tail",
        offset: 4,
        totalLength: 8,
      });
    });
    assert.deepEqual(await requester.last(owner.sessionId, { entryId: "entry-a", offset: 4 }), {
      error: "Recipient returned an invalid last-message page",
    });
    owner.removeAllListeners("last_request");
    const dispatched = once(owner, "last_request");
    const disconnected = requester.last(owner.sessionId);
    await dispatched;
    await owner.disconnect();
    assert.deepEqual(await disconnected, { error: "Peer disconnected during last-message read" });
  } finally {
    await Promise.all([requester.disconnect(), owner.disconnect(), other.disconnect()]);
  }
});

test("guarded broker sends bind one exact main context while ordinary names remain usable", async (t) => {
  isolatedAgent(t);
  await startBroker(t);
  const clients: IntercomClient[] = [];
  const connect = async (incarnation?: string, rootSessionId = "original-root") => {
    const client = new IntercomClient();
    clients.push(client);
    client.on("error", (error: Error) => assert.fail(error.message));
    await client.connect(
      {
        name: rootSessionId === "original-root" ? "ordinary-name" : rootSessionId,
        cwd: "/fixture",
        model: "fixture",
        rootSessionId,
        ...(incarnation !== undefined
          ? ({ incarnation, guardedDelivery: 1, applicationGuard: "consent-1" } as const)
          : {}),
      },
      nativePeerId(rootSessionId),
    );
    return client;
  };
  try {
    const sender = await connect(undefined, "sender-root");
    const owner = await connect("context-1");
    const peerId = text(owner.sessionId);
    const guard = {
      rootSessionId: "original-root",
      peerId,
      incarnation: "context-1",
      applicationGuard: "consent-1",
    };
    const options = {
      text: "original command",
      expectsReply: false,
      delivery: "passive",
      guard,
    } as const;
    const messages: Message[] = [];
    owner.on("message", (_from: SessionInfo, message: Message) => {
      messages.push(message);
    });
    const accepted = await sender.send(peerId, { ...options, messageId: "original-command" });
    assert.equal(accepted.delivered, true);
    await owner.listSessions();
    assert.equal(messages.length, 1);
    assert.equal(messages[0].id, "original-command");
    for (const changed of [
      { ...guard, rootSessionId: "wrong-root" },
      { ...guard, incarnation: "stale-context" },
      { ...guard, applicationGuard: "stale-consent" },
      { ...guard, peerId: "wrong-peer" },
    ]) {
      // Each response is the real broker's negative admission, not a client predicate.
      // oxlint-disable-next-line no-await-in-loop
      const denied = await sender.send(peerId, {
        ...options,
        guard: changed,
        messageId: JSON.stringify(changed),
      });
      assert.equal(denied.accepted, false);
    }
    assert.equal(
      (await sender.send("ordinary-name", { ...options, messageId: "guarded-name" })).accepted,
      false,
    );
    const duplicate = await connect("duplicate-context");
    assert.notEqual(duplicate.sessionId, peerId);
    assert.equal(
      (await sender.send(peerId, { ...options, messageId: "ambiguous-root" })).reason,
      "Guarded root is ambiguous",
    );
    await duplicate.disconnect();
    await owner.disconnect();
    const replacement = await connect("context-2");
    assert.equal(replacement.sessionId, peerId, "a later context can reuse a requested peer ID");
    const replacementMessages: unknown[] = [];
    replacement.on("message", (...message: unknown[]) => {
      replacementMessages.push(message);
    });
    assert.equal(
      (await sender.send(peerId, { ...options, messageId: "old-handle" })).reason,
      "Guarded target changed",
    );
    assert.equal(
      (await sender.send("ordinary-name", { text: "ordinary local send", messageId: "ordinary" }))
        .delivered,
      true,
      "ordinary convenience names still work",
    );
    await sender.disconnect();
    const ordinary = once(replacement, "message");
    const legacy = await connect(undefined, "legacy-root");
    assert.equal((await legacy.send(peerId, { text: "ordinary local send" })).delivered, true);
    await ordinary;
    await replacement.listSessions();
    assert.equal(replacementMessages.length, 2, "no stale guarded command reached the replacement");
    assert.equal(
      (
        await legacy.send(peerId, {
          ...options,
          guard: { ...guard, incarnation: "context-2" },
          messageId: "fresh-handle",
        })
      ).accepted,
      true,
    );
    assert.equal(
      (
        await replacement.send(text(legacy.sessionId), {
          ...options,
          guard: {
            rootSessionId: "legacy-root",
            peerId: text(legacy.sessionId),
            incarnation: "missing",
            applicationGuard: "consent-1",
          },
          messageId: "legacy-recipient",
        })
      ).reason,
      "Recipient does not support guarded delivery",
    );
  } finally {
    await Promise.all(clients.map((client) => client.disconnect()));
  }
});

test("collaboration lineage restricts discovery and all delivery paths at the broker", async (t) => {
  isolatedAgent(t);
  await startBroker(t);
  const clients: IntercomClient[] = [];
  const connect = async (
    native: string,
    rootSessionId?: string,
    parentSessionId?: string,
    name = native,
  ) => {
    const client = new IntercomClient();
    client.on("error", () => {
      /* Invalid registrations below close their own sockets. */
    });
    clients.push(client);
    await client.connect(
      { name, cwd: `/projects/${native}`, model: "fixture", rootSessionId, parentSessionId },
      nativePeerId(native),
    );
    return client;
  };
  try {
    const main = await connect("main-a", "main-a");
    const child = await connect("child-a", "main-a", "main-a");
    const sibling = await connect("sibling-a", "main-a", "main-a", "worker");
    const otherMain = await connect("main-b", "main-b");
    const otherChild = await connect("child-b", "main-b", "main-b", "worker");
    const legacy = await connect("legacy");
    const ids = async (client: IntercomClient) =>
      new Set((await client.listSessions()).map((session) => session.id));
    assert.deepEqual(
      await ids(main),
      new Set([
        main.sessionId,
        child.sessionId,
        sibling.sessionId,
        otherMain.sessionId,
        legacy.sessionId,
      ]),
    );
    assert.deepEqual(
      await ids(child),
      new Set([main.sessionId, child.sessionId, sibling.sessionId]),
    );
    assert.deepEqual(
      await ids(legacy),
      new Set([main.sessionId, otherMain.sessionId, legacy.sessionId]),
    );
    const delivered = once(sibling, "message");
    const receipt = await child.send("worker", { text: "visible sibling only" });
    assert.equal(receipt.delivered, true, "hidden duplicate names must not create ambiguity");
    const payload = await delivered;
    assert.equal(record(payload[0]).id, child.sessionId);
    const forbidden = await child.send(otherMain.sessionId ?? "", { text: "forbidden" });
    assert.equal(forbidden.accepted, false);
    assert.equal(forbidden.reason, "Session not found");
    assert.equal(
      (await main.send(otherChild.sessionId ?? "", { text: "foreign child" })).reason,
      "Session not found",
    );

    let lastRequests = 0;
    otherChild.on("last_request", () => {
      lastRequests += 1;
    });
    assert.deepEqual(await main.last(otherChild.sessionId ?? ""), { error: "Session not found" });
    await otherChild.listSessions(); // Real recipient socket barrier after the denied broker request.
    assert.equal(lastRequests, 0);
    const messages: unknown[] = [];
    child.on("message", (...event: unknown[]) => {
      messages.push(event);
    });
    await child.updateTopics({ action: "subscribe", subscription: { topic: "coordination" } });
    await otherChild.updateTopics({
      action: "publish",
      topic: topic("coordination", "foreign private state"),
    });
    await child.listSessions(); // Publication accepted and the recipient processed a later broker response.
    assert.deepEqual(messages, []);
    const publication = once(child, "message");
    await sibling.updateTopics({
      action: "publish",
      topic: topic("coordination", "same-group state"),
    });
    await publication;

    // A peer cannot switch its collaboration group through a presence frame.
    assertDefined(child.sessionId);
    const raw = net.connect(prepareBrokerSocketPath());
    raw.on("error", (error: Error) => assert.fail(error.message));
    try {
      await once(raw, "connect");
      const events = new EventEmitter();
      raw.on(
        "data",
        createMessageReader(
          (value) => {
            events.emit("frame", value);
          },
          (error) => {
            raw.destroy(error);
          },
        ),
      );
      const registered = once(events, "frame");
      writeMessage(raw, {
        type: "register",
        session: {
          cwd: "/raw",
          model: "fixture",
          rootSessionId: "main-a",
          parentSessionId: "main-a",
        },
      });
      const registration = record((await registered)[0]);
      assert.deepEqual(await main.last(text(registration.sessionId)), {
        error: "Recipient does not support last-message reads; reload its extension.",
      });
      writeMessage(raw, { type: "presence", rootSessionId: "main-b", parentSessionId: "main-b" });
      const listed = once(events, "frame");
      writeMessage(raw, { type: "list", requestId: "pinned-lineage" });
      const snapshot = record((await listed)[0]);
      const visible = array(snapshot.sessions).map((session) => record(session));
      assert.equal(
        visible.some((session) => session.id === otherMain.sessionId),
        false,
      );
      assert.equal(
        visible.some((session) => session.id === main.sessionId),
        true,
      );
      const rawLeft = once(child, "session_left");
      raw.destroy();
      await rawLeft;
    } finally {
      raw.destroy();
    }
    await assert.rejects(connect("nested", "child-a", "child-a"), /disconnected|protocol|closed/i);
    await assert.rejects(
      connect("invalid", "main-a", "other-parent"),
      /disconnected|protocol|closed/i,
    );
    const left: string[] = [];
    child.on("session_left", (id: string) => {
      left.push(id);
    });
    await otherChild.disconnect();
    await child.listSessions();
    assert.deepEqual(left, [], "hidden disconnects must not expose foreign child IDs");
    const parentLeft = once(child, "session_left");
    await main.disconnect();
    await parentLeft;
    assert.deepEqual(await ids(child), new Set([child.sessionId, sibling.sessionId]));
    await sibling.listSessions();
  } finally {
    await Promise.all(clients.map((client) => client.disconnect()));
  }
});
