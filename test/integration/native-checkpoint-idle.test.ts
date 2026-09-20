import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

// Opt in: released Pi does not yet expose the additive checkpoint API.
const sdkRoot = process.env.PI_CHECKPOINT_TEST_SDK;
if (process.env.PI_CHECKPOINT_TEST_REQUIRED === "1") {
  assert.ok(sdkRoot, "PI_CHECKPOINT_TEST_REQUIRED=1 requires PI_CHECKPOINT_TEST_SDK; native checkpoint controls must not skip");
}
const repo = fileURLToPath(new URL("../../", import.meta.url));
const runtimeRepo = process.env.PI_CHECKPOINT_TEST_PACKAGE ?? repo;
const root = realpathSync(mkdtempSync(path.join(process.env.PI_CHECKPOINT_TEST_EVIDENCE ?? tmpdir(), "checkpoint-idle-")));
const agentDir = path.join(root, "agent");
for (const dir of [agentDir, path.join(root, "home"), path.join(root, "calls"), path.join(root, "bin")]) mkdirSync(dir);
for (const key of Object.keys(process.env)) if (key.startsWith("PI_SUBAGENT_") || key.startsWith("PI_SESSION_") || key.startsWith("PI_CHECKPOINT_SOCKET")) delete process.env[key];
Object.assign(process.env, { HOME: path.join(root, "home"), PI_CODING_AGENT_DIR: agentDir, PI_SUBAGENT_TEMP_ROOT: path.join(root, "pi-subagents-runs"), PI_OFFLINE: "1", JITI_FS_CACHE: path.join(root, "jiti"), OWNERSHIP_SDK_ROOT: sdkRoot, OWNERSHIP_PROBE_DIR: path.join(root, "calls"), OWNERSHIP_REPO: runtimeRepo });
writeFileSync(path.join(root, "bin/pi"), `#!/bin/sh\nexec "${process.execPath}" "${path.join(repo, "test/fixtures/native-ownership-cli.mjs")}" "$@"\n`, { mode: 0o755 });
process.env.PATH = `${path.join(root, "bin")}${path.delimiter}${process.env.PATH}`;
const { IntercomClient } = await import("../../src/pi-intercom/broker/client.ts");
const broker = spawn(process.execPath, [path.join(runtimeRepo, "src/pi-intercom/broker/broker.ts")], { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: agentDir }, stdio: ["ignore", "pipe", "pipe"] });
let brokerLog = "";
broker.stdout.on("data", c => { brokerLog += c; });
broker.stderr.on("data", c => { brokerLog += c; });
async function waitFor(check: () => boolean | Promise<boolean>, label = "condition") {
  const deadline = Date.now() + 10000;
  while (!await check()) { assert.ok(Date.now() < deadline, `timed out: ${label}`); await sleep(10); }
}
const keeper = new IntercomClient();
before(async () => { await waitFor(() => brokerLog.includes("Intercom broker started")); await keeper.connect({ name: "keeper", cwd: root, model: "none" }); });
after(async () => {
  await keeper.disconnect();
  if (broker.exitCode === null) { const exited = once(broker, "exit"); broker.kill("SIGTERM"); await exited; }
  writeFileSync(path.join(root, "broker.log"), brokerLog);
  if (process.env.PI_CHECKPOINT_TEST_EVIDENCE) console.log(`Evidence: ${root}`);
  else rmSync(root, { recursive: true, force: true });
});

