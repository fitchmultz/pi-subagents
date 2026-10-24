import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { after as afterAll, before as beforeAll, test, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext, AgentSession } from "@earendil-works/pi-coding-agent";
import type { Message, SessionInfo } from "../../src/pi-intercom/types.ts";
import type { ReadonlyDeep as ReadonlyInput } from "type-fest";
import { createMessageReader } from "../../src/pi-intercom/broker/framing.ts";
import { importSelectedNative } from "../support/native-import.ts";
import { registeredSession, waitFor } from "../support/native-readiness.ts";
import {
  assertDefined,
  array,
  record,
  records,
  strings,
  text,
  numberValue,
} from "../support/assertions.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const evidenceDir = process.env.PI_INTERCOM_TEST_EVIDENCE_DIR;
if (evidenceDir !== undefined && evidenceDir !== "") {
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
}
const root = realpathSync(mkdtempSync(path.join(evidenceDir ?? tmpdir(), "pi-intercom-native-")));
const agentDir = path.join(root, "agent");
for (const directory of [
  agentDir,
  path.join(root, "home"),
  path.join(root, "pi-subagents-runtime"),
]) {
  mkdirSync(directory, { recursive: true });
}
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PI_SUBAGENT_")) {
    delete process.env[key];
  }
}
process.env.HOME = path.join(root, "home");
process.env.USERPROFILE = process.env.HOME;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_SUBAGENT_TEMP_ROOT = path.join(root, "pi-subagents-runtime");
process.env.PI_OFFLINE = "1";
process.env.JITI_FS_CACHE = path.join(root, "jiti");

function codingAgentManifest(): string {
  const manifest = findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url);
  assertDefined(manifest);
  return manifest;
}

// Use an isolated rebuilt Pi package to check a native fix before it is released.
const sdkRoot = process.env.PI_INTERCOM_TEST_SDK ?? path.dirname(codingAgentManifest());
process.env.PI_PACKAGE_DIR = sdkRoot;
const sdkEntry = pathToFileURL(path.join(sdkRoot, "dist/index.js"));
const aiManifest = findPackageJSON("@earendil-works/pi-ai", sdkEntry);
assertDefined(aiManifest);
const aiRoot = path.dirname(aiManifest);
const {
  createAgentSession,
  AgentSessionRuntime,
  DefaultResourceLoader,
  ModelRuntime,
  parseSessionEntries,
  SessionManager,
  SettingsManager,
} = await importSelectedNative(
  import.meta.url,
  "@earendil-works/pi-coding-agent",
  sdkEntry.href,
  () => import("@earendil-works/pi-coding-agent"),
);
const { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore, Type } =
  await importSelectedNative(
    import.meta.url,
    "@earendil-works/pi-ai",
    pathToFileURL(path.join(aiRoot, "dist/index.js")).href,
    () => import("@earendil-works/pi-ai"),
  );
const { IntercomClient } = await import("../../src/pi-intercom/broker/client.ts");

function launchBroker() {
  const child = spawn(process.execPath, [path.join(repo, "src/pi-intercom/broker/broker.ts")], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      TMPDIR: tmpdir(),
      PI_CODING_AGENT_DIR: agentDir,
      PI_INTERCOM_RUNTIME_DIR: process.env.PI_INTERCOM_RUNTIME_DIR,
      PI_SUBAGENT_TEMP_ROOT: process.env.PI_SUBAGENT_TEMP_ROOT,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", collectBrokerLog);
  child.stderr.on("data", collectBrokerLog);
  return child;
}
let brokerLog = "";
const collectBrokerLog = (chunk: unknown) => {
  brokerLog += text(chunk);
};
let broker = launchBroker();

const fixtureClient = new IntercomClient();
beforeAll(async () => {
  await waitFor(() => brokerLog.includes("Intercom broker started"), "private broker");
  // Keep the suite's broker alive between cold SDK loads, beyond its 5s idle exit.
  await fixtureClient.connect({ name: "fixture-host", cwd: root, model: "fixture" });
});
afterAll(async () => {
  await fixtureClient.disconnect();
  if (broker.exitCode === null) {
    const exited = once(broker, "exit");
    broker.kill("SIGTERM");
    await exited;
  }
  if (evidenceDir !== undefined && evidenceDir !== "") {
    writeFileSync(path.join(root, "broker.log"), brokerLog);
  } else {
    rmSync(root, { recursive: true, force: true });
  }
});

function gate(t: TestContext) {
  const deferred: PromiseWithResolvers<void> = Promise.withResolvers();
  t.after(() => deferred.resolve());
  return deferred;
}

function property(value: unknown, key: string): unknown {
  const result: unknown =
    typeof value === "object" && value !== null && key in value
      ? Reflect.get(value, key)
      : undefined;
  return result;
}

function at(value: unknown, ...keys: readonly string[]): unknown {
  let current = value;
  for (const key of keys) {
    current = property(current, key);
  }
  return current;
}

function registeredTool(session: AgentSession, name: string) {
  const tool = session.agent.state.tools.find((candidate) => candidate.name === name);
  assertDefined(tool);
  return {
    async execute(id: string, params: Readonly<Record<string, unknown>>, signal: AbortSignal) {
      const published: unknown = await tool.execute(id, params, signal);
      const result = record(published);
      const isError = result.isError;
      assert.ok(isError === undefined || typeof isError === "boolean");
      const content = records(result.content).map((part) => ({
        type: text(part.type),
        text: text(part.text),
      }));
      return { content, details: result.details, isError };
    },
  };
}

function executeIntercom(
  target: { readonly session: AgentSession },
  params: Readonly<Record<string, unknown>>,
) {
  return registeredTool(target.session, "intercom").execute(
    randomUUID(),
    params,
    new AbortController().signal,
  );
}

function observedSession(
  sessions: readonly ReadonlyInput<SessionInfo>[],
  match: (session: ReadonlyInput<SessionInfo>) => boolean,
): ReadonlyInput<SessionInfo> {
  const session = sessions.find(match);
  assertDefined(session);
  return session;
}

async function receiveResume(child: ChildProcess) {
  const received: unknown = await once(child, "message", { signal: AbortSignal.timeout(8_000) });
  const frame = record(array(received)[0]);
  assert.ok(typeof frame.nativeQueued === "boolean");
  return [
    {
      type: text(frame.type),
      sessionId: text(frame.sessionId),
      sessionFile: text(frame.sessionFile),
      modelCalls: numberValue(frame.modelCalls),
      nativeQueued: frame.nativeQueued,
      status: text(frame.status),
      visibleIds: strings(frame.visibleIds),
      checkpointOwners: strings(frame.checkpointOwners),
      errors: array(frame.errors),
    },
  ];
}

function inboundId(message: unknown): string | undefined {
  const id: unknown = property(property(property(message, "details"), "message"), "id");
  return typeof id === "string" ? id : undefined;
}

async function makeSession(
  t: TestContext,
  name: string,
  options: {
    readonly configure?: (pi: ExtensionAPI) => void;
    readonly hasUI?: boolean;
    readonly lineage?: { readonly rootSessionId: string; readonly parentSessionId: string };
    readonly config?: Readonly<Record<string, unknown>>;
    readonly waitForRegistration?: boolean;
  } = {},
) {
  const cwd = path.join(root, name);
  mkdirSync(cwd);
  const faux = fauxProvider({ provider: `fixture-${name}` });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false, keepRecentTokens: 1 },
    retry: { enabled: false },
  });
  const events: Array<Record<string, unknown>> = [];
  const errors: Array<{ event: string; error: string }> = [];
  let ctx: ExtensionContext | undefined;
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "Deterministic intercom regression fixture.",
    additionalExtensionPaths: [
      process.env.PI_INTERCOM_TEST_EXTENSION ?? path.join(repo, "src/pi-intercom/index.ts"),
    ],
    extensionFactories: [
      (pi: ExtensionAPI) => {
        pi.on("session_start", (event, context) => {
          ctx = context;
          pi.setSessionName(name);
          events.push({ type: "extension.session_start", reason: event.reason });
        });
        pi.on("message_end", (event) => {
          events.push({
            type: "extension.message_end",
            role: event.message.role,
            id: inboundId(event.message),
            stopReason: "stopReason" in event.message ? event.message.stopReason : undefined,
          });
        });
        pi.on("agent_settled", (_event, context) => {
          events.push({
            type: "extension.agent_settled",
            signalPresent: Boolean(context.signal),
            pending: context.hasPendingMessages(),
          });
        });
        pi.on("session_before_compact", ({ preparation }) => ({
          compaction: {
            summary: "Earlier fixture messages were handled.",
            firstKeptEntryId: preparation.firstKeptEntryId,
            tokensBefore: preparation.tokensBefore,
          },
        }));
        options.configure?.(pi);
      },
    ],
  });
  if (options.lineage) {
    process.env.PI_INTERCOM_ROOT_SESSION_ID = options.lineage.rootSessionId;
    process.env.PI_INTERCOM_PARENT_SESSION_ID = options.lineage.parentSessionId;
  }
  const configPath = path.join(agentDir, "intercom/config.json");
  if (options.config) {
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(options.config));
  }
  try {
    await loader.reload();
  } finally {
    delete process.env.PI_INTERCOM_ROOT_SESSION_ID;
    delete process.env.PI_INTERCOM_PARENT_SESSION_ID;
    if (options.config) {
      rmSync(configPath);
    }
  }
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    settingsManager,
    resourceLoader: loader,
    model: faux.getModel(),
    noTools: "builtin",
    sessionManager: SessionManager.create(cwd, path.join(cwd, "sessions")),
  });
  const runtime = new AgentSessionRuntime(
    session,
    { cwd, agentDir, modelRuntime, settingsManager, resourceLoader: loader, diagnostics: [] },
    async () => {
      throw new Error("This fixture does not replace sessions");
    },
  );
  let disposal: Promise<void> | undefined;
  const dispose = () => {
    disposal ??= runtime.dispose();
    return disposal;
  };
  session.subscribe((event) => {
    if (event.type === "message_end" || event.type === "agent_settled") {
      events.push({
        type: `sdk.${event.type}`,
        role: event.type === "message_end" ? event.message.role : undefined,
        id: event.type === "message_end" ? inboundId(event.message) : undefined,
      });
    }
  });
  const sender = new IntercomClient();
  const sends: string[] = [];
  t.after(async () => {
    if (!disposal) {
      await session.abort();
    }
    await dispose();
    await sender.disconnect();
    if (evidenceDir !== undefined && evidenceDir !== "") {
      writeFileSync(
        path.join(root, `${name}.json`),
        JSON.stringify(
          {
            sends,
            modelCalls: faux.state.callCount,
            errors,
            events,
            entries: session.sessionManager.getEntries(),
          },
          null,
          2,
        ),
      );
    }
  });
  await sender.connect({ name: `sender-${name}`, cwd, model: "fixture", ...options.lineage });
  await session.bindExtensions({
    mode: options.hasUI === true ? "rpc" : "print",
    ...(options.hasUI === true ? { uiContext: { ...session.extensionRunner.getUIContext() } } : {}),
    onError: (error) => {
      errors.push(error);
    },
  });
  if (options.waitForRegistration !== false) {
    await registeredSession(sender, session.sessionManager.getSessionId());
  }
  return {
    session,
    runtime,
    dispose,
    faux,
    events,
    errors,
    sender,
    sends,
    context: () => {
      assertDefined(ctx);
      return ctx;
    },
    visible: (id: string) =>
      session.sessionManager
        .getEntries()
        .filter((entry) => entry.type === "custom_message")
        .filter((entry) => inboundId(entry) === id),
    settled: () => events.filter((event) => event.type === "sdk.agent_settled").length,
    send: async (
      id: string,
      input: ReadonlyInput<
        Omit<Parameters<InstanceType<typeof IntercomClient>["send"]>[1], "messageId">
      > = {
        text: `message:${id}`,
      },
    ) => {
      await registeredSession(sender, session.sessionManager.getSessionId());
      sends.push(id);
      const receipt = await sender.send(name, { ...input, messageId: id });
      assert.equal(receipt.accepted, true, JSON.stringify(receipt));
      return receipt;
    },
    status: async () => {
      const tool = registeredTool(session, "intercom");
      return JSON.stringify(
        await tool.execute("fixture-status", { action: "status" }, new AbortController().signal),
      );
    },
  };
}

test("native session renaming after startup updates its broker target without a model turn", async (t) => {
  const receiver = await makeSession(t, "rename-before");
  const registered = observedSession(
    await receiver.sender.listSessions(),
    (peer) => peer.name === "rename-before",
  );
  receiver.session.setSessionName("rename-after");
  await waitFor(
    async () => (await receiver.sender.listSessions()).some((peer) => peer.name === "rename-after"),
    "renamed broker target",
  );
  const peers = await receiver.sender.listSessions();
  assert.equal(
    peers.find((peer) => peer.name === "rename-after")?.id,
    registered.id,
    "renaming retains the same registered owner",
  );
  assert.ok(!peers.some((peer) => peer.name === "rename-before"));
  const receipt = await receiver.sender.send("rename-after", {
    text: "Renamed target",
    messageId: "renamed-passive",
    delivery: "passive",
  });
  assert.equal(receipt.accepted, true);
  await waitFor(
    () => receiver.visible("renamed-passive").length === 1,
    "passive delivery under the updated name",
  );
  assert.equal(receiver.faux.state.callCount, 0);
  assert.deepEqual(receiver.errors, []);
});

