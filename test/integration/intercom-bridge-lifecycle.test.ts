import "../support/isolated-home.ts";
import test from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SessionManager, parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { IntercomClient } from "../../src/pi-intercom/broker/client.ts";
import { getBrokerSocketPath } from "../../src/pi-intercom/broker/paths.ts";
import { SessionCatalog } from "../../src/pi-intercom/bridge-catalog.ts";
import { loadConfig } from "../../src/pi-intercom/bridge-config.ts";
import { hasErrorCode, isUnknownArray, type UnknownRecord } from "../../src/shared/unknown.ts";
import { bridgeRequest, exec, parseCredential, start, stop } from "../support/intercom-bridge.ts";
import { json, numberValue, readJson, record, records, text } from "../support/assertions.ts";
import { nativeCli, nativeSdkRoot } from "../support/native-sdk.ts";

const repo = resolve(import.meta.dirname, "../..");
const sdk = nativeSdkRoot(process.env.PI_INTERCOM_TEST_SDK);
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const signal = AbortSignal.timeout(15000);
  // Observe each receipt serially before waiting for its next publication.
  // oxlint-disable-next-line no-await-in-loop
  while (!(await check())) {
    // Poll actual publication/receipts; elapsed time alone never proves readiness.
    // oxlint-disable-next-line no-await-in-loop
    await delay(25, undefined, { signal });
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
function hasText(file: string, expected: string): boolean {
  return SessionManager.open(file)
    .getEntries()
    .some(
      (entry) =>
        (entry.type === "message" &&
          entry.message.role === "user" &&
          JSON.stringify(entry.message.content).includes(expected)) ||
        (entry.type === "custom_message" && JSON.stringify(entry.content).includes(expected)),
    );
}

test(
  "native bridge spawn/resume/catalog/cancel use approved workspaces and preserve saved identity",
  { timeout: 180000 },
  async (t) => {
    const root = realpathSync(mkdtempSync("/tmp/pib-life-"));
    const cwd = join(root, "workspace");
    const selected = join(cwd, "selected");
    const sessions = join(root, "launched");
    const savedDir = join(root, "saved");
    const outside = join(root, "outside");
    const receipts = join(root, "receipts");
    const agent = join(root, "agent");
    const home = join(root, "home");
    for (const dir of [
      cwd,
      selected,
      sessions,
      savedDir,
      outside,
      receipts,
      agent,
      home,
      join(selected, ".pi"),
      join(selected, ".pi/extensions"),
    ]) {
      mkdirSync(dir, { mode: 0o700 });
    }
    writeFileSync(
      join(selected, ".pi/extensions/workspace.js"),
      `export default (pi) => pi.registerTool({name:"workspace_only",label:"Workspace resource",description:"Local project tool",parameters:{type:"object",properties:{}},execute:async()=>({content:[{type:"text",text:"ok"}]})});`,
    );
    writeFileSync(
      join(agent, "settings.json"),
      JSON.stringify({
        defaultProvider: "launch-fixture",
        defaultModel: "faux-1",
        defaultThinkingLevel: "off",
      }),
    );
    const input = join(root, "input.json");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      TMPDIR: root,
      TMP: root,
      TEMP: root,
      PI_CODING_AGENT_DIR: agent,
      PI_PACKAGE_DIR: sdk,
      PI_INTERCOM_TEST_SDK: sdk,
      PI_INTERCOM_LAUNCH_FIXTURE: input,
      PI_OFFLINE: "1",
      JITI_FS_CACHE: join(root, "jiti"),
    };
    delete env.PI_TIMING;
    delete env.PI_EXTENSION_PERFORMANCE;
    const scenario = (value: string) =>
      writeFileSync(input, JSON.stringify({ scenario: value, receipts }));
    scenario("task");
    const credentials = join(root, "credentials");
    const issued = json(
      (
        await exec(
          process.execPath,
          [
            join(repo, "scripts/intercom-bridge-credentials.mjs"),
            "init",
            credentials,
            "grok-bot",
            "--cwd",
            cwd,
          ],
          { env },
        )
      ).stdout,
    );
    const credential = parseCredential(issued);
    const configPath = join(credentials, "config.json");
    const config = record(readJson(configPath));
    const client = record(records(config.clients).find((row) => row.name === "grok-bot"));
    client.launch = {
      packageRoot: sdk,
      sessionDir: sessions,
      workspaceRoots: [cwd],
      resumeDirs: [savedDir],
      context: "Locally approved independent Pi. Await Intercom tasks.",
      extensions: [
        join(repo, "src/pi-intercom/index.ts"),
        join(repo, "test/fixtures/intercom-launch-provider.mjs"),
      ],
      discoverResources: true,
      trustProject: true,
      offline: true,
      maxSessions: 4,
      startupTimeoutMs: 12000,
    };
    config.port = 0;
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    let bridge: ReturnType<typeof start> | undefined;
    let brokerPid: number | undefined;
    let external: ChildProcess | undefined;
    const pids = new Set<number>();
    const previousAgent = process.env.PI_CODING_AGENT_DIR;
    const previousTmp = process.env.TMPDIR;
    process.env.PI_CODING_AGENT_DIR = agent;
    process.env.TMPDIR = root;
    const observer = new IntercomClient();
    const launchHelper = async () => {
      const active = start("src/pi-intercom/bridge.ts", ["--config", configPath], env);
      bridge = active;
      const output = await active.wait(/"event":"listening"/);
      const row = output
        .split("\n")
        .filter(Boolean)
        .map(json)
        .find((entry) => entry.event === "listening");
      const url = `https://127.0.0.1:${numberValue(record(row).port)}`;
      return {
        active,
        request: bridgeRequest(url, credential),
        remote: async (...args: readonly string[]) =>
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
          ),
      };
    };
    const receipt = (id: string): UnknownRecord => {
      const matches = readdirSync(receipts)
        .map((name) => record(readJson(join(receipts, name))))
        .filter((row) => row.sessionId === id);
      return record(matches.find((row) => !gone(numberValue(row.pid))) ?? matches.at(-1));
    };
    const own = (session: UnknownRecord) => {
      pids.add(numberValue(session.pid));
      return session;
    };
    const stopped = async (
      running: Awaited<ReturnType<typeof launchHelper>>,
      session: UnknownRecord,
    ) => {
      const result = await running.request("stop", { target: session.peerId, mode: "kill" });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(record(result.body.session).status, "exited");
      const pid = numberValue(session.pid);
      await running.active.wait(new RegExp(`"event":"launch_exit","pid":${pid},`));
      await until(() => gone(pid) && gone(numberValue(receipt(text(session.sessionId)).pid)));
      assert.ok(existsSync(text(session.sessionFile)), "native journal survives observed exit");
    };
    try {
      let running = await launchHelper();
      assert.equal(
        existsSync(join(agent, "intercom/broker.pid")),
        false,
        "isolated cold helper starts with no Pi or broker",
      );
      let spawned: UnknownRecord = {};
      await t.test(
        "spawn selects cwd and normal local resources/model, accepts task after exact native publication, and cold-starts private broker",
        async () => {
          assert.equal(
            (await running.request("spawn", { name: "outside", cwd: outside })).status,
            403,
          );
          assert.equal(
            (await running.request("spawn", { name: "relative", cwd: "selected" })).status,
            400,
          );
          assert.equal(
            (
              await running.request("spawn", {
                name: "flags",
                cwd: selected,
                flags: ["--api-key", "remote"],
              })
            ).status,
            400,
          );
          const result = await running.remote(
            "spawn",
            "--name",
            "selected",
            "--cwd",
            selected,
            "--task",
            "TASK_AFTER_NATIVE_READY",
          );
          spawned = own(record(result.session));
          assert.equal(result.id, spawned.sessionId);
          assert.equal(record(result.task).accepted, true);
          assert.equal(record(result.task).completed, false);
          assert.equal(spawned.cwd, selected);
          const id = text(spawned.sessionId);
          const file = text(spawned.sessionFile);
          brokerPid = Number.parseInt(readFileSync(join(agent, "intercom/broker.pid"), "utf8"), 10);
          await until(
            () => hasText(file, "TASK_AFTER_NATIVE_READY") && numberValue(receipt(id).calls) > 0,
          );
          assert.equal(receipt(id).cwd, selected);
          assert.equal(receipt(id).model, "faux-1");
          const tools = receipt(id).tools;
          assert.ok(isUnknownArray(tools) && tools.includes("workspace_only"));
          assert.equal(receipt(id).networkRequests, 0);
          assert.equal(SessionManager.open(file).getSessionName(), "remote:grok-bot:selected");
          brokerPid = Number.parseInt(readFileSync(join(agent, "intercom/broker.pid"), "utf8"), 10);
          assert.equal(gone(brokerPid), false);
          await observer.connect({ name: "unrelated-live-peer", cwd, model: "fixture" });
          assert.ok((await observer.listSessions()).some((peer) => peer.id === spawned.peerId));
          const reused = await running.remote("start", "--name", "legacy");
          const legacy = own(record(reused.session));
          assert.equal(legacy.cwd, cwd);
          assert.equal(receipt(text(legacy.sessionId)).calls, 0);
          await stopped(running, legacy);
        },
      );
      await t.test(
        "catalog metadata is bounded, filtered, opt-in; live resume reuses the native writer",
        async () => {
          const before = readdirSync(receipts).length;
          const reused = await running.request("resume", { sessionId: spawned.sessionId });
          assert.equal(reused.status, 200, JSON.stringify(reused.body));
          assert.equal(reused.body.reused, true);
          assert.equal(record(reused.body.session).pid, spawned.pid);
          assert.equal(readdirSync(receipts).length, before);
          const page = await running.remote(
            "sessions",
            "--live",
            "--saved",
            "--q",
            "selected",
            "--limit",
            "1",
          );
          assert.equal(records(page.sessions).length, 1);
          const row = record(records(page.sessions).at(0));
          assert.equal(row.id, spawned.sessionId);
          assert.equal(row.saved, true);
          assert.equal(row.owned, true);
          assert.equal(row.sessionFile, undefined);
          assert.equal(row.pid, undefined);
          assert.ok(!JSON.stringify(page).includes("TASK_AFTER_NATIVE_READY"));
          assert.equal((await running.request("sessions?limit=101&saved=true")).status, 400);
          assert.equal((await running.request("sessions?saved=true&saved=true")).status, 400);
          assert.ok((await observer.listSessions()).some((peer) => peer.id === observer.sessionId));
          await stopped(running, spawned);
        },
      );
      await t.test(
        "historical owned exit never masks an independently resumed live writer of the same UUID",
        async () => {
          const historical = await running.request("stop", { sessionId: spawned.sessionId });
          assert.equal(historical.status, 200, JSON.stringify(historical.body));
          assert.equal(record(historical.body.session).status, "exited");
          const file = text(spawned.sessionFile);
          external = spawn(
            process.execPath,
            [
              nativeCli(sdk),
              "--mode",
              "rpc",
              "--session",
              file,
              "--offline",
              "--approve",
              "--extension",
              join(repo, "src/pi-intercom/index.ts"),
              "--extension",
              join(repo, "test/fixtures/intercom-launch-provider.mjs"),
            ],
            { env, cwd: selected, stdio: ["pipe", "pipe", "pipe"] },
          );
          external.stdout?.resume();
          external.stderr?.resume();
          try {
            await until(async () =>
              (await observer.listSessions()).some((peer) => peer.id === spawned.peerId),
            );
            const before = readFileSync(file);
            for (const verb of ["stop", "cancel"]) {
              // Both public routes must reach the newer native owner, not the exited launch record.
              // oxlint-disable-next-line no-await-in-loop
              const result = await running.request(verb, { sessionId: spawned.sessionId });
              assert.equal(result.status, 200, JSON.stringify(result.body));
              assert.equal(result.body.peer, spawned.peerId);
              assert.equal(result.body.session, undefined, "no stale PID or ownership claim");
              assert.equal(result.body.processExited, false);
              assert.equal(record(result.body.native).verb, verb);
              assert.equal(
                record(result.body.native).status,
                "denied",
                "the independent native recipient has no control policy",
              );
            }
            assert.deepEqual(
              readFileSync(file),
              before,
              "denied controls preserve the live journal",
            );
            assert.equal(external.exitCode, null);
            assert.equal(external.signalCode, null);
            assert.ok((await observer.listSessions()).some((peer) => peer.id === spawned.peerId));
          } finally {
            await stop(external);
            external = undefined;
          }
          await until(
            async () => !(await observer.listSessions()).some((peer) => peer.id === spawned.peerId),
          );
          const retried = await running.request("stop", { sessionId: spawned.sessionId });
          assert.equal(retried.status, 200, JSON.stringify(retried.body));
          assert.equal(record(retried.body.session).status, "exited");
        },
      );
      await t.test(
        "helper restart recovers saved launch catalog and resume preserves same UUID/name/cwd/history/model and run metadata",
        async () => {
          const file = text(spawned.sessionFile);
          const manager = SessionManager.open(file);
          manager.appendCustomEntry("subagent-run", { runId: "retained-native-run" });
          const before = manager.getEntries().map((entry) => entry.id);
          await stop(running.active.child);
          const launchPolicy = record(client.launch);
          launchPolicy.provider = "launch-fixture";
          launchPolicy.model = "missing-launch-default";
          writeFileSync(configPath, JSON.stringify(config));
          running = await launchHelper();
          assert.deepEqual(
            (await running.request("sessions")).body.sessions,
            [],
            "restart never adopts stale PIDs",
          );
          const page = await running.remote(
            "sessions",
            "--saved",
            "--q",
            "selected",
            "--limit",
            "1",
          );
          assert.equal(record(records(page.sessions).at(0)).sessionId, spawned.sessionId);
          assert.equal(record(records(page.sessions).at(0)).owned, false);
          assert.equal(
            (await running.request("stop", { sessionId: spawned.sessionId })).status,
            404,
          );
          const savedBytes = readFileSync(file);
          const transcript = await running.remote(
            "transcript",
            "--target",
            text(spawned.sessionId),
          );
          assert.equal(transcript.source, "saved");
          assert.equal(record(transcript.transcript).sessionId, spawned.sessionId);
          assert.ok(
            records(record(transcript.transcript).records).some(
              (entry) => entry.text === "Locally approved independent Pi. Await Intercom tasks.",
            ),
          );
          assert.deepEqual(
            readFileSync(file),
            savedBytes,
            "saved HTTP transcript never rewrites history",
          );
          const resumed = await running.remote(
            "resume",
            "--name",
            "remote:grok-bot:selected",
            "--task",
            "RESUMED_TASK",
          );
          const session = own(record(resumed.session));
          assert.equal(session.sessionId, spawned.sessionId);
          assert.equal(session.cwd, selected);
          assert.equal(session.name, "remote:grok-bot:selected");
          assert.equal(session.sessionFile, file);
          assert.equal(record(resumed.task).accepted, true);
          await until(() => hasText(file, "RESUMED_TASK"));
          const saved = SessionManager.open(file);
          assert.ok(before.every((id) => saved.getEntries().some((entry) => entry.id === id)));
          assert.ok(
            saved
              .getEntries()
              .some(
                (entry) =>
                  entry.type === "custom" &&
                  entry.customType === "subagent-run" &&
                  record(entry.data).runId === "retained-native-run",
              ),
          );
          assert.equal(saved.buildSessionContext().model?.modelId, "faux-1");
          await stopped(running, session);
          delete launchPolicy.provider;
          delete launchPolicy.model;
          writeFileSync(configPath, JSON.stringify(config));
          const offset = running.active.output().length;
          running.active.child.kill("SIGHUP");
          await running.active.wait(/"event":"allowlist_reloaded"/, offset);
        },
      );
      const saved = SessionManager.create(selected, savedDir);
      saved.appendSessionInfo("local-saved");
      saved.appendModelChange("launch-fixture", "faux-1");
      saved.appendMessage({
        role: "user",
        content: "ORIGINAL_LOCAL_HISTORY",
        timestamp: Date.now(),
      });
      const savedFile = text(saved.getSessionFile());
      chmodSync(savedFile, 0o644);
      await t.test(
        "0644 native saved sessions resume correctly; proven external peer is reused without opening or claiming its writer",
        async () => {
          scenario("task");
          external = spawn(
            process.execPath,
            [
              nativeCli(sdk),
              "--mode",
              "rpc",
              "--session",
              savedFile,
              "--offline",
              "--approve",
              "--extension",
              join(repo, "src/pi-intercom/index.ts"),
              "--extension",
              join(repo, "test/fixtures/intercom-launch-provider.mjs"),
            ],
            { env, cwd: selected, stdio: ["pipe", "pipe", "pipe"] },
          );
          external.stdout?.resume();
          external.stderr?.resume();
          await until(async () =>
            (await observer.listSessions()).some((peer) => peer.name === "local-saved"),
          );
          const before = readFileSync(savedFile, "utf8");
          const count = readdirSync(receipts).length;
          const reused = await running.request("resume", { name: "local-saved" });
          assert.equal(reused.status, 200, JSON.stringify(reused.body));
          assert.equal(reused.body.reused, true);
          assert.equal(record(reused.body.session).owned, false);
          assert.equal(readdirSync(receipts).length, count);
          assert.equal(
            readFileSync(savedFile, "utf8"),
            before,
            "live reuse must not rewrite/open an active journal",
          );
          const foreignStop = await running.request("stop", { sessionId: saved.getSessionId() });
          assert.equal(
            foreignStop.body.session,
            undefined,
            "live resume never acquires foreign PID ownership",
          );
          assert.equal(foreignStop.body.processExited, false);
          assert.equal(
            record(foreignStop.body.native).status,
            "denied",
            "recipient has no configured native-control policy",
          );
          const collision = new IntercomClient();
          try {
            const nativePeer = (await observer.listSessions()).find(
              (peer) => peer.name === "local-saved",
            );
            assert.ok(nativePeer);
            await collision.connect(
              { name: "local-saved", cwd: selected, model: "unknown-owner" },
              nativePeer.id,
            );
            assert.notEqual(
              collision.sessionId,
              nativePeer.id,
              "actual broker collision changes the requested native identity",
            );
            await stop(external);
            external = undefined;
            await until(
              async () =>
                !(await observer.listSessions()).some((peer) => peer.id === nativePeer.id),
            );
            const blocked = await running.request("resume", { sessionId: saved.getSessionId() });
            assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
            assert.equal(record(blocked.body.error).code, "active_session");
            assert.equal(
              readdirSync(receipts).length,
              count,
              "unknown live ownership must not create a native writer",
            );
          } finally {
            await collision.disconnect();
          }
          await until(
            async () =>
              !(await observer.listSessions()).some((peer) => peer.name === "local-saved"),
          );
          const result = await running.request("resume", { sessionId: saved.getSessionId() });
          assert.equal(result.status, 200, JSON.stringify(result.body));
          const session = own(record(result.body.session));
          assert.equal(session.cwd, selected);
          assert.equal(session.name, "local-saved");
          assert.equal(session.sessionFile, savedFile);
          assert.ok(hasText(savedFile, "ORIGINAL_LOCAL_HISTORY"));
          await stopped(running, session);
        },
      );
      await t.test(
        "unnamed native UUID resumes without adding or changing its native display name",
        async () => {
          const journal = SessionManager.create(selected, savedDir);
          journal.appendModelChange("launch-fixture", "faux-1");
          journal.appendMessage({
            role: "user",
            content: "UNNAMED_ORIGINAL_CONTEXT",
            timestamp: Date.now(),
          });
          const result = await running.request("resume", {
            sessionId: journal.getSessionId(),
            task: "UNNAMED_TASK",
          });
          assert.equal(result.status, 200, JSON.stringify(result.body));
          const session = own(record(result.body.session));
          assert.equal(session.name, undefined);
          assert.equal(session.sessionId, journal.getSessionId());
          assert.equal(session.sessionFile, journal.getSessionFile());
          assert.ok(
            (await observer.listSessions()).some(
              (peer) => peer.id === session.peerId && peer.cwd === selected,
            ),
          );
          const page = await running.request(
            `sessions?saved=true&live=true&q=${journal.getSessionId()}`,
          );
          assert.equal(page.status, 200, JSON.stringify(page.body));
          assert.equal(record(records(page.body.sessions).at(0)).name, undefined);
          await until(() => hasText(text(journal.getSessionFile()), "UNNAMED_TASK"));
          await stopped(running, session);
          const reopened = SessionManager.open(text(journal.getSessionFile()));
          assert.equal(reopened.getSessionName(), undefined);
          assert.ok(!reopened.getEntries().some((entry) => entry.type === "session_info"));
        },
      );
      await t.test(
        "mixed v1/current saved names reject ambiguity without migrating or selecting the legacy journal",
        async () => {
          const native = SessionManager.inMemory(selected);
          const header = native.getHeader();
          assert.ok(header);
          const content =
            [
              { ...header, version: 1 },
              {
                type: "session_info",
                name: "legacy-duplicate",
                timestamp: new Date().toISOString(),
              },
              {
                type: "message",
                message: { role: "user", content: "LEGACY_SAVED_CONTEXT", timestamp: Date.now() },
              },
            ]
              .map((entry) => JSON.stringify(entry))
              .join("\n") + "\n";
          const legacyFile = join(savedDir, `legacy_${native.getSessionId()}.jsonl`);
          writeFileSync(legacyFile, content, { mode: 0o644 });
          assert.equal(
            SessionManager.inMemory(
              selected,
              undefined,
              parseSessionEntries(content),
            ).getSessionName(),
            "legacy-duplicate",
          );
          const current = SessionManager.create(selected, savedDir);
          current.appendSessionInfo("legacy-duplicate");
          current.appendMessage({
            role: "user",
            content: "Current duplicate.",
            timestamp: Date.now(),
          });
          const before = readdirSync(receipts).length;
          const page = await running.request("sessions?saved=true&q=legacy-duplicate&limit=10");
          assert.equal(page.status, 200, JSON.stringify(page.body));
          assert.equal(records(page.body.sessions).length, 2);
          const result = await running.request("resume", { name: "legacy-duplicate" });
          assert.equal(result.status, 409, JSON.stringify(result.body));
          assert.equal(record(result.body.error).code, "ambiguous_session");
          assert.equal(
            readdirSync(receipts).length,
            before,
            "ambiguous legacy names must never open a native writer",
          );
          assert.equal(
            readFileSync(legacyFile, "utf8"),
            content,
            "metadata migration must remain in memory",
          );
        },
      );
      await t.test("resume rejects native model fallback before accepting a task", async () => {
        const journal = SessionManager.create(selected, savedDir);
        journal.appendSessionInfo("strict-fallback");
        journal.appendModelChange("unavailable-saved-provider", "original-model");
        journal.appendMessage({
          role: "user",
          content: "Saved unavailable model context.",
          timestamp: Date.now(),
        });
        const result = await running.request("resume", {
          sessionId: journal.getSessionId(),
          task: "MUST_NOT_RUN_FALLBACK",
        });
        assert.equal(result.status, 503, JSON.stringify(result.body));
        assert.equal(record(result.body.error).code, "model_restore_failed");
        const row = records((await running.request("sessions")).body.sessions).findLast(
          (entry) => entry.sessionId === journal.getSessionId(),
        );
        const session = own(record(row));
        assert.equal(session.status, "exited");
        assert.equal(receipt(journal.getSessionId()).calls, 0);
        assert.equal(
          SessionManager.open(text(journal.getSessionFile())).getSessionId(),
          journal.getSessionId(),
        );
        assert.equal(hasText(text(journal.getSessionFile()), "MUST_NOT_RUN_FALLBACK"), false);
      });
      await t.test(
        "missing, ambiguous, untrusted selectors and concurrent startup fail without a second native writer",
        async () => {
          for (const body of [
            {},
            { name: "missing" },
            { sessionId: savedFile },
            { sessionId: saved.getSessionId(), name: "local-saved" },
          ]) {
            // Each request targets a distinct public input failure, not a private predicate.
            // oxlint-disable-next-line no-await-in-loop
            assert.ok((await running.request("resume", body)).status >= 400);
          }
          const twin = SessionManager.create(selected, savedDir);
          twin.appendSessionInfo("local-saved");
          twin.appendMessage({ role: "user", content: "second saved name", timestamp: Date.now() });
          assert.equal((await running.request("resume", { name: "local-saved" })).status, 409);
          const untrusted = SessionManager.create(outside, outside);
          untrusted.appendSessionInfo("outside-history");
          untrusted.appendMessage({ role: "user", content: "outside", timestamp: Date.now() });
          symlinkSync(text(untrusted.getSessionFile()), join(savedDir, "linked.jsonl"));
          assert.equal(
            (await running.request("resume", { sessionId: untrusted.getSessionId() })).status,
            404,
          );
          scenario("stall");
          const abort = new AbortController();
          const pending = running
            .request("resume", { sessionId: saved.getSessionId() }, { signal: abort.signal })
            .catch((error: unknown) => error);
          await until(async () =>
            records((await running.request("sessions")).body.sessions).some(
              (row) =>
                row.sessionId === saved.getSessionId() &&
                row.status === "starting" &&
                typeof row.pid === "number" &&
                readdirSync(receipts)
                  .map((name) => record(readJson(join(receipts, name))))
                  .some(
                    (runtime) =>
                      runtime.sessionId === saved.getSessionId() &&
                      runtime.started === true &&
                      (runtime.pid === row.pid || runtime.ppid === row.pid),
                  ),
            ),
          );
          const started = records((await running.request("sessions")).body.sessions).findLast(
            (row) => row.sessionId === saved.getSessionId(),
          );
          const session = own(record(started));
          const duplicate = await running.request("resume", { sessionId: saved.getSessionId() });
          assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));
          assert.equal(record(duplicate.body.error).code, "launch_in_progress");
          abort.abort();
          await pending;
          await running.active.wait(
            new RegExp(`"event":"launch_exit","pid":${numberValue(session.pid)},`),
          );
          assert.ok(existsSync(savedFile));
        },
      );
      await t.test(
        "cancel aborts actual native tool work, reports idle without killing the session, and stop still observes exit",
        async () => {
          scenario("cancel");
          const result = await running.remote(
            "spawn",
            "--name",
            "cancellable",
            "--cwd",
            selected,
            "--task",
            "Wait in the real native tool.",
          );
          const session = own(record(result.session));
          const id = text(session.sessionId);
          await until(() => receipt(id).waiting === true);
          const cancelled = await running.remote("cancel", "--session-id", id);
          assert.equal(cancelled.cancelled, true);
          assert.equal(cancelled.queuesPreserved, true);
          assert.equal(record(cancelled.state).isStreaming, false);
          assert.equal(record(cancelled.session).status, "idle");
          assert.equal(receipt(id).toolAborted, true);
          assert.equal(gone(numberValue(session.pid)), false);
          await stopped(running, session);
        },
      );
      await t.test(
        "consumer model/target/stop-mode aliases retain authority and root workspace approval",
        async () => {
          scenario("task");
          const policy = record(client.launch);
          policy.workspaceRoots = ["/"];
          writeFileSync(configPath, JSON.stringify(config));
          const offset = running.active.output().length;
          running.active.child.kill("SIGHUP");
          await running.active.wait(/"event":"allowlist_reloaded","result":"accepted"/, offset);
          const result = await running.remote(
            "spawn",
            "--name",
            "chosen-model",
            "--cwd",
            outside,
            "--model",
            "launch-fixture/faux-1",
          );
          const session = own(record(result.session));
          assert.equal(session.cwd, outside);
          assert.equal(receipt(text(session.sessionId)).model, "faux-1");
          assert.equal(
            SessionManager.open(text(session.sessionFile)).buildSessionContext().model?.modelId,
            "faux-1",
          );
          const reused = await running.remote("resume", "--target", text(session.name));
          assert.equal(reused.reused, true);
          assert.equal(record(reused.session).sessionId, session.sessionId);
          const conflicting = await running.request("spawn", {
            name: "chosen-model",
            cwd: outside,
            model: "launch-fixture/faux-2",
          });
          assert.equal(conflicting.status, 409);
          assert.equal(record(conflicting.body.error).code, "model_conflict");
          const cancelled = await running.remote(
            "stop",
            "--target",
            text(session.sessionId),
            "--mode",
            "cancel",
          );
          assert.equal(cancelled.cancelled, true);
          assert.equal(record(cancelled.session).status, "idle");
          assert.equal(gone(numberValue(session.pid)), false);
          const oldOwner = await running.request("stop", {
            target: observer.sessionId,
            mode: "kill",
            timeoutMs: 100,
          });
          assert.equal(oldOwner.status, 504);
          assert.equal(record(oldOwner.body.error).code, "control_unconfirmed");
          assert.equal(record(oldOwner.body.error).deliveryUnknown, true);
          assert.ok((await observer.listSessions()).some((peer) => peer.id === observer.sessionId));
          assert.equal(
            (await running.request("stop", { target: session.sessionId, mode: "invalid" })).status,
            400,
          );
          assert.equal(
            (await running.request("resume", { target: session.sessionId, name: session.name }))
              .status,
            400,
          );
          await stopped(running, session);
        },
      );
      await t.test(
        "catalog preserves reordered and concurrent chunked metadata and gives exact IDs priority over names",
        async () => {
          const journal = SessionManager.inMemory(selected);
          const header = journal.getHeader();
          assert.ok(header);
          const first =
            JSON.stringify({
              cwd: header.cwd,
              id: header.id,
              timestamp: header.timestamp,
              version: header.version,
              type: "session",
            }) + "\n";
          const message = {
            type: "message",
            id: "body-entry",
            parentId: null,
            timestamp: header.timestamp,
            message: {
              role: "user",
              content: '\n{"type":"session_info","name":"BODY_IS_NOT_METADATA"}',
              timestamp: Date.now(),
            },
          };
          const padding =
            1024 * 1024 - 31 - Buffer.byteLength(first + JSON.stringify(message) + "\n");
          message.message.content = "x".repeat(padding) + message.message.content;
          const name = {
            name: "chunked-catalog-name",
            parentId: "body-entry",
            id: "name-entry",
            timestamp: header.timestamp,
            type: "session_info",
          };
          const file = join(savedDir, "filename-is-not-the-native-id.jsonl");
          const published = first + JSON.stringify(message) + "\n" + JSON.stringify(name) + "\n";
          const content = published + JSON.stringify({ ...name, name: "UNPUBLISHED_NAME" });
          writeFileSync(file, content, { mode: 0o600 });
          const page = await running.request("sessions?saved=true&q=chunked-catalog-name");
          assert.equal(page.status, 200, JSON.stringify(page.body));
          const row = record(records(page.body.sessions).at(0));
          assert.equal(row.sessionId, header.id);
          assert.equal(row.name, "chunked-catalog-name");
          assert.equal(row.cwd, selected);
          assert.deepEqual(
            (await running.request("sessions?saved=true&q=BODY_IS_NOT_METADATA")).body.sessions,
            [],
          );
          assert.deepEqual(
            (await running.request("sessions?saved=true&q=UNPUBLISHED_NAME")).body.sessions,
            [],
          );
          assert.equal(readFileSync(file, "utf8"), content, "metadata inspection never rewrites");
          const changed = await running.request("resume", { target: header.id });
          assert.equal(changed.status, 409, JSON.stringify(changed.body));
          assert.equal(record(changed.body.error).code, "journal_changed");
          assert.equal(
            readFileSync(file, "utf8"),
            content,
            "changed native identity is not rewritten",
          );
          writeFileSync(file, published, { mode: 0o600 });
          for (let index = 0; index < 2; index++) {
            const shadow = SessionManager.create(selected, savedDir);
            shadow.appendSessionInfo(header.id);
            shadow.appendMessage({
              role: "user",
              content: "Name collision.",
              timestamp: Date.now(),
            });
          }
          const ambiguous = await running.request("resume", { name: header.id });
          assert.equal(ambiguous.status, 409, JSON.stringify(ambiguous.body));
          assert.equal(record(ambiguous.body.error).code, "ambiguous_session");
          const exact = await running.request("resume", { target: header.id });
          assert.equal(exact.status, 200, JSON.stringify(exact.body));
          const session = own(record(exact.body.session));
          assert.equal(session.sessionId, header.id);
          assert.equal(session.name, "chunked-catalog-name");
          await stopped(running, session);
          const policy = [...loadConfig(configPath).clients.values()].find(
            (identity) => identity.name === "grok-bot",
          )?.launch;
          assert.ok(policy);
          const variants = [
            { character: "漢", boundary: 1 },
            { character: "漢", boundary: 2 },
            { character: "🌈", boundary: 1 },
            { character: "🌈", boundary: 2 },
            { character: "🌈", boundary: 3 },
            { character: "", boundary: 1 },
            { character: "", boundary: 31 },
            { character: "", boundary: 63 },
          ];
          const concurrent = variants.map(({ character, boundary }, index) => {
            const id = `concurrent-native-${index}`;
            const expectedName = `concurrent-name-${index}-漢🌈`;
            const firstLine = JSON.stringify({ ...header, id }) + "\n";
            const metadata = JSON.stringify({ ...name, name: expectedName }) + "\n";
            let fixtureContent: string;
            if (character !== "") {
              const prefix = '{"ignored":"';
              const chunkPadding = 1024 * 1024 - Buffer.byteLength(firstLine + prefix) - boundary;
              fixtureContent =
                firstLine +
                prefix +
                "x".repeat(chunkPadding) +
                character +
                '",' +
                metadata.slice(1);
            } else {
              const prefix = '{"type":"message","message":{"role":"user","content":"';
              const suffix = '","timestamp":0}}\n';
              const chunkPadding =
                1024 * 1024 - boundary - Buffer.byteLength(firstLine + prefix + suffix);
              fixtureContent = firstLine + prefix + "x".repeat(chunkPadding) + suffix + metadata;
            }
            const fixtureFile = join(savedDir, `concurrent-${index}.jsonl`);
            writeFileSync(fixtureFile, fixtureContent);
            return { file: fixtureFile, content: fixtureContent, id, expectedName };
          });
          const rows = await Promise.all([
            ...concurrent.map((fixture) =>
              new SessionCatalog().read(policy, fixture.file, AbortSignal.timeout(15000)),
            ),
            ...concurrent.map((fixture) =>
              new SessionCatalog().read(policy, fixture.file, AbortSignal.timeout(15000), true),
            ),
          ]);
          for (const [index, fixture] of concurrent.entries()) {
            assert.equal(rows[index]?.sessionId, fixture.id);
            assert.equal(rows[index]?.name, fixture.expectedName);
            assert.equal(rows[index + concurrent.length]?.sessionId, fixture.id);
            assert.equal(readFileSync(fixture.file, "utf8"), fixture.content);
          }
        },
      );
      await t.test(
        "partial filtered catalog pages never establish missing or unique saved-name resolution",
        async () => {
          for (let index = 0; index < 1002; index++) {
            const journal = SessionManager.create(selected, savedDir);
            journal.appendSessionInfo(
              index === 0 || index === 1001 ? "across-catalog-pages" : `batch-${index}`,
            );
            journal.appendMessage({
              role: "user",
              content: "CATALOG_BODY_MUST_NOT_LEAK",
              timestamp: Date.now(),
            });
          }
          const page = await running.request("sessions?saved=true&q=no-such-name&limit=1");
          assert.equal(page.status, 200, JSON.stringify(page.body));
          assert.deepEqual(page.body.sessions, []);
          assert.ok(
            numberValue(page.body.nextOffset) > 0,
            "empty partial filter results must still expose continuation",
          );
          const ambiguous = await running.request("resume", { name: "across-catalog-pages" });
          assert.equal(ambiguous.status, 409, JSON.stringify(ambiguous.body));
          assert.equal(record(ambiguous.body.error).code, "ambiguous_session");
          assert.ok(!JSON.stringify(page.body).includes("CATALOG_BODY_MUST_NOT_LEAK"));
        },
      );
      await t.test(
        "unreachable live broker rejects spawn and resume without replacing the broker",
        async () => {
          assert.ok(brokerPid !== undefined && !gone(brokerPid));
          const pidFile = join(agent, "intercom/broker.pid");
          const identity = readFileSync(pidFile, "utf8");
          assert.equal(Number.parseInt(identity, 10), brokerPid);
          await observer.listSessions();
          unlinkSync(getBrokerSocketPath(agent));
          scenario("task");
          const failed = await running.request("spawn", {
            name: "unhealthy-broker",
            task: "TASK_MUST_NOT_BE_ACCEPTED",
          });
          assert.equal(failed.status, 503, JSON.stringify(failed.body));
          assert.equal(record(failed.body.error).code, "broker_unavailable");
          const session = own(
            record(
              records((await running.request("sessions")).body.sessions).find(
                (row) => row.name === "remote:grok-bot:unhealthy-broker",
              ),
            ),
          );
          assert.equal(session.status, "exited");
          await until(() => gone(numberValue(session.pid)));
          assert.equal(receipt(text(session.sessionId)).calls, 0);
          const files = readdirSync(receipts).sort();
          const journal = readFileSync(text(session.sessionFile));
          const resumed = await running.request("resume", { sessionId: session.sessionId });
          assert.equal(resumed.status, 503, JSON.stringify(resumed.body));
          assert.equal(record(resumed.body.error).code, "broker_unavailable");
          assert.deepEqual(readdirSync(receipts).sort(), files, "resume opens no second writer");
          assert.deepEqual(readFileSync(text(session.sessionFile)), journal);
          assert.equal(readFileSync(pidFile, "utf8"), identity);
          assert.equal(gone(brokerPid), false);
          assert.ok(
            (await observer.listSessions()).some((peer) => peer.id === observer.sessionId),
            "the same broker still serves its already-connected peer",
          );
        },
      );
    } finally {
      if (external) {
        await stop(external);
      }
      if (bridge) {
        await stop(bridge.child);
      }
      await observer.disconnect();
      if (brokerPid !== undefined && !gone(brokerPid)) {
        const pid = brokerPid;
        process.kill(pid, "SIGTERM");
        await until(() => gone(pid));
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
      for (const pid of pids) {
        // Confirm owned process groups are gone before deleting private journals/fixtures.
        // oxlint-disable-next-line no-await-in-loop
        await until(() => gone(pid) && gone(-pid));
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);
