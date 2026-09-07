import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const root = mkdtempSync(path.join(evidenceDir ?? tmpdir(), "pi-intercom-native-"));
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
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(sdkEntry.href);
const { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore, Type } = await import(pathToFileURL(path.join(aiRoot, "dist/index.js")).href);
const { IntercomClient } = await import("../../src/pi-intercom/broker/client.ts");
const { listSupervisorQuestions, readQuestionState, saveQuestionAnswer, saveQuestionOwner } = await import("../../src/runs/shared/supervisor-questions.ts");

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
    cwd, agentDir, settingsManager,
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

test("native concurrent prompt preflight failure cannot spin receiver replay", async (t) => {
  const launch = gate(t);
  const activeRun = gate(t);
  let beforeStarts = 0;
  let heldFirstStart = false;
  const receiver = await makeSession(t, "early-failure", { configure(pi) {
    pi.on("before_agent_start", async () => {
      beforeStarts++;
      if (beforeStarts <= 2) await launch.promise;
      else await sleep(10); // A broken replay stays bounded and lets test cleanup run.
    });
    pi.on("agent_start", async () => {
      if (!heldFirstStart) { heldFirstStart = true; await activeRun.promise; }
    });
  } });
  receiver.faux.setResponses([fauxAssistantMessage("First handled"), fauxAssistantMessage("Second handled")]);
  await Promise.all([receiver.send("first"), receiver.send("second")]);
  await waitFor(() => beforeStarts === 2, "overlapping native prompt preparation");
  launch.resolve();
  await waitFor(() => receiver.errors.some((error) => error.error.includes("already processing")), "native preflight rejection");
  await sleep(60);
  const attemptsWhileOriginalActive = beforeStarts;
  activeRun.resolve();
  await waitFor(() => receiver.faux.state.callCount >= 2 && receiver.session.isIdle, "real run and failed handoff recovery");
  assert.equal(attemptsWhileOriginalActive, 2, "settlement of a rejected prompt must not start repeated receiver prompts");
  assert.equal(receiver.errors.length, 1);
  assert.equal(receiver.visible("first").length, 1);
  assert.equal(receiver.visible("second").length, 1);
  assert.equal(receiver.faux.state.callCount, 2);
  assert.equal(beforeStarts, 3);
  assert.match(await receiver.status(), /Pending inbound messages: 0/);
  t.diagnostic("2 one-time sends; 1 real preflight rejection; no replay while native signal is active; 2 visible messages and 2 provider calls.");
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
