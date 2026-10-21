import "../support/isolated-home.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:https";
import { createServer as createTcpServer, createConnection, type Socket } from "node:net";
import { performance } from "node:perf_hooks";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID, X509Certificate } from "node:crypto";
import { IntercomClient } from "../../src/pi-intercom/broker/client.ts";
import { createMessageReader, writeMessage } from "../../src/pi-intercom/broker/framing.ts";
import { getBrokerSocketPath } from "../../src/pi-intercom/broker/paths.ts";
import { bridgeApi, exec, parseCredential, start, stop } from "../support/intercom-bridge.ts";
import {
  assertDefined,
  json,
  numberValue,
  readJson,
  record,
  records,
  text,
} from "../support/assertions.ts";

const repo = resolve(import.meta.dirname, "../..");
const relayDelayMs = 250;

async function advanceClock(bridge: ReturnType<typeof start>, signal: NodeJS.Signals) {
  const after = bridge.output().length;
  bridge.child.kill(signal);
  await bridge.wait(/"event":"fixture_clock"/, after);
}

function delayedRelay(port: number) {
  const sockets = new Set<Socket>();
  const timings = new Map<
    number,
    { readonly acceptedAt: number; forwardedAt: number; handshakeAt: number; requestedAt: number }
  >();
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    const timing = {
      acceptedAt: performance.now(),
      forwardedAt: 0,
      handshakeAt: 0,
      requestedAt: 0,
    };
    let upstream: Socket | undefined;
    let timer: NodeJS.Timeout;
    const forward = () => {
      const remaining = timing.acceptedAt + relayDelayMs - performance.now();
      if (remaining > 0) {
        timer = setTimeout(forward, Math.ceil(remaining));
        return;
      }
      const outgoing = createConnection({ host: "127.0.0.1", port });
      upstream = outgoing;
      sockets.add(outgoing);
      outgoing.once("connect", () => {
        timing.forwardedAt = performance.now();
        timings.set(outgoing.localPort ?? 0, timing);
        socket.pipe(outgoing).pipe(socket);
      });
      outgoing.on("error", () => {
        socket.destroy();
      });
      outgoing.once("close", () => {
        sockets.delete(outgoing);
        socket.destroy();
      });
    };
    timer = setTimeout(forward, relayDelayMs);
    socket.on("error", () => {
      socket.destroy();
    });
    socket.once("close", () => {
      clearTimeout(timer);
      upstream?.destroy();
      sockets.delete(socket);
    });
  });
  return {
    server,
    timings,
    close: async () => {
      const closed = once(server, "close", { signal: AbortSignal.timeout(5000) });
      server.close();
      for (const socket of sockets) {
        socket.destroy();
      }
      await closed;
    },
  };
}

