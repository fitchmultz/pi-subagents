import "../support/isolated-home.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:https";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { IntercomClient } from "../../src/pi-intercom/broker/client.ts";
import { bridgeApi, exec, parseCredential, start, stop } from "../support/intercom-bridge.ts";
import { json, readJson, record, records, text } from "../support/assertions.ts";

const repo = resolve(import.meta.dirname, "../..");

async function fixture(t: test.TestContext, identities = 1, realClock = false) {
  const root = mkdtempSync("/tmp/pib-budget-");
  const env = {
    ...process.env,
    HOME: root,
    TMPDIR: root,
    TMP: root,
    TEMP: root,
    PI_CODING_AGENT_DIR: join(root, "agent"),
  };
  const keys = join(root, "keys");
  const credentials = [];
  for (let index = 0; index < identities; index++) {
    // oxlint-disable-next-line no-await-in-loop
    const result = await exec(
      process.execPath,
      [
        join(repo, "scripts/intercom-bridge-credentials.mjs"),
        index === 0 ? "init" : "issue",
        keys,
        `bot-${index}`,
        "--cwd",
        root,
      ],
      { env },
    );
    credentials.push(parseCredential(json(result.stdout)));
  }
  const configPath = join(keys, "config.json");
  const config = record(readJson(configPath));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { mode: 0o700 });
  const requests: { readonly path: string | undefined; readonly body: unknown }[] = [];
  const server = createServer(
    { cert: readFileSync(text(config.cert)), key: readFileSync(text(config.key)) },
    (req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      req.on("end", () => {
        requests.push({ path: req.url, body: JSON.parse(body) as unknown });
        res.writeHead(400);
        res.end();
      });
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening", { signal: t.signal });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  for (const [index, client] of records(config.clients).entries()) {
    const envFile = join(root, `wake-${index}.env`);
    writeFileSync(
      envFile,
      `GROK_WAKE_WEBHOOK_URL=https://127.0.0.1:${address.port}/${index === 1 ? "other" : "wake"}\nGROK_WAKE_WEBHOOK_KEY=fixture-secret\n`,
      { mode: 0o600 },
    );
    client.wake = { envFile };
  }
  config.stateDir = stateDir;
  config.port = 0;
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const helperEnv = {
    ...env,
    NODE_EXTRA_CA_CERTS: credentials[0].ca,
    PI_FIXTURE_CLOCK_FILE: join(root, "fixture-clock"),
  };
  const broker = start("src/pi-intercom/broker/broker.ts", [], env);
  await broker.wait(/Intercom broker started/);
  // IntercomClient paths are resolved from this process's environment.
  const oldAgent = process.env.PI_CODING_AGENT_DIR;
  const oldTmp = process.env.TMPDIR;
  process.env.PI_CODING_AGENT_DIR = env.PI_CODING_AGENT_DIR;
  process.env.TMPDIR = root;
  const peer = new IntercomClient();
  peer.on("error", () => {
    /* Teardown owns broker shutdown. */
  });
  await peer.connect({ name: "sender", cwd: root, model: "fixture" });
  let bridge = start(
    realClock ? "src/pi-intercom/bridge.ts" : "test/fixtures/intercom-bridge-clock.ts",
    ["--config", configPath],
    helperEnv,
  );
  const apis = [];
  const remoteIds = [];
  for (const credential of credentials) {
    // oxlint-disable-next-line no-await-in-loop
    const api = await bridgeApi(bridge, credential);
    apis.push(api);
    // oxlint-disable-next-line no-await-in-loop
    remoteIds.push(text((await api.api("register", {})).body.sessionId));
  }
  const quotaPath = join(stateDir, "wake-quota.sqlite");
  const clock = async (signal: NodeJS.Signals) => {
    const after = bridge.output().length;
    bridge.child.kill(signal);
    await bridge.wait(/"event":"fixture_clock"/, after);
  };
  const restart = async (extra: Readonly<NodeJS.ProcessEnv> = {}) => {
    await stop(bridge.child);
    bridge = start("test/fixtures/intercom-bridge-clock.ts", ["--config", configPath], {
      ...helperEnv,
      ...extra,
    });
    await bridge.wait(/"event":"listening"/);
    if (extra.PI_FIXTURE_CRASH_BEFORE_FETCH !== "1") {
      await clock("SIGALRM");
      await bridge.wait(/"event":"registered"/);
      await clock("SIGWINCH");
      for (let index = 1; index < identities; index++) {
        // oxlint-disable-next-line no-await-in-loop
        await bridge.wait(new RegExp(`"event":"registered","name":"bot-${index}"`));
      }
    }
    return bridge;
  };
  const rows = (sql: string) => {
    const db = new DatabaseSync(quotaPath);
    try {
      db.exec("PRAGMA busy_timeout=1000");
      return db.prepare(sql).all();
    } finally {
      db.close();
    }
  };
  t.after(async () => {
    await peer.disconnect();
    await stop(bridge.child);
    await stop(broker.child);
    server.closeAllConnections();
    await new Promise<void>((resolveClose, reject) => {
      server.close((error) => (error ? reject(error) : resolveClose()));
    });
    if (oldAgent === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = oldAgent;
    }
    if (oldTmp === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = oldTmp;
    }
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    env,
    configPath,
    quotaPath,
    credentials,
    apis,
    remoteIds,
    requests,
    server,
    peer,
    clock,
    restart,
    rows,
    current: () => bridge,
  };
}

test(
  "real mailbox commit reaches HTTPS just after ACK grace without consumer polling",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t, 1, true);
    const healthy = await f.peer.send(f.remoteIds[0], { text: "already received by primary" });
    await f.current().wait(new RegExp(`"messageId":"${healthy.id}"`));
    assert.deepEqual((await f.apis[0].api("ack", { ids: [healthy.id] })).body.acked, [healthy.id]);
    const payload = "actionable large payload " + "x".repeat(150000);
    const started = performance.now();
    const cold = await f.peer.send(f.remoteIds[0], { text: payload });
    await f.current().wait(new RegExp(`"messageId":"${cold.id}".*"result":"http_rejected"`));
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= 1900, `ACK coordination grace: ${elapsed}ms`);
    assert.ok(elapsed < 6000, `event-driven cold latency: ${elapsed}ms`);
    assert.equal(f.requests.length, 1, "healthy ACK prevents fallback; cold mail alone wakes");
    assert.equal(record(f.requests[0].body).text, payload);
    t.diagnostic(`real broker commit -> HTTPS result: ${elapsed.toFixed(0)}ms`);
  },
);