test("native steady passive receipts do not rescan old history and still survive tree navigation", async (t) => {
  const receiver = await makeSession(t, "incremental-receipts");
  const manager = receiver.session.sessionManager;
  const historicalIds = new Set<string>();
  for (let index = 0; index < 1_024; index++) {
    historicalIds.add(
      manager.appendCustomMessageEntry("intercom_message", `old receipt ${index}`, false, {
        message: { id: `old-${index}` },
      }),
    );
  }
  const branchPoint = manager.getLeafId();
  const readEntry = manager.getEntry.bind(manager),
    restored = new Set<string>();
  const recoveryRead = t.mock.method(manager, "getEntry", (id: string) => {
    if (historicalIds.has(id)) {
      restored.add(id);
    }
    return readEntry(id);
  });
  const readsAtInput: number[] = [];
  let servicingInput = true,
    input: NodeJS.Immediate;
  const serviceInput = () => {
    readsAtInput.push(restored.size);
    if (servicingInput) {
      input = setImmediate(serviceInput);
    }
  };
  input = setImmediate(serviceInput);
  try {
    await receiver.session.reload();
  } finally {
    servicingInput = false;
    clearImmediate(input);
    recoveryRead.mock.restore();
  }
  assert.equal(restored.size, historicalIds.size, "every historical receipt is restored");
  assert.ok(
    readsAtInput.some((count) => count > 0 && count < historicalIds.size),
    "input must run during receipt restoration",
  );
  await waitFor(
    async () =>
      (await receiver.sender.listSessions()).some((peer) => peer.name === "incremental-receipts"),
    "registration after receipt restore",
  );
  const entriesBefore = manager.getEntries();
  const oldIds = new Set(entriesBefore.map((entry: { readonly id: string }) => entry.id));
  let fullReads = 0,
    oldLookups = 0,
    lookups = 0;
  const readAll = manager.getEntries.bind(manager),
    readOne = manager.getEntry.bind(manager);
  // Count extension reads, not Pi's canonical-context projection on each passive append.
  const observedManager = new Proxy(manager, {
    get(target, key) {
      if (key === "getEntries") {
        return () => {
          fullReads++;
          return readAll();
        };
      }
      if (key === "getEntry") {
        return (id: string) => {
          lookups++;
          if (oldIds.has(id)) {
            oldLookups++;
          }
          return readOne(id);
        };
      }
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== "function") {
        return value;
      }
      return (...args: readonly unknown[]) => {
        const result: unknown = Reflect.apply(value, target, args);
        return result;
      };
    },
  });
  t.mock.getter(receiver.context(), "sessionManager", () => observedManager);
  for (let index = 0; index < 12; index++) {
    const id = `new-${index}`;
    // Observe each native passive receipt before admitting the next message.
    // oxlint-disable-next-line no-await-in-loop
    await receiver.send(id, { text: `passive ${index}`, delivery: "passive" });
    // Receipt indexing is checked after each ordered send.
    // oxlint-disable-next-line no-await-in-loop
    await waitFor(
      () => receiver.events.some((event) => event.type === "sdk.message_end" && event.id === id),
      "native passive receipt",
    );
  }
  t.diagnostic(
    `1,024 historical receipts; 12 passive deliveries; full history reads: ${fullReads}; old entry lookups: ${oldLookups}; total lookups: ${lookups}.`,
  );
  assert.equal(fullReads, 0, "steady inbound reconciliation must not load the old entry list");
  assert.ok(oldLookups <= 1, "the receipt cursor must stop at the already visited boundary");
  assert.equal(receiver.faux.state.callCount, 0, "passive receipts must not wake the model");
  t.mock.restoreAll();
  assert.match(await receiver.status(), /Pending inbound messages: 0/);

  assertDefined(branchPoint);
  await receiver.session.navigateTree(branchPoint, { summarize: false });
  await receiver.send("after-branch", { text: "passive on another branch", delivery: "passive" });
  await waitFor(() => receiver.visible("after-branch").length === 1, "branched passive receipt");
  await receiver.session.reload();
  assert.match(await receiver.status(), /Pending inbound messages: 0/);
  for (const id of receiver.sends) {
    assert.equal(receiver.visible(id).length, 1, id);
  }
  // Retrying an admitted ID must not duplicate its native receipt, including after reload.
  await receiver.send("after-branch", {
    text: "duplicate same-ID payload must not be delivered again",
    delivery: "passive",
  });
  await receiver.send("dedup-barrier", { text: "ordered receive barrier", delivery: "passive" });
  await waitFor(() => receiver.visible("dedup-barrier").length === 1, "later receive processed");
  assert.equal(receiver.visible("after-branch").length, 1);
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
  let initialContext: unknown;
  const seen: string[] = [];
  const receiver = await makeSession(t, "delivery-modes", {
    hasUI: true,
    configure(pi) {
      pi.registerTool({
        name: "hold",
        label: "Hold",
        description: "Fixture gate",
        parameters: Type.Object({}),
        async execute() {
          toolStarted = true;
          await toolGate.promise;
          return { content: [{ type: "text", text: "released" }], details: {} };
        },
      });
    },
  });
  // One-at-a-time steering would let a wrongly steered queue masquerade as a follow-up.
  receiver.session.setSteeringMode("all");
  receiver.faux.setResponses([
    (context: unknown) => {
      initialContext = structuredClone(context);
      return fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" });
    },
    (context: unknown) => {
      seen.push(JSON.stringify(context));
      return fauxAssistantMessage("Current work done");
    },
    (context: unknown) => {
      seen.push(JSON.stringify(context));
      return fauxAssistantMessage("Queued work done");
    },
  ]);
  const running = receiver.session.prompt("Start work");
  await waitFor(() => toolStarted, "native tool execution");
  assert.equal((await receiver.send("steer")).delivered, true);
  await receiver.send("steer", { text: "duplicate steer must not appear" });
  assert.equal(
    (await receiver.send("queued", { text: "message:queued", delivery: "queue" })).delivered,
    true,
  );
  assert.equal(
    (await receiver.send("passive", { text: "message:passive", delivery: "passive" })).delivered,
    true,
  );
  await waitFor(
    async () => (await receiver.status()).includes("Pending inbound messages: 3"),
    "all inbound messages",
  );
  toolGate.resolve();
  await running;
  await waitFor(() => receiver.visible("passive").length === 1, "idle passive flush");
  assert.match(seen[0], /message:steer/);
  assert.doesNotMatch(seen[0], /duplicate steer must not appear/);
  assert.doesNotMatch(seen[0], /message:queued|message:passive/);
  assert.match(seen[1], /message:queued/);
  assert.doesNotMatch(seen[1], /message:passive/);
  const prefix = array(at(initialContext, "messages"));
  assert.ok(prefix.length > 0);
  for (const context of seen) {
    assert.deepEqual(
      array(at(JSON.parse(context), "messages")).slice(0, prefix.length),
      prefix,
      "delivery appends without rewriting the provider's existing prompt prefix",
    );
  }
  for (const id of receiver.sends) {
    assert.equal(receiver.visible(id).length, 1, id);
    assert.equal(receiver.visible(id)[0].customType, "intercom_message");
  }
  assert.equal(receiver.faux.state.callCount, 3);
  assert.equal(receiver.settled(), 1);
  assert.deepEqual(receiver.errors, []);
  t.diagnostic(
    "steer before next response; follow-up after current work; 3 visible once; no replay/passive turn.",
  );
});

for (const { count, reload, repeat } of [
  { count: 2, repeat: true },
  { count: 101 },
  { count: 101, reload: true },
]) {
  let suffix = " without replaying appended followers";
  if (reload === true) {
    suffix = " across an in-flight reload";
  } else if (repeat === true) {
    suffix = " through a second abort";
  }
  const progressPrefix = repeat === true ? "Subagent progress update.\n\n" : "";
  const expectedRequests = repeat === true ? 3 : 2;
  const questionBacklog = count === 101 && reload !== true;
  const questionOptions = questionBacklog ? { expectsReply: true, delivery: "steer" as const } : {};
  test(`native clearQueue plus abort recovers ${count} messages once${suffix}`, async (t) => {
    const responseGate = gate(t);
    const secondResponseGate = gate(t);
    const receiver = await makeSession(
      t,
      `cleared-abort-${count}${reload === true ? "-reload" : ""}`,
    );
    receiver.faux.setResponses([
      async () => {
        await responseGate.promise;
        return fauxAssistantMessage("Cancelled response");
      },
      ...(repeat === true
        ? [
            async () => {
              await secondResponseGate.promise;
              return fauxAssistantMessage("Cancelled recovery response");
            },
          ]
        : []),
      fauxAssistantMessage("Recovered all messages"),
    ]);
    const running = receiver.session.prompt("Start abortable work");
    await waitFor(() => receiver.faux.state.callCount === 1, "active provider request");
    const now = Date.now;
    try {
      Date.now = () => now() - (repeat === true ? 120_000 : 0);
      for (let index = 0; index < count; index++) {
        // Populate native handoffs in send order before the clear.
        // oxlint-disable-next-line no-await-in-loop
        await receiver.send(`cleared-${index}`, {
          text: `${progressPrefix}message:cleared-${index}`,
          ...questionOptions,
        });
      }
    } finally {
      Date.now = now;
    }
    await waitFor(
      async () => (await receiver.status()).includes(`Pending inbound messages: ${count}`),
      "native handoffs",
    );
    if (questionBacklog) {
      const pending = (await executeIntercom(receiver, { action: "pending" })).content[0].text;
      assert.match(pending, /replyTo: "cleared-0"/);
      assert.match(pending, /replyTo: "cleared-100"/);
      const peer = observedSession(
        await receiver.sender.listSessions(),
        (entry) => entry.name === "cleared-abort-101",
      );
      assert.equal(peer.pendingAsks, 101, "accepted questions are not capped at 100");
    }
    if (repeat === true) {
      assert.match(await receiver.status(), /delivered to model queue; not yet consumed/);
      for (const id of receiver.sends) {
        assert.equal(receiver.visible(id).length, 0, "aged handoffs are not yet consumed");
      }
    }
    assert.equal(receiver.session.agent.hasQueuedMessages(), true);
    await receiver.session.sendCustomMessage(
      { customType: "fixture-aside", content: "Next user prompt only", display: false },
      { deliverAs: "nextTurn" },
    );
    receiver.session.clearQueue();
    assert.equal(
      receiver.context().hasPendingMessages(),
      false,
      "a nextTurn aside must not block cleared-message recovery",
    );
    let reloading: Promise<void> | undefined,
      reloadScheduled = false;
    if (reload === true) {
      t.after(
        receiver.session.subscribe((event) => {
          if (
            !reloadScheduled &&
            event.type === "message_end" &&
            inboundId(event.message) === "cleared-1"
          ) {
            reloadScheduled = true;
            setImmediate(() => {
              reloading = receiver.session.reload();
            });
          }
        }),
      );
    }
    receiver.session.agent.abort();
    responseGate.resolve();
    if (repeat === true) {
      await waitFor(() => receiver.faux.state.callCount === 2, "held native recovery request");
      for (const id of receiver.sends) {
        assert.equal(
          receiver.visible(id).length,
          1,
          "the first batch is consumed before later directions",
        );
      }
      for (let index = 0; index < count; index++) {
        // Each new direction must be admitted before its successor.
        // oxlint-disable-next-line no-await-in-loop
        await receiver.send(`second-abort-${index}`);
      }
      await waitFor(
        async () => (await receiver.status()).includes(`Pending inbound messages: ${count}`),
        "new directions during recovery",
      );
      assert.equal(
        receiver.session.agent.hasQueuedMessages(),
        true,
        "the second abort clears actual unconsumed native work",
      );
      for (let index = 0; index < count; index++) {
        assert.equal(receiver.visible(`second-abort-${index}`).length, 0);
      }
      receiver.session.clearQueue();
      receiver.session.agent.abort();
      secondResponseGate.resolve();
    }
    const receiptsAtInput: number[] = [];
    let servicingInput = true,
      input: NodeJS.Immediate;
    const serviceInput = () => {
      receiptsAtInput.push(
        receiver.events.filter(
          (event) =>
            event.type === "sdk.message_end" &&
            typeof event.id === "string" &&
            event.id.startsWith("cleared-"),
        ).length,
      );
      if (servicingInput) {
        input = setImmediate(serviceInput);
      }
    };
    input = setImmediate(serviceInput);
    try {
      await running;
    } finally {
      servicingInput = false;
      clearImmediate(input);
    }
    if (reload === true) {
      await waitFor(() => Boolean(reloading), "reload during recovery");
      await reloading;
    }
    await waitFor(
      () => receiver.settled() >= expectedRequests && receiver.session.isIdle,
      "recovery settlement",
    );
    for (const id of receiver.sends) {
      assert.equal(receiver.visible(id).length, 1, id);
    }
    if (count === 101) {
      assert.ok(
        receiptsAtInput.some((received) => received > 0 && received < count - 1),
        "input must run before the recovery followers finish appending",
      );
    }
    assert.equal(receiver.faux.state.callCount, expectedRequests);
    assert.equal(receiver.settled(), expectedRequests);
    assert.match(await receiver.status(), /Pending inbound messages: 0/);
    assert.deepEqual(receiver.errors, []);
    t.diagnostic(
      `${receiver.sends.length} sends visible once; ${expectedRequests - 1} aborted requests + 1 recovery request; consumed batch followers are not replayed.`,
    );
  });
}

test("native abort during restored busy handoff recovers cleared steers once", async (t) => {
  const responseGate = gate(t);
  const receiver = await makeSession(t, "busy-handoff-abort", { hasUI: true });
  receiver.faux.setResponses([
    async () => {
      await responseGate.promise;
      return fauxAssistantMessage("Cancelled response");
    },
    fauxAssistantMessage("Recovered steers"),
  ]);
  const manager = receiver.session.sessionManager;
  const from = observedSession(
    await receiver.sender.listSessions(),
    (peer) => peer.name === "sender-busy-handoff-abort",
  );
  for (let index = 0; index < 101; index++) {
    const id = `busy-cleared-${index}`;
    receiver.sends.push(id);
    manager.appendCustomEntry("intercom_delivery", {
      sessionId: manager.getSessionId(),
      entry: {
        from,
        message: { id, timestamp: Date.now(), delivery: "steer", content: { text: id } },
        bodyText: id,
        stage: "queued",
        flushDelivery: "steer",
        receivedAt: Date.now(),
      },
    });
  }
  let running: Promise<void> | undefined, aborting: Promise<void> | undefined;
  let scheduled = false,
    nativeQueuedAtClear = false;
  t.after(
    receiver.session.subscribe((event) => {
      if (
        scheduled ||
        event.type !== "entry_appended" ||
        at(event, "entry", "customType") !== "intercom_delivery" ||
        at(event, "entry", "data", "stage") !== "native" ||
        !text(at(event, "entry", "data", "messageId")).startsWith("busy-cleared-")
      ) {
        return;
      }
      scheduled = true;
      setImmediate(() => {
        nativeQueuedAtClear = receiver.session.agent.hasQueuedMessages();
        receiver.session.clearQueue();
        aborting = receiver.session.abort();
        responseGate.resolve();
      });
    }),
  );
  // Both hosts can load extension state into a running SDK prompt.
  await receiver.session.reload({
    beforeSessionStart: async () => {
      running = receiver.session.prompt("Work while saved steers restore");
      await waitFor(() => receiver.faux.state.callCount === 1, "held provider before restoration");
    },
  });
  await waitFor(() => Boolean(aborting), "clearQueue during the busy handoff");
  await running;
  await aborting;
  assert.equal(nativeQueuedAtClear, true, "the clear must remove real native queued work");
  await waitFor(() => receiver.settled() >= 2 && receiver.session.isIdle, "cleared steer recovery");
  for (const id of receiver.sends) {
    assert.equal(receiver.visible(id).length, 1, id);
  }
  assert.equal(receiver.faux.state.callCount, 2);
  assert.match(await receiver.status(), /Pending inbound messages: 0/);
  assert.deepEqual(receiver.errors, []);
});

