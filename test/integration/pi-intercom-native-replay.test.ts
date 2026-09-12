import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const evidenceDir = process.env.PI_INTERCOM_TEST_EVIDENCE_DIR;
if (evidenceDir) mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
const root = realpathSync(mkdtempSync(path.join(evidenceDir ?? tmpdir(), "pi-intercom-native-")));
const agentDir = path.join(root, "agent");
for (const directory of [agentDir, path.join(root, "home"), path.join(root, "pi-subagents-runtime")]) {
  mkdirSync(directory, { recursive: true });
}
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PI_SUBAGENT_")) delete process.env[key];
}
process.env.HOME = path.join(root, "home");
process.env.USERPROFILE = process.env.HOME;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_SUBAGENT_TEMP_ROOT = path.join(root, "pi-subagents-runtime");
process.env.PI_OFFLINE = "1";
process.env.JITI_FS_CACHE = path.join(root, "jiti");

// Use an isolated rebuilt Pi package to check a native fix before it is released.
const sdkRoot = process.env.PI_INTERCOM_TEST_SDK ?? path.dirname(findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url)!);
const sdkEntry = pathToFileURL(path.join(sdkRoot, "dist/index.js"));
const aiRoot = path.dirname(findPackageJSON("@earendil-works/pi-ai", sdkEntry)!);
const { createAgentSession, createEventBus, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(sdkEntry.href);
const { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore, Type } = await import(pathToFileURL(path.join(aiRoot, "dist/index.js")).href);
const { IntercomClient } = await import("../../src/pi-intercom/broker/client.ts");
const { buildSubagentResultIntercomPayload, deliverSubagentResultIntercomEvent } = await import("../../src/intercom/result-intercom.ts");
const { listSupervisorQuestions, questionProcessAlive, readQuestionState, saveQuestionAnswer, saveQuestionOwner } = await import("../../src/runs/shared/supervisor-questions.ts");
const { runSync } = await import("../../src/runs/foreground/execution.ts");
const { executeAsyncSingle } = await import("../../src/runs/background/async-execution.ts");
const { resolveControlConfig, formatControlNoticeMessage } = await import("../../src/runs/shared/subagent-control.ts");
const { handleSubagentControlNotice } = await import("../../src/extension/control-notices.ts");
const { makeAgent } = await import("../support/helpers.ts");
const { createSubagentExecutor } = await import("../../src/runs/foreground/subagent-executor.ts");
const { ownedRunView } = await import("../../src/runs/shared/run-records.ts");

const broker = spawn(process.execPath, [path.join(repo, "src/pi-intercom/broker/broker.ts")], {
  cwd: root,
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    TMPDIR: tmpdir(),
    PI_CODING_AGENT_DIR: agentDir,
    PI_SUBAGENT_TEMP_ROOT: process.env.PI_SUBAGENT_TEMP_ROOT,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let brokerLog = "";
broker.stdout.on("data", (chunk) => { brokerLog += chunk; });
broker.stderr.on("data", (chunk) => { brokerLog += chunk; });

async function waitFor(check: () => boolean | Promise<boolean>, description: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${description}`);
    await sleep(5);
  }
}

const fixtureClient = new IntercomClient();
before(async () => {
  await waitFor(() => brokerLog.includes("Intercom broker started"), "private broker");
  // Keep the suite's broker alive between cold SDK loads, beyond its 5s idle exit.
  await fixtureClient.connect({ name: "fixture-host", cwd: root, model: "fixture" });
});
after(async () => {
  await fixtureClient.disconnect();
  if (broker.exitCode === null) {
    const exited = once(broker, "exit");
    broker.kill("SIGTERM");
    await exited;
  }
  if (evidenceDir) writeFileSync(path.join(root, "broker.log"), brokerLog);
  else rmSync(root, { recursive: true, force: true });
});

function gate(t: TestContext) {
  const deferred = Promise.withResolvers<void>();
  t.after(() => deferred.resolve());
  return deferred;
}

function inboundId(message: unknown): string | undefined {
  return (message as { details?: { message?: { id?: string } } } | undefined)?.details?.message?.id;
}

async function makeSession(t: TestContext, name: string, options: {
  configure?: (pi: ExtensionAPI) => void;
  eventBus?: ExtensionAPI["events"];
  hasUI?: boolean;
  subagents?: boolean | string;
  child?: { runId: string; supervisor: string };
} = {}) {
  const cwd = path.join(root, name);
  mkdirSync(cwd);
  const faux = fauxProvider({ provider: `fixture-${name}` });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false } });
  const events: Array<Record<string, unknown>> = [];
  const errors: Array<{ event: string; error: string }> = [];
  let ctx: ExtensionContext;
  const loader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager, eventBus: options.eventBus,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: "Deterministic intercom regression fixture.",
    additionalExtensionPaths: [
      process.env.PI_INTERCOM_TEST_EXTENSION ?? path.join(repo, "src/pi-intercom/index.ts"),
      ...(options.subagents ? [typeof options.subagents === "string" ? options.subagents : path.join(repo, "src/extension/index.ts")] : []),
    ],
    extensionFactories: [(pi: ExtensionAPI) => {
      pi.on("session_start", (event, context) => {
        ctx = context;
        pi.setSessionName(name);
        events.push({ type: "extension.session_start", reason: event.reason });
      });
      pi.on("message_end", (event) => {
        events.push({ type: "extension.message_end", role: event.message.role, id: inboundId(event.message), stopReason: "stopReason" in event.message ? event.message.stopReason : undefined });
      });
      pi.on("agent_settled", (_event, context) => {
        events.push({ type: "extension.agent_settled", signalPresent: !!context.signal, pending: context.hasPendingMessages() });
      });
      pi.on("session_before_compact", ({ preparation }) => ({ compaction: {
        summary: "Earlier fixture messages were handled.",
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore,
      } }));
      options.configure?.(pi);
    }],
  });
  if (options.child) {
    process.env.PI_SUBAGENT_ORCHESTRATOR_TARGET = options.child.supervisor;
    process.env.PI_SUBAGENT_RUN_ID = options.child.runId;
    process.env.PI_SUBAGENT_CHILD_AGENT = "worker";
    process.env.PI_SUBAGENT_CHILD_INDEX = "0";
    process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME = name;
  }
  try {
    await loader.reload();
  } finally {
    for (const key of ["PI_SUBAGENT_ORCHESTRATOR_TARGET", "PI_SUBAGENT_RUN_ID", "PI_SUBAGENT_CHILD_AGENT", "PI_SUBAGENT_CHILD_INDEX", "PI_SUBAGENT_INTERCOM_SESSION_NAME"]) delete process.env[key];
  }
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({
    cwd, agentDir, modelRuntime, settingsManager, resourceLoader: loader,
    model: faux.getModel(), noTools: "builtin",
    sessionManager: SessionManager.create(cwd, path.join(cwd, "sessions")),
  });
  session.subscribe((event: { type: string; message?: { role: string; details?: unknown } }) => {
    if (event.type === "message_end" || event.type === "agent_settled") {
      events.push({ type: `sdk.${event.type}`, role: event.message?.role, id: event.message && inboundId(event.message) });
    }
  });
  const sender = new IntercomClient();
  const sends: string[] = [];
  t.after(async () => {
    // Only teardown is emitted explicitly. All delivery/settlement events come from native Pi.
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    await session.abort();
    session.dispose();
    await sender.disconnect();
    if (evidenceDir) writeFileSync(path.join(root, `${name}.json`), JSON.stringify({ sends, modelCalls: faux.state.callCount, errors, events, entries: session.sessionManager.getEntries() }, null, 2));
  });
  await sender.connect({ name: `sender-${name}`, cwd, model: "fixture" });
  await session.bindExtensions({
    mode: options.hasUI ? "rpc" : "print",
    ...(options.hasUI ? { uiContext: { ...session.extensionRunner.getUIContext() } } : {}),
    onError: (error: { event: string; error: string }) => errors.push(error),
  });
  await waitFor(async () => (await sender.listSessions()).some((peer) => peer.name === name), "receiver registration");
  return {
    session, faux, events, errors, sender, sends,
    context: () => ctx!,
    visible: (id: string) => session.sessionManager.getEntries().filter((entry: { type: string; details?: unknown }) => entry.type === "custom_message" && inboundId(entry) === id),
    settled: () => events.filter((event) => event.type === "sdk.agent_settled").length,
    send: async (id: string, input: Omit<Parameters<InstanceType<typeof IntercomClient>["send"]>[1], "messageId"> = { text: `message:${id}` }) => {
      sends.push(id);
      const receipt = await sender.send(name, { ...input, messageId: id });
      assert.equal(receipt.accepted, true);
      return receipt;
    },
    status: async () => {
      const tool = session.agent.state.tools.find((tool: { name: string }) => tool.name === "intercom");
      return JSON.stringify(await tool.execute("fixture-status", { action: "status" }, new AbortController().signal));
    },
  };
}

test("native Doctor reports broker registration and loaded compiled identity, not changed files on disk", async (t) => {
  const packageCopy = path.join(root, "doctor-package");
  mkdirSync(packageCopy);
  cpSync(path.join(repo, "dist"), path.join(packageCopy, "dist"), { recursive: true });
  const manifest = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8"));
  writeFileSync(path.join(packageCopy, "package.json"), JSON.stringify(manifest));
  const receiver = await makeSession(t, "doctor-loaded", { subagents: path.join(packageCopy, "dist/extension/index.js") });
  const loader = receiver.session.agent.state.tools.find((tool: { name: string }) => tool.name === "load_subagent");
  await loader.execute("load", {}, new AbortController().signal);
  const subagent = receiver.session.agent.state.tools.find((tool: { name: string }) => tool.name === "subagent");
  const doctor = async () => {
    const result = await subagent.execute("doctor", { action: "doctor" }, new AbortController().signal);
    assert.equal(result.isError, undefined);
    return result.content.map((part: { text?: string }) => part.text ?? "").join("\n");
  };
  const before = await doctor();
  assert.match(before, /- bridge: responding\n- connection: connected/);
  const registered = (await receiver.sender.listSessions()).find((peer) => peer.name === "doctor-loaded")!;
  assert.ok(before.includes(`- broker session id: ${registered.id}`));
  assert.ok(before.includes(`- Node: ${process.version}`));
  assert.ok(before.includes(`- process: ${process.pid} (${process.execPath})`));
  assert.ok(before.includes(`- Pi package directory: ${sdkRoot}`));
  assert.ok(before.includes(`- extension module: ${path.join(packageCopy, "dist/extension/doctor.js")}`));
  const build = before.match(/^- loaded pi-subagents build: (.+)$/m)?.[1];
  assert.ok(build?.startsWith(`${manifest.version} (runtime SHA-256 `), "Doctor must identify the loaded compiled build");
  assert.match(build, /[0-9a-f]{64}\)$/);
  assert.match(before, /- native queue contract: not verified/);
  writeFileSync(path.join(packageCopy, "package.json"), JSON.stringify({ ...manifest, version: "99.0.0" }));
  writeFileSync(path.join(packageCopy, "dist/extension/build-info.js"), `export const EXTENSION_BUILD = { version: "99.0.0", sha256: "${"0".repeat(64)}" };\n`);
  const after = await doctor();
  assert.equal(after.match(/^- loaded pi-subagents build: (.+)$/m)?.[1], build, "on-disk replacement does not change loaded code identity");
  assert.equal(receiver.faux.state.callCount, 0);
  assert.deepEqual(receiver.errors, []);
  if (evidenceDir) writeFileSync(path.join(root, "doctor-loaded-identity.json"), JSON.stringify({ before, after }, null, 2));
});

test("native steady passive receipts do not rescan old history and still survive tree navigation", async (t) => {
  const receiver = await makeSession(t, "incremental-receipts");
  const manager = receiver.session.sessionManager;
  for (let index = 0; index < 1_024; index++) manager.appendCustomMessageEntry("intercom_message", `old receipt ${index}`, false, { message: { id: `old-${index}` } });
  const branchPoint = manager.getLeafId();
  await receiver.session.reload();
  await waitFor(async () => (await receiver.sender.listSessions()).some((peer) => peer.name === "incremental-receipts"), "registration after receipt restore");
  const entriesBefore = manager.getEntries();
  const oldIds = new Set(entriesBefore.map((entry: { id: string }) => entry.id));
  let fullReads = 0, oldLookups = 0, lookups = 0;
  const readAll = manager.getEntries.bind(manager), readOne = manager.getEntry.bind(manager);
  t.mock.method(manager, "getEntries", () => { fullReads++; return readAll(); });
  t.mock.method(manager, "getEntry", (id: string) => { lookups++; if (oldIds.has(id)) oldLookups++; return readOne(id); });
  for (let index = 0; index < 12; index++) {
    const id = `new-${index}`;
    await receiver.send(id, { text: `passive ${index}`, delivery: "passive" });
    await waitFor(() => receiver.events.some((event) => event.type === "sdk.message_end" && event.id === id), "native passive receipt");
  }
  t.diagnostic(`1,024 historical receipts; 12 passive deliveries; full history reads: ${fullReads}; old entry lookups: ${oldLookups}; total lookups: ${lookups}.`);
  assert.equal(fullReads, 0, "steady inbound reconciliation must not load the old entry list");
  assert.ok(oldLookups <= 1, "the receipt cursor must stop at the already visited boundary");
  assert.equal(receiver.faux.state.callCount, 0, "passive receipts must not wake the model");
  t.mock.restoreAll();
  assert.match(await receiver.status(), /Pending inbound messages: 0/);

  await receiver.session.navigateTree(branchPoint, { summarize: false });
  await receiver.send("after-branch", { text: "passive on another branch", delivery: "passive" });
  await waitFor(() => receiver.visible("after-branch").length === 1, "branched passive receipt");
  await receiver.session.reload();
  assert.match(await receiver.status(), /Pending inbound messages: 0/);
  for (const id of receiver.sends) assert.equal(receiver.visible(id).length, 1, id);
  // This is receipt indexing, not a new explicit-message-ID deduplication policy.
  await receiver.send("after-branch", { text: "explicit same-ID send remains a second send", delivery: "passive" });
  await waitFor(() => receiver.visible("after-branch").length === 2, "unchanged explicit same-ID behavior");
  assert.equal(receiver.faux.state.callCount, 0);
  assert.deepEqual(receiver.errors, []);
});

test("native idle send is visible once and passive delivery does not start a turn", async (t) => {
  const receiver = await makeSession(t, "normal");
  receiver.faux.setResponses([fauxAssistantMessage("Done")]);
  await receiver.send("only");
  await waitFor(() => receiver.settled() === 1, "normal settlement");
  await receiver.send("passive", { text: "breadcrumb", delivery: "passive" });
  await waitFor(() => receiver.visible("passive").length === 1, "passive append");
  assert.equal(receiver.visible("only").length, 1);
  assert.equal(receiver.faux.state.callCount, 1);
  assert.match(await receiver.status(), /Pending inbound messages: 0/);
  assert.deepEqual(receiver.errors, []);
  t.diagnostic("2 one-time sends; 2 visible messages; 1 provider call; no passive wakeup.");
});

test("native steer reaches the next tool boundary, queue waits, and busy passive stays passive", async (t) => {
  const toolGate = gate(t);
  let toolStarted = false;
  const seen: string[] = [];
  const receiver = await makeSession(t, "delivery-modes", { hasUI: true, configure(pi) {
    pi.registerTool({ name: "hold", label: "Hold", description: "Fixture gate", parameters: Type.Object({}), async execute() {
      toolStarted = true;
      await toolGate.promise;
      return { content: [{ type: "text", text: "released" }], details: {} };
    } });
  } });
  receiver.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
    (context: unknown) => { seen.push(JSON.stringify(context)); return fauxAssistantMessage("Current work done"); },
    (context: unknown) => { seen.push(JSON.stringify(context)); return fauxAssistantMessage("Queued work done"); },
  ]);
  const running = receiver.session.prompt("Start work");
  await waitFor(() => toolStarted, "native tool execution");
  await receiver.send("steer");
  await receiver.send("queued", { text: "message:queued", delivery: "queue" });
  await receiver.send("passive", { text: "message:passive", delivery: "passive" });
  await waitFor(async () => (await receiver.status()).includes("Pending inbound messages: 3"), "all inbound messages");
  toolGate.resolve();
  await running;
  await waitFor(() => receiver.visible("passive").length === 1, "idle passive flush");
  assert.match(seen[0]!, /message:steer/);
  assert.doesNotMatch(seen[0]!, /message:queued|message:passive/);
  assert.match(seen[1]!, /message:queued/);
  assert.doesNotMatch(seen[1]!, /message:passive/);
  for (const id of receiver.sends) assert.equal(receiver.visible(id).length, 1, id);
  assert.equal(receiver.faux.state.callCount, 3);
  assert.equal(receiver.settled(), 1);
  assert.deepEqual(receiver.errors, []);
  t.diagnostic("steer before next response; follow-up after current work; 3 visible once; no replay/passive turn.");
});

for (const count of [2, 101]) test(`native clearQueue plus abort recovers ${count} messages once without replaying appended followers`, async (t) => {
  const responseGate = gate(t);
  const receiver = await makeSession(t, `cleared-abort-${count}`);
  receiver.faux.setResponses([
    async () => { await responseGate.promise; return fauxAssistantMessage("Cancelled response"); },
    fauxAssistantMessage("Recovered all messages"),
  ]);
  const running = receiver.session.prompt("Start abortable work");
  await waitFor(() => receiver.faux.state.callCount === 1, "active provider request");
  for (let index = 0; index < count; index++) await receiver.send(`cleared-${index}`);
  await waitFor(async () => (await receiver.status()).includes(`Pending inbound messages: ${count}`), "native handoffs");
  assert.equal(receiver.session.agent.hasQueuedMessages(), true);
  await receiver.session.sendCustomMessage({ customType: "fixture-aside", content: "Next user prompt only", display: false }, { deliverAs: "nextTurn" });
  receiver.session.clearQueue();
  assert.equal(receiver.context().hasPendingMessages(), false, "a nextTurn aside must not block cleared-message recovery");
  receiver.session.agent.abort();
  responseGate.resolve();
  await running;
  await waitFor(() => receiver.settled() >= 2 && receiver.session.isIdle, "recovery settlement");
  for (const id of receiver.sends) assert.equal(receiver.visible(id).length, 1, id);
  assert.equal(receiver.faux.state.callCount, 2);
  assert.equal(receiver.settled(), 2);
  assert.match(await receiver.status(), /Pending inbound messages: 0/);
  assert.deepEqual(receiver.errors, []);
  t.diagnostic(`${count} sends, ${count} visible once; 1 aborted request + 1 recovery request; appended batch followers are not replayed.`);
});

test("native ordinary steer bursts do not retain unanswered attention handshakes", async (t) => {
  const responseGate = gate(t);
  let active = 0, peak = 0;
  const eventBus = createEventBus(), original = eventBus.on;
  eventBus.on = (channel, handler) => {
    if (channel !== "pi-intercom:detach-response") return original(channel, handler);
    active++; peak = Math.max(peak, active);
    const unsubscribe = original(channel, handler); let subscribed = true;
    return () => { if (subscribed) { active--; subscribed = false; } unsubscribe(); };
  };
  const receiver = await makeSession(t, "attention-burst", { eventBus });
  receiver.faux.setResponses([async () => { await responseGate.promise; return fauxAssistantMessage("First response"); }, fauxAssistantMessage("Directions handled")]);
  const running = receiver.session.prompt("Hold while ordinary steers arrive");
  try {
    await waitFor(() => receiver.faux.state.callCount === 1, "held provider");
    for (let index = 0; index < 12; index++) await receiver.send(`burst-${index}`);
    await waitFor(async () => (await receiver.status()).includes("Pending inbound messages: 12"), "all native handoffs");
    const retained = active;
    await sleep(550);
    receiver.events.push({ type: "fixture.attention-handshakes", peak, retained, afterTimeout: active });
    t.diagnostic(`Attention response listeners: peak=${peak}, after handoff=${retained}, after timeout=${active}.`);
    assert.equal(retained, 0, "without an owned wait, ordinary attention needs no outstanding response listener");
  } finally { responseGate.resolve(); await running; }
  for (const id of receiver.sends) assert.equal(receiver.visible(id).length, 1);
  assert.deepEqual(receiver.errors, []);
});

test("native abort retaining custom queues does not enqueue a second copy", async (t) => {
  const responseGate = gate(t);
  const receiver = await makeSession(t, "retained-abort");
  receiver.faux.setResponses([
    async () => { await responseGate.promise; return fauxAssistantMessage("Cancelled response"); },
    fauxAssistantMessage("Steered work"),
    fauxAssistantMessage("Follow-up work"),
  ]);
  const running = receiver.session.prompt("Start abortable work");
  await waitFor(() => receiver.faux.state.callCount === 1, "active provider request");
  await receiver.send("retained-steer");
  await receiver.send("retained-queue", { text: "retained follow-up", delivery: "queue" });
  await waitFor(async () => (await receiver.status()).includes("Pending inbound messages: 2"), "native custom queues");
  assert.equal(receiver.session.agent.hasQueuedMessages(), true);
  assert.equal(receiver.context().hasPendingMessages(), true, "Pi must expose pending custom steer/follow-up work, not only UI text queues");
  receiver.session.agent.abort();
  responseGate.resolve();
  await running;
  await sleep(30);
  assert.equal(receiver.faux.state.callCount, 1);
  assert.equal(receiver.session.agent.hasQueuedMessages(), true);
  await receiver.session.reload();
  assert.equal(receiver.context().hasPendingMessages(), true);
  await receiver.session.prompt("Resume retained work");
  for (const id of receiver.sends) assert.equal(receiver.visible(id).length, 1, id);
  assert.equal(receiver.faux.state.callCount, 3);
  assert.match(await receiver.status(), /Pending inbound messages: 0/);
  assert.deepEqual(receiver.errors, []);
  t.diagnostic("retained native queues survive reload; next prompt delivers both once, without a recovery-only turn.");
});

test("native idle multi-ask batch keeps the selected first ask as the default reply target", async (t) => {
  const hold = gate(t);
  let started = false;
  const receiver = await makeSession(t, "ask-batch-priority", { hasUI: true, configure(pi) {
    pi.registerTool({ name: "hold", label: "Hold", description: "Fixture gate", parameters: Type.Object({}), async execute() {
      started = true;
      await hold.promise;
      return { content: [{ type: "text", text: "Released" }], details: {} };
    } });
  } });
  const replies: string[] = [];
  receiver.sender.on("message", (_from, message) => { if (message.replyTo) replies.push(message.replyTo); });
  receiver.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("Current work finished"),
    fauxAssistantMessage(fauxToolCall("intercom", { action: "reply", message: "Answer the selected first ask" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Answer sent"),
  ]);
  const running = receiver.session.prompt("Hold before the ask batch");
  await waitFor(() => started, "busy native tool");
  for (const id of ["first-ask", "second-ask"]) {
    await receiver.send(id, { text: `Question ${id}`, expectsReply: true });
    await waitFor(async () => (await receiver.status()).includes(`Question ${id}`), "staged ask");
  }
  hold.resolve();
  await running;
  await waitFor(() => receiver.settled() === 2 && receiver.session.isIdle && replies.length === 1, "default reply delivery");
  assert.deepEqual(replies, ["first-ask"], "trigger-last must not switch the implicit reply to a follower ask");
  const intercom = receiver.session.agent.state.tools.find((tool: { name: string }) => tool.name === "intercom");
  const pending = await intercom.execute("remaining-ask", { action: "pending" }, new AbortController().signal);
  assert.match(JSON.stringify(pending), /second-ask/);
  assert.doesNotMatch(JSON.stringify(pending), /first-ask/);
  for (const id of receiver.sends) assert.equal(receiver.visible(id).length, 1, id);
  assert.equal(receiver.faux.state.callCount, 4);
  assert.match(await receiver.status(), /Pending inbound messages: 0/);
  assert.deepEqual(receiver.errors, []);
  receiver.events.push({ type: "fixture.default_reply", replies });
  t.diagnostic("Two queued asks append once in one delivery run; the real intercom reply tool targets the originally selected first ask.");
});

test("native rejected input leaves the active intercom run and idle wait intact", async (t) => {
  const inputRelease = gate(t);
  const responseRelease = gate(t);
  const losingInput = "User input held before admission";
  const preflight: boolean[] = [];
  let inputHeld = false, beforeStarts = 0, seen = "";
  const receiver = await makeSession(t, "input-rejection", { configure(pi) {
    pi.on("input", async (event) => {
      if (event.text === losingInput) { inputHeld = true; await inputRelease.promise; }
    });
    pi.on("before_agent_start", () => { beforeStarts++; });
  } });
  receiver.faux.setResponses([async (context: unknown) => {
    seen = JSON.stringify(context);
    await responseRelease.promise;
    return fauxAssistantMessage("Owned intercom work finished");
  }]);
  const rejected = assert.rejects(receiver.session.prompt(losingInput, { preflightResult: (accepted: boolean) => preflight.push(accepted) }), /already processing/);
  try {
    await waitFor(() => inputHeld, "held input interception");
    await receiver.send("input-owner");
    await waitFor(() => receiver.faux.state.callCount === 1, "custom-owned provider request");
    const signal = receiver.context().signal;
    const systemPrompt = receiver.session.systemPrompt;
    assert.ok(signal && !signal.aborted);
    let idleResolved = false;
    const idle = receiver.session.waitForIdle().then(() => { idleResolved = true; });
    inputRelease.resolve();
    await rejected;
    receiver.events.push({ type: "fixture.input_rejection", preflight: [...preflight], beforeStarts, idle: receiver.session.isIdle, streaming: receiver.session.isStreaming, signalUnchanged: receiver.context().signal === signal, idleResolved, settled: receiver.settled() });
    assert.deepEqual(preflight, [false]);
    assert.equal(receiver.context().signal, signal);
    assert.equal(signal.aborted, false);
    assert.equal(receiver.session.systemPrompt, systemPrompt);
    assert.equal(receiver.session.isStreaming, true);
    assert.equal(receiver.context().isIdle(), false);
    assert.equal(idleResolved, false, "a rejected input cannot release the owning run's idle waiter");
    assert.equal(receiver.settled(), 0);
    assert.equal(beforeStarts, 1, "rejected admission must not prepare receiver replay");
    assert.equal(receiver.faux.state.callCount, 1);
    assert.equal(receiver.visible("input-owner").length, 1);
    responseRelease.resolve();
    await idle;
    assert.equal(idleResolved, true);
    assert.equal(receiver.settled(), 1);
    assert.equal(receiver.context().isIdle(), true);
    assert.equal(receiver.context().signal, undefined);
    assert.equal(receiver.context().hasPendingMessages(), false);
    assert.equal(beforeStarts, 1);
    assert.equal(receiver.faux.state.callCount, 1);
    assert.equal(receiver.visible("input-owner").length, 1);
    assert.equal(seen.split("message:input-owner").length - 1, 1);
    assert.doesNotMatch(seen, /User input held before admission/);
    assert.deepEqual(preflight, [false]);
    assert.deepEqual(receiver.events.filter((event) => event.type === "extension.message_end" && event.role === "assistant").map((event) => event.stopReason), ["stop"]);
    assert.match(await receiver.status(), /Pending inbound messages: 0/);
    assert.deepEqual(receiver.errors, []);
    receiver.events.push({ type: "fixture.input_complete", providerContext: seen, idleResolved, settled: receiver.settled() });
    t.diagnostic("Real losing input rejects once; the original custom signal, busy state and idle wait survive; one visible custom receipt, one clean provider call and one true settlement.");
  } finally {
    inputRelease.resolve();
    responseRelease.resolve();
    await Promise.allSettled([rejected, receiver.session.agent.waitForIdle()]);
  }
});

test("native user preparation queues intercom without another startup or provider turn", async (t) => {
  const startupRelease = gate(t);
  const userPrompt = "User startup held before the agent runs";
  let beforeStarts = 0, seen = "";
  const receiver = await makeSession(t, "startup-queued", { configure(pi) {
    pi.on("before_agent_start", async (event) => {
      beforeStarts++;
      if (event.prompt === userPrompt) await startupRelease.promise;
    });
  } });
  receiver.faux.setResponses([(context: unknown) => { seen = JSON.stringify(context); return fauxAssistantMessage("Both inputs handled"); }]);
  const running = receiver.session.prompt(userPrompt);
  try {
    await waitFor(() => beforeStarts === 1, "held user preparation");
    receiver.events.push({ type: "fixture.user_preparation", idle: receiver.context().isIdle(), streaming: receiver.session.isStreaming, beforeStarts, providerCalls: receiver.faux.state.callCount });
    assert.equal(receiver.context().isIdle(), false, "admitted user preparation must already be busy");
    assert.equal(receiver.session.isStreaming, true);
    assert.equal(receiver.faux.state.callCount, 0);
    await receiver.send("startup-queued");
    await waitFor(() => receiver.context().hasPendingMessages(), "native queued custom message");
    assert.equal(beforeStarts, 1, "the queued custom message must not start another preflight");
    assert.equal(receiver.faux.state.callCount, 0);
    assert.equal(receiver.visible("startup-queued").length, 0);
    assert.equal(receiver.settled(), 0);
    receiver.events.push({ type: "fixture.startup_queue", nativeQueued: receiver.context().hasPendingMessages(), beforeStarts, settled: receiver.settled() });
    startupRelease.resolve();
    await running;
    await receiver.session.waitForIdle();
    assert.equal(beforeStarts, 1);
    assert.equal(receiver.faux.state.callCount, 1);
    assert.equal(receiver.settled(), 1);
    assert.equal(receiver.visible("startup-queued").length, 1);
    const users = receiver.session.sessionManager.getEntries().filter((entry: { type: string; message?: { role: string; content: unknown } }) => entry.type === "message" && entry.message?.role === "user" && JSON.stringify(entry.message.content).includes(userPrompt));
    assert.equal(users.length, 1);
    for (const body of [userPrompt, "message:startup-queued"]) assert.equal(seen.split(body).length - 1, 1, body);
    assert.equal(receiver.context().isIdle(), true);
    assert.equal(receiver.context().signal, undefined);
    assert.equal(receiver.context().hasPendingMessages(), false);
    assert.deepEqual(receiver.events.filter((event) => event.type === "extension.message_end" && event.role === "assistant").map((event) => event.stopReason), ["stop"]);
    assert.match(await receiver.status(), /Pending inbound messages: 0/);
    assert.deepEqual(receiver.errors, []);
    receiver.events.push({ type: "fixture.startup_complete", providerContext: seen, settled: receiver.settled() });
    t.diagnostic("Busy user preparation queues the real intercom send; both accepted inputs reach one provider request and history once, with one startup and one true settlement.");
  } finally {
    startupRelease.resolve();
    await running;
  }
});

test("native context reset, compaction, and reload preserve receipts without replaying consumed messages", async (t) => {
  const originalResponse = gate(t);
  const recoveryResponse = gate(t);
  const receiver = await makeSession(t, "compact-reload");
  receiver.faux.setResponses([
    async () => { await originalResponse.promise; return fauxAssistantMessage("Aborted"); },
    async () => { await recoveryResponse.promise; return fauxAssistantMessage("Handled"); },
    fauxAssistantMessage("Fresh window"),
    fauxAssistantMessage("Continued"),
  ]);
  const running = receiver.session.prompt("Start abortable work");
  await waitFor(() => receiver.faux.state.callCount === 1, "original provider request");
  await receiver.send("trigger");
  await receiver.send("appended-follower");
  await waitFor(async () => (await receiver.status()).includes("Pending inbound messages: 2"), "two native handoffs");
  receiver.session.clearQueue();
  receiver.session.agent.abort();
  originalResponse.resolve();
  await running;
  await waitFor(() => receiver.faux.state.callCount === 2, "recovery provider request");
  receiver.session.newContext({ handoff: "The intercom messages were handled." });
  recoveryResponse.resolve();
  await waitFor(() => receiver.settled() >= 2 && receiver.session.isIdle, "fresh context boundary");
  assert.equal(receiver.session.messages.some((message: unknown) => inboundId(message) === "appended-follower"), false);
  assert.equal(receiver.visible("appended-follower").length, 1);
  assert.equal(receiver.events.filter((event) => event.type === "extension.message_end" && event.id === "appended-follower").length, 0);
  assert.match(await receiver.status(), /Pending inbound messages: 0/);

  await receiver.session.prompt("Continue in the fresh window");
  await receiver.session.compact();
  assert.ok(receiver.session.sessionManager.getEntries().some((entry: { type: string }) => entry.type === "compaction"));
  await receiver.session.reload();
  assert.equal(receiver.events.filter((event) => event.type === "extension.session_start" && event.reason === "reload").length, 1);
  await receiver.session.prompt("Continue after reload");
  for (const id of receiver.sends) assert.equal(receiver.visible(id).length, 1, id);
  assert.equal(receiver.faux.state.callCount, 4);
  assert.match(await receiver.status(), /Pending inbound messages: 0/);
  assert.deepEqual(receiver.errors, []);
  t.diagnostic("unacknowledged appended follower is removed from active context before settlement, retained once in full history; actual compact/reload never replays it.");
});

test("native supervisor question survives reload and consumes the saved answer once", async (t) => {
  const supervisor = await makeSession(t, "question-supervisor");
  supervisor.faux.setResponses([fauxAssistantMessage("Question received")]);
  const runId = "native-question-run";
  const ownerId = supervisor.session.sessionManager.getSessionId();
  saveQuestionOwner(runId, ownerId);
  const child = await makeSession(t, "question-child", { child: { runId, supervisor: "question-supervisor" } });
  child.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("contact_supervisor", { reason: "need_decision", message: "Which path should I use?" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Saved answer applied"),
  ]);
  const running = child.session.prompt("Ask the supervisor");
  await waitFor(() => listSupervisorQuestions(ownerId, runId).length === 1 && supervisor.settled() === 1, "durable native question");
  const question = listSupervisorQuestions(ownerId, runId)[0]!;
  await supervisor.session.reload();
  assert.equal(child.session.isStreaming, true);
  saveQuestionAnswer(question, "Use the saved native receipt.");
  await running;
  const state = readQuestionState(question);
  assert.equal(state.state, "answered");
  assert.equal(state.delivery?.kind, "live");
  assert.equal(supervisor.visible(question.questionId).length, 1);
  assert.equal(child.faux.state.callCount, 2);
  assert.equal(supervisor.faux.state.callCount, 1);
  assert.match(JSON.stringify(child.session.messages), /Use the saved native receipt/);
  assert.deepEqual([...child.errors, ...supervisor.errors], []);
  t.diagnostic("real contact_supervisor tool wait; supervisor reload; durable answer consumed by live child once; no notification replay.");
});

test("native agent_runs answer clears the parent's intercom pending asks and presence", async (t) => {
  const supervisor = await makeSession(t, "answer-supervisor", { subagents: true });
  const runId = "native-answer-presence";
  const ownerId = supervisor.session.sessionManager.getSessionId();
  saveQuestionOwner(runId, ownerId);
  supervisor.faux.setResponses([
    fauxAssistantMessage("Question received"),
    () => fauxAssistantMessage(fauxToolCall("agent_runs", {
      action: "answer", id: runId,
      questionId: listSupervisorQuestions(ownerId, runId)[0]!.questionId,
      message: "Use the native path.",
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Answer saved"),
  ]);
  const child = await makeSession(t, "answer-child", { child: { runId, supervisor: "answer-supervisor" } });
  child.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("contact_supervisor", { reason: "need_decision", message: "Which path?" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Continuing with the answer"),
  ]);
  const running = child.session.prompt("Ask the supervisor");
  const presence = async () => (await supervisor.sender.listSessions()).find((peer) => peer.name === "answer-supervisor");
  await waitFor(async () => supervisor.settled() === 1 && (await presence())?.pendingAsks === 1, "one unresolved supervisor ask");
  await supervisor.session.prompt("Answer the question");
  await running;
  assert.equal(listSupervisorQuestions(ownerId, runId)[0]?.state, "answered");
  assert.equal((await presence())?.pendingAsks, 0, "saved answers must clear live intercom ask presence too");
  const intercom = supervisor.session.agent.state.tools.find((tool: { name: string }) => tool.name === "intercom");
  const pending = await intercom.execute("fixture-pending", { action: "pending" }, new AbortController().signal);
  assert.match(JSON.stringify(pending), /No unresolved inbound asks/);
  assert.deepEqual([...child.errors, ...supervisor.errors], []);
  t.diagnostic("actual agent_runs answer + durable child delivery leave no unresolved intercom ask or stale presence count.");
});

test("native supervisor ask releases a controlled busy tool and reaches the model before the reply", async (t) => {
  const foregroundWait = gate(t);
  let busy = false;
  let detachRequests = 0;
  let checkpointBeforeDetach = false;
  let modelSawQuestion = false;
  const supervisor = await makeSession(t, "busy-supervisor", { hasUI: true, configure(pi) {
    pi.registerTool({ name: "foreground_wait", label: "Foreground Wait", description: "Controlled foreground wait", parameters: Type.Object({}), async execute() {
      busy = true;
      await foregroundWait.promise;
      return { content: [{ type: "text", text: "Released to answer the child" }], details: {} };
    } });
    pi.events.on("pi-intercom:detach-request", (payload) => {
      detachRequests++;
      checkpointBeforeDetach = JSON.stringify(supervisor.session.sessionManager.getEntries()).includes("Choose the native path?");
      foregroundWait.resolve();
      pi.events.emit("pi-intercom:detach-response", { ...(payload as { requestId: string }), accepted: true });
    });
  } });
  supervisor.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("foreground_wait", {}), { stopReason: "toolUse" }),
    (context: unknown) => {
      modelSawQuestion = JSON.stringify(context).includes("Choose the native path?");
      return fauxAssistantMessage(fauxToolCall("intercom", { action: "reply", message: "Use the native path." }), { stopReason: "toolUse" });
    },
    fauxAssistantMessage("Parent continued"),
  ]);
  const parentRun = supervisor.session.prompt("Wait for child work");
  await waitFor(() => busy, "native parent tool wait");
  const runId = "native-busy-question";
  const ownerId = supervisor.session.sessionManager.getSessionId();
  saveQuestionOwner(runId, ownerId);
  const child = await makeSession(t, "busy-question-child", { child: { runId, supervisor: "busy-supervisor" } });
  child.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("contact_supervisor", { reason: "need_decision", message: "Choose the native path?" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Child continued"),
  ]);
  const childRun = child.session.prompt("Ask before continuing");
  await waitFor(() => modelSawQuestion, "model-visible blocking question, not only saved state");
  await Promise.all([parentRun, childRun]);
  const question = listSupervisorQuestions(ownerId, runId)[0]!;
  assert.equal(detachRequests, 1);
  assert.equal(checkpointBeforeDetach, true, "persist the blocking notification before awaiting foreground detachment");
  assert.equal(supervisor.visible(question.questionId).length, 1);
  assert.equal(question.state, "answered");
  assert.equal(supervisor.faux.state.callCount, 3);
  assert.equal(child.faux.state.callCount, 2);
  assert.deepEqual([...child.errors, ...supervisor.errors], []);
  t.diagnostic("actual native tool boundary + intercom detach handshake; parent provider sees the blocking question once and replies before child continues.");
});

function restartFixture(t: TestContext, mode: string, directory: string, sessionFile?: string) {
  const child = spawn(process.execPath, [path.join(repo, "test/fixtures/pi-intercom-native-resume.mjs"), mode, directory, ...(sessionFile ? [sessionFile] : [])], {
    cwd: root,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE,
      TMPDIR: tmpdir(),
      PI_CODING_AGENT_DIR: agentDir, PI_SUBAGENT_TEMP_ROOT: process.env.PI_SUBAGENT_TEMP_ROOT,
      PI_OFFLINE: "1", JITI_FS_CACHE: path.join(root, "jiti-child"),
      PI_INTERCOM_TEST_SDK: process.env.PI_INTERCOM_TEST_SDK,
      PI_INTERCOM_TEST_EXTENSION: process.env.PI_INTERCOM_TEST_EXTENSION,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  const messages: unknown[] = [];
  child.on("message", (message) => messages.push(message));
  assert.ok(child.stdout && child.stderr);
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exited = once(child, "exit");
  const result = once(child, "message", { signal: AbortSignal.timeout(8_000) });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    if (evidenceDir) writeFileSync(path.join(root, `${path.basename(directory)}-${mode}.json`), JSON.stringify({ messages, output }, null, 2));
  });
  return { child, result, exited };
}

test("fresh native processes resume pending messages once without fork/new-session adoption", async (t) => {
  const sender = new IntercomClient();
  await sender.connect({ name: "restart-sender", cwd: root, model: "fixture" });
  t.after(() => sender.disconnect());
  const seed = restartFixture(t, "seed", path.join(root, "restart-seed"));
  const [ready] = await seed.result;
  assert.equal(ready.type, "ready");
  for (const message of [
    { messageId: "native-steer", text: "native steering handoff" },
    { messageId: "native-followup", text: "native follow-up handoff", delivery: "queue" as const },
    { messageId: "old-milestone", text: "obsolete progress", delivery: "queue" as const, queueMode: "replace" as const, threadId: "restart-milestone" },
    { messageId: "latest-milestone", text: "latest material progress", delivery: "queue" as const, queueMode: "replace" as const, threadId: "restart-milestone" },
    { messageId: "passive", text: "passive breadcrumb", delivery: "passive" as const },
  ]) assert.equal((await sender.send("restart-parent", message)).accepted, true);
  const snapshotPromise = once(seed.child, "message", { signal: AbortSignal.timeout(5_000) });
  seed.child.send({ action: "snapshot" });
  const [snapshot] = await snapshotPromise;
  assert.equal(snapshot.nativeQueued, true);
  assert.equal(snapshot.publicPending, true);
  assert.match(snapshot.status, /Pending inbound messages: 4/);
  assert.deepEqual(snapshot.visibleIds, []);
  const saved = readFileSync(ready.sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  seed.child.kill("SIGKILL");
  await seed.exited;

  let forkCheckpointOwners: string[] = [];
  for (const mode of ["fork", "new"]) {
    const fresh = restartFixture(t, mode, path.join(root, `restart-${mode}`), ready.sessionFile);
    const [result] = await fresh.result;
    await fresh.exited;
    assert.notEqual(result.sessionId, ready.sessionId);
    assert.equal(result.modelCalls, 0, `${mode} must not adopt another session's pending messages`);
    assert.deepEqual(result.visibleIds, []);
    assert.match(result.status, /Pending inbound messages: 0/);
    if (mode === "fork") forkCheckpointOwners = result.checkpointOwners;
    assert.deepEqual(result.errors, []);
  }

  for (const attempt of [1, 2]) {
    const resumed = restartFixture(t, "resume", path.join(root, `restart-resume-${attempt}`), ready.sessionFile);
    const [result] = await resumed.result;
    await resumed.exited;
    assert.equal(result.sessionId, ready.sessionId);
    assert.equal(result.modelCalls, attempt === 1 ? 1 : 0, "only the first resume needs a delivery turn");
    assert.deepEqual(result.visibleIds.sort(), ["latest-milestone", "native-followup", "native-steer", "passive"]);
    assert.match(result.status, /Pending inbound messages: 0/);
    assert.deepEqual(result.errors, []);
  }
  assert.deepEqual(forkCheckpointOwners, [ready.sessionId]);
  assert.equal(saved.filter((entry) => entry.type === "custom" && entry.customType === "intercom_delivery" && entry.data.entry).length, 5, "each received body is checkpointed once before process loss");

  const passiveSeed = restartFixture(t, "seed", path.join(root, "restart-passive-seed"));
  const [passiveReady] = await passiveSeed.result;
  assert.equal((await sender.send("restart-parent", { messageId: "passive-only", text: "Do not wake the model", delivery: "passive" })).accepted, true);
  const passiveSnapshot = once(passiveSeed.child, "message", { signal: AbortSignal.timeout(5_000) });
  passiveSeed.child.send({ action: "snapshot" });
  assert.match((await passiveSnapshot)[0].status, /Pending inbound messages: 1/);
  passiveSeed.child.kill("SIGKILL");
  await passiveSeed.exited;
  const passiveResume = restartFixture(t, "resume", path.join(root, "restart-passive-resume"), passiveReady.sessionFile);
  const [passiveResult] = await passiveResume.result;
  await passiveResume.exited;
  assert.equal(passiveResult.modelCalls, 0);
  assert.deepEqual(passiveResult.visibleIds, ["passive-only"]);
  assert.deepEqual(passiveResult.errors, []);
  t.diagnostic("hard-killed host restores 2 native-queued + 2 staged messages once in 1 turn; second resume/fork/new/passive-only restore run 0 turns; superseded progress stays absent.");
});

for (const background of [false, true]) for (const scenario of ["question", "tool"] as const) test(`native ${background ? "background" : "foreground"} attention uses observed ${scenario} state and still finishes normally`, async (t) => {
  const name = `attention-${background ? "bg" : "fg"}-${scenario}`;
  let api: ExtensionAPI;
  const parent = await makeSession(t, name, { configure(pi) { api = pi; } });
  parent.faux.setResponses([fauxAssistantMessage("Synthetic question or attention noted"), ...(scenario === "question" ? [fauxAssistantMessage("Synthetic supervisor wait noted")] : [])]);
  const owner = parent.session.sessionManager.getSessionId();
  const directory = path.join(root, `${name}-child`), bin = path.join(directory, "bin"), release = path.join(directory, "release");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "pi"), `#!/bin/sh\nexec "${process.execPath}" "${path.join(repo, "test/fixtures/native-feedback-child.mjs")}" "$@"\n`, { mode: 0o700 });
  const savedEnv = { PATH: process.env.PATH, PI_FEEDBACK_RELEASE_FILE: process.env.PI_FEEDBACK_RELEASE_FILE, PI_FEEDBACK_SCENARIO: process.env.PI_FEEDBACK_SCENARIO };
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  process.env.PI_FEEDBACK_RELEASE_FILE = release;
  process.env.PI_FEEDBACK_SCENARIO = scenario;
  saveQuestionOwner(name, owner);
  const controlConfig = resolveControlConfig({ needsAttentionAfterMs: 300 });
  const agent = makeAgent("worker", { model: "feedback-fixture/faux-1", extensions: [], output: false });
  const notices: Array<{ event: import("../../src/shared/types.ts").ControlEvent; noticeText?: string }> = [];
  let asyncDir: string | undefined, pending: Promise<unknown> | undefined;
  t.after(async () => {
    writeFileSync(release, "released");
    for (const question of listSupervisorQuestions(owner, name)) if (question.state === "awaiting_input") saveQuestionAnswer(question, "Use the synthetic native path.");
    await pending;
    for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
  if (background) {
    const started = executeAsyncSingle(name, { agent: "worker", task: "Synthetic attention check", agentConfig: agent,
      ctx: { pi: api!, cwd: directory, currentSessionId: owner }, sessionFile: path.join(directory, "session.jsonl"), shareEnabled: false, maxSubagentDepth: 1,
      controlConfig, controlIntercomTarget: name, childIntercomTarget: () => `${name}-child` });
    assert.ok(!started.isError, started.content[0]?.text);
    asyncDir = started.details.asyncDir!;
    // The durable runner status is also the cleanup receipt for this synthetic child.
    pending = (async () => {
      await waitFor(() => existsSync(path.join(asyncDir!, "status.json")) && JSON.parse(readFileSync(path.join(asyncDir!, "status.json"), "utf8")).state !== "running", "async child completion");
      const status = JSON.parse(readFileSync(path.join(asyncDir!, "status.json"), "utf8"));
      assert.equal(status.state, "complete");
      await waitFor(() => !questionProcessAlive({ pid: status.pid }), "private runner exit");
      return status;
    })();
  } else {
    pending = runSync(directory, [agent], "worker", "Synthetic attention check", { runId: name, sessionFile: path.join(directory, "session.jsonl"), index: 0,
      controlConfig, orchestratorIntercomTarget: name, intercomSessionName: `${name}-child`, onControlEvent: (event) => notices.push({ event, noticeText: formatControlNoticeMessage(event, `${name}-child`) }) });
  }
  const childReceipt = () => JSON.parse(readFileSync(`${release}.json`, "utf8"));
  await waitFor(() => existsSync(`${release}.json`) && childReceipt().events.some((event: { type: string }) => event.type === "tool_execution_start"), "real native child tool start");
  const toolStartedAt = childReceipt().events.find((event: { type: string }) => event.type === "tool_execution_start").timestamp;
  if (scenario === "question") await waitFor(() => listSupervisorQuestions(owner, name)[0]?.state === "awaiting_input", "real durable contact_supervisor wait");
  const readNotices = () => background
    ? existsSync(path.join(asyncDir!, "events.jsonl")) ? readFileSync(path.join(asyncDir!, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((entry) => entry.type === "subagent.control") : []
    : notices;
  await waitFor(() => readNotices().some(({ event }) => event.ts > toolStartedAt + controlConfig.needsAttentionAfterMs), "runner idle producer event");
  const notice = readNotices().find(({ event }) => event.ts > toolStartedAt + controlConfig.needsAttentionAfterMs)!;
  const event = notice.event;
  const state = { foregroundControls: new Map([[name, { runId: name, mode: "single", startedAt: toolStartedAt, updatedAt: event.ts, currentAgent: "worker", currentIndex: 0, currentActivityState: "needs_attention" }]]) };
  handleSubagentControlNotice({ pi: api!, state, visibleControlNotices: new Set(), details: { ...notice, source: background ? "async" : "foreground", childIntercomTarget: `${name}-child` }, foregroundDelayMs: 0 });
  await waitFor(() => parent.session.sessionManager.getEntries().some((entry: { type: string; customType?: string }) => entry.type === "custom_message" && entry.customType === "subagent_control_notice"), "native attention custom message");
  const message = parent.session.sessionManager.getEntries().find((entry: { customType?: string }) => entry.customType === "subagent_control_notice");
  assert.equal(message.content, notice.noticeText);
  if (scenario === "question") {
    const question = listSupervisorQuestions(owner, name)[0]!;
    assert.match(message.content, /Waiting for supervisor input/);
    assert.ok(message.content.includes(question.questionId));
    assert.match(message.content, /agent_runs\(\{ action: "answer"/);
    assert.doesNotMatch(message.content, /waiting for user|What are you blocked on/i);
    saveQuestionAnswer(question, "Use the synthetic native path.");
  } else {
    assert.match(message.content, /bash still active for \d+s; no observed output\/events for \d+s/);
    assert.match(message.content, /Inspect command progress/);
    assert.doesNotMatch(message.content, /Waiting for supervisor input|timed out|making progress/);
    writeFileSync(release, "released");
  }
  assert.equal(event.currentTool, scenario === "question" ? "contact_supervisor" : "bash");
  assert.ok(event.currentToolDurationMs >= controlConfig.needsAttentionAfterMs);
  assert.ok(event.elapsedMs >= controlConfig.needsAttentionAfterMs);
  assert.match(message.content, /agent_runs\(\{ action: "inspect"/);
  assert.doesNotMatch(message.content, /subagent\(\{ action: "(?:status|nudge|interrupt)"/);
  await pending;
  assert.equal(childReceipt().modelCalls, 2);
  assert.equal(childReceipt().networkRequests, 0);
  assert.deepEqual(childReceipt().errors, []);
  if (scenario === "question") assert.equal(listSupervisorQuestions(owner, name)[0]?.state, "answered");
  await parent.session.waitForIdle();
  for (const message of parent.session.messages) if (message.role === "assistant") assert.equal(message.stopReason, "stop", message.errorMessage);
  assert.deepEqual(parent.errors, []);
  t.diagnostic(`Real native ${scenario} + ${background ? "async" : "foreground"} idle producer; observed tool/age and actionable notice, then normal completion (no 10-minute wait).`);
});

test("native obsolete completed-child progress stays in raw history without a late model wake", async (t) => {
  const hold = gate(t);
  let started = false, api: ExtensionAPI;
  const seen: string[] = [];
  const parent = await makeSession(t, "historical-busy", { hasUI: true, configure(pi) {
    api = pi;
    pi.registerTool({ name: "hold", label: "Hold", description: "Synthetic blocking parent tool", parameters: Type.Object({}), async execute() {
      started = true;
      await hold.promise;
      return { content: [{ type: "text", text: "Released" }], details: {} };
    } });
  } });
  parent.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
    (context: unknown) => { seen.push(JSON.stringify(context)); return fauxAssistantMessage("Result read"); },

  ]);
  const running = parent.session.prompt("Hold for synthetic child work");
  await waitFor(() => started, "native blocking parent tool");
  const threadId = "subagent-progress:historical-run:worker:0";
  const sentAt = Date.now() - 120_000;
  const now = Date.now;
  try {
    Date.now = () => sentAt;
    await parent.send("superseded-progress", { text: "Earlier milestone", delivery: "queue", queueMode: "replace", threadId });
    await parent.send("material-progress", { text: "Subagent progress update.\n\nFinishing the change.\nMATERIAL FINDING: preserve this complete body, even after acceptance.", delivery: "queue", queueMode: "replace", threadId });
  } finally { Date.now = now; }
  await waitFor(async () => (await parent.status()).includes("MATERIAL FINDING"), "staged progress");
  assert.equal(await deliverSubagentResultIntercomEvent(api!.events, buildSubagentResultIntercomPayload({
    to: "historical-busy", runId: "historical-run", mode: "single", source: "foreground", children: [
      { agent: "worker", index: 0, status: "completed", summary: "Final accepted result", intercomTarget: "sender-historical-busy" },
    ],
  })), true);
  hold.resolve();
  await running;
  await waitFor(() => parent.session.isIdle, "parent completion");
  await sleep(600);
  assert.equal(parent.visible("material-progress").length, 0);
  assert.equal(parent.visible("superseded-progress").length, 0);
  assert.equal(parent.faux.state.callCount, 2, "obsolete progress must not wake another turn");
  assert.match(seen[0]!, /Final accepted result/);
  assert.doesNotMatch(seen[0]!, /MATERIAL FINDING/);
  const checkpoints = parent.session.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "intercom_delivery");
  assert.ok(checkpoints.some((entry) => entry.data?.entry?.message?.id === "material-progress" && entry.data.entry.bodyText.includes("MATERIAL FINDING")), "original raw progress remains saved");
  assert.ok(checkpoints.some((entry) => entry.data?.messageId === "material-progress" && entry.data.stage === "discarded"));
  assert.deepEqual(parent.errors, []);
});

test("native broker-staged progress recovers terminal child identity across reload and sender disconnect", async (t) => {
  const hold = gate(t);
  let api: ExtensionAPI, started = false;
  const parent = await makeSession(t, "historical-reload", { hasUI: true, configure(pi) {
    api = pi;
    pi.registerTool({ name: "hold", label: "Hold", description: "Fixture gate", parameters: Type.Object({}), async execute() {
      started = true; await hold.promise; return { content: [{ type: "text", text: "Released" }], details: {} };
    } });
  } });
  parent.faux.setResponses([fauxAssistantMessage("Completion received"), fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }), fauxAssistantMessage("Independent work finished"), fauxAssistantMessage("Deferred finding read")]);
  const receipt = await parent.send("broker-delayed-progress", { text: "Finishing tests; material old warning retained", delivery: "queue", queueMode: "replace", threadId: "subagent-progress:reload-run:worker:0" });
  assert.equal(receipt.queued, true, "idle replace is staged by the real private broker");
  assert.equal(await deliverSubagentResultIntercomEvent(api!.events, buildSubagentResultIntercomPayload({
    to: "historical-reload", runId: "reload-run", mode: "parallel", source: "async", children: [
      { agent: "worker", index: 0, status: "completed", summary: "Work finished", intercomTarget: "sender-historical-reload" },
      { agent: "sibling", index: 1, status: "detached", summary: "Still alive", intercomTarget: "sender-historical-reload" },
    ],
  })), true);
  await waitFor(() => parent.settled() === 1, "completion before broker release");
  await parent.sender.disconnect();
  const running = parent.session.prompt("Independent work while progress is deferred");
  await waitFor(() => started, "second native blocking tool");
  await waitFor(() => parent.session.sessionManager.getEntries().some((entry) => entry.type === "custom" && entry.customType === "intercom_delivery" && entry.data?.messageId === "broker-delayed-progress" && entry.data.stage === "discarded"), "obsolete broker progress discarded before receiver reload");
  await parent.session.reload();
  hold.resolve();
  await running;
  await waitFor(() => parent.session.isIdle, "independent work after reload/disconnect");
  await sleep(600);
  assert.equal(parent.visible("broker-delayed-progress").length, 0);
  assert.equal(parent.faux.state.callCount, 3, "completion plus two independent-work responses; no obsolete progress wake");
  assert.deepEqual(parent.errors, []);
  t.diagnostic("Terminal association restored from the existing saved delivery/receipt metadata, with broker delay and no replay.");
});

test("native obsolete-progress suppression leaves detached, successor, unknown, wrong-sender, question and answer progress untouched", async (t) => {
  const hold = gate(t);
  let started = false, api: ExtensionAPI;
  const parent = await makeSession(t, "historical-boundaries", { hasUI: true, configure(pi) {
    api = pi;
    pi.registerTool({ name: "hold", label: "Hold", description: "Fixture gate", parameters: Type.Object({}), async execute() {
      started = true; await hold.promise; return { content: [{ type: "text", text: "Released" }], details: {} };
    } });
  } });
  parent.faux.setResponses([fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }), fauxAssistantMessage("Result read"), fauxAssistantMessage("Updates read")]);
  const running = parent.session.prompt("Hold");
  await waitFor(() => started, "blocking parent");
  const cases = [
    { id: "terminal", agent: "worker", index: 0 },
    { id: "detached", agent: "sibling", index: 1 },
    { id: "live-unreported", agent: "worker", index: 2 },
    { id: "successor", agent: "worker", index: 0, runId: "successor-run" },
    { id: "unknown", agent: "worker", index: 0, runId: "unknown-run" },
    { id: "ordinary-peer", agent: "worker", index: 0, threadId: "ordinary-peer-thread" },
    { id: "ask", agent: "asker", index: 3, expectsReply: true },
    { id: "answer", agent: "answerer", index: 4, replyTo: "old-question" },
  ];
  for (const item of cases) await parent.send(item.id, { text: `Subagent progress update. Finished? ${item.id}`, delivery: "queue", queueMode: "replace", threadId: item.threadId ?? `subagent-progress:${item.runId ?? "mixed-run"}:${item.agent}:${item.index}`, expectsReply: item.expectsReply, replyTo: item.replyTo });
  const stranger = new IntercomClient();
  t.after(() => stranger.disconnect());
  await stranger.connect({ name: "unrelated-peer", cwd: root, model: "fixture" });
  assert.equal((await stranger.send("historical-boundaries", { messageId: "wrong-sender", text: "Subagent progress update. Claimed completion", delivery: "queue", queueMode: "replace", threadId: "subagent-progress:mixed-run:worker:0" })).accepted, true);
  await waitFor(async () => { const status = await parent.status(); return status.includes("Claimed completion") && status.includes("Finished? ask"); }, "all messages staged, including the broker-delayed ask");
  assert.equal(await deliverSubagentResultIntercomEvent(api!.events, buildSubagentResultIntercomPayload({ to: "historical-boundaries", runId: "mixed-run", mode: "parallel", source: "foreground", children: [
    { agent: "worker", index: 0, status: "completed", summary: "One child finished", intercomTarget: "sender-historical-boundaries" },
    { agent: "sibling", index: 1, status: "detached", summary: "Another child remains live", intercomTarget: "sender-historical-boundaries" },
    { agent: "asker", index: 3, status: "completed", summary: "Question control", intercomTarget: "sender-historical-boundaries" },
    { agent: "answerer", index: 4, status: "completed", summary: "Answer control", intercomTarget: "sender-historical-boundaries" },
  ] })), true);
  hold.resolve();
  await running;
  await waitFor(() => cases.filter(({ id }) => id !== "terminal").every(({ id }) => parent.visible(id).length === 1) && parent.visible("wrong-sender").length === 1 && parent.session.isIdle, "all unrelated updates retained");
  assert.equal(parent.visible("terminal").length, 0);
  for (const id of [...cases.filter((item) => item.id !== "terminal").map((item) => item.id), "wrong-sender"]) assert.doesNotMatch(parent.visible(id)[0].content, /Historical\/deferred progress|Originally sent:/, id);
  assert.equal(parent.faux.state.callCount, 3);
  assert.deepEqual(parent.errors, []);
});

test("native contact_supervisor progress reaches the first tool boundary before the parent finishes", async (t) => {
  const firstGate = gate(t), secondGate = gate(t);
  let firstStarted = false, secondStarted = false, seenAtBoundary = "";
  const parent = await makeSession(t, "timely-progress-parent", { hasUI: true, configure(pi) {
    pi.registerTool({ name: "first_gate", label: "First gate", description: "Controlled first boundary", parameters: Type.Object({}), async execute() {
      firstStarted = true; await firstGate.promise; return { content: [{ type: "text", text: "First tool finished" }], details: {} };
    } });
    pi.registerTool({ name: "second_gate", label: "Second gate", description: "Keep parent work active", parameters: Type.Object({}), async execute() {
      secondStarted = true; await secondGate.promise; return { content: [{ type: "text", text: "Second tool finished" }], details: {} };
    } });
  } });
  const child = await makeSession(t, "timely-progress-child", { child: { runId: "timely-progress-run", supervisor: "timely-progress-parent" } });
  parent.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("first_gate", {}), { stopReason: "toolUse" }),
    (context) => { seenAtBoundary = JSON.stringify(context); return fauxAssistantMessage(fauxToolCall("second_gate", {}), { stopReason: "toolUse" }); },
    fauxAssistantMessage("Parent work completed"),
  ]);
  const running = parent.session.prompt("Work through both controlled boundaries");
  await waitFor(() => firstStarted, "first parent tool");
  const contact = child.session.agent.state.tools.find((tool) => tool.name === "contact_supervisor")!;
  const receipt = await contact.execute("timely-discovery", { reason: "progress_update", message: "A required migration changes the API decision." }, new AbortController().signal);
  assert.equal(secondStarted, false);
  firstGate.resolve();
  await waitFor(() => secondStarted, "second parent tool");
  assert.match(seenAtBoundary, /A required migration changes the API decision/);
  assert.equal(parent.session.isIdle, false, "progress was consumed before parent work completed");
  assert.match(JSON.stringify(receipt), /broker acceptance does not confirm/i);
  secondGate.resolve();
  await running;
  assert.equal(parent.faux.state.callCount, 3, "no delayed progress-only turn");
  assert.deepEqual(parent.errors, []);
});