test(
  "persistent presence and event-driven HTTPS fallback survive helper crashes without consumer polling",
  { timeout: 60000 },
  async (t) => {
    const root = mkdtempSync("/tmp/pib-delivery-");
    const previousAgent = process.env.PI_CODING_AGENT_DIR;
    const previousTmp = process.env.TMPDIR;
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");
    process.env.TMPDIR = root;
    const env = { ...process.env, HOME: root, TMP: root, TEMP: root };
    const peer = new IntercomClient();
    peer.on("error", () => {
      /* Owned broker is stopped during teardown. */
    });
    const requests: { readonly authorization: string | undefined; readonly body: unknown }[] = [];
    let broker: ReturnType<typeof start> | undefined;
    let bridge: ReturnType<typeof start> | undefined;
    let server: ReturnType<typeof createServer> | undefined;
    let relay: ReturnType<typeof delayedRelay> | undefined;
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
                "fitch-os",
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
      const stateDir = join(root, "state");
      mkdirSync(stateDir, { mode: 0o700 });
      server = createServer(
        { cert: readFileSync(text(config.cert)), key: readFileSync(text(config.key)) },
        (req, res) => {
          let body = "";
          req.on("data", (chunk: Buffer) => {
            body += chunk.toString("utf8");
          });
          req.on("end", () => {
            const timing = relay?.timings.get(req.socket.remotePort ?? 0);
            if (timing) {
              timing.requestedAt = performance.now();
            }
            requests.push({
              authorization: req.headers.authorization,
              body: JSON.parse(body) as unknown,
            });
            res.writeHead(requests.length === 1 ? 503 : 204);
            res.end();
          });
        },
      );
      server.on("secureConnection", (socket) => {
        const timing = relay?.timings.get(socket.remotePort ?? 0);
        if (timing) {
          timing.handshakeAt = performance.now();
        }
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening", { signal: t.signal });
      const address = server.address();
      assert.ok(address !== null && typeof address !== "string");
      // Delay the native TCP relay before connecting upstream; HTTPS socket.pause does not gate TLS.
      relay = delayedRelay(address.port);
      relay.server.listen(0, "127.0.0.1");
      await once(relay.server, "listening", { signal: t.signal });
      const relayAddress = relay.server.address();
      assert.ok(relayAddress !== null && typeof relayAddress !== "string");
      const envFile = join(root, "wake.env");
      writeFileSync(
        envFile,
        `GROK_WAKE_WEBHOOK_URL=https://127.0.0.1:${relayAddress.port}/wake\nGROK_WAKE_WEBHOOK_KEY=fixture-bearer-secret\n`,
        { mode: 0o600 },
      );
      config.port = 0;
      config.stateDir = stateDir;
      records(config.clients)[0].wake = { envFile };
      writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
      const helperEnv = {
        ...env,
        NODE_EXTRA_CA_CERTS: credential.ca,
        PI_FIXTURE_CLOCK_FILE: join(root, "fixture-clock"),
      };
      broker = start("src/pi-intercom/broker/broker.ts", [], env);
      await broker.wait(/Intercom broker started/);
      await peer.connect({ name: "local-sender", cwd: root, model: "fixture" });
      bridge = start("test/fixtures/intercom-bridge-clock.ts", ["--config", configPath], helperEnv);
      let first = await bridgeApi(bridge, credential);
      const remoteId = text((await first.api("register", {})).body.sessionId);
      const mailboxPath = join(
        stateDir,
        `${credential.fingerprint256.replaceAll(":", "").toUpperCase()}.sqlite`,
      );
      const passive: { readonly id: string; readonly text: string }[] = [];
      const modes = [{ delivery: "passive" as const }, { passive: true }];
      for (let index = 0; index < 257; index++) {
        const body = `passive ${index}: exact\nmailbox text`;
        // Cross the notification count boundary through the real broker, using both native forms.
        // oxlint-disable-next-line no-await-in-loop
        const sent = await peer.send(remoteId, {
          text: body,
          ...modes[index % 2],
        });
        passive.push({ id: sent.id, text: body });
      }
      await bridge.wait(new RegExp(`"messageId":"${passive[256].id}"`));
      await advanceClock(bridge, "SIGUSR1");
      await advanceClock(bridge, "SIGALRM");
      assert.ok(
        !bridge.output().includes('"event":"fixture_fetch"'),
        "unacknowledged passive messages must never invoke the webhook after the fallback threshold",
      );
      const suppressed = new DatabaseSync(mailboxPath);
      try {
        assert.equal(
          suppressed.prepare("SELECT COUNT(*) AS count FROM mailbox WHERE notified=0").get()?.count,
          0,
          "the entire passive notification backlog must be retired, not only its first page",
        );
      } finally {
        suppressed.close();
      }
      const coldBody = "passive intake just before crash";
      // Older senders emitted only passive:true; the current SDK also adds delivery:"passive".
      const legacy = createConnection({ path: getBrokerSocketPath() });
      t.after(() => legacy.destroy());
      const registration = new Promise<unknown>((resolveRegistration, reject) => {
        legacy.on("data", createMessageReader(resolveRegistration, reject));
        legacy.once("error", reject);
      });
      writeMessage(legacy, {
        type: "register",
        requestedId: "legacy-sender",
        session: { cwd: root, model: "fixture" },
      });
      assert.equal(record(await registration).sessionId, "legacy-sender");
      const coldId = randomUUID();
      writeMessage(legacy, {
        type: "send",
        to: remoteId,
        message: {
          id: coldId,
          timestamp: Date.now(),
          passive: true,
          content: { text: coldBody },
        },
      });
      passive.push({ id: coldId, text: coldBody });
      await bridge.wait(new RegExp(`"messageId":"${coldId}"`));
      legacy.end();
      const passiveCrash = once(bridge.child, "close", { signal: t.signal });
      bridge.child.kill("SIGKILL");
      await passiveCrash;
      bridge = start("test/fixtures/intercom-bridge-clock.ts", ["--config", configPath], helperEnv);
      await bridge.wait(/"event":"listening"/);
      bridge.child.kill("SIGALRM");
      await bridge.wait(/"event":"registered"/);
      await bridge.wait(/"event":"fixture_clock"/);
      const passiveRecovered = await bridgeApi(bridge, credential);
      first = passiveRecovered;
      await advanceClock(bridge, "SIGUSR1");
      await advanceClock(bridge, "SIGALRM");
      // Restart resets the fixture clock; also age mail received under the previous clock.
      await advanceClock(bridge, "SIGUSR1");
      assert.ok(!bridge.output().includes('"event":"fixture_fetch"'));
      const pageOne = (await passiveRecovered.api("inbox")).body;
      const pageTwo = (await passiveRecovered.api(`inbox?after=${text(pageOne.nextCursor)}`)).body;
      assert.equal(pageOne.hasMore, true);
      assert.equal(pageTwo.hasMore, false);
      const recoveredPassive = [...records(pageOne.messages), ...records(pageTwo.messages)];
      assert.deepEqual(
        recoveredPassive.map((entry) => ({
          id: record(entry.message).id,
          text: record(record(entry.message).content).text,
        })),
        passive,
        "suppressing a notification must not acknowledge, prune or consume passive mail",
      );
      assert.deepEqual(
        (await passiveRecovered.api("ack", { ids: passive.slice(0, 256).map((entry) => entry.id) }))
          .body.acked,
        passive.slice(0, 256).map((entry) => entry.id),
      );
      assert.deepEqual(
        (await passiveRecovered.api("ack", { ids: passive.slice(256).map((entry) => entry.id) }))
          .body.acked,
        passive.slice(256).map((entry) => entry.id),
      );
      assert.deepEqual((await passiveRecovered.api("inbox")).body.messages, []);
      await stop(bridge.child);
      bridge = start("test/fixtures/intercom-bridge-clock.ts", ["--config", configPath], helperEnv);
      await bridge.wait(/"event":"listening"/);
      bridge.child.kill("SIGALRM");
      await bridge.wait(/"event":"registered"/);
      first = await bridgeApi(bridge, credential);
      assert.deepEqual((await first.api("inbox")).body.messages, []);

      // An active message behind another full passive page still gets prompt event-driven fallback.
      const largePassive: string[] = [];
      for (let index = 0; index < 6; index++) {
        // oxlint-disable-next-line no-await-in-loop
        const sent = await peer.send(remoteId, {
          text: `${index}:${"x".repeat(850000)}`,
          delivery: "passive",
        });
        largePassive.push(sent.id);
      }
      const notice = await peer.send(remoteId, { text: "fallback payload" });
      const ask = await peer.send(remoteId, {
        text: "already durably consumed ask",
        expectsReply: true,
      });
      await bridge.wait(new RegExp(`"messageId":"${ask.id}"`));
      assert.deepEqual((await first.api("ack", { ids: [ask.id] })).body.acked, [ask.id]);
      const db = new DatabaseSync(mailboxPath);
      let receivedAt: number;
      try {
        receivedAt = numberValue(
          db.prepare("SELECT receivedAt FROM mailbox WHERE id=?").get(notice.id)?.receivedAt,
        );
      } finally {
        db.close();
      }
      await advanceClock(bridge, "SIGWINCH");
      await bridge.wait(/"result":"http_rejected"/);
      assert.equal(
        requests.length,
        1,
        "consumer-acknowledged asks must not generate fallback wakes",
      );
      assert.deepEqual(requests[0], {
        authorization: "Bearer fixture-bearer-secret",
        body: {
          from: "local-sender",
          from_id: peer.sessionId,
          to: "fitch-os",
          message_id: notice.id,
          ask_id: null,
          text: "fallback payload",
        },
      });
      const attempts = bridge
        .output()
        .trim()
        .split("\n")
        .map(json)
        .filter((entry) => entry.event === "fixture_fetch");
      assert.equal(attempts.length, 1);
      const wakeLatency = numberValue(attempts[0].timestamp) - receivedAt;
      assert.ok(wakeLatency >= 2000, "ACK grace precedes fallback");
      assert.ok(wakeLatency < 3000, "mailbox commit promptly wakes after two-second ACK grace");
      assert.ok(!bridge.output().includes("fixture-bearer-secret"));
      const crashed = once(bridge.child, "close", { signal: t.signal });
      bridge.child.kill("SIGKILL");
      await crashed;

      // No HTTP request registers the restarted helper: its private certificate proof restores presence.
      bridge = start("test/fixtures/intercom-bridge-clock.ts", ["--config", configPath], helperEnv);
      await bridge.wait(/"event":"listening"/);
      bridge.child.kill("SIGALRM");
      await bridge.wait(/"event":"registered"/);
      assert.ok(
        (await peer.listSessions()).some(
          (entry) => entry.id === remoteId && entry.name === "fitch-os",
        ),
      );
      bridge.child.kill("SIGUSR2");
      await bridge.wait(/"result":"accepted"/);
      assert.equal(requests.length, 2);
      assert.deepEqual(
        requests[1],
        requests[0],
        "non-2xx wake remains durable across a cold crash",
      );
      const proofPath = join(
        stateDir,
        `presence-${credential.fingerprint256.replaceAll(":", "").toUpperCase()}.json`,
      );
      assert.equal(statSync(proofPath).mode & 0o777, 0o600);
      const stored = new DatabaseSync(mailboxPath);
      try {
        assert.equal(
          stored.prepare("SELECT COUNT(*) AS count FROM mailbox WHERE acked=0").get()?.count,
          7,
          "webhook acceptance is not consumer acknowledgement or model consumption",
        );
      } finally {
        stored.close();
      }
      const acceptedCrash = once(bridge.child, "close", { signal: t.signal });
      bridge.child.kill("SIGKILL");
      await acceptedCrash;
      bridge = start("test/fixtures/intercom-bridge-clock.ts", ["--config", configPath], helperEnv);
      await bridge.wait(/"event":"listening"/);
      bridge.child.kill("SIGALRM");
      await bridge.wait(/"event":"registered"/);
      await advanceClock(bridge, "SIGALRM");
      assert.equal(requests.length, 2, "restart does not reset the persisted retry deadline");
      bridge.child.kill("SIGUSR2");
      await bridge.wait(/"result":"accepted"/);
      assert.equal(requests.length, 3);
      assert.deepEqual(
        requests[2],
        requests[1],
        "HTTP acceptance without durable intake ACK must retry after a cold helper crash",
      );
      assert.equal(relay.timings.size, requests.length);
      const elapsed = [...relay.timings.values()].map((timing) => ({
        forwardedMs: timing.forwardedAt - timing.acceptedAt,
        handshakeMs: timing.handshakeAt - timing.acceptedAt,
        requestedMs: timing.requestedAt - timing.acceptedAt,
      }));
      for (const timing of elapsed) {
        assert.ok(timing.forwardedMs >= relayDelayMs, JSON.stringify(timing));
        assert.ok(timing.handshakeMs >= relayDelayMs, JSON.stringify(timing));
        assert.ok(timing.requestedMs >= relayDelayMs, JSON.stringify(timing));
      }
      t.diagnostic(JSON.stringify({ relayDelayMs, elapsed }));
      const recovered = await bridgeApi(bridge, credential);
      assert.deepEqual(
        (await recovered.api("ack", { ids: largePassive })).body.acked,
        largePassive,
      );
      assert.deepEqual((await recovered.api("ack", { ids: [notice.id] })).body.acked, [notice.id]);
      const afterAck = bridge.output().length;
      bridge.child.kill("SIGUSR2");
      await bridge.wait(/"event":"fixture_clock"/, afterAck);
      assert.equal(requests.length, 3, "durable intake ACK suppresses repeated accepted wakes");
      await stop(bridge.child);
      bridge = start("src/pi-intercom/bridge.ts", ["--config", configPath], helperEnv);
      await bridge.wait(/"event":"registered"/);
      const afterRestart = await peer.send(remoteId, {
        text: "still addressable without box polls",
      });
      await bridge.wait(new RegExp(`"messageId":"${afterRestart.id}"`));
      assert.equal(
        broker.child.exitCode,
        null,
        "helper lifecycle must preserve the existing shared broker",
      );
      await stop(bridge.child);

      const beforeRenewal = record(readJson(configPath));
      await exec(
        process.execPath,
        [
          join(repo, "scripts/intercom-bridge-credentials.mjs"),
          "renew-server",
          join(root, "keys"),
          "--days",
          "3650",
        ],
        { env },
      );
      const renewed = record(readJson(configPath));
      assert.equal(renewed.ca, beforeRenewal.ca);
      assert.deepEqual(renewed.clients, beforeRenewal.clients);
      assert.notEqual(renewed.cert, beforeRenewal.cert);
      assert.ok(
        Date.parse(new X509Certificate(readFileSync(text(renewed.cert))).validTo) - Date.now() >
          9 * 365 * 24 * 60 * 60 * 1000,
      );
      Object.assign(config, renewed);
      bridge = start("src/pi-intercom/bridge.ts", ["--config", configPath], helperEnv);
      const afterRenewal = await bridgeApi(bridge, credential);
      assert.equal(
        (await afterRenewal.api("register", {})).body.name,
        "fitch-os",
        "same-CA server renewal preserves the existing client key and authorization",
      );
      await stop(bridge.child);

      config.clients = [];
      writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
      bridge = start("src/pi-intercom/bridge.ts", ["--config", configPath], helperEnv);
      await bridge.wait(/"event":"listening"/);
      assert.ok(
        !(await peer.listSessions()).some((entry) => entry.id === remoteId),
        "saved proof cannot restore a revoked identity",
      );
      assert.equal(requests.length, 3);
    } finally {
      await peer.disconnect();
      if (bridge) {
        await stop(bridge.child);
      }
      if (broker) {
        await stop(broker.child);
      }
      await relay?.close();
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolveClose, reject) => {
          assertDefined(server);
          server.close((error) => (error ? reject(error) : resolveClose()));
        });
      }
      if (previousAgent === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgent;
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