for (const hasUI of [true, false]) {
  test(`native arrivals during recovery reach the next tool boundary in ${hasUI ? "UI" : "print"} mode`, async (t) => {
    const responseGate = gate(t),
      toolGate = gate(t);
    const name = `recovery-arrival-${hasUI ? "ui" : "print"}`;
    let toolStarted = false,
      seen = "";
    let sends: Promise<unknown[]> | undefined;
    const receiver = await makeSession(t, name, {
      hasUI,
      configure(pi) {
        pi.registerTool({
          name: "hold",
          label: "Hold",
          description: "Held recovery tool",
          parameters: Type.Object({}),
          async execute() {
            toolStarted = true;
            await toolGate.promise;
            return { content: [{ type: "text", text: "Released" }], details: {} };
          },
        });
      },
    });
    receiver.session.setSteeringMode("all");
    receiver.faux.setResponses([
      async () => {
        await responseGate.promise;
        return fauxAssistantMessage("Cancelled response");
      },
      fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
      (context: unknown) => {
        seen = JSON.stringify(context);
        return fauxAssistantMessage("Recovered work finished");
      },
      fauxAssistantMessage("Queued work finished"),
    ]);
    const running = receiver.session.prompt("Start abortable work");
    await waitFor(() => receiver.faux.state.callCount === 1, "active provider");
    for (let index = 0; index < 101; index++) {
      // Recover followers in native admission order.
      // oxlint-disable-next-line no-await-in-loop
      await receiver.send(`recovered-${index}`);
    }
    await waitFor(
      async () => (await receiver.status()).includes("Pending inbound messages: 101"),
      "native handoffs",
    );
    receiver.session.clearQueue();
    let injected = false;
    t.after(
      receiver.session.subscribe((event) => {
        if (
          injected ||
          event.type !== "message_end" ||
          inboundId(event.message) !== "recovered-1"
        ) {
          return;
        }
        injected = true;
        // Native publication reenters synchronously while recovery owns the batch.
        sends = Promise.all([
          receiver.send("new-steer", {
            text: "Steer during recovery",
            delivery: "steer",
            ...(hasUI ? { expectsReply: true } : {}),
          }),
          receiver.send("new-queue", { text: "Ordinary queued message", delivery: "queue" }),
          receiver.send("new-passive", { text: "Passive message", delivery: "passive" }),
        ]);
      }),
    );
    receiver.session.agent.abort();
    responseGate.resolve();
    await waitFor(() => toolStarted, "held recovery tool");
    await sends;
    await waitFor(
      async () => (await receiver.status()).includes("Passive message"),
      "broker arrivals",
    );
    toolGate.resolve();
    await running;
    await waitFor(
      () =>
        receiver.sends.every((id) => receiver.visible(id).length === 1) && receiver.session.isIdle,
      "all arrivals delivered once",
    );
    if (hasUI) {
      const staged = receiver.session.sessionManager
        .getEntries()
        .find(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === "intercom_delivery" &&
            at(entry, "data", "entry", "message", "id") === "new-steer",
        );
      assert.equal(
        at(staged, "data", "entry", "flushDelivery"),
        "steer",
        "exercise arrival staging during the batch, rather than direct busy admission",
      );
    }
    assert.match(seen, /Steer during recovery/);
    assert.doesNotMatch(seen, /Ordinary queued message|Passive message/);
    for (const id of receiver.sends) {
      assert.equal(receiver.visible(id).length, 1, id);
    }
    assert.match(await receiver.status(), /Pending inbound messages: 0/);
    assert.deepEqual(receiver.errors, []);
  });
}

test("native abort retaining custom queues does not enqueue a second copy", async (t) => {
  const responseGate = gate(t);
  const receiver = await makeSession(t, "retained-abort");
  receiver.faux.setResponses([
    async () => {
      await responseGate.promise;
      return fauxAssistantMessage("Cancelled response");
    },
    fauxAssistantMessage("Steered work"),
    fauxAssistantMessage("Follow-up work"),
  ]);
  const running = receiver.session.prompt("Start abortable work");
  await waitFor(() => receiver.faux.state.callCount === 1, "active provider request");
  await receiver.send("retained-steer");
  await receiver.send("retained-queue", { text: "retained follow-up", delivery: "queue" });
  await waitFor(
    async () => (await receiver.status()).includes("Pending inbound messages: 2"),
    "native custom queues",
  );
  assert.equal(receiver.session.agent.hasQueuedMessages(), true);
  const aborting = receiver.session.abort();
  responseGate.resolve();
  await running;
  await aborting;
  assert.match(await receiver.status(), /Pending inbound messages: 2/);
  assert.equal(receiver.faux.state.callCount, 1);
  assert.equal(receiver.session.agent.hasQueuedMessages(), true);
  await receiver.session.reload();
  assert.equal(receiver.session.agent.hasQueuedMessages(), true);
  await receiver.session.prompt("Resume retained work");
  for (const id of receiver.sends) {
    assert.equal(receiver.visible(id).length, 1, id);
  }
  assert.equal(receiver.faux.state.callCount, 3);
  assert.match(await receiver.status(), /Pending inbound messages: 0/);
  assert.deepEqual(receiver.errors, []);
  t.diagnostic(
    "retained native queues survive reload; next prompt delivers both once, without a recovery-only turn.",
  );
});

for (const recovery of [false, true]) {
  test(`native ${recovery ? "recovered plain/ask" : "explicit queued passive/plain/multi-ask"} batch keeps the selected ask as the default reply target`, async (t) => {
    const hold = gate(t);
    let started = false,
      replyContext = "";
    const receiver = await makeSession(t, `ask-batch-priority-${recovery ? "recovery" : "idle"}`, {
      hasUI: true,
      configure(pi) {
        pi.registerTool({
          name: "hold",
          label: "Hold",
          description: "Fixture gate",
          parameters: Type.Object({}),
          async execute() {
            started = true;
            await hold.promise;
            return { content: [{ type: "text", text: "Released" }], details: {} };
          },
        });
      },
    });
    const replies: string[] = [];
    receiver.sender.on(
      "message",
      (_from: ReadonlyInput<SessionInfo>, message: ReadonlyInput<Message>) => {
        if (
          message.replyTo !== undefined &&
          message.content.text === "Answer the selected first ask"
        ) {
          replies.push(message.replyTo);
        }
      },
    );
    receiver.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
      ...(recovery ? [] : [fauxAssistantMessage("Current work finished")]),
      (context: unknown) => {
        replyContext = JSON.stringify(context);
        return fauxAssistantMessage(
          fauxToolCall("intercom", { action: "reply", message: "Answer the selected first ask" }),
          { stopReason: "toolUse" },
        );
      },
      fauxAssistantMessage("Answer sent"),
    ]);
    const running = receiver.session.prompt("Hold before the ask batch");
    await waitFor(() => started, "busy native tool");
    if (!recovery) {
      await receiver.send("passive-first", { text: "Passive breadcrumb.", delivery: "passive" });
    }
    await receiver.send("plain-before-ask", {
      text: "Plain leftover.",
      delivery: recovery ? "steer" : "queue",
      ...(!recovery ? { queueMode: "replace", threadId: "plain-thread" } : {}),
    });
    for (const id of recovery ? ["first-ask"] : ["first-ask", "second-ask"]) {
      // Establish each ask's admission before adding its successor.
      // oxlint-disable-next-line no-await-in-loop
      await receiver.send(id, {
        text: `Question ${id}`,
        expectsReply: true,
        ...(recovery
          ? { delivery: "steer" }
          : { delivery: "queue", queueMode: "replace", threadId: id }),
      });
      // Broker acknowledgement alone does not prove native staging.
      // oxlint-disable-next-line no-await-in-loop
      await waitFor(async () => (await receiver.status()).includes(`Question ${id}`), "staged ask");
    }
    if (recovery) {
      assert.equal(receiver.session.agent.hasQueuedMessages(), true);
      receiver.session.clearQueue();
      receiver.session.agent.abort();
    }
    hold.resolve();
    await running;
    await waitFor(() => receiver.session.isIdle && replies.length === 1, "default reply delivery");
    if (!recovery) {
      assert.match(replyContext, /Passive breadcrumb/);
    }
    assert.match(replyContext, /Plain leftover/);
    assert.match(replyContext, /Question first-ask/);
    const ids = receiver.session.sessionManager
      .getEntries()
      .filter((entry) => entry.type === "custom_message")
      .map(inboundId);
    if (!recovery) {
      assert.ok(
        ids.indexOf("passive-first") < ids.indexOf("first-ask"),
        "passive publication precedes the selected ask",
      );
    }
    assert.ok(
      ids.indexOf("plain-before-ask") < ids.indexOf("first-ask"),
      "plain follower publication precedes the selected ask",
    );
    assert.deepEqual(
      replies,
      ["first-ask"],
      "trigger-last must not switch the implicit reply to a follower ask",
    );
    const intercom = registeredTool(receiver.session, "intercom");
    const pending = await intercom.execute(
      "remaining-ask",
      { action: "pending" },
      new AbortController().signal,
    );
    if (!recovery) {
      assert.match(JSON.stringify(pending), /second-ask/);
    }
    assert.doesNotMatch(JSON.stringify(pending), /first-ask/);
    for (const id of receiver.sends) {
      assert.equal(receiver.visible(id).length, 1, id);
      assert.equal(
        JSON.stringify(receiver.visible(id)[0].content).includes("To reply"),
        ["first-ask", "second-ask"].includes(id),
        id,
      );
    }
    assert.equal(receiver.faux.state.callCount, recovery ? 3 : 4);
    assert.match(await receiver.status(), /Pending inbound messages: 0/);
    assert.deepEqual(receiver.errors, []);
    receiver.events.push({ type: "fixture.default_reply", replies });
    t.diagnostic(
      "Actual provider context sees followers before the real intercom reply targets the selected ask; passive and multi-ask idle ordering stay distinct from abort recovery.",
    );
  });
}

test("native concurrent asks reserve one reply waiter after a completed ask", async (t) => {
  const results: Array<{ toolCallId: string; isError: boolean; content: unknown }> = [];
  const asker = await makeSession(t, "concurrent-asks", {
    configure(pi) {
      pi.on("tool_result", (event) => {
        results.push(event);
      });
    },
  });
  const received: ReadonlyInput<Message>[] = [];
  asker.sender.on(
    "message",
    (_from: ReadonlyInput<SessionInfo>, message: ReadonlyInput<Message>) => {
      if (message.expectsReply === true) {
        received.push(message);
      }
    },
  );
  const ask = (id: string) =>
    fauxToolCall(
      "intercom",
      {
        action: "ask",
        to: "sender-concurrent-asks",
        message: id,
        delivery: "steer",
      },
      { id },
    );
  const reply = async (question: ReadonlyInput<Message>) => {
    const receipt = await asker.sender.send("concurrent-asks", {
      text: `answer:${question.content.text}`,
      replyTo: question.id,
      messageId: `reply-${question.content.text}`,
    });
    assert.equal(receipt.accepted, true);
  };
  const completedAsk = async (id: string) => {
    asker.faux.setResponses([
      fauxAssistantMessage(ask(id), { stopReason: "toolUse" }),
      fauxAssistantMessage("Reply received"),
    ]);
    const running = asker.session.prompt(id);
    await waitFor(() => received.some((message) => message.content.text === id), id);
    const question = received.find((message) => message.content.text === id);
    assertDefined(question);
    await reply(question);
    await running;
    assert.equal(results.find((result) => result.toolCallId === id)?.isError, false);
    assert.match(
      JSON.stringify(results.find((result) => result.toolCallId === id)?.content),
      new RegExp(`answer:${id}`),
    );
  };
  await completedAsk("before");

  asker.faux.setResponses([
    fauxAssistantMessage([ask("contender-a"), ask("contender-b")], { stopReason: "toolUse" }),
    fauxAssistantMessage("Concurrent asks handled"),
  ]);
  const concurrent = asker.session.prompt("Ask both peers concurrently");
  await waitFor(
    () =>
      received.length >= 2 &&
      results.some((result) => result.toolCallId.startsWith("contender-") && result.isError),
    "contender rejection",
  );
  const rejected = results.filter(
    (result) => result.toolCallId.startsWith("contender-") && result.isError,
  );
  assert.equal(rejected.length, 1, "rejecting the contender must not reject the winning waiter");
  assert.match(JSON.stringify(rejected[0].content), /Already waiting for a reply/);
  assert.equal(received.length, 2, "only one concurrent ask may reach the peer");
  const winner = received[1];
  assert.notEqual(winner.content.text, rejected[0].toolCallId);
  await reply(winner);
  await concurrent;
  const winningResult = results.find((result) => result.toolCallId === winner.content.text);
  assert.equal(winningResult?.isError, false);
  assert.match(JSON.stringify(winningResult.content), new RegExp(`answer:${winner.content.text}`));

  await completedAsk("after");
  assert.deepEqual(
    received.map((message) => message.content.text),
    ["before", winner.content.text, "after"],
  );
  const calls = asker.faux.state.callCount;
  for (const reload of [false, true]) {
    if (reload) {
      // oxlint-disable-next-line no-await-in-loop
      await asker.session.reload();
    }
    // oxlint-disable-next-line no-await-in-loop
    await asker.send("reply-before", {
      text: "Duplicate answered reply",
      replyTo: received[0].id,
      delivery: "passive",
    });
    const barrier = `reply-dedup-${reload}`;
    // oxlint-disable-next-line no-await-in-loop
    await asker.send(barrier, { text: "Ordered receive barrier", delivery: "passive" });
    // oxlint-disable-next-line no-await-in-loop
    await waitFor(() => asker.visible(barrier).length === 1, "reply replay processed");
    assert.equal(asker.visible("reply-before").length, 0);
    assert.equal(asker.faux.state.callCount, calls);
  }
  assert.deepEqual(asker.errors, []);
});