async function nativeSession(t: TestContext, name: string, options: { waitForConnection?: boolean; beforeAgentStart?: () => Promise<void>; extensionFactory?: (pi: any) => void } = {}) {
  const sdkEntry = pathToFileURL(path.join(sdkRoot!, "dist/index.js"));
  const sdk = await import(sdkEntry.href);
  const aiRoot = path.dirname(findPackageJSON("@earendil-works/pi-ai", sdkEntry)!);
  const { InMemoryCredentialStore, fauxProvider } = await import(pathToFileURL(path.join(aiRoot, "dist/index.js")).href);
  const cwd = path.join(root, name); mkdirSync(cwd);
  mkdirSync(path.join(cwd, ".pi/agents"), { recursive: true });
  writeFileSync(path.join(cwd, ".pi/agents/probe.md"), "---\nname: probe\ndescription: Controlled no-model child\nmodel: openai/gpt-6-astra\nextensions:\ninheritProjectContext: false\ninheritSkills: false\n---\nReturn the fixture result.\n");
  const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  settingsManager.setProjectTrusted(true);
  const modelRuntime = await sdk.ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  const faux = options.beforeAgentStart ? fauxProvider({ provider: `checkpoint-${name}` }) : undefined;
  if (faux) modelRuntime.registerNativeProvider(faux.provider);
  const eventBus = sdk.createEventBus();
  let providerCalls = 0;
  const errors: unknown[] = [];
  const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager, eventBus, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [path.join(runtimeRepo, "src/extension/index.ts"), path.join(runtimeRepo, "src/pi-intercom/index.ts")], extensionFactories: [(pi: any) => {
    options.extensionFactory?.(pi);
    pi.on("session_start", () => pi.setSessionName(name));
    if (options.beforeAgentStart) pi.on("before_agent_start", options.beforeAgentStart);
    pi.on("before_provider_request", () => { providerCalls++; throw new Error("No model calls permitted"); });
  }] });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await sdk.createAgentSession({ cwd, agentDir, settingsManager, modelRuntime, resourceLoader: loader, model: faux?.getModel(), noTools: "builtin", sessionManager: sdk.SessionManager.create(cwd, path.join(cwd, "sessions")) });
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    await session.abort(); session.dispose();
    assert.equal(providerCalls, 0);
    if (faux) assert.equal(faux.state.callCount, 0);
    writeFileSync(path.join(root, `${name}-entries.json`), JSON.stringify({ entries: session.sessionManager.getEntries(), providerCalls, errors }, null, 2));
  };
  t.after(close);
  await session.bindExtensions({ mode: "print", onError: (e: unknown) => errors.push(e) });
  if (options.waitForConnection !== false) await waitFor(async () => (await keeper.listSessions()).some((s) => s.name === name), "native registration");
  await sleep(50);
  const invoke = (toolName: string, args: object, signal = new AbortController().signal) => session.agent.state.tools.find((tool: any) => tool.name === toolName).execute("checkpoint-fixture", args, signal);
  const capture = () => session.acquireCheckpoint({ quiesce: () => () => {}, signal: AbortSignal.timeout(5000) });
  return { session, invoke, capture, close, sdk, cwd, eventBus };
}

test("real broker startup writes a backward-readable PID identity and stays protected", async () => {
  const { stopUnhealthyBrokerBeforeSpawn } = await import("../../src/pi-intercom/broker/spawn.ts");
  const pidPath = path.join(agentDir, "intercom/broker.pid");
  const record = readFileSync(pidPath, "utf8");
  assert.equal(Number.parseInt(record, 10), broker.pid);
  if (process.platform === "linux") assert.match(record, /^\d+\nlinux-v1 /);
  // An unhealthy-socket observation must not override a matching live identity.
  await assert.rejects(stopUnhealthyBrokerBeforeSpawn(pidPath, async () => false), /refusing to spawn a second broker/);
  assert.equal(readFileSync(pidPath, "utf8"), record);
  assert.equal(keeper.isConnected(), true);
  await keeper.listSessions();
});

// Kept as counterexamples to unsafe disconnect/stop approaches, not proposed fixes.
test("unchanged protocol: accepted replace delivery is lost on recipient disconnect", async () => {
  const recipient = new IntercomClient(); let received = 0;
  recipient.on("message", () => received++);
  await recipient.connect({ name: "queue-loss", cwd: root, model: "none", status: "idle", acceptsAsks: true });
  const receipt = await keeper.send("queue-loss", { text: "accepted only in broker memory", delivery: "queue", queueMode: "replace", threadId: "proof" });
  assert.equal(receipt.accepted, true); assert.equal(receipt.queued, true); assert.equal(received, 0);
  await recipient.disconnect();
  await recipient.connect({ name: "queue-loss", cwd: root, model: "none", status: "idle" });
  await sleep(1700); assert.equal(received, 0); await recipient.disconnect();
  writeFileSync(path.join(root, "accepted-queued-disconnect.json"), JSON.stringify({ receipt, received }));
});