test("native owning-parent human messages preserve context and real consumption, without elevating peers", async (t) => {
  const hold = gate(t);
  let started = false, parentApi: ExtensionAPI, seen = "";
  const parent = await makeSession(t, "human-parent", { configure(pi) { parentApi = pi; } });
  const owner = parent.session.sessionManager.getSessionId();
  saveQuestionOwner("human-run", owner);
  const child = await makeSession(t, "human-child", { child: { runId: "human-run", supervisor: "human-parent" }, configure(pi) {
    pi.registerTool({ name: "hold", label: "Hold", description: "Controlled child tool", parameters: Type.Object({}), async execute() {
      started = true; await hold.promise; return { content: [{ type: "text", text: "Child tool finished" }], details: {} };
    } });
  } });
  child.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
    (context) => { seen = JSON.stringify(context); return fauxAssistantMessage("I will preserve that API as requested."); },
    fauxAssistantMessage("Peer note seen as a peer note"),
  ]);
  const running = child.session.prompt("Inspect the implementation");
  await waitFor(() => started, "child tool");
  const { sendLiveSubagentMessage } = await import("../../src/intercom/live-intercom.ts");
  const receipt = await sendLiveSubagentMessage(parentApi!.events, { to: "human-child", message: "Keep the public API unchanged.", timeoutMs: 5000,
    extra: { messageId: "human-direction", human: { ownerSessionId: owner, runId: "human-run", index: 0 }, attachments: [{ type: "context", name: "Selected edit", content: "- oldAPI\n+ proposedAPI" }] } });
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.messageId, "human-direction");
  const humanEntries = () => child.session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "subagent-human-message");
  assert.equal(humanEntries().length, 0, "broker receipt is not model consumption");
  hold.resolve();
  await running;
  assert.equal(humanEntries().length, 1);
  assert.equal(humanEntries()[0].details.message.id, "human-direction");
  assert.match(seen, /Direct user message to this agent/);
  assert.match(seen, /human origin, not peer advice/);
  assert.match(seen, /Keep the public API unchanged/);
  assert.match(seen, /Selected edit/);
  assert.match(seen, /proposedAPI/);
  assert.ok(child.session.sessionManager.getEntries().some((entry) => entry.type === "message" && entry.message.role === "assistant" && JSON.stringify(entry.message.content).includes("preserve that API")));
  await child.send("spoofed-peer-origin", { text: "Peer text must not gain user authority", delivery: "steer", human: { ownerSessionId: owner, runId: "human-run", index: 0 } });
  await waitFor(() => child.visible("spoofed-peer-origin").length === 1 && child.session.isIdle, "ordinary peer delivery");
  assert.equal(humanEntries().length, 1);
  assert.match(child.visible("spoofed-peer-origin")[0].content, /From sender-human-child/);
  assert.doesNotMatch(child.visible("spoofed-peer-origin")[0].content, /Direct user message/);
  assert.deepEqual(child.errors, []);
});

