import "../support/isolated-home.ts";
import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { X509Certificate } from "node:crypto";
import { IntercomClient } from "../../src/pi-intercom/broker/client.ts";
import { exec, start, stop, parseCredential } from "../support/intercom-bridge.ts";
import { nativeSdkRoot, nativeCli } from "../support/native-sdk.ts";
import { json, readJson, record, records, text, numberValue } from "../support/assertions.ts";
import { hasErrorCode, type UnknownRecord } from "../../src/shared/unknown.ts";

const repo = resolve(import.meta.dirname, "../..");
const sdk = nativeSdkRoot(process.env.PI_INTERCOM_TEST_SDK);
const context =
  "This session was launched at the local owner's request through the authenticated Intercom bridge. Stay idle until an Intercom task arrives; reply through Intercom.";
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const signal = AbortSignal.timeout(15000);
  let done = await check();
  while (!done) {
    // Observe an actual receipt/state; the delay alone never proves processing.
    // oxlint-disable-next-line no-await-in-loop
    await delay(25, undefined, { signal });
    // Each iteration observes the actual owner before continuing, not a fixed sleep assertion.
    // oxlint-disable-next-line no-await-in-loop
    done = await check();
  }
}
function gone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (hasErrorCode(error, "ESRCH")) {
      return true;
    }
    throw error;
  }
}

function api(url: string, credential: ReturnType<typeof parseCredential>) {
  const tls = {
    ca: readFileSync(credential.ca),
    cert: readFileSync(credential.cert),
    key: readFileSync(credential.key),
    agent: false as const,
  };
  return (action: string, body?: unknown, signal = AbortSignal.timeout(20000)) =>
    new Promise<{ readonly status: number; readonly body: UnknownRecord }>((resolveApi, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = https.request(
        `${url}/v1/${action}`,
        {
          ...tls,
          method: payload === undefined ? "GET" : "POST",
          headers: payload === undefined ? {} : { "Content-Type": "application/json" },
          signal,
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
              reject(error instanceof Error ? error : new Error("Invalid bridge response"));
              return;
            }
            resolveApi({ status: res.statusCode ?? 0, body: parsed });
          });
        },
      );
      req.on("error", reject);
      req.end(payload);
    });
}

