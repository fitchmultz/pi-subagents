import "../support/isolated-home.ts";
import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { EventEmitter, once } from "node:events";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, watch } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { IntercomClient } from "../../src/pi-intercom/broker/client.ts";
import { getBrokerSocketPath } from "../../src/pi-intercom/broker/paths.ts";
import type { Message, SessionInfo } from "../../src/pi-intercom/types.ts";

const exec = promisify(execFile);
const repo = resolve(import.meta.dirname, "../..");

function start(file: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [join(repo, file), ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  const events = new EventEmitter();
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; events.emit("output"); });
  child.stderr.on("data", (chunk) => { output += chunk; events.emit("output"); });
  child.on("exit", () => events.emit("output"));
  child.on("error", (error) => { output += error.message; events.emit("output"); });
  return {
    child, output: () => output,
    wait: (pattern: RegExp, after = 0) => new Promise<string>((resolveWait, reject) => {
      const timer = setTimeout(() => finish(new Error(`No ${pattern}: ${output}`)), 15000);
      const check = () => {
        if (pattern.test(output.slice(after))) finish();
        else if (child.exitCode !== null || child.signalCode !== null) finish(new Error(`Exited before ${pattern}: ${output}`));
      };
      const finish = (error?: Error) => { clearTimeout(timer); events.off("output", check); error ? reject(error) : resolveWait(output); };
      events.on("output", check);
      check();
    }),
  };
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
  child.kill("SIGTERM");
  try { await exited; } finally { clearTimeout(timer); }
}

function nextMessage(client: IntercomClient) {
  return once(client, "message").then(([from, message]) => ({ from: from as SessionInfo, message: message as Message }));
}