test("native rejected input leaves the active intercom run and idle wait intact", async (t) => {
  const inputRelease = gate(t);
  const responseRelease = gate(t);
  const losingInput = "User input held before admission";
  const preflight: unknown[] = [];
  const beforeStarts: unknown[] = [];
  let inputHeld = false,
    seen = "";
  const receiver = await makeSession(t, "input-rejection", {
    configure(pi) {
      pi.on("input", async (event) => {
        if (event.text === losingInput) {
          inputHeld = true;
          await inputRelease.promise;
        }
      });
      pi.on("before_agent_start", (event) => {
        beforeStarts.push("messageType" in event ? property(event, "messageType") : "user");
      });
    },
  });
  receiver.faux.setResponses([
    async (context: unknown) => {
      seen = JSON.stringify(context);
      await responseRelease.promise;
      return fauxAssistantMessage("Owned intercom work finished");
    },
  ]);
  const rejected = assert.rejects(
    receiver.session.prompt(losingInput, {
      preflightResult: (disposition: unknown) => {
        preflight.push(disposition);
      },
    }),
    /already processing/,
  );
  try {
    await waitFor(() => inputHeld, "held input interception");
    await receiver.send("input-owner");
    await waitFor(() => receiver.faux.state.callCount === 1, "custom-owned provider request");
    const expectedStarts = beforeStarts.includes("custom") ? ["custom"] : [];
    const signal = receiver.context().signal;
    const systemPrompt = receiver.session.systemPrompt;
    assert.ok(signal && !signal.aborted);
    let idleResolved = false;
    const idle = (async () => {
      await receiver.session.waitForIdle();
      idleResolved = true;
    })();
    inputRelease.resolve();
    await rejected;
    receiver.events.push({
      type: "fixture.input_rejection",
      preflight: [...preflight],
      beforeStarts: [...beforeStarts],
      idle: receiver.session.isIdle,
      streaming: receiver.session.isStreaming,
      signalUnchanged: receiver.context().signal === signal,
      idleResolved,
      settled: receiver.settled(),
    });
    assert.deepEqual(
      preflight,
      [],
      "rejection must not report handled, queued or started admission",
    );
    assert.equal(receiver.context().signal, signal);
    assert.equal(signal.aborted, false);
    assert.equal(receiver.session.systemPrompt, systemPrompt);
    assert.equal(receiver.session.isStreaming, true);
    assert.equal(receiver.context().isIdle(), false);
    assert.equal(
      idleResolved,
      false,
      "a rejected input cannot release the owning run's idle waiter",
    );
    assert.equal(receiver.settled(), 0);
    assert.deepEqual(
      beforeStarts,
      expectedStarts,
      "only the owning custom run may prepare; rejected user input must not prepare replay",
    );
    assert.equal(receiver.faux.state.callCount, 1);
    assert.equal(receiver.visible("input-owner").length, 1);
    responseRelease.resolve();
    await idle;
    assert.equal(idleResolved, true);
    assert.equal(receiver.settled(), 1);
    assert.equal(receiver.context().isIdle(), true);
    assert.equal(receiver.context().signal, undefined);
    assert.equal(receiver.context().hasPendingMessages(), false);
    assert.deepEqual(beforeStarts, expectedStarts);
    assert.equal(receiver.faux.state.callCount, 1);
    assert.equal(receiver.visible("input-owner").length, 1);
    assert.equal(seen.split("message:input-owner").length - 1, 1);
    assert.doesNotMatch(seen, /User input held before admission/);
    assert.deepEqual(preflight, [], "rejection must not later report accepted admission");
    assert.deepEqual(
      receiver.events
        .filter((event) => event.type === "extension.message_end" && event.role === "assistant")
        .map((event) => event.stopReason),
      ["stop"],
    );
    assert.match(await receiver.status(), /Pending inbound messages: 0/);
    assert.deepEqual(receiver.errors, []);
    receiver.events.push({
      type: "fixture.input_complete",
      providerContext: seen,
      idleResolved,
      settled: receiver.settled(),
    });
    t.diagnostic(
      "Real losing input rejects once; the original custom signal, busy state and idle wait survive; one visible custom receipt, one clean provider call and one true settlement.",
    );
  } finally {
    inputRelease.resolve();
    responseRelease.resolve();
    await Promise.allSettled([rejected, receiver.session.agent.waitForIdle()]);
  }
});

test("native user preparation preserves both inputs through separate admission or busy-start steering", async (t) => {
  const startupRelease = gate(t);
  const userPrompt = "User startup held before the agent runs";
  let beforeStarts = 0;
  let inputHeld = false;
  const host = { customStartEvents: false };
  const seen: string[] = [];
  const receiver = await makeSession(t, "startup-queued", {
    configure(pi) {
      pi.on("before_agent_start", async (event) => {
        beforeStarts++;
        host.customStartEvents = "messageType" in event;
        if ("prompt" in event && event.prompt === userPrompt) {
          inputHeld = true;
          await startupRelease.promise;
        }
      });
    },
  });
  receiver.faux.setResponses([
    (context: unknown) => {
      seen.push(JSON.stringify(context));
      return fauxAssistantMessage("First request handled");
    },
    (context: unknown) => {
      seen.push(JSON.stringify(context));
      return fauxAssistantMessage("Second request handled");
    },
  ]);
  const running = receiver.session.prompt(userPrompt);
  try {
    await waitFor(() => inputHeld, "held user preparation");
    const preparationIdle = receiver.context().isIdle();
    assert.equal(preparationIdle, !host.customStartEvents);
    receiver.events.push({
      type: "fixture.user_preparation",
      idle: preparationIdle,
      streaming: receiver.session.isStreaming,
      beforeStarts,
      providerCalls: receiver.faux.state.callCount,
    });
    assert.equal(receiver.faux.state.callCount, 0);
    await receiver.send("startup-queued");
    if (preparationIdle) {
      await waitFor(
        () => receiver.settled() === 1 && receiver.session.isIdle,
        "separate custom run settlement before user admission",
      );
      assert.equal(receiver.faux.state.callCount, 1);
      assert.equal(receiver.visible("startup-queued").length, 1);
      assert.doesNotMatch(seen[0], /User startup held before the agent runs/);
      assert.equal(seen[0].split("message:startup-queued").length - 1, 1);
    } else {
      await waitFor(
        () =>
          receiver.session.agent
            .peekQueuedMessages()
            .some((message) => inboundId(message) === "startup-queued"),
        "native steering receipt during busy preparation",
      );
      assert.equal(receiver.context().isIdle(), false);
      assert.equal(receiver.faux.state.callCount, 0);
      assert.equal(receiver.settled(), 0);
      assert.equal(receiver.visible("startup-queued").length, 0);
    }
    assert.equal(beforeStarts, 1, "busy delivery queues without preparing another run");
    startupRelease.resolve();
    await running;
    await receiver.session.waitForIdle();
    assert.equal(beforeStarts, 1);
    const requests = preparationIdle ? 2 : 1;
    assert.equal(receiver.faux.state.callCount, requests);
    assert.equal(receiver.settled(), requests);
    assert.equal(receiver.visible("startup-queued").length, 1);
    const users = receiver.session.sessionManager
      .getEntries()
      .filter(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "user" &&
          JSON.stringify(entry.message.content).includes(userPrompt),
      );
    assert.equal(users.length, 1);
    const owningContext = seen.at(-1);
    assertDefined(owningContext);
    for (const body of [userPrompt, "message:startup-queued"]) {
      assert.equal(owningContext.split(body).length - 1, 1, body);
    }
    assert.equal(
      receiver.events.filter(
        (event) => event.type === "extension.message_end" && event.id === "startup-queued",
      ).length,
      1,
      "custom input publishes one native receipt",
    );
    assert.equal(receiver.context().isIdle(), true);
    assert.equal(receiver.context().signal, undefined);
    assert.equal(receiver.context().hasPendingMessages(), false);
    assert.deepEqual(
      receiver.events
        .filter((event) => event.type === "extension.message_end" && event.role === "assistant")
        .map((event) => event.stopReason),
      Array.from({ length: requests }, () => "stop"),
    );
    assert.match(await receiver.status(), /Pending inbound messages: 0/);
    assert.deepEqual(receiver.errors, []);
    receiver.events.push({
      type: "fixture.startup_complete",
      providerContexts: seen,
      settled: receiver.settled(),
    });
    t.diagnostic(
      preparationIdle
        ? "User-only preparation is idle: custom input runs separately, then user admission retains both inputs once."
        : "Discriminated preparation is busy: native steering preserves both inputs once in the owning request.",
    );
  } finally {
    startupRelease.resolve();
    await running;
  }
});

test("native recovery, compaction, and reload preserve receipts without replaying consumed messages", async (t) => {
  const originalResponse = gate(t);
  const recoveryResponse = gate(t);
  const receiver = await makeSession(t, "compact-reload");
  receiver.faux.setResponses([
    async () => {
      await originalResponse.promise;
      return fauxAssistantMessage("Aborted");
    },
    async () => {
      await recoveryResponse.promise;
      return fauxAssistantMessage("Handled");
    },
    fauxAssistantMessage("Fresh window"),
    fauxAssistantMessage("Continued"),
  ]);
  const running = receiver.session.prompt("Start abortable work");
  await waitFor(() => receiver.faux.state.callCount === 1, "original provider request");
  await receiver.send("trigger");
  await receiver.send("appended-follower");
  await waitFor(
    async () => (await receiver.status()).includes("Pending inbound messages: 2"),
    "two native handoffs",
  );
  receiver.session.clearQueue();
  receiver.session.agent.abort();
  originalResponse.resolve();
  await waitFor(() => receiver.faux.state.callCount === 2, "recovery provider request");
  const resetContext = property(receiver.session, "newContext");
  const canResetContext = typeof resetContext === "function";
  if (typeof resetContext === "function") {
    const result: unknown = Reflect.apply(resetContext, receiver.session, [
      { handoff: "The intercom messages were handled." },
    ]);
    await Promise.resolve(result);
  }
  recoveryResponse.resolve();
  // Pi joins settlement-triggered runs; release recovery before awaiting the original prompt.
  await running;
  await waitFor(() => receiver.settled() >= 2 && receiver.session.isIdle, "recovery boundary");
  if (canResetContext) {
    assert.equal(
      receiver.session.messages.some(
        (message: unknown) => inboundId(message) === "appended-follower",
      ),
      false,
    );
  }
  assert.equal(receiver.visible("appended-follower").length, 1);
  assert.deepEqual(
    receiver.session.sessionManager
      .getEntries()
      .filter((entry) => entry.type === "custom_message")
      .map((entry) => inboundId(entry))
      .filter((id) => id === "trigger" || id === "appended-follower"),
    ["trigger", "appended-follower"],
    "recovery keeps admission order",
  );
  assert.equal(
    receiver.events.filter(
      (event) => event.type === "extension.message_end" && event.id === "trigger",
    ).length,
    0,
  );
  assert.match(await receiver.status(), /Pending inbound messages: 0/);

  await receiver.session.prompt("Continue after recovery");
  await receiver.session.compact();
  assert.ok(
    receiver.session.sessionManager
      .getEntries()
      .some((entry: { readonly type: string }) => entry.type === "compaction"),
  );
  await receiver.session.reload();
  assert.equal(
    receiver.events.filter(
      (event) => event.type === "extension.session_start" && event.reason === "reload",
    ).length,
    1,
  );
  await receiver.session.prompt("Continue after reload");
  for (const id of receiver.sends) {
    assert.equal(receiver.visible(id).length, 1, id);
  }
  assert.equal(receiver.faux.state.callCount, 4);
  assert.match(await receiver.status(), /Pending inbound messages: 0/);
  assert.deepEqual(receiver.errors, []);
  t.diagnostic(
    "recovery retains each receipt once in history; actual compact/reload never replays it; optional context reset also prunes the active window.",
  );
});

test("native unresolved ordinary ask restores through recipient reload and replies with its correlation", async (t) => {
  const recipient = await makeSession(t, "reload-recipient");
  recipient.faux.setResponses([fauxAssistantMessage("Question received")]);
  await recipient.send("reload-question", {
    text: "Which native path?",
    expectsReply: true,
    delivery: "steer",
  });
  await waitFor(
    async () =>
      recipient.settled() === 1 &&
      (await recipient.sender.listSessions()).find((peer) => peer.name === "reload-recipient")
        ?.pendingAsks === 1,
    "published correlated ask and presence",
  );
  await recipient.session.reload();
  await waitFor(
    async () =>
      (await recipient.sender.listSessions()).some((peer) => peer.name === "reload-recipient"),
    "reloaded recipient registration",
  );
  const response = once(recipient.sender, "message");
  await executeIntercom(recipient, {
    action: "reply",
    replyTo: "reload-question",
    message: "Use the native receipt.",
  });
  const [, reply] = array(await response);
  assert.equal(at(reply, "replyTo"), "reload-question");
  assert.equal(at(reply, "content", "text"), "Use the native receipt.");
  assert.equal(recipient.visible("reload-question").length, 1);
  assert.equal(recipient.faux.state.callCount, 1);
  assert.match(
    JSON.stringify(await executeIntercom(recipient, { action: "pending" })),
    /No unresolved inbound asks/,
  );
  const presence = (await recipient.sender.listSessions()).find(
    (peer) => peer.name === "reload-recipient",
  );
  assert.equal(presence?.pendingAsks, 0);
  await recipient.send("reload-question", {
    text: "Retry of the answered ask",
    expectsReply: true,
  });
  await recipient.send("answered-ask-barrier", {
    text: "Ordered receive barrier",
    delivery: "passive",
  });
  await waitFor(
    () => recipient.visible("answered-ask-barrier").length === 1,
    "answered ask retry processed",
  );
  assert.match(
    JSON.stringify(await executeIntercom(recipient, { action: "pending" })),
    /No unresolved inbound asks/,
  );
  assert.equal(recipient.visible("reload-question").length, 1);
  assert.equal(recipient.faux.state.callCount, 1);
  assert.deepEqual(recipient.errors, []);
});

