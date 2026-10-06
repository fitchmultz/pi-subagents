import "../support/isolated-home.ts";
import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { once } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, watch } from "node:fs";
import { join, resolve } from "node:path";
import { IntercomClient } from "../../src/pi-intercom/broker/client.ts";
import { getBrokerSocketPath } from "../../src/pi-intercom/broker/paths.ts";
import { normalizeMessage, normalizeSessionInfo } from "../../src/pi-intercom/types.ts";
import { hasErrorCode, errorMessage, type UnknownRecord } from "../../src/shared/unknown.ts";
import { exec, start, stop, parseCredential } from "../support/intercom-bridge.ts";
import {
  assertDefined,
  json,
  readJson,
  record,
  records,
  text,
  numberValue,
} from "../support/assertions.ts";

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
        await runTool("init", credentials, "grok-bot", "--cwd", project),
      );
      const unpinned = parseCredential(await runTool("issue", credentials, "unapproved"));
      const configPath = join(credentials, "config.json");
      const config = record(readJson(configPath));
      config.clients = records(config.clients).filter((client) => client.name === "grok-bot");
      config.port = 0;
      writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
      broker = start("src/pi-intercom/broker/broker.ts", [], env);
      await broker.wait(/Intercom broker started/);
      const peer = await agent("known-peer");
      const intruder = await agent("wrong-replier");
      bridge = start("src/pi-intercom/bridge.ts", ["--config", configPath], env);
      const activeBridge = bridge;
      const activeBroker = broker;
      const listening = await activeBridge.wait(/"event":"listening"/);
      const listeningRecord = listening
        .split("\n")
        .filter((line) => line !== "")
        .map(json)
        .find((line) => line.event === "listening");
      assertDefined(listeningRecord);
      assert.equal(listeningRecord.host, "127.0.0.1");
      const url = `https://127.0.0.1:${numberValue(listeningRecord.port)}`;
      const tls = {
        ca: readFileSync(credential.ca),
        cert: readFileSync(credential.cert),
        key: readFileSync(credential.key),
        rejectUnauthorized: true,
        agent: false as const,
      };
      const api = (action: string, body?: unknown, extra = {}) =>
        new Promise<{ readonly status: number; readonly body: UnknownRecord }>(
          (resolveApi, reject) => {
            const payload = body === undefined ? undefined : JSON.stringify(body);
            const req = https.request(
              `${url}/v1/${action}`,
              {
                ...tls,
                method: payload === undefined ? "GET" : "POST",
                headers: payload === undefined ? {} : { "Content-Type": "application/json" },
                signal: AbortSignal.timeout(15000),
                ...extra,
              },
              (res) => {
                let data = "";
                res.on("data", (chunk: Buffer) => {
                  data += chunk.toString("utf8");
                });
                res.on("error", reject);
                res.on("end", () => {
                  let parsed: UnknownRecord;
                  try {
                    parsed = json(data);
                  } catch (error) {
                    reject(error instanceof Error ? error : new Error(errorMessage(error)));
                    return;
                  }
                  resolveApi({ status: res.statusCode ?? 0, body: parsed });
                });
              },
            );
            req.on("error", reject);
            req.end(payload);
          },
        );

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
        assert.equal((await receiving).from.id, remoteId);
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
          const controller = new AbortController();
          const cancelMessage = nextMessage(peer);
          const cancelled = api(
            "ask",
            { to: peer.sessionId, message: "cancel now", timeoutMs: 10000 },
            { signal: controller.signal },
          );
          await cancelMessage;
          controller.abort();
          await assert.rejects(cancelled);
          await activeBridge.wait(/"event":"session_closed"/);
          const afterCancel = await api("register", {});
          assert.equal(afterCancel.body.ok, true);
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