test(
  "FULL commit delay cannot shorten healthy consumer ACK grace",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t, 1, true);
    const mailboxPath = join(
      f.root,
      "state",
      `${f.credentials[0].fingerprint256.replaceAll(":", "").toUpperCase()}.sqlite`,
    );
    const locked = new DatabaseSync(mailboxPath);
    locked.exec("BEGIN IMMEDIATE");
    const release = delay(900).then(() => {
      locked.exec("COMMIT");
      return;
    });
    const started = performance.now();
    let id: string;
    try {
      id = (
        await f.peer.send(f.remoteIds[0], {
          text: "healthy fsynced intake after real SQLite contention",
        })
      ).id;
      await f.current().wait(new RegExp(`"messageId":"${id}".*"result":"stored"`));
    } finally {
      await release;
      locked.close();
    }
    const committed = performance.now();
    assert.ok(committed - started >= 800, "real SQLite writer contention delayed mailbox commit");
    const intake = (await f.apis[0].api("inbox")).body;
    const fd = openSync(join(f.root, "primary-intake.json"), "w", 0o600);
    try {
      writeSync(fd, JSON.stringify(intake));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    await delay(1400, undefined, { signal: t.signal });
    assert.deepEqual((await f.apis[0].api("ack", { ids: [id] })).body.acked, [id]);
    assert.ok(
      performance.now() - committed < 2000,
      "successful primary ACK is within post-commit grace",
    );
    assert.equal(f.requests.length, 0, "FULL commit wait must not spend the primary's ACK grace");
    assert.equal(f.rows("SELECT attemptedAt FROM wake_attempts").length, 0);
    const cold = await f.peer.send(f.remoteIds[0], {
      text: "cold wake witnesses processing beyond the prior ACK grace",
    });
    await f.current().wait(new RegExp(`"messageId":"${cold.id}".*"result":"http_rejected"`));
    assert.equal(
      f.requests.length,
      1,
      "actual owner transport witnesses no late fallback for healthy ACK",
    );
    assert.equal(record(f.requests[0].body).message_id, cold.id);
  },
);

