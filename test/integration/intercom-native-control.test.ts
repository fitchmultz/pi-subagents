import "../support/isolated-home.ts";
import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { on } from "node:events";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Type } from "typebox";
import {
  createAgentSessionRuntime,
  createAgentSessionServices,
  createAgentSessionFromServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import piIntercom from "../../src/pi-intercom/index.ts";
import { IntercomClient } from "../../src/pi-intercom/broker/client.ts";
import { CONTROL_SCHEMA, CONTROL_FALLBACK } from "../../src/pi-intercom/native-control-protocol.ts";
import {
  normalizeMessage,
  normalizeSessionInfo,
  type Message,
  type SessionInfo,
} from "../../src/pi-intercom/types.ts";
import { exec, start, stop, parseCredential } from "../support/intercom-bridge.ts";
import {
  assertDefined,
  json,
  readJson,
  record,
  records,
  numberValue,
  text,
} from "../support/assertions.ts";
import type { UnknownRecord } from "../../src/shared/unknown.ts";

const repo = resolve(import.meta.dirname, "../..");
async function nextMessage(client: Readonly<IntercomClient>, expectedText?: string) {
  const events: AsyncIterable<readonly unknown[]> = on(client, "message", {
    signal: AbortSignal.timeout(15000),
  });
  for await (const args of events) {
    const from = normalizeSessionInfo(args[0]);
    const message = normalizeMessage(args[1]);
    assertDefined(from);
    assertDefined(message);
    if (expectedText === undefined || message.content.text === expectedText) {
      return { from, message };
    }
  }
  throw new Error("Message stream closed before the expected message.");
}
async function waitPeer(client: Readonly<IntercomClient>, name: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    // Readiness comes from actual broker publication, never a sleep alone.
    // oxlint-disable-next-line no-await-in-loop
    const peer = (await client.listSessions()).find((candidate) => candidate.name === name);
    if (peer !== undefined) {
      return peer;
    }
    // oxlint-disable-next-line no-await-in-loop
    await sleep(20);
  }
  throw new Error(`Peer ${name} never registered.`);
}
async function nativeOwner(root: string) {
  const faux = fauxProvider({ provider: "native-control-fixture" });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const started: PromiseWithResolvers<void> = Promise.withResolvers();
  const aborted: PromiseWithResolvers<void> = Promise.withResolvers();
  const shutdown: PromiseWithResolvers<void> = Promise.withResolvers();
  const factory: CreateAgentSessionRuntimeFactory = async ({ sessionManager }) => {
    const services = await createAgentSessionServices({
      cwd: root,
      agentDir: join(root, "agent"),
      modelRuntime,
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
      }),
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noThemes: true,
        noContextFiles: true,
        noPromptTemplates: true,
        extensionFactories: [
          piIntercom,
          (pi) => {
            pi.on("session_start", () => pi.setSessionName("native-owner"));
            pi.registerTool({
              name: "hold",
              label: "Hold",
              description: "Signal-aware native test tool.",
              parameters: Type.Object({}),
              execute: async (_id, _args, signal) => {
                assertDefined(signal);
                started.resolve();
                await new Promise<void>((resolveAbort) => {
                  if (signal.aborted) {
                    resolveAbort();
                  } else {
                    signal.addEventListener("abort", () => resolveAbort(), { once: true });
                  }
                });
                aborted.resolve();
                return {
                  content: [{ type: "text", text: "native signal aborted" }],
                  isError: true,
                  details: {},
                };
              },
            });
          },
        ],
      },
    });
    assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager,
        model: faux.getModel(),
        noTools: "builtin",
      })),
      services,
      diagnostics: services.diagnostics,
    };
  };
  const runtime = await createAgentSessionRuntime(factory, {
    cwd: root,
    agentDir: join(root, "agent"),
    sessionManager: SessionManager.inMemory(root),
  });
  await runtime.session.bindExtensions({
    mode: "print",
    shutdownHandler: () => shutdown.resolve(),
  });
  return {
    runtime,
    faux,
    started: started.promise,
    aborted: aborted.promise,
    shutdown: shutdown.promise,
  };
}