for (const mode of ["single", "parallel", "chain"] as const) test(`native important steer releases the ${mode} wait without skipping child work`, async (t) => {
  const name = `important-${mode}-parent`, directory = path.join(root, `important-${mode}-child`), bin = path.join(directory, "bin"), release = path.join(directory, "release");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "pi"), `#!/bin/sh\nexec "${process.execPath}" "${path.join(repo, "test/fixtures/native-feedback-child.mjs")}" "$@"\n`, { mode: 0o700 });
  const saved = { PATH: process.env.PATH, PI_FEEDBACK_RELEASE_FILE: process.env.PI_FEEDBACK_RELEASE_FILE, PI_FEEDBACK_SCENARIO: process.env.PI_FEEDBACK_SCENARIO };
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`; process.env.PI_FEEDBACK_RELEASE_FILE = release; process.env.PI_FEEDBACK_SCENARIO = "tool";
  const state = { baseCwd: directory, currentSessionId: "", ownedRuns: new Map(), asyncJobs: new Map(), foregroundRuns: new Map(), foregroundControls: new Map(), lastForegroundControlId: null };
  const notices = [];
  let seen = "", yielded;
  t.after(async () => { writeFileSync(release, "released"); await waitFor(() => !state.foregroundControls.size, "continued workflow cleanup"); for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const parent = await makeSession(t, name, { hasUI: true, configure(pi) {
    const executor = createSubagentExecutor({ pi, state, config: {}, asyncByDefault: false, tempArtifactsDir: directory, getSubagentSessionRoot: () => path.join(directory, "sessions"), expandTilde: (value) => value,
      discoverAgents: () => ({ agents: [makeAgent("worker", { model: "feedback-fixture/faux-1", completionGuard: false, output: false, progress: false })] }) });
    pi.events.on("subagent:result-intercom", (notice) => { notices.push(notice); });
    pi.registerTool({ name: "foreground_agent", label: "Foreground agent", description: "Wait for the real native child fixture", parameters: Type.Object({}), async execute(id, _args, signal, update, ctx) {
      const first = { agent: "worker", task: "STEP_A keep working", output: false }, second = { agent: "worker", task: "STEP_B consume {previous}", output: false };
      return yielded = await executor.execute(id, { ...(mode === "single" ? first : mode === "parallel" ? { tasks: [first, second], concurrency: 1 } : { chain: [first, second] }), async: false, context: "fresh", artifacts: false }, signal, update, ctx);
    } });
  } });
  parent.faux.setResponses([fauxAssistantMessage(fauxToolCall("foreground_agent", {}), { stopReason: "toolUse" }), (context) => { seen = JSON.stringify(context); return fauxAssistantMessage("Important direction handled before child completion"); }, fauxAssistantMessage("Final child result handled")]);
  const running = parent.session.prompt("Wait for the foreground child");
  const receipt = () => JSON.parse(readFileSync(`${release}.json`, "utf8"));
  await waitFor(() => existsSync(`${release}.json`) && receipt().events.some((event) => event.type === "tool_execution_start"), "real native held child");
  const firstPid = receipt().pid;
  await parent.send(`important-during-${mode}`, { text: "Important direction: keep the current API.", delivery: "steer" });
  await running;
  assert.match(seen, /Important direction: keep the current API/);
  assert.match(seen, /continues unchanged, including queued and dependent steps/);
  assert.equal(questionProcessAlive({ pid: firstPid }), true, "the important message did not kill the child");
  assert.equal(existsSync(release), false);
  assert.ok(state.foregroundControls.has(yielded.details.runId), "yielding keeps the original workflow control alive");
  writeFileSync(release, "released");
  await waitFor(() => !state.foregroundControls.size && notices.length === 1, "all original workflow steps and one final result");
  const view = ownedRunView(state.ownedRuns.get(yielded.details.runId), state);
  assert.equal(view.state, "completed");
  assert.equal(view.children.length, mode === "single" ? 1 : 2);
  for (const child of view.children) { assert.equal(child.state, "completed"); assert.equal(child.result.finalOutput, "Synthetic child finished normally"); }
  if (mode === "chain") assert.match(view.children[1].task, /STEP_B consume Synthetic child finished normally/, "dependent B receives A's real output");
  assert.equal(notices[0].status, "completed");
  assert.equal(notices.length, 1, "yielding must not synthesize a terminal result before real completion");
  assert.deepEqual(parent.errors, []);
});

test("native topics keep routine state out of conversation and interrupt only relevant subscriptions", async (t) => {
  const publisher = await makeSession(t, "topic-publisher");
  const subscriber = await makeSession(t, "topic-subscriber");
  const late = await makeSession(t, "topic-late");
  const call = (target, params) => target.session.agent.state.tools.find((tool) => tool.name === "intercom").execute(randomUUID(), params, new AbortController().signal);
  const inspect = async (target) => JSON.stringify(await call(target, { action: "topics", topic: "browser/shared-test" }));
  subscriber.faux.setResponses([fauxAssistantMessage("Blocker considered"), fauxAssistantMessage("Awaited release seen"), fauxAssistantMessage("Direct message seen")]);
  late.faux.setResponses([fauxAssistantMessage("Blocker considered")]);
  await call(subscriber, { action: "subscribe", topic: "browser/shared-test", awaitRelease: true });
  for (const message of ["Old routine state", "Current routine state"]) await call(publisher, { action: "publish", topic: "browser/shared-test", message, resource: "tab/test", ownership: "held" });
  await waitFor(async () => (await inspect(subscriber)).includes("Current routine state"), "latest quiet record");
  assert.equal(subscriber.faux.state.callCount, 0);
  assert.equal(subscriber.session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message").length, 0, "quiet topic records are not passive model-context messages");
  assert.doesNotMatch(await inspect(subscriber), /Old routine state/);
  await call(late, { action: "subscribe", topic: "browser/shared-test" });
  assert.match(await inspect(late), /Current routine state/);
  assert.equal(late.faux.state.callCount, 0, "late subscription inspects current state without replaying old interruptions");
  await call(publisher, { action: "publish", topic: "browser/shared-test", event: "blocker", message: "Touch ID is required before this shared tab can proceed", resource: "tab/test", ownership: "held" });
  await waitFor(() => subscriber.faux.state.callCount === 1 && late.faux.state.callCount === 1, "subscribed blockers interrupt");
  await call(publisher, { action: "publish", topic: "browser/shared-test", event: "release", message: "The shared tab is released", resource: "tab/test", ownership: "released" });
  await waitFor(() => subscriber.faux.state.callCount === 2, "awaited ownership release");
  await sleep(1700);
  assert.equal(late.faux.state.callCount, 1, "unawaited release only replaces quiet state");
  await call(subscriber, { action: "unsubscribe", topic: "browser/shared-test" });
  await subscriber.send("topic-direct-bypass", { text: "Direct messages always get through", delivery: "steer" });
  await waitFor(() => subscriber.faux.state.callCount === 3, "direct message bypasses subscriptions");
  await call(publisher, { action: "publish", topic: "browser/shared-test", message: "Using the tab again", resource: "tab/test", ownership: "held" });
  await call(subscriber, { action: "subscribe", topic: "browser/shared-test", awaitRelease: true });
  await subscriber.session.reload();
  await waitFor(async () => (await inspect(subscriber)).includes("awaiting release"), "same-session subscription restoration");
  await publisher.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  await waitFor(async () => (await inspect(subscriber)).includes("disconnected / unavailable"), "owner disconnect is visible");
  const disconnected = await inspect(subscriber);
  assert.match(disconnected, /declared held/);
  assert.match(disconnected, /disconnect is not release/);
  assert.equal(subscriber.faux.state.callCount, 3, "disconnect is not an awaited release interruption");
  assert.deepEqual(subscriber.errors, []);
});

test("native concurrent selected stops survive one runner poll without stopping a third child", async (t) => {
  const { executeAsyncChain } = await import("../../src/runs/background/async-execution.ts");
  const { interruptAsyncRun } = await import("../../src/runs/foreground/foreground-control.ts");
  const { getRunMetadataDir } = await import("../../src/runs/shared/supervisor-questions.ts");
  const directory = path.join(root, "concurrent-stops"), bin = path.join(directory, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "pi"), `#!/bin/sh\nexec "${process.execPath}" "${path.join(repo, "test/fixtures/native-feedback-child.mjs")}" "$@"\n`, { mode: 0o700 });
  const pollRelease = path.join(directory, "poll-release"), childRelease = path.join(directory, "child-release-{index}");
  const saved = Object.fromEntries(["PATH", "NODE_OPTIONS", "PI_TEST_RUNNER_POLL_RELEASE", "PI_FEEDBACK_RELEASE_FILE", "PI_FEEDBACK_SCENARIO"].map((key) => [key, process.env[key]]));
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(path.join(repo, "test/fixtures/hold-runner-polls.mjs")).href}`;
  process.env.PI_TEST_RUNNER_POLL_RELEASE = pollRelease;
  process.env.PI_FEEDBACK_RELEASE_FILE = childRelease;
  process.env.PI_FEEDBACK_SCENARIO = "tool";
  const id = randomUUID();
  saveQuestionOwner(id, "concurrent-stop-owner");
  const started = executeAsyncChain(id, { chain: [{ parallel: [0, 1, 2].map((index) => ({ agent: "worker", task: `Held native child ${index}`, output: false })), concurrency: 3 }], resultMode: "parallel",
    agents: [makeAgent("worker", { model: "feedback-fixture/faux-1", output: false, extensions: [], completionGuard: false })],
    ctx: { pi: { events: createEventBus() }, cwd: directory, currentSessionId: "concurrent-stop-owner" }, cwd: directory,
    sessionRoot: path.join(directory, "sessions"), sessionFilesByFlatIndex: [0, 1, 2].map((index) => path.join(directory, "sessions", `${index}.jsonl`)), shareEnabled: false, maxSubagentDepth: 1 });
  assert.equal(started.isError, undefined, JSON.stringify(started));
  const statusPath = path.join(started.details.asyncDir!, "status.json"), resultPath = path.join(getRunMetadataDir(id), "result.json");
  const status = () => existsSync(statusPath) ? JSON.parse(readFileSync(statusPath, "utf8")) : undefined;
  t.after(async () => {
    writeFileSync(pollRelease, "released");
    for (const index of [0, 1, 2]) writeFileSync(childRelease.replace("{index}", String(index)), "released");
    await waitFor(() => existsSync(resultPath), "all selected-stop fixture children settle");
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
  await waitFor(() => status()?.steps?.length === 3 && status().steps.every((step) => step.currentTool === "bash"), "three real native tools before the first control poll");
  await waitFor(() => existsSync(`${pollRelease}.held`), "the private runner's poll clock is held");
  assert.equal(existsSync(pollRelease), false);
  const state = { asyncJobs: new Map([[id, { asyncId: id, asyncDir: started.details.asyncDir!, status: "running" }]]) };
  const receipts = [interruptAsyncRun(state, id, 0), interruptAsyncRun(state, id, 1)];
  assert.ok(receipts.every((receipt) => receipt && !receipt.isError));
  writeFileSync(pollRelease, "released");
  await waitFor(() => status().steps[1].status === "paused", "second selected child pauses");
  await sleep(200);
  const observed = status().steps.map((step) => ({ status: step.status, currentTool: step.currentTool, agentProcessExit: step.agentProcessExit }));
  writeFileSync(path.join(directory, "observation.json"), JSON.stringify({ receipts, observed }, null, 2));
  t.diagnostic(JSON.stringify({ observed }));
  assert.deepEqual(observed.map((step) => step.status), ["paused", "paused", "running"], "both accepted selected stops must execute; an unrelated native child keeps working");
  assert.ok(observed[0].agentProcessExit?.at && observed[1].agentProcessExit?.at, "paused agent processes have actual exit evidence");
  assert.equal(observed[2].currentTool, "bash");
  assert.equal(observed[2].agentProcessExit, undefined);
  writeFileSync(childRelease.replace("{index}", "2"), "released");
  await waitFor(() => existsSync(resultPath), "unselected child finishes normally");
  assert.deepEqual(status().steps.map((step) => step.status), ["paused", "paused", "complete"]);
  const receipt = JSON.parse(readFileSync(`${childRelease.replace("{index}", "2")}.json`, "utf8"));
  assert.equal(receipt.networkRequests, 0); assert.deepEqual(receipt.errors, []);
});

for (const boundary of ["presence", "registration"] as const) test(`native rejected topic ${boundary} snapshot preserves prior publication through reload and direct messaging`, async (t) => {
  const { MAX_FRAME_SIZE_BYTES, intercomMessageSizeBytes } = await import("../../src/pi-intercom/broker/framing.ts");
  const publisher = await makeSession(t, `topic-size-${boundary}`), topic = `private/size-${boundary}`;
  const call = (params) => publisher.session.agent.state.tools.find((tool) => tool.name === "intercom").execute(randomUUID(), params, new AbortController().signal);
  publisher.faux.setResponses([fauxAssistantMessage("Persist native history"), fauxAssistantMessage("Direct message after rejection was read")]);
  await publisher.session.prompt("Seed private session"); await publisher.session.waitForIdle();
  await call({ action: "publish", topic, message: "Previous valid publication" });
  const emptyUpdate = { topic, text: "", event: "update", revision: 2, updatedAt: Date.now() };
  const length = boundary === "presence" ? MAX_FRAME_SIZE_BYTES : MAX_FRAME_SIZE_BYTES - intercomMessageSizeBytes({ type: "presence", subscriptions: [], topics: [emptyUpdate] });
  const message = "x".repeat(length);
  if (boundary === "registration") assert.equal(intercomMessageSizeBytes({ type: "presence", subscriptions: [], topics: [{ ...emptyUpdate, text: message }] }), MAX_FRAME_SIZE_BYTES, "the candidate fits the presence frame but must also fit registration");
  let rejected: string | undefined;
  try { await call({ action: "publish", topic, message }); } catch (error) { rejected = String(error); }
  const publications = publisher.session.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "intercom-topic" && entry.data?.published).map((entry) => entry.data.published);
  await publisher.session.reload();
  let reconnected: string;
  try { reconnected = await publisher.status(); } catch (error) { reconnected = String(error); }
  t.diagnostic(JSON.stringify({ boundary, rejected, publishedTextLengths: publications.map((entry) => entry.text.length), reconnected }));
  assert.ok(rejected, "oversized transported state must be rejected");
  assert.equal(publications.length, 1, "a rejected snapshot must change neither publication state nor native durable history");
  assert.equal(publications[0].text, "Previous valid publication");
  assert.doesNotMatch(reconnected, /not connected|too large|disconnected/i);
  await publisher.send(`after-size-${boundary}`, { text: "A normal direct message still works", delivery: "steer" });
  await waitFor(() => publisher.visible(`after-size-${boundary}`).length === 1 && publisher.session.isIdle, "ordinary native direct delivery after rejected publication and reload");
  assert.match(JSON.stringify(await call({ action: "topics", topic })), /Previous valid publication/);
  await call({ action: "publish", topic, message: "Small corrected publication" });
  assert.match(JSON.stringify(await call({ action: "topics", topic })), /Small corrected publication/);
  assert.deepEqual(publisher.errors, []);
});

test("native aggregate topic snapshots remain complete across reload and ordinary messaging", async (t) => {
  const { MAX_FRAME_SIZE_BYTES, intercomMessageSizeBytes } = await import("../../src/pi-intercom/broker/framing.ts");
  const publisher = await makeSession(t, "aggregate-topic-publisher"), topic = "private/aggregate-topic";
  const call = (params) => publisher.session.agent.state.tools.find((tool) => tool.name === "intercom").execute(randomUUID(), params, new AbortController().signal);
  publisher.faux.setResponses([fauxAssistantMessage("Persist private native history")]);
  await publisher.session.prompt("Seed"); await publisher.session.waitForIdle();
  await call({ action: "publish", topic, message: "Prior valid state" });
  const peers = [], received = [];
  t.after(async () => { await Promise.all(peers.map((peer) => peer.disconnect())); });
  for (let index = 0; index < 4; index++) {
    const peer = new IntercomClient(); peer.on("message", (_from, message) => received.push(message.content.text));
    await peer.connect({ name: `aggregate-peer-${index}`, cwd: root, model: "fixture" }); peers.push(peer);
  }
  const before = await peers[0].listSessions(), own = before.find((session) => session.name === "aggregate-topic-publisher")!;
  const { id, ...registration } = own;
  const update = { topic, text: "", event: "update", revision: 2, updatedAt: Date.now() };
  const presence = { subscriptions: own.subscriptions ?? [], topics: [update] };
  update.text = "x".repeat(MAX_FRAME_SIZE_BYTES - intercomMessageSizeBytes({ type: "register", session: { ...registration, ...presence }, requestedId: id }) - 64);
  assert.ok(intercomMessageSizeBytes({ type: "presence", ...presence }) < MAX_FRAME_SIZE_BYTES);
  assert.ok(intercomMessageSizeBytes({ type: "sessions", requestId: randomUUID(), sessions: before.map((session) => session.id === id ? { ...session, ...presence } : session) }) > MAX_FRAME_SIZE_BYTES, "the complete valid snapshot exceeds one reply frame");
  let publicationError;
  try { await call({ action: "publish", topic, message: update.text }); } catch (error) { publicationError = String(error); }
  assert.equal(publicationError, undefined, "valid topic data must not fail because ordinary peers enlarge the aggregate snapshot");
  const snapshot = await peers[0].listSessions();
  assert.equal(snapshot.find((session) => session.id === id).topics[0].text, update.text);
  for (const peer of peers) assert.ok(snapshot.some((session) => session.id === peer.sessionId));
  const otherTopics = ["private/concurrent-a", "private/concurrent-b"];
  const otherText = "Concurrent quiet result ".repeat(26000);
  await Promise.all(otherTopics.map((topic) => call({ action: "publish", topic, message: otherText })));
  const combined = (await peers[0].listSessions()).find((session) => session.id === id)!;
  assert.ok(intercomMessageSizeBytes(combined) > MAX_FRAME_SIZE_BYTES, "one publisher's valid registry can span reply frames too");
  for (const topic of otherTopics) assert.equal(combined.topics.find((update) => update.topic === topic).text, otherText, "concurrent publications must not replace one another's records");
  const direction = "Ordinary direction ".repeat(15000);
  await call({ action: "send", to: peers[0].sessionId, message: direction });
  await waitFor(() => received.includes(direction), "ordinary direct delivery must not carry the publisher's large quiet registry");
  await publisher.session.reload();
  assert.match(await publisher.status(), /Connected: Yes/);
  const restored = (await peers[0].listSessions()).find((session) => session.id === id)!;
  assert.equal(restored.topics.find((entry) => entry.topic === topic).text, update.text, "native reload preserves the complete published state");
  for (const topic of otherTopics) assert.equal(restored.topics.find((update) => update.topic === topic).text, otherText);
  await call({ action: "publish", topic, message: "Small corrected state" });
  await call({ action: "send", to: peers[0].sessionId, message: "After correction" });
  await waitFor(() => received.includes("After correction"), "ordinary messaging after correction");
  assert.deepEqual(publisher.errors, []);
});

test("native large subscribed topic delivery does not duplicate text or leak its registry into messages", async (t) => {
  const publisher = await makeSession(t, "large-topic-publisher"), subscriber = await makeSession(t, "large-topic-subscriber");
  const call = (target, params) => target.session.agent.state.tools.find((tool) => tool.name === "intercom").execute(randomUUID(), params, new AbortController().signal);
  const topic = "private/large-delivery", message = "Complete quiet result 日本語 ".repeat(18000);
  assert.ok(Buffer.byteLength(message) > 512 * 1024 && Buffer.byteLength(message) < 800 * 1024);
  await call(subscriber, { action: "subscribe", topic });
  const receipt = await call(publisher, { action: "publish", topic, message });
  assert.equal(receipt.details.receipts.length, 1);
  assert.equal(receipt.details.receipts[0].accepted, true, "a valid large topic update must reach its subscriber within the existing frame limit");
  await waitFor(() => subscriber.session.sessionManager.getEntries().some((entry) => entry.type === "custom" && entry.customType === "intercom-topic" && entry.data?.record?.update.text === message), "complete quiet topic delivery");
  assert.equal(subscriber.faux.state.callCount, 0);
  assert.equal(subscriber.session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message").length, 0);
  assert.deepEqual(publisher.errors, []); assert.deepEqual(subscriber.errors, []);
});

test("native rejected complete topic delivery envelope preserves broker and durable state", async (t) => {
  const { MAX_FRAME_SIZE_BYTES, intercomMessageSizeBytes } = await import("../../src/pi-intercom/broker/framing.ts");
  const publisher = await makeSession(t, "topic-envelope-publisher"), subscriber = await makeSession(t, "topic-envelope-subscriber");
  const call = (target, params) => target.session.agent.state.tools.find((tool) => tool.name === "intercom").execute(randomUUID(), params, new AbortController().signal);
  const topic = "private/delivery-envelope";
  publisher.faux.setResponses([fauxAssistantMessage("Persist private native history")]);
  await publisher.session.prompt("Seed"); await publisher.session.waitForIdle();
  await call(publisher, { action: "publish", topic, message: "Previous usable publication" });
  await call(subscriber, { action: "subscribe", topic });
  const own = (await publisher.sender.listSessions()).find((session) => session.name === "topic-envelope-publisher")!;
  const { id, topics: _topics, subscriptions: _subscriptions, ...from } = own;
  const update = { topic, text: "", event: "update", revision: 2, updatedAt: Date.now() };
  const message = { id: randomUUID(), timestamp: Date.now(), topic: { ...update, text: undefined }, delivery: "queue", queueMode: "replace", threadId: `topic:${topic}`, content: { text: "" } };
  const emptyDeliverySize = intercomMessageSizeBytes({ type: "message", from: { ...from, id }, message });
  const emptyRegistrationSize = intercomMessageSizeBytes({ type: "register", session: { ...from, subscriptions: [], topics: [update] }, requestedId: id });
  const text = "x".repeat(Math.min(MAX_FRAME_SIZE_BYTES - emptyRegistrationSize - 32, MAX_FRAME_SIZE_BYTES - emptyDeliverySize + 64));
  assert.ok(emptyRegistrationSize + text.length < MAX_FRAME_SIZE_BYTES);
  assert.ok(emptyDeliverySize + text.length > MAX_FRAME_SIZE_BYTES, "the complete delivery envelope, even without duplicated text, exceeds the frame");
  let rejection;
  try { await call(publisher, { action: "publish", topic, message: text }); } catch (error) { rejection = String(error); }
  assert.ok(rejection, "an undeliverable candidate must be rejected before it is saved");
  const saved = publisher.session.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "intercom-topic" && entry.data?.published);
  assert.equal(saved.length, 1, "a hard delivery rejection must not overwrite the prior durable publication");
  assert.equal((await publisher.sender.listSessions()).find((session) => session.id === id).topics[0].text, "Previous usable publication", "the broker must also retain its prior valid snapshot");
  await publisher.session.reload();
  assert.match(await publisher.status(), /Connected: Yes/);
  const received = once(publisher.sender, "message");
  await call(publisher, { action: "send", to: publisher.sender.sessionId, message: "Direct messaging still works" });
  assert.equal((await received)[1].content.text, "Direct messaging still works");
  await call(publisher, { action: "publish", topic, message: "Small valid correction" });
  assert.deepEqual(publisher.errors, []);
});

test("native previously poisoned topic history cannot prevent reconnect or a small correction", async (t) => {
  const publisher = await makeSession(t, "poisoned-topic-history"), topic = "private/old-poisoned-topic";
  const call = (params) => publisher.session.agent.state.tools.find((tool) => tool.name === "intercom").execute(randomUUID(), params, new AbortController().signal);
  publisher.faux.setResponses([fauxAssistantMessage("Persist private native history")]);
  await publisher.session.prompt("Seed"); await publisher.session.waitForIdle();
  await call({ action: "publish", topic, message: "Previous valid publication" });
  // This is the durable entry left by the reproduced pre-fix publish-before-validation failure.
  publisher.session.sessionManager.appendCustomEntry("intercom-topic", { sessionId: publisher.session.sessionManager.getSessionId(), published: { topic, text: "x".repeat(1024 * 1024), event: "update", revision: 2, updatedAt: Date.now() } });
  await publisher.session.reload();
  assert.match(await publisher.status(), /Connected: Yes/, "a saved quiet-state failure must not disable the ordinary connection");
  const received = once(publisher.sender, "message");
  await call({ action: "send", to: publisher.sender.sessionId, message: "Ordinary message before correction" });
  assert.equal((await received)[1].content.text, "Ordinary message before correction");
  await call({ action: "publish", topic, message: "Small corrected state" });
  assert.equal((await publisher.sender.listSessions()).find((session) => session.name === "poisoned-topic-history").topics[0].text, "Small corrected state");
  await publisher.session.reload();
  assert.match(await publisher.status(), /Connected: Yes/);
  assert.ok(publisher.session.sessionManager.getEntries().some((entry) => entry.type === "custom" && entry.customType === "intercom-topic" && entry.data?.published?.text.length === 1024 * 1024), "raw native history remains intact");
  assert.deepEqual(publisher.errors, []);
});

test("native latest material milestone survives two minutes busy and reload without stale superseded delivery", async (t) => {
  const toolGate = gate(t);
  let toolStarted = false;
  const supervisor = await makeSession(t, "milestone-supervisor", { hasUI: true, configure(pi) {
    pi.registerTool({ name: "hold", label: "Hold", description: "Fixture gate", parameters: Type.Object({}), async execute() {
      toolStarted = true;
      await toolGate.promise;
      return { content: [{ type: "text", text: "released" }], details: {} };
    } });
  } });
  supervisor.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("Current work complete"),
    fauxAssistantMessage("Milestone handled"),
  ]);
  const running = supervisor.session.prompt("Work before the milestone");
  await waitFor(() => toolStarted, "busy supervisor tool");
  const now = Date.now;
  try {
    Date.now = () => now() - 120_000;
    await supervisor.send("old-milestone", { text: "Subagent progress update.\n\nOld finding", delivery: "queue", queueMode: "replace", threadId: "material-progress" });
    await supervisor.send("latest-milestone", { text: "Subagent progress update.\n\nRoot cause confirmed", delivery: "queue", queueMode: "replace", threadId: "material-progress" });
  } finally {
    Date.now = now;
  }
  await waitFor(async () => (await supervisor.status()).includes("Root cause confirmed"), "coalesced latest milestone");
  await supervisor.session.reload();
  toolGate.resolve();
  await running;
  await waitFor(() => supervisor.visible("latest-milestone").length === 1 && supervisor.settled() === 2, "milestone settlement");
  assert.equal(supervisor.visible("old-milestone").length, 0);
  assert.equal(supervisor.visible("latest-milestone").length, 1);
  assert.equal(supervisor.faux.state.callCount, 3);
  assert.match(await supervisor.status(), /Pending inbound messages: 0/);
  assert.deepEqual(supervisor.errors, []);
  t.diagnostic("latest backdated material finding survives native reload while busy; superseded progress never wakes the model.");
});