test("native correlated steer reaches the native queue during a held tool and is answered after it", async (t) => {
  const release = gate(t);
  let started = false,
    sawQuestion = false;
  const recipient = await makeSession(t, "busy-question-recipient", {
    hasUI: true,
    configure(pi) {
      pi.registerTool({
        name: "held_wait",
        label: "Held wait",
        description: "Controlled native wait",
        parameters: Type.Object({}),
        async execute() {
          started = true;
          await release.promise;
          return { content: [{ type: "text", text: "Released" }], details: {} };
        },
      });
    },
  });
  const asker = await makeSession(t, "busy-question-asker");
  recipient.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("held_wait", {}), { stopReason: "toolUse" }),
    (context) => {
      sawQuestion = JSON.stringify(context).includes("Choose the native path?");
      return fauxAssistantMessage(
        fauxToolCall("intercom", { action: "reply", message: "Use the native path." }),
        { stopReason: "toolUse" },
      );
    },
    fauxAssistantMessage("Recipient continued"),
  ]);
  asker.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("intercom", {
        action: "ask",
        to: "busy-question-recipient",
        delivery: "steer",
        message: "Choose the native path?",
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Asker continued"),
  ]);
  const receiving = recipient.session.prompt("Wait for an ordinary peer");
  await waitFor(() => started, "controlled native tool");
  const asking = asker.session.prompt("Ask before continuing");
  await waitFor(() => {
    const stages = recipient.session.sessionManager
      .getEntries()
      .filter((entry) => entry.type === "custom" && entry.customType === "intercom_delivery");
    const last = at(stages.at(-1), "data");
    return (at(last, "stage") ?? at(last, "entry", "stage")) === "native";
  }, "correlated steer reaches the native queue while the tool is held");
  assert.equal(recipient.faux.state.callCount, 1, "the busy tool still owns the turn");
  release.resolve();
  await Promise.all([receiving, asking]);
  assert.equal(sawQuestion, true);
  assert.equal(recipient.faux.state.callCount, 3);
  assert.equal(asker.faux.state.callCount, 2);
  assert.match(JSON.stringify(asker.session.messages), /Use the native path/);
  assert.deepEqual([...recipient.errors, ...asker.errors], []);
});

test("native peer metadata never elevates ordinary context to human authority", async (t) => {
  const receiver = await makeSession(t, "ordinary-origin");
  let seen = "";
  receiver.faux.setResponses([
    (context) => {
      seen = JSON.stringify(context);
      return fauxAssistantMessage("Peer note handled");
    },
  ]);
  await receiver.send("peer-origin", {
    text: "Keep the API unchanged.",
    delivery: "steer",
    human: { ownerSessionId: "untrusted-owner", runId: "old-run", index: 0 },
    attachments: [
      { type: "context", name: "Selected edit", content: "Literal full proposed edit" },
    ],
  });
  await waitFor(() => receiver.settled() === 1, "ordinary peer settlement");
  assert.equal(receiver.visible("peer-origin").length, 1);
  assert.equal(receiver.visible("peer-origin")[0].customType, "intercom_message");
  assert.match(seen, /From sender-ordinary-origin/);
  assert.match(seen, /Literal full proposed edit/);
  assert.doesNotMatch(seen, /Direct user message|human origin/);
  assert.deepEqual(receiver.errors, []);
});

for (const boundary of ["reload", "dispose"] as const) {
  test(`native ${boundary} joins admitted socket registration before invalidation and preserves other broker clients`, async (t) => {
    const receiver = await makeSession(t, `shutdown-connect-${boundary}`);
    const enteredShutdown = gate(t);
    const original: unknown = Reflect.get(net.Socket.prototype, "write");
    assert.equal(typeof original, "function");
    if (typeof original !== "function") {
      throw new Error("Socket write unavailable");
    }
    let held:
      | { readonly socket: net.Socket; readonly args: Parameters<net.Socket["write"]> }
      | undefined;
    let captured = false,
      flushed = false;
    t.mock.method(
      net.Socket.prototype,
      "write",
      function (this: net.Socket, ...args: Parameters<net.Socket["write"]>) {
        const chunk = args[0];
        if (
          !captured &&
          Buffer.isBuffer(chunk) &&
          chunk.subarray(4).toString().includes(`"name":"shutdown-connect-${boundary}"`) &&
          chunk.subarray(4).toString().includes('"type":"register"')
        ) {
          held = { socket: this, args };
          captured = true;
          return true;
        }
        const result: unknown = Reflect.apply(original, this, args);
        return result === true;
      },
    );
    const flushHeld = () => {
      if (held && !flushed) {
        flushed = true;
        Reflect.apply(original, held.socket, held.args);
      }
    };
    t.after(flushHeld);
    await receiver.session.reload();
    await waitFor(
      () => held !== undefined,
      "real socket registration awaiting broker acknowledgement",
    );
    assertDefined(held);
    const outgoing = receiver.session.extensionRunner;
    const emit = outgoing.emit.bind(outgoing);
    t.mock.method(outgoing, "emit", (...args: Parameters<typeof emit>) => {
      if (args[0].type === "session_shutdown") {
        enteredShutdown.resolve();
      }
      return emit(...args);
    });
    let reloaded = false;
    const replacing = (async () => {
      if (boundary === "dispose") {
        await receiver.dispose();
      } else {
        await receiver.session.reload();
      }
      reloaded = true;
    })();
    await enteredShutdown.promise;
    assert.equal(reloaded, false, "native shutdown must join the admitted registration");
    assert.equal(
      receiver.context().hasUI,
      false,
      "outgoing context remains valid until shutdown joins",
    );
    let invalidatedAfterJoin = false;
    receiver.runtime.setBeforeSessionInvalidate(() => {
      assert.equal(held?.socket.destroyed, true);
      assert.doesNotThrow(() => receiver.context().sessionManager.getSessionId());
      invalidatedAfterJoin = true;
    });
    flushHeld();
    await replacing;
    assert.equal(held.socket.destroyed, true);
    if (boundary === "dispose") {
      assert.equal(invalidatedAfterJoin, true);
      assert.throws(() => receiver.context().sessionManager.getSessionId(), /stale|disposed/i);
      assert.ok(
        !(await receiver.sender.listSessions()).some(
          (peer) => peer.name === `shutdown-connect-${boundary}`,
        ),
      );
      assert.deepEqual(receiver.errors, []);
      return;
    }
    assert.equal(
      receiver.sender.isConnected(),
      true,
      "shutdown must preserve another broker client",
    );
    await waitFor(
      async () =>
        (await receiver.sender.listSessions()).some(
          (peer) => peer.name === `shutdown-connect-${boundary}`,
        ),
      "successor registration",
    );
    await receiver.send("successor-barrier", {
      text: "Successor processed real input",
      delivery: "passive",
    });
    await waitFor(
      () => receiver.visible("successor-barrier").length === 1,
      "successor processing barrier",
    );
    assert.equal(receiver.faux.state.callCount, 0);
    receiver.runtime.setBeforeSessionInvalidate();
    assert.deepEqual(receiver.errors, []);
  });
}

test("native prior delegation calls and results remain in provider context after reload", async (t) => {
  let seen = "";
  const receiver = await makeSession(t, "prior-delegation", {
    configure(pi) {
      pi.registerTool({
        name: "delegate",
        label: "Delegate fixture",
        description: "Native historical tool receipt",
        parameters: Type.Object({ prompt: Type.String() }),
        async execute() {
          return {
            content: [{ type: "text", text: "Literal complete delegated result" }],
            details: { retained: true },
          };
        },
      });
    },
  });
  receiver.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall(
        "delegate",
        { prompt: "Entire invoking agent prompt" },
        { id: "historical-delegation" },
      ),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Delegation finished"),
    (context) => {
      seen = JSON.stringify(context);
      return fauxAssistantMessage("History retained");
    },
  ]);
  await receiver.session.prompt("Do the fixture delegation");
  await receiver.session.reload();
  await receiver.session.prompt("Read the earlier native call and result");
  assert.match(seen, /historical-delegation/);
  assert.match(seen, /Entire invoking agent prompt/);
  assert.match(seen, /Literal complete delegated result/);
  const results = receiver.session.sessionManager
    .getEntries()
    .filter((entry) => entry.type === "message" && entry.message.role === "toolResult");
  assert.equal(results.length, 1);
  assert.equal(at(results[0], "message", "toolCallId"), "historical-delegation");
  assert.deepEqual(receiver.errors, []);
});

test("native explicit lineage scopes discovery, send and last across unrelated directories", async (t) => {
  const main = await makeSession(t, "group-main");
  const rootSessionId = main.session.sessionManager.getSessionId();
  const lineage = { rootSessionId, parentSessionId: rootSessionId };
  const child = await makeSession(t, "group-child", { lineage });
  const sibling = await makeSession(t, "group-sibling", { lineage });
  const otherMain = await makeSession(t, "other-main");
  const foreignRoot = otherMain.session.sessionManager.getSessionId();
  const otherChild = await makeSession(t, "other-child", {
    lineage: { rootSessionId: foreignRoot, parentSessionId: foreignRoot },
  });
  const list = JSON.stringify(await executeIntercom(child, { action: "list" }));
  assert.match(list, /group-main/);
  assert.match(list, /group-sibling/);
  assert.doesNotMatch(list, /other-main|other-child/);
  const mains = JSON.stringify(await executeIntercom(main, { action: "list" }));
  assert.match(mains, /other-main/);
  assert.doesNotMatch(mains, /other-child/);
  const registered = await child.sender.listSessions();
  const childPresence = registered.find((peer) => peer.name === "group-child");
  assertDefined(childPresence);
  assert.equal(childPresence.rootSessionId, rootSessionId);
  assert.equal(childPresence.parentSessionId, rootSessionId);
  const other = (await otherMain.sender.listSessions()).find((peer) => peer.name === "other-main");
  assertDefined(other);
  const hidden = (await otherChild.sender.listSessions()).find(
    (peer) => peer.name === "other-child",
  );
  assertDefined(hidden);
  assert.equal(
    (await child.sender.send(other.id, { text: "Forbidden direct target" })).accepted,
    false,
  );
  assert.ok("error" in (await child.sender.last(other.id)));
  assert.equal(
    (await main.sender.send(hidden.id, { text: "Forbidden foreign child" })).accepted,
    false,
  );
  assert.ok("error" in (await main.sender.last(hidden.id)));
  const response = await executeIntercom(child, { action: "last", to: "group-sibling" });
  assert.equal(record(response.details).entryId, null);
  assert.equal(sibling.faux.state.callCount, 0);
  assert.deepEqual(
    [...main.errors, ...child.errors, ...sibling.errors, ...otherMain.errors, ...otherChild.errors],
    [],
  );
});