test(
  "controlled mTLS launches own persistent native RPC peers, wakes them and observes cleanup",
  { timeout: 180000 },
  async (t) => {
    const root = realpathSync(mkdtempSync("/tmp/pib-launch-"));
    const cwd = join(root, "project");
    const sessions = join(root, "sessions");
    const receipts = join(root, "receipts");
    for (const dir of [cwd, sessions, receipts, join(root, "home"), join(root, "agent")]) {
      mkdirSync(dir, { mode: 0o700 });
    }
    const input = join(root, "input.json");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: join(root, "home"),
      USERPROFILE: join(root, "home"),
      TMPDIR: root,
      TMP: root,
      TEMP: root,
      PI_CODING_AGENT_DIR: join(root, "agent"),
      PI_PACKAGE_DIR: sdk,
      PI_INTERCOM_TEST_SDK: sdk,
      PI_INTERCOM_LAUNCH_FIXTURE: input,
      PI_OFFLINE: "1",
      JITI_FS_CACHE: join(root, "jiti"),
      PI_SUBAGENT_INTERCOM_SESSION_NAME: "must-not-impersonate-supervisor-child",
      PI_SUBAGENT_ORCHESTRATOR_TARGET: "must-not-route-to-inherited-supervisor",
      PI_SUBAGENT_RUN_ID: "inherited-run",
      PI_SUBAGENT_CHILD_AGENT: "inherited-agent",
      PI_SUBAGENT_CHILD_INDEX: "0",
    };
    delete env.PI_TIMING;
    delete env.PI_EXTENSION_PERFORMANCE;
    const credentials = join(root, "credentials");
    const tool = join(repo, "scripts/intercom-bridge-credentials.mjs");
    const runTool = async (...args: readonly string[]) =>
      json((await exec(process.execPath, [tool, ...args], { env })).stdout);
    const credential = parseCredential(
      await runTool("init", credentials, "grok-bot", "--cwd", cwd),
    );
    const remote = async (url: string, ...args: readonly string[]) =>
      json(
        (
          await exec(process.execPath, [join(repo, "scripts/intercom-remote.mjs"), ...args], {
            env: {
              ...env,
              INTERCOM_BRIDGE_URL: url,
              INTERCOM_BRIDGE_CA: credential.ca,
              INTERCOM_BRIDGE_CERT: credential.cert,
              INTERCOM_BRIDGE_KEY: credential.key,
            },
          })
        ).stdout,
      );
    const other = parseCredential(await runTool("issue", credentials, "other-bot", "--cwd", cwd));
    const configPath = join(credentials, "config.json");
    const config = record(readJson(configPath));
    const policy = {
      packageRoot: sdk,
      sessionDir: sessions,
      provider: "launch-fixture",
      model: "faux-1",
      context,
      extensions: [
        join(repo, "src/pi-intercom/index.ts"),
        join(repo, "test/fixtures/intercom-launch-provider.mjs"),
      ],
      offline: true,
      discoverResources: false,
      trustProject: false,
      maxSessions: 1,
      startupTimeoutMs: 12000,
    };
    const clients = records(config.clients);
    const grok = clients.find((client) => client.name === "grok-bot");
    assert.ok(grok);
    grok.launch = policy;
    config.port = 0;
    const save = () => writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    const scenario = (value: string) =>
      writeFileSync(input, JSON.stringify({ scenario: value, receipts }), { mode: 0o600 });
    save();
    scenario("reply");
    const broker = start("src/pi-intercom/broker/broker.ts", [], env);
    let bridge: ReturnType<typeof start> | undefined;
    const pids = new Set<number>();
    const launchBridge = async (file = "src/pi-intercom/bridge.ts", client = credential) => {
      const active = start(file, ["--config", configPath], env);
      bridge = active;
      const output = await active.wait(/"event":"listening"/);
      const listening = output
        .split("\n")
        .filter(Boolean)
        .map(json)
        .find((row) => row.event === "listening");
      assert.ok(listening);
      const url = `https://127.0.0.1:${numberValue(listening.port)}`;
      return { active, url, request: api(url, client) };
    };
    const nativeReceipts = () =>
      readdirSync(receipts).map((name) => record(readJson(join(receipts, name))));
    const receipt = (pid: number) => {
      const matches = nativeReceipts().filter((row) => row.pid === pid || row.ppid === pid);
      assert.equal(matches.length, 1, "one real native runtime must belong to the CLI owner");
      const runtime = record(matches[0]);
      const runtimePid = numberValue(runtime.pid);
      pids.add(runtimePid);
      const cli = realpathSync(nativeCli(sdk));
      assert.equal(
        realpathSync(text(runtime.cli)),
        runtimePid === pid ? cli : realpathSync(join(dirname(cli), "cli-worker.js")),
        "runtime must be the selected manifest CLI or its actual native supervised worker",
      );
      return runtime;
    };
    const observedExit = async (active: ReturnType<typeof start>, pid: number) => {
      await active.wait(new RegExp(`"event":"launch_exit","pid":${pid},`));
      assert.equal(gone(pid), true, "kernel must confirm child is no longer alive");
      const runtimePid = numberValue(receipt(pid).pid);
      await until(() => gone(runtimePid));
      assert.equal(gone(runtimePid), true, "native runtime must exit with its CLI owner");
    };
    const previousAgent = process.env.PI_CODING_AGENT_DIR;
    const previousTmp = process.env.TMPDIR;
    process.env.PI_CODING_AGENT_DIR = env.PI_CODING_AGENT_DIR;
    process.env.TMPDIR = root;
    const observer = new IntercomClient();
    try {
      await broker.wait(/Intercom broker started/);
      await observer.connect({
        name: "launch-observer",
        cwd,
        model: "fixture",
        status: "idle",
      });
      assert.ok((await observer.listSessions()).some((peer) => peer.id === observer.sessionId));
      const running = await launchBridge();
      await t.test(
        "native persistence and idle readiness precede inference; ordinary mTLS ask invokes real reply tool",
        async () => {
          assert.equal((await api(running.url, other)("start", { name: "denied" })).status, 403);
          assert.equal((await running.request("start", { name: "bad", cwd: root })).status, 400);
          const created = await running.request("start", { name: "planner" });
          assert.equal(created.status, 200, JSON.stringify(created.body));
          const peer = record(created.body.session);
          assert.equal(peer.name, "remote:grok-bot:planner");
          assert.equal(peer.status, "idle");
          const pid = numberValue(peer.pid);
          pids.add(pid);
          assert.equal(receipt(pid).calls, 0);
          assert.equal(receipt(pid).networkRequests, 0);
          assert.equal(receipt(pid).cwd, cwd);
          assert.equal(receipt(pid).sessionId, peer.sessionId);
          assert.equal(receipt(pid).sessionFile, peer.sessionFile);
          const file = text(peer.sessionFile);
          assert.equal(statSync(file).mode & 0o777, 0o600);
          const saved = SessionManager.open(file, sessions);
          assert.equal(saved.getSessionId(), peer.sessionId);
          assert.equal(saved.getSessionName(), "remote:grok-bot:planner");
          assert.ok(
            saved
              .getEntries()
              .some(
                (entry) =>
                  entry.type === "message" &&
                  entry.message.role === "user" &&
                  entry.message.content === context,
              ),
          );
          const listed = await running.request("list");
          assert.ok(
            records(listed.body.sessions).some(
              (row) => row.id === peer.peerId && row.name === peer.name,
            ),
          );
          const reused = await remote(running.url, "start", "--name", "planner");
          assert.equal(reused.reused, true);
          assert.equal(record(reused.session).sessionId, peer.sessionId);
          assert.equal((await running.request("start", { name: "second" })).status, 429);
          assert.equal(
            (await api(running.url, other)("stop", { sessionId: peer.sessionId })).status,
            404,
          );
          const reply = await running.request("ask", {
            to: peer.peerId,
            message: "Reply using the real Intercom tool.",
            timeoutMs: 10000,
          });
          assert.equal(reply.status, 200, JSON.stringify(reply.body));
          assert.equal(record(record(reply.body.reply).message).replyTo, reply.body.id);
          assert.equal(
            record(record(record(reply.body.reply).message).content).text,
            "native-launch-reply",
          );
          assert.ok(numberValue(receipt(pid).calls) >= 1);
          assert.equal(gone(pid), false);
          assert.equal(records((await remote(running.url, "sessions")).sessions).length, 1);
          const stopped = await remote(running.url, "stop", "--session-id", text(peer.sessionId));
          assert.equal(record(stopped.session).status, "exited");
          await observedExit(running.active, pid);
          assert.equal(existsSync(file), true, "stop retains the real journal for local recovery");
          assert.ok(!running.active.output().includes("Reply using the real Intercom tool."));
        },
      );
      await t.test(
        "client abort and native startup deadline reap actual stalled children",
        async () => {
          scenario("stall");
          const previousReceipts = new Set(readdirSync(receipts));
          const controller = new AbortController();
          const pending = running.request("start", { name: "cancelled" }, controller.signal);
          const observed = pending.catch((error: unknown) => error);
          await until(() =>
            readdirSync(receipts).some(
              (name) =>
                !previousReceipts.has(name) &&
                record(readJson(join(receipts, name))).started === true,
            ),
          );
          const runtime = record(
            readJson(
              join(
                receipts,
                text(readdirSync(receipts).find((name) => !previousReceipts.has(name))),
              ),
            ),
          );
          const cancelled = records((await running.request("sessions")).body.sessions).find(
            (row) => row.sessionId === runtime.sessionId,
          );
          assert.ok(cancelled, "new native session must belong to the pending launch");
          const pid = numberValue(cancelled.pid);
          pids.add(pid);
          assert.equal(receipt(pid).pid, runtime.pid);
          controller.abort();
          await observed;
          await observedExit(running.active, pid);
          policy.startupTimeoutMs = 1500;
          save();
          const offset = running.active.output().length;
          running.active.child.kill("SIGHUP");
          await running.active.wait(/"event":"allowlist_reloaded"/, offset);
          const timed = await running.request("start", { name: "deadline" });
          assert.ok(timed.status >= 400);
          assert.equal(record(timed.body.error).code, "launch_timeout");
          const rows = records((await running.request("sessions")).body.sessions);
          const dead = rows.find((row) => row.name === "remote:grok-bot:deadline");
          assert.ok(dead);
          const deadPid = numberValue(dead.pid);
          pids.add(deadPid);
          await observedExit(running.active, deadPid);
          policy.startupTimeoutMs = 12000;
          save();
          running.active.child.kill("SIGHUP");
          await running.active.wait(/"event":"allowlist_reloaded"/, running.active.output().length);
        },
      );
      await t.test(
        "early native activity cannot admit a duplicate start and stalled broker readiness obeys the launch deadline",
        async () => {
          let paused = false;
          const pausedAt = running.active.output().length;
          let pending:
            | Promise<{ readonly status: number; readonly body: UnknownRecord }>
            | undefined;
          try {
            scenario("early-work");
            policy.startupTimeoutMs = 2500;
            save();
            running.active.child.kill("SIGHUP");
            await running.active.wait(/"event":"allowlist_reloaded"/, pausedAt);
            const started = Date.now();
            assert.equal(broker.child.kill("SIGSTOP"), true);
            paused = true;
            pending = running.request("start", { name: "admission" });
            pending.catch(() => {
              /* Same request is awaited after broker release if the test fails. */
            });
            await until(async () =>
              records((await running.request("sessions")).body.sessions).some(
                (row) =>
                  row.name === "remote:grok-bot:admission" &&
                  ["idle", "running"].includes(text(row.status)),
              ),
            );
            const concurrent = await running.request("start", { name: "admission" });
            assert.equal(concurrent.status, 409, JSON.stringify(concurrent.body));
            assert.equal(record(concurrent.body.error).code, "launch_in_progress");
            const failed = await pending;
            assert.equal(failed.status, 504, JSON.stringify(failed.body));
            assert.equal(record(failed.body.error).code, "launch_timeout");
            assert.ok(
              Date.now() - started < 7000,
              "startup deadline must interrupt broker acquisition, not wait for its 10-second timeout",
            );
            const row = records((await running.request("sessions")).body.sessions).find(
              (entry) => entry.name === "remote:grok-bot:admission",
            );
            assert.ok(row);
            const pid = numberValue(row.pid);
            pids.add(pid);
            assert.ok(
              numberValue(receipt(pid).calls) > 0,
              "native activity must actually precede admission check",
            );
            await observedExit(running.active, pid);
          } finally {
            if (paused) {
              broker.child.kill("SIGCONT");
            }
            if (pending) {
              await pending.catch(() => {
                /* Original failure remains authoritative. */
              });
            }
            const remaining = records((await running.request("sessions")).body.sessions).filter(
              (row) => row.name === "remote:grok-bot:admission",
            );
            for (const row of remaining) {
              pids.add(numberValue(row.pid));
              // Teardown settles any successful admission if an earlier assertion failed.
              // oxlint-disable-next-line no-await-in-loop
              await running.request("stop", { sessionId: row.sessionId });
            }
            policy.startupTimeoutMs = 12000;
            save();
            const after = running.active.output().length;
            running.active.child.kill("SIGHUP");
            await running.active.wait(/"event":"allowlist_reloaded"/, after);
          }
        },
      );
      await t.test(
        "native provider selection failure cannot publish a successful launch or retain a child",
        async () => {
          scenario("reply");
          policy.provider = "missing-provider";
          save();
          const offset = running.active.output().length;
          running.active.child.kill("SIGHUP");
          await running.active.wait(/"event":"allowlist_reloaded"/, offset);
          const failed = await running.request("start", { name: "missing-provider" });
          assert.ok(failed.status >= 400);
          const row = records((await running.request("sessions")).body.sessions).find(
            (entry) => entry.name === "remote:grok-bot:missing-provider",
          );
          assert.ok(row);
          const pid = numberValue(row.pid);
          pids.add(pid);
          await observedExit(running.active, pid);
          assert.equal(record(failed.body.error).code, "rpc_closed");
          policy.provider = "launch-fixture";
          save();
          const afterFailure = running.active.output().length;
          running.active.child.kill("SIGHUP");
          await running.active.wait(/"event":"allowlist_reloaded"/, afterFailure);
        },
      );
      await t.test(
        "unsupported native dialog is cancelled, never approved, and process exits",
        async () => {
          scenario("dialog");
          const result = await running.request("start", { name: "interaction" });
          assert.equal(result.status, 409, JSON.stringify(result.body));
          assert.equal(record(result.body.error).code, "interaction_required");
          const row = records((await running.request("sessions")).body.sessions).find(
            (entry) => entry.name === "remote:grok-bot:interaction",
          );
          assert.ok(row);
          const pid = numberValue(row.pid);
          pids.add(pid);
          await observedExit(running.active, pid);
          assert.notEqual(receipt(pid).dialog, true);
          assert.equal(receipt(pid).calls, 0);
        },
      );
      await t.test(
        "large genuine native tool events are drained without truncating Pi capability or losing the later Intercom reply",
        async () => {
          scenario("large-result");
          const started = await running.request("start", { name: "large-native-result" });
          assert.equal(started.status, 200, JSON.stringify(started.body));
          const peer = record(started.body.session);
          const pid = numberValue(peer.pid);
          pids.add(pid);
          const result = await running.request("ask", {
            to: peer.peerId,
            message: "Produce the large native detail then reply through Intercom.",
            timeoutMs: 10000,
          });
          assert.equal(result.status, 200, JSON.stringify(result.body));
          assert.equal(
            record(record(record(result.body.reply).message).content).text,
            "native-launch-reply",
          );
          const saved = SessionManager.open(text(peer.sessionFile), sessions);
          const toolEntry = saved
            .getEntries()
            .find(
              (entry) =>
                entry.type === "message" &&
                entry.message.role === "toolResult" &&
                entry.message.toolName === "launch_payload",
            );
          assert.ok(
            toolEntry && toolEntry.type === "message" && toolEntry.message.role === "toolResult",
          );
          assert.ok(text(record(toolEntry.message.details).payload).length > 4 * 1024 * 1024);
          assert.equal(gone(pid), false);
          const current = records((await running.request("sessions")).body.sessions).find(
            (row) => row.sessionId === peer.sessionId,
          );
          assert.ok(current);
          assert.equal(current.error, undefined);
          assert.ok(running.active.output().includes('"event":"rpc_event_discarded"'));
          assert.ok(!running.active.output().includes("LARGE_EVENT_SENTINEL"));
          const stopped = await running.request("stop", { sessionId: peer.sessionId });
          assert.equal(record(stopped.body.session).status, "exited");
          await observedExit(running.active, pid);
        },
      );
      await t.test(
        "certificate expiry stops idle children after the authenticating TLS connection has closed",
        async () => {
          const dir = join(root, "expiry");
          mkdirSync(dir, { mode: 0o700 });
          writeFileSync(join(dir, "index"), "");
          writeFileSync(join(dir, "serial"), "0100\n");
          const caConfig = join(dir, "openssl.cnf");
          writeFileSync(
            caConfig,
            `[ca]\ndefault_ca=local\n[local]\ndatabase=${dir}/index\nserial=${dir}/serial\nnew_certs_dir=${dir}\ncertificate=${credentials}/ca.crt\nprivate_key=${credentials}/ca.key\ndefault_md=sha256\npolicy=names\nx509_extensions=client\n[names]\ncommonName=supplied\n[client]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n`,
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
            date(Date.now() + 10000),
          ]);
          const short = {
            ...credential,
            cert,
            fingerprint256: new X509Certificate(readFileSync(cert)).fingerprint256,
          };
          config.clients = [
            ...clients,
            { fingerprint256: short.fingerprint256, name: "short-lived", cwd, launch: policy },
          ];
          save();
          const offset = running.active.output().length;
          running.active.child.kill("SIGHUP");
          await running.active.wait(/"event":"allowlist_reloaded"/, offset);
          scenario("reply");
          const shortApi = api(running.url, short);
          const started = await shortApi("start", { name: "expires" });
          assert.equal(started.status, 200, JSON.stringify(started.body));
          const peer = record(started.body.session);
          const pid = numberValue(peer.pid);
          pids.add(pid);
          await observedExit(running.active, pid);
          assert.equal(existsSync(text(peer.sessionFile)), true);
          await assert.rejects(shortApi("sessions"));
          config.clients = clients;
          save();
          const afterExpiry = running.active.output().length;
          running.active.child.kill("SIGHUP");
          await running.active.wait(/"event":"allowlist_reloaded"/, afterExpiry);
        },
      );

      await t.test(
        "rotation preserves policy, revocation terminates children even after TLS closes; helper shutdown leaves other broker peers alone",
        async () => {
          scenario("reply");
          const launched = record(
            (await running.request("start", { name: "revoked" })).body.session,
          );
          const pid = numberValue(launched.pid);
          pids.add(pid);
          const renewed = parseCredential(await runTool("issue", credentials, "grok-bot"));
          assert.deepEqual(
            record(
              records(record(readJson(configPath)).clients).find((row) => row.name === "grok-bot"),
            ).launch,
            policy,
          );
          let offset = running.active.output().length;
          running.active.child.kill("SIGHUP");
          await running.active.wait(/"event":"allowlist_reloaded"/, offset);
          await observedExit(running.active, pid);
          const renewedApi = api(running.url, renewed);
          const again = record((await renewedApi("start", { name: "shutdown" })).body.session);
          const nextPid = numberValue(again.pid);
          pids.add(nextPid);
          const nextRuntimePid = numberValue(receipt(nextPid).pid);
          await stop(running.active.child);
          assert.equal(running.active.child.signalCode, null);
          assert.equal(running.active.child.exitCode, 0);
          assert.ok(running.active.output().includes('"event":"shutdown","result":"closed"'));
          assert.match(
            running.active.output(),
            new RegExp(`"event":"launch_exit","pid":${nextPid},`),
          );
          await until(() => gone(nextPid));
          await until(() => gone(nextRuntimePid));
          assert.equal(
            broker.child.exitCode,
            null,
            "helper must never stop the independent broker",
          );
          assert.ok(
            (await observer.listSessions()).some((peer) => peer.id === observer.sessionId),
            "the independent broker peer must remain usable after helper shutdown",
          );
          // Fresh helper owns none of the old processes and does not resume them implicitly.
          const clocked = await launchBridge("test/fixtures/intercom-bridge-clock.ts", renewed);
          const next = clocked.active;
          const request = clocked.request;
          assert.deepEqual((await request("sessions")).body.sessions, []);
          assert.equal((await request("stop", { sessionId: again.sessionId })).status, 404);
          const leased = record(
            (await request("start", { name: "past-presence-lease" })).body.session,
          );
          const leasePid = numberValue(leased.pid);
          pids.add(leasePid);
          offset = next.output().length;
          next.child.kill("SIGUSR2");
          await next.wait(/"event":"fixture_clock"/, offset);
          await next.wait(/"result":"lease_expired"/, offset);
          assert.equal(gone(leasePid), false);
          assert.equal(
            record((await request("start", { name: "past-presence-lease" })).body.session)
              .sessionId,
            leased.sessionId,
          );
          offset = next.output().length;
          await runTool("revoke", credentials, "grok-bot");
          next.child.kill("SIGHUP");
          await next.wait(/"event":"allowlist_reloaded"/, offset);
          await observedExit(next, leasePid);
          await assert.rejects(request("list"));
        },
      );
    } finally {
      if (bridge) {
        await stop(bridge.child);
      }
      await observer.disconnect();
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
      await stop(broker.child);
      for (const pid of pids) {
        // Reparented exit observation can precede kernel reaping when the helper has just exited.
        // oxlint-disable-next-line no-await-in-loop
        await until(() => gone(pid));
        assert.equal(
          gone(pid),
          true,
          `launched child ${pid} must exit before private roots are deleted`,
        );
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);
