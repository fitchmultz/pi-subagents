import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  cpSync,
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
import { after as afterAll, before as beforeAll, test, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext, AgentSession } from "@earendil-works/pi-coding-agent";
import type { SubagentState, SubagentExecutionResult } from "../../src/shared/types.ts";
import type { SubagentParamsLike } from "../../src/runs/foreground/subagent-executor.ts";
import { parseAsyncStatus, parseControlEvent } from "../../src/runs/background/run-schemas.ts";
import { errorMessage } from "../../src/shared/unknown.ts";
import {
  isMessage,
  normalizeSessionInfo,
  type Message,
  type SessionInfo,
} from "../../src/pi-intercom/types.ts";
import type { ReadonlyInput } from "../../src/shared/types/inputs.ts";
import { importSelectedNative } from "../../src/shared/native-import.ts";
import {
  assertDefined,
  array,
  textAt,
  record,
  records,
  strings,
  text,
  json,
  numberValue,
} from "../support/assertions.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const evidenceDir = process.env.PI_INTERCOM_TEST_EVIDENCE_DIR;
if (evidenceDir !== undefined && evidenceDir !== "") {
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
}
const root = realpathSync(mkdtempSync(path.join(evidenceDir ?? tmpdir(), "pi-intercom-native-")));
let retainRoot = false;
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
  createEventBus,
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
const { buildSubagentResultIntercomPayload, deliverSubagentResultIntercomEvent } =
  await import("../../src/intercom/result-intercom.ts");
const {
  listSupervisorQuestions,
  questionProcessAlive,
  readQuestionState,
  saveQuestionAnswer,
  saveQuestionOwner,
} = await import("../../src/runs/shared/supervisor-questions.ts");
const { executeAsyncSingle } = await import("../../src/runs/background/async-execution.ts");
const { resolveControlConfig } = await import("../../src/runs/shared/subagent-control.ts");
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
broker.stdout.setEncoding("utf8");
broker.stderr.setEncoding("utf8");
const collectBrokerLog = (chunk: unknown) => {
  brokerLog += text(chunk);
};
broker.stdout.on("data", collectBrokerLog);
broker.stderr.on("data", collectBrokerLog);