for (const stopReason of ["stop", "length"] as const) {
  test(`native last reads the latest ${stopReason} response in full pages without waking a busy peer`, async (t) => {
    const release = gate(t);
    const reader = await makeSession(t, `last-reader-${stopReason}`);
    const targetName = `last-target-${stopReason}`;
    const target = await makeSession(t, targetName);
    const empty = record(
      (await executeIntercom(reader, { action: "last", to: targetName })).details,
    );
    assert.equal(empty.entryId, null);
    assert.equal(empty.text, "");
    assert.equal(target.faux.state.callCount, 0);
    const body = "Original assistant response 日本語 😀\n".repeat(2200);
    target.faux.setResponses([
      fauxAssistantMessage("Older completed response"),
      fauxAssistantMessage(body, { stopReason }),
      async () => {
        await release.promise;
        return fauxAssistantMessage("Newer response");
      },
    ]);
    await target.session.prompt("Publish an older response");
    await target.session.prompt("Publish the latest response");
    const completedEntryId = target.session.sessionManager.getLeafId();
    const held = target.session.prompt("Hold another provider request");
    await waitFor(() => target.faux.state.callCount === 3, "busy target provider");
    let offset = 0,
      entryId: string | undefined;
    const pages: string[] = [];
    do {
      // Pages are independently fetched over the real broker and pinned to one native entry.
      // oxlint-disable-next-line no-await-in-loop
      const result = await executeIntercom(reader, {
        action: "last",
        to: targetName,
        offset,
        entryId,
        limit: 8192,
      });
      assert.notEqual(result.isError, true);
      const page = record(result.details);
      entryId ??= text(page.entryId);
      assert.equal(page.entryId, completedEntryId);
      assert.equal(page.entryId, entryId);
      assert.equal(page.offset, offset);
      assert.equal(page.totalLength, body.length);
      assert.equal(text(record(page.session).status), "thinking");
      assert.equal(text(record(page.session).name), targetName);
      pages.push(text(page.text));
      assert.equal(text(result.content[0].text), page.text);
      assert.match(text(result.content[1].text), /Session: last-target/);
      assert.match(text(result.content[1].text), /Status: thinking/);
      if (page.nextOffset !== undefined) {
        assert.match(text(result.content[1].text), /Next page: intercom\(/);
      }
      if (page.nextOffset === undefined) {
        break;
      }
      offset = numberValue(page.nextOffset);
    } while (offset < body.length);
    assert.equal(pages.join(""), body);
    assert.ok(pages.length > 1);
    assert.equal(target.faux.state.callCount, 3);
    assert.equal(target.session.isStreaming, true);
    assert.equal(reader.faux.state.callCount, 0);
    assert.equal(
      target.session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message")
        .length,
      0,
    );
    const invalid = await reader.sender.last(targetName, { entryId: "foreign-entry" });
    assert.ok("error" in invalid);
    release.resolve();
    await held;
    assert.deepEqual([...reader.errors, ...target.errors], []);
  });
}

function restartFixture(t: TestContext, mode: string, directory: string, sessionFile?: string) {
  const child = spawn(
    process.execPath,
    [
      path.join(repo, "test/fixtures/pi-intercom-native-resume.mjs"),
      mode,
      directory,
      ...(sessionFile !== undefined ? [sessionFile] : []),
    ],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
        TMPDIR: tmpdir(),
        PI_CODING_AGENT_DIR: agentDir,
        PI_INTERCOM_RUNTIME_DIR: process.env.PI_INTERCOM_RUNTIME_DIR,
        PI_SUBAGENT_TEMP_ROOT: process.env.PI_SUBAGENT_TEMP_ROOT,
        PI_OFFLINE: "1",
        JITI_FS_CACHE: path.join(root, "jiti-child"),
        PI_INTERCOM_TEST_SDK: process.env.PI_INTERCOM_TEST_SDK,
        PI_INTERCOM_TEST_EXTENSION: process.env.PI_INTERCOM_TEST_EXTENSION,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let output = "";
  const messages: unknown[] = [];
  child.on("message", (message: unknown) => {
    messages.push(message);
  });
  assert.ok(child.stdout && child.stderr);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const collect = (chunk: unknown) => {
    output += text(chunk);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const exited = once(child, "exit");
  const result = receiveResume(child);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await exited;
    if (evidenceDir !== undefined && evidenceDir !== "") {
      writeFileSync(
        path.join(root, `${path.basename(directory)}-${mode}.json`),
        JSON.stringify({ messages, output }, null, 2),
      );
    }
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
    {
      messageId: "old-milestone",
      text: "obsolete progress",
      delivery: "queue" as const,
      queueMode: "replace" as const,
      threadId: "restart-milestone",
    },
    {
      messageId: "latest-milestone",
      text: "latest material progress",
      delivery: "queue" as const,
      queueMode: "replace" as const,
      threadId: "restart-milestone",
    },
    { messageId: "passive", text: "passive breadcrumb", delivery: "passive" as const },
  ]) {
    // Superseding progress depends on accepting the previous send first.
    // oxlint-disable-next-line no-await-in-loop
    assert.equal((await sender.send("restart-parent", message)).accepted, true);
  }
  const snapshotPromise = receiveResume(seed.child);
  seed.child.send({ action: "snapshot" });
  const [snapshot] = await snapshotPromise;
  assert.equal(snapshot.nativeQueued, true);
  assert.match(snapshot.status, /Pending inbound messages: 4/);
  assert.deepEqual(snapshot.visibleIds, []);
  const saved = parseSessionEntries(readFileSync(ready.sessionFile, "utf8"));
  seed.child.kill("SIGKILL");
  await seed.exited;

  let forkCheckpointOwners: string[] = [];
  for (const mode of ["fork", "new"]) {
    const fresh = restartFixture(t, mode, path.join(root, `restart-${mode}`), ready.sessionFile);
    // These processes share a broker target and must not overlap.
    // oxlint-disable-next-line no-await-in-loop
    const [result] = await fresh.result;
    // Release the previous native process before starting its successor.
    // oxlint-disable-next-line no-await-in-loop
    await fresh.exited;
    assert.notEqual(result.sessionId, ready.sessionId);
    assert.equal(result.modelCalls, 0, `${mode} must not adopt another session's pending messages`);
    assert.deepEqual(result.visibleIds, []);
    assert.match(result.status, /Pending inbound messages: 0/);
    if (mode === "fork") {
      forkCheckpointOwners = [...result.checkpointOwners];
    }
    assert.deepEqual(result.errors, []);
  }

  for (const attempt of [1, 2]) {
    const resumed = restartFixture(
      t,
      "resume",
      path.join(root, `restart-resume-${attempt}`),
      ready.sessionFile,
    );
    // The second resume must read the journal produced by the first resume.
    // oxlint-disable-next-line no-await-in-loop
    const [result] = await resumed.result;
    // Do not overlap native processes that own the same saved session.
    // oxlint-disable-next-line no-await-in-loop
    await resumed.exited;
    assert.equal(result.sessionId, ready.sessionId);
    assert.equal(
      result.modelCalls,
      attempt === 1 ? 1 : 0,
      "only the first resume needs a delivery turn",
    );
    assert.deepEqual(
      result.visibleIds.toSorted((a, b) => a.localeCompare(b)),
      ["latest-milestone", "native-followup", "native-steer", "passive"],
    );
    assert.match(result.status, /Pending inbound messages: 0/);
    assert.deepEqual(result.errors, []);
  }
  assert.deepEqual(forkCheckpointOwners, [ready.sessionId]);
  assert.equal(
    saved.filter(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === "intercom_delivery" &&
        at(entry, "data", "entry") !== undefined,
    ).length,
    5,
    "each received body is checkpointed once before process loss",
  );

  const passiveSeed = restartFixture(t, "seed", path.join(root, "restart-passive-seed"));
  const [passiveReady] = await passiveSeed.result;
  assert.equal(
    (
      await sender.send("restart-parent", {
        messageId: "passive-only",
        text: "Do not wake the model",
        delivery: "passive",
      })
    ).accepted,
    true,
  );
  const passiveSnapshot = receiveResume(passiveSeed.child);
  passiveSeed.child.send({ action: "snapshot" });
  assert.match((await passiveSnapshot)[0].status, /Pending inbound messages: 1/);
  passiveSeed.child.kill("SIGKILL");
  await passiveSeed.exited;
  const passiveResume = restartFixture(
    t,
    "resume",
    path.join(root, "restart-passive-resume"),
    passiveReady.sessionFile,
  );
  const [passiveResult] = await passiveResume.result;
  await passiveResume.exited;
  assert.equal(passiveResult.modelCalls, 0);
  assert.deepEqual(passiveResult.visibleIds, ["passive-only"]);
  assert.deepEqual(passiveResult.errors, []);
  t.diagnostic(
    "hard-killed host restores 2 native-queued + 2 staged messages once in 1 turn; second resume/fork/new/passive-only restore run 0 turns; superseded progress stays absent.",
  );
});

test("native ordinary progress reaches the first tool boundary before the recipient finishes", async (t) => {
  const firstGate = gate(t),
    secondGate = gate(t);
  let firstStarted = false,
    secondStarted = false,
    seenAtBoundary = "";
  const parent = await makeSession(t, "timely-progress-parent", {
    hasUI: true,
    configure(pi) {
      pi.registerTool({
        name: "first_gate",
        label: "First gate",
        description: "Controlled first boundary",
        parameters: Type.Object({}),
        async execute() {
          firstStarted = true;
          await firstGate.promise;
          return { content: [{ type: "text", text: "First tool finished" }], details: {} };
        },
      });
      pi.registerTool({
        name: "second_gate",
        label: "Second gate",
        description: "Keep parent work active",
        parameters: Type.Object({}),
        async execute() {
          secondStarted = true;
          await secondGate.promise;
          return { content: [{ type: "text", text: "Second tool finished" }], details: {} };
        },
      });
    },
  });
  const child = await makeSession(t, "timely-progress-child");
  parent.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("first_gate", {}), { stopReason: "toolUse" }),
    (context) => {
      seenAtBoundary = JSON.stringify(context);
      return fauxAssistantMessage(fauxToolCall("second_gate", {}), { stopReason: "toolUse" });
    },
    fauxAssistantMessage("Parent work completed"),
  ]);
  const running = parent.session.prompt("Work through both controlled boundaries");
  await waitFor(() => firstStarted, "first parent tool");
  const contact = registeredTool(child.session, "intercom");
  const receipt = await contact.execute(
    "timely-discovery",
    {
      action: "send",
      to: "timely-progress-parent",
      message: "A required migration changes the API decision.",
    },
    new AbortController().signal,
  );
  const receiptDetails = record(receipt.details);
  assert.equal(receiptDetails.accepted, true);
  // Broker acceptance is not recipient admission. Keep the first tool active
  // until public recipient status confirms this exact message's native handoff.
  await waitFor(
    async () =>
      (await parent.status()).includes(
        `[${text(receiptDetails.messageId)}] (delivered to model queue; not yet consumed)`,
      ),
    "progress admitted during first parent tool",
  );
  assert.equal(secondStarted, false);
  firstGate.resolve();
  await waitFor(() => secondStarted, "second parent tool");
  assert.match(seenAtBoundary, /A required migration changes the API decision/);
  assert.equal(parent.session.isIdle, false, "progress was consumed before parent work completed");
  assert.equal(receiptDetails.delivered, true);
  secondGate.resolve();
  await running;
  assert.equal(parent.faux.state.callCount, 3, "no delayed progress-only turn");
  assert.deepEqual(parent.errors, []);
});

test("native latest material milestone survives two minutes busy and reload without stale superseded delivery", async (t) => {
  const toolGate = gate(t);
  let toolStarted = false;
  const supervisor = await makeSession(t, "milestone-supervisor", {
    hasUI: true,
    configure(pi) {
      pi.registerTool({
        name: "hold",
        label: "Hold",
        description: "Fixture gate",
        parameters: Type.Object({}),
        async execute() {
          toolStarted = true;
          await toolGate.promise;
          return { content: [{ type: "text", text: "released" }], details: {} };
        },
      });
    },
  });
  supervisor.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("Milestone handled"),
  ]);
  const running = supervisor.session.prompt("Work before the milestone");
  await waitFor(() => toolStarted, "busy supervisor tool");
  const now = Date.now;
  try {
    Date.now = () => now() - 120_000;
    const oldReceipt = await supervisor.send("old-milestone", {
      text: "Subagent progress update.\n\nOld finding",
      delivery: "queue",
      queueMode: "replace",
      threadId: "material-progress",
    });
    assert.equal(oldReceipt.delivered, true);
    const latestReceipt = await supervisor.send("latest-milestone", {
      text: "Subagent progress update.\n\nRoot cause confirmed",
      delivery: "queue",
      queueMode: "replace",
      threadId: "material-progress",
    });
    assert.equal(latestReceipt.delivered, true);
  } finally {
    Date.now = now;
  }
  await waitFor(
    async () => (await supervisor.status()).includes("Root cause confirmed"),
    "coalesced latest milestone",
  );
  const staged = await supervisor.status();
  assert.match(staged, /queued; not yet delivered to model/);
  assert.match(staged, /Root cause confirmed/);
  assert.doesNotMatch(staged, /Old finding/);
  assert.equal(supervisor.visible("old-milestone").length, 0);
  assert.equal(supervisor.visible("latest-milestone").length, 0);
  await supervisor.send("old-milestone", {
    text: "Replayed superseded finding",
    delivery: "queue",
    queueMode: "replace",
    threadId: "material-progress",
  });
  await supervisor.send("replacement-barrier", {
    text: "Ordered receive barrier",
    delivery: "passive",
  });
  await waitFor(
    async () => (await supervisor.status()).includes("replacement-barrier"),
    "superseded retry processed",
  );
  assert.doesNotMatch(await supervisor.status(), /Replayed superseded finding/);
  await supervisor.sender.disconnect();
  assert.match(await supervisor.status(), /Root cause confirmed/);
  const aborting = supervisor.session.abort();
  toolGate.resolve();
  await running;
  await aborting;
  await supervisor.session.reload();
  await waitFor(
    () => supervisor.visible("latest-milestone").length === 1 && supervisor.settled() === 2,
    "milestone settlement",
  );
  assert.equal(supervisor.visible("old-milestone").length, 0);
  assert.equal(supervisor.visible("latest-milestone").length, 1);
  assert.equal(
    supervisor.faux.state.callCount,
    2,
    "explicit abort ends the held turn; only the retained milestone starts another response",
  );
  assert.match(await supervisor.status(), /Pending inbound messages: 0/);
  assert.deepEqual(supervisor.errors, []);
  t.diagnostic(
    "latest backdated material finding survives native reload while busy; superseded progress never wakes the model.",
  );
});

test("native runtime disposal cancels deferred startup before any broker registration", async (t) => {
  const receiver = await makeSession(t, "dispose-deferred", { waitForRegistration: false });
  await receiver.dispose();
  // The observer's real round trip runs after the canceled startup timer was due.
  assert.ok(
    !(await receiver.sender.listSessions()).some((peer) => peer.name === "dispose-deferred"),
  );
  assert.equal(receiver.faux.state.callCount, 0);
  assert.deepEqual(receiver.errors, []);
});

test("native public tools resolve displayed targets safely through duplicate names and prefix collisions", async (t) => {
  const receiver = await makeSession(t, "target-resolution");
  const duplicates = [new IntercomClient(), new IntercomClient()];
  const collision = new IntercomClient();
  t.after(async () => {
    await Promise.all([...duplicates, collision].map((client) => client.disconnect()));
  });
  await Promise.all(
    duplicates.map((client) => client.connect({ name: "duplicate", cwd: root, model: "fixture" })),
  );
  const target = observedSession(
    await receiver.sender.listSessions(),
    (peer) => peer.name === "duplicate",
  );
  const peer = duplicates.find((client) => client.sessionId === target.id);
  assertDefined(peer);
  const impostor = duplicates.find((client) => client !== peer);
  assertDefined(impostor);
  const short = target.id.slice(0, 8);
  assert.match(
    JSON.stringify(await executeIntercom(receiver, { action: "list" })),
    new RegExp(`target:${short}`),
  );
  for (const action of ["send", "ask"] as const) {
    const received: Promise<unknown> = once(peer, "message");
    let settled = false;
    const sending = executeIntercom(receiver, {
      action,
      to: short,
      message: `safe ${action}`,
    }).finally(() => {
      settled = true;
    });
    // Finish this delivered request before admitting the next action.
    // oxlint-disable-next-line no-await-in-loop
    const [from, input] = array(await received).map(record);
    assert.equal(at(input, "content", "text"), `safe ${action}`);
    if (action === "ask") {
      assert.equal(input.expectsReply, true);
      peer.updatePresence({ name: "renamed-duplicate" });
      // The mutable name must not replace the broker identity pinned by the ask.
      // oxlint-disable-next-line no-await-in-loop
      await waitFor(
        async () =>
          (await peer.listSessions()).some(
            (session) => session.id === peer.sessionId && session.name === "renamed-duplicate",
          ),
        "renamed ask recipient",
      );
      // oxlint-disable-next-line no-await-in-loop
      await impostor.send(text(from.id), {
        messageId: "wrong-ask-sender",
        text: "Same display name is not the pinned sender",
        replyTo: text(input.id),
        passive: true,
      });
      // oxlint-disable-next-line no-await-in-loop
      await peer.send(text(from.id), {
        messageId: "wrong-ask-correlation",
        text: "Pinned sender but a different question",
        replyTo: "another-question",
        passive: true,
      });
      // Real native publication proves both guards processed their input before this negative.
      // oxlint-disable-next-line no-await-in-loop
      await waitFor(
        () =>
          receiver.visible("wrong-ask-sender").length === 1 &&
          receiver.visible("wrong-ask-correlation").length === 1,
        "unmatched reply publication",
      );
      assert.equal(settled, false);
      // The observed correlation is required before replying.
      // oxlint-disable-next-line no-await-in-loop
      await peer.send(text(from.id), { text: "Exact correlated reply", replyTo: text(input.id) });
      peer.updatePresence({ name: "duplicate" });
    } else {
      assert.equal(input.delivery, "steer");
    }
    // Do not overlap the next tool action with this reply waiter.
    // oxlint-disable-next-line no-await-in-loop
    assert.notEqual((await sending).isError, true);
  }
  await waitFor(
    async () =>
      (await peer.listSessions()).filter((session) => session.name === "duplicate").length === 2,
    "restored duplicate names",
  );
  for (const action of ["send", "ask"] as const) {
    // oxlint-disable-next-line no-await-in-loop
    await assert.rejects(
      executeIntercom(receiver, { action, to: short.slice(0, 7), message: "unsafe" }),
      /too short/,
    );
    // oxlint-disable-next-line no-await-in-loop
    await assert.rejects(
      executeIntercom(receiver, { action, to: "duplicate", message: "ambiguous" }),
      /matches multiple sessions/,
    );
  }
  await collision.connect({ name: short, cwd: root, model: "fixture" });
  for (const action of ["send", "ask"] as const) {
    // oxlint-disable-next-line no-await-in-loop
    await assert.rejects(
      executeIntercom(receiver, { action, to: short, message: "collision" }),
      /matches multiple sessions/,
    );
  }
  const safe = target.id.slice(0, 9);
  assert.match(
    JSON.stringify(await executeIntercom(receiver, { action: "list" })),
    new RegExp(`target:${safe}`),
  );
  const received = once(peer, "message");
  await executeIntercom(receiver, { action: "send", to: safe, message: "Longer safe target" });
  assert.equal(at(array(await received)[1], "content", "text"), "Longer safe target");
  assert.deepEqual(receiver.errors, []);
});