test(
  "wake-key reload preserves unread retry after owner timers and authenticated reattachment",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t, 3);
    const sent = await f.peer.send(f.remoteIds[0], { text: "unACKed through wake-key rotation" });
    await f.current().wait(new RegExp(`"messageId":"${sent.id}".*"result":"stored"`));
    await f.clock("SIGWINCH");
    await f.current().wait(/"result":"http_rejected"/);
    const attemptTime = f.rows("SELECT attemptedAt FROM wake_attempts")[0].attemptedAt;
    assert.ok(typeof attemptTime === "number");
    const envFile = join(f.root, "wake-0.env");
    writeFileSync(
      envFile,
      readFileSync(envFile, "utf8").replace("KEY=fixture-secret", "KEY=rotated-secret"),
      { mode: 0o600 },
    );
    const after = f.current().output().length;
    f.current().child.kill("SIGHUP");
    await f.current().wait(/"event":"allowlist_reloaded"/, after);
    await f.clock("SIGWINCH");
    assert.deepEqual(
      f.rows("SELECT due FROM wake_batches").map((row) => row.due),
      [attemptTime + 30000],
      "scheduled reconciliation must retain the original retry deadline without ACK",
    );
    const inbox = await f.apis[0].api("inbox");
    assert.equal(inbox.status, 200);
    assert.equal(records(inbox.body.messages).length, 1);
    await f.clock("SIGWINCH");
    assert.deepEqual(
      f.rows("SELECT due FROM wake_batches").map((row) => row.due),
      [attemptTime + 30000],
    );
    assert.equal(
      f.requests.length,
      1,
      "reconnection cannot POST the same unread obligation four seconds later",
    );
  },
);

test(
  "all URLs/fingerprints share 20 durable attempts; reload, rotation, and crash cannot reset quota",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t, 3);
    for (let index = 0; index < 20; index++) {
      const identity = index % 3;
      // oxlint-disable-next-line no-await-in-loop
      const sent = await f.peer.send(f.remoteIds[identity], { text: `cold request ${index}` });
      // oxlint-disable-next-line no-await-in-loop
      await f.current().wait(new RegExp(`"messageId":"${sent.id}"`));
      const after = f.current().output().length;
      // oxlint-disable-next-line no-await-in-loop
      await f.clock("SIGWINCH");
      // oxlint-disable-next-line no-await-in-loop
      await f.current().wait(/"result":"http_rejected"/, after);
      assert.equal(f.requests.length, index + 1);
      // Actual ACK permits a fresh immediate wake, without inheriting the prior batch's backoff.
      // oxlint-disable-next-line no-await-in-loop
      assert.deepEqual((await f.apis[identity].api("ack", { ids: [sent.id] })).body.acked, [
        sent.id,
      ]);
    }
    assert.equal(
      f.rows("SELECT attemptedAt FROM wake_attempts").length,
      20,
      "400s also consume allowance",
    );
    assert.ok(f.requests.some((request) => request.path === "/other"));
    const final = await f.peer.send(f.remoteIds[0], { text: "quota-deferred payload" });
    await f.current().wait(new RegExp(`"messageId":"${final.id}"`));
    await f.clock("SIGWINCH");
    assert.equal(f.requests.length, 20);
    const reloaded = f.current().output().length;
    f.current().child.kill("SIGHUP");
    await f.current().wait(/"event":"allowlist_reloaded"/, reloaded);
    await f.clock("SIGALRM");
    assert.equal(f.requests.length, 20);
    const rotated = parseCredential(
      json(
        (
          await exec(
            process.execPath,
            [
              join(repo, "scripts/intercom-bridge-credentials.mjs"),
              "issue",
              join(f.root, "keys"),
              "bot-1",
              "--cwd",
              f.root,
            ],
            { env: f.env },
          )
        ).stdout,
      ),
    );
    const beforeRotation = f.current().output().length;
    f.current().child.kill("SIGHUP");
    await f.current().wait(/"event":"allowlist_reloaded"/, beforeRotation);
    const rotatedApi = await bridgeApi(f.current(), rotated);
    const rotatedId = text((await rotatedApi.api("register", {})).body.sessionId);
    const fresh = await f.peer.send(rotatedId, { text: "rotation does not buy more capacity" });
    await f.current().wait(new RegExp(`"messageId":"${fresh.id}"`));
    await f.clock("SIGWINCH");
    assert.equal(f.requests.length, 20);
    await f.restart();
    assert.equal(f.requests.length, 20);
    const after = f.current().output().length;
    await f.clock("SIGQUIT");
    await f.current().wait(/"result":"http_rejected"/, after);
    const otherAfter = f.current().output().length;
    await f.clock("SIGWINCH");
    await f.current().wait(/"result":"http_rejected"/, otherAfter);
    assert.equal(f.requests.length, 22, "two URLs recover automatically at the budget deadline");
    assert.ok(f.requests.some((request) => record(request.body).message_id === final.id));
    assert.ok(f.requests.some((request) => record(request.body).message_id === fresh.id));
  },
);