test("unchanged watcher stop leaves a real file-processing tail alive", async () => {
  const { createResultWatcher } = await import("../../src/runs/background/result-watcher.ts");
  const { createEventBus } = await import("../support/helpers.ts");
  const events = createEventBus(); const dir = path.join(root, "watcher-tail"); mkdirSync(dir);
  const state = { currentSessionId: "owner", completionSeen: new Map(), resultFileCoalescer: { schedule() {}, clear() {} } } as any;
  const watcher = createResultWatcher({ events }, state, dir, 60000);
  let relay: any; let completed = 0;
  events.on("subagent:result-intercom", payload => { relay = payload; });
  events.on("subagent:async-complete", () => completed++);
  watcher.startResultWatcher();
  const file = path.join(dir, "tail.json");
  writeFileSync(file, JSON.stringify({ id: "tail", runId: "tail", sessionId: "owner", agent: "worker", summary: "done", success: true, timestamp: Date.now(), intercomTarget: "peer", nestedChildren: [] }));
  await waitFor(() => !!relay); await watcher.stopResultWatcher();
  assert.equal(completed, 0); assert.equal(existsSync(file), true);
  events.emit("subagent:result-intercom-delivery", { requestId: relay.requestId, delivered: true });
  await waitFor(() => completed === 1); assert.equal(existsSync(file), false);
  writeFileSync(path.join(root, "watcher-tail.json"), JSON.stringify({ completedAfterStop: completed, deletedAfterStop: !existsSync(file) }));
});

test("watcher checkpoint invalidates before joining the real delivery tail, then resumes observation", async () => {
  const { createResultWatcher } = await import("../../src/runs/background/result-watcher.ts");
  const { createEventBus } = await import("../support/helpers.ts");
  const events = createEventBus(); const dir = path.join(root, "watcher-join"); mkdirSync(dir);
  const state = { currentSessionId: "join-owner", completionSeen: new Map(), resultFileCoalescer: { schedule() {}, clear() {} } } as any;
  const watcher = createResultWatcher({ events }, state, dir, 60000);
  let relay: any; let completed = 0;
  const controller = new AbortController();
  events.on("subagent:result-intercom", payload => { relay = payload; });
  events.on("subagent:async-complete", () => { assert.equal(controller.signal.aborted, true); completed++; });
  watcher.startResultWatcher();
  const publish = (id: string) => writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, runId: id, sessionId: "join-owner", agent: "worker", summary: "done", success: true, timestamp: Date.now(), intercomTarget: "peer", nestedChildren: [] }));
  try {
    publish("first"); await waitFor(() => !!relay);
    let joined = false;
    const joining = watcher.holdCheckpoint({ type: "session_checkpoint", boundary: "settled", signal: controller.signal, invalidate: () => controller.abort() }).then(() => { joined = true; });
    await sleep(10); assert.equal(controller.signal.aborted, true); assert.equal(joined, false); assert.equal(completed, 0);
    events.emit("subagent:result-intercom-delivery", { requestId: relay.requestId, delivered: true });
    await joining; assert.equal(completed, 1); assert.equal(existsSync(path.join(dir, "first.json")), false);
    relay = undefined; publish("second"); await waitFor(() => !!relay);
    events.emit("subagent:result-intercom-delivery", { requestId: relay.requestId, delivered: true });
    await waitFor(() => completed === 2); assert.equal(existsSync(path.join(dir, "second.json")), false);
  } finally { watcher.stopResultWatcher(); }
});

test("native idle package can acquire a resumable checkpoint; broker refuses before mutation and release resumes once", { skip: !sdkRoot }, async (t) => {
  const host = await nativeSession(t, "idle");
  const hold = await host.capture();
  try {
    writeFileSync(path.join(root, "idle-receipt.json"), JSON.stringify({ sleepReady: hold.sleepReady, sleepBlockers: hold.sleepBlockers, checkpoint: hold.checkpoint }, null, 2));
    assert.equal(hold.sleepReady, true, hold.sleepBlockers.join("\n"));
    const before = host.session.sessionManager.getEntries().length;
    const refused = await keeper.send("idle", { text: "must not be accepted", delivery: "passive" });
    assert.equal(refused.accepted, false); assert.match(refused.reason!, /held for checkpoint/);
    assert.equal(host.session.sessionManager.getEntries().length, before);
    assert.equal(hold.signal.aborted, false);
  } finally { hold.release(); }
  // Native release is synchronous; the broker release travels on the host socket.
  // A list round trip on that same connection orders it before another client sends.
  await host.invoke("intercom", { action: "list" });
  const delivered = await keeper.send("idle", { text: "after release", delivery: "passive", messageId: "released-once" });
  assert.equal(delivered.accepted, true);
  await waitFor(() => host.session.sessionManager.getEntries().some((e: any) => e.details?.message?.id === "released-once"));
  assert.equal(host.session.sessionManager.getEntries().filter((e: any) => e.details?.message?.id === "released-once").length, 1);
});