test("native named ask refuses a peer absent from discovery even when it registers before send", async (t) => {
  const asker = await makeSession(t, "late-registration-asker", {
    config: { askTimeoutMs: 1000 },
  });
  const peer = new IntercomClient();
  t.after(() => peer.disconnect());
  let snapshotReady = false;
  const originalWrite: unknown = Reflect.get(net.Socket.prototype, "write");
  assert.ok(typeof originalWrite === "function");
  let heldConnection: { readonly socket: net.Socket } | undefined;
  let release: (() => void) | undefined;
  const sends: unknown[] = [];
  t.after(() => release?.());
  t.mock.method(
    net.Socket.prototype,
    "write",
    function (this: net.Socket, ...args: Parameters<net.Socket["write"]>) {
      const chunk = args[0];
      if (
        Buffer.isBuffer(chunk) &&
        chunk.subarray(4).toString().includes('"type":"list"') &&
        heldConnection === undefined
      ) {
        heldConnection = { socket: this };
        const request = record(JSON.parse(chunk.subarray(4).toString()));
        const originalEmit = this.emit.bind(this);
        const held: Buffer[] = [];
        let released = false;
        const read = createMessageReader(
          (value) => {
            const frame = record(value);
            if (
              frame.type === "sessions" &&
              frame.requestId === request.requestId &&
              frame.more !== true
            ) {
              assert.ok(
                !records(frame.sessions).some((session) => session.name === "late-named-peer"),
              );
              snapshotReady = true;
            }
          },
          (error) => {
            throw new Error(error.message, { cause: error });
          },
        );
        t.mock.method(this, "emit", (event: string | symbol, ...values: unknown[]) => {
          if (!released && event === "data" && Buffer.isBuffer(values[0])) {
            held.push(values[0]);
            read(values[0]);
            return true;
          }
          return Reflect.apply(originalEmit, this, [event, ...values]) === true;
        });
        release = () => {
          released = true;
          for (const data of held.splice(0)) {
            originalEmit("data", data);
          }
        };
      }
      if (
        this === heldConnection?.socket &&
        Buffer.isBuffer(chunk) &&
        chunk.subarray(4).toString().includes('"type":"send"')
      ) {
        sends.push(JSON.parse(chunk.subarray(4).toString()));
      }
      return Reflect.apply(originalWrite, this, args) === true;
    },
  );
  const received: Message[] = [];
  const replies: Promise<unknown>[] = [];
  peer.on("message", (from: SessionInfo, message: Message) => {
    received.push(message);
    if (message.expectsReply === true) {
      const reply = peer.send(from.id, {
        messageId: "late-registration-answer",
        text: "Answer from the registered broker ID",
        replyTo: message.id,
        passive: true,
      });
      reply.catch(() => {
        // Join delivery failures below, after the ask settles.
      });
      replies.push(reply);
    }
  });
  const asking = executeIntercom(asker, {
    action: "ask",
    to: "late-named-peer",
    message: "Must not send an unresolved ask",
  }).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await waitFor(() => snapshotReady, "discovery snapshot before peer registration");
  await peer.connect({ name: "late-named-peer", cwd: root, model: "fixture" });
  assert.ok((await peer.listSessions()).some((session) => session.id === peer.sessionId));
  assertDefined(release);
  release();
  const result = await asking;
  const replyReceipts = await Promise.all(replies);
  assert.ok("error" in result);
  const failure = record(result.error);
  t.diagnostic(
    JSON.stringify({
      reasonCode: record(failure.details).reasonCode,
      sends,
      received,
      replyReceipts,
      publishedAnswers: asker.visible("late-registration-answer").length,
    }),
  );
  assert.equal(record(failure.details).reasonCode, "delivery_failed");
  assert.equal(record(failure.details).accepted, false);
  assert.equal(record(failure.details).delivered, false);
  assert.match(text(failure.message), /not sent.*not found/i);
  assert.equal(sends.length, 0, "no unresolved target may reach the sender socket");
  assert.deepEqual(received, []);
  const retry = await executeIntercom(asker, {
    action: "ask",
    to: "late-named-peer",
    message: "Retry after registration",
  });
  assert.match(JSON.stringify(retry.content), /Answer from the registered broker ID/);
  assert.equal(record(sends[0]).to, peer.sessionId);
  assert.equal(received.length, 1);
  assert.equal(asker.faux.state.callCount, 0);
  assert.deepEqual(asker.errors, []);
});

test("native ordinary asks honor busy capability and explicit steer/queue without claiming consumption", async (t) => {
  const asker = await makeSession(t, "busy-capability-asker");
  asker.sender.updatePresence({ status: "thinking", acceptsAsks: false, pendingAsks: 2 });
  await waitFor(
    async () =>
      (await asker.sender.listSessions()).find(
        (peer) => peer.name === "sender-busy-capability-asker",
      )?.acceptsAsks === false,
    "busy peer presence",
  );
  const listing = JSON.stringify(await executeIntercom(asker, { action: "list" }));
  const status = await asker.status();
  for (const output of [listing, status]) {
    assert.match(output, /state:busy/);
    assert.match(output, /accepts_asks:false/);
    assert.match(output, /pending_asks:2/);
    assert.match(output, /self target unavailable/);
  }
  const received = once(asker.sender, "message");
  const busy = await executeIntercom(asker, {
    action: "ask",
    to: "sender-busy-capability-asker",
    message: "Busy default ask",
  });
  assert.equal(at(array(await received)[1], "expectsReply"), true);
  const details = record(busy.details);
  assert.equal(details.accepted, true);
  assert.equal(details.delivered, true);
  assert.equal(details.replied, false);
  assert.equal(details.reasonCode, "recipient_not_accepting_asks");
  assert.match(JSON.stringify(busy.content), /Not waiting.*does not mean.*consumed/);
  for (const delivery of ["steer", "queue"] as const) {
    const request = once(asker.sender, "message");
    let settled = false;
    const asking = executeIntercom(asker, {
      action: "ask",
      to: "sender-busy-capability-asker",
      delivery,
      message: `Explicit ${delivery}`,
    }).finally(() => {
      settled = true;
    });
    // Observe actual delivery before replying to this ask.
    // oxlint-disable-next-line no-await-in-loop
    const [from, input] = array(await request).map(record);
    assert.equal(input.delivery, delivery);
    assert.equal(input.expectsReply, true);
    assert.equal(settled, false);
    // The next ask must not race this correlated reply.
    // oxlint-disable-next-line no-await-in-loop
    await asker.sender.send(text(from.id), { text: `Answer ${delivery}`, replyTo: text(input.id) });
    // Release the sole waiter before admitting the next delivery mode.
    // oxlint-disable-next-line no-await-in-loop
    assert.match(JSON.stringify((await asking).content), new RegExp(`Answer ${delivery}`));
  }
  assert.equal(asker.faux.state.callCount, 0);
  assert.deepEqual(asker.errors, []);
});

for (const outcome of [
  "timeout",
  "disconnect",
  "cancel",
  "failure-marker",
  "normal-prefix",
] as const) {
  test(`native ordinary ask ${outcome} settles with its original correlation and releases the waiter`, async (t) => {
    const asker = await makeSession(t, `ask-outcome-${outcome}`, {
      config: { askTimeoutMs: 1000 },
    });
    const controller = new AbortController();
    const received = once(asker.sender, "message");
    const asking = registeredTool(asker.session, "intercom").execute(
      "ordinary-ask",
      {
        action: "ask",
        to: `sender-ask-outcome-${outcome}`,
        message: "Original ordinary question",
      },
      controller.signal,
    );
    // Join rejection now, before the external peer/timeout can settle it.
    const result = asking.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    const [from, question] = array(await received).map(record);
    if (outcome === "disconnect") {
      await asker.sender.disconnect();
    } else if (outcome === "cancel") {
      controller.abort();
    } else if (outcome !== "timeout") {
      await asker.sender.send(text(from.id), {
        text: "Recipient turn failed: is only ordinary text without the marker",
        replyTo: text(question.id),
        ...(outcome === "failure-marker"
          ? {
              attachments: [
                {
                  type: "context",
                  name: "pi-intercom-recipient-turn-failure",
                  content: "Provider unavailable",
                },
              ],
            }
          : {}),
      });
    }
    const settled = await result;
    if (outcome === "normal-prefix") {
      assert.ok("value" in settled);
      assert.match(JSON.stringify(settled.value.content), /is only ordinary text/);
    } else {
      assert.ok("error" in settled);
      const error = record(settled.error);
      if (outcome === "timeout" || outcome === "failure-marker") {
        const details = record(error.details);
        assert.equal(
          details.reasonCode,
          outcome === "timeout" ? "reply_timeout" : "recipient_turn_failed",
        );
        assert.equal(outcome === "timeout" ? details.messageId : details.replyTo, question.id);
        assert.deepEqual(
          records(details.nextActions).map((action) => action.action),
          outcome === "timeout" ? ["status", "list", "send"] : ["status", "send"],
        );
      } else {
        assert.match(
          text(error.message),
          outcome === "cancel" ? /Cancelled/ : /Reply peer disconnected/,
        );
      }
    }
    if (outcome === "disconnect") {
      await asker.sender.connect({
        name: `sender-ask-outcome-${outcome}`,
        cwd: root,
        model: "fixture",
      });
    }
    const next = once(asker.sender, "message");
    const retry = executeIntercom(asker, {
      action: "ask",
      to: `sender-ask-outcome-${outcome}`,
      message: "Next ordinary question",
    });
    const [nextFrom, nextQuestion] = array(await next).map(record);
    await asker.sender.send(text(nextFrom.id), {
      text: "Next answer",
      replyTo: text(nextQuestion.id),
    });
    assert.match(JSON.stringify((await retry).content), /Next answer/);
    assert.deepEqual(asker.errors, []);
  });
}

for (const afterTool of [false, true]) {
  test(`native recipient provider failure ${afterTool ? "after a tool turn" : "on its first turn"} reaches the ordinary ask as an error`, async (t) => {
    const recipient = await makeSession(t, `provider-failure-${afterTool}`, {
      configure(pi) {
        pi.registerTool({
          name: "noop",
          label: "No-op",
          description: "Native intervening tool",
          parameters: Type.Object({}),
          async execute() {
            return { content: [{ type: "text", text: "Intervening tool finished" }], details: {} };
          },
        });
      },
    });
    const asker = await makeSession(t, `failure-asker-${afterTool}`);
    recipient.faux.setResponses([
      ...(afterTool
        ? [fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" })]
        : []),
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "Fixture provider unavailable",
      }),
    ]);
    await assert.rejects(
      executeIntercom(asker, {
        action: "ask",
        to: `provider-failure-${afterTool}`,
        message: "Need a real answer",
      }),
      (error: unknown) => {
        assert.match(
          text(property(error, "message")),
          /Recipient turn failed: Fixture provider unavailable/,
        );
        assert.equal(at(error, "details", "reasonCode"), "recipient_turn_failed");
        return true;
      },
    );
    await recipient.session.waitForIdle();
    assert.equal(recipient.faux.state.callCount, afterTool ? 2 : 1);
    assert.match(
      JSON.stringify(await executeIntercom(recipient, { action: "pending" })),
      /No unresolved inbound asks/,
    );
    assert.deepEqual([...recipient.errors, ...asker.errors], []);
  });
}

for (const scenario of ["already-replied", "agent-settled", "non-error"] as const) {
  test(`native ${scenario} does not produce a spurious recipient-failure reply`, async (t) => {
    const recipient = await makeSession(t, `no-spurious-${scenario}`);
    const replies: ReadonlyInput<Message>[] = [];
    recipient.sender.on(
      "message",
      (_from: ReadonlyInput<SessionInfo>, message: ReadonlyInput<Message>) => {
        replies.push(message);
      },
    );
    recipient.faux.setResponses([
      ...(scenario === "already-replied"
        ? [
            fauxAssistantMessage(
              fauxToolCall("intercom", {
                action: "reply",
                message: "Normal reply",
                attachments: [
                  { type: "context", name: "answer.txt", content: "Supporting context" },
                ],
              }),
              { stopReason: "toolUse" },
            ),
          ]
        : []),
      fauxAssistantMessage(
        scenario === "non-error" ? "Normal response" : "",
        scenario === "agent-settled"
          ? {}
          : {
              stopReason: scenario === "non-error" ? "stop" : "error",
              errorMessage: "Later provider warning",
            },
      ),
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "Failure on unrelated later prompt",
      }),
    ]);
    await recipient.send("spurious-question", { text: "Question", expectsReply: true });
    await waitFor(() => recipient.settled() === 1, "original question settlement");
    if (scenario === "agent-settled") {
      await recipient.session.prompt("Unrelated later prompt");
    }
    // A later direct send from the same runtime drains earlier broker writes before the negative assertion.
    const control = once(recipient.sender, "message");
    await executeIntercom(recipient, {
      action: "send",
      to: `sender-no-spurious-${scenario}`,
      message: "Failure-check barrier",
    });
    await control;
    const correlated = replies.filter((reply) => reply.replyTo === "spurious-question");
    assert.equal(correlated.length, scenario === "already-replied" ? 1 : 0);
    if (scenario === "already-replied") {
      assert.equal(correlated[0].content.text, "Normal reply");
      assert.deepEqual(correlated[0].content.attachments, [
        { type: "context", name: "answer.txt", content: "Supporting context" },
      ]);
    }
    assert.deepEqual(recipient.errors, []);
  });
}

