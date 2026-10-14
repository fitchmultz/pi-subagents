import "../support/isolated-home.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import {
  chmodSync,
  mkdirSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
  watch,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { X509Certificate } from "node:crypto";
import { IntercomClient } from "../../src/pi-intercom/broker/client.ts";
import { getBrokerSocketPath } from "../../src/pi-intercom/broker/paths.ts";
import { normalizeMessage, normalizeSessionInfo } from "../../src/pi-intercom/types.ts";
import { hasErrorCode, errorMessage, type UnknownRecord } from "../../src/shared/unknown.ts";
import { exec, start, stop, parseCredential, bridgeApi } from "../support/intercom-bridge.ts";
import { assertDefined, json, readJson, record, records, text } from "../support/assertions.ts";

function envelope(value: unknown) {
  const input = record(value);
  const from = normalizeSessionInfo(input.from);
  const message = normalizeMessage(input.message);
  assert.ok(from, "Expected broker sender metadata");
  assert.ok(message, "Expected broker message");
  return { from, message };
}
function messages(body: UnknownRecord) {
  return records(body.messages).map(envelope);
}
const repo = resolve(import.meta.dirname, "../..");

function nextMessage(client: Readonly<IntercomClient>) {
  return once(client, "message").then((args: readonly unknown[]) =>
    envelope({ from: args[0], message: args[1] }),
  );
}