test(
  "healthy fsynced ACK, passive and exact note prefixes suppress wake; explicit asks and retained fingerprints coalesce",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t, 3);
    const messages = [
      "ACK: done",
      "DUP-ACK done",
      "FYI: info",
      "NOTE: " + "x".repeat(100000),
      "RECEIPT",
      "NOWAKE: later",
    ];
    const ids = [];
    for (const message of messages) {
      // oxlint-disable-next-line no-await-in-loop
      ids.push((await f.peer.send(f.remoteIds[0], { text: message })).id);
    }
    const passiveAsk = await f.peer.send(f.remoteIds[0], {
      text: "ACK: passive ask",
      delivery: "passive",
    });
    const healthy = await f.peer.send(f.remoteIds[0], {
      text: "healthy primary intake",
      expectsReply: true,
    });
    await f.current().wait(new RegExp(`"messageId":"${healthy.id}"`));
    const intake = (await f.apis[0].api("inbox")).body;
    const fd = openSync(join(f.root, "primary-intake.json"), "w", 0o600);
    try {
      writeSync(fd, JSON.stringify(intake));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    assert.deepEqual((await f.apis[0].api("ack", { ids: [healthy.id] })).body.acked, [healthy.id]);
    await f.clock("SIGWINCH");
    assert.equal(f.requests.length, 0);
    assert.equal(
      records((await f.apis[0].api("inbox")).body.messages).length,
      7,
      "suppression preserves every unacknowledged payload",
    );
    const explicit = await f.peer.send(f.remoteIds[0], {
      text: "ACK: please answer this request",
      expectsReply: true,
    });
    const joined = [];
    for (let index = 0; index < 32; index++) {
      // oxlint-disable-next-line no-await-in-loop
      joined.push((await f.peer.send(f.remoteIds[2], { text: `same URL flood ${index}` })).id);
    }
    await f.current().wait(new RegExp(`"messageId":"${joined[31]}"`));
    const after = f.current().output().length;
    await f.clock("SIGWINCH");
    await f.current().wait(/"result":"http_rejected"/, after);
    assert.equal(f.requests.length, 1, "all retained fingerprints on a URL form one cold batch");
    assert.equal(record(f.requests[0].body).message_id, explicit.id);
    assert.equal(record(f.requests[0].body).ask_id, explicit.id);
    for (let index = 0; index < 32; index++) {
      // oxlint-disable-next-line no-await-in-loop
      joined.push((await f.peer.send(f.remoteIds[2], { text: `after POST flood ${index}` })).id);
    }
    await f.current().wait(new RegExp(`"messageId":"${joined[63]}"`));
    await f.clock("SIGWINCH");
    assert.equal(f.requests.length, 1, "new pending flood does not bypass cold batch backoff");
    assert.deepEqual(
      (await f.apis[0].api("ack", { ids: [explicit.id, passiveAsk.id] })).body.acked,
      [explicit.id, passiveAsk.id],
    );
    const attemptTime = f.rows("SELECT attemptedAt FROM wake_attempts")[0].attemptedAt;
    assert.ok(typeof attemptTime === "number");
    await f.restart();
    assert.deepEqual(
      f.rows("SELECT due FROM wake_batches").map((row) => row.due),
      [attemptTime + 30000],
      "restart retains the exact original uncertainty deadline across all fingerprints",
    );
    assert.equal(
      f.requests.length,
      1,
      "empty first fingerprint cannot reset another fingerprint's persisted retry",
    );
    f.apis[0] = await bridgeApi(f.current(), f.credentials[0]);
    f.apis[2] = await bridgeApi(f.current(), f.credentials[2]);
    assert.deepEqual((await f.apis[2].api("ack", { ids: joined })).body.acked, joined);
    await f.clock("SIGUSR1");
    assert.equal(f.requests.length, 1, "real ACKs transfer durable intake and retire notification");
    const newMail = await f.peer.send(f.remoteIds[0], {
      text: "ACKNOWLEDGE is not an exact ACK prefix",
    });
    await f.current().wait(new RegExp(`"messageId":"${newMail.id}"`));
    const newAfter = f.current().output().length;
    await f.clock("SIGWINCH");
    await f.current().wait(/"result":"http_rejected"/, newAfter);
    assert.equal(
      f.requests.length,
      2,
      "new work after actual ACK has no five-minute success delay",
    );
  },
);