test("real socket arrival racing acquisition is persisted in the cut or invalidates it, never accepted past the cut", { skip: !sdkRoot }, async (t) => {
  const host = await nativeSession(t, "socket-race");
  const outcomes = [];
  for (let i = 0; i < 20; i++) {
    const id = `race-${i}`;
    const acquisition = host.capture().then((hold: any) => ({ hold }), (error: Error) => ({ error }));
    const receipt = await keeper.send("socket-race", { text: id, messageId: id, delivery: "passive" });
    const result = await acquisition;
    if ("hold" in result) {
      try {
        if (receipt.accepted && result.hold.sleepReady && !result.hold.signal.aborted) {
          assert.ok(result.hold.checkpoint.entries.some((e: any) => e.details?.message?.id === id), "an accepted message must precede the positive cut or invalidate it");
        }
        outcomes.push({ accepted: receipt.accepted, sleepReady: result.hold.sleepReady, invalidated: result.hold.signal.aborted });
      } finally { result.hold.release(); }
    } else { assert.match(result.error.message, /Checkpoint cancelled/); outcomes.push({ accepted: receipt.accepted, cancelled: true }); }
    if (receipt.accepted) {
      await waitFor(() => host.session.sessionManager.getEntries().some((e: any) => e.details?.message?.id === id));
      assert.equal(host.session.sessionManager.getEntries().filter((e: any) => e.details?.message?.id === id).length, 1);
    } else {
      assert.match(receipt.reason!, /held for checkpoint/);
      assert.equal(host.session.sessionManager.getEntries().filter((e: any) => e.details?.message?.id === id).length, 0);
    }
  }
  writeFileSync(path.join(root, "socket-race.json"), JSON.stringify(outcomes, null, 2));
});