test(
  "real mTLS bridge admits only messaging, preserves peer identity and cancels waits",
  { timeout: 90000 },
  async (t) => {
    const root = mkdtempSync("/tmp/pib-");
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");
    const env = { ...process.env, HOME: root, TMPDIR: root, TMP: root, TEMP: root };
    // Keep this process's socket discovery consistent with its isolated broker.
    const previousTmp = process.env.TMPDIR;
    process.env.TMPDIR = root;
    const credentials = join(root, "credentials");
    const project = join(root, "future-project");
    const tools = join(repo, "scripts/intercom-bridge-credentials.mjs");
    const runTool = async (...args: readonly string[]) =>
      json((await exec(process.execPath, [tools, ...args], { env })).stdout);
    let broker: ReturnType<typeof start> | undefined;
    let bridge: ReturnType<typeof start> | undefined;
    const clients: IntercomClient[] = [];
    const agent = async (name: string) => {
      const client = new IntercomClient();
      client.on("error", () => {
        /* Broker outage is asserted through the bridge API below. */
      });
      clients.push(client);
      await client.connect({
        name,
        cwd: root,
        model: "fixture",
        status: "idle",
        acceptsAsks: true,
      });
      return client;
    };
    try {
      const credential = parseCredential(
        await runTool(
          "init",
          credentials,
          "grok-bot",
          "--cwd",
          project,
          "--port",
          "0",
          "--days",
          "3650",
        ),
      );
      const unpinned = parseCredential(await runTool("issue", credentials, "unapproved"));
      const configPath = join(credentials, "config.json");
      const config = record(readJson(configPath));
      config.clients = records(config.clients).filter((client) => client.name === "grok-bot");
      assert.equal(config.port, 0, "each bridge can choose its own loopback port");
      assert.ok(
        Date.parse(new X509Certificate(readFileSync(credential.cert)).validTo) - Date.now() >
          9 * 365 * 24 * 60 * 60 * 1000,
        "explicit unattended credentials can remain valid for ten years",
      );
      writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
      broker = start("src/pi-intercom/broker/broker.ts", [], env);
      await broker.wait(/Intercom broker started/);
      const peer = await agent("known-peer");
      const intruder = await agent("wrong-replier");
      bridge = start("src/pi-intercom/bridge.ts", ["--config", configPath], env);
      const activeBridge = bridge;
      const activeBroker = broker;
      const { url, api, host } = await bridgeApi(activeBridge, credential);
      assert.equal(host, "127.0.0.1");

      await t.test("mutual authentication, least privilege and real remote CLI", async () => {
        await assert.rejects(api("list", undefined, { cert: undefined, key: undefined }));
        await assert.rejects(
          api("list", undefined, {
            cert: readFileSync(unpinned.cert),
            key: readFileSync(unpinned.key),
          }),
        );
        const registered = await api("register", {});
        assert.equal(registered.body.name, "grok-bot");
        const remoteId = text(registered.body.sessionId);
        const remotePeer = (await peer.listSessions()).find((row) => row.id === remoteId);
        assert.equal(remotePeer?.name, "grok-bot");
        assert.equal(remotePeer.cwd, project);
        assert.equal(statSync(getBrokerSocketPath()).mode & 0o777, 0o600);
        for (const [action, body] of [
          ["register", { name: "spoofed" }],
          ["send", { to: peer.sessionId, message: "unsafe", type: "unregister" }],
          ["presence", {}],
          ["send", { to: peer.sessionId, message: "bad\u001bcontrol" }],
          ...[null, "true", 1, {}, []].map(
            (passive) =>
              ["send", { to: peer.sessionId, message: "invalid passive flag", passive }] as const,
          ),
          ["ask", { to: peer.sessionId, message: "invalid passive ask", passive: true }],
          ["reply", { replyTo: "missing", message: "invalid passive reply", passive: true }],
        ] as const) {
          // Each rejection is acknowledged before the next security case is sent.
          // oxlint-disable-next-line no-await-in-loop
          const rejected = await api(action, body);
          assert.ok(rejected.status >= 400, JSON.stringify(rejected));
        }
        const labelDenied = await api("send", { to: "known-peer\u0007", message: "hello" });
        assert.equal(labelDenied.status, 400);
        assert.equal(record(labelDenied.body.error).code, "invalid_input");
        const originDenied = await api("list", undefined, {
          headers: { Origin: "https://evil.example" },
        });
        assert.equal(originDenied.status, 403);
        const cliEnv = {
          ...env,
          INTERCOM_BRIDGE_URL: url,
          INTERCOM_BRIDGE_CA: credential.ca,
          INTERCOM_BRIDGE_CERT: credential.cert,
          INTERCOM_BRIDGE_KEY: credential.key,
        };
        const result = json(
          (
            await exec(process.execPath, [join(repo, "scripts/intercom-remote.mjs"), "list"], {
              env: cliEnv,
            })
          ).stdout,
        );
        assert.equal(result.ok, true);
        assert.equal(
          records(result.sessions).find((row) => row.id === peer.sessionId)?.name,
          "known-peer",
        );
        assert.ok(
          records(result.sessions).every(
            (row) => row.topics === undefined && row.subscriptions === undefined,
          ),
        );
        const receiving = nextMessage(peer);
        const sent = await api("send", {
          to: text(peer.sessionId).slice(0, 8),
          message: "BODY_SENTINEL_NOT_FOR_LOGS",
        });
        assert.equal(sent.body.accepted, true);
        const received = await receiving;
        assert.equal(received.from.id, remoteId);
        assert.equal(received.message.delivery, "steer");
        for (const passive of [false, true]) {
          const incoming = nextMessage(peer);
          // oxlint-disable-next-line no-await-in-loop
          const receipt = await api("send", {
            to: peer.sessionId,
            message: `HTTP passive=${passive}`,
            passive,
          });
          assert.equal(receipt.body.accepted, true);
          // oxlint-disable-next-line no-await-in-loop
          const delivered = await incoming;
          assert.equal(delivered.message.id, receipt.body.id);
          assert.equal(delivered.message.delivery, passive ? "passive" : "steer");
          assert.equal(delivered.message.content.text, `HTTP passive=${passive}`);
        }
        const passiveIncoming = nextMessage(peer);
        const passiveReceipt = json(
          (
            await exec(
              process.execPath,
              [
                join(repo, "scripts/intercom-remote.mjs"),
                "send",
                "--passive",
                "--to",
                text(peer.sessionId),
                "--message",
                "CLI passive\nexact text",
              ],
              { env: cliEnv },
            )
          ).stdout,
        );
        assert.equal(passiveReceipt.accepted, true);
        const passiveMessage = await passiveIncoming;
        assert.equal(passiveMessage.message.id, passiveReceipt.id);
        assert.equal(passiveMessage.message.delivery, "passive");
        assert.equal(passiveMessage.message.content.text, "CLI passive\nexact text");
        await assert.rejects(
          exec(process.execPath, [join(repo, "scripts/intercom-remote.mjs"), "ask", "--passive"], {
            env: cliEnv,
          }),
          /Unexpected arguments for this action/,
        );
        assert.equal((await api("send", { to: "offline-peer", message: "hello" })).status, 404);
      });

      await t.test(
        "asks correlate exact sender and replyTo; inbox is non-destructive and replies cannot spoof targets",
        async () => {
          let settled = false;
          const receiving = nextMessage(peer);
          const asking = api("ask", { to: "known-peer", message: "ASK_SENTINEL", timeoutMs: 5000 });
          const observedAsking = asking.then((answer) => {
            settled = true;
            return answer;
          });
          const question = await receiving;
          assert.equal(question.message.expectsReply, true);
          assert.equal(question.message.delivery, "steer");
          const forged = await intruder.send(question.from.id, {
            text: "forged answer",
            replyTo: question.message.id,
          });
          await activeBridge.wait(new RegExp(`"messageId":"${forged.id}"`));
          const inbox = await api("inbox");
          assert.ok(
            messages(inbox.body).some((item) => item.message.content.text === "forged answer"),
          );
          assert.equal(settled, false, "wrong sender must not satisfy the outgoing ask");
          await peer.send(question.from.id, {
            text: "bridge-smoke-ok",
            replyTo: question.message.id,
          });
          const answer = await observedAsking;
          assert.equal(envelope(answer.body.reply).from.id, peer.sessionId);
          assert.equal(envelope(answer.body.reply).message.content.text, "bridge-smoke-ok");
          assert.equal((await api("reply", { replyTo: "invented", message: "spoof" })).status, 404);
          const inbound = await peer.send(question.from.id, {
            text: "Local question",
            expectsReply: true,
            delivery: "steer",
          });
          const first = await api("inbox");
          assert.ok(messages(first.body).some((item) => item.message.id === inbound.id));
          assert.deepEqual((await api("inbox")).body.messages, first.body.messages);
          await api("ack", { ids: [inbound.id] });
          assert.ok(
            messages((await api("inbox")).body).some((item) => item.message.id === inbound.id),
          );
          const replyReceipt = nextMessage(peer);
          const reply = await api("reply", { replyTo: inbound.id, message: "Remote decision" });
          assert.equal(reply.body.accepted, true);
          const observed = await replyReceipt;
          assert.equal(observed.message.replyTo, inbound.id);
          assert.equal(observed.message.content.text, "Remote decision");
          assert.ok(
            !messages((await api("inbox")).body).some((item) => item.message.id === inbound.id),
          );
          const notice = await peer.send(question.from.id, { text: "ordinary message" });
          assert.ok(
            messages((await api("inbox")).body).some((item) => item.message.id === notice.id),
          );
          await api("ack", { ids: [notice.id] });
          assert.ok(
            !messages((await api("inbox")).body).some((item) => item.message.id === notice.id),
          );
        },
      );

      await t.test(
        "bounded input and inbox report overflow without losing retained messages",
        async () => {
          const rejected = await api("send", { to: peer.sessionId, message: "x".repeat(65536) });
          assert.equal(rejected.status, 413);
          const remoteId = text((await api("register", {})).body.sessionId);
          const before = await api("inbox");
          let lastId = "";
          for (let index = messages(before.body).length; index <= 256; index++) {
            // Broker acknowledgements bound each publication and preserve inbox fill order.
            // oxlint-disable-next-line no-await-in-loop
            lastId = (await peer.send(remoteId, { text: `bounded notice ${index}` })).id;
          }
          await activeBridge.wait(new RegExp(`"messageId":"${lastId}"`));
          const full = await api("inbox");
          assert.equal(messages(full.body).length, 256);
          assert.equal(full.body.overflow, true);
          assert.equal(full.body.lostMessages, 1);
          assert.equal(
            (await peer.listSessions()).find((row) => row.id === remoteId)?.acceptsAsks,
            false,
          );
          await api("ack", { ids: messages(full.body).map((item) => item.message.id) });
          assert.equal(messages((await api("inbox")).body).length, 0);
        },
      );

      await t.test(
        "timeout, peer departure, client cancellation and broker outage do not hang",
        async () => {
          const timed = await api("ask", {
            to: peer.sessionId,
            message: "no answer",
            timeoutMs: 100,
          });
          assert.equal(timed.status, 504);
          assert.equal(record(timed.body.error).code, "ask_timeout");
          const temporary = await agent("leaving-peer");
          const receiving = nextMessage(temporary);
          const asking = api("ask", {
            to: temporary.sessionId,
            message: "leave now",
            timeoutMs: 10000,
          });
          await receiving;
          await temporary.disconnect();
          assert.equal(record((await asking).body.error).code, "peer_offline");
          const volatileNotice = await peer.send(text((await api("register", {})).body.sessionId), {
            text: "legacy volatile lease loss",
          });
          await activeBridge.wait(new RegExp(`"messageId":"${volatileNotice.id}"`));
          const controller = new AbortController();
          const cancelMessage = nextMessage(peer);
          const cancelled = api(
            "ask",
            { to: peer.sessionId, message: "cancel now", timeoutMs: 10000 },
            { signal: controller.signal },
          );
          const cancelledQuestion = await cancelMessage;
          const offset = activeBridge.output().length;
          controller.abort();
          await assert.rejects(cancelled);
          await activeBridge.wait(
            /"event":"session_closed".*"name":"grok-bot".*"result":"client_aborted"/,
            offset,
          );
          const afterCancel = await api("register", {});
          assert.equal(afterCancel.body.ok, true, JSON.stringify(afterCancel));
          assert.equal(
            afterCancel.body.sessionId,
            cancelledQuestion.from.id,
            "re-register preserves the certificate-bound broker identity",
          );
          const afterLoss = (await api("inbox")).body;
          assert.equal(messages(afterLoss).length, 0);
          assert.equal(
            afterLoss.lostMessages,
            2,
            "legacy overflow plus cancellation loss remain visible",
          );
          await stop(activeBroker.child);
          const down = await api("list");
          assert.equal(down.status, 503);
          assert.equal(record(down.body.error).code, "broker_unavailable");
          broker = start("src/pi-intercom/broker/broker.ts", [], env);
          await broker.wait(/Intercom broker started/);
          await peer.connect({ name: "known-peer", cwd: root, model: "fixture", status: "idle" });
          assert.equal((await api("list")).body.ok, true);
        },
      );

      await t.test(
        "credential rotation and revoke cancel in-flight asks and deny the old certificate",
        async () => {
          const receiving = nextMessage(peer);
          const asking = api("ask", {
            to: peer.sessionId,
            message: "revoke during wait",
            timeoutMs: 10000,
          }).catch((error: unknown) => ({ transport: error }));
          await receiving;
          const rotated = parseCredential(await runTool("issue", credentials, "grok-bot"));
          activeBridge.child.kill("SIGHUP");
          await activeBridge.wait(/"event":"allowlist_reloaded"/);
          await asking; // Revocation may terminate TLS before an HTTP error can be read.
          await assert.rejects(api("list"));
          const newTls = { cert: readFileSync(rotated.cert), key: readFileSync(rotated.key) };
          assert.equal((await api("register", {}, newTls)).body.name, "grok-bot");
          await runTool("revoke", credentials, "grok-bot");
          activeBridge.child.kill("SIGHUP");
          // Use an actual new request as the authorization barrier, not a sleep.
          await activeBridge.wait(/"clients":0/);
          await assert.rejects(api("list", undefined, newTls));
          const rows = await peer.listSessions();
          assert.ok(!rows.some((row) => row.name === "grok-bot"));
          const renewed = parseCredential(await runTool("issue", credentials, "grok-bot"));
          let offset = activeBridge.output().length;
          activeBridge.child.kill("SIGHUP");
          await activeBridge.wait(/"event":"allowlist_reloaded"/, offset);
          const renewedTls = { cert: readFileSync(renewed.cert), key: readFileSync(renewed.key) };
          assert.equal((await api("register", {}, renewedTls)).body.ok, true);
          writeFileSync(configPath, '{"clients":', { mode: 0o600 });
          offset = activeBridge.output().length;
          activeBridge.child.kill("SIGHUP");
          await activeBridge.wait(/"result":"failed_closed"/, offset);
          await assert.rejects(api("list", undefined, renewedTls));
          assert.ok(!activeBridge.output().includes("BODY_SENTINEL_NOT_FOR_LOGS"));
          assert.ok(!activeBridge.output().includes("ASK_SENTINEL"));
          for (const line of activeBridge.output().trim().split("\n")) {
            assert.doesNotThrow(() => JSON.parse(line));
          }
        },
      );
    } finally {
      await Promise.all(clients.map((client) => client.disconnect()));
      if (bridge) {
        await stop(bridge.child);
      }
      if (broker) {
        await stop(broker.child);
      }
      if (previous === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previous;
      }
      if (previousTmp === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = previousTmp;
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "persistent mailbox survives restart, lease, broker outage and bounded paging",
  { timeout: 60000 },
  async (t) => {
    const root = mkdtempSync("/tmp/pib-mailbox-");
    const previous = process.env.PI_CODING_AGENT_DIR;
    const previousTmp = process.env.TMPDIR;
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");
    process.env.TMPDIR = root;
    const env = { ...process.env, HOME: root, TMP: root, TEMP: root };
    const peer = new IntercomClient();
    peer.on("error", () => {
      /* Broker outage is verified through mailbox reads below. */
    });
    let broker: ReturnType<typeof start> | undefined;
    let bridge: ReturnType<typeof start> | undefined;
    try {
      const credential = parseCredential(
        json(
          (
            await exec(
              process.execPath,
              [
                join(repo, "scripts/intercom-bridge-credentials.mjs"),
                "init",
                join(root, "keys"),
                "--cwd",
                root,
              ],
              { env },
            )
          ).stdout,
        ),
      );
      const configPath = join(root, "keys/config.json");
      const config = record(readJson(configPath));
      config.port = 0;
      config.stateDir = join(root, "mailbox");
      mkdirSync(text(config.stateDir), { mode: 0o700 });
      writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
      broker = start("src/pi-intercom/broker/broker.ts", [], env);
      await broker.wait(/Intercom broker started/);
      await peer.connect({ name: "saved-sender", cwd: root, model: "fixture" });
      bridge = start("src/pi-intercom/bridge.ts", ["--config", configPath], env);
      const first = await bridgeApi(bridge, credential);
      const remoteId = text((await first.api("register", {})).body.sessionId);
      const notice = await peer.send(remoteId, { text: "keep through cold restart" });
      const question = await peer.send(remoteId, { text: "saved obligation", expectsReply: true });
      await bridge.wait(new RegExp(`"messageId":"${question.id}"`));
      const received = messages((await first.api("inbox")).body);
      assert.deepEqual(
        received.map((item) => item.message.id),
        [notice.id, question.id],
      );
      const exited = once(bridge.child, "close");
      bridge.child.kill("SIGKILL");
      await exited;
      bridge = start("src/pi-intercom/bridge.ts", ["--config", configPath], env);
      const restarted = await bridgeApi(bridge, credential);
      assert.deepEqual(messages((await restarted.api("inbox")).body), received);
      let api = restarted.api;
      const mailboxPath = join(
        text(config.stateDir),
        `${credential.fingerprint256.replaceAll(":", "").toUpperCase()}.sqlite`,
      );
      assert.equal(statSync(mailboxPath).mode & 0o777, 0o600);
      assert.equal(statSync(mailboxPath).uid, process.getuid?.());
      const cliEnv = {
        ...env,
        INTERCOM_BRIDGE_URL: restarted.url,
        INTERCOM_BRIDGE_CA: credential.ca,
        INTERCOM_BRIDGE_CERT: credential.cert,
        INTERCOM_BRIDGE_KEY: credential.key,
      };

      await t.test(
        "ordinary ack and exact saved sender survive departure and reconnection",
        async () => {
          const ack = await api("ack", { ids: [notice.id, question.id] });
          assert.deepEqual(ack.body.acked, [notice.id]);
          assert.deepEqual(ack.body.retained, [question.id]);
          const senderId = text(peer.sessionId);
          await peer.disconnect();
          const offline = await api("reply", { replyTo: question.id, message: "keep obligation" });
          assert.equal(offline.status, 409);
          assert.equal(record(offline.body.error).code, "peer_offline");
          assert.equal(record(offline.body.error).message, "Original ask sender is disconnected.");
          assert.deepEqual(
            messages((await api("inbox")).body).map((item) => item.message.id),
            [question.id],
          );
          await peer.connect({ name: "saved-sender", cwd: root, model: "fixture" }, senderId);
          const receiving = nextMessage(peer);
          assert.equal(
            (await api("reply", { replyTo: question.id, message: "saved sender answer" })).body
              .accepted,
            true,
          );
          const answer = await receiving;
          assert.equal(answer.message.replyTo, question.id);
          assert.equal(answer.from.id, remoteId);
          assert.equal(messages((await api("inbox")).body).length, 0);
          await peer.send(remoteId, {
            text: "replay must not resurrect acked notice",
            messageId: notice.id,
          });
          await bridge?.wait(new RegExp(`"messageId":"${notice.id}".*"result":"duplicate"`));
          assert.equal(messages((await api("inbox")).body).length, 0);
          const receivingAsk = nextMessage(peer);
          const asking = api("ask", {
            to: peer.sessionId,
            message: "persist the correlated answer",
            timeoutMs: 5000,
          });
          const outgoing = await receivingAsk;
          const reply = await peer.send(remoteId, {
            text: "durable outgoing answer",
            replyTo: outgoing.message.id,
          });
          const result = await asking;
          assert.equal(envelope(result.body.reply).message.id, reply.id);
          assert.equal(messages((await api("inbox")).body)[0].message.id, reply.id);
          await api("ack", { ids: [reply.id] });
        },
      );

      await t.test(
        "inbox waits release after commit, respect cursors and never consume mail",
        async () => {
          assertDefined(bridge);
          const started = Date.now();
          const empty = await api("inbox?waitMs=80");
          assert.equal(empty.status, 200);
          assert.deepEqual(messages(empty.body), []);
          assert.equal(empty.body.nextCursor, "0");
          assert.ok(Date.now() - started >= 70, "an empty longpoll waits for its bounded timeout");

          let offset = bridge.output().length;
          const waiting = api("inbox?waitMs=10000", undefined, {
            signal: AbortSignal.timeout(3000),
          });
          await bridge.wait(/"event":"inbox_wait"/, offset);
          const passive = await peer.send(remoteId, {
            text: "passive release after durable admission",
            delivery: "passive",
          });
          const released = await waiting;
          assert.equal(released.status, 200);
          assert.deepEqual(
            messages(released.body).map((item) => item.message.id),
            [passive.id],
          );
          assert.equal(messages(released.body)[0].message.delivery, "passive");
          const db = new DatabaseSync(mailboxPath);
          try {
            const row = db.prepare("SELECT envelope,acked FROM mailbox WHERE id=?").get(passive.id);
            assertDefined(row);
            assert.equal(row.acked, 0);
            assert.equal(envelope(json(text(row.envelope))).message.id, passive.id);
          } finally {
            db.close();
          }
          const backlog = await api("inbox?waitMs=10000", undefined, {
            signal: AbortSignal.timeout(3000),
          });
          assert.deepEqual(backlog.body.messages, released.body.messages);
          assert.equal(backlog.body.nextCursor, released.body.nextCursor);
          assert.deepEqual((await api("inbox?waitMs=0")).body.messages, released.body.messages);
          const cliImmediate = json(
            (
              await exec(
                process.execPath,
                [join(repo, "scripts/intercom-remote.mjs"), "inbox", "--wait-ms=0"],
                { env: cliEnv },
              )
            ).stdout,
          );
          assert.deepEqual(cliImmediate.messages, released.body.messages);
          await api("ack", { ids: [passive.id] });

          const ask = await peer.send(remoteId, { text: "retained ask", expectsReply: true });
          await bridge.wait(new RegExp(`"messageId":"${ask.id}"`));
          const tail = text((await api("inbox")).body.nextCursor);
          assert.deepEqual((await api("ack", { ids: [ask.id] })).body.retained, [ask.id]);
          offset = bridge.output().length;
          let settled = false;
          const next = api(`inbox?after=${tail}&waitMs=10000`, undefined, {
            signal: AbortSignal.timeout(3000),
          }).then((result) => {
            settled = true;
            return result;
          });
          await bridge.wait(/"event":"inbox_wait"/, offset);
          await peer.send(remoteId, {
            text: "duplicate retained ask must not cause a read spin",
            messageId: ask.id,
            expectsReply: true,
          });
          await bridge.wait(new RegExp(`"messageId":"${ask.id}".*"result":"duplicate"`), offset);
          await api("list"); // Owner processed the duplicate before this negative assertion.
          assert.equal(settled, false, "a retained ask before the cursor must not release a wait");
          const futureCursor = String(Number(tail) + 10);
          offset = bridge.output().length;
          const future = api(`inbox?after=${futureCursor}&waitMs=150`);
          await bridge.wait(new RegExp(`"event":"inbox_wait".*"after":${futureCursor}`), offset);
          const activeNotice = await peer.send(remoteId, {
            text: "active cursor release",
            delivery: "steer",
          });
          const page = (await next).body;
          assert.deepEqual(
            messages(page).map((item) => item.message.id),
            [activeNotice.id],
          );
          assert.equal(messages(page)[0].message.content.text, "active cursor release");
          assert.equal(messages(page)[0].message.delivery, "steer");
          const unmatched = (await future).body;
          assert.deepEqual(messages(unmatched), []);
          assert.equal(unmatched.nextCursor, futureCursor, "notifications never advance a cursor");

          offset = bridge.output().length;
          const cliWait = exec(
            process.execPath,
            [
              join(repo, "scripts/intercom-remote.mjs"),
              "inbox",
              "--after",
              text(page.nextCursor),
              "--wait-ms",
              "10000",
            ],
            { env: cliEnv },
          );
          await bridge.wait(/"event":"inbox_wait"/, offset);
          const cliNotice = await peer.send(remoteId, { text: "maintained CLI longpoll" });
          assert.deepEqual(
            messages(json((await cliWait).stdout)).map((item) => item.message.id),
            [cliNotice.id],
          );
          assert.deepEqual(
            (await api("ack", { ids: [activeNotice.id, cliNotice.id] })).body.acked,
            [activeNotice.id, cliNotice.id],
          );
          const receiving = nextMessage(peer);
          await api("reply", { replyTo: ask.id, message: "retire retained obligation" });
          assert.equal((await receiving).message.replyTo, ask.id);
        },
      );

      await t.test(
        "cancelling inbox leaves a concurrent ask and native identity intact",
        async () => {
          assertDefined(bridge);
          const receiving = nextMessage(peer);
          const asking = api("ask", {
            to: peer.sessionId,
            message: "survive read cancellation",
            timeoutMs: 5000,
          });
          const outgoing = await receiving;
          const cancelled = new AbortController();
          const offset = bridge.output().length;
          const waiting = api("inbox?waitMs=10000", undefined, { signal: cancelled.signal });
          const rejected = assert.rejects(waiting);
          await bridge.wait(/"event":"inbox_wait"/, offset);
          cancelled.abort();
          await rejected;
          await bridge.wait(/"event":"request".*"result":"client_aborted"/, offset);
          assert.ok(!bridge.output().slice(offset).includes('"event":"session_closed"'));
          assert.equal(
            (await peer.listSessions()).find((row) => row.id === remoteId)?.name,
            "grok-bot",
          );
          const reply = await peer.send(remoteId, {
            text: "ask remained live",
            replyTo: outgoing.message.id,
          });
          const answer = await asking;
          assert.equal(answer.status, 200);
          assert.equal(envelope(answer.body.reply).message.id, reply.id);
          assert.deepEqual((await api("ack", { ids: [reply.id] })).body.acked, [reply.id]);
        },
      );

      await t.test(
        "inbox waits share the eight-request cap and release slots on cancellation",
        async () => {
          assertDefined(bridge);
          const offset = bridge.output().length;
          const controllers = Array.from({ length: 8 }, () => new AbortController());
          const pending = controllers.map((controller) =>
            assert.rejects(
              api("inbox?waitMs=10000", undefined, {
                signal: controller.signal,
              }),
            ),
          );
          await bridge.wait(/(?:[\s\S]*?"event":"inbox_wait"){8}/, offset);
          const excess = await api("inbox");
          assert.equal(excess.status, 429);
          assert.equal(record(excess.body.error).code, "too_many_requests");
          for (const controller of controllers) {
            controller.abort();
          }
          await Promise.all(pending);
          await bridge.wait(
            /(?:[\s\S]*?"event":"request"[^\n]*"result":"client_aborted"){8}/,
            offset,
          );
          assert.equal((await api("register", {})).body.sessionId, remoteId);
          assert.ok(!bridge.output().slice(offset).includes('"event":"session_closed"'));
        },
      );

      await t.test(
        "intake exceeds old count/byte caps with stable bounded pages and deduplication",
        async () => {
          const expected: string[] = [];
          for (let index = 0; index < 300; index++) {
            // Ordered broker publications exercise the actual bridge inbox.
            // oxlint-disable-next-line no-await-in-loop
            expected.push((await peer.send(remoteId, { text: `durable notice ${index}` })).id);
          }
          for (let index = 0; index < 6; index++) {
            // Exceed the former 4 MiB total without exceeding a broker frame.
            // oxlint-disable-next-line no-await-in-loop
            const sent = await peer.send(remoteId, { text: `${index}:${"x".repeat(850000)}` });
            expected.push(sent.id);
          }
          await bridge?.wait(new RegExp(`"messageId":"${text(expected.at(-1))}"`));
          const firstPage = (await api("inbox")).body;
          assert.equal(messages(firstPage).length, 256);
          assert.equal(firstPage.hasMore, true);
          assert.equal(firstPage.overflow, false);
          assert.equal(firstPage.lostMessages, 0);
          assert.deepEqual((await api("inbox")).body.messages, firstPage.messages);
          await peer.send(remoteId, {
            text: "duplicate must not replace original",
            messageId: expected[0],
          });
          await bridge?.wait(new RegExp(`"messageId":"${expected[0]}".*"result":"duplicate"`));
          assert.equal(
            messages((await api("inbox?limit=1")).body)[0].message.content.text,
            "durable notice 0",
          );
          const observed: string[] = [];
          let after = "0";
          let more = true;
          while (more) {
            // Cursor pages are the public interface; never hydrate the whole mailbox.
            // oxlint-disable-next-line no-await-in-loop
            const page = (await api(`inbox?after=${after}&limit=256`)).body;
            const items = messages(page);
            assert.ok(items.length <= 256);
            assert.ok(Buffer.byteLength(JSON.stringify(page.messages)) <= 4 * 1024 * 1024 + 256);
            observed.push(...items.map((item) => item.message.id));
            after = text(page.nextCursor);
            more = page.hasMore === true;
          }
          assert.deepEqual(observed, expected);
          for (const query of [
            "limit=0",
            "limit=257",
            "after=-1",
            "after=9007199254740992",
            "after=01",
            "limit=1&limit=2",
            "unknown=1",
            ...["", "-1", "10001", "1.5", "1e3", "01", "+1", " 1", "Infinity"].map(
              (value) => `waitMs=${encodeURIComponent(value)}`,
            ),
            "waitMs=1&waitMs=2",
          ]) {
            // Each invalid request must reach the public parser and be rejected.
            // oxlint-disable-next-line no-await-in-loop
            assert.equal((await api(`inbox?${query}`)).status, 400);
          }
          const result = json(
            (
              await exec(
                process.execPath,
                [
                  join(repo, "scripts/intercom-remote.mjs"),
                  "inbox",
                  "--after",
                  text(firstPage.nextCursor),
                  "--limit",
                  "1",
                  "--wait-ms",
                  "10000",
                ],
                {
                  env: {
                    ...env,
                    INTERCOM_BRIDGE_URL: restarted.url,
                    INTERCOM_BRIDGE_CA: credential.ca,
                    INTERCOM_BRIDGE_CERT: credential.cert,
                    INTERCOM_BRIDGE_KEY: credential.key,
                  },
                },
              )
            ).stdout,
          );
          assert.equal(messages(result)[0].message.id, expected[256]);
          for (const value of ["", "-1", "10001", "1.5", "1e3", "01", "+1", " 1", "Infinity"]) {
            // Validation must fail before TLS/file loading, with the maintained CLI's argument exit.
            // oxlint-disable-next-line no-await-in-loop
            await assert.rejects(
              exec(process.execPath, [
                join(repo, "scripts/intercom-remote.mjs"),
                "inbox",
                `--wait-ms=${value}`,
              ]),
              (error: unknown) =>
                error instanceof Error &&
                record(error.cause).code === 2 &&
                error.message.includes("--wait-ms must be 0..10000"),
            );
          }
          for (const args of [
            ["inbox", "--wait-ms=1", "--wait-ms=2"],
            ["list", "--wait-ms=0"],
          ]) {
            // Repeated and misplaced wait options cannot silently select a different operation.
            // oxlint-disable-next-line no-await-in-loop
            await assert.rejects(
              exec(process.execPath, [join(repo, "scripts/intercom-remote.mjs"), ...args]),
              (error: unknown) => error instanceof Error && record(error.cause).code === 2,
            );
          }
          const ackFirst = expected.slice(0, 256);
          assert.deepEqual((await api("ack", { ids: ackFirst })).body.acked, ackFirst);
          assert.deepEqual(
            (await api("ack", { ids: expected.slice(256) })).body.acked,
            expected.slice(256),
          );
          assert.equal(messages((await api("inbox")).body).length, 0);
          assert.equal(
            (await peer.listSessions()).find((row) => row.id === remoteId)?.acceptsAsks,
            true,
          );
        },
      );

      await t.test(
        "lease retirement and broker outage retain obligations and allow offline reads/acks",
        async () => {
          assertDefined(bridge);
          await stop(bridge.child);
          bridge = start("test/fixtures/intercom-bridge-clock.ts", ["--config", configPath], env);
          api = (await bridgeApi(bridge, credential)).api;
          await api("register", {});
          const ordinary = await peer.send(remoteId, { text: "across lease and outage" });
          const obligation = await peer.send(remoteId, {
            text: "reply after reconnect",
            expectsReply: true,
          });
          await bridge.wait(new RegExp(`"messageId":"${obligation.id}"`));
          const beforeLease = messages((await api("inbox")).body);
          const offset = bridge.output().length;
          bridge.child.kill("SIGUSR2");
          await bridge.wait(/"result":"lease_expired"/, offset);
          assert.deepEqual(messages((await api("inbox")).body), beforeLease);
          await api("register", {});
          assert.equal(
            (await peer.listSessions()).find((row) => row.id === remoteId)?.pendingAsks,
            1,
          );
          assertDefined(broker);
          await stop(broker.child);
          await bridge.wait(/"result":"broker_disconnected"/, offset);
          assert.deepEqual(messages((await api("inbox")).body), beforeLease);
          assert.deepEqual((await api("ack", { ids: [ordinary.id, obligation.id] })).body.acked, [
            ordinary.id,
          ]);
          assert.deepEqual(
            messages((await api("inbox")).body).map((item) => item.message.id),
            [obligation.id],
          );
          broker = start("src/pi-intercom/broker/broker.ts", [], env);
          await broker.wait(/Intercom broker started/);
          await peer.connect(
            { name: "saved-sender", cwd: root, model: "fixture" },
            beforeLease[1].from.id,
          );
          await api("register", {});
          const receiving = nextMessage(peer);
          assert.equal(
            (await api("reply", { replyTo: obligation.id, message: "obligation settled" })).body
              .accepted,
            true,
          );
          assert.equal((await receiving).message.replyTo, obligation.id);
        },
      );

      await t.test(
        "broker disconnect, revocation, invalid reload and shutdown settle admitted inbox waits",
        async () => {
          assertDefined(bridge);
          await stop(bridge.child);
          bridge = start("src/pi-intercom/bridge.ts", ["--config", configPath], env);
          api = (await bridgeApi(bridge, credential)).api;
          await api("register", {});
          let offset = bridge.output().length;
          const disconnected = api("inbox?after=9007199254740991&waitMs=10000");
          await bridge.wait(/"event":"inbox_wait"/, offset);
          assertDefined(broker);
          await stop(broker.child);
          const down = await disconnected;
          assert.equal(down.status, 503);
          assert.equal(record(down.body.error).code, "broker_disconnected");
          await bridge.wait(/"event":"session_closed".*"result":"broker_disconnected"/, offset);
          broker = start("src/pi-intercom/broker/broker.ts", [], env);
          await broker.wait(/Intercom broker started/);
          await peer.connect({ name: "saved-sender", cwd: root, model: "fixture" });
          await api("register", {});

          const clients = config.clients;
          for (const mode of ["revoked", "invalid", "shutdown"]) {
            // Each transition owns a distinct pending HTTP request, admitted by its audit event.
            offset = bridge.output().length;
            const pending = api("inbox?after=9007199254740991&waitMs=10000").catch(() => null);
            // oxlint-disable-next-line no-await-in-loop
            await bridge.wait(/"event":"inbox_wait"/, offset);
            if (mode === "shutdown") {
              // oxlint-disable-next-line no-await-in-loop
              await stop(bridge.child);
              assert.equal(
                bridge.child.exitCode,
                0,
                "shutdown must finish without the SIGKILL guard",
              );
              assert.match(bridge.output().slice(offset), /"event":"shutdown","result":"closed"/);
            } else {
              config.clients = [];
              writeFileSync(
                configPath,
                mode === "invalid" ? '{"clients":' : JSON.stringify(config),
                { mode: 0o600 },
              );
              bridge.child.kill("SIGHUP");
              // oxlint-disable-next-line no-await-in-loop
              await bridge.wait(/"event":"allowlist_reloaded"/, offset);
              // oxlint-disable-next-line no-await-in-loop
              await assert.rejects(api("inbox"));
            }
            // oxlint-disable-next-line no-await-in-loop
            const result = await pending;
            assert.ok(result === null || result.body.ok === false, "no revoked data is exposed");
            if (mode !== "shutdown") {
              // The denied generation owns its socket until retirement, even after HTTP ends.
              // oxlint-disable-next-line no-await-in-loop
              await bridge.wait(/"event":"session_closed"/, offset);
            }
            config.clients = clients;
            writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
            if (mode === "shutdown") {
              bridge = start("src/pi-intercom/bridge.ts", ["--config", configPath], env);
              // oxlint-disable-next-line no-await-in-loop
              api = (await bridgeApi(bridge, credential)).api;
            } else {
              offset = bridge.output().length;
              bridge.child.kill("SIGHUP");
              // oxlint-disable-next-line no-await-in-loop
              await bridge.wait(/"event":"allowlist_reloaded"/, offset);
            }
            // oxlint-disable-next-line no-await-in-loop
            assert.equal((await api("register", {})).body.ok, true);
          }
        },
      );

      await t.test(
        "certificate expiry settles an admitted inbox wait and retires its identity",
        async () => {
          assertDefined(bridge);
          const dir = join(root, "short-lived");
          mkdirSync(dir, { mode: 0o700 });
          writeFileSync(join(dir, "index"), "");
          writeFileSync(join(dir, "serial"), "0100\n");
          const caConfig = join(dir, "openssl.cnf");
          writeFileSync(
            caConfig,
            `[ca]\ndefault_ca=local\n[local]\ndatabase=${dir}/index\nserial=${dir}/serial\nnew_certs_dir=${dir}\ncertificate=${root}/keys/ca.crt\nprivate_key=${root}/keys/ca.key\ndefault_md=sha256\npolicy=names\nx509_extensions=client\n[names]\ncommonName=supplied\n[client]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n`,
            { mode: 0o600 },
          );
          const csr = join(dir, "client.csr");
          const cert = join(dir, "client.crt");
          await exec("openssl", [
            "req",
            "-new",
            "-key",
            credential.key,
            "-subj",
            "/CN=short-lived",
            "-out",
            csr,
          ]);
          const date = (ms: number) =>
            new Date(ms).toISOString().replace(/[-:]/g, "").replace("T", "").slice(2, 14) + "Z";
          await exec("openssl", [
            "ca",
            "-batch",
            "-notext",
            "-config",
            caConfig,
            "-in",
            csr,
            "-out",
            cert,
            "-startdate",
            date(Date.now() - 1000),
            "-enddate",
            date(Date.now() + 5000),
          ]);
          const short = {
            ...credential,
            cert,
            fingerprint256: new X509Certificate(readFileSync(cert)).fingerprint256,
          };
          const clients = config.clients;
          config.clients = [
            ...records(clients),
            { fingerprint256: short.fingerprint256, name: "short-lived", cwd: root },
          ];
          writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
          let offset = bridge.output().length;
          bridge.child.kill("SIGHUP");
          await bridge.wait(/"event":"allowlist_reloaded"/, offset);
          const shortApi = (await bridgeApi(bridge, short)).api;
          const shortId = text((await shortApi("register", {})).body.sessionId);
          offset = bridge.output().length;
          const pending = shortApi("inbox?waitMs=10000").catch(() => null);
          await bridge.wait(/"event":"inbox_wait".*"name":"short-lived"/, offset);
          const result = await pending;
          assert.ok(result === null || result.body.ok === false);
          await bridge.wait(
            /"event":"session_closed".*"name":"short-lived".*"result":"certificate_expired"/,
            offset,
          );
          await assert.rejects(shortApi("inbox"));
          assert.ok(!(await peer.listSessions()).some((row) => row.id === shortId));
          config.clients = clients;
          writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
          offset = bridge.output().length;
          bridge.child.kill("SIGHUP");
          await bridge.wait(/"event":"allowlist_reloaded"/, offset);
        },
      );

      await t.test(
        "storage admission failure is recorded durably without a false receipt",
        async () => {
          const db = new DatabaseSync(mailboxPath);
          try {
            db.exec(
              "CREATE TRIGGER reject_intake BEFORE INSERT ON mailbox BEGIN SELECT RAISE(FAIL, 'BODY_SENTINEL_NOT_FOR_LOGS'); END",
            );
            assertDefined(bridge);
            const offset = bridge.output().length;
            const waiting = api("inbox?waitMs=10000", undefined, {
              signal: AbortSignal.timeout(3000),
            });
            await bridge.wait(/"event":"inbox_wait"/, offset);
            const rejected = await peer.send(remoteId, { text: "BODY_SENTINEL_NOT_FOR_LOGS" });
            await bridge.wait(
              new RegExp(`"messageId":"${rejected.id}".*"result":"storage_failed"`),
            );
            const failed = (await waiting).body;
            assert.equal(failed.overflow, true);
            assert.equal(failed.storageError, true);
            assert.equal(failed.lostMessages, 1);
            assert.equal(messages(failed).length, 0);
            assert.deepEqual((await api("inbox")).body.messages, failed.messages);
            assert.equal(
              (await peer.listSessions()).find((row) => row.id === remoteId)?.acceptsAsks,
              false,
            );
            assert.ok(!bridge.output().includes("BODY_SENTINEL_NOT_FOR_LOGS"));
            const exitedAgain = once(bridge.child, "close");
            bridge.child.kill("SIGKILL");
            await exitedAgain;
            db.exec("DROP TRIGGER reject_intake");
            bridge = start("src/pi-intercom/bridge.ts", ["--config", configPath], env);
            api = (await bridgeApi(bridge, credential)).api;
            assert.equal((await api("inbox")).body.lostMessages, 1);
          } finally {
            db.close();
          }
        },
      );

      await t.test("unsafe directory/database permissions and symlinks fail closed", async () => {
        assertDefined(bridge);
        await stop(bridge.child);
        const unsafe = async () => {
          const process = start("src/pi-intercom/bridge.ts", ["--config", configPath], env);
          try {
            const client = await bridgeApi(process, credential);
            const rejected = await client.api("inbox");
            assert.equal(rejected.body.ok, false);
            assert.equal(rejected.status, 507);
            assert.equal(record(rejected.body.error).code, "mailbox_storage_failed");
          } finally {
            await stop(process.child);
          }
        };
        chmodSync(mailboxPath, 0o644);
        await unsafe();
        chmodSync(mailboxPath, 0o600);
        renameSync(mailboxPath, `${mailboxPath}.saved`);
        symlinkSync(`${mailboxPath}.saved`, mailboxPath);
        await unsafe();
        unlinkSync(mailboxPath);
        renameSync(`${mailboxPath}.saved`, mailboxPath);
        const link = join(root, "state-link");
        symlinkSync(text(config.stateDir), link);
        const publicDir = join(root, "public");
        mkdirSync(publicDir, { mode: 0o755 });
        chmodSync(publicDir, 0o755);
        for (const dir of [link, publicDir]) {
          config.stateDir = dir;
          writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
          // Neither a symlink nor a nonprivate directory may be accepted.
          // oxlint-disable-next-line no-await-in-loop
          await assert.rejects(
            exec(
              process.execPath,
              [join(repo, "src/pi-intercom/bridge.ts"), "--config", configPath],
              { env },
            ),
          );
        }
      });
    } finally {
      await peer.disconnect();
      if (bridge) {
        await stop(bridge.child);
      }
      if (broker) {
        await stop(broker.child);
      }
      if (previous === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previous;
      }
      if (previousTmp === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = previousTmp;
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("wake intents retain unconfirmed payloads and stop after durable ask intake", async () => {
  const root = mkdtempSync("/tmp/pib-wake-");
  const module = join(repo, "src/pi-intercom/bridge-mailbox.ts");
  const run = async (script: string) =>
    json(
      (
        await exec(process.execPath, [
          "--input-type=module",
          "-e",
          `
      import { Mailbox } from ${JSON.stringify(module)};
      const mailbox = new Mailbox(${JSON.stringify(root)}, ${JSON.stringify("A".repeat(64))}, true);
      ${script}
      mailbox.close();
    `,
        ])
      ).stdout,
    );
  try {
    const before = Date.now();
    const first = await run(`
      const from = {id:"saved-sender",cwd:"/fixture",model:"fixture"};
      mailbox.add({from,message:{id:"notice",timestamp:1,content:{text:"notice payload"}}});
      mailbox.add({from,message:{id:"ask",timestamp:2,expectsReply:true,content:{text:"ask payload"}}});
      const ack = mailbox.ack(["notice","ask"]);
      console.log(JSON.stringify({ack,inbox:mailbox.page(0,256),wake:mailbox.pendingNotifications()}));
    `);
    assert.deepEqual(record(first.ack).acked, ["notice"]);
    assert.deepEqual(record(first.ack).retained, ["ask"]);
    assert.deepEqual(
      messages(record(first.inbox)).map((item) => item.message.id),
      ["ask"],
    );
    const pending = records(record(first.wake).messages);
    assert.deepEqual(
      pending.map((item) => record(item.message).id),
      ["notice"],
    );
    assert.deepEqual(
      pending.map((item) => item.acknowledged),
      [true],
    );
    assert.ok(
      pending.every(
        (item) =>
          typeof item.receivedAt === "number" &&
          item.receivedAt >= before &&
          item.receivedAt <= Date.now(),
      ),
    );
    const second = await run(`
      const restored = mailbox.pendingNotifications();
      mailbox.notificationAccepted("notice");
      mailbox.notificationAccepted("ask");
      const from = {id:"saved-sender",cwd:"/fixture",model:"fixture"};
      const replay = mailbox.add({from,message:{id:"notice",timestamp:3,content:{text:"do not resurrect"}}});
      mailbox.add({from,message:{id:"notify-first",timestamp:4,content:{text:"reverse order"}}});
      mailbox.notificationAccepted("notify-first");
      const stillUnread = mailbox.page(0,256);
      mailbox.ack(["notify-first"]);
      console.log(JSON.stringify({restored,replay,stillUnread,inbox:mailbox.page(0,256),wake:mailbox.pendingNotifications()}));
    `);
    assert.deepEqual(record(second.restored), record(first.wake));
    assert.equal(second.replay, "duplicate");
    assert.deepEqual(
      messages(record(second.stillUnread)).map((item) => item.message.id),
      ["ask", "notify-first"],
    );
    assert.deepEqual(
      messages(record(second.inbox)).map((item) => item.message.id),
      ["ask"],
    );
    assert.deepEqual(record(second.wake).messages, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("credential issue cannot overwrite a concurrent revocation", { timeout: 30000 }, async () => {
  const root = mkdtempSync("/tmp/pib-lock-");
  const dir = join(root, "credentials");
  const tool = join(repo, "scripts/intercom-bridge-credentials.mjs");
  let signingPid: number | undefined;
  let issuing: Promise<unknown> | undefined;
  let cleanupError: Error | undefined;
  try {
    const original = parseCredential(
      json((await exec(process.execPath, [tool, "init", dir, "--cwd", root])).stdout),
    );
    const ready = join(root, "signing-ready");
    const wrapper = join(root, "pause-openssl");
    writeFileSync(
      wrapper,
      `#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { writeFileSync, renameSync } from "node:fs";
if (process.argv[2] === "ecparam") {
  const timer = setTimeout(() => process.exit(1), 20000);
  process.once("SIGUSR1", () => {
    clearTimeout(timer);
    execFileSync("openssl", process.argv.slice(2));
    process.exit(0);
  });
  writeFileSync(${JSON.stringify(`${ready}.tmp`)}, String(process.pid));
  renameSync(${JSON.stringify(`${ready}.tmp`)}, ${JSON.stringify(ready)});
} else {
  execFileSync("openssl", process.argv.slice(2));
}
`,
      { mode: 0o700 },
    );
    const signing = new Promise<void>((resolveReady, reject) => {
      const watcher = watch(root, (_event, name) => {
        if (name?.toString() !== "signing-ready") {
          return;
        }
        signingPid = Number(readFileSync(ready, "utf8"));
        clearTimeout(timer);
        watcher.close();
        resolveReady();
      });
      const timer = setTimeout(() => {
        watcher.close();
        reject(new Error("Signer never reached key creation."));
      }, 10000);
    });
    issuing = exec(process.execPath, [tool, "issue", dir, "maintenance"], {
      env: { ...process.env, OPENSSL: wrapper },
    });
    issuing.catch(() => {
      /* The same original promise is awaited after signer release and in teardown. */
    });
    await signing; // Actual issue owns its read/modify/write window before testing the conflicting command.
    await assert.rejects(
      exec(process.execPath, [tool, "revoke", dir, "grok-bot"]),
      /Another credential command holds/,
    );
    assertDefined(signingPid);
    process.kill(signingPid, "SIGUSR1");
    await issuing;
    const configPath = join(dir, "config.json");
    const clients = records(record(readJson(configPath)).clients);
    assert.equal(
      clients.find((client) => client.name === "grok-bot")?.fingerprint256,
      original.fingerprint256,
    );
    const rotationConfig = record(readJson(configPath));
    const identity = records(rotationConfig.clients).find((client) => client.name === "grok-bot");
    assertDefined(identity);
    identity.wake = { envFile: join(root, "private-wake.env") };
    writeFileSync(configPath, JSON.stringify(rotationConfig), { mode: 0o600 });
    const rotated = parseCredential(
      json((await exec(process.execPath, [tool, "issue", dir, "grok-bot"])).stdout),
    );
    assert.notEqual(rotated.fingerprint256, original.fingerprint256);
    assert.deepEqual(
      records(record(readJson(configPath)).clients).find((client) => client.name === "grok-bot")
        ?.wake,
      identity.wake,
      "certificate rotation preserves the local wake policy",
    );
    await exec(process.execPath, [tool, "revoke", dir, "grok-bot"]);
    assert.ok(
      !records(record(readJson(configPath)).clients).some((client) => client.name === "grok-bot"),
    );
  } finally {
    if (signingPid !== undefined) {
      try {
        process.kill(signingPid, "SIGKILL");
      } catch (error) {
        if (!hasErrorCode(error, "ESRCH")) {
          cleanupError = error instanceof Error ? error : new Error(errorMessage(error));
        }
      }
    }
    if (issuing) {
      await issuing.catch(() => {
        /* Expected if teardown killed the paused signer. */
      });
    }
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      cleanupError ??= error instanceof Error ? error : new Error(errorMessage(error));
    }
  }
  // A primary failure propagates through finally; report cleanup failure only after primary success.
  if (cleanupError) {
    throw cleanupError;
  }
});