for (const hasUI of [false, true]) {
  test(`native replace asks retire superseded pending questions and wake once after ${hasUI ? "UI tool" : "print provider"} work settles`, async (t) => {
    const release = gate(t);
    let started = false;
    const receiver = await makeSession(t, `replace-asks-${hasUI}`, {
      hasUI,
      configure(pi) {
        if (!hasUI) {
          return;
        }
        pi.registerTool({
          name: "hold",
          label: "Hold",
          description: "Held native work",
          parameters: Type.Object({}),
          async execute() {
            started = true;
            await release.promise;
            return { content: [{ type: "text", text: "Released" }], details: {} };
          },
        });
      },
    });
    receiver.faux.setResponses([
      hasUI
        ? fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" })
        : async () => {
            started = true;
            await release.promise;
            return fauxAssistantMessage("Original work finished");
          },
      ...(hasUI ? [fauxAssistantMessage("Original tool work finished")] : []),
      fauxAssistantMessage("Latest question handled"),
    ]);
    const running = receiver.session.prompt("Work before questions");
    await waitFor(() => started, "held native work");
    for (const id of ["old-question", "latest-question"]) {
      // Supersession requires the old question to be admitted first.
      // oxlint-disable-next-line no-await-in-loop
      await receiver.send(id, {
        text: id,
        expectsReply: true,
        delivery: "queue",
        queueMode: "replace",
        threadId: "decision",
      });
    }
    await waitFor(
      async () => (await receiver.status()).includes("latest-question"),
      "latest pending ask",
    );
    const pending = JSON.stringify(await executeIntercom(receiver, { action: "pending" }));
    assert.match(pending, /latest-question/);
    assert.doesNotMatch(pending, /old-question/);
    const peer = observedSession(
      await receiver.sender.listSessions(),
      (entry) => entry.name === `replace-asks-${hasUI}`,
    );
    assert.equal(peer.pendingAsks, 1);
    assert.equal(peer.acceptsAsks, false);
    assert.equal(receiver.visible("old-question").length, 0);
    assert.equal(receiver.visible("latest-question").length, 0);
    release.resolve();
    await running;
    await waitFor(
      () => receiver.session.isIdle && receiver.visible("latest-question").length === 1,
      "replacement question wake",
    );
    assert.equal(receiver.visible("old-question").length, 0);
    assert.equal(receiver.faux.state.callCount, hasUI ? 3 : 2);
    assert.deepEqual(receiver.errors, []);
  });
}

test("native public tool rejects invalid delivery combinations and preserves recovery actions", async (t) => {
  const receiver = await makeSession(t, "invalid-options");
  for (const { params, expected, reason } of [
    {
      params: { action: "ask", delivery: "passive", to: "nobody", message: "Invalid" },
      expected: /delivery='passive' is only valid/,
      reason: undefined,
    },
    {
      params: { action: "ask", passive: true, to: "nobody", message: "Invalid" },
      expected: /'passive' is only valid/,
      reason: undefined,
    },
    {
      params: {
        action: "send",
        delivery: "queue",
        queueMode: "replace",
        to: "nobody",
        message: "Invalid",
      },
      expected: /requires a non-empty threadId/,
      reason: "invalid_queue_arguments",
    },
    {
      params: { action: "send", queueMode: "stack", to: "nobody", message: "Invalid" },
      expected: /only valid with delivery='queue'/,
      reason: "invalid_queue_arguments",
    },
    {
      params: { action: "pending", delivery: "queue" },
      expected: /only valid for action='send' or action='ask'/,
      reason: "invalid_queue_arguments",
    },
    {
      params: { action: "send", to: "not-connected", message: "Missing target" },
      expected: /not delivered/,
      reason: "delivery_failed",
    },
    {
      params: { action: "reply", message: "No question" },
      expected: /No active intercom context/,
      reason: "no_pending_reply",
    },
  ]) {
    // Validate one public tool invocation before the next reuses its session.
    // oxlint-disable-next-line no-await-in-loop
    await assert.rejects(executeIntercom(receiver, params), (error: unknown) => {
      assert.match(text(property(error, "message")), expected);
      if (reason !== undefined) {
        assert.equal(at(error, "details", "reasonCode"), reason);
        assert.ok(records(at(error, "details", "nextActions")).length > 0);
      }
      return true;
    });
  }
  const passive = await executeIntercom(receiver, {
    action: "send",
    to: "sender-invalid-options",
    message: "Passive alias",
    passive: true,
  });
  assert.match(JSON.stringify(passive.content), /passive; recipient model was not woken/);
  assert.deepEqual(receiver.errors, []);
});

test("native busy print work steers ordinary asks without aborting and admits only the latest replacement at its tool boundary", async (t) => {
  const release = gate(t);
  let started = false,
    seen = "";
  const receiver = await makeSession(t, "print-busy-policy", {
    configure(pi) {
      pi.registerTool({
        name: "hold",
        label: "Hold",
        description: "Held print work",
        parameters: Type.Object({}),
        async execute() {
          started = true;
          await release.promise;
          return { content: [{ type: "text", text: "Released" }], details: {} };
        },
      });
    },
  });
  receiver.session.setSteeringMode("all");
  receiver.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
    (context) => {
      seen = JSON.stringify(context);
      return fauxAssistantMessage("Print task continued");
    },
  ]);
  const running = receiver.session.prompt("Keep working until released");
  await waitFor(() => started, "held print work");
  await receiver.send("plain-print", { text: "Plain print direction" });
  await receiver.send("old-print", {
    text: "Old print replacement",
    delivery: "queue",
    queueMode: "replace",
    threadId: "print-work",
  });
  await receiver.send("latest-print", {
    text: "Latest print replacement",
    delivery: "queue",
    queueMode: "replace",
    threadId: "print-work",
  });
  await receiver.send("busy-print-ask", { text: "Can you answer while busy?", expectsReply: true });
  await waitFor(async () => (await receiver.status()).includes("busy-print-ask"), "ask admitted");
  assert.equal(receiver.session.isIdle, false);
  assert.equal(receiver.faux.state.callCount, 1);
  release.resolve();
  await running;
  assert.match(seen, /Plain print direction/);
  assert.match(seen, /Latest print replacement/);
  assert.doesNotMatch(seen, /Old print replacement/);
  assert.match(seen, /Can you answer while busy/);
  assert.equal(receiver.faux.state.callCount, 2);
  assert.deepEqual(receiver.errors, []);
});

test("native runtime disposal cancels queued inbound work without a later wake", async (t) => {
  const receiver = await makeSession(t, "dispose-pending", { hasUI: true });
  const control = await makeSession(t, "dispose-control");
  control.faux.setResponses([fauxAssistantMessage("Later native replacement handled")]);
  await receiver.send("disposed-question", {
    text: "Must not wake a disposed runtime",
    expectsReply: true,
    delivery: "queue",
    queueMode: "replace",
    threadId: "dispose-timer",
  });
  await waitFor(
    async () => (await receiver.status()).includes("queued; not yet delivered to model"),
    "recipient admission before disposal",
  );
  await receiver.dispose();
  await control.send("later-native-control", {
    text: "Later native replacement window",
    delivery: "queue",
    queueMode: "replace",
    threadId: "later-window",
  });
  await waitFor(
    () => control.visible("later-native-control").length === 1 && control.session.isIdle,
    "later broker and native timer processing barrier",
  );
  assert.ok(
    !(await receiver.sender.listSessions()).some((peer) => peer.name === "dispose-pending"),
  );
  assert.equal(receiver.visible("disposed-question").length, 0);
  assert.equal(receiver.faux.state.callCount, 0);
  assert.deepEqual([...receiver.errors, ...control.errors], []);
});

test("native lifecycle presence follows parallel tools, selected model and final settlement", async (t) => {
  const first = gate(t),
    second = gate(t);
  const started = new Set<string>();
  const lowLevelEnds: Array<ReadonlyInput<SessionInfo>> = [];
  const receiver = await makeSession(t, "lifecycle-presence", {
    configure(pi) {
      pi.on("agent_end", async () => {
        const peers = await receiver.sender.listSessions();
        lowLevelEnds.push(observedSession(peers, (peer) => peer.name === "lifecycle-presence"));
      });
      for (const [name, release] of [
        ["first", first],
        ["second", second],
      ] as const) {
        pi.registerTool({
          name,
          label: name,
          description: "Native concurrent tool",
          parameters: Type.Object({}),
          async execute() {
            started.add(name);
            await release.promise;
            return { content: [{ type: "text", text: name }], details: {} };
          },
        });
      }
    },
  });
  const presence = async () =>
    observedSession(
      await receiver.sender.listSessions(),
      (peer) => peer.name === "lifecycle-presence",
    );
  assert.equal((await presence()).status, "idle");
  assert.equal((await presence()).acceptsAsks, true);
  const alternate = fauxProvider({
    provider: "alternate-presence-model",
    models: [{ id: "alternate-model" }],
  });
  receiver.session.modelRuntime.registerNativeProvider(alternate.provider);
  await receiver.session.setModel(alternate.getModel());
  alternate.setResponses([
    fauxAssistantMessage([fauxToolCall("first", {}), fauxToolCall("second", {})], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("Both tools finished"),
  ]);
  await waitFor(
    async () => (await presence()).model === alternate.getModel().id,
    "selected model presence",
  );
  const running = receiver.session.prompt("Run both tools");
  await waitFor(() => started.size === 2, "parallel native tools");
  await waitFor(
    async () => (await presence()).status === "tool:first",
    "first active tool presence",
  );
  assert.equal((await presence()).acceptsAsks, false);
  first.resolve();
  await waitFor(
    async () => (await presence()).status === "tool:second",
    "remaining active tool presence",
  );
  assert.equal(receiver.session.isIdle, false);
  second.resolve();
  await running;
  await waitFor(
    async () => (await presence()).status === "idle" && (await presence()).acceptsAsks === true,
    "final idle presence",
  );
  assert.equal((await presence()).pendingAsks, 0);
  assert.equal(lowLevelEnds.length, 1);
  assert.equal(lowLevelEnds[0].status, "thinking", "low-level agent_end is not final settlement");
  assert.equal(lowLevelEnds[0].acceptsAsks, false);
  assert.deepEqual(receiver.errors, []);
});

for (const foreground of [false, true]) {
  test(
    `native reconnect retries after a failed ${foreground ? "foreground takeover during backoff" : "background launch"}`,
    { timeout: 30000 },
    async (t) => {
      const attemptFile = path.join(root, `reconnect-attempts-${foreground}`);
      const name = `reconnect-${foreground}`;
      const receiver = await makeSession(t, name, {
        config: {
          brokerCommand: process.execPath,
          brokerArgs: [
            "-e",
            `require("node:fs").appendFileSync(${JSON.stringify(attemptFile)}, "x"); process.exit(0)`,
          ],
        },
      });
      const attempts = () => (existsSync(attemptFile) ? readFileSync(attemptFile).length : 0);
      // Observing failed real launcher processes proves a retry happened; no owner timer injection.
      const disconnected = once(receiver.sender, "disconnected");
      const exited = once(broker, "exit");
      broker.kill("SIGTERM");
      await Promise.all([disconnected, exited]);
      try {
        if (foreground) {
          // Sender disconnection is ordered after broker exit; the tool owns an actual failed reconnect.
          await assert.rejects(
            executeIntercom(receiver, { action: "list" }),
            /not connected|Failed to list/i,
          );
          const foregroundAttempts = attempts();
          assert.ok(foregroundAttempts > 0);
          await waitFor(
            () => attempts() > foregroundAttempts,
            "background retry after foreground failure",
          );
        } else {
          await waitFor(
            () => attempts() > 1,
            "subsequent launcher after failed background attempt",
          );
        }
        await receiver.sender.disconnect();
        await fixtureClient.disconnect();
        brokerLog = "";
        broker = launchBroker();
        await waitFor(
          () => brokerLog.includes("Intercom broker started"),
          "returned broker process",
        );
        await fixtureClient.connect({ name: "fixture-host", cwd: root, model: "fixture" });
        await receiver.sender.connect({ name: `sender-${name}`, cwd: root, model: "fixture" });
        const deadline = Date.now() + 12000;
        while (true) {
          // Complete each real broker observation before retrying it.
          // oxlint-disable-next-line no-await-in-loop
          const sessions = await receiver.sender.listSessions();
          if (sessions.some((peer) => peer.name === name)) {
            break;
          }
          assert.ok(Date.now() < deadline, "retry chain must reconnect without a foreground tool");
          // Back off only after the preceding broker read.
          // oxlint-disable-next-line no-await-in-loop
          await sleep(25);
        }
        await receiver.send("after-reconnect", {
          text: "Real post-reconnect input",
          delivery: "passive",
        });
        await waitFor(
          () => receiver.visible("after-reconnect").length === 1,
          "reconnected native delivery",
        );
        assert.equal(receiver.faux.state.callCount, 0);
        assert.deepEqual(receiver.errors, []);
      } finally {
        if (broker.exitCode !== null || broker.signalCode !== null) {
          brokerLog = "";
          broker = launchBroker();
          await waitFor(
            () => brokerLog.includes("Intercom broker started"),
            "broker restored after failure",
          );
        }
        if (!fixtureClient.isConnected()) {
          await fixtureClient.connect({ name: "fixture-host", cwd: root, model: "fixture" });
        }
      }
    },
  );
}