test("accepted queued topic blocks capture until recipient persistence; topic and native queue survive fresh cold SDK", { skip: !sdkRoot }, async (t) => {
  const host = await nativeSession(t, "queued");
  const completed = await host.invoke("delegate", { agent: "probe", task: "Return FIRST_SESSION_TOKEN", async: false, output: false });
  assert.ok(completed.details.runId);
  writeFileSync(path.join(root, "cold-expected.json"), JSON.stringify({ runId: completed.details.runId }));
  // Delegation's completion notification can still be preparing a native turn.
  // Join it; the subscription round trip then orders idle presence on that socket.
  await host.session.waitForIdle();
  await host.invoke("intercom", { action: "subscribe", topic: "checkpoint-resource" });
  const update = { topic: "checkpoint-resource", revision: 1, updatedAt: Date.now(), event: "update" as const, text: "retained owner", resource: "fixture", ownership: "held" as const };
  const snapshot = await keeper.updateTopics({ action: "publish", topic: update });
  assert.equal(snapshot.receipts.length, 1); assert.equal(snapshot.receipts[0].accepted, true); assert.equal(snapshot.receipts[0].queued, true);
  assert.equal(await keeper.holdCheckpoint(), false, "accepted outgoing coalesced delivery also blocks its sender");
  const blocked = await host.capture();
  assert.equal(blocked.sleepReady, false); assert.match(blocked.sleepBlockers.join("\n"), /accepted queued/);
  blocked.release();
  await waitFor(() => host.session.sessionManager.getEntries().some((e: any) => e.customType === "intercom-topic" && e.data?.record?.update.text === "retained owner"));
  // A native next-turn queue must be captured, not converted into another mailbox.
  host.session.sendCustomMessage({ customType: "checkpoint-fixture", content: "native pending payload", display: false }, { deliverAs: "nextTurn" });
  const hold = await host.capture();
  let checkpoint;
  try {
    assert.equal(hold.sleepReady, true, hold.sleepBlockers.join("\n")); checkpoint = hold.checkpoint;
    assert.equal(checkpoint.queues.nextTurn.length, 1);
    host.sdk.writeSessionCheckpoint(path.join(root, "cold-checkpoint.json"), checkpoint);
  } finally { hold.release(); }
  await host.close();
  const callsBefore = readdirSync(path.join(root, "calls")).length;
  const child = spawn(process.execPath, [path.join(repo, "test/fixtures/native-checkpoint-cold.mjs"), root, runtimeRepo, sdkRoot!], { env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: agentDir, PI_SUBAGENT_TEMP_ROOT: process.env.PI_SUBAGENT_TEMP_ROOT, PI_OFFLINE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", c => output += c); child.stderr.on("data", c => output += c);
  const [code] = await once(child, "exit"); writeFileSync(path.join(root, "cold.log"), output); assert.equal(code, 0, output);
  assert.equal(readdirSync(path.join(root, "calls")).length, callsBefore, "cold restoration must not launch children");
});

test("native result arrival invalidates the hold before result handling", { skip: !sdkRoot }, async (t) => {
  const host = await nativeSession(t, "arrival");
  const { RESULTS_DIR } = await import("../../src/shared/types.ts");
  const hold = await host.capture(); assert.equal(hold.sleepReady, true);
  const file = path.join(RESULTS_DIR, "foreign-result.json");
  // Another owner shares the watcher directory. This must invalidate before
  // inspection, but must never adopt/delete the other owner's result.
  writeFileSync(file, JSON.stringify({ id: "foreign", sessionId: "other-owner", success: true, summary: "retain", timestamp: Date.now() }));
  await waitFor(() => hold.signal.aborted, "result arrival invalidation");
  assert.equal(existsSync(file), true); hold.release();
});

for (const code of ["EMFILE", "ENOSPC"]) {
  test(`native polling checkpoint invalidates owned arrivals after ${code} without adopting foreign results`, { skip: !sdkRoot }, async (t) => {
    const { createResultWatcher } = await import("../../src/runs/background/result-watcher.ts");
    const dir = path.join(root, `polling-${code}`); mkdirSync(dir);
    const state = { currentSessionId: "poll-owner", ownedRuns: new Map([["foreign", {}], ["legacy", {}]]), completionSeen: new Map() } as any;
    const foreign = path.join(dir, "foreign.json"), owned = path.join(dir, "owned.json"), legacy = path.join(dir, "legacy.json");
    const foreignContent = JSON.stringify({ id: "foreign", sessionId: "other-owner", summary: "retain", success: true, nestedChildren: [] });
    writeFileSync(foreign, foreignContent);
    let watcher: ReturnType<typeof createResultWatcher>;
    let checkpointSignal: AbortSignal;
    let polls = 0;
    let failUnlink = true;
    const completed: string[] = [];
    const host = await nativeSession(t, `poll-${code}`, { extensionFactory: (pi) => {
      // Inject only the OS watch failure. Files, coalescing, polling timers and
      // checkpoint event/invalidation/release all use their real implementations.
      watcher = createResultWatcher({ events: { on: () => () => {}, emit: (event, data: any) => {
        if (event !== "subagent:async-complete") return;
        assert.equal(checkpointSignal.aborted, true, "invalidate before notification or unlink");
        completed.push(data.id);
        pi.appendEntry("polling-completion", data);
      } } }, state, dir, 60000, {
        fs: { ...fs, watch: code === "EMFILE" ? () => { throw Object.assign(new Error(code), { code }); } : fs.watch, unlinkSync: (file) => {
          if (file === owned && failUnlink) { failUnlink = false; throw Object.assign(new Error("fixture unlink failure"), { code: "EBUSY" }); }
          fs.unlinkSync(file);
        } },
        timers: { setTimeout, clearTimeout, clearInterval, setInterval: (handler: () => void, ms?: number) => setInterval(() => { handler(); polls++; }, ms) },
      });
      pi.on("session_checkpoint", async (event: any) => {
        checkpointSignal = event.signal;
        await watcher.holdCheckpoint(event);
        event.signal.throwIfAborted();
        return { sleepReady: true };
      });
    } });
    watcher!.startResultWatcher();
    if (code === "ENOSPC") state.watcher.emit("error", Object.assign(new Error(code), { code }));
    assert.equal(state.watcher, null);
    assert.ok(state.watcherRestartTimer);
    // No timeout signal: a deadline must not masquerade as arrival invalidation.
    const capture = () => host.session.acquireCheckpoint({ quiesce: () => () => {} });
    let hold: any;
    try {
      hold = await capture(); assert.equal(hold.sleepReady, true);
      let before = polls;
      await waitFor(() => polls > before, "real foreign-only polling tick");
      assert.equal(hold.signal.aborted, false, "foreign files must not permanently block idle, even with a copied run id");
      assert.equal(readFileSync(foreign, "utf8"), foreignContent);
      assert.deepEqual(completed, []);
      let atInvalidation: unknown;
      hold.signal.addEventListener("abort", () => { atInvalidation = { completed: [...completed], fileExists: existsSync(owned), seen: state.completionSeen.size }; }, { once: true });
      writeFileSync(owned, JSON.stringify({ id: "owned", sessionId: "poll-owner", summary: "arrived after cut", success: true, nestedChildren: [] }));
      before = polls;
      await waitFor(() => polls > before, "real owned-result polling tick");
      const observation = { code, polls, sleepReady: hold.sleepReady, invalidated: hold.signal.aborted, fileExists: existsSync(owned), completed: [...completed], capturedCompletion: hold.checkpoint.entries.some((e: any) => e.customType === "polling-completion") };
      writeFileSync(path.join(root, `polling-${code}.json`), JSON.stringify(observation, null, 2));
      assert.equal(hold.signal.aborted, true, JSON.stringify(observation));
      assert.deepEqual(atInvalidation, { completed: [], fileExists: true, seen: 0 });
      hold.release();
      await waitFor(() => completed.length === 1, "ordinary completion after invalidation");
      assert.deepEqual(completed, ["owned"]); assert.equal(existsSync(owned), true);
      // The runtime deduper must not certify the notification/failed-unlink gap.
      await assert.rejects(capture(), /Checkpoint cancelled/);
      await waitFor(() => !existsSync(owned), "ordinary dedupe/unlink after cancelled acquisition");
      assert.deepEqual(completed, ["owned"]);

      // Existing legacy-owned pending files also block acquisition.
      writeFileSync(legacy, JSON.stringify({ id: "legacy", summary: "pending before cut", success: true, nestedChildren: [] }));
      await assert.rejects(capture(), /Checkpoint cancelled/);
      await waitFor(() => completed.length === 2, "existing owned completion after cancelled acquisition");
      assert.deepEqual(completed, ["owned", "legacy"]); assert.equal(existsSync(legacy), false);
      hold = await capture(); assert.equal(hold.sleepReady, true);
      assert.equal(hold.checkpoint.entries.filter((e: any) => e.customType === "polling-completion").length, 2);
      before = polls;
      await waitFor(() => polls > before, "foreign-only polling after delivery");
      assert.equal(hold.signal.aborted, false);
      assert.deepEqual(completed, ["owned", "legacy"]);
      assert.equal(readFileSync(foreign, "utf8"), foreignContent);
    } finally { hold?.release(); watcher!.stopResultWatcher(); }
  });
}

test("native ordinary ask blocks sleep without answering or disconnecting it", { skip: !sdkRoot }, async (t) => {
  const host = await nativeSession(t, "ask");
  const controller = new AbortController(); let asked = false;
  const onMessage = (_from: unknown, message: any) => { if (message.content.text === "live ask") asked = true; };
  keeper.on("message", onMessage);
  const pending = host.invoke("intercom", { action: "ask", to: "keeper", message: "live ask", delivery: "steer" }, controller.signal);
  try {
    await waitFor(() => asked);
    const hold = await host.capture();
    assert.equal(hold.sleepReady, false); assert.match(hold.sleepBlockers.join("\n"), /reply waiter/); hold.release();
    assert.equal(controller.signal.aborted, false);
  } finally { controller.abort(); await assert.rejects(pending, /Cancelled/); keeper.off("message", onMessage); }
});

test("native inbound tail invalidates acquisition after cancelled preparation, with zero provider requests", { skip: !sdkRoot }, async (t) => {
  const prepared = Promise.withResolvers<void>(), proceed = Promise.withResolvers<void>();
  const host = await nativeSession(t, "inbound-tail", { beforeAgentStart: async () => { prepared.resolve(); await proceed.promise; } });
  let detachRequested = false;
  host.eventBus.on("pi-intercom:detach-request", () => { detachRequested = true; });
  const prompt = host.session.prompt("never reaches a provider");
  void prompt.catch(() => {});
  try {
    await prepared.promise;
    const receipt = await keeper.send("inbound-tail", { messageId: "inbound-tail-ask", text: "Subagent needs a supervisor decision.\nRetain this question.", expectsReply: true, delivery: "steer" });
    assert.equal(receipt.accepted, true);
    await waitFor(() => detachRequested);
    const abort = host.session.abort(); proceed.resolve();
    await abort; await assert.rejects(prompt, /abort|cancel/i);
    // Only the preparation admission used a local model descriptor. Leave no
    // model selected for the later ordinary notification; no stream is called.
    host.session.agent.selectedModel = undefined;
    // The real socket callback is still awaiting the 500ms detach handshake.
    await assert.rejects(host.capture(), /Checkpoint cancelled/);
    await waitFor(() => host.session.sessionManager.getEntries().some((e: any) => e.details?.message?.id === "inbound-tail-ask"));
    // The normal no-model error feedback resolves the peer's reply context;
    // checkpoint code did not answer, cancel or drop the accepted message.
    const hold = await host.capture();
    assert.equal(hold.sleepReady, true, hold.sleepBlockers.join("\n")); hold.release();
    assert.equal(host.session.sessionManager.getEntries().filter((e: any) => e.details?.message?.id === "inbound-tail-ask").length, 1);
  } finally { proceed.resolve(); await host.session.abort(); await prompt.catch(() => {}); }
});

test("native reconnect tail invalidates acquisition and reconnects normally after release", { skip: !sdkRoot }, async (t) => {
  broker.kill("SIGSTOP");
  let host: Awaited<ReturnType<typeof nativeSession>>;
  try {
    host = await nativeSession(t, "reconnect", { waitForConnection: false });
    await assert.rejects(host.capture(), /Checkpoint cancelled/);
  } finally { broker.kill("SIGCONT"); }
  await waitFor(async () => (await keeper.listSessions()).some(s => s.name === "reconnect"));
  const hold = await host!.capture();
  assert.equal(hold.sleepReady, true, hold.sleepBlockers.join("\n")); hold.release();
});

test("native relay callback remains owned through real pending broker IPC", { skip: !sdkRoot }, async (t) => {
  const host = await nativeSession(t, "relay");
  const received: string[] = [];
  const onMessage = (_from: unknown, message: any) => received.push(message.content.text);
  keeper.on("message", onMessage);
  broker.kill("SIGSTOP"); // Only this test's isolated broker, never the installed broker.
  let captured = false;
  let acquisition: Promise<any> | undefined;
  try {
    host.eventBus.emit("subagent:result-intercom", { to: "keeper", message: "joined relay", requestId: "joined-relay" });
    acquisition = host.capture().then((hold: any) => { captured = true; return hold; });
    await sleep(100);
    assert.equal(captured, false, "capture must wait for the returned relay tail, not snapshot its empty local inbox");
  } finally { broker.kill("SIGCONT"); }
  try {
    const hold = await acquisition!;
    assert.equal(hold.sleepReady, true, hold.sleepBlockers.join("\n")); hold.release();
    await waitFor(() => received.includes("joined relay"));
    assert.equal(received.filter(x => x === "joined relay").length, 1);
  } finally { keeper.off("message", onMessage); }
});

test("native checkpoint fails closed when disk discovery cannot establish run ownership", { skip: !sdkRoot }, async (t) => {
  const host = await nativeSession(t, "unreadable-run");
  const { ASYNC_DIR } = await import("../../src/shared/types.ts");
  const dir = path.join(ASYNC_DIR, "unreadable"); mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "status.json"), "{unfinished");
  try { await assert.rejects(host.capture(), /parse async status/); }
  finally {
    // Repair only this fixture's file so later tests can use the shared isolated root.
    writeFileSync(path.join(dir, "status.json"), JSON.stringify({ runId: "unreadable", sessionId: "another-fixture", state: "complete", startedAt: Date.now(), mode: "single", steps: [] }));
  }
});

