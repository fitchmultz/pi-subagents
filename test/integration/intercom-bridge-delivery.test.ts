import "../support/isolated-home.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:https";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { IntercomClient } from "../../src/pi-intercom/broker/client.ts";
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

test(
  "persistent presence and delayed HTTPS fallback survive helper crashes without consumer polling",
  { timeout: 60000 },
  async () => {
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
    const wakes = new EventEmitter();
    let broker: ReturnType<typeof start> | undefined;
    let bridge: ReturnType<typeof start> | undefined;
    let server: ReturnType<typeof createServer> | undefined;
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
            requests.push({
              authorization: req.headers.authorization,
              body: JSON.parse(body) as unknown,
            });
            res.writeHead(requests.length === 1 ? 503 : 204);
            res.end();
            wakes.emit("request");
          });
        },
      );
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      assert.ok(address !== null && typeof address !== "string");
      const envFile = join(root, "wake.env");
      writeFileSync(
        envFile,
        `GROK_WAKE_WEBHOOK_URL=https://127.0.0.1:${address.port}/wake\nGROK_WAKE_WEBHOOK_KEY=fixture-bearer-secret\n`,
        { mode: 0o600 },
      );
      config.port = 0;
      config.stateDir = stateDir;
      records(config.clients)[0].wake = { envFile };
      writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
      const helperEnv = { ...env, NODE_EXTRA_CA_CERTS: credential.ca };
      broker = start("src/pi-intercom/broker/broker.ts", [], env);
      await broker.wait(/Intercom broker started/);
      await peer.connect({ name: "local-sender", cwd: root, model: "fixture" });
      bridge = start("test/fixtures/intercom-bridge-clock.ts", ["--config", configPath], helperEnv);
      const first = await bridgeApi(bridge, credential);
      const remoteId = text((await first.api("register", {})).body.sessionId);
      const notice = await peer.send(remoteId, { text: "fallback payload" });
      const ask = await peer.send(remoteId, {
        text: "already durably consumed ask",
        expectsReply: true,
      });
      await bridge.wait(new RegExp(`"messageId":"${ask.id}"`));
      assert.deepEqual((await first.api("ack", { ids: [ask.id] })).body.retained, [ask.id]);
      const mailboxPath = join(
        stateDir,
        `${credential.fingerprint256.replaceAll(":", "").toUpperCase()}.sqlite`,
      );
      const db = new DatabaseSync(mailboxPath);
      let receivedAt: number;
      try {
        receivedAt = numberValue(
          db.prepare("SELECT receivedAt FROM mailbox WHERE id=?").get(notice.id)?.receivedAt,
        );
      } finally {
        db.close();
      }
      bridge.child.kill("SIGUSR1");
      await bridge.wait(/"event":"fixture_clock"/);
      const rejectedWake = once(wakes, "request");
      bridge.child.kill("SIGALRM");
      await rejectedWake;
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
      assert.ok(
        numberValue(attempts[0].timestamp) - receivedAt >= 120000,
        "no HTTP request before the unacked fallback threshold",
      );
      assert.ok(!bridge.output().includes("fixture-bearer-secret"));
      const crashed = once(bridge.child, "close");
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
      const acceptedWake = once(wakes, "request");
      bridge.child.kill("SIGUSR2");
      await acceptedWake;
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
          stored.prepare("SELECT COUNT(*) AS count FROM mailbox WHERE notified=0").get()?.count,
          0,
        );
        assert.equal(
          stored.prepare("SELECT COUNT(*) AS count FROM mailbox WHERE acked=0").get()?.count,
          2,
          "webhook acceptance is not consumer acknowledgement or model consumption",
        );
      } finally {
        stored.close();
      }
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

      config.clients = [];
      writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
      bridge = start("src/pi-intercom/bridge.ts", ["--config", configPath], helperEnv);
      await bridge.wait(/"event":"listening"/);
      assert.ok(
        !(await peer.listSessions()).some((entry) => entry.id === remoteId),
        "saved proof cannot restore a revoked identity",
      );
      assert.equal(requests.length, 2);
    } finally {
      await peer.disconnect();
      if (bridge) {
        await stop(bridge.child);
      }
      if (broker) {
        await stop(broker.child);
      }
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