async function waitFor(
  check: () => boolean | Promise<boolean>,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  // Each native readiness observation must finish before retrying it.
  // oxlint-disable-next-line no-await-in-loop
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${description}`);
    // Back off only after observing the preceding readiness check.
    // oxlint-disable-next-line no-await-in-loop
    await sleep(5);
  }
}

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
  if (retainRoot || (evidenceDir !== undefined && evidenceDir !== "")) {
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

function sessionTopic(session: ReadonlyInput<SessionInfo>, topic: string) {
  const update = session.topics?.find((candidate) => candidate.topic === topic);
  assertDefined(update);
  return update;
}

function requireApi(api: ExtensionAPI | undefined): ExtensionAPI {
  assertDefined(api);
  return api;
}

function fixtureState(
  cwd: string,
): SubagentState & Required<Pick<SubagentState, "ownedRuns" | "foregroundRuns">> {
  return {
    baseCwd: cwd,
    currentSessionId: null,
    ownedRuns: new Map(),
    asyncJobs: new Map(),
    foregroundRuns: new Map(),
    cleanupTimers: new Map(),
    lastUiContext: null,
    poller: null,
    completionSeen: new Map(),
    watcher: null,
    watcherRestartTimer: null,
    resultFileCoalescer: {
      schedule: () => false,
      clear: () => {
        /* This fixture owns no scheduled result files. */
      },
    },
  };
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

async function receiveBrokerMessage(
  client: InstanceType<typeof IntercomClient>,
): Promise<readonly [SessionInfo, Message]> {
  const received: unknown = await once(client, "message");
  const [rawFrom, message] = array(received);
  const from = normalizeSessionInfo(rawFrom);
  assertDefined(from);
  assert.ok(isMessage(message));
  return [from, message];
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
    readonly eventBus?: ExtensionAPI["events"];
    readonly hasUI?: boolean;
    readonly subagents?: boolean | string;
    readonly child?: { readonly runId: string; readonly supervisor: string };
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
    eventBus: options.eventBus,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "Deterministic intercom regression fixture.",
    additionalExtensionPaths: [
      process.env.PI_INTERCOM_TEST_EXTENSION ?? path.join(repo, "src/pi-intercom/index.ts"),
      ...(options.subagents !== undefined && options.subagents !== false
        ? [
            typeof options.subagents === "string"
              ? options.subagents
              : path.join(repo, "src/extension/index.ts"),
          ]
        : []),
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
    for (const key of [
      "PI_SUBAGENT_ORCHESTRATOR_TARGET",
      "PI_SUBAGENT_RUN_ID",
      "PI_SUBAGENT_CHILD_AGENT",
      "PI_SUBAGENT_CHILD_INDEX",
      "PI_SUBAGENT_INTERCOM_SESSION_NAME",
    ]) {
      delete process.env[key];
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
    // Only teardown is emitted explicitly. All delivery/settlement events come from native Pi.
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    await session.abort();
    session.dispose();
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
  await sender.connect({ name: `sender-${name}`, cwd, model: "fixture" });
  await session.bindExtensions({
    mode: options.hasUI === true ? "rpc" : "print",
    ...(options.hasUI === true ? { uiContext: { ...session.extensionRunner.getUIContext() } } : {}),
    onError: (error) => {
      errors.push(error);
    },
  });
  await waitFor(
    async () => (await sender.listSessions()).some((peer) => peer.name === name),
    "receiver registration",
  );
  // These are messaging/recovery contracts; the dedicated lazy-coordination suite owns untouched startup.
  const loadControls = async () => {
    for (const toolName of [
      "load_intercom",
      ...(options.subagents !== undefined && options.subagents !== false ? ["load_subagent"] : []),
    ]) {
      const tool = registeredTool(session, toolName);
      // SDK control loading mutates the active tool set in this registration order.
      // oxlint-disable-next-line no-await-in-loop
      await tool.execute("fixture-load", { advanced: false }, new AbortController().signal);
    }
  };
  await loadControls();
  return {
    session,
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
      sends.push(id);
      const receipt = await sender.send(name, { ...input, messageId: id });
      assert.equal(receipt.accepted, true);
      return receipt;
    },
    status: async () => {
      if (!session.agent.state.tools.some((tool) => tool.name === "intercom")) {
        await loadControls();
      }
      const tool = registeredTool(session, "intercom");
      return JSON.stringify(
        await tool.execute("fixture-status", { action: "status" }, new AbortController().signal),
      );
    },
  };
}

test("native Doctor reports broker registration and loaded compiled identity, not changed files on disk", async (t) => {
  const packageCopy = realpathSync(mkdtempSync(path.join(repo, "node_modules", ".pi-doctor-")));
  cpSync(path.join(repo, "dist"), path.join(packageCopy, "dist"), { recursive: true });
  const manifest = json(readFileSync(path.join(repo, "package.json"), "utf8"));
  writeFileSync(path.join(packageCopy, "package.json"), JSON.stringify(manifest));
  const receiver = await makeSession(t, "doctor-loaded", {
    subagents: path.join(packageCopy, "dist/extension/index.js"),
  });
  t.after(() => rmSync(packageCopy, { recursive: true, force: true }));
  const loader = registeredTool(receiver.session, "load_subagent");
  await loader.execute("load", {}, new AbortController().signal);
  const subagent = registeredTool(receiver.session, "subagent");
  const doctor = async () => {
    const result = await subagent.execute(
      "doctor",
      { action: "doctor" },
      new AbortController().signal,
    );
    assert.equal(result.isError, undefined);
    return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
  };
  const before = await doctor();
  assert.match(before, /- bridge: responding\n- connection: connected/);
  const registered = observedSession(
    await receiver.sender.listSessions(),
    (peer) => peer.name === "doctor-loaded",
  );
  assert.ok(before.includes(`- broker session id: ${registered.id}`));
  assert.ok(before.includes(`- Node: ${process.version}`));
  assert.ok(before.includes(`- process: ${process.pid} (${process.execPath})`));
  assert.ok(
    before.includes(
      `- Pi SDK resource directory: ${sdkRoot} (may be overridden; not executable provenance)`,
    ),
  );
  assert.ok(
    before.includes(`- extension module: ${path.join(packageCopy, "dist/extension/doctor.js")}`),
  );
  const build = before.match(/^- loaded pi-subagents build: (.+)$/m)?.[1];
  assertDefined(build);
  assert.ok(
    build.startsWith(`${text(manifest.version)} (runtime SHA-256 `),
    "Doctor must identify the loaded compiled build",
  );
  assert.match(build, /[0-9a-f]{64}\)$/);
  assert.match(before, /- native queue contract: not verified/);
  writeFileSync(
    path.join(packageCopy, "package.json"),
    JSON.stringify({ ...manifest, version: "99.0.0" }),
  );
  writeFileSync(
    path.join(packageCopy, "dist/extension/build-info.js"),
    `export const EXTENSION_BUILD = { version: "99.0.0", sha256: "${"0".repeat(64)}" };\n`,
  );
  const after = await doctor();
  assert.equal(
    after.match(/^- loaded pi-subagents build: (.+)$/m)?.[1],
    build,
    "on-disk replacement does not change loaded code identity",
  );
  assert.equal(receiver.faux.state.callCount, 0);
  assert.deepEqual(receiver.errors, []);
  if (evidenceDir !== undefined && evidenceDir !== "") {
    writeFileSync(
      path.join(root, "doctor-loaded-identity.json"),
      JSON.stringify({ before, after }, null, 2),
    );
  }
});

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
  // This is receipt indexing, not a new explicit-message-ID deduplication policy.
  await receiver.send("after-branch", {
    text: "explicit same-ID send remains a second send",
    delivery: "passive",
  });
  await waitFor(
    () => receiver.visible("after-branch").length === 2,
    "unchanged explicit same-ID behavior",
  );
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
  receiver.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
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
  await receiver.send("steer");
  await receiver.send("queued", { text: "message:queued", delivery: "queue" });
  await receiver.send("passive", { text: "message:passive", delivery: "passive" });
  await waitFor(
    async () => (await receiver.status()).includes("Pending inbound messages: 3"),
    "all inbound messages",
  );
  toolGate.resolve();
  await running;
  await waitFor(() => receiver.visible("passive").length === 1, "idle passive flush");
  assert.match(seen[0], /message:steer/);
  assert.doesNotMatch(seen[0], /message:queued|message:passive/);
  assert.match(seen[1], /message:queued/);
  assert.doesNotMatch(seen[1], /message:passive/);
  for (const id of receiver.sends) {
    assert.equal(receiver.visible(id).length, 1, id);
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
    for (let index = 0; index < count; index++) {
      // Populate native handoffs in send order before the clear.
      // oxlint-disable-next-line no-await-in-loop
      await receiver.send(`cleared-${index}`);
    }
    await waitFor(
      async () => (await receiver.status()).includes(`Pending inbound messages: ${count}`),
      "native handoffs",
    );
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
    const expectedRequests = repeat === true ? 3 : 2;
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
    const resultId = "subagent-completion:recovery-arrival";
    let api: ExtensionAPI | undefined,
      toolStarted = false,
      seen = "";
    let acknowledged: Promise<boolean> | undefined, sends: Promise<unknown[]> | undefined;
    let stageAtAck: unknown, visibleAtAck: number | undefined, stageAtDetach: unknown;
    const receiver = await makeSession(t, name, {
      hasUI,
      configure(pi) {
        api = pi;
        pi.events.on("subagent:result-intercom-delivery", () => {
          stageAtAck = receiver.session.sessionManager
            .getEntries()
            .find(
              (entry) =>
                entry.type === "custom" &&
                entry.customType === "intercom_delivery" &&
                at(entry, "data", "entry", "message", "id") === resultId,
            );
          stageAtAck = at(stageAtAck, "data", "entry", "stage");
          visibleAtAck = receiver.visible(resultId).length;
        });
        if (hasUI) {
          pi.events.on("pi-intercom:detach-request", (payload) => {
            const stages = receiver.session.sessionManager
              .getEntries()
              .filter(
                (entry) =>
                  entry.type === "custom" &&
                  entry.customType === "intercom_delivery" &&
                  (at(entry, "data", "entry", "message", "id") === "new-steer" ||
                    at(entry, "data", "messageId") === "new-steer"),
              );
            if (stages.length === 0) {
              return;
            }
            const last = record(property(stages.at(-1), "data"));
            stageAtDetach = last.stage ?? at(last, "entry", "stage");
            pi.events.emit("pi-intercom:detach-response", {
              ...record(payload),
              accepted: true,
            });
          });
        }
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
        acknowledged = deliverSubagentResultIntercomEvent(
          requireApi(api).events,
          buildSubagentResultIntercomPayload({
            to: name,
            completionId: "recovery-arrival",
            runId: "arrival-run",
            mode: "single",
            source: "async",
            children: [
              {
                agent: "worker",
                index: 0,
                status: "completed",
                intercomTarget: `sender-${name}`,
                summary: "Self result during recovery",
              },
            ],
          }),
        );
        sends = Promise.all([
          receiver.send("new-steer", {
            text: `${hasUI ? "Subagent needs a supervisor decision.\n\n" : ""}Steer during recovery`,
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
    assert.equal(await acknowledged, true);
    assert.equal(
      stageAtAck,
      "queued",
      "ownership must precede native subscriber reentry; acknowledge durable staging",
    );
    assert.equal(visibleAtAck, 0, "the result must not start a turn between recovery followers");
    await sends;
    await waitFor(
      async () => (await receiver.status()).includes("Passive message"),
      "broker arrivals",
    );
    toolGate.resolve();
    await running;
    await waitFor(
      () =>
        receiver.sends.every((id) => receiver.visible(id).length === 1) &&
        receiver.visible(resultId).length === 1 &&
        receiver.session.isIdle,
      "all arrivals delivered once",
    );
    if (hasUI) {
      assert.equal(
        stageAtDetach,
        "native",
        "hand off the staged blocking steer before requesting foreground detachment",
      );
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
    assert.match(seen, /Self result during recovery/);
    assert.match(seen, /Steer during recovery/);
    assert.doesNotMatch(seen, /Ordinary queued message|Passive message/);
    assert.equal(receiver.visible(resultId).length, 1);
    for (const id of receiver.sends) {
      assert.equal(receiver.visible(id).length, 1, id);
    }
    assert.match(await receiver.status(), /Pending inbound messages: 0/);
    assert.deepEqual(receiver.errors, []);
  });
}

test("native ordinary steer bursts do not retain unanswered attention handshakes", async (t) => {
  const responseGate = gate(t);
  let active = 0,
    peak = 0;
  const eventBus = createEventBus();
  const original = eventBus.on.bind(eventBus);
  eventBus.on = (channel, handler) => {
    if (channel !== "pi-intercom:detach-response") {
      return original(channel, handler);
    }
    active++;
    peak = Math.max(peak, active);
    const unsubscribe = original(channel, handler);
    let subscribed = true;
    return () => {
      if (subscribed) {
        active--;
        subscribed = false;
      }
      unsubscribe();
    };
  };
  const receiver = await makeSession(t, "attention-burst", { eventBus });
  receiver.faux.setResponses([
    async () => {
      await responseGate.promise;
      return fauxAssistantMessage("First response");
    },
    fauxAssistantMessage("Directions handled"),
  ]);
  const running = receiver.session.prompt("Hold while ordinary steers arrive");
  try {
    await waitFor(() => receiver.faux.state.callCount === 1, "held provider");
    for (let index = 0; index < 12; index++) {
      // Exercise the ordered native burst rather than concurrent broker races.
      // oxlint-disable-next-line no-await-in-loop
      await receiver.send(`burst-${index}`);
    }
    await waitFor(
      async () => (await receiver.status()).includes("Pending inbound messages: 12"),
      "all native handoffs",
    );
    const retained = active;
    receiver.events.push({ type: "fixture.attention-handshakes", peak, retained });
    t.diagnostic(`Attention response listeners: peak=${peak}, after handoff=${retained}.`);
    assert.equal(
      retained,
      0,
      "without an owned wait, ordinary attention needs no outstanding response listener",
    );
  } finally {
    responseGate.resolve();
    await running;
  }
  for (const id of receiver.sends) {
    assert.equal(receiver.visible(id).length, 1);
  }
  assert.deepEqual(receiver.errors, []);
});

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
  await sleep(30);
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
  test(`native ${recovery ? "recovered plain/ask" : "idle passive/plain/multi-ask"} batch keeps the selected ask as the default reply target`, async (t) => {
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
        ...(recovery ? { delivery: "steer" } : {}),
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
  assert.deepEqual(asker.errors, []);
});

test("native rejected input leaves the active intercom run and idle wait intact", async (t) => {
  const inputRelease = gate(t);
  const responseRelease = gate(t);
  const losingInput = "User input held before admission";
  const preflight: unknown[] = [];
  let inputHeld = false,
    beforeStarts = 0,
    seen = "";
  const receiver = await makeSession(t, "input-rejection", {
    configure(pi) {
      pi.on("input", async (event) => {
        if (event.text === losingInput) {
          inputHeld = true;
          await inputRelease.promise;
        }
      });
      pi.on("before_agent_start", () => {
        beforeStarts++;
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
      beforeStarts,
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
    assert.equal(
      beforeStarts,
      0,
      "custom delivery bypasses user preparation; rejected input must not prepare replay",
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
    assert.equal(beforeStarts, 0);
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

test("native pre-admission user preparation allows a separate custom run without losing or duplicating either input", async (t) => {
  const startupRelease = gate(t);
  const userPrompt = "User startup held before the agent runs";
  let beforeStarts = 0;
  const seen: string[] = [];
  const receiver = await makeSession(t, "startup-queued", {
    configure(pi) {
      pi.on("before_agent_start", async (event) => {
        beforeStarts++;
        if (event.prompt === userPrompt) {
          await startupRelease.promise;
        }
      });
    },
  });
  receiver.faux.setResponses([
    (context: unknown) => {
      seen.push(JSON.stringify(context));
      return fauxAssistantMessage("Custom input handled");
    },
    (context: unknown) => {
      seen.push(JSON.stringify(context));
      return fauxAssistantMessage("User input handled");
    },
  ]);
  const running = receiver.session.prompt(userPrompt);
  try {
    await waitFor(() => beforeStarts === 1, "held user preparation");
    receiver.events.push({
      type: "fixture.user_preparation",
      idle: receiver.context().isIdle(),
      streaming: receiver.session.isStreaming,
      beforeStarts,
      providerCalls: receiver.faux.state.callCount,
    });
    assert.equal(receiver.faux.state.callCount, 0);
    await receiver.send("startup-queued");
    await waitFor(
      () => receiver.settled() === 1 && receiver.session.isIdle,
      "separate custom run settlement before user admission",
    );
    assert.equal(beforeStarts, 1, "custom delivery does not run user preparation hooks");
    assert.equal(receiver.faux.state.callCount, 1);
    assert.equal(receiver.visible("startup-queued").length, 1);
    assert.doesNotMatch(seen[0], /User startup held before the agent runs/);
    assert.equal(seen[0].split("message:startup-queued").length - 1, 1);
    startupRelease.resolve();
    await running;
    await receiver.session.waitForIdle();
    assert.equal(beforeStarts, 1);
    assert.equal(receiver.faux.state.callCount, 2);
    assert.equal(receiver.settled(), 2);
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
    for (const body of [userPrompt, "message:startup-queued"]) {
      assert.equal(seen[1].split(body).length - 1, 1, body);
    }
    assert.equal(receiver.context().isIdle(), true);
    assert.equal(receiver.context().signal, undefined);
    assert.equal(receiver.context().hasPendingMessages(), false);
    assert.deepEqual(
      receiver.events
        .filter((event) => event.type === "extension.message_end" && event.role === "assistant")
        .map((event) => event.stopReason),
      ["stop", "stop"],
    );
    assert.match(await receiver.status(), /Pending inbound messages: 0/);
    assert.deepEqual(receiver.errors, []);
    receiver.events.push({
      type: "fixture.startup_complete",
      providerContexts: seen,
      settled: receiver.settled(),
    });
    t.diagnostic(
      "Official 1.0 preparation precedes admission: custom input legitimately runs separately, then user admission retains both inputs exactly once without replay.",
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
  assert.equal(
    receiver.events.filter(
      (event) => event.type === "extension.message_end" && event.id === "appended-follower",
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

test("native supervisor question survives reload and consumes the saved answer once", async (t) => {
  const supervisor = await makeSession(t, "question-supervisor");
  supervisor.faux.setResponses([fauxAssistantMessage("Question received")]);
  const runId = "native-question-run";
  const ownerId = supervisor.session.sessionManager.getSessionId();
  saveQuestionOwner(runId, ownerId);
  const child = await makeSession(t, "question-child", {
    child: { runId, supervisor: "question-supervisor" },
  });
  child.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("contact_supervisor", {
        reason: "need_decision",
        message: "Which path should I use?",
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Saved answer applied"),
  ]);
  const running = child.session.prompt("Ask the supervisor");
  await waitFor(
    () => listSupervisorQuestions(ownerId, runId).length === 1 && supervisor.settled() === 1,
    "durable native question",
  );
  const question = listSupervisorQuestions(ownerId, runId)[0];
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
  t.diagnostic(
    "real contact_supervisor tool wait; supervisor reload; durable answer consumed by live child once; no notification replay.",
  );
});

test("native agent_runs answer clears the parent's intercom pending asks and presence", async (t) => {
  const supervisor = await makeSession(t, "answer-supervisor", { subagents: true });
  const runId = "native-answer-presence";
  const ownerId = supervisor.session.sessionManager.getSessionId();
  saveQuestionOwner(runId, ownerId);
  supervisor.faux.setResponses([
    fauxAssistantMessage("Question received"),
    () =>
      fauxAssistantMessage(
        fauxToolCall("agent_runs", {
          action: "answer",
          id: runId,
          questionId: listSupervisorQuestions(ownerId, runId)[0].questionId,
          message: "Use the native path.",
        }),
        { stopReason: "toolUse" },
      ),
    fauxAssistantMessage("Answer saved"),
  ]);
  const child = await makeSession(t, "answer-child", {
    child: { runId, supervisor: "answer-supervisor" },
  });
  child.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("contact_supervisor", { reason: "need_decision", message: "Which path?" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Continuing with the answer"),
  ]);
  const running = child.session.prompt("Ask the supervisor");
  const presence = async () =>
    (await supervisor.sender.listSessions()).find((peer) => peer.name === "answer-supervisor");
  await waitFor(
    async () => supervisor.settled() === 1 && (await presence())?.pendingAsks === 1,
    "one unresolved supervisor ask",
  );
  await supervisor.session.prompt("Answer the question");
  await running;
  assert.equal(listSupervisorQuestions(ownerId, runId)[0]?.state, "answered");
  assert.equal(
    (await presence())?.pendingAsks,
    0,
    "saved answers must clear live intercom ask presence too",
  );
  const intercom = registeredTool(supervisor.session, "intercom");
  const pending = await intercom.execute(
    "fixture-pending",
    { action: "pending" },
    new AbortController().signal,
  );
  assert.match(JSON.stringify(pending), /No unresolved inbound asks/);
  assert.deepEqual([...child.errors, ...supervisor.errors], []);
  t.diagnostic(
    "actual agent_runs answer + durable child delivery leave no unresolved intercom ask or stale presence count.",
  );
});

test("native supervisor ask releases a controlled busy tool and reaches the model before the reply", async (t) => {
  const foregroundWait = gate(t);
  let busy = false;
  let detachRequests = 0;
  let checkpointBeforeDetach = false;
  let modelSawQuestion = false;
  const supervisor = await makeSession(t, "busy-supervisor", {
    hasUI: true,
    configure(pi) {
      pi.registerTool({
        name: "foreground_wait",
        label: "Foreground Wait",
        description: "Controlled foreground wait",
        parameters: Type.Object({}),
        async execute() {
          busy = true;
          await foregroundWait.promise;
          return { content: [{ type: "text", text: "Released to answer the child" }], details: {} };
        },
      });
      pi.events.on("pi-intercom:detach-request", (payload) => {
        detachRequests++;
        checkpointBeforeDetach = JSON.stringify(
          supervisor.session.sessionManager.getEntries(),
        ).includes("Choose the native path?");
        foregroundWait.resolve();
        pi.events.emit("pi-intercom:detach-response", {
          ...record(payload),
          accepted: true,
        });
      });
    },
  });
  supervisor.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("foreground_wait", {}), { stopReason: "toolUse" }),
    (context: unknown) => {
      modelSawQuestion = JSON.stringify(context).includes("Choose the native path?");
      return fauxAssistantMessage(
        fauxToolCall("intercom", { action: "reply", message: "Use the native path." }),
        { stopReason: "toolUse" },
      );
    },
    fauxAssistantMessage("Parent continued"),
  ]);
  const parentRun = supervisor.session.prompt("Wait for child work");
  await waitFor(() => busy, "native parent tool wait");
  const runId = "native-busy-question";
  const ownerId = supervisor.session.sessionManager.getSessionId();
  saveQuestionOwner(runId, ownerId);
  const child = await makeSession(t, "busy-question-child", {
    child: { runId, supervisor: "busy-supervisor" },
  });
  child.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("contact_supervisor", {
        reason: "need_decision",
        message: "Choose the native path?",
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Child continued"),
  ]);
  const childRun = child.session.prompt("Ask before continuing");
  await waitFor(() => modelSawQuestion, "model-visible blocking question, not only saved state");
  await Promise.all([parentRun, childRun]);
  const question = listSupervisorQuestions(ownerId, runId)[0];
  assert.equal(detachRequests, 1);
  assert.equal(
    checkpointBeforeDetach,
    true,
    "persist the blocking notification before awaiting foreground detachment",
  );
  assert.equal(supervisor.visible(question.questionId).length, 1);
  assert.equal(question.state, "answered");
  assert.equal(supervisor.faux.state.callCount, 3);
  assert.equal(child.faux.state.callCount, 2);
  assert.deepEqual([...child.errors, ...supervisor.errors], []);
  t.diagnostic(
    "actual native tool boundary + intercom detach handshake; parent provider sees the blocking question once and replies before child continues.",
  );
});

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

for (const scenario of ["completed", "live", "guard", "question"] as const) {
  test(`native queued idle attention rechecks ${scenario} child before waking the parent`, async (t) => {
    const hold = gate(t);
    let api: ExtensionAPI | undefined,
      started = false;
    const parent = await makeSession(t, `idle-notice-${scenario}`, {
      subagents: process.env.PI_INTERCOM_TEST_SUBAGENTS ?? true,
      configure(pi) {
        api = pi;
      },
    });
    const seen: string[] = [];
    parent.faux.setResponses([
      async () => {
        started = true;
        await hold.promise;
        return fauxAssistantMessage("Parent work finished");
      },
      (context: unknown) => {
        seen.push(JSON.stringify(context));
        return fauxAssistantMessage("Saved work considered");
      },
    ]);
    const runId = randomUUID(),
      asyncDir = path.join(root, runId);
    mkdirSync(asyncDir);
    const status = {
      runId,
      state: "running",
      mode: "single",
      startedAt: Date.now(),
      steps: [{ agent: "worker", status: "running" }],
    };
    writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(status));
    const event = {
      type: "needs_attention",
      to: "needs_attention",
      ts: Date.now(),
      runId,
      agent: "worker",
      index: 0,
      reason: scenario === "guard" ? "completion_guard" : "idle",
      ...(scenario === "question"
        ? { supervisorQuestion: { questionId: "unanswered", state: "awaiting_input" } }
        : {}),
      message: `NOTICE_${scenario}`,
    };
    const details = { source: "async", asyncDir, event, noticeText: `NOTICE_${scenario}` };
    const raw =
      JSON.stringify({ type: "subagent.control", ...details, channels: ["event"] }) + "\n";
    writeFileSync(path.join(asyncDir, "events.jsonl"), raw);
    const pending = parent.session.prompt("Finish current parent work");
    await waitFor(() => started, "busy native parent");
    requireApi(api).events.emit("subagent:control-event", details);
    if (scenario !== "live") {
      writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify({
          ...status,
          state: scenario === "guard" ? "failed" : "complete",
          steps: [{ agent: "worker", status: "completed" }],
        }),
      );
      requireApi(api).sendMessage(
        { customType: "fixture-child-result", content: "SAVED_CHILD_RESULT", display: true },
        { triggerTurn: false },
      );
    }
    hold.resolve();
    await pending;
    await parent.session.waitForIdle();
    const shouldWake = scenario === "live" || scenario === "question";
    assert.equal(
      parent.faux.state.callCount,
      shouldWake ? 2 : 1,
      "obsolete idle notices must not start another model turn",
    );
    if (!shouldWake) {
      await parent.session.prompt("Read saved work");
    }
    assert.equal(seen.length, 1);
    assert.equal(seen[0].includes(`NOTICE_${scenario}`), scenario !== "completed");
    if (scenario !== "live") {
      assert.ok(seen[0].includes("SAVED_CHILD_RESULT"), "terminal result remains visible");
    }
    assert.equal(
      readFileSync(path.join(asyncDir, "events.jsonl"), "utf8"),
      raw,
      "raw control history is preserved",
    );
    assert.deepEqual(parent.errors, []);
  });
}

test("native unread terminal idle notices are discarded while guard findings and raw history survive", async (t) => {
  let api: ExtensionAPI | undefined;
  const parent = await makeSession(t, "idle-notice-unread", {
    subagents: process.env.PI_INTERCOM_TEST_SUBAGENTS ?? true,
    configure(pi) {
      api = pi;
    },
  });
  const runId = randomUUID(),
    asyncDir = path.join(root, runId);
  mkdirSync(asyncDir);
  writeFileSync(
    path.join(asyncDir, "status.json"),
    JSON.stringify({
      runId,
      state: "failed",
      mode: "single",
      startedAt: Date.now(),
      steps: [{ agent: "worker", status: "failed" }],
    }),
  );
  const raw =
    ["idle", "completion_guard"]
      .map((reason) =>
        JSON.stringify({
          type: "subagent.control",
          channels: ["event", "intercom"],
          event: {
            type: "needs_attention",
            to: "needs_attention",
            reason,
            ts: Date.now(),
            runId,
            agent: "worker",
            index: 0,
            message: `UNREAD_${reason}`,
          },
          noticeText: `UNREAD_${reason}`,
          intercom: { to: "idle-notice-unread", message: `UNREAD_${reason}` },
        }),
      )
      .join("\n") + "\n";
  writeFileSync(path.join(asyncDir, "events.jsonl"), raw);
  requireApi(api).events.emit("subagent:async-started", { id: runId, asyncDir, agent: "worker" });
  await waitFor(
    () =>
      parent.session.sessionManager
        .getEntries()
        .some((entry) => property(entry, "content") === "UNREAD_completion_guard"),
    "unread control events consumed",
  );
  await parent.session.waitForIdle();
  assert.equal(parent.faux.state.callCount, 0, "terminal idle events cannot wake the parent");
  assert.equal(
    parent.session.sessionManager
      .getEntries()
      .some((entry) => property(entry, "content") === "UNREAD_idle"),
    false,
  );
  assert.equal(readFileSync(path.join(asyncDir, "events.jsonl"), "utf8"), raw);
  assert.deepEqual(parent.errors, []);
});

test("native context omits previously delivered idle attention for a finished child without changing history", async (t) => {
  let api: ExtensionAPI | undefined;
  const parent = await makeSession(t, "idle-notice-history", {
    subagents: process.env.PI_INTERCOM_TEST_SUBAGENTS ?? true,
    configure(pi) {
      api = pi;
    },
  });
  const runId = randomUUID(),
    asyncDir = path.join(root, runId);
  mkdirSync(asyncDir);
  const status = {
    runId,
    state: "running",
    mode: "parallel",
    startedAt: Date.now(),
    steps: [
      { agent: "worker", status: "running" },
      { agent: "sibling", status: "running" },
    ],
  };
  writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(status));
  const seen: string[] = [];
  parent.faux.setResponses([
    fauxAssistantMessage("Active child needs attention"),
    (context: unknown) => {
      seen.push(JSON.stringify(context));
      return fauxAssistantMessage("Sibling still working");
    },
  ]);
  requireApi(api).events.emit("subagent:control-event", {
    source: "async",
    asyncDir,
    event: {
      type: "needs_attention",
      to: "needs_attention",
      reason: "idle",
      ts: Date.now(),
      runId,
      agent: "worker",
      index: 0,
      message: "Worker is waiting for attention while its sibling runs",
    },
    noticeText: "PREVIOUS_IDLE_NOTICE",
  });
  await waitFor(() => parent.faux.state.callCount === 1, "live notice delivered");
  await parent.session.waitForIdle();
  const original = parent.session.sessionManager
    .getEntries()
    .find((entry) => property(entry, "content") === "PREVIOUS_IDLE_NOTICE");
  assert.ok(original);
  status.steps[0].status = "completed";
  writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(status));
  await parent.session.prompt("Consider the remaining sibling");
  assert.equal(
    seen[0].includes("PREVIOUS_IDLE_NOTICE"),
    false,
    "a completed child cannot stay idle just because its sibling is running",
  );
  assert.deepEqual(
    parent.session.sessionManager
      .getEntries()
      .find((entry: { readonly id: string }) => entry.id === original.id),
    original,
  );
  assert.deepEqual(parent.errors, []);
});

for (const scenario of ["question", "tool"] as const) {
  test(`native owner attention uses observed ${scenario} state and still finishes normally`, async (t) => {
    const name = `attention-bg-${scenario}`;
    let api: ExtensionAPI | undefined;
    const parent = await makeSession(t, name, {
      configure(pi) {
        api = pi;
      },
    });
    parent.faux.setResponses([
      fauxAssistantMessage("Synthetic question or attention noted"),
      ...(scenario === "question" ? [fauxAssistantMessage("Synthetic supervisor wait noted")] : []),
    ]);
    const owner = parent.session.sessionManager.getSessionId();
    const directory = path.join(root, `${name}-child`),
      bin = path.join(directory, "bin"),
      release = path.join(directory, "release");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      path.join(bin, "pi"),
      `#!/bin/sh\nexec "${process.execPath}" "${path.join(repo, "test/fixtures/native-feedback-child.mjs")}" "$@"\n`,
      { mode: 0o700 },
    );
    const savedEnv = {
      PATH: process.env.PATH,
      PI_FEEDBACK_RELEASE_FILE: process.env.PI_FEEDBACK_RELEASE_FILE,
      PI_FEEDBACK_SCENARIO: process.env.PI_FEEDBACK_SCENARIO,
    };
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
    process.env.PI_FEEDBACK_RELEASE_FILE = release;
    process.env.PI_FEEDBACK_SCENARIO = scenario;
    saveQuestionOwner(name, owner);
    const controlConfig = resolveControlConfig({ needsAttentionAfterMs: 300 });
    const agent = makeAgent("worker", {
      model: "feedback-fixture/faux-1",
      extensions: [],
    });
    let asyncDir: string | undefined, pending: Promise<unknown> | undefined;
    let tearingDown = false;
    const releaseChild = () => {
      writeFileSync(release, "released");
      for (const question of listSupervisorQuestions(owner, name)) {
        if (question.state === "awaiting_input") {
          saveQuestionAnswer(question, "Use the synthetic native path.");
        }
      }
    };
    const waitForChild = () => {
      const runDirectory = asyncDir;
      if (runDirectory === undefined) {
        return pending;
      }
      // Completion and native exit are bounded only after the held child is released.
      pending ??= (async () => {
        let failure: Error | undefined, status: ReturnType<typeof json> | undefined;
        try {
          await waitFor(() => {
            if (tearingDown) {
              releaseChild();
            }
            return (
              existsSync(path.join(runDirectory, "status.json")) &&
              json(readFileSync(path.join(runDirectory, "status.json"), "utf8")).state !== "running"
            );
          }, "async child completion");
          status = json(readFileSync(path.join(runDirectory, "status.json"), "utf8"));
          assert.equal(status.state, "complete");
        } catch (error) {
          if (!(error instanceof Error)) {
            retainRoot = true;
            throw error;
          }
          failure = error;
        }
        try {
          // Completion failure cannot stand in for observing the actual runner's exit.
          await waitFor(() => {
            if (tearingDown) {
              releaseChild();
            }
            if (!existsSync(path.join(runDirectory, "status.json"))) {
              return false;
            }
            const observed = json(readFileSync(path.join(runDirectory, "status.json"), "utf8"));
            return !questionProcessAlive({ pid: numberValue(observed.pid) });
          }, "private runner exit");
        } catch (error) {
          retainRoot = true;
          if (failure === undefined) {
            throw error;
          }
          t.diagnostic(`Private runner custody remains uncertain: ${errorMessage(error)}`);
        }
        if (failure !== undefined) {
          throw failure;
        }
        return status;
      })();
      return pending;
    };
    t.after(async () => {
      try {
        tearingDown = true;
        releaseChild();
        await waitForChild();
      } catch (error) {
        retainRoot = true;
        throw error;
      } finally {
        for (const [key, value] of Object.entries(savedEnv)) {
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
      }
    });
    {
      const started = executeAsyncSingle(name, {
        agent: "worker",
        task: "Synthetic attention check",
        agentConfig: agent,
        ctx: { pi: requireApi(api), cwd: directory, currentSessionId: owner },
        sessionFile: path.join(directory, "session.jsonl"),
        shareEnabled: false,
        maxSubagentDepth: 1,
        controlConfig,
        controlIntercomTarget: name,
        childIntercomTarget: () => `${name}-child`,
      });
      assert.ok(started.isError !== true, textAt(started.content));
      asyncDir = text(started.details.asyncDir);
    }
    const childReceipt = () => json(readFileSync(`${release}.json`, "utf8"));
    await waitFor(
      () =>
        existsSync(`${release}.json`) &&
        records(childReceipt().events).some((event) => event.type === "tool_execution_start"),
      "real native child tool start",
    );
    const toolStartedAt = numberValue(
      record(records(childReceipt().events).find((event) => event.type === "tool_execution_start"))
        .timestamp,
    );
    if (scenario === "question") {
      await waitFor(
        () => listSupervisorQuestions(owner, name)[0]?.state === "awaiting_input",
        "real durable contact_supervisor wait",
      );
    }
    const readNotices = () =>
      existsSync(path.join(asyncDir, "events.jsonl"))
        ? readFileSync(path.join(asyncDir, "events.jsonl"), "utf8")
            .trim()
            .split("\n")
            .map((line) => json(line))
            .filter((entry) => entry.type === "subagent.control")
        : [];
    await waitFor(
      () =>
        readNotices().some(
          ({ event }) =>
            numberValue(record(event).ts) > toolStartedAt + controlConfig.needsAttentionAfterMs,
        ),
      "runner idle producer event",
    );
    const notice = readNotices().find(
      ({ event }) =>
        numberValue(record(event).ts) > toolStartedAt + controlConfig.needsAttentionAfterMs,
    );
    assertDefined(notice);
    const event = parseControlEvent(notice.event);
    handleSubagentControlNotice({
      pi: requireApi(api),
      visibleControlNotices: new Set(),
      details: {
        event,
        noticeText: text(notice.noticeText),
        asyncDir,
        source: "async",
        childIntercomTarget: `${name}-child`,
      },
    });
    await waitFor(
      () =>
        parent.session.sessionManager
          .getEntries()
          .some(
            (entry: { readonly type: string; readonly customType?: string }) =>
              entry.type === "custom_message" && entry.customType === "subagent_control_notice",
          ),
      "native attention custom message",
    );
    const message = parent.session.sessionManager
      .getEntries()
      .filter((entry) => entry.type === "custom_message")
      .find((entry) => entry.customType === "subagent_control_notice");
    assertDefined(message);
    assert.ok(typeof message.content === "string");
    assert.equal(message.content, notice.noticeText);
    if (scenario === "question") {
      const question = listSupervisorQuestions(owner, name)[0];
      assert.match(message.content, /Waiting for supervisor input/);
      assert.ok(message.content.includes(question.questionId));
      assert.match(message.content, /agent_runs\(\{ action: "answer"/);
      assert.doesNotMatch(message.content, /waiting for user|What are you blocked on/i);
      saveQuestionAnswer(question, "Use the synthetic native path.");
    } else {
      assert.match(
        message.content,
        /bash still active for \d+s; no observed output\/events for \d+s/,
      );
      assert.match(message.content, /Inspect command progress/);
      assert.doesNotMatch(
        message.content,
        /Waiting for supervisor input|timed out|making progress/,
      );
      writeFileSync(release, "released");
    }
    assert.equal(event.currentTool, scenario === "question" ? "contact_supervisor" : "bash");
    assert.ok(numberValue(event.currentToolDurationMs) >= controlConfig.needsAttentionAfterMs);
    assert.ok(numberValue(event.elapsedMs) >= controlConfig.needsAttentionAfterMs);
    assert.match(message.content, /agent_runs\(\{ action: "inspect"/);
    assert.doesNotMatch(message.content, /subagent\(\{ action: "(?:status|nudge|interrupt)"/);
    await waitForChild();
    assert.equal(childReceipt().modelCalls, 2);
    assert.equal(childReceipt().networkRequests, 0);
    assert.deepEqual(childReceipt().errors, []);
    if (scenario === "question") {
      assert.equal(listSupervisorQuestions(owner, name)[0]?.state, "answered");
    }
    await parent.session.waitForIdle();
    for (const nativeMessage of parent.session.messages) {
      if (nativeMessage.role === "assistant") {
        assert.equal(nativeMessage.stopReason, "stop", nativeMessage.errorMessage);
      }
    }
    assert.deepEqual(parent.errors, []);
    t.diagnostic(
      `Real native ${scenario} + owner idle producer; observed tool/age and actionable notice, then normal completion (no 10-minute wait).`,
    );
  });
}

test("native obsolete completed-child progress stays in raw history without a late model wake", async (t) => {
  const hold = gate(t);
  let started = false,
    api: ExtensionAPI | undefined;
  const seen: string[] = [];
  const parent = await makeSession(t, "historical-busy", {
    hasUI: true,
    configure(pi) {
      api = pi;
      pi.registerTool({
        name: "hold",
        label: "Hold",
        description: "Synthetic blocking parent tool",
        parameters: Type.Object({}),
        async execute() {
          started = true;
          await hold.promise;
          return { content: [{ type: "text", text: "Released" }], details: {} };
        },
      });
    },
  });
  parent.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
    (context: unknown) => {
      seen.push(JSON.stringify(context));
      return fauxAssistantMessage("Result read");
    },
  ]);
  const running = parent.session.prompt("Hold for synthetic child work");
  await waitFor(() => started, "native blocking parent tool");
  const threadId = "subagent-progress:historical-run:worker:0";
  const sentAt = Date.now() - 120_000;
  const now = Date.now;
  try {
    Date.now = () => sentAt;
    await parent.send("superseded-progress", {
      text: "Earlier milestone",
      delivery: "queue",
      queueMode: "replace",
      threadId,
    });
    await parent.send("material-progress", {
      text: "Subagent progress update.\n\nFinishing the change.\nMATERIAL FINDING: preserve this complete body, even after acceptance.",
      delivery: "queue",
      queueMode: "replace",
      threadId,
    });
  } finally {
    Date.now = now;
  }
  await waitFor(
    async () => (await parent.status()).includes("MATERIAL FINDING"),
    "staged progress",
  );
  assert.equal(
    await deliverSubagentResultIntercomEvent(
      requireApi(api).events,
      buildSubagentResultIntercomPayload({
        to: "historical-busy",
        runId: "historical-run",
        mode: "single",
        source: "foreground",
        children: [
          {
            agent: "worker",
            index: 0,
            status: "completed",
            summary: "Final accepted result",
            intercomTarget: "sender-historical-busy",
          },
        ],
      }),
    ),
    true,
  );
  hold.resolve();
  await running;
  await waitFor(() => parent.session.isIdle, "parent completion");
  await sleep(600);
  assert.equal(parent.visible("material-progress").length, 0);
  assert.equal(parent.visible("superseded-progress").length, 0);
  assert.equal(parent.faux.state.callCount, 2, "obsolete progress must not wake another turn");
  assert.match(seen[0], /Final accepted result/);
  assert.doesNotMatch(seen[0], /MATERIAL FINDING/);
  const checkpoints = parent.session.sessionManager
    .getEntries()
    .filter((entry) => entry.type === "custom" && entry.customType === "intercom_delivery");
  assert.ok(
    checkpoints.some(
      (entry) =>
        at(entry, "data", "entry", "message", "id") === "material-progress" &&
        text(at(entry, "data", "entry", "bodyText")).includes("MATERIAL FINDING"),
    ),
    "original raw progress remains saved",
  );
  assert.ok(
    checkpoints.some(
      (entry) =>
        at(entry, "data", "messageId") === "material-progress" &&
        at(entry, "data", "stage") === "discarded",
    ),
  );
  assert.deepEqual(parent.errors, []);
});

test("native broker-staged progress recovers terminal child identity across reload and sender disconnect", async (t) => {
  const hold = gate(t);
  let api: ExtensionAPI | undefined,
    started = false;
  const parent = await makeSession(t, "historical-reload", {
    hasUI: true,
    configure(pi) {
      api = pi;
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
  parent.faux.setResponses([
    fauxAssistantMessage("Completion received"),
    fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("Independent work finished"),
    fauxAssistantMessage("Deferred finding read"),
  ]);
  const receipt = await parent.send("broker-delayed-progress", {
    text: "Finishing tests; material old warning retained",
    delivery: "queue",
    queueMode: "replace",
    threadId: "subagent-progress:reload-run:worker:0",
  });
  assert.equal(receipt.queued, true, "idle replace is staged by the real private broker");
  const completionId = "subagent-completion:reload-terminal";
  const summary = "Work finished\x1b[31m\x00after";
  assert.equal(
    await deliverSubagentResultIntercomEvent(
      requireApi(api).events,
      buildSubagentResultIntercomPayload({
        to: "historical-reload",
        completionId: "reload-terminal",
        runId: "reload-run",
        mode: "parallel",
        source: "async",
        children: [
          {
            agent: "worker",
            index: 0,
            status: "completed",
            summary,
            intercomTarget: "sender-historical-reload",
          },
          {
            agent: "sibling",
            index: 1,
            status: "detached",
            summary: "Still alive",
            intercomTarget: "sender-historical-reload",
          },
        ],
      }),
    ),
    true,
  );
  await waitFor(() => parent.settled() === 1, "completion before broker release");
  assert.equal(parent.visible(completionId).length, 1);
  assert.ok(
    text(parent.visible(completionId)[0].content).includes(summary),
    "local child output preserves literal ESC/NUL rather than adopting peer-wire restrictions",
  );
  const senderId = parent.sender.sessionId;
  assertDefined(senderId);
  await parent.sender.disconnect();
  const running = parent.session.prompt("Independent work while progress is deferred");
  await waitFor(() => started, "second native blocking tool");
  await waitFor(
    () =>
      parent.session.sessionManager
        .getEntries()
        .some(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === "intercom_delivery" &&
            at(entry, "data", "messageId") === "broker-delayed-progress" &&
            at(entry, "data", "stage") === "discarded",
        ),
    "obsolete broker progress discarded before receiver reload",
  );
  const aborting = parent.session.abort();
  hold.resolve();
  await running;
  await aborting;
  await parent.session.reload();
  await parent.session.prompt("Continue independent work after reload");
  await waitFor(() => parent.session.isIdle, "independent work after reload/disconnect");
  await parent.sender.connect(
    { name: "sender-historical-reload", cwd: parent.context().cwd, model: "fixture" },
    senderId,
  );
  await parent.send("post-reload-progress", {
    text: "An obsolete finding from the completed child after native reload",
    delivery: "queue",
    queueMode: "replace",
    threadId: "subagent-progress:reload-run:worker:0",
  });
  const discardedAfterReload = () =>
    parent.session.sessionManager
      .getEntries()
      .some(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === "intercom_delivery" &&
          at(entry, "data", "messageId") === "post-reload-progress" &&
          at(entry, "data", "stage") === "discarded",
      );
  await waitFor(
    () => discardedAfterReload() || parent.visible("post-reload-progress").length > 0,
    "the restored terminal association processes a new stale child update",
  );
  assert.equal(parent.visible("post-reload-progress").length, 0);
  assert.equal(
    discardedAfterReload(),
    true,
    "literal local output must restore terminal identity, not only remain in raw history",
  );
  await sleep(600);
  assert.equal(parent.visible("broker-delayed-progress").length, 0);
  assert.equal(parent.visible(completionId).length, 1, "reload must not replay a consumed result");
  assert.ok(text(parent.visible(completionId)[0].content).includes(summary));
  const checkpoints = parent.session.sessionManager
    .getEntries()
    .filter((entry) => entry.type === "custom" && entry.customType === "intercom_delivery");
  assert.equal(
    checkpoints.filter((entry) => at(entry, "data", "entry", "message", "id") === completionId)
      .length,
    1,
    "the real local result is checkpointed once",
  );
  assert.ok(
    checkpoints.some(
      (entry) =>
        at(entry, "data", "messageId") === "broker-delayed-progress" &&
        at(entry, "data", "stage") === "discarded",
    ),
    "reload retains the obsolete-progress tombstone",
  );
  assert.equal(
    parent.faux.state.callCount,
    3,
    "completion, interrupted work, and explicit post-reload prompt; no obsolete progress wake",
  );
  assert.deepEqual(parent.errors, []);
  t.diagnostic(
    "Terminal association restored from the existing saved delivery/receipt metadata, with broker delay and no replay.",
  );
});

test("native obsolete-progress suppression leaves detached, successor, unknown, wrong-sender, question and answer progress untouched", async (t) => {
  const hold = gate(t);
  let started = false,
    api: ExtensionAPI | undefined;
  const parent = await makeSession(t, "historical-boundaries", {
    hasUI: true,
    configure(pi) {
      api = pi;
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
  parent.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("Result read"),
    fauxAssistantMessage("Updates read"),
  ]);
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
  for (const item of cases) {
    // Preserve progress replacement order before the parent becomes idle.
    // oxlint-disable-next-line no-await-in-loop
    await parent.send(item.id, {
      text: `Subagent progress update. Finished? ${item.id}`,
      delivery: "queue",
      queueMode: "replace",
      threadId:
        item.threadId ??
        `subagent-progress:${item.runId ?? "mixed-run"}:${item.agent}:${item.index}`,
      expectsReply: item.expectsReply,
      replyTo: item.replyTo,
    });
  }
  const stranger = new IntercomClient();
  t.after(() => stranger.disconnect());
  await stranger.connect({ name: "unrelated-peer", cwd: root, model: "fixture" });
  assert.equal(
    (
      await stranger.send("historical-boundaries", {
        messageId: "wrong-sender",
        text: "Subagent progress update. Claimed completion",
        delivery: "queue",
        queueMode: "replace",
        threadId: "subagent-progress:mixed-run:worker:0",
      })
    ).accepted,
    true,
  );
  await waitFor(async () => {
    const status = await parent.status();
    return status.includes("Claimed completion") && status.includes("Finished? ask");
  }, "all messages staged, including the broker-delayed ask");
  assert.equal(
    await deliverSubagentResultIntercomEvent(
      requireApi(api).events,
      buildSubagentResultIntercomPayload({
        to: "historical-boundaries",
        runId: "mixed-run",
        mode: "parallel",
        source: "foreground",
        children: [
          {
            agent: "worker",
            index: 0,
            status: "completed",
            summary: "One child finished",
            intercomTarget: "sender-historical-boundaries",
          },
          {
            agent: "sibling",
            index: 1,
            status: "detached",
            summary: "Another child remains live",
            intercomTarget: "sender-historical-boundaries",
          },
          {
            agent: "asker",
            index: 3,
            status: "completed",
            summary: "Question control",
            intercomTarget: "sender-historical-boundaries",
          },
          {
            agent: "answerer",
            index: 4,
            status: "completed",
            summary: "Answer control",
            intercomTarget: "sender-historical-boundaries",
          },
        ],
      }),
    ),
    true,
  );
  hold.resolve();
  await running;
  await waitFor(
    () =>
      cases
        .filter(({ id }) => id !== "terminal")
        .every(({ id }) => parent.visible(id).length === 1) &&
      parent.visible("wrong-sender").length === 1 &&
      parent.session.isIdle,
    "all unrelated updates retained",
  );
  assert.equal(parent.visible("terminal").length, 0);
  for (const id of [
    ...cases.filter((item) => item.id !== "terminal").map((item) => item.id),
    "wrong-sender",
  ]) {
    assert.doesNotMatch(
      text(parent.visible(id)[0].content),
      /Historical\/deferred progress|Originally sent:/,
      id,
    );
  }
  assert.equal(parent.faux.state.callCount, 3);
  assert.deepEqual(parent.errors, []);
});

test("native contact_supervisor progress reaches the first tool boundary before the parent finishes", async (t) => {
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
  const child = await makeSession(t, "timely-progress-child", {
    child: { runId: "timely-progress-run", supervisor: "timely-progress-parent" },
  });
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
  const contact = registeredTool(child.session, "contact_supervisor");
  const receipt = await contact.execute(
    "timely-discovery",
    { reason: "progress_update", message: "A required migration changes the API decision." },
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
  assert.match(JSON.stringify(receipt), /broker acceptance does not confirm/i);
  secondGate.resolve();
  await running;
  assert.equal(parent.faux.state.callCount, 3, "no delayed progress-only turn");
  assert.deepEqual(parent.errors, []);
});

test("native owning-parent human messages preserve context and real consumption, without elevating peers", async (t) => {
  const hold = gate(t);
  let started = false,
    parentApi: ExtensionAPI | undefined,
    seen = "";
  const parent = await makeSession(t, "human-parent", {
    configure(pi) {
      parentApi = pi;
    },
  });
  const owner = parent.session.sessionManager.getSessionId();
  saveQuestionOwner("human-run", owner);
  const child = await makeSession(t, "human-child", {
    child: { runId: "human-run", supervisor: "human-parent" },
    configure(pi) {
      pi.registerTool({
        name: "hold",
        label: "Hold",
        description: "Controlled child tool",
        parameters: Type.Object({}),
        async execute() {
          started = true;
          await hold.promise;
          return { content: [{ type: "text", text: "Child tool finished" }], details: {} };
        },
      });
    },
  });
  child.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
    (context) => {
      seen = JSON.stringify(context);
      return fauxAssistantMessage("I will preserve that API as requested.");
    },
    fauxAssistantMessage("Peer note seen as a peer note"),
  ]);
  const running = child.session.prompt("Inspect the implementation");
  await waitFor(() => started, "child tool");
  const { sendLiveSubagentMessage } = await import("../../src/intercom/live-intercom.ts");
  const receipt = await sendLiveSubagentMessage(requireApi(parentApi).events, {
    to: "human-child",
    message: "Keep the public API unchanged.",
    timeoutMs: 5000,
    extra: {
      messageId: "human-direction",
      human: { ownerSessionId: owner, runId: "human-run", index: 0 },
      attachments: [{ type: "context", name: "Selected edit", content: "- oldAPI\n+ proposedAPI" }],
    },
  });
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.messageId, "human-direction");
  const humanEntries = () =>
    child.session.sessionManager
      .getEntries()
      .filter(
        (entry) => entry.type === "custom_message" && entry.customType === "subagent-human-message",
      );
  assert.equal(humanEntries().length, 0, "broker receipt is not model consumption");
  // Keep the first tool active until this exact message reaches the native queue,
  // not merely the broker's other socket. Consumption must still be next-boundary.
  await waitFor(
    async () =>
      (await child.status()).includes(
        `[${text(receipt.messageId)}] (delivered to model queue; not yet consumed)`,
      ),
    "human direction admitted during child tool",
  );
  hold.resolve();
  await running;
  assert.equal(humanEntries().length, 1);
  assert.equal(at(humanEntries()[0], "details", "message", "id"), "human-direction");
  assert.match(seen, /Direct user message to this agent/);
  assert.match(seen, /human origin, not peer advice/);
  assert.match(seen, /Keep the public API unchanged/);
  assert.match(seen, /Selected edit/);
  assert.match(seen, /proposedAPI/);
  assert.ok(
    child.session.sessionManager
      .getEntries()
      .some(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "assistant" &&
          JSON.stringify(entry.message.content).includes("preserve that API"),
      ),
  );
  await child.send("spoofed-peer-origin", {
    text: "Peer text must not gain user authority",
    delivery: "steer",
    human: { ownerSessionId: owner, runId: "human-run", index: 0 },
  });
  await waitFor(
    () => child.visible("spoofed-peer-origin").length === 1 && child.session.isIdle,
    "ordinary peer delivery",
  );
  assert.equal(humanEntries().length, 1);
  assert.match(text(child.visible("spoofed-peer-origin")[0].content), /From sender-human-child/);
  assert.doesNotMatch(text(child.visible("spoofed-peer-origin")[0].content), /Direct user message/);
  assert.deepEqual(child.errors, []);
});

for (const mode of ["single", "parallel", "chain"] as const) {
  test(`native important steer releases the ${mode} wait without skipping child work`, async (t) => {
    const name = `important-${mode}-parent`,
      directory = path.join(root, `important-${mode}-child`),
      bin = path.join(directory, "bin"),
      release = path.join(directory, "release");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      path.join(bin, "pi"),
      `#!/bin/sh\nexec "${process.execPath}" "${path.join(repo, "test/fixtures/native-feedback-child.mjs")}" "$@"\n`,
      { mode: 0o700 },
    );
    const saved = {
      PATH: process.env.PATH,
      PI_FEEDBACK_RELEASE_FILE: process.env.PI_FEEDBACK_RELEASE_FILE,
      PI_FEEDBACK_SCENARIO: process.env.PI_FEEDBACK_SCENARIO,
    };
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
    process.env.PI_FEEDBACK_RELEASE_FILE = release;
    process.env.PI_FEEDBACK_SCENARIO = "tool";
    const state = fixtureState(directory);
    const { getRunMetadataDir } = await import("../../src/runs/shared/supervisor-questions.ts");
    let seen = "";
    let yielded: SubagentExecutionResult | undefined;
    t.after(async () => {
      writeFileSync(release, "released");
      await waitFor(
        () =>
          [...state.ownedRuns.keys()].every((id) =>
            existsSync(path.join(getRunMetadataDir(id), "result.json")),
          ),
        "continued workflow cleanup",
      );
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    });
    const parent = await makeSession(t, name, {
      hasUI: true,
      configure(pi) {
        const executor = createSubagentExecutor({
          pi,
          state,
          config: {},
          asyncByDefault: false,
          tempArtifactsDir: directory,
          getSubagentSessionRoot: () => path.join(directory, "sessions"),
          expandTilde: (value) => value,
          discoverAgents: () => ({
            agents: [
              makeAgent("worker", {
                model: "feedback-fixture/faux-1",
                completionGuard: false,
              }),
            ],
          }),
        });
        pi.registerTool({
          name: "foreground_agent",
          label: "Foreground agent",
          description: "Wait for the real native child fixture",
          parameters: Type.Object({}),
          async execute(id, _args, signal, update, ctx) {
            const first: NonNullable<SubagentParamsLike["tasks"]>[number] = {
              agent: "worker",
              task: "STEP_A keep working",
              output: false,
            };
            const second: NonNullable<SubagentParamsLike["tasks"]>[number] = {
              agent: "worker",
              task: "STEP_B consume {previous}",
              output: false,
            };
            let request: SubagentParamsLike = first;
            if (mode === "parallel") {
              request = { tasks: [first, second], concurrency: 1 };
            }
            if (mode === "chain") {
              request = {
                chain: [
                  { agent: first.agent, task: first.task, output: false },
                  { agent: second.agent, task: second.task, output: false },
                ],
              };
            }
            yielded = await executor.execute({
              toolCallId: id,
              params: { ...request, async: false, context: "fresh", artifacts: false },
              signal,
              onUpdate: update,
              ctx,
            });
            return yielded;
          },
        });
      },
    });
    parent.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("foreground_agent", {}), { stopReason: "toolUse" }),
      (context) => {
        seen = JSON.stringify(context);
        return fauxAssistantMessage("Important direction handled before child completion");
      },
      fauxAssistantMessage("Final child result handled"),
    ]);
    const running = parent.session.prompt("Wait for the foreground child");
    const receipt = () => json(readFileSync(`${release}.json`, "utf8"));
    await waitFor(
      () =>
        existsSync(`${release}.json`) &&
        records(receipt().events).some((event) => event.type === "tool_execution_start"),
      "real native held child",
    );
    const firstPid = numberValue(receipt().pid);
    await parent.send(`important-during-${mode}`, {
      text: "Important direction: keep the current API.",
      delivery: "steer",
    });
    await running;
    assert.match(seen, /Important direction: keep the current API/);
    assert.match(seen, /Run .* is unchanged.*completion will arrive automatically/);
    assert.equal(
      questionProcessAlive({ pid: firstPid }),
      true,
      "the important message did not kill the child",
    );
    assert.equal(existsSync(release), false);
    assertDefined(yielded);
    const runId = text(record(yielded.details.wait).runId);
    const resultPath = path.join(getRunMetadataDir(runId), "result.json");
    const owned = state.ownedRuns.get(runId);
    assertDefined(owned);
    assert.equal(ownedRunView(owned, state).state, "live");
    assert.equal(
      existsSync(resultPath),
      false,
      "releasing a wait does not publish an early terminal result",
    );
    writeFileSync(release, "released");
    await waitFor(
      () => existsSync(resultPath),
      "all original workflow steps publish a final result",
    );
    const completed = state.ownedRuns.get(runId);
    assertDefined(completed);
    const view = ownedRunView(completed, state);
    assert.equal(view.state, "completed");
    assert.equal(view.children.length, mode === "single" ? 1 : 2);
    for (const child of view.children) {
      assert.equal(child.state, "completed");
      assertDefined(child.result);
      assert.equal(child.result.finalOutput, "Synthetic child finished normally");
    }
    if (mode === "chain") {
      assert.match(
        text(view.children[1].task),
        /STEP_B consume Synthetic child finished normally/,
        "dependent B receives A's real output",
      );
    }
    const terminalEvents = readFileSync(path.join(getRunMetadataDir(runId), "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => json(line))
      .filter((event) => event.type === "subagent.run.completed");
    assert.equal(terminalEvents.length, 1, "one durable completion after every original step");
    assert.equal(terminalEvents[0].status, "complete");
    assert.deepEqual(parent.errors, []);
  });
}

test("native topics keep routine state out of conversation and interrupt only relevant subscriptions", async (t) => {
  const publisher = await makeSession(t, "topic-publisher");
  const subscriber = await makeSession(t, "topic-subscriber");
  const late = await makeSession(t, "topic-late");
  const call = executeIntercom;
  const inspect = async (target: { readonly session: AgentSession }) =>
    JSON.stringify(await call(target, { action: "topics", topic: "browser/shared-test" }));
  subscriber.faux.setResponses([
    fauxAssistantMessage("Blocker considered"),
    fauxAssistantMessage("Awaited release seen"),
    fauxAssistantMessage("Direct message seen"),
  ]);
  late.faux.setResponses([fauxAssistantMessage("Blocker considered")]);
  await call(subscriber, { action: "subscribe", topic: "browser/shared-test", awaitRelease: true });
  for (const message of ["Old routine state", "Current routine state"]) {
    // The second publication must replace the first accepted revision.
    // oxlint-disable-next-line no-await-in-loop
    await call(publisher, {
      action: "publish",
      topic: "browser/shared-test",
      message,
      resource: "tab/test",
      ownership: "held",
    });
  }
  await waitFor(
    async () => (await inspect(subscriber)).includes("Current routine state"),
    "latest quiet record",
  );
  assert.equal(subscriber.faux.state.callCount, 0);
  assert.equal(
    subscriber.session.sessionManager
      .getEntries()
      .filter((entry) => entry.type === "custom_message").length,
    0,
    "quiet topic records are not passive model-context messages",
  );
  assert.doesNotMatch(await inspect(subscriber), /Old routine state/);
  await call(late, { action: "subscribe", topic: "browser/shared-test" });
  assert.match(await inspect(late), /Current routine state/);
  assert.equal(
    late.faux.state.callCount,
    0,
    "late subscription inspects current state without replaying old interruptions",
  );
  await call(publisher, {
    action: "publish",
    topic: "browser/shared-test",
    event: "blocker",
    message: "Touch ID is required before this shared tab can proceed",
    resource: "tab/test",
    ownership: "held",
  });
  await waitFor(
    () => subscriber.faux.state.callCount === 1 && late.faux.state.callCount === 1,
    "subscribed blockers interrupt",
  );
  await call(publisher, {
    action: "publish",
    topic: "browser/shared-test",
    event: "release",
    message: "The shared tab is released",
    resource: "tab/test",
    ownership: "released",
  });
  await waitFor(() => subscriber.faux.state.callCount === 2, "awaited ownership release");
  await sleep(1700);
  assert.equal(late.faux.state.callCount, 1, "unawaited release only replaces quiet state");
  await call(subscriber, { action: "unsubscribe", topic: "browser/shared-test" });
  await subscriber.send("topic-direct-bypass", {
    text: "Direct messages always get through",
    delivery: "steer",
  });
  await waitFor(
    () => subscriber.faux.state.callCount === 3,
    "direct message bypasses subscriptions",
  );
  await call(publisher, {
    action: "publish",
    topic: "browser/shared-test",
    message: "Using the tab again",
    resource: "tab/test",
    ownership: "held",
  });
  await call(subscriber, { action: "subscribe", topic: "browser/shared-test", awaitRelease: true });
  await subscriber.session.reload();
  await waitFor(
    async () => (await inspect(subscriber)).includes("awaiting release"),
    "same-session subscription restoration",
  );
  await publisher.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  await waitFor(
    async () => (await inspect(subscriber)).includes("disconnected / unavailable"),
    "owner disconnect is visible",
  );
  const disconnected = await inspect(subscriber);
  assert.match(disconnected, /declared held/);
  assert.match(disconnected, /disconnect is not release/);
  assert.equal(
    subscriber.faux.state.callCount,
    3,
    "disconnect is not an awaited release interruption",
  );
  assert.deepEqual(subscriber.errors, []);
});

test("native concurrent selected stops survive one runner poll without stopping a third child", async (t) => {
  const { executeAsyncChain } = await import("../../src/runs/background/async-execution.ts");
  const { interruptAsyncRun } = await import("../../src/runs/foreground/foreground-control.ts");
  const { getRunMetadataDir } = await import("../../src/runs/shared/supervisor-questions.ts");
  const directory = path.join(root, "concurrent-stops"),
    bin = path.join(directory, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    path.join(bin, "pi"),
    `#!/bin/sh\nexec "${process.execPath}" "${path.join(repo, "test/fixtures/native-feedback-child.mjs")}" "$@"\n`,
    { mode: 0o700 },
  );
  const pollRelease = path.join(directory, "poll-release"),
    childRelease = path.join(directory, "child-release-{index}");
  const saved = Object.fromEntries(
    [
      "PATH",
      "NODE_OPTIONS",
      "PI_TEST_RUNNER_POLL_RELEASE",
      "PI_FEEDBACK_RELEASE_FILE",
      "PI_FEEDBACK_SCENARIO",
    ].map((key) => [key, process.env[key]]),
  );
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(path.join(repo, "test/fixtures/hold-runner-polls.mjs")).href}`;
  process.env.PI_TEST_RUNNER_POLL_RELEASE = pollRelease;
  process.env.PI_FEEDBACK_RELEASE_FILE = childRelease;
  process.env.PI_FEEDBACK_SCENARIO = "tool";
  const id = randomUUID();
  let pi: ExtensionAPI | undefined;
  const owner = await makeSession(t, "concurrent-stop-owner", {
    configure(api) {
      pi = api;
    },
  });
  const ownerId = owner.session.sessionManager.getSessionId();
  saveQuestionOwner(id, ownerId);
  const started = executeAsyncChain(id, {
    chain: [
      {
        parallel: [0, 1, 2].map((index) => ({
          agent: "worker",
          task: `Held native child ${index}`,
          output: false,
        })),
        concurrency: 3,
      },
    ],
    resultMode: "parallel",
    agents: [
      makeAgent("worker", {
        model: "feedback-fixture/faux-1",
        extensions: [],
        completionGuard: false,
      }),
    ],
    ctx: {
      pi: requireApi(pi),
      cwd: directory,
      currentSessionId: ownerId,
    },
    cwd: directory,
    sessionRoot: path.join(directory, "sessions"),
    sessionFilesByFlatIndex: [0, 1, 2].map((index) =>
      path.join(directory, "sessions", `${index}.jsonl`),
    ),
    shareEnabled: false,
    maxSubagentDepth: 1,
  });
  assert.equal(started.isError, undefined, JSON.stringify(started));
  const statusPath = path.join(text(started.details.asyncDir), "status.json"),
    resultPath = path.join(getRunMetadataDir(id), "result.json");
  const status = () =>
    existsSync(statusPath) ? parseAsyncStatus(json(readFileSync(statusPath, "utf8"))) : undefined;
  t.after(async () => {
    writeFileSync(pollRelease, "released");
    for (const index of [0, 1, 2]) {
      writeFileSync(childRelease.replace("{index}", String(index)), "released");
    }
    await waitFor(() => existsSync(resultPath), "all selected-stop fixture children settle");
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
  await waitFor(() => existsSync(`${pollRelease}.held`), "the private runner's poll clock is held");
  assert.equal(existsSync(pollRelease), false);
  // Detached admission is not native startup. Observe each SDK tool receipt before
  // asking the owner to publish its coalesced projection of those events.
  await Promise.all(
    [0, 1, 2].map((index) =>
      waitFor(() => {
        const receiptPath = `${childRelease.replace("{index}", String(index))}.json`;
        return (
          existsSync(receiptPath) &&
          records(json(readFileSync(receiptPath, "utf8")).events).some(
            (event) => event.type === "tool_execution_start" && event.toolName === "bash",
          )
        );
      }, `native child ${index} tool publication`),
    ),
  );
  await waitFor(() => {
    const current = status()?.steps;
    return (
      current !== undefined &&
      current.length === 3 &&
      current.every((step) => step.currentTool === "bash")
    );
  }, "three real native tools before the first control poll");
  const steps = () => {
    const current = status()?.steps;
    assertDefined(current);
    return current;
  };
  const state = fixtureState(directory);
  state.asyncJobs.set(id, {
    asyncId: id,
    asyncDir: text(started.details.asyncDir),
    status: "running",
  });
  const receipts = [interruptAsyncRun(state, id, 0), interruptAsyncRun(state, id, 1)];
  assert.ok(receipts.every((receipt) => receipt !== null && receipt.isError !== true));
  writeFileSync(pollRelease, "released");
  await waitFor(() => steps()[1].status === "paused", "second selected child pauses");
  await waitFor(
    () =>
      steps()[0].agentProcessExit?.at !== undefined &&
      steps()[1].agentProcessExit?.at !== undefined,
    "both selected native agent process exits",
  );
  const observed = steps().map((step) => ({
    status: step.status,
    currentTool: step.currentTool,
    agentProcessExit: step.agentProcessExit,
  }));
  writeFileSync(
    path.join(directory, "observation.json"),
    JSON.stringify({ receipts, observed }, null, 2),
  );
  t.diagnostic(JSON.stringify({ observed }));
  assert.deepEqual(
    observed.map((step) => step.status),
    ["paused", "paused", "running"],
    "both accepted selected stops must execute; an unrelated native child keeps working",
  );
  assert.ok(
    observed[0].agentProcessExit?.at !== undefined &&
      observed[1].agentProcessExit?.at !== undefined,
    "paused agent processes have actual exit evidence",
  );
  assert.equal(observed[2].currentTool, "bash");
  assert.equal(observed[2].agentProcessExit, undefined);
  writeFileSync(childRelease.replace("{index}", "2"), "released");
  await waitFor(() => existsSync(resultPath), "unselected child finishes normally");
  assert.deepEqual(
    steps().map((step) => step.status),
    ["paused", "paused", "complete"],
  );
  const receipt = json(readFileSync(`${childRelease.replace("{index}", "2")}.json`, "utf8"));
  assert.equal(receipt.networkRequests, 0);
  assert.deepEqual(receipt.errors, []);
});

for (const boundary of ["presence", "registration"] as const) {
  test(`native rejected topic ${boundary} snapshot preserves prior publication through reload and direct messaging`, async (t) => {
    const { MAX_FRAME_SIZE_BYTES, intercomMessageSizeBytes } =
      await import("../../src/pi-intercom/broker/framing.ts");
    const publisher = await makeSession(t, `topic-size-${boundary}`),
      topic = `private/size-${boundary}`;
    const call = (params: Readonly<Record<string, unknown>>) => executeIntercom(publisher, params);
    publisher.faux.setResponses([
      fauxAssistantMessage("Persist native history"),
      fauxAssistantMessage("Direct message after rejection was read"),
    ]);
    await publisher.session.prompt("Seed private session");
    await publisher.session.waitForIdle();
    await call({ action: "publish", topic, message: "Previous valid publication" });
    const emptyUpdate = { topic, text: "", event: "update", revision: 2, updatedAt: Date.now() };
    const length =
      boundary === "presence"
        ? MAX_FRAME_SIZE_BYTES
        : MAX_FRAME_SIZE_BYTES -
          intercomMessageSizeBytes({ type: "presence", subscriptions: [], topics: [emptyUpdate] });
    const message = "x".repeat(length);
    if (boundary === "registration") {
      assert.equal(
        intercomMessageSizeBytes({
          type: "presence",
          subscriptions: [],
          topics: [{ ...emptyUpdate, text: message }],
        }),
        MAX_FRAME_SIZE_BYTES,
        "the candidate fits the presence frame but must also fit registration",
      );
    }
    let rejected: string | undefined;
    try {
      await call({ action: "publish", topic, message });
    } catch (error) {
      rejected = errorMessage(error);
    }
    const publications = publisher.session.sessionManager
      .getEntries()
      .filter(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === "intercom-topic" &&
          at(entry, "data", "published") !== undefined,
      )
      .map((entry) => record(at(entry, "data", "published")));
    await publisher.session.reload();
    let reconnected: string;
    try {
      reconnected = await publisher.status();
    } catch (error) {
      reconnected = errorMessage(error);
    }
    t.diagnostic(
      JSON.stringify({
        boundary,
        rejected,
        publishedTextLengths: publications.map((entry) => text(entry.text).length),
        reconnected,
      }),
    );
    assert.ok(
      rejected !== undefined && rejected !== "",
      "oversized transported state must be rejected",
    );
    assert.equal(
      publications.length,
      1,
      "a rejected snapshot must change neither publication state nor native durable history",
    );
    assert.equal(publications[0].text, "Previous valid publication");
    assert.doesNotMatch(reconnected, /not connected|too large|disconnected/i);
    await publisher.send(`after-size-${boundary}`, {
      text: "A normal direct message still works",
      delivery: "steer",
    });
    await waitFor(
      () => publisher.visible(`after-size-${boundary}`).length === 1 && publisher.session.isIdle,
      "ordinary native direct delivery after rejected publication and reload",
    );
    assert.match(
      JSON.stringify(await call({ action: "topics", topic })),
      /Previous valid publication/,
    );
    await call({ action: "publish", topic, message: "Small corrected publication" });
    assert.match(
      JSON.stringify(await call({ action: "topics", topic })),
      /Small corrected publication/,
    );
    assert.deepEqual(publisher.errors, []);
  });
}

test("native aggregate topic snapshots remain complete across reload and ordinary messaging", async (t) => {
  const { MAX_FRAME_SIZE_BYTES, intercomMessageSizeBytes } =
    await import("../../src/pi-intercom/broker/framing.ts");
  const publisher = await makeSession(t, "aggregate-topic-publisher"),
    topic = "private/aggregate-topic";
  const call = (params: Readonly<Record<string, unknown>>) => executeIntercom(publisher, params);
  publisher.faux.setResponses([fauxAssistantMessage("Persist private native history")]);
  await publisher.session.prompt("Seed");
  await publisher.session.waitForIdle();
  await call({ action: "publish", topic, message: "Prior valid state" });
  const peers: InstanceType<typeof IntercomClient>[] = [];
  const received: string[] = [];
  t.after(async () => {
    await Promise.all(peers.map((peer) => peer.disconnect()));
  });
  for (let index = 0; index < 4; index++) {
    const peer = new IntercomClient();
    peer.on("message", (_from: ReadonlyInput<SessionInfo>, message: ReadonlyInput<Message>) => {
      received.push(message.content.text);
    });
    // Publish peers in deterministic registration order for the frame-size fixture.
    // oxlint-disable-next-line no-await-in-loop
    await peer.connect({ name: `aggregate-peer-${index}`, cwd: root, model: "fixture" });
    peers.push(peer);
  }
  const before = await peers[0].listSessions();
  const own = observedSession(before, (session) => session.name === "aggregate-topic-publisher");
  const { id, ...registration } = own;
  const update = { topic, text: "", event: "update", revision: 2, updatedAt: Date.now() };
  const presence = { subscriptions: own.subscriptions ?? [], topics: [update] };
  update.text = "x".repeat(
    MAX_FRAME_SIZE_BYTES -
      intercomMessageSizeBytes({
        type: "register",
        session: { ...registration, ...presence },
        requestedId: id,
      }) -
      64,
  );
  assert.ok(intercomMessageSizeBytes({ type: "presence", ...presence }) < MAX_FRAME_SIZE_BYTES);
  assert.ok(
    intercomMessageSizeBytes({
      type: "sessions",
      requestId: randomUUID(),
      sessions: before.map((session) =>
        session.id === id ? Object.assign({}, session, presence) : session,
      ),
    }) > MAX_FRAME_SIZE_BYTES,
    "the complete valid snapshot exceeds one reply frame",
  );
  let publicationError;
  try {
    await call({ action: "publish", topic, message: update.text });
  } catch (error) {
    publicationError = errorMessage(error);
  }
  assert.equal(
    publicationError,
    undefined,
    "valid topic data must not fail because ordinary peers enlarge the aggregate snapshot",
  );
  const snapshot = await peers[0].listSessions();
  assert.equal(
    sessionTopic(
      observedSession(snapshot, (session) => session.id === id),
      topic,
    ).text,
    update.text,
  );
  for (const peer of peers) {
    assert.ok(snapshot.some((session) => session.id === peer.sessionId));
  }
  const otherTopics = ["private/concurrent-a", "private/concurrent-b"];
  const otherText = "Concurrent quiet result ".repeat(26000);
  await Promise.all(
    otherTopics.map((topicName) =>
      call({ action: "publish", topic: topicName, message: otherText }),
    ),
  );
  const combined = observedSession(await peers[0].listSessions(), (session) => session.id === id);
  assert.ok(
    intercomMessageSizeBytes(combined) > MAX_FRAME_SIZE_BYTES,
    "one publisher's valid registry can span reply frames too",
  );
  for (const topicName of otherTopics) {
    assert.equal(
      sessionTopic(combined, topicName).text,
      otherText,
      "concurrent publications must not replace one another's records",
    );
  }
  const direction = "Ordinary direction ".repeat(15000);
  await call({ action: "send", to: peers[0].sessionId, message: direction });
  await waitFor(
    () => received.includes(direction),
    "ordinary direct delivery must not carry the publisher's large quiet registry",
  );
  await publisher.session.reload();
  assert.match(await publisher.status(), /Connected: Yes/);
  const restored = observedSession(await peers[0].listSessions(), (session) => session.id === id);
  assert.equal(
    sessionTopic(restored, topic).text,
    update.text,
    "native reload preserves the complete published state",
  );
  for (const topicName of otherTopics) {
    assert.equal(sessionTopic(restored, topicName).text, otherText);
  }
  await call({ action: "publish", topic, message: "Small corrected state" });
  await call({ action: "send", to: peers[0].sessionId, message: "After correction" });
  await waitFor(() => received.includes("After correction"), "ordinary messaging after correction");
  assert.deepEqual(publisher.errors, []);
});

test("native large subscribed topic delivery does not duplicate text or leak its registry into messages", async (t) => {
  const publisher = await makeSession(t, "large-topic-publisher"),
    subscriber = await makeSession(t, "large-topic-subscriber");
  const call = executeIntercom;
  const topic = "private/large-delivery",
    message = "Complete quiet result 日本語 ".repeat(18000);
  assert.ok(Buffer.byteLength(message) > 512 * 1024 && Buffer.byteLength(message) < 800 * 1024);
  await call(subscriber, { action: "subscribe", topic });
  const receipt = await call(publisher, { action: "publish", topic, message });
  const receipts = records(record(receipt.details).receipts);
  assert.equal(receipts.length, 1);
  assert.equal(
    record(receipts[0]).accepted,
    true,
    "a valid large topic update must reach its subscriber within the existing frame limit",
  );
  await waitFor(
    () =>
      subscriber.session.sessionManager
        .getEntries()
        .some(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === "intercom-topic" &&
            at(entry, "data", "record", "update", "text") === message,
        ),
    "complete quiet topic delivery",
  );
  assert.equal(subscriber.faux.state.callCount, 0);
  assert.equal(
    subscriber.session.sessionManager
      .getEntries()
      .filter((entry) => entry.type === "custom_message").length,
    0,
  );
  assert.deepEqual(publisher.errors, []);
  assert.deepEqual(subscriber.errors, []);
});

test("native rejected complete topic delivery envelope preserves broker and durable state", async (t) => {
  const { MAX_FRAME_SIZE_BYTES, intercomMessageSizeBytes } =
    await import("../../src/pi-intercom/broker/framing.ts");
  const publisher = await makeSession(t, "topic-envelope-publisher"),
    subscriber = await makeSession(t, "topic-envelope-subscriber");
  const call = executeIntercom;
  const topic = "private/delivery-envelope";
  publisher.faux.setResponses([fauxAssistantMessage("Persist private native history")]);
  await publisher.session.prompt("Seed");
  await publisher.session.waitForIdle();
  await call(publisher, { action: "publish", topic, message: "Previous usable publication" });
  await call(subscriber, { action: "subscribe", topic });
  const own = observedSession(
    await publisher.sender.listSessions(),
    (session) => session.name === "topic-envelope-publisher",
  );
  const { id, topics: _topics, subscriptions: _subscriptions, ...from } = own;
  const update = { topic, text: "", event: "update", revision: 2, updatedAt: Date.now() };
  const message = {
    id: randomUUID(),
    timestamp: Date.now(),
    topic: { ...update, text: undefined },
    delivery: "queue",
    queueMode: "replace",
    threadId: `topic:${topic}`,
    content: { text: "" },
  };
  const emptyDeliverySize = intercomMessageSizeBytes({
    type: "message",
    from: { ...from, id },
    message,
  });
  const emptyRegistrationSize = intercomMessageSizeBytes({
    type: "register",
    session: { ...from, subscriptions: [], topics: [update] },
    requestedId: id,
  });
  const oversizedText = "x".repeat(
    Math.min(
      MAX_FRAME_SIZE_BYTES - emptyRegistrationSize - 32,
      MAX_FRAME_SIZE_BYTES - emptyDeliverySize + 64,
    ),
  );
  assert.ok(emptyRegistrationSize + oversizedText.length < MAX_FRAME_SIZE_BYTES);
  assert.ok(
    emptyDeliverySize + oversizedText.length > MAX_FRAME_SIZE_BYTES,
    "the complete delivery envelope, even without duplicated text, exceeds the frame",
  );
  let rejection;
  try {
    await call(publisher, { action: "publish", topic, message: oversizedText });
  } catch (error) {
    rejection = errorMessage(error);
  }
  assert.ok(
    rejection !== undefined && rejection !== "",
    "an undeliverable candidate must be rejected before it is saved",
  );
  const saved = publisher.session.sessionManager
    .getEntries()
    .filter(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === "intercom-topic" &&
        at(entry, "data", "published") !== undefined,
    );
  assert.equal(
    saved.length,
    1,
    "a hard delivery rejection must not overwrite the prior durable publication",
  );
  assert.equal(
    sessionTopic(
      observedSession(await publisher.sender.listSessions(), (session) => session.id === id),
      topic,
    ).text,
    "Previous usable publication",
    "the broker must also retain its prior valid snapshot",
  );
  await publisher.session.reload();
  assert.match(await publisher.status(), /Connected: Yes/);
  const received = receiveBrokerMessage(publisher.sender);
  await call(publisher, {
    action: "send",
    to: publisher.sender.sessionId,
    message: "Direct messaging still works",
  });
  assert.equal((await received)[1].content.text, "Direct messaging still works");
  await call(publisher, { action: "publish", topic, message: "Small valid correction" });
  assert.deepEqual(publisher.errors, []);
});

test("native previously poisoned topic history cannot prevent reconnect or a small correction", async (t) => {
  const publisher = await makeSession(t, "poisoned-topic-history"),
    topic = "private/old-poisoned-topic";
  const call = (params: Readonly<Record<string, unknown>>) => executeIntercom(publisher, params);
  publisher.faux.setResponses([fauxAssistantMessage("Persist private native history")]);
  await publisher.session.prompt("Seed");
  await publisher.session.waitForIdle();
  await call({ action: "publish", topic, message: "Previous valid publication" });
  // This is the durable entry left by the reproduced pre-fix publish-before-validation failure.
  publisher.session.sessionManager.appendCustomEntry("intercom-topic", {
    sessionId: publisher.session.sessionManager.getSessionId(),
    published: {
      topic,
      text: "x".repeat(1024 * 1024),
      event: "update",
      revision: 2,
      updatedAt: Date.now(),
    },
  });
  await publisher.session.reload();
  assert.match(
    await publisher.status(),
    /Connected: Yes/,
    "a saved quiet-state failure must not disable the ordinary connection",
  );
  const received = receiveBrokerMessage(publisher.sender);
  await call({
    action: "send",
    to: publisher.sender.sessionId,
    message: "Ordinary message before correction",
  });
  assert.equal((await received)[1].content.text, "Ordinary message before correction");
  await call({ action: "publish", topic, message: "Small corrected state" });
  assert.equal(
    sessionTopic(
      observedSession(
        await publisher.sender.listSessions(),
        (session) => session.name === "poisoned-topic-history",
      ),
      topic,
    ).text,
    "Small corrected state",
  );
  await publisher.session.reload();
  assert.match(await publisher.status(), /Connected: Yes/);
  assert.ok(
    publisher.session.sessionManager.getEntries().some((entry) => {
      const published = at(entry, "data", "published", "text");
      return (
        entry.type === "custom" &&
        entry.customType === "intercom-topic" &&
        typeof published === "string" &&
        published.length === 1024 * 1024
      );
    }),
    "raw native history remains intact",
  );
  assert.deepEqual(publisher.errors, []);
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
    await supervisor.send("old-milestone", {
      text: "Subagent progress update.\n\nOld finding",
      delivery: "queue",
      queueMode: "replace",
      threadId: "material-progress",
    });
    await supervisor.send("latest-milestone", {
      text: "Subagent progress update.\n\nRoot cause confirmed",
      delivery: "queue",
      queueMode: "replace",
      threadId: "material-progress",
    });
  } finally {
    Date.now = now;
  }
  await waitFor(
    async () => (await supervisor.status()).includes("Root cause confirmed"),
    "coalesced latest milestone",
  );
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