test("native durable supervisor question blocks without being answered or cancelled", { skip: !sdkRoot }, async (t) => {
  const host = await nativeSession(t, "question");
  const result = await host.invoke("delegate", { agent: "probe", task: "CREATE_QUESTION", async: false, output: false });
  const { listSupervisorQuestions } = await import("../../src/runs/shared/supervisor-questions.ts");
  const before = listSupervisorQuestions(host.session.sessionId);
  assert.equal(before.length, 1); assert.equal(before[0].state, "awaiting_input");
  const hold = await host.capture();
  assert.equal(hold.sleepReady, false); assert.match(hold.sleepBlockers.join("\n"), /question is unresolved/); hold.release();
  assert.equal(listSupervisorQuestions(host.session.sessionId)[0].state, "awaiting_input");
  assert.ok(result.details.runId);
});

test("native slash foreground ownership defers capture and preserves its live child", { skip: !sdkRoot }, async (t) => {
  const host = await nativeSession(t, "slash");
  const command = host.session.prompt("/run probe[output=false] WAIT_GATE:release_slash --fg");
  const calls = () => readdirSync(path.join(root, "calls")).filter(f => f.startsWith("call-")).map(f => JSON.parse(readFileSync(path.join(root, "calls", f), "utf8")));
  try {
    await waitFor(() => calls().some(c => c.task.includes("WAIT_GATE:release_slash")), "slash child");
    const call = calls().find(c => c.task.includes("WAIT_GATE:release_slash"));
    await assert.rejects(host.session.acquireCheckpoint({ quiesce: () => () => {}, signal: AbortSignal.timeout(100) }), /Checkpoint cancelled/);
    assert.equal(process.kill(call.pid, 0), true);
  } finally { writeFileSync(path.join(root, "calls/release_slash"), "release"); await command; }
  assert.ok(host.session.sessionManager.getEntries().some((e: any) => e.customType === "subagent-slash-result"));
  const hold = await host.capture(); assert.equal(hold.sleepReady, true, hold.sleepBlockers.join("\n")); hold.release();
});