test("failed POST settlement recovers after ACK even with no remaining candidate", async (t) => {
  const f = await fixture(t);
  // At the wire boundary the pre-POST reservation is already durable; deny only its completion.
  f.server.once("request", () => chmodSync(f.quotaPath, 0o644));
  const sent = await f.peer.send(f.remoteIds[0], {
    text: "actionable work ACKed after failed completion write",
  });
  await f.current().wait(new RegExp(`"messageId":"${sent.id}".*"result":"stored"`));
  const publicationDeadline = performance.now() + 5000;
  while (f.rows("SELECT due FROM wake_batches").length === 0) {
    assert.ok(performance.now() < publicationDeadline, "owner published the post-commit grace");
    // oxlint-disable-next-line no-await-in-loop
    await delay(5);
  }
  const after = f.current().output().length;
  await f.clock("SIGWINCH");
  await f.current().wait(/"result":"storage_unavailable"/, after);
  assert.equal(f.requests.length, 1);
  assert.equal(f.rows("SELECT settledAt FROM wake_attempts")[0].settledAt, null);
  chmodSync(f.quotaPath, 0o600);
  assert.deepEqual((await f.apis[0].api("ack", { ids: [sent.id] })).body.acked, [sent.id]);
  await f.clock("SIGALRM");
  assert.equal(f.rows("SELECT due FROM wake_batches").length, 0, "real ACK retired the candidate");
  assert.equal(
    typeof f.rows("SELECT settledAt FROM wake_attempts")[0].settledAt,
    "number",
    "empty reconciliation still retries the failed durable settlement",
  );
  assert.equal(f.requests.length, 1, "settlement repair never replays the consumed payload");
});

test(
  "reservation survives crash before POST; permission and corrupt ledger fail closed",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    chmodSync(f.quotaPath, 0o644);
    const sent = await f.peer.send(f.remoteIds[0], { text: "retained through storage failure" });
    await f.current().wait(new RegExp(`"messageId":"${sent.id}"`));
    const after = f.current().output().length;
    await f.clock("SIGWINCH");
    await f.current().wait(/"result":"storage_unavailable"/, after);
    assert.equal(f.requests.length, 0);
    chmodSync(f.quotaPath, 0o600);
    const locked = new DatabaseSync(f.quotaPath);
    try {
      locked.exec("BEGIN IMMEDIATE");
      const busyAfter = f.current().output().length;
      await f.clock("SIGALRM");
      await f.current().wait(/"result":"storage_unavailable"/, busyAfter);
      assert.equal(f.requests.length, 0, "SQLite reservation failure cannot dispatch HTTP");
      assert.equal(f.rows("SELECT attemptedAt FROM wake_attempts").length, 0);
    } finally {
      locked.exec("ROLLBACK");
      locked.close();
    }
    await f.restart({ PI_FIXTURE_CRASH_BEFORE_FETCH: "1" });
    const crashed = once(f.current().child, "close", { signal: t.signal });
    await f.clock("SIGUSR2");
    f.current().child.kill("SIGWINCH");
    await crashed;
    assert.equal(f.requests.length, 0, "crash injected at transport boundary before any HTTP POST");
    assert.equal(f.rows("SELECT attemptedAt FROM wake_attempts").length, 1);
    assert.equal(f.rows("SELECT due FROM wake_batches").length, 1);
    await f.restart();
    assert.equal(f.requests.length, 0, "no re-POST 15 seconds after cold restart");
    const recovered = f.current().output().length;
    await f.clock("SIGUSR2");
    await f.current().wait(/"result":"http_rejected"/, recovered);
    assert.equal(f.requests.length, 1);
    assert.equal(record(f.requests[0].body).message_id, sent.id);
    await stop(f.current().child);
    writeFileSync(f.quotaPath, "corrupt quota ledger", { mode: 0o600 });
    await assert.rejects(f.restart(), /Exited before/);
    assert.equal(f.requests.length, 1, "corrupt ledger cannot grant a reset allowance");
  },
);