test("real mTLS bridge admits only messaging, preserves peer identity and cancels waits", { timeout: 90000 }, async (t) => {
  const root = mkdtempSync("/tmp/pib-");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const env = { ...process.env, HOME: root, TMPDIR: root, TMP: root, TEMP: root };
  // Keep this process's socket discovery consistent with its isolated broker.
  const previousTmp = process.env.TMPDIR;
  process.env.TMPDIR = root;
  const credentials = join(root, "credentials");
  const tools = join(repo, "scripts/intercom-bridge-credentials.mjs");
  const runTool = async (...args: string[]) => JSON.parse((await exec(process.execPath, [tools, ...args], { env })).stdout);
  let broker: ReturnType<typeof start> | undefined;
  let bridge: ReturnType<typeof start> | undefined;
  const clients: IntercomClient[] = [];
  const agent = async (name: string) => {
    const client = new IntercomClient();
    client.on("error", () => {});
    clients.push(client);
    await client.connect({ name, cwd: root, model: "fixture", status: "idle", acceptsAsks: true });
    return client;
  };
  try {
    const credential = await runTool("init", credentials, "grok-bot", "--cwd", root);
    const unpinned = await runTool("issue", credentials, "unapproved");
    const configPath = join(credentials, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.clients = config.clients.filter((client) => client.name === "grok-bot");
    config.port = 0;
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    broker = start("src/pi-intercom/broker/broker.ts", [], env);
    await broker.wait(/Intercom broker started/);
    const peer = await agent("known-peer");
    const intruder = await agent("wrong-replier");
    bridge = start("src/pi-intercom/bridge.ts", ["--config", configPath], env);
    const listening = await bridge.wait(/"event":"listening"/);
    const record = listening.split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((line) => line.event === "listening");
    assert.equal(record.host, "127.0.0.1");
    const url = `https://127.0.0.1:${record.port}`;
    const tls = { ca: readFileSync(credential.ca), cert: readFileSync(credential.cert), key: readFileSync(credential.key), rejectUnauthorized: true, agent: false as const };
    const api = (action: string, body?: unknown, extra = {}) => new Promise<{ status: number; body: any }>((resolveApi, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = https.request(`${url}/v1/${action}`, { ...tls, method: payload === undefined ? "GET" : "POST",
        headers: payload === undefined ? {} : { "Content-Type": "application/json" }, signal: AbortSignal.timeout(15000), ...extra,
      }, (res) => {
        let data = "";
        res.on("data", (chunk) => data += chunk);
        res.on("error", reject);
        res.on("end", () => { try { resolveApi({ status: res.statusCode!, body: JSON.parse(data) }); } catch (error) { reject(error); } });
      });
      req.on("error", reject);
      req.end(payload);
    });

    await t.test("mutual authentication, least privilege and real remote CLI", async () => {
      await assert.rejects(api("list", undefined, { cert: undefined, key: undefined }));
      await assert.rejects(api("list", undefined, { cert: readFileSync(unpinned.cert), key: readFileSync(unpinned.key) }));
      const registered = await api("register", {});
      assert.equal(registered.body.name, "grok-bot");
      const remoteId = registered.body.sessionId;
      assert.equal((await peer.listSessions()).find((row) => row.id === remoteId)?.name, "grok-bot");
      assert.equal((statSync(getBrokerSocketPath()).mode & 0o777), 0o600);
      for (const [action, body] of [["register", { name: "spoofed" }], ["send", { to: peer.sessionId, message: "unsafe", type: "unregister" }], ["presence", {}], ["send", { to: peer.sessionId, message: "bad\u001bcontrol" }]] as const) {
        const rejected = await api(action, body);
        assert.ok(rejected.status >= 400, JSON.stringify(rejected));
      }
      const originDenied = await api("list", undefined, { headers: { Origin: "https://evil.example" } });
      assert.equal(originDenied.status, 403);
      const cliEnv = { ...env, INTERCOM_BRIDGE_URL: url, INTERCOM_BRIDGE_CA: credential.ca, INTERCOM_BRIDGE_CERT: credential.cert, INTERCOM_BRIDGE_KEY: credential.key };
      const result = JSON.parse((await exec(process.execPath, [join(repo, "scripts/intercom-remote.mjs"), "list"], { env: cliEnv })).stdout);
      assert.equal(result.ok, true);
      assert.equal(result.sessions.find((row) => row.id === peer.sessionId).name, "known-peer");
      assert.ok(result.sessions.every((row) => row.topics === undefined && row.subscriptions === undefined));
      const receiving = nextMessage(peer);
      const sent = await api("send", { to: peer.sessionId!.slice(0, 8), message: "BODY_SENTINEL_NOT_FOR_LOGS" });
      assert.equal(sent.body.accepted, true);
      assert.equal((await receiving).from.id, remoteId);
      assert.equal((await api("send", { to: "offline-peer", message: "hello" })).status, 404);
    });

    await t.test("asks correlate exact sender and replyTo; inbox is non-destructive and replies cannot spoof targets", async () => {
      let settled = false;
      const receiving = nextMessage(peer);
      const asking = api("ask", { to: "known-peer", message: "ASK_SENTINEL", timeoutMs: 5000 });
      void asking.then(() => settled = true);
      const question = await receiving;
      assert.equal(question.message.expectsReply, true);
      assert.equal(question.message.delivery, "steer");
      const forged = await intruder.send(question.from.id, { text: "forged answer", replyTo: question.message.id });
      await bridge!.wait(new RegExp(`"messageId":"${forged.id}"`));
      const inbox = await api("inbox");
      assert.ok(inbox.body.messages.some((item) => item.message.content.text === "forged answer"));
      assert.equal(settled, false, "wrong sender must not satisfy the outgoing ask");
      await peer.send(question.from.id, { text: "bridge-smoke-ok", replyTo: question.message.id });
      const answer = await asking;
      assert.equal(answer.body.reply.from.id, peer.sessionId);
      assert.equal(answer.body.reply.message.content.text, "bridge-smoke-ok");
      assert.equal((await api("reply", { replyTo: "invented", message: "spoof" })).status, 404);
      const inbound = await peer.send(question.from.id, { text: "Local question", expectsReply: true, delivery: "steer" });
      const first = await api("inbox");
      assert.ok(first.body.messages.some((item) => item.message.id === inbound.id));
      assert.deepEqual((await api("inbox")).body.messages, first.body.messages);
      await api("ack", { ids: [inbound.id] });
      assert.ok((await api("inbox")).body.messages.some((item) => item.message.id === inbound.id));
      const replyReceipt = nextMessage(peer);
      const reply = await api("reply", { replyTo: inbound.id, message: "Remote decision" });
      assert.equal(reply.body.accepted, true);
      const observed = await replyReceipt;
      assert.equal(observed.message.replyTo, inbound.id);
      assert.equal(observed.message.content.text, "Remote decision");
      assert.ok(!(await api("inbox")).body.messages.some((item) => item.message.id === inbound.id));
      const notice = await peer.send(question.from.id, { text: "ordinary message" });
      assert.ok((await api("inbox")).body.messages.some((item) => item.message.id === notice.id));
      await api("ack", { ids: [notice.id] });
      assert.ok(!(await api("inbox")).body.messages.some((item) => item.message.id === notice.id));
    });

    await t.test("bounded input and inbox report overflow without losing retained messages", async () => {
      const rejected = await api("send", { to: peer.sessionId, message: "x".repeat(65536) });
      assert.equal(rejected.status, 413);
      const remoteId = (await api("register", {})).body.sessionId;
      const before = await api("inbox");
      let lastId = "";
      for (let index = before.body.messages.length; index <= 256; index++) {
        lastId = (await peer.send(remoteId, { text: `bounded notice ${index}` })).id;
      }
      await bridge!.wait(new RegExp(`"messageId":"${lastId}"`));
      const full = await api("inbox");
      assert.equal(full.body.messages.length, 256);
      assert.equal(full.body.overflow, true);
      assert.equal(full.body.lostMessages, 1);
      assert.equal((await peer.listSessions()).find((row) => row.id === remoteId)?.acceptsAsks, false);
      await api("ack", { ids: full.body.messages.map((item) => item.message.id) });
      assert.equal((await api("inbox")).body.messages.length, 0);
    });

    await t.test("timeout, peer departure, client cancellation and broker outage do not hang", async () => {
      const timed = await api("ask", { to: peer.sessionId, message: "no answer", timeoutMs: 100 });
      assert.equal(timed.status, 504);
      assert.equal(timed.body.error.code, "ask_timeout");
      const temporary = await agent("leaving-peer");
      const receiving = nextMessage(temporary);
      const asking = api("ask", { to: temporary.sessionId, message: "leave now", timeoutMs: 10000 });
      await receiving;
      await temporary.disconnect();
      assert.equal((await asking).body.error.code, "peer_offline");
      const controller = new AbortController();
      const cancelMessage = nextMessage(peer);
      const cancelled = api("ask", { to: peer.sessionId, message: "cancel now", timeoutMs: 10000 }, { signal: controller.signal });
      await cancelMessage;
      controller.abort();
      await assert.rejects(cancelled);
      await bridge!.wait(/"event":"session_closed"/);
      const afterCancel = await api("register", {});
      assert.equal(afterCancel.body.ok, true);
      await stop(broker!.child);
      const down = await api("list");
      assert.equal(down.status, 503);
      assert.equal(down.body.error.code, "broker_unavailable");
      broker = start("src/pi-intercom/broker/broker.ts", [], env);
      await broker.wait(/Intercom broker started/);
      await peer.connect({ name: "known-peer", cwd: root, model: "fixture", status: "idle" });
      assert.equal((await api("list")).body.ok, true);
    });

    await t.test("credential rotation and revoke cancel in-flight asks and deny the old certificate", async () => {
      const receiving = nextMessage(peer);
      const asking = api("ask", { to: peer.sessionId, message: "revoke during wait", timeoutMs: 10000 }).catch((error) => ({ transport: error }));
      await receiving;
      const rotated = await runTool("issue", credentials, "grok-bot");
      bridge!.child.kill("SIGHUP");
      await bridge!.wait(/"event":"allowlist_reloaded"/);
      await asking; // Revocation may terminate TLS before an HTTP error can be read.
      await assert.rejects(api("list"));
      const newTls = { cert: readFileSync(rotated.cert), key: readFileSync(rotated.key) };
      assert.equal((await api("register", {}, newTls)).body.name, "grok-bot");
      await runTool("revoke", credentials, "grok-bot");
      bridge!.child.kill("SIGHUP");
      // Use an actual new request as the authorization barrier, not a sleep.
      await bridge!.wait(/"clients":0/);
      await assert.rejects(api("list", undefined, newTls));
      const rows = await peer.listSessions();
      assert.ok(!rows.some((row) => row.name === "grok-bot"));
      const renewed = await runTool("issue", credentials, "grok-bot");
      let offset = bridge!.output().length;
      bridge!.child.kill("SIGHUP");
      await bridge!.wait(/"event":"allowlist_reloaded"/, offset);
      const renewedTls = { cert: readFileSync(renewed.cert), key: readFileSync(renewed.key) };
      assert.equal((await api("register", {}, renewedTls)).body.ok, true);
      writeFileSync(configPath, "{\"clients\":", { mode: 0o600 });
      offset = bridge!.output().length;
      bridge!.child.kill("SIGHUP");
      await bridge!.wait(/"result":"failed_closed"/, offset);
      await assert.rejects(api("list", undefined, renewedTls));
      assert.ok(!bridge!.output().includes("BODY_SENTINEL_NOT_FOR_LOGS"));
      assert.ok(!bridge!.output().includes("ASK_SENTINEL"));
      for (const line of bridge!.output().trim().split("\n")) assert.doesNotThrow(() => JSON.parse(line));
    });
  } finally {
    await Promise.all(clients.map((client) => client.disconnect()));
    if (bridge) await stop(bridge.child);
    if (broker) await stop(broker.child);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp;
    rmSync(root, { recursive: true, force: true });
  }
});

test("credential issue cannot overwrite a concurrent revocation", { timeout: 30000 }, async () => {
  const root = mkdtempSync("/tmp/pib-lock-");
  const dir = join(root, "credentials");
  const tool = join(repo, "scripts/intercom-bridge-credentials.mjs");
  let signingPid: number | undefined;
  let issuing: Promise<unknown> | undefined;
  try {
    const original = JSON.parse((await exec(process.execPath, [tool, "init", dir, "--cwd", root])).stdout);
    const ready = join(root, "signing-ready");
    const wrapper = join(root, "pause-openssl");
    writeFileSync(wrapper, `#!/usr/bin/env node
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
`, { mode: 0o700 });
    const signing = new Promise<void>((resolveReady, reject) => {
      const watcher = watch(root, (_event, name) => {
        if (name?.toString() !== "signing-ready") return;
        signingPid = Number(readFileSync(ready, "utf8"));
        clearTimeout(timer);
        watcher.close();
        resolveReady();
      });
      const timer = setTimeout(() => { watcher.close(); reject(new Error("Signer never reached key creation.")); }, 10000);
    });
    issuing = exec(process.execPath, [tool, "issue", dir, "maintenance"], { env: { ...process.env, OPENSSL: wrapper } });
    void issuing.catch(() => {});
    await signing; // Actual issue owns its read/modify/write window before testing the conflicting command.
    await assert.rejects(exec(process.execPath, [tool, "revoke", dir, "grok-bot"]), /Another credential command holds/);
    process.kill(signingPid!, "SIGUSR1");
    await issuing;
    const configPath = join(dir, "config.json");
    const clients = JSON.parse(readFileSync(configPath, "utf8")).clients;
    assert.equal(clients.find((client) => client.name === "grok-bot").fingerprint256, original.fingerprint256);
    await exec(process.execPath, [tool, "revoke", dir, "grok-bot"]);
    assert.ok(!JSON.parse(readFileSync(configPath, "utf8")).clients.some((client) => client.name === "grok-bot"));
  } finally {
    if (signingPid) { try { process.kill(signingPid, "SIGKILL"); } catch {} }
    if (issuing) await issuing.catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});