test(
  "real broker/mTLS native controls and persistent live group routing",
  { timeout: 90000 },
  async (t) => {
    const root = mkdtempSync("/tmp/pic-");
    const previousAgent = process.env.PI_CODING_AGENT_DIR;
    const previousTmp = process.env.TMPDIR;
    const previousPolicy = process.env.PI_INTERCOM_BRIDGE_CONFIG;
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");
    process.env.TMPDIR = root;
    const env = { ...process.env, HOME: root, TMPDIR: root, TMP: root, TEMP: root };
    const dir = join(root, "credentials");
    const tool = join(repo, "scripts/intercom-bridge-credentials.mjs");
    const credential = parseCredential(
      json(
        (await exec(process.execPath, [tool, "init", dir, "grok-bot", "--cwd", root], { env }))
          .stdout,
      ),
    );
    const other = parseCredential(
      json((await exec(process.execPath, [tool, "issue", dir, "other-bot"], { env })).stdout),
    );
    const configPath = join(dir, "config.json");
    const config = record(readJson(configPath));
    config.port = 0;
    config.stateDir = join(root, "state");
    mkdirSync(join(root, "state"), { mode: 0o700 });
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    process.env.PI_INTERCOM_BRIDGE_CONFIG = configPath;
    const broker = start("src/pi-intercom/broker/broker.ts", [], env);
    let bridge: ReturnType<typeof start> | undefined;
    const clients: IntercomClient[] = [];
    const cleanup: { owner?: Awaited<ReturnType<typeof nativeOwner>> } = {};
    t.after(async () => {
      await cleanup.owner?.runtime.dispose();
      await Promise.all(clients.map((client) => client.disconnect()));
      if (bridge !== undefined) {
        await stop(bridge.child);
      }
      await stop(broker.child);
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
      if (previousPolicy === undefined) {
        delete process.env.PI_INTERCOM_BRIDGE_CONFIG;
      } else {
        process.env.PI_INTERCOM_BRIDGE_CONFIG = previousPolicy;
      }
      rmSync(root, { recursive: true, force: true });
    });
    await broker.wait(/Intercom broker started/);
    const connect = async (name: string, id?: string) => {
      const client = new IntercomClient();
      clients.push(client);
      client.on("error", () => {
        /* Assertions own transport failures. */
      });
      await client.connect({ name, cwd: root, model: "fixture", status: "idle" }, id);
      return client;
    };
    const probe = await connect("unrelated-peer");
    const launchBridge = async () => {
      bridge = start("src/pi-intercom/bridge.ts", ["--config", configPath], env);
      const output = await bridge.wait(/"event":"listening"/);
      const listening = output
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map(json)
        .find((line) => line.event === "listening");
      assertDefined(listening);
      return `https://127.0.0.1:${numberValue(listening.port)}`;
    };
    let url = await launchBridge();
    const api = (action: string, body?: unknown, identity = credential) =>
      new Promise<UnknownRecord>((resolveApi, reject) => {
        const request = https.request(
          `${url}/v1/${action}`,
          {
            method: body === undefined ? "GET" : "POST",
            ca: readFileSync(identity.ca),
            cert: readFileSync(identity.cert),
            key: readFileSync(identity.key),
            agent: false,
            signal: AbortSignal.timeout(15000),
            headers: { "Content-Type": "application/json" },
          },
          (response) => {
            let output = "";
            response.on("data", (chunk: Buffer) => {
              output += chunk.toString();
            });
            response.on("error", reject);
            response.on("end", () => {
              try {
                resolveApi(json(output));
              } catch (error) {
                reject(error instanceof Error ? error : new Error("Invalid JSON response"));
              }
            });
          },
        );
        request.on("error", reject);
        request.end(body === undefined ? undefined : JSON.stringify(body));
      });
    const cli = (...args: readonly string[]) =>
      new Promise<UnknownRecord>((resolveCli, reject) => {
        execFile(
          process.execPath,
          [join(repo, "scripts/intercom-remote.mjs"), ...args],
          {
            env: {
              ...env,
              INTERCOM_BRIDGE_URL: url,
              INTERCOM_BRIDGE_CA: credential.ca,
              INTERCOM_BRIDGE_CERT: credential.cert,
              INTERCOM_BRIDGE_KEY: credential.key,
            },
          },
          (error, stdout, stderr) => {
            try {
              const body = json(stdout.length > 0 ? stdout : stderr);
              resolveCli({ ...body, cliExitCode: error?.code ?? 0 });
            } catch (caught) {
              reject(caught instanceof Error ? caught : new Error("Invalid CLI output"));
            }
          },
        );
      });
    const owner = await nativeOwner(root);
    cleanup.owner = owner;
    const target = await waitPeer(probe, "native-owner");
    await t.test(
      "native capabilities/transcript use no inference or transcript cache",
      async () => {
        const capabilities = await cli(
          "capabilities",
          "--to",
          owner.runtime.session.sessionManager.getSessionId(),
        );
        assert.equal(record(capabilities.native).status, "ok");
        assert.equal(capabilities.cliExitCode, 0);
        assert.equal(record(capabilities.native).stopSupport, "host_dependent");
        assert.deepEqual(record(capabilities.native).verbs, [
          "capabilities",
          "cancel",
          "stop",
          "transcript",
        ]);
        owner.runtime.session.sessionManager.appendMessage({
          role: "user",
          content: "retained user",
          timestamp: 1,
        });
        owner.runtime.session.sessionManager.appendMessage(fauxAssistantMessage("retained answer"));
        const before = JSON.stringify(owner.runtime.session.sessionManager.getEntries());
        const page = await api(`transcript?target=${target.id}&limit=1`);
        assert.equal(page.ok, true);
        assert.deepEqual(
          records(record(record(page.native).transcript).records).map((entry) => entry.text),
          ["retained answer"],
        );
        assert.equal(record(record(page.native).transcript).finalizedOnly, true);
        assert.equal(JSON.stringify(owner.runtime.session.sessionManager.getEntries()), before);
        assert.equal(owner.faux.state.callCount, 0);
        assert.equal((await api("transcript", { to: target.id, path: "/etc/passwd" })).ok, false);
      },
    );
    await t.test(
      "private allowlist revocation, certificate expiry and display-name spoof are denied before effects",
      async (sub) => {
        const attacker = await connect("grok-bot");
        const response = nextMessage(attacker);
        await attacker.send(target.id, {
          text: CONTROL_FALLBACK,
          delivery: "passive",
          control: {
            schema: CONTROL_SCHEMA,
            kind: "request",
            verb: "cancel",
            certificate: readFileSync(credential.cert, "utf8"),
          },
        });
        const denied = (await response).message.control;
        assert.equal(record(denied).status, "denied");
        assert.equal(record((await api("capabilities", { to: target.id })).native).status, "ok");
        writeFileSync(configPath, JSON.stringify({ ...config, clients: [] }), { mode: 0o600 });
        // Helper still has its admitted identity; recipient must independently reread private policy.
        assert.equal(record((await api("cancel", { to: target.id })).native).status, "denied");
        writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
        const now = Date.now();
        sub.mock.method(Date, "now", () => now + 8 * 24 * 60 * 60 * 1000);
        assert.equal(record((await api("cancel", { to: target.id })).native).status, "denied");
        sub.mock.restoreAll();
        assert.equal(owner.faux.state.callCount, 0);
        assert.equal(owner.runtime.session.isStreaming, false);
        assert.equal(
          owner.runtime.session.sessionManager
            .getEntries()
            .filter((entry) => entry.type === "message").length,
          2,
        );
      },
    );
    await t.test(
      "unified foreign stop and incorrect response correlation cannot confirm execution",
      async () => {
        const legacy = await connect("legacy-owner");
        const inbound = nextMessage(legacy);
        const pending = api("stop", { target: legacy.sessionId, mode: "kill", timeoutMs: 500 });
        const received = await inbound;
        assert.equal(received.message.delivery, "passive");
        assert.notEqual(received.message.expectsReply, true);
        assert.equal(received.message.content.text, CONTROL_FALLBACK);
        const result = {
          schema: CONTROL_SCHEMA,
          kind: "result",
          verb: "stop",
          status: "shutdown_requested",
          processExited: false,
        } as const;
        await probe.send(received.from.id, {
          text: CONTROL_FALLBACK,
          replyTo: received.message.id,
          delivery: "passive",
          control: result,
        });
        await legacy.send(received.from.id, {
          text: "ordinary reply",
          replyTo: received.message.id,
          delivery: "passive",
        });
        await legacy.send(received.from.id, {
          text: CONTROL_FALLBACK,
          replyTo: received.message.id,
          delivery: "passive",
          control: { ...result, verb: "cancel" },
        });
        await legacy.send(received.from.id, {
          text: CONTROL_FALLBACK,
          replyTo: "another-request",
          delivery: "passive",
          control: result,
        });
        const incompatible = normalizeMessage({
          id: "incompatible",
          timestamp: Date.now(),
          content: { text: CONTROL_FALLBACK },
          control: { ...result, schema: "pi-intercom/control-v2" },
        });
        assertDefined(incompatible);
        await legacy.send(received.from.id, {
          text: CONTROL_FALLBACK,
          replyTo: received.message.id,
          delivery: "passive",
          control: incompatible.control,
        });
        const response = await pending;
        assert.equal(response.ok, false);
        assert.equal(record(response.error).code, "control_unconfirmed");
        assert.equal(record(response.error).deliveryUnknown, true);
        assert.ok((await probe.listSessions()).some((peer) => peer.id === legacy.sessionId));
      },
    );
    await t.test(
      "native current-operation abort reaches a real tool signal and preserves pending input",
      async () => {
        owner.runtime.session.refreshContext();
        owner.faux.setResponses([
          fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
          fauxAssistantMessage("accepted queued input completed"),
        ]);
        const prompt = owner.runtime.session.prompt("Run the signal-aware tool.");
        await owner.started;
        await owner.runtime.session.followUp("accepted pending input");
        const cancelled = await cli("cancel", "--to", target.id);
        assert.equal(record(cancelled.native).status, "cancel_requested");
        assert.equal(record(cancelled.native).pendingInput, true);
        assert.equal(record(cancelled.native).queueCleared, false);
        await owner.aborted;
        await prompt;
        await owner.runtime.session.waitForIdle();
        const completed = owner.runtime.session.messages.filter(
          (message) => message.role === "user" && message.content === "accepted pending input",
        ).length;
        const pending = owner.runtime.session
          .getFollowUpMessages()
          .filter((message) => message === "accepted pending input").length;
        assert.equal(
          completed + pending,
          1,
          "native abort neither loses nor duplicates accepted input",
        );
        assert.equal(
          owner.faux.state.callCount,
          1 + completed,
          "controls infer nothing; only accepted work may continue",
        );
      },
    );
    await t.test(
      "native stop acknowledges a request, invokes host shutdown, and never claims process exit",
      async () => {
        const stopped = await cli("stop", "--to", target.id);
        assert.equal(record(stopped.native).status, "unsupported");
        assert.equal(stopped.cliExitCode, 1);
        assert.equal(stopped.processExited, false);
        assert.equal(stopped.observedDisconnected, false);
        await owner.shutdown;
        await owner.runtime.dispose();
        assert.ok(!(await probe.listSessions()).some((peer) => peer.id === target.id));
        const replacement = await nativeOwner(root);
        try {
          const current = await waitPeer(probe, "native-owner");
          assert.notEqual(current.id, target.id);
          assert.equal(
            record((await api("capabilities", { to: target.id })).error).code,
            "peer_offline",
          );
          assert.equal(record((await api("capabilities", { to: current.id })).native).status, "ok");
          assert.equal(replacement.faux.state.callCount, 0);
        } finally {
          await replacement.runtime.dispose();
        }
        const ordinary = await connect("ordinary-recipient");
        const inbound = nextMessage(ordinary);
        assert.equal(
          (await api("send", { to: ordinary.sessionId, message: "broker remains usable" }))
            .accepted,
          true,
        );
        assert.equal((await inbound).message.content.text, "broker remains usable");
      },
    );
    await t.test(
      "explicit/dynamic groups are private, deduplicated, restart-persistent and return partial receipts",
      async () => {
        const nativeId = "11111111-1111-4111-8111-111111111111";
        const worker = await connect(
          "worker-one",
          `pi-${createHash("sha256").update(nativeId).digest("hex").slice(0, 32)}`,
        );
        const first = await cli(
          "group-upsert",
          "--name",
          "workers",
          "--members",
          JSON.stringify([nativeId, worker.sessionId, "worker-one", "offline-member"]),
          "--name-pattern",
          "worker-*",
        );
        assert.equal(first.ok, true);
        const transient = await connect("worker-two", `pi-${"2".repeat(32)}`);
        const firstMessage = nextMessage(worker);
        const secondMessage = nextMessage(transient);
        const sent = await cli("group-send", "--group", "workers", "--message", "group message");
        assert.equal(sent.status, "partial");
        assert.equal(sent.cliExitCode, 1);
        assert.equal(records(sent.receipts).length, 2);
        assert.deepEqual(records(sent.errors), [
          { member: "offline-member", code: "peer_offline" },
        ]);
        assert.equal((await firstMessage).message.content.text, "group message");
        assert.equal((await secondMessage).message.content.text, "group message");
        assert.deepEqual((await api("groups", undefined, other)).groups, []);
        assert.equal(statSync(join(root, "state")).mode & 0o777, 0o700);
        assert.equal(
          statSync(
            join(
              root,
              "state",
              `groups-${credential.fingerprint256.replaceAll(":", "").toLowerCase()}.json`,
            ),
          ).mode & 0o777,
          0o600,
        );
        assertDefined(bridge);
        await stop(bridge.child);
        url = await launchBridge();
        assert.equal(records((await cli("groups")).groups)[0].name, "workers");
        await api("groups", { name: "alias", match: { nameglob: "worker-*", cwd: root } });
        assert.equal((await api("groups", { name: "box-alias", match: "worker-*" })).ok, true);
        const broadcasts = [nextMessage(worker), nextMessage(transient)];
        const all = await cli("broadcast", "--message", "all native peers");
        assert.equal(all.status, "complete");
        assert.equal(all.cliExitCode, 0);
        assert.deepEqual(
          records(all.receipts)
            .map((receipt) => {
              assert.equal(typeof receipt.peer, "string");
              return typeof receipt.peer === "string" ? receipt.peer : "";
            })
            .sort((left, right) => left.localeCompare(right)),
          [worker.sessionId, transient.sessionId].sort((left, right) =>
            (left ?? "").localeCompare(right ?? ""),
          ),
        );
        assert.ok(records(all.receipts).every((receipt) => receipt.accepted === true));
        assert.equal((await broadcasts[0]).message.content.text, "all native peers");
        assert.equal((await broadcasts[1]).message.content.text, "all native peers");
      },
    );
    for (const mode of ["stall", "kill"] as const) {
      // Keep both outage modes at the real fanout owner; the second case retires this private broker.
      // oxlint-disable-next-line no-await-in-loop
      await t.test(
        `broadcast preserves receipts and unknown outcomes on broker ${mode}`,
        async () => {
          if (mode === "stall") {
            await Promise.all(
              [3, 4, 5, 6].map((digit) =>
                connect(`fanout-${digit}`, `pi-${String(digit).repeat(32)}`),
              ),
            );
          }
          const targets = clients.filter((client) => client.sessionId?.startsWith("pi-") === true);
          const targetIds = targets.map((client) => text(client.sessionId));
          assert.equal(targets.length, 6);
          const message = `FANOUT_${mode}`;
          const received = new Map<string, string[]>();
          let interrupted = false;
          const listeners = targets.map((client) => {
            const id = text(client.sessionId);
            const listener = (_from: SessionInfo, incoming: Message) => {
              if (incoming.content.text === message) {
                received.set(id, [...(received.get(id) ?? []), incoming.id]);
                if (!interrupted) {
                  interrupted = true;
                  broker.child.kill(mode === "stall" ? "SIGSTOP" : "SIGKILL");
                }
              }
            };
            client.on("message", listener);
            return { client, listener };
          });
          try {
            const result = await cli("broadcast", "--message", message);
            assert.equal(interrupted, true, "outage begins only after a real recipient receives");
            assert.equal(result.ok, false);
            assert.equal(result.cliExitCode, 1);
            assert.equal(result.status, "partial");
            assert.equal(
              record(result.error).code,
              mode === "stall" ? "send_unconfirmed" : "broker_disconnected",
            );
            const receipts = records(result.receipts);
            assert.deepEqual(
              receipts.map((receipt) => text(receipt.peer)).sort(),
              [...targetIds].sort(),
              "every selected target has exactly one outcome",
            );
            const accepted = receipts.filter((receipt) => receipt.accepted === true);
            assert.ok(accepted.length > 0, "prior broker acknowledgements survive the outage");
            for (const receipt of accepted) {
              assert.ok(received.get(text(receipt.peer))?.includes(text(receipt.id)) === true);
            }
            const unknown = receipts.filter(
              (receipt) =>
                receipt.error !== undefined && record(receipt.error).deliveryUnknown === true,
            );
            assert.equal(unknown.length, 1, "only the in-flight mutation may be unknown");
            const uncertain = record(unknown[0]);
            const uncertainId = text(record(uncertain.error).id);
            assertDefined(bridge);
            assert.ok(
              bridge
                .output()
                .split("\n")
                .filter((line) => line.startsWith("{"))
                .map(json)
                .some(
                  (entry) =>
                    entry.event === "send" &&
                    entry.peer === uncertain.peer &&
                    entry.messageId === uncertainId,
                ),
              "unknown outcome retains the exact published message ID",
            );
            const unattempted = receipts.filter((receipt) => receipt.attempted === false);
            assert.ok(unattempted.length > 0);
            for (const receipt of unattempted) {
              assert.equal(received.has(text(receipt.peer)), false);
              assert.equal(record(receipt.error).deliveryUnknown, false);
            }
            if (mode === "stall") {
              broker.child.kill("SIGCONT");
              // A native round-trip fence consumes prior frames without retrying the uncertain mutation.
              await Promise.all(
                targets.map(async (client) => {
                  const fence = nextMessage(client, "fanout fence");
                  await probe.send(text(client.sessionId), { text: "fanout fence" });
                  assert.equal((await fence).message.content.text, "fanout fence");
                }),
              );
            }
            assert.ok([...received.values()].every((ids) => ids.length === 1));
            const eventual = received.get(text(uncertain.peer));
            if (eventual !== undefined) {
              assert.deepEqual(eventual, [uncertainId], "late delivery uses the same unknown ID");
            }
            for (const receipt of unattempted) {
              assert.equal(received.has(text(receipt.peer)), false, "no automatic fanout retry");
            }
          } finally {
            if (mode === "stall") {
              broker.child.kill("SIGCONT");
            }
            for (const { client, listener } of listeners) {
              client.off("message", listener);
            }
          }
        },
      );
    }
  },
);