test("actual background and foreground controlled children block sleep without being stopped", { skip: !sdkRoot }, async (t) => {
  const host = await nativeSession(t, "children");
  const calls = () => readdirSync(path.join(root, "calls")).filter(f => f.startsWith("call-")).map(f => JSON.parse(readFileSync(path.join(root, "calls", f), "utf8")));
  for (const background of [true, false]) {
    const gate = background ? "release_background" : "release_foreground";
    const running = host.invoke("delegate", { agent: "probe", task: `WAIT_GATE:${gate}`, async: background, output: false });
    await waitFor(() => calls().some(c => c.task.includes(`WAIT_GATE:${gate}`)), "controlled child start");
    const call = calls().find(c => c.task.includes(`WAIT_GATE:${gate}`));
    try {
      const hold = await host.capture();
      assert.equal(hold.sleepReady, false); assert.match(hold.sleepBlockers.join("\n"), /subagent.*live|Subagent.*live/); hold.release();
      assert.equal(process.kill(call.pid, 0), true);
    } finally { writeFileSync(path.join(root, "calls", gate), "release"); }
    const result = await running;
    await waitFor(() => { try { process.kill(call.pid, 0); return false; } catch { return true; } }, "natural child exit");
    const runId = result.details.runId ?? result.details.asyncId;
    await waitFor(() => host.session.sessionManager.getEntries().some((e: any) => e.customType === "intercom_message" && e.details?.subagentCompletion?.runId === runId), "automatic completion after release");
    assert.equal(host.session.sessionManager.getEntries().filter((e: any) => e.customType === "intercom_message" && e.details?.subagentCompletion?.runId === runId).length, 1);
    if (background) {
      const runnerPid = JSON.parse(readFileSync(path.join(result.details.asyncDir, "status.json"), "utf8")).pid;
      await waitFor(() => { try { process.kill(runnerPid, 0); return false; } catch { return true; } }, "natural runner exit");
    }
  }
});
