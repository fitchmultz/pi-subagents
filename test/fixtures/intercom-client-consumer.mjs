import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Run as an external ESM consumer, with no Pi SDK, provider or extension loader.
assert.equal(process.permission.has("child"), false, "subprocess creation is denied");
const hook = registerHooks({
  resolve(specifier, context, next) {
    assert.doesNotMatch(specifier, /@earendil-works\/|^typebox(?:\/|$)/);
    const result = next(specifier, context);
    assert.doesNotMatch(result.url, /\/dist\/(?:index|agent\/[^/]+)\.js$/);
    return result;
  },
});
const { connectIntercom } = await import("@fitchmultz/pi-subagents/intercom-client");
await assert.rejects(import("@fitchmultz/pi-subagents/dist/pi-intercom/broker/client.js"), {
  code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
});
const root = mkdtempSync(join(process.env.HOME, "client-"));
const runtime = process.env.PI_INTERCOM_RUNTIME_DIR;
/** @param {unknown} value */
function text(value) {
  assert.ok(typeof value === "string" && value.length > 0);
  return value;
}
const guard = {
  rootSessionId: text(process.env.S3_ROOT),
  peerId: text(process.env.S3_PEER),
  incarnation: text(process.env.S3_INCARNATION),
  applicationGuard: text(process.env.S3_GUARD),
};
const brokerPid = Number(process.env.S3_BROKER_PID);
assert.ok(Number.isSafeInteger(brokerPid) && brokerPid > 1 && brokerPid !== process.pid);
const options = Object.freeze({
  spawn: false,
  session: {
    name: "supported-consumer",
    cwd: process.cwd(),
    model: "non-model-client",
    rootSessionId: "supported-consumer-root",
    incarnation: "supported-consumer-incarnation",
  },
  sendTimeoutMs: 100,
});
let client;
try {
  process.env.PI_INTERCOM_RUNTIME_DIR = join(root, "absent");
  await assert.rejects(connectIntercom(options), /broker socket is unavailable/);
  assert.equal(
    existsSync(process.env.PI_INTERCOM_RUNTIME_DIR),
    false,
    "no broker or state created",
  );
  process.env.PI_INTERCOM_RUNTIME_DIR = runtime;
  await assert.rejects(connectIntercom({ ...options, spawn: true }), /requires spawn:false/);
  client = await connectIntercom(options);
  const senderId = client.sessionId;
  assert.ok(typeof senderId === "string" && senderId.length > 0);
  const peers = await client.listSessions();
  assert.ok(
    peers.some((peer) => peer.id === guard.peerId && peer.rootSessionId === guard.rootSessionId),
  );
  assert.equal(
    peers.some(
      (peer) =>
        peer.parentSessionId !== undefined && peer.rootSessionId !== options.session.rootSessionId,
    ),
    false,
  );

  const first = await client.last(guard.peerId, { limit: 6 });
  assert.ok("entryId" in first && first.entryId !== null);
  let page = first;
  let answer = first.text;
  while (page.nextOffset !== undefined) {
    // Follow the owner's UTF-16 cursor and immutable entry, not a newly selected answer.
    // oxlint-disable-next-line no-await-in-loop
    page = await client.last(guard.peerId, {
      entryId: first.entryId,
      offset: page.nextOffset,
      limit: 6,
    });
    assert.equal(page.entryId, first.entryId);
    answer += page.text;
  }
  assert.equal(answer, "PACKED_PARENT_COMPLETE");
  const messageId = "a1234567-1234-1234-1234-123456789abc";
  const replyHint = {
    tool: "publish_reply",
    commandId: "12345678-1234-1234-1234-123456789abc",
    commandFingerprint: "9".repeat(64),
  };
  const send = Object.freeze({
    messageId,
    text: "  Original sender 日本語 😀 e\u0301 é\n\tKeep spacing.  ",
    expectsReply: false,
    delivery: "passive",
    guard,
    replyHint,
  });
  await assert.rejects(client.send(guard.peerId, { ...send, guard: undefined }), /exact guarded/);
  /** @param {unknown} error */
  function failure(error) {
    assert.ok(error instanceof Error);
    return error;
  }
  process.kill(brokerPid, "SIGSTOP");
  try {
    const original = client.send(guard.peerId, send).catch(failure);
    const duplicate = await Promise.race([
      client.send(guard.peerId, send).catch(failure),
      delay(300, new Error("Duplicate send stayed pending")),
    ]);
    assert.ok(duplicate instanceof Error);
    assert.match(duplicate.message, /already has a pending send/);
    const unconfirmed = await original;
    assert.ok(unconfirmed instanceof Error);
    assert.match(unconfirmed.message, /Send timeout/);
  } finally {
    process.kill(brokerPid, "SIGCONT");
  }
  let received;
  const deadline = Date.now() + 5000;
  for (;;) {
    // A lost acknowledgement is reconciled by reads of the original ID, never another send.
    // oxlint-disable-next-line no-await-in-loop
    const result = await client.receipt(guard.peerId, {
      rootSessionId: guard.rootSessionId,
      messageId,
    });
    if ("receipt" in result && result.receipt.placementEntryId !== null) {
      received = result;
      break;
    }
    assert.ok(Date.now() < deadline, JSON.stringify(result));
    // oxlint-disable-next-line no-await-in-loop
    await delay(5);
  }
  assert.equal(received.receipt.messageId, messageId);
  assert.equal(received.receipt.rootSessionId, guard.rootSessionId);
  assert.deepEqual(received.receipt.sender, {
    peerId: senderId,
    rootSessionId: options.session.rootSessionId,
    incarnation: options.session.incarnation,
  });
  assert.equal(
    received.receipt.textSha256,
    "d3ab0909aef5d0126534b0b8aa180f8de20568930bdd76d5d46aa77b570d93c8",
  );
  assert.deepEqual(received.receipt.guard, guard);
  assert.deepEqual(received.receipt.replyHint, replyHint);
  assert.equal("text" in received.receipt, false);
  assert.equal(received.receipt.nativeHandoff, true);
  await client.disconnect();
  await client.disconnect();
  assert.equal(client.isConnected(), false);
  assert.equal(client.sessionId, null);
  await assert.rejects(client.listSessions(), /Not connected|disconnect/i);
  client = await connectIntercom(options);
  assert.deepEqual(
    await client.receipt(guard.peerId, { rootSessionId: guard.rootSessionId, messageId }),
    received,
    "a new connection reads the original sender's receipt without adopting or resending it",
  );
  console.log(
    "[supported-client] external packed ESM consumer: no SDK/model/spawn; pinned last, original-ID unknown reconciliation, native receipt and disconnect/reconnect passed",
  );
} finally {
  process.env.PI_INTERCOM_RUNTIME_DIR = runtime;
  await client?.disconnect();
  hook.deregister();
  rmSync(root, { recursive: true, force: true });
}
