import "../support/isolated-home.ts";
import test, { after as afterAll } from "node:test";
import { setTimeout as sleep, setImmediate as nextTurn } from "node:timers/promises";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { createRequire } from "node:module";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import net from "node:net";
import type { Readable } from "node:stream";
import {
  SessionManager,
  DefaultResourceLoader,
  createExtensionRuntime,
  initTheme,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionCommandContext,
  type ToolDefinition,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { makeExtensionContext } from "../support/helpers.ts";
import {
  assertRecord,
  assertDefined,
  array,
  record,
  records,
  text as requireText,
  textAt,
} from "../support/assertions.ts";
import { stripTerminalSequences, Text, TuiAltScreen, type Component } from "@earendil-works/pi-tui";
import { fauxProvider } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import { createPlainTheme } from "../support/ui.ts";
import { importSelectedNative } from "../../src/shared/native-import.ts";
import type { ReadonlyInput } from "../../src/shared/types/inputs.ts";
import { createTestTerminal } from "../support/terminal.ts";
const { KeybindingsManager } =
  await import("../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js");
import { ReplyTracker } from "../../src/pi-intercom/reply-tracker.ts";
import {
  cancelSupervisorQuestion,
  listSupervisorQuestions,
  readQuestionState,
  saveQuestionAnswer,
  saveQuestionOwner,
} from "../../src/runs/shared/supervisor-questions.ts";
import { resolveSessionProjectId } from "../../src/pi-intercom/session-targets.ts";
import { ComposeOverlay } from "../../src/pi-intercom/ui/compose.ts";
import {
  isMessage,
  normalizeSessionInfo,
  type Message,
  type SessionInfo,
  type SendResult,
} from "../../src/pi-intercom/types.ts";

const repoDir = process.cwd();
const childEnvKeys = [
  "PI_SUBAGENT_ORCHESTRATOR_TARGET",
  "PI_SUBAGENT_RUN_ID",
  "PI_SUBAGENT_CHILD_AGENT",
  "PI_SUBAGENT_CHILD_INDEX",
  "PI_SUBAGENT_INTERCOM_SESSION_NAME",
] as const;
const sharedHomeDir = mkdtempSync(path.join(tmpdir(), "pic-"));
const sharedAgentDir = path.join(sharedHomeDir, "pi-agent");
const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;
const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousChildEnv = new Map<string, string | undefined>();
for (const key of childEnvKeys) {
  previousChildEnv.set(key, process.env[key]);
  delete process.env[key];
}
process.env.HOME = sharedHomeDir;
process.env.USERPROFILE = sharedHomeDir;
process.env.PI_CODING_AGENT_DIR = sharedAgentDir;
const { IntercomClient } = await import("../../src/pi-intercom/broker/client.ts");
const { MAX_FRAME_SIZE_BYTES, writeMessage } =
  await import("../../src/pi-intercom/broker/framing.ts");
const { getBrokerSocketPath } = await import("../../src/pi-intercom/broker/paths.ts");
process.on("exit", () => {
  for (const broker of activeBrokers) {
    signalBroker(broker, "SIGKILL");
  }
  signalSharedBroker("SIGKILL");
  process.env.HOME = previousHome;
  process.env.USERPROFILE = previousUserProfile;
  if (previousPiAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
  }
  for (const key of childEnvKeys) {
    const value = previousChildEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  rmSync(sharedHomeDir, { recursive: true, force: true });
});

type BrokerProcess = ChildProcessByStdio<null, Readable, Readable>;
const activeBrokers = new Set<BrokerProcess>();

function signalBroker(broker: BrokerProcess, signal: NodeJS.Signals): void {
  if (broker.pid !== undefined && broker.pid > 0) {
    try {
      process.kill(-broker.pid, signal);
      return;
    } catch {
      // Fall back to the direct child below.
    }
  }
  broker.kill(signal);
}

afterAll(async () => {
  await Promise.all([...activeBrokers].map(stopBroker));
  await stopSharedBroker();
});

function sharedBrokerPid(): number | null {
  const pidPath = path.join(sharedAgentDir, "intercom", "broker.pid");
  if (!existsSync(pidPath)) {
    return null;
  }
  const pid = Number.parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
  return Number.isFinite(pid) ? pid : null;
}

function signalSharedBroker(signal: NodeJS.Signals): void {
  const pid = sharedBrokerPid();
  if (pid === null) {
    return;
  }
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
}

async function stopSharedBroker(): Promise<void> {
  const pid = sharedBrokerPid();
  if (pid === null) {
    return;
  }
  signalSharedBroker("SIGTERM");
  const start = Date.now();
  while (Date.now() - start < 2000) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    // Observe process liveness before backing off for the next shutdown poll.
    // oxlint-disable-next-line no-await-in-loop
    await sleep(50);
  }
  signalSharedBroker("SIGKILL");
}

function unrefStream(stream: Readable): void {
  if (stream instanceof net.Socket) {
    stream.unref();
  }
}

function detachBrokerFromTestRunner(broker: BrokerProcess): void {
  unrefStream(broker.stdout);
  unrefStream(broker.stderr);
  broker.unref();
}

function brokerSocketConnectable(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(getBrokerSocketPath());
    const timeout = setTimeout(() => finish(false), 1000);
    const finish = (connected: boolean) => {
      clearTimeout(timeout);
      socket.off("connect", onConnect);
      socket.off("error", onError);
      socket.destroy();
      resolve(connected);
    };
    const onConnect = () => finish(true);
    const onError = () => finish(false);
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

async function waitForBrokerReady(broker: BrokerProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const poll = setInterval(() => {
      brokerSocketConnectable()
        .then((connected) => {
          if (connected) {
            cleanup();
            resolve();
          }
        })
        .catch((error: unknown) => {
          cleanup();
          reject(
            error instanceof Error ? error : new Error("Broker readiness failed", { cause: error }),
          );
        });
    }, 50);
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Broker startup timed out"));
    }, 10000);
    const onStdout = (chunk: Buffer) => {
      if (chunk.toString().includes("Intercom broker started")) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `Broker exited before startup (code=${code ?? "none"}, signal=${signal ?? "none"})`,
        ),
      );
    };
    const cleanup = () => {
      clearInterval(poll);
      clearTimeout(timeout);
      broker.stdout.off("data", onStdout);
      broker.off("exit", onExit);
    };

    broker.stdout.on("data", onStdout);
    broker.once("exit", onExit);
  });
}

async function withChildOrchestratorEnv<T>(
  metadata: {
    readonly orchestratorTarget?: string;
    readonly runId?: string;
    readonly agent?: string;
    readonly index?: string;
    readonly sessionName?: string;
  },
  fn: () => T | Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of childEnvKeys) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  if (metadata.orchestratorTarget !== undefined) {
    process.env.PI_SUBAGENT_ORCHESTRATOR_TARGET = metadata.orchestratorTarget;
  }
  if (metadata.runId !== undefined) {
    process.env.PI_SUBAGENT_RUN_ID = metadata.runId;
    saveQuestionOwner(metadata.runId, "supervisor-session-test");
  }
  if (metadata.agent !== undefined) {
    process.env.PI_SUBAGENT_CHILD_AGENT = metadata.agent;
  }
  if (metadata.index !== undefined) {
    process.env.PI_SUBAGENT_CHILD_INDEX = metadata.index;
  }
  if (metadata.sessionName !== undefined) {
    process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME = metadata.sessionName;
  }
  try {
    return await fn();
  } finally {
    for (const key of childEnvKeys) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

interface CapturedToolResult {
  readonly content: readonly { readonly type: string; readonly text: string }[];
  readonly isError: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
}

interface RenderToolResult {
  readonly content: readonly { readonly type: string; readonly text: string }[];
  readonly details?: Readonly<Record<string, unknown>>;
}

type RenderedComponent = Component;
type RenderTheme = Theme;

interface CapturedTool {
  readonly name: string;
  readonly description?: string;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: readonly string[];
  readonly parameters?: unknown;
  readonly execute: (
    toolCallId: string,
    params: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<CapturedToolResult>;
  readonly renderCall?: (
    args: Readonly<Record<string, unknown>>,
    theme: RenderTheme,
    context: Readonly<Record<string, unknown>>,
  ) => RenderedComponent;
  readonly renderResult?: (
    result: RenderToolResult,
    options: { readonly expanded?: boolean; readonly isPartial?: boolean },
    theme: RenderTheme,
    context: Readonly<Record<string, unknown>>,
  ) => RenderedComponent;
}

initTheme("dark", false);
const renderTheme: RenderTheme = createPlainTheme();

function renderToText(component: RenderedComponent): string {
  return component
    .render(120)
    .map((line) => stripTerminalSequences(line).trimEnd())
    .join("\n");
}

async function createExtensionHarness(
  sessionName = "child-worker",
  options: {
    readonly abort?: () => void;
    readonly hasUI?: boolean;
    readonly isIdle?: () => boolean;
    readonly ui?: Readonly<Partial<ExtensionContext["ui"]>>;
    readonly wrapToolErrors?: boolean;
  } = {},
) {
  const base = makeExtensionContext(repoDir);
  const manager = SessionManager.inMemory(repoDir, { id: "session-child-test" });
  const sessionFile = path.join(sharedHomeDir, `${sessionName}.jsonl`);
  writeFileSync(
    sessionFile,
    `${JSON.stringify({ type: "session", version: 3, id: "session-child-test", cwd: repoDir })}\n`,
  );
  manager.getSessionFile = () => sessionFile;
  const ctx = {
    ...base,
    sessionManager: manager,
    model: { ...fauxProvider().getModel(), id: "child-model" },
    isIdle: options.isIdle ?? (() => true),
    hasUI: options.hasUI ?? false,
    abort: options.abort ?? (() => base.abort()),
    ui: { ...base.ui, ...options.ui },
  };
  const runtime = createExtensionRuntime();
  const entries: Array<{ type: string; data: unknown }> = [];
  const sentMessages: Array<{
    message: { customType: string; content: string; display: boolean; details?: unknown };
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" };
  }> = [];
  let activeTools: string[] = [];
  let api: ExtensionAPI | undefined;
  const loader = new DefaultResourceLoader({
    cwd: repoDir,
    agentDir: sharedAgentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) => {
        api = pi;
      },
    ],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assertDefined(api);
  const loaded = loader.getExtensions();
  // The SDK owns registration and handler identity. Only process-host actions are recorded here.
  Object.assign(loaded.runtime, {
    ...runtime,
    createContext: () => ctx,
    getSessionName: () => sessionName,
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: readonly string[]) => {
      activeTools = [...names];
    },
    getAllTools: () =>
      loaded.extensions
        .flatMap((extension) => [...extension.tools.values()])
        .map(({ definition }) => ({
          name: definition.name,
          description: definition.description,
          parameters: definition.parameters,
          sourceInfo: { source: "extension", path: sessionFile, scope: "temporary" },
        })),
    refreshTools: () => {
      activeTools = loaded.extensions.flatMap((extension) => [...extension.tools.keys()]);
    },
    appendEntry: (type: string, data: unknown) => {
      entries.push({ type, data });
      manager.appendCustomEntry(type, data);
    },
    sendMessage: (
      message: {
        readonly customType: string;
        readonly content: unknown;
        readonly display: boolean;
        readonly details?: unknown;
      },
      sendOptions?: {
        readonly triggerTurn?: boolean;
        readonly deliverAs?: "steer" | "followUp" | "nextTurn";
      },
    ) => {
      assert.ok(
        typeof message.content === "string",
        "intercom fixture records literal transcript messages",
      );
      sentMessages.push({
        message: {
          customType: message.customType,
          content: message.content,
          display: message.display,
          details: message.details,
        },
        options: sendOptions,
      });
    },
  });
  const toolDefinitions = () =>
    loaded.extensions.flatMap((extension) => [...extension.tools.values()]);
  const tools = (): CapturedTool[] => {
    const captured: CapturedTool[] = [];
    for (const registered of toolDefinitions()) {
      const definition: ToolDefinition<TSchema, unknown, unknown> = registered.definition;
      captured.push({
        name: definition.name,
        description: definition.description,
        promptSnippet: definition.promptSnippet,
        promptGuidelines: definition.promptGuidelines,
        parameters: definition.parameters,
        async execute(id, params, signal, _onUpdate, context) {
          assertRecord(context);
          const toolContext = {
            ...ctx,
            ...context,
            tools: [],
            executeTool: async () => {
              throw new Error("Nested execution is not part of this direct tool fixture");
            },
          };
          try {
            const result = await definition.execute(id, params, signal, undefined, toolContext);
            const content = result.content.map((part) => {
              assert.equal(part.type, "text");
              return part;
            });
            const details: unknown = result.details;
            if (details !== undefined) {
              assertRecord(details);
            }
            return { content, details, isError: result.isError ?? false };
          } catch (error) {
            if (options.wrapToolErrors === false) {
              throw error;
            }
            const details: unknown =
              typeof error === "object" && error !== null && "details" in error
                ? error.details
                : undefined;
            if (details !== undefined) {
              assertRecord(details);
            }
            return {
              content: [
                {
                  type: "text",
                  text: error instanceof Error ? error.message : "Unknown tool failure",
                },
              ],
              isError: true,
              details,
            };
          }
        },
        ...(definition.renderCall === undefined
          ? {}
          : {
              renderCall: (args, theme, context) =>
                definition.renderCall?.(args, theme, {
                  toolCallId: "render",
                  args,
                  state: undefined,
                  lastComponent: undefined,
                  cwd: repoDir,
                  executionStarted: false,
                  argsComplete: true,
                  isPartial: false,
                  expanded: false,
                  showImages: false,
                  isError: false,
                  invalidate: () => {
                    /* This fixture renders synchronously. */
                  },
                  ...context,
                }) ?? new Text("", 0, 0),
            }),
        ...(definition.renderResult === undefined
          ? {}
          : {
              renderResult: (result, renderOptions, theme, context) =>
                definition.renderResult?.(
                  {
                    ...result,
                    content: result.content.map((part) => ({ type: "text", text: part.text })),
                    details: result.details,
                  },
                  { expanded: false, isPartial: false, ...renderOptions },
                  theme,
                  {
                    toolCallId: "render",
                    args: {},
                    state: undefined,
                    lastComponent: undefined,
                    cwd: repoDir,
                    executionStarted: true,
                    argsComplete: true,
                    isPartial: false,
                    expanded: false,
                    showImages: false,
                    isError: false,
                    invalidate: () => {
                      /* This fixture renders synchronously. */
                    },
                    ...context,
                  },
                ) ?? new Text("", 0, 0),
            }),
      });
    }
    return captured;
  };
  return {
    pi: api,
    ctx,
    get tools() {
      return tools();
    },
    tool(name: string): CapturedTool {
      const tool = tools().find((candidate) => candidate.name === name);
      assertDefined(tool);
      return tool;
    },
    command(name: string) {
      const command = this.commands.get(name);
      assertDefined(command);
      return command;
    },
    get commands() {
      return new Map(
        loaded.extensions.flatMap((extension) =>
          [...extension.commands].map(([name, command]) => [
            name,
            (args: string, context: unknown) => {
              assertRecord(context);
              const commandContext: ExtensionCommandContext = {
                ...ctx,
                ...context,
                getSystemPromptOptions: () => ({ sections: {}, cwd: repoDir }),
                waitForIdle: async () => {
                  /* No agent is owned by the registrar fixture. */
                },
                newSession: async () => {
                  throw new Error("Session creation requires a native agent fixture");
                },
                fork: async () => {
                  throw new Error("Forking requires a native agent fixture");
                },
                navigateTree: async () => {
                  throw new Error("Navigation requires a native agent fixture");
                },
                switchSession: async () => {
                  throw new Error("Switching requires a native agent fixture");
                },
                reload: async () => {
                  throw new Error("Reload requires a native agent fixture");
                },
              };
              return command.handler(args, commandContext);
            },
          ]),
        ),
      );
    },
    entries,
    sessionManager: manager,
    get sessionEntries() {
      return manager.getEntries();
    },
    sentMessages,
    async emitLifecycle(event: string, payload: unknown = {}, eventContext: unknown = ctx) {
      assertRecord(payload);
      const nativePayload =
        event === "turn_end" ? { context: { pendingMessages: [] }, ...payload } : payload;
      const results: unknown[] = [];
      for (const handler of loaded.extensions.flatMap(
        (extension) => extension.handlers.get(event) ?? [],
      )) {
        // Lifecycle handlers must run in registration order, as they do in the SDK runner.
        // oxlint-disable-next-line no-await-in-loop
        results.push(await handler(nativePayload, eventContext));
      }
      return results;
    },
  };
}

async function setupBroker() {
  const broker = spawn(
    process.execPath,
    [
      process.env.PI_INTERCOM_TEST_BROKER ??
        path.join(repoDir, "src", "pi-intercom", "broker", "broker.ts"),
    ],
    {
      cwd: repoDir,
      detached: true,
      env: {
        ...process.env,
        HOME: sharedHomeDir,
        USERPROFILE: sharedHomeDir,
        PI_CODING_AGENT_DIR: sharedAgentDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  activeBrokers.add(broker);
  try {
    await waitForBrokerReady(broker);
    detachBrokerFromTestRunner(broker);
    return broker;
  } catch (error) {
    activeBrokers.delete(broker);
    signalBroker(broker, "SIGKILL");
    throw error;
  }
}

async function stopBroker(broker: BrokerProcess): Promise<void> {
  activeBrokers.delete(broker);
  if (broker.exitCode !== null || broker.signalCode !== null) {
    return;
  }
  signalBroker(broker, "SIGTERM");
  await Promise.race([
    once(broker, "exit"),
    new Promise<void>((resolve) => {
      setTimeout(() => {
        signalBroker(broker, "SIGKILL");
        resolve();
      }, 2000);
    }),
  ]);
}

async function connectClient(
  client: InstanceType<typeof IntercomClient>,
  name: string,
  overrides: ReadonlyInput<Partial<Omit<SessionInfo, "id" | "name">>> = {},
): Promise<void> {
  const normalized = normalizeSessionInfo({
    id: "fixture-registration",
    name,
    cwd: repoDir,
    model: "test-model",
    ...overrides,
  });
  assertDefined(normalized);
  const { id: _id, ...registration } = normalized;
  await client.connect(registration);
}

async function setupClients() {
  const broker = await setupBroker();

  try {
    const planner = new IntercomClient();
    const orchestrator = new IntercomClient();

    await connectClient(planner, "planner");
    await connectClient(orchestrator, "orchestrator");

    return {
      planner,
      orchestrator,
      cleanup: async () => {
        await planner.disconnect();
        await orchestrator.disconnect();
        await stopBroker(broker);
      },
    };
  } catch (error) {
    await stopBroker(broker);
    throw error;
  }
}

async function waitForSentMessages(
  harness: { readonly sentMessages: readonly unknown[] },
  count: number,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (harness.sentMessages.length >= count) {
      return;
    }
    // Observe recipient publication before backing off for the next poll.
    // oxlint-disable-next-line no-await-in-loop
    await sleep(20);
  }
  throw new Error(
    `Timed out waiting for ${count} sent messages; got ${harness.sentMessages.length}`,
  );
}

function persistSentIntercom(harness: {
  readonly sessionManager: SessionManager;
  readonly sentMessages: readonly {
    readonly message: {
      readonly customType: string;
      readonly content: string;
      readonly display: boolean;
      readonly details?: unknown;
    };
  }[];
}): void {
  const sent = harness.sentMessages.at(-1);
  assert.ok(sent, "expected a sent intercom message to persist");
  harness.sessionManager.appendCustomMessageEntry(
    sent.message.customType,
    sent.message.content,
    sent.message.display,
    sent.message.details,
  );
}

function captureClientMethod(name: "connect" | "send" | "listSessions") {
  const method: unknown = Object.getOwnPropertyDescriptor(IntercomClient.prototype, name)?.value;
  assert.ok(typeof method === "function", `Missing native client method ${name}`);
  return async (receiver: InstanceType<typeof IntercomClient>, args: readonly unknown[]) => {
    const result: unknown = await Reflect.apply(method, receiver, args);
    return result;
  };
}

function observedSendResult(value: unknown): SendResult {
  const result = record(value);
  assert.ok(typeof result.id === "string");
  assert.ok(typeof result.accepted === "boolean");
  assert.ok(typeof result.delivered === "boolean");
  assert.ok(result.queued === undefined || typeof result.queued === "boolean");
  assert.ok(result.reason === undefined || typeof result.reason === "string");
  return {
    id: result.id,
    accepted: result.accepted,
    delivered: result.delivered,
    ...(result.queued === undefined ? {} : { queued: result.queued }),
    ...(result.reason === undefined ? {} : { reason: result.reason }),
  };
}

async function receiveMessage(
  client: InstanceType<typeof IntercomClient>,
  options?: { readonly signal: AbortSignal },
): Promise<[SessionInfo, Message]> {
  const received: unknown = await once(client, "message", options);
  const [rawFrom, message] = array(received);
  const from = normalizeSessionInfo(rawFrom);
  assertDefined(from);
  assert.ok(isMessage(message), "the broker must emit a valid public message");
  return [from, message];
}

function waitForReply(
  client: InstanceType<typeof IntercomClient>,
  replyTo: string,
  timeoutMs = 5000,
): Promise<{
  readonly from: ReadonlyInput<SessionInfo>;
  readonly message: ReadonlyInput<Message>;
}> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      client.off("message", handler);
      reject(new Error(`Timed out waiting for reply to ${replyTo}`));
    }, timeoutMs);
    const handler = (from: ReadonlyInput<SessionInfo>, message: ReadonlyInput<Message>) => {
      if (message.replyTo !== replyTo) {
        return;
      }
      clearTimeout(timeout);
      client.off("message", handler);
      resolve({ from, message });
    };
    client.on("message", handler);
  });
}

async function waitForSession(
  client: InstanceType<typeof IntercomClient>,
  matches: (session: ReadonlyInput<SessionInfo>) => boolean,
  timeoutMessage: (sessions: readonly ReadonlyInput<SessionInfo>[]) => string,
): Promise<SessionInfo> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    // Never overlap broker readiness queries.
    // oxlint-disable-next-line no-await-in-loop
    const session = (await client.listSessions()).find(matches);
    if (session) {
      return session;
    }
    // Query completion precedes the next readiness poll.
    // oxlint-disable-next-line no-await-in-loop
    await sleep(25);
  }
  throw new Error(timeoutMessage(await client.listSessions()));
}

function waitForSessionByName(
  client: InstanceType<typeof IntercomClient>,
  name: string,
): Promise<SessionInfo> {
  return waitForSession(
    client,
    (session) => session.name === name,
    (sessions) =>
      `Timed out waiting for ${name}; saw ${JSON.stringify(sessions.map((session) => session.name))}`,
  );
}

function waitForSessionStatus(
  client: InstanceType<typeof IntercomClient>,
  name: string,
  status: string,
): Promise<SessionInfo> {
  return waitForSession(
    client,
    (session) => session.name === name && session.status === status,
    (sessions) =>
      `Timed out waiting for ${name} status ${status}; saw ${JSON.stringify(sessions.map((session) => ({ name: session.name, status: session.status })))}`,
  );
}

function waitForSessionModel(
  client: InstanceType<typeof IntercomClient>,
  name: string,
  model: string,
): Promise<SessionInfo> {
  return waitForSession(
    client,
    (session) => session.name === name && session.model === model,
    (sessions) =>
      `Timed out waiting for ${name} model ${model}; saw ${JSON.stringify(sessions.map((session) => ({ name: session.name, model: session.model })))}`,
  );
}

test("intercom tool renders compact call and result rows", async (t) => {
  const sdk = import.meta.resolve("@earendil-works/pi-coding-agent");

  const { getKeybindings, setKeybindings } = await importSelectedNative(
    import.meta.url,
    "@earendil-works/pi-tui",
    createRequire(sdk).resolve("@earendil-works/pi-tui"),
    () => import("@earendil-works/pi-tui"),
  );
  const previous = getKeybindings();
  setKeybindings(new KeybindingsManager());
  t.after(() => setKeybindings(previous));
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const harness = await createExtensionHarness();

  piIntercomExtension(harness.pi);
  const intercomTool = harness.tool("intercom");

  assert.ok(intercomTool.renderCall);
  assert.ok(intercomTool.renderResult);
  assert.equal(renderToText(intercomTool.renderCall({}, renderTheme, {})), "intercom intercom");
  assert.equal(
    renderToText(
      intercomTool.renderCall({ action: "send", to: 5, attachments: "partial" }, renderTheme, {}),
    ),
    "intercom send",
  );
  assert.match(
    renderToText(
      intercomTool.renderCall(
        {
          action: "ask",
          to: "planner",
          message: "Need a decision before I continue with this implementation.",
          attachments: [{ type: "snippet", name: "note.ts", content: "const ok = true;" }],
        },
        renderTheme,
        {},
      ),
    ),
    /intercom ask → planner \(1 attachment\)\n  Need a decision/,
  );

  const resultText = renderToText(
    intercomTool.renderResult(
      {
        content: [{ type: "text", text: "Message sent to planner" }],
        details: { delivered: true, messageId: "abcdef123456" },
      },
      { isPartial: false, expanded: false },
      renderTheme,
      { isError: false, expanded: false },
    ),
  );
  assert.match(resultText, /✓ Message sent to planner \(abcdef12\)/);

  const listResult = {
    content: [
      { type: "text", text: "Current session: controller\nOther sessions:\n- busy-worker" },
    ],
    details: { sessionCount: 12 },
  };
  const collapsedListText = renderToText(
    intercomTool.renderResult(listResult, { isPartial: false, expanded: false }, renderTheme, {
      isError: false,
      expanded: false,
      args: { action: "list" },
    }),
  );
  assert.match(collapsedListText, /✓ 12 sessions .*ctrl\+o.*to expand/);
  assert.doesNotMatch(collapsedListText, /busy-worker/);

  const expandedListText = renderToText(
    intercomTool.renderResult(listResult, { isPartial: false, expanded: true }, renderTheme, {
      isError: false,
      expanded: true,
      args: { action: "list" },
    }),
  );
  assert.match(expandedListText, /busy-worker/);

  const errorText = renderToText(
    intercomTool.renderResult(
      {
        content: [{ type: "text", text: "Missing 'to' or 'message' parameter" }],
        details: { error: true, reason: "Missing target" },
      },
      { isPartial: false, expanded: true },
      renderTheme,
      { isError: false, expanded: true },
    ),
  );
  assert.match(errorText, /✗ Missing 'to' or 'message' parameter/);
  assert.match(errorText, /Reason: Missing target/);
});

test("contact supervisor tool renders reason and reply state", async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");

  await withChildOrchestratorEnv(
    {
      orchestratorTarget: "orchestrator",
      runId: "78f659a3",
      agent: "worker",
      index: "0",
    },
    async () => {
      const harness = await createExtensionHarness();
      piIntercomExtension(harness.pi);
      const supervisorTool = harness.tool("contact_supervisor");

      assert.ok(supervisorTool.renderCall);
      assert.ok(supervisorTool.renderResult);
      assert.match(
        renderToText(
          supervisorTool.renderCall(
            {
              reason: "interview_request",
              message: "Please answer these before I continue.",
              interview: { title: "API migration", questions: [] },
            },
            renderTheme,
            {},
          ),
        ),
        /contact_supervisor interview_request API migration\n  Please answer/,
      );

      const warningText = renderToText(
        supervisorTool.renderResult(
          {
            content: [{ type: "text", text: "Reply from supervisor:\nUse stable API" }],
            details: { structuredReplyParseError: "reply JSON must include a responses array" },
          },
          { isPartial: false },
          renderTheme,
          { isError: false },
        ),
      );
      assert.match(warningText, /⚠ Reply from supervisor:\nUse stable API/);
      assert.match(
        warningText,
        /Structured reply parse issue: reply JSON must include a responses array/,
      );

      const failureText = renderToText(
        supervisorTool.renderResult(
          {
            content: [{ type: "text", text: "Invalid reason" }],
            details: { error: true },
          },
          { isPartial: false },
          renderTheme,
          { isError: false },
        ),
      );
      assert.match(failureText, /✗ Invalid reason/);
    },
  );
});

test(
  "intercom tool empty list output gives local fork next steps",
  { concurrency: false },
  async () => {
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const broker = await setupBroker();
    const harness = await createExtensionHarness("solo", { hasUI: true });

    try {
      piIntercomExtension(harness.pi);
      await harness.emitLifecycle("session_start");
      const intercomTool = harness.tool("intercom");

      const result = await intercomTool.execute(
        "tool-empty-list",
        {
          action: "list",
        },
        new AbortController().signal,
        undefined,
        harness.ctx,
      );

      assert.equal(result.isError, false);
      assert.deepEqual(result.details, { sessionCount: 1 });
      const text = textAt(result.content);
      assert.match(text, /No other sessions connected/);
      assert.match(text, /pi --name worker/);
      assert.match(
        text,
        new RegExp(
          `--extension '${repoDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/src/pi-intercom/index\\.ts' --skill '${repoDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/skills/pi-intercom'`,
        ),
      );
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await stopBroker(broker);
    }
  },
);

test(
  "intercom list defaults to the current project and scope all reveals other projects",
  { concurrency: false },
  async () => {
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const broker = await setupBroker();
    const sameProject = new IntercomClient();
    const unrelated = new IntercomClient();
    const harness = await createExtensionHarness("project-controller");

    try {
      await connectClient(sameProject, "same-project-peer", {
        cwd: path.join(repoDir, "..", "linked-worktree"),
        projectId: await resolveSessionProjectId(repoDir),
      });
      await connectClient(unrelated, "other-project-peer", {
        cwd: path.join(tmpdir(), "unrelated-project"),
        projectId: "b".repeat(64),
      });
      piIntercomExtension(harness.pi);
      await harness.emitLifecycle("session_start");
      await waitForSessionByName(sameProject, "project-controller");
      const intercomTool = harness.tool("intercom");

      const projectResult = await intercomTool.execute(
        "list-project",
        {
          action: "list",
        },
        new AbortController().signal,
        undefined,
        harness.ctx,
      );
      const projectText = textAt(projectResult.content);
      assert.match(projectText, /same-project-peer/);
      assert.doesNotMatch(projectText, /other-project-peer/);
      assert.match(projectText, /1 session in other projects hidden/);
      assert.match(projectText, /intercom\(\{ action: "list", scope: "all" \}\)/);
      assert.deepEqual(projectResult.details, { sessionCount: 2 });

      const allResult = await intercomTool.execute(
        "list-all",
        {
          action: "list",
          scope: "all",
        },
        new AbortController().signal,
        undefined,
        harness.ctx,
      );
      const allText = textAt(allResult.content);
      assert.match(allText, /same-project-peer/);
      assert.match(allText, /other-project-peer/);
      assert.doesNotMatch(allText, /other projects hidden/);
      assert.deepEqual(allResult.details, { sessionCount: 3 });
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await sameProject.disconnect();
      await unrelated.disconnect();
      await stopBroker(broker);
    }
  },
);

test(
  "before_agent_start adds a bounded hint only for same-project peers",
  { concurrency: false },
  async () => {
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const broker = await setupBroker();
    const related = new IntercomClient();
    const unrelated = new IntercomClient();
    const harness = await createExtensionHarness("ambient-controller");
    const unrelatedDir = mkdtempSync(path.join(tmpdir(), "pi-intercom-unrelated-"));

    try {
      await connectClient(related, "same-project-peer", {
        cwd: path.join(repoDir, "..", "another-worktree"),
        projectId: await resolveSessionProjectId(repoDir),
      });
      await connectClient(unrelated, "unrelated-peer", {
        cwd: unrelatedDir,
        projectId: await resolveSessionProjectId(unrelatedDir),
      });
      piIntercomExtension(harness.pi);
      await harness.emitLifecycle("session_start");
      await waitForSessionByName(related, "ambient-controller");

      const options: { sections: Record<string, string>; forceSystemPrompt: string | undefined } = {
        sections: {},
        forceSystemPrompt: undefined,
      };
      const results = await harness.emitLifecycle("before_agent_start", {
        systemPrompt: "base prompt",
        systemPromptOptions: options,
      });
      assert.ok(results.every((result) => result === undefined));
      assert.match(
        options.sections.intercom_peers,
        /^Other Pi sessions may be connected to this project\./,
      );
      assert.doesNotMatch(options.sections.intercom_peers, /same-project-peer|unrelated-peer/);
      assert.equal(options.forceSystemPrompt, undefined);

      // Fleet churn must not alter the pinned section on later turns.
      await related.disconnect();
      const afterChurn: { sections: Record<string, string>; forceSystemPrompt: string } = {
        sections: {},
        forceSystemPrompt: "EXACT OVERRIDE",
      };
      await harness.emitLifecycle("before_agent_start", {
        systemPrompt: "EXACT OVERRIDE",
        systemPromptOptions: afterChurn,
      });
      assert.equal(afterChurn.sections.intercom_peers, options.sections.intercom_peers);
      assert.equal(
        afterChurn.forceSystemPrompt,
        `EXACT OVERRIDE\n\n<intercom_peers>\n${options.sections.intercom_peers}\n</intercom_peers>`,
      );
    } finally {
      await related.disconnect();
      await unrelated.disconnect();
      await harness.emitLifecycle("session_shutdown");
      await stopBroker(broker);
      rmSync(unrelatedDir, { recursive: true, force: true });
    }
  },
);

test("background reconnect chain survives a failed attempt", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const configPath = path.join(sharedAgentDir, "intercom", "config.json");
  // Broker self-spawn must fail deterministically during this test: node
  // evaluates -e and exits 0 without reading the broker script argument, so
  // spawnBrokerIfNeeded rejects fast ("exited before startup"). The config is
  // read once at extension registration, so the extension can never revive
  // the broker itself; only its own retry chain plus an externally restarted
  // broker can restore the connection. That isolates the regression: a retry
  // chain that dies after one failed attempt never reconnects here.
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify({ brokerCommand: process.execPath, brokerArgs: ["-e", "process.exit(0)"] }),
  );
  let broker = await setupBroker();
  const harness = await createExtensionHarness("reconnect-chain-controller");
  const probe = new IntercomClient();
  try {
    piIntercomExtension(harness.pi);
    await harness.emitLifecycle("session_start");
    await connectClient(probe, "reconnect-chain-probe", {});
    await waitForSessionByName(probe, "reconnect-chain-controller");
    await probe.disconnect();

    // Kill the broker and hold it down past the first background retry
    // (scheduled at 1s; the failing spawn rejects within milliseconds), so
    // the retry chain must survive at least one full failure.
    await stopBroker(broker);
    await sleep(2500);

    // Broker returns; only retry #2 or later can observe it. Backoff after
    // one failure is 2s, then 5s, so allow a generous window.
    broker = await setupBroker();
    await connectClient(probe, "reconnect-chain-probe", {});
    const deadline = Date.now() + 12_000;
    let reconnected = false;
    while (Date.now() < deadline) {
      // Reconnect observations must finish before querying the broker again.
      // oxlint-disable-next-line no-await-in-loop
      const sessions = await probe.listSessions().catch(() => []);
      if (sessions.some((session) => session.name === "reconnect-chain-controller")) {
        reconnected = true;
        break;
      }
      // Back off after observing this failed reconnect attempt.
      // oxlint-disable-next-line no-await-in-loop
      await sleep(200);
    }
    assert.ok(
      reconnected,
      "extension should reconnect via a retry scheduled after a failed background attempt",
    );
  } finally {
    rmSync(configPath, { force: true });
    await probe.disconnect();
    await harness.emitLifecycle("session_shutdown");
    await stopBroker(broker);
  }
});

test(
  "failed foreground attempt during backoff re-arms the reconnect chain",
  { concurrency: false },
  async () => {
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const configPath = path.join(sharedAgentDir, "intercom", "config.json");
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({ brokerCommand: process.execPath, brokerArgs: ["-e", "process.exit(0)"] }),
    );
    let broker = await setupBroker();
    const harness = await createExtensionHarness("reconnect-takeover-controller");
    const probe = new IntercomClient();
    try {
      piIntercomExtension(harness.pi);
      await harness.emitLifecycle("session_start");
      await connectClient(probe, "reconnect-takeover-probe", {});
      await waitForSessionByName(probe, "reconnect-takeover-controller");
      await probe.disconnect();

      // Disconnect schedules a background retry at 1s. A foreground tool call
      // inside that backoff window clears the pending timer on entry and then
      // fails (broker down, spawn config failing). Without retry re-arming on
      // every failed live attempt, this cancellation permanently ends
      // recovery: no timer remains and nothing else restores one.
      await stopBroker(broker);
      await sleep(150);
      const intercomTool = harness.tool("intercom");
      const result = await intercomTool
        .execute(
          "tool-during-backoff",
          { action: "list" },
          new AbortController().signal,
          undefined,
          harness.ctx,
        )
        .catch(() => ({ isError: true, content: [] }));
      assert.equal(result.isError, true, "listing without a broker should fail");

      // Hold the broker down long enough that at least one re-armed background
      // retry also fails, then restore it and require reconnection.
      await sleep(2350);
      broker = await setupBroker();
      await connectClient(probe, "reconnect-takeover-probe", {});
      const deadline = Date.now() + 12_000;
      let reconnected = false;
      while (Date.now() < deadline) {
        // Reconnect observations must finish before querying the broker again.
        // oxlint-disable-next-line no-await-in-loop
        const sessions = await probe.listSessions().catch(() => []);
        if (sessions.some((session) => session.name === "reconnect-takeover-controller")) {
          reconnected = true;
          break;
        }
        // Back off after observing this failed reconnect attempt.
        // oxlint-disable-next-line no-await-in-loop
        await sleep(200);
      }
      assert.ok(
        reconnected,
        "a failed foreground attempt during backoff must re-arm the background retry chain",
      );
    } finally {
      rmSync(configPath, { force: true });
      await probe.disconnect();
      await harness.emitLifecycle("session_shutdown");
      await stopBroker(broker);
    }
  },
);

test(
  "before_agent_start fails open while project identity resolution is slow",
  { concurrency: false },
  async () => {
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const broker = await setupBroker();
    const harness = await createExtensionHarness("slow-project-controller");
    const fakeBin = mkdtempSync(path.join(tmpdir(), "pi-intercom-slow-git-"));
    const previousPath = process.env.PATH;
    writeFileSync(
      path.join(fakeBin, "git"),
      "#!/usr/bin/env node\nsetTimeout(() => process.exit(1), 2000);\n",
      { mode: 0o755 },
    );

    try {
      process.env.PATH = `${fakeBin}${path.delimiter}${previousPath ?? ""}`;
      piIntercomExtension(harness.pi);
      await harness.emitLifecycle("session_start");

      const startedAt = Date.now();
      const results = await harness.emitLifecycle("before_agent_start", {
        systemPrompt: "base prompt",
      });
      assert.ok(
        Date.now() - startedAt < 250,
        "peer awareness should fail open before slow Git resolution settles",
      );
      assert.equal(
        results.some(
          (result) => result !== null && typeof result === "object" && "systemPrompt" in result,
        ),
        false,
      );
      await sleep(550);
    } finally {
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
      await harness.emitLifecycle("session_shutdown");
      await stopBroker(broker);
      rmSync(fakeBin, { recursive: true, force: true });
    }
  },
);

test(
  "intercom list and status show recipient capability and delivery guidance",
  { concurrency: false },
  async () => {
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const broker = await setupBroker();
    const harness = await createExtensionHarness("capability-controller", { hasUI: true });
    const busyPeer = new IntercomClient();

    try {
      await connectClient(busyPeer, "busy-peer", {
        status: "thinking",
        acceptsAsks: false,
        pendingAsks: 2,
        lastIntercomActivity: Date.now() - 65_000,
      });
      piIntercomExtension(harness.pi);
      await harness.emitLifecycle("session_start");
      const intercomTool = harness.tool("intercom");

      const listResult = await intercomTool.execute(
        "tool-capability-list",
        {
          action: "list",
        },
        new AbortController().signal,
        undefined,
        harness.ctx,
      );
      const listText = textAt(listResult.content);
      assert.equal(listResult.isError, false);
      assert.match(listText, /capability-controller/);
      assert.match(
        listText,
        /self target unavailable; choose a peer from Other sessions; use pending\/reply for inbound asks/,
      );
      assert.match(listText, /busy-peer/);
      assert.match(listText, /state:busy/);
      assert.match(listText, /accepts_asks:false/);
      assert.match(listText, /pending_asks:2/);
      assert.match(listText, /last_intercom_activity:1m ago/);
      assert.match(listText, /ask only if sender must stay alive for a required reply/);
      assert.match(listText, /default sends without waiting when peer is busy/);
      assert.match(listText, /passive discouraged/);

      const statusResult = await intercomTool.execute(
        "tool-capability-status",
        {
          action: "status",
        },
        new AbortController().signal,
        undefined,
        harness.ctx,
      );
      const statusText = textAt(statusResult.content);
      assert.equal(statusResult.isError, false);
      assert.match(statusText, /Intercom Status/);
      assert.match(statusText, /Current session/);
      assert.match(statusText, /Other sessions/);
      assert.match(statusText, /self target unavailable/);
      assert.match(statusText, /busy-peer/);
      assert.match(statusText, /send defaults to steer/);
      assert.match(statusText, /queue only for intentional delay/);
    } finally {
      await busyPeer.disconnect();
      await harness.emitLifecycle("session_shutdown");
      await stopBroker(broker);
    }
  },
);

test(
  "plain sends wake by default, passive sends do not, and only asks show reply hints",
  { concurrency: false },
  async () => {
    const { planner, cleanup } = await setupClients();
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const harness = await createExtensionHarness("hint-worker", { hasUI: true });

    try {
      piIntercomExtension(harness.pi);
      await harness.emitLifecycle("session_start");
      const target = await waitForSessionByName(planner, "hint-worker");

      await planner.send(target.id, { messageId: "plain-send", text: "FYI only" });
      await nextTurn();
      assert.match(harness.sentMessages[0]?.message.content ?? "", /FYI only/);
      assert.doesNotMatch(harness.sentMessages[0]?.message.content ?? "", /To reply/);
      assert.deepEqual(harness.sentMessages[0]?.options, { triggerTurn: true });

      await planner.send(target.id, {
        messageId: "passive-send",
        text: "FYI later",
        passive: true,
      });
      await nextTurn();
      assert.match(harness.sentMessages[1]?.message.content ?? "", /FYI later/);
      assert.doesNotMatch(harness.sentMessages[1]?.message.content ?? "", /To reply/);
      assert.deepEqual(harness.sentMessages[1]?.options, { triggerTurn: false });

      await planner.send(target.id, {
        messageId: "needs-reply",
        text: "Need answer",
        expectsReply: true,
      });
      await nextTurn();
      assert.match(harness.sentMessages[2]?.message.content ?? "", /Need answer/);
      assert.match(harness.sentMessages[2]?.message.content ?? "", /To reply/);
      assert.deepEqual(harness.sentMessages[2]?.options, { triggerTurn: true });
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await cleanup();
    }
  },
);

test("broker exits when no session ever registers", { concurrency: false }, async () => {
  const broker = await setupBroker();
  let timeout: NodeJS.Timeout | undefined;
  try {
    const exited: unknown = await Promise.race([
      once(broker, "exit"),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Broker kept running without sessions")),
          10_000,
        );
      }),
    ]);
    assert.equal(array(exited)[0], 0);
  } finally {
    clearTimeout(timeout);
    await stopBroker(broker);
  }
});

test(
  "broker returns a clean delivery failure when forwarding would exceed the frame cap",
  { concurrency: false },
  async () => {
    const broker = await setupBroker();
    const sender = new IntercomClient({ sendTimeoutMs: 2000 });
    const receiver = new IntercomClient({ sendTimeoutMs: 2000 });

    try {
      await sender.connect({
        name: "large-sender",
        cwd: "c".repeat(300_000),
        model: "m".repeat(100_000),
      });
      await connectClient(receiver, "large-receiver");

      assertDefined(receiver.sessionId);
      const result = await sender.send(receiver.sessionId, {
        messageId: "too-large-forward",
        text: "x".repeat(Math.max(1, MAX_FRAME_SIZE_BYTES - 350_000)),
      });

      assert.equal(result.delivered, false);
      assert.match(result.reason ?? "", /message too large/i);

      const queuedResult = await sender.send(receiver.sessionId, {
        messageId: "too-large-queued-forward",
        text: "x".repeat(Math.max(1, MAX_FRAME_SIZE_BYTES - 350_000)),
        expectsReply: true,
        delivery: "queue",
        queueMode: "replace",
        threadId: "too-large-forward",
      });
      assert.equal(queuedResult.delivered, false);
      assert.equal(queuedResult.queued, undefined);
      assert.match(queuedResult.reason ?? "", /message too large/i);
      assert.equal(sender.isConnected(), true);
    } finally {
      await sender.disconnect();
      await receiver.disconnect();
      await stopBroker(broker);
    }
  },
);

test(
  "intercom send passive opt-in is exposed through the public tool",
  { concurrency: false },
  async () => {
    const { planner, cleanup } = await setupClients();
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const sender = await createExtensionHarness("tool-passive-sender", { hasUI: true });
    const receiver = await createExtensionHarness("tool-passive-receiver", { hasUI: true });

    try {
      piIntercomExtension(sender.pi);
      piIntercomExtension(receiver.pi);
      await sender.emitLifecycle("session_start");
      await receiver.emitLifecycle("session_start");
      await waitForSessionByName(planner, "tool-passive-receiver");

      const intercomTool = sender.tool("intercom");
      const result = await intercomTool.execute(
        "tool-passive-send",
        {
          action: "send",
          to: "tool-passive-receiver",
          message: "FYI for transcript only",
          passive: true,
        },
        new AbortController().signal,
        undefined,
        sender.ctx,
      );

      assert.equal(result.isError, false);
      assert.match(textAt(result.content), /passive; recipient model was not woken/);
      await nextTurn();
      assert.match(receiver.sentMessages[0]?.message.content ?? "", /FYI for transcript only/);
      assert.deepEqual(receiver.sentMessages[0]?.options, { triggerTurn: false });

      const invalidPassiveResult = await intercomTool.execute(
        "tool-passive-ask",
        {
          action: "ask",
          to: "tool-passive-receiver",
          message: "Can this be passive?",
          passive: true,
        },
        new AbortController().signal,
        undefined,
        sender.ctx,
      );
      assert.equal(invalidPassiveResult.isError, true);
      assert.match(textAt(invalidPassiveResult.content), /only valid for action='send'/);
    } finally {
      await sender.emitLifecycle("session_shutdown");
      await receiver.emitLifecycle("session_shutdown");
      await cleanup();
    }
  },
);

test(
  "pending ask is expired when sender disconnects before reply",
  { concurrency: false },
  async () => {
    const { planner, cleanup } = await setupClients();
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const harness = await createExtensionHarness("disconnect-expiry-worker", { hasUI: true });

    try {
      piIntercomExtension(harness.pi);
      await harness.emitLifecycle("session_start");
      const target = await waitForSessionByName(planner, "disconnect-expiry-worker");

      await planner.send(target.id, {
        messageId: "disconnecting-ask",
        text: "Need answer",
        expectsReply: true,
      });
      await nextTurn();
      assert.match(harness.sentMessages[0]?.message.content ?? "", /Need answer/);

      await planner.disconnect();
      await nextTurn();

      const intercomTool = harness.tool("intercom");
      const result = await intercomTool.execute(
        "reply-after-disconnect",
        {
          action: "reply",
          message: "normal reply",
        },
        new AbortController().signal,
        undefined,
        harness.ctx,
      );

      assert.equal(result.isError, true);
      assert.match(textAt(result.content), /No active intercom context to reply to/);
      assert.doesNotMatch(textAt(result.content), /Session not found|not delivered/);
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await cleanup();
    }
  },
);

test(
  "recipient turn failures are reported to waiting ask senders",
  { concurrency: false },
  async () => {
    const { planner, cleanup } = await setupClients();
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const harness = await createExtensionHarness("failing-worker", { hasUI: true });

    try {
      piIntercomExtension(harness.pi);
      await harness.emitLifecycle("session_start");
      const target = await waitForSessionByName(planner, "failing-worker");
      const replyPromise = waitForReply(planner, "failure-ask");

      await planner.send(target.id, {
        messageId: "failure-ask",
        text: "Need answer",
        expectsReply: true,
      });
      await waitForSentMessages(harness, 1);
      await harness.emitLifecycle("turn_start");
      await harness.emitLifecycle("message_end", {
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "No API key for provider: test",
        },
      });

      const reply = await replyPromise;
      assert.equal(reply.message.replyTo, "failure-ask");
      assert.match(
        reply.message.content.text,
        /Recipient turn failed: No API key for provider: test/,
      );
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await cleanup();
    }
  },
);

test(
  "recipient turn failures after tool turns still report to waiting ask senders",
  { concurrency: false },
  async () => {
    const { planner, cleanup } = await setupClients();
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const harness = await createExtensionHarness("multi-turn-failing-worker", { hasUI: true });

    try {
      piIntercomExtension(harness.pi);
      await harness.emitLifecycle("session_start");
      const target = await waitForSessionByName(planner, "multi-turn-failing-worker");
      const replyPromise = waitForReply(planner, "multi-turn-failure-ask");

      await planner.send(target.id, {
        messageId: "multi-turn-failure-ask",
        text: "Need answer",
        expectsReply: true,
      });
      await waitForSentMessages(harness, 1);
      await harness.emitLifecycle("turn_start");
      await harness.emitLifecycle("turn_end");
      await harness.emitLifecycle("turn_start");
      await harness.emitLifecycle("message_end", {
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "Tool-followup provider failure",
        },
      });

      const reply = await replyPromise;
      assert.equal(reply.message.replyTo, "multi-turn-failure-ask");
      assert.match(
        reply.message.content.text,
        /Recipient turn failed: Tool-followup provider failure/,
      );
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await cleanup();
    }
  },
);

test(
  "recipient turn failures do not report after an ask is already replied",
  { concurrency: false },
  async () => {
    const { planner, cleanup } = await setupClients();
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const harness = await createExtensionHarness("replied-worker", { hasUI: true });

    try {
      piIntercomExtension(harness.pi);
      await harness.emitLifecycle("session_start");
      const target = await waitForSessionByName(planner, "replied-worker");
      const firstReplyPromise = waitForReply(planner, "already-replied-ask");

      await planner.send(target.id, {
        messageId: "already-replied-ask",
        text: "Need answer",
        expectsReply: true,
      });
      await waitForSentMessages(harness, 1);
      await harness.emitLifecycle("turn_start");
      const intercomTool = harness.tool("intercom");
      const replyResult = await intercomTool.execute(
        "reply-before-error",
        {
          action: "reply",
          message: "normal reply",
          attachments: [{ type: "context", name: "answer.txt", content: "supporting context" }],
        },
        new AbortController().signal,
        undefined,
        harness.ctx,
      );
      assert.equal(replyResult.isError, false);
      const receivedReply = (await firstReplyPromise).message;
      assert.equal(receivedReply.content.text, "normal reply");
      assert.deepEqual(receivedReply.content.attachments, [
        { type: "context", name: "answer.txt", content: "supporting context" },
      ]);

      let unexpectedFailureReply = false;
      const handler = (_from: ReadonlyInput<SessionInfo>, message: ReadonlyInput<Message>) => {
        if (message.replyTo === "already-replied-ask") {
          unexpectedFailureReply = true;
        }
      };
      planner.on("message", handler);
      await harness.emitLifecycle("message_end", {
        message: { role: "assistant", stopReason: "error", errorMessage: "later failure" },
      });
      await sleep(100);
      planner.off("message", handler);
      assert.equal(unexpectedFailureReply, false);
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await cleanup();
    }
  },
);

test(
  "recipient turn failure propagation stops after agent_settled",
  { concurrency: false },
  async () => {
    const { planner, cleanup } = await setupClients();
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const harness = await createExtensionHarness("agent-ended-worker", { hasUI: true });

    try {
      piIntercomExtension(harness.pi);
      await harness.emitLifecycle("session_start");
      const target = await waitForSessionByName(planner, "agent-ended-worker");
      await planner.send(target.id, {
        messageId: "agent-ended-ask",
        text: "Need answer",
        expectsReply: true,
      });
      await waitForSentMessages(harness, 1);
      await harness.emitLifecycle("turn_start");
      await harness.emitLifecycle("turn_end");
      await harness.emitLifecycle("agent_end");
      await harness.emitLifecycle("agent_settled");

      let unexpectedFailureReply = false;
      const handler = (_from: ReadonlyInput<SessionInfo>, message: ReadonlyInput<Message>) => {
        if (message.replyTo === "agent-ended-ask") {
          unexpectedFailureReply = true;
        }
      };
      planner.on("message", handler);
      await harness.emitLifecycle("message_end", {
        message: { role: "assistant", stopReason: "error", errorMessage: "post-agent failure" },
      });
      await sleep(100);
      planner.off("message", handler);
      assert.equal(unexpectedFailureReply, false);
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await cleanup();
    }
  },
);

test(
  "intercom ask returns an error result for recipient turn failure replies",
  { concurrency: false },
  async () => {
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const { cleanup } = await setupClients();
    const worker = new IntercomClient();
    const harness = await createExtensionHarness("ask-controller", { hasUI: true });

    try {
      piIntercomExtension(harness.pi);
      await harness.emitLifecycle("session_start");
      await connectClient(worker, "failing-peer");
      const intercomTool = harness.tool("intercom");
      const askReceived = receiveMessage(worker);
      const resultPromise = intercomTool.execute(
        "ask-failure",
        {
          action: "ask",
          to: "failing-peer",
          message: "Can you answer?",
        },
        new AbortController().signal,
        undefined,
        harness.ctx,
      );
      const [from, message] = await askReceived;
      await worker.send(from.id, {
        text: "Recipient turn failed: No API key for provider: test",
        replyTo: message.id,
        attachments: [
          {
            type: "context",
            name: "pi-intercom-recipient-turn-failure",
            content: "No API key for provider: test",
          },
        ],
      });

      const result = await resultPromise;
      assert.equal(result.isError, true);
      assert.match(textAt(result.content), /Recipient turn failed: No API key for provider: test/);
      assert.equal(record(result.details).reasonCode, "recipient_turn_failed");
      assert.equal(typeof record(result.details).messageId, "string");
      assert.equal(typeof record(result.details).replyTo, "string");
      assert.deepEqual(record(result.details).nextActions, [
        { action: "status" },
        { action: "send", guidance: "Send recovery context after the recipient is healthy." },
      ]);
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await worker.disconnect();
      await cleanup();
    }
  },
);

test(
  "intercom ask treats failure-like normal reply text as a successful reply",
  { concurrency: false },
  async () => {
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const { cleanup } = await setupClients();
    const worker = new IntercomClient();
    const harness = await createExtensionHarness("ask-controller-normal-prefix", { hasUI: true });

    try {
      piIntercomExtension(harness.pi);
      await harness.emitLifecycle("session_start");
      await connectClient(worker, "prefix-reply-peer");
      const intercomTool = harness.tool("intercom");
      const askReceived = receiveMessage(worker);
      const resultPromise = intercomTool.execute(
        "ask-normal-prefix",
        {
          action: "ask",
          to: "prefix-reply-peer",
          message: "Can you answer?",
        },
        new AbortController().signal,
        undefined,
        harness.ctx,
      );
      const [from, message] = await askReceived;
      await worker.send(from.id, {
        text: "Recipient turn failed: is just text in this normal answer",
        replyTo: message.id,
      });

      const result = await resultPromise;
      assert.equal(result.isError, false);
      assert.match(textAt(result.content), /Recipient turn failed: is just text/);
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await worker.disconnect();
      await cleanup();
    }
  },
);

test(
  "intercom ask rejects promptly when the reply peer disconnects",
  { concurrency: false },
  async () => {
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const { cleanup } = await setupClients();
    const worker = new IntercomClient();
    const harness = await createExtensionHarness("ask-disconnect-controller", { hasUI: true });

    try {
      piIntercomExtension(harness.pi);
      await harness.emitLifecycle("session_start");
      await connectClient(worker, "disconnecting-peer");
      const intercomTool = harness.tool("intercom");
      const askReceived = receiveMessage(worker);
      const resultPromise = intercomTool.execute(
        "ask-peer-disconnect",
        {
          action: "ask",
          to: "disconnecting-peer",
          message: "Will you vanish?",
        },
        new AbortController().signal,
        undefined,
        harness.ctx,
      );
      await askReceived;
      await worker.disconnect();

      const result = await Promise.race([
        resultPromise,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("ask did not reject promptly")), 1000);
        }),
      ]);
      assert.equal(result.isError, true);
      assert.match(textAt(result.content), /Reply peer disconnected before answering/);
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await worker.disconnect();
      await cleanup();
    }
  },
);

test(
  "non-error assistant messages do not propagate recipient failure replies",
  { concurrency: false },
  async () => {
    const { planner, cleanup } = await setupClients();
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const harness = await createExtensionHarness("non-error-worker", { hasUI: true });

    try {
      piIntercomExtension(harness.pi);
      await harness.emitLifecycle("session_start");
      const target = await waitForSessionByName(planner, "non-error-worker");
      await planner.send(target.id, {
        messageId: "non-error-ask",
        text: "Need answer",
        expectsReply: true,
      });
      await nextTurn();
      await harness.emitLifecycle("turn_start");

      let unexpectedFailureReply = false;
      const handler = (_from: ReadonlyInput<SessionInfo>, message: ReadonlyInput<Message>) => {
        if (message.replyTo === "non-error-ask") {
          unexpectedFailureReply = true;
        }
      };
      planner.on("message", handler);
      await harness.emitLifecycle("message_end", {
        message: { role: "assistant", stopReason: "stop", errorMessage: "stale provider warning" },
      });
      await sleep(100);
      planner.off("message", handler);
      assert.equal(unexpectedFailureReply, false);
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await cleanup();
    }
  },
);

test(
  "intercom tool accepts displayed short IDs when session names are duplicated",
  { concurrency: false },
  async () => {
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const { planner, cleanup } = await setupClients();
    const duplicateA = new IntercomClient();
    const duplicateB = new IntercomClient();
    const nameCollision = new IntercomClient();
    const harness = await createExtensionHarness("controller", { hasUI: true });

    try {
      piIntercomExtension(harness.pi);
      await harness.emitLifecycle("session_start");

      await connectClient(duplicateA, "duplicate-worker");
      await connectClient(duplicateB, "duplicate-worker");

      const duplicateSessions = (await planner.listSessions()).filter(
        (session) => session.name === "duplicate-worker",
      );
      assert.equal(duplicateSessions.length, 2);
      const target = duplicateSessions[0];
      const shortTarget = target.id.slice(0, 8);
      const receiver = duplicateA.sessionId === target.id ? duplicateA : duplicateB;
      const messagePromise = receiveMessage(receiver);

      const intercomTool = harness.tool("intercom");
      const result = await intercomTool.execute(
        "tool-1",
        {
          action: "send",
          to: shortTarget,
          message: "short id delivery works",
        },
        new AbortController().signal,
        undefined,
        harness.ctx,
      );

      assert.equal(result.isError, false);
      assert.match(textAt(result.content), /defaults to steer/);
      const [, message] = await messagePromise;
      assert.equal(message.content.text, "short id delivery works");
      assert.equal(message.delivery, "steer");

      const tooShortPrefixResult = await intercomTool.execute(
        "tool-too-short",
        {
          action: "send",
          to: shortTarget.slice(0, 7),
          message: "too short should not deliver",
        },
        new AbortController().signal,
        undefined,
        harness.ctx,
      );
      assert.equal(tooShortPrefixResult.isError, true);
      assert.match(textAt(tooShortPrefixResult.content), /too short/);
      assert.match(textAt(tooShortPrefixResult.content), new RegExp(shortTarget));

      const listResult = await intercomTool.execute(
        "tool-list",
        {
          action: "list",
        },
        new AbortController().signal,
        undefined,
        harness.ctx,
      );
      assert.match(textAt(listResult.content), new RegExp(`target:${shortTarget}`));

      const askMessagePromise = receiveMessage(receiver);
      const askResultPromise = intercomTool.execute(
        "tool-ask",
        {
          action: "ask",
          to: shortTarget,
          message: "short id ask works",
        },
        new AbortController().signal,
        undefined,
        harness.ctx,
      );
      const [askFrom, askMessage] = await askMessagePromise;
      assert.equal(askMessage.content.text, "short id ask works");
      assert.equal(askMessage.expectsReply, true);
      assert.equal(askMessage.delivery, undefined);
      await receiver.send(askFrom.id, { text: "short id ask reply", replyTo: askMessage.id });
      const askResult = await askResultPromise;
      assert.equal(askResult.isError, false);
      assert.match(textAt(askResult.content), /short id ask reply/);

      const duplicateNameResult = await intercomTool.execute(
        "tool-2",
        {
          action: "send",
          to: "duplicate-worker",
          message: "ambiguous",
        },
        new AbortController().signal,
        undefined,
        harness.ctx,
      );
      assert.equal(duplicateNameResult.isError, true);
      assert.match(textAt(duplicateNameResult.content), /Use one of these targets/);
      assert.match(textAt(duplicateNameResult.content), new RegExp(shortTarget));

      await connectClient(nameCollision, shortTarget);
      const collisionResult = await intercomTool.execute(
        "tool-collision",
        {
          action: "send",
          to: shortTarget,
          message: "must not silently choose name over short id",
        },
        new AbortController().signal,
        undefined,
        harness.ctx,
      );
      assert.equal(collisionResult.isError, true);
      assert.match(textAt(collisionResult.content), /matches multiple sessions/);

      const duplicateNameAfterCollision = await intercomTool.execute(
        "tool-collision-options",
        {
          action: "send",
          to: "duplicate-worker",
          message: "ambiguous after collision",
        },
        new AbortController().signal,
        undefined,
        harness.ctx,
      );
      assert.equal(duplicateNameAfterCollision.isError, true);
      assert.match(textAt(duplicateNameAfterCollision.content), new RegExp(target.id.slice(0, 9)));

      const listAfterCollision = await intercomTool.execute(
        "tool-list-after-collision",
        {
          action: "list",
        },
        new AbortController().signal,
        undefined,
        harness.ctx,
      );
      assert.match(
        textAt(listAfterCollision.content),
        new RegExp(`\\(${target.id.slice(0, 9)}\\)`),
      );
      assert.match(
        textAt(listAfterCollision.content),
        new RegExp(`target:${target.id.slice(0, 9)}`),
      );

      const collisionSafeMessagePromise = receiveMessage(receiver);
      const collisionSafeResult = await intercomTool.execute(
        "tool-collision-safe",
        {
          action: "send",
          to: target.id.slice(0, 9),
          message: "longer short id delivery works",
        },
        new AbortController().signal,
        undefined,
        harness.ctx,
      );
      assert.equal(collisionSafeResult.isError, false);
      const [, collisionSafeMessage] = await collisionSafeMessagePromise;
      assert.equal(collisionSafeMessage.content.text, "longer short id delivery works");
    } finally {
      await duplicateA.disconnect();
      await duplicateB.disconnect();
      await nameCollision.disconnect();
      await harness.emitLifecycle("session_shutdown");
      await cleanup();
    }
  },
);

test("compose overlay preserves complete bracketed pastes as literal content", async (t) => {
  const sent: Array<{ to: string; text: string; expectsReply: boolean | undefined }> = [];
  let renderRequests = 0;
  let doneResult: unknown;
  const keybindings = new KeybindingsManager();
  const tui = new TuiAltScreen(createTestTerminal());
  t.mock.method(tui, "requestRender", () => {
    renderRequests += 1;
  });
  const overlay = new ComposeOverlay(tui, renderTheme, {
    keybindings,
    target: { id: "target-session", name: "worker", cwd: repoDir, model: "test-model" },
    targetLabel: "worker",
    client: {
      send: async (
        to: string,
        options: ReadonlyInput<Parameters<InstanceType<typeof IntercomClient>["send"]>[1]>,
      ) => {
        sent.push({ to, text: options.text, expectsReply: options.expectsReply });
        return { id: "message-1", accepted: true, delivered: true };
      },
    },
    done: (result) => {
      doneResult = result;
    },
  });

  overlay.handleInput("\x1b[200~\tLine 1\r\n\tLine 2\r\x1b[201~");
  overlay.handleInput("\t");
  overlay.handleInput("x");
  overlay.handleInput("\x7f");
  const rendered = overlay.render(100).join("\n");
  assert.match(rendered, /Request reply to: worker/);
  assert.match(rendered, /Line 1/);
  assert.match(rendered, /Line 2/);

  overlay.handleInput("\r");
  await nextTurn();

  assert.equal(renderRequests >= 4, true);
  assert.deepEqual(sent, [
    { to: "target-session", text: "\tLine 1\n\tLine 2\n", expectsReply: true },
  ]);
  assert.deepEqual(doneResult, {
    sent: true,
    messageId: "message-1",
    text: "\tLine 1\n\tLine 2\n",
    expectsReply: true,
  });

  doneResult = undefined;
  const cancelOverlay = new ComposeOverlay(tui, renderTheme, {
    keybindings,
    target: { id: "target-session", name: "worker", cwd: repoDir, model: "test-model" },
    targetLabel: "worker",
    client: { send: async () => ({ id: "unused", accepted: true, delivered: true }) },
    done: (result) => {
      doneResult = result;
    },
  });
  cancelOverlay.handleInput("\x1b");
  assert.equal(doneResult, undefined);
  await sleep(250);
  assert.deepEqual(doneResult, { sent: false });

  doneResult = undefined;
  const partialPasteOverlay = new ComposeOverlay(tui, renderTheme, {
    keybindings,
    target: { id: "target-session", name: "worker", cwd: repoDir, model: "test-model" },
    targetLabel: "worker",
    client: { send: async () => ({ id: "unused", accepted: true, delivered: true }) },
    done: (result) => {
      doneResult = result;
    },
  });
  partialPasteOverlay.handleInput("\x1b[200~unterminated");
  assert.match(partialPasteOverlay.render(100).join("\n"), /unterminated/);
  partialPasteOverlay.handleInput("\x1b");
  assert.equal(
    doneResult,
    undefined,
    "escape bytes inside an incomplete paste are literal paste content",
  );
  partialPasteOverlay.handleInput("\x1b[201~");
  assert.match(partialPasteOverlay.render(100).join("\n"), /unterminated/);
  partialPasteOverlay.handleInput("\x1b");
  await sleep(250);
  assert.deepEqual(doneResult, { sent: false });

  doneResult = undefined;
  const splitPasteOverlay = new ComposeOverlay(tui, renderTheme, {
    keybindings,
    target: { id: "target-session", name: "worker", cwd: repoDir, model: "test-model" },
    targetLabel: "worker",
    client: { send: async () => ({ id: "unused", accepted: true, delivered: true }) },
    done: (result) => {
      doneResult = result;
    },
  });
  splitPasteOverlay.handleInput("\x1b");
  assert.equal(doneResult, undefined, "a split paste marker must not cancel the overlay");
  splitPasteOverlay.handleInput("[200~split start marker");
  splitPasteOverlay.handleInput("\x1b[201~");
  assert.match(splitPasteOverlay.render(100).join("\n"), /split start marker/);

  doneResult = undefined;
  const abandonedPasteOverlay = new ComposeOverlay(tui, renderTheme, {
    keybindings,
    target: { id: "target-session", name: "worker", cwd: repoDir, model: "test-model" },
    targetLabel: "worker",
    client: { send: async () => ({ id: "unused", accepted: true, delivered: true }) },
    done: (result) => {
      doneResult = result;
    },
  });
  abandonedPasteOverlay.handleInput("\x1b[200~abandoned paste");
  await sleep(250);
  abandonedPasteOverlay.handleInput("\x1b");
  await sleep(250);
  assert.deepEqual(doneResult, { sent: false });

  const overflowOverlay = new ComposeOverlay(tui, renderTheme, {
    keybindings,
    target: { id: "target-session", name: "worker", cwd: repoDir, model: "test-model" },
    targetLabel: "worker",
    client: { send: async () => ({ id: "unused", accepted: true, delivered: true }) },
    done: () => {
      /* This case checks paste rendering, not completion. */
    },
  });
  overflowOverlay.handleInput(`\x1b[200~${"x".repeat(1_000_001)}`);
  overflowOverlay.handleInput("tail\x1b[201~");
  const overflowRendered = overflowOverlay.render(100).join("\n");
  assert.match(overflowRendered, /tail/);
  assert.doesNotMatch(overflowRendered, /\[201~/);

  const tailSent: string[] = [];
  const tailOverlay = new ComposeOverlay(tui, renderTheme, {
    keybindings,
    target: { id: "target-session", name: "worker", cwd: repoDir, model: "test-model" },
    targetLabel: "worker",
    client: {
      send: async (
        _to: string,
        options: ReadonlyInput<Parameters<InstanceType<typeof IntercomClient>["send"]>[1]>,
      ) => {
        tailSent.push(options.text);
        return { id: "tail", accepted: true, delivered: true };
      },
    },
    done: () => {
      /* This case checks submitted text, not completion receipt. */
    },
  });
  tailOverlay.handleInput("\x1b[200~body\x1b[201~tail");
  tailOverlay.handleInput("\r");
  await nextTurn();
  assert.deepEqual(tailSent, ["bodytail"]);

  const unicodeSent: string[] = [];
  const unicodeClient = {
    send: async (
      _to: string,
      options: ReadonlyInput<Parameters<InstanceType<typeof IntercomClient>["send"]>[1]>,
    ) => {
      unicodeSent.push(options.text);
      return { id: "unicode", accepted: true, delivered: true };
    },
  };
  const unicodeOverlay = () =>
    new ComposeOverlay(tui, renderTheme, {
      keybindings,
      target: { id: "target-session", name: "worker", cwd: repoDir, model: "test-model" },
      targetLabel: "worker",
      client: unicodeClient,
      done: () => {
        /* The submitted draft is the assertion boundary in this case. */
      },
    });
  const family = unicodeOverlay();
  family.handleInput("e\u0301👩‍👩‍👧‍👦");
  family.handleInput("\x7f");
  family.handleInput("\r");
  await nextTurn();
  assert.deepEqual(
    unicodeSent,
    ["e\u0301"],
    "one Backspace removes the complete family emoji, not the combining cluster before it",
  );
  const combining = unicodeOverlay();
  combining.handleInput("e\u0301👩‍👩‍👧‍👦");
  combining.handleInput("\x7f");
  combining.handleInput("\x7f");
  combining.handleInput("kept");
  combining.handleInput("\r");
  await nextTurn();
  assert.deepEqual(
    unicodeSent,
    ["e\u0301", "kept"],
    "a second Backspace removes the complete combining cluster",
  );
});

test(
  "invalid presence updates cannot poison peer session lists",
  { concurrency: false },
  async () => {
    const broker = await setupBroker();
    const badPeer = new IntercomClient();
    const healthyPeer = new IntercomClient();
    try {
      await connectClient(badPeer, "bad-presence-peer");
      await connectClient(healthyPeer, "healthy-presence-peer");
      badPeer.updatePresence({ name: "bad\u0001name", pendingAsks: 0.5 });
      const deadline = Date.now() + 2_000;
      while (badPeer.isConnected() && Date.now() < deadline) {
        // Wait for the broker to close the invalid peer before listing healthy peers.
        // oxlint-disable-next-line no-await-in-loop
        await sleep(25);
      }
      assert.equal(badPeer.isConnected(), false);
      const sessions = await healthyPeer.listSessions();
      assert.equal(
        sessions.some((session) => session.name === "healthy-presence-peer"),
        true,
      );
      assert.equal(
        sessions.some((session) => session.name !== undefined && session.name.includes("bad")),
        false,
      );
    } finally {
      await badPeer.disconnect();
      await healthyPeer.disconnect();
      await stopBroker(broker);
    }
  },
);

test("sessions publish automatic lifecycle status", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const { planner, cleanup } = await setupClients();
  let contextIdle = true;
  const harness = await createExtensionHarness("status-worker", {
    hasUI: true,
    isIdle: () => contextIdle,
  });

  try {
    piIntercomExtension(harness.pi);
    await harness.emitLifecycle("session_start");

    let statusSession = await waitForSessionStatus(planner, "status-worker", "idle");
    assert.equal(statusSession.acceptsAsks, true);
    assert.equal(statusSession.pendingAsks, 0);
    assert.equal(typeof statusSession.lastSeen, "number");

    const freshEventContext = {
      ...harness.ctx,
      model: { ...harness.ctx.model, id: "fresh-model" },
    };
    await harness.emitLifecycle(
      "model_select",
      { model: { id: "fresh-model" } },
      freshEventContext,
    );
    await waitForSessionModel(planner, "status-worker", "fresh-model");

    contextIdle = false;
    await harness.emitLifecycle("agent_start");
    statusSession = await waitForSessionStatus(planner, "status-worker", "thinking");
    assert.equal(statusSession.acceptsAsks, false);

    await harness.emitLifecycle("tool_execution_start", { toolCallId: "tool-1", toolName: "bash" });
    await waitForSessionStatus(planner, "status-worker", "tool:bash");
    await harness.emitLifecycle("tool_execution_start", { toolCallId: "tool-2", toolName: "read" });

    await harness.emitLifecycle("tool_execution_end", { toolCallId: "tool-1", toolName: "bash" });
    await waitForSessionStatus(planner, "status-worker", "tool:read");

    await harness.emitLifecycle("tool_execution_end", { toolCallId: "tool-2", toolName: "read" });
    await waitForSessionStatus(planner, "status-worker", "thinking");

    await harness.emitLifecycle("agent_end");
    await waitForSessionStatus(planner, "status-worker", "thinking");
    contextIdle = true;
    await harness.emitLifecycle("agent_settled");
    statusSession = await waitForSessionStatus(planner, "status-worker", "idle");
    assert.equal(statusSession.acceptsAsks, true);
  } finally {
    await harness.emitLifecycle("session_shutdown");
    await cleanup();
  }
});

test(
  "intercom ask reports a busy recipient and stops waiting without claiming consumption",
  { concurrency: false },
  async () => {
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const { planner, cleanup } = await setupClients();
    const peer = new IntercomClient();
    const harness = await createExtensionHarness("ask-controller", { hasUI: true });

    try {
      await connectClient(peer, "busy-peer-health", {
        acceptsAsks: false,
        pendingAsks: 1,
        lastIntercomActivity: 0,
      });
      piIntercomExtension(harness.pi);
      await harness.emitLifecycle("session_start");
      await waitForSessionByName(planner, "ask-controller");
      const target = await waitForSessionByName(planner, "busy-peer-health");
      assert.equal(target.acceptsAsks, false);

      const intercomTool = harness.tools.find((tool) => tool.name === "intercom");
      assert.ok(intercomTool);
      const received = receiveMessage(peer);
      const result = await intercomTool.execute(
        "ask-peer-idle",
        {
          action: "ask",
          to: "busy-peer-health",
          message: "Can you answer?",
        },
        new AbortController().signal,
        undefined,
        harness.ctx,
      );
      const [, message] = await received;

      assert.equal(message.expectsReply, true);
      assert.equal(result.isError, false);
      assert.match(textAt(result.content), /peer is busy.*peer_busy/);
      assert.match(textAt(result.content), /Not waiting for a reply/);
      assert.equal(record(result.details).accepted, true);
      assert.equal(record(result.details).queued, false);
      assert.equal(record(result.details).delivered, true);
      assert.equal(record(result.details).replied, false);
      assert.equal(record(result.details).reason, "peer_busy");
      assert.equal(record(result.details).reasonCode, "recipient_not_accepting_asks");
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await peer.disconnect();
      await cleanup();
    }
  },
);

test(
  "explicit steer asks wait for replies even when peer health says idle",
  { concurrency: false },
  async () => {
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const { planner, cleanup } = await setupClients();
    const peer = new IntercomClient();
    const harness = await createExtensionHarness("ask-steer-controller", { hasUI: true });

    try {
      await connectClient(peer, "busy-peer-steer", {
        acceptsAsks: false,
        pendingAsks: 1,
        lastIntercomActivity: 0,
      });
      piIntercomExtension(harness.pi);
      await harness.emitLifecycle("session_start");
      await waitForSessionByName(planner, "ask-steer-controller");
      const target = await waitForSessionByName(planner, "busy-peer-steer");
      assert.equal(target.acceptsAsks, false);

      const intercomTool = harness.tools.find((tool) => tool.name === "intercom");
      assert.ok(intercomTool);
      const resultPromise = intercomTool.execute(
        "ask-peer-steer",
        {
          action: "ask",
          to: "busy-peer-steer",
          delivery: "steer",
          message: "Can you answer now?",
        },
        new AbortController().signal,
        undefined,
        harness.ctx,
      );
      const [from, message] = await receiveMessage(peer);
      assert.equal(message.delivery, "steer");
      assert.equal(message.expectsReply, true);
      await peer.send(from.id, {
        text: "ACK steer",
        replyTo: message.id,
      });
      const result = await resultPromise;

      assert.equal(result.isError, false);
      assert.match(textAt(result.content), /ACK steer/);
      assert.notEqual(record(result.details).reason, "peer_idle");
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await peer.disconnect();
      await cleanup();
    }
  },
);

test(
  "explicit queue asks wait for replies even when peer health says idle",
  { concurrency: false },
  async () => {
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const { planner, cleanup } = await setupClients();
    const peer = new IntercomClient();
    const harness = await createExtensionHarness("ask-queue-controller", { hasUI: true });

    try {
      await connectClient(peer, "busy-peer-queue", {
        acceptsAsks: false,
        pendingAsks: 1,
        lastIntercomActivity: 0,
      });
      piIntercomExtension(harness.pi);
      await harness.emitLifecycle("session_start");
      await waitForSessionByName(planner, "ask-queue-controller");
      const target = await waitForSessionByName(planner, "busy-peer-queue");
      assert.equal(target.acceptsAsks, false);

      const intercomTool = harness.tools.find((tool) => tool.name === "intercom");
      assert.ok(intercomTool);
      const resultPromise = intercomTool.execute(
        "ask-peer-queue",
        {
          action: "ask",
          to: "busy-peer-queue",
          delivery: "queue",
          message: "Can you answer later?",
        },
        new AbortController().signal,
        undefined,
        harness.ctx,
      );
      const [from, message] = await receiveMessage(peer);
      assert.equal(message.delivery, "queue");
      assert.equal(message.expectsReply, true);
      await peer.send(from.id, {
        text: "ACK queue",
        replyTo: message.id,
      });
      const result = await resultPromise;

      assert.equal(result.isError, false);
      assert.match(textAt(result.content), /ACK queue/);
      assert.notEqual(record(result.details).reason, "peer_idle");
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await peer.disconnect();
      await cleanup();
    }
  },
);

test(
  "busy interactive sessions idle-gate default asks and steer default sends without aborting",
  { concurrency: false },
  async () => {
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const { planner, cleanup } = await setupClients();
    let abortCount = 0;
    let idle = false;
    const harness = await createExtensionHarness("interactive-worker", {
      abort: () => {
        abortCount += 1;
      },
      hasUI: true,
      isIdle: () => idle,
    });

    try {
      piIntercomExtension(harness.pi);
      await harness.emitLifecycle("session_start");

      const target = await waitForSessionByName(planner, "interactive-worker");

      const delivered = await planner.send(target.id, {
        messageId: "interactive-busy-ask",
        text: "Can you respond after your current turn?",
        expectsReply: true,
      });
      assert.equal(delivered.delivered, true);
      await sleep(250);
      assert.equal(abortCount, 0);
      assert.equal(harness.sentMessages.length, 0);

      idle = true;
      await harness.emitLifecycle("agent_end");
      await harness.emitLifecycle("agent_settled");
      await sleep(20);

      assert.equal(abortCount, 0);
      assert.equal(harness.sentMessages.length, 1);
      assert.equal(harness.sentMessages[0]?.message.customType, "intercom_message");
      assert.equal(harness.sentMessages[0]?.options?.triggerTurn, true);
      assert.match(
        harness.sentMessages[0]?.message.content ?? "",
        /Can you respond after your current turn/,
      );

      idle = false;
      const sent = await planner.send(target.id, {
        messageId: "interactive-busy-send",
        text: "Plain send should steer current work.",
      });
      assert.equal(sent.delivered, true);
      await nextTurn();
      assert.equal(abortCount, 0);
      assert.equal(harness.sentMessages.length, 2);
      assert.equal(harness.sentMessages[1]?.message.customType, "intercom_message");
      assert.deepEqual(harness.sentMessages[1]?.options, { deliverAs: "steer" });
      assert.match(
        harness.sentMessages[1]?.message.content ?? "",
        /Plain send should steer current work/,
      );
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await cleanup();
    }
  },
);

test(
  "non-UI replace asks wake when the recipient becomes idle",
  { concurrency: false },
  async () => {
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const { planner, cleanup } = await setupClients();
    let idle = false;
    const harness = await createExtensionHarness("nonui-replace-ask-worker", {
      hasUI: false,
      isIdle: () => idle,
    });

    try {
      piIntercomExtension(harness.pi);
      await harness.emitLifecycle("session_start");
      await harness.emitLifecycle("agent_start");
      const target = await waitForSessionByName(planner, "nonui-replace-ask-worker");
      const queued = await planner.send(target.id, {
        messageId: "nonui-replace-ask",
        text: "Non-UI replace ask.",
        expectsReply: true,
        delivery: "queue",
        queueMode: "replace",
        threadId: "nonui-ask",
      });
      assert.equal(queued.accepted, true);
      await sleep(1700);
      assert.equal(harness.sentMessages.length, 0);

      idle = true;
      await harness.emitLifecycle("agent_end");
      await harness.emitLifecycle("agent_settled");
      await sleep(20);
      assert.equal(harness.sentMessages.length, 1);
      assert.deepEqual(harness.sentMessages[0]?.options, { triggerTurn: true });
      assert.match(harness.sentMessages[0]?.message.content ?? "", /Non-UI replace ask/);
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await cleanup();
    }
  },
);

test(
  "busy interactive sessions retain all accepted asks beyond 100 queued messages",
  { concurrency: false },
  async () => {
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const { planner, cleanup } = await setupClients();
    let idle = false;
    const harness = await createExtensionHarness("interactive-backlog-worker", {
      hasUI: true,
      isIdle: () => idle,
    });

    try {
      piIntercomExtension(harness.pi);
      await harness.emitLifecycle("session_start");
      const target = await waitForSessionByName(planner, "interactive-backlog-worker");
      for (let index = 0; index <= 100; index += 1) {
        assert.equal(
          // The backlog fixture establishes the accepted ask order before flushing.
          // oxlint-disable-next-line no-await-in-loop
          (
            await planner.send(target.id, {
              messageId: `backlog-ask-${index}`,
              text: `Queued question ${index}`,
              expectsReply: true,
            })
          ).delivered,
          true,
        );
      }
      // Sender acknowledgements confirm broker writes, not recipient processing.
      await waitForSession(
        planner,
        (session) => session.id === target.id && session.pendingAsks === 101,
        (sessions) =>
          `Timed out waiting for 101 received asks; pending: ${sessions.find((session) => session.id === target.id)?.pendingAsks ?? "none"}`,
      );
      const intercom = harness.tool("intercom");
      const pending = await intercom.execute(
        "backlog-pending",
        { action: "pending" },
        new AbortController().signal,
        undefined,
        harness.ctx,
      );
      assert.match(textAt(pending.content), /backlog-ask-0"/);
      assert.match(textAt(pending.content), /backlog-ask-100"/);
      assert.equal(harness.sentMessages.length, 0);

      idle = true;
      await harness.emitLifecycle("agent_settled");
      await waitForSentMessages(harness, 101);
      assert.equal(harness.sentMessages.length, 101);
      assert.deepEqual(
        harness.sentMessages.map(({ message }) => record(record(message.details).message).id),
        [...Array.from({ length: 100 }, (_, index) => `backlog-ask-${index + 1}`), "backlog-ask-0"],
      );
      assert.ok(
        harness.sentMessages.slice(0, -1).every(({ options }) => options?.deliverAs === "followUp"),
      );
      assert.deepEqual(harness.sentMessages.at(-1)?.options, { triggerTurn: true });
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await cleanup();
    }
  },
);

test(
  "busy interactive sessions defer explicit queued sends and idle-gate default asks",
  { concurrency: false },
  async () => {
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const { planner, cleanup } = await setupClients();
    let idle = false;
    const harness = await createExtensionHarness("interactive-queue-worker", {
      hasUI: true,
      isIdle: () => idle,
    });

    try {
      piIntercomExtension(harness.pi);
      await harness.emitLifecycle("session_start");
      const target = await waitForSessionByName(planner, "interactive-queue-worker");

      assert.equal(
        (
          await planner.send(target.id, {
            messageId: "queued-send-before-ask",
            text: "Context before the question.",
            delivery: "queue",
          })
        ).delivered,
        true,
      );
      assert.equal(
        (
          await planner.send(target.id, {
            messageId: "queued-ask-after-send",
            text: "Question that should own reply context.",
            expectsReply: true,
          })
        ).delivered,
        true,
      );

      await sleep(250);
      assert.equal(harness.sentMessages.length, 1);
      assert.deepEqual(harness.sentMessages[0]?.options, { deliverAs: "followUp" });
      persistSentIntercom(harness);

      idle = true;
      await harness.emitLifecycle("agent_end");
      await harness.emitLifecycle("agent_settled");
      await sleep(20);

      assert.equal(harness.sentMessages.length, 2);
      assert.match(harness.sentMessages[0]?.message.content ?? "", /Context before the question/);
      assert.deepEqual(harness.sentMessages[0]?.options, { deliverAs: "followUp" });
      assert.match(
        harness.sentMessages[1]?.message.content ?? "",
        /Question that should own reply context/,
      );
      assert.deepEqual(harness.sentMessages[1]?.options, { triggerTurn: true });
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await cleanup();
    }
  },
);

test(
  "omitted delivery defaults to steer while explicit queue stays deferred",
  { concurrency: false },
  async () => {
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const { planner, cleanup } = await setupClients();
    const harness = await createExtensionHarness("native-delivery-worker", {
      hasUI: true,
      isIdle: () => false,
    });

    try {
      piIntercomExtension(harness.pi);
      await harness.emitLifecycle("session_start");
      const target = await waitForSessionByName(planner, "native-delivery-worker");

      assert.equal(
        (
          await planner.send(target.id, {
            messageId: "default-steer",
            text: "Default to live steer.",
          })
        ).delivered,
        true,
      );
      assert.equal(
        (
          await planner.send(target.id, {
            messageId: "native-queue",
            text: "Queue this behind current work.",
            delivery: "queue",
          })
        ).delivered,
        true,
      );
      assert.equal(
        (
          await planner.send(target.id, {
            messageId: "native-steer",
            text: "Steer after the current tool.",
            delivery: "steer",
          })
        ).delivered,
        true,
      );

      await nextTurn();
      assert.equal(harness.sentMessages.length, 3);
      assert.match(harness.sentMessages[0]?.message.content ?? "", /Default to live steer/);
      assert.deepEqual(harness.sentMessages[0]?.options, { deliverAs: "steer" });
      assert.match(harness.sentMessages[1]?.message.content ?? "", /Queue this/);
      assert.deepEqual(harness.sentMessages[1]?.options, { deliverAs: "followUp" });
      assert.match(harness.sentMessages[2]?.message.content ?? "", /Steer after/);
      assert.deepEqual(harness.sentMessages[2]?.options, { deliverAs: "steer" });
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await cleanup();
    }
  },
);

test(
  "pre-cutover omitted delivery still steers a busy recipient",
  { concurrency: false },
  async () => {
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const { planner, cleanup } = await setupClients();
    const harness = await createExtensionHarness("legacy-delivery-worker", {
      hasUI: true,
      isIdle: () => false,
    });
    let legacySocket: net.Socket | undefined;

    try {
      piIntercomExtension(harness.pi);
      await harness.emitLifecycle("session_start");
      const target = await waitForSessionByName(planner, "legacy-delivery-worker");
      legacySocket = net.createConnection(getBrokerSocketPath());
      await once(legacySocket, "connect");
      writeMessage(legacySocket, {
        type: "register",
        session: { name: "legacy-raw-sender", cwd: repoDir, model: "test-model" },
      });
      await waitForSessionByName(planner, "legacy-raw-sender");

      writeMessage(legacySocket, {
        type: "send",
        to: target.id,
        message: {
          id: "legacy-default-steer",
          timestamp: Date.now(),
          content: { text: "Legacy sender omitted delivery." },
        },
      });

      await waitForSentMessages(harness, 1);
      assert.match(
        harness.sentMessages[0]?.message.content ?? "",
        /Legacy sender omitted delivery/,
      );
      assert.deepEqual(harness.sentMessages[0]?.options, { deliverAs: "steer" });
    } finally {
      legacySocket?.destroy();
      await harness.emitLifecycle("session_shutdown");
      await cleanup();
    }
  },
);

test(
  "replace queue mode keeps only the latest undelivered message for a thread",
  { concurrency: false },
  async () => {
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const { planner, cleanup } = await setupClients();
    let idle = false;
    const harness = await createExtensionHarness("replace-queue-worker", {
      hasUI: true,
      isIdle: () => idle,
    });

    try {
      piIntercomExtension(harness.pi);
      await harness.emitLifecycle("session_start");
      const target = await waitForSessionByName(planner, "replace-queue-worker");

      assert.equal(
        (
          await planner.send(target.id, {
            messageId: "replace-old",
            text: "Old instructions.",
            delivery: "queue",
            queueMode: "replace",
            threadId: "plan",
          })
        ).delivered,
        true,
      );
      assert.equal(
        (
          await planner.send(target.id, {
            messageId: "replace-new",
            text: "New instructions.",
            delivery: "queue",
            queueMode: "replace",
            threadId: "plan",
          })
        ).delivered,
        true,
      );

      await sleep(1800);
      assert.equal(harness.sentMessages.length, 0);

      idle = true;
      await harness.emitLifecycle("agent_end");
      await harness.emitLifecycle("agent_settled");
      await sleep(20);

      assert.equal(harness.sentMessages.length, 1);
      assert.doesNotMatch(harness.sentMessages[0]?.message.content ?? "", /Old instructions/);
      assert.match(harness.sentMessages[0]?.message.content ?? "", /New instructions/);
      assert.deepEqual(harness.sentMessages[0]?.options, { triggerTurn: true });
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await cleanup();
    }
  },
);

test(
  "replace queue mode coalesces quick idle updates before waking",
  { concurrency: false },
  async () => {
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const { planner, cleanup } = await setupClients();
    const harness = await createExtensionHarness("idle-replace-worker", {
      hasUI: true,
      isIdle: () => true,
    });

    try {
      piIntercomExtension(harness.pi);
      await harness.emitLifecycle("session_start");
      const target = await waitForSessionByName(planner, "idle-replace-worker");

      assert.deepEqual(
        await planner.send(target.id, {
          messageId: "idle-old",
          text: "OLD idle replacement.",
          delivery: "queue",
          queueMode: "replace",
          threadId: "idle-race",
        }),
        {
          id: "idle-old",
          accepted: true,
          delivered: false,
          queued: true,
          reason: "Queued for replace-mode delivery",
        },
      );
      assert.deepEqual(
        await planner.send(target.id, {
          messageId: "idle-final",
          text: "FINAL idle replacement.",
          delivery: "queue",
          queueMode: "replace",
          threadId: "idle-race",
        }),
        {
          id: "idle-final",
          accepted: true,
          delivered: false,
          queued: true,
          reason: "Queued for replace-mode delivery",
        },
      );

      await sleep(300);
      assert.equal(harness.sentMessages.length, 0);
      await sleep(1600);

      assert.equal(harness.sentMessages.length, 1);
      assert.doesNotMatch(harness.sentMessages[0]?.message.content ?? "", /OLD idle/);
      assert.match(harness.sentMessages[0]?.message.content ?? "", /FINAL idle/);
      assert.deepEqual(harness.sentMessages[0]?.options, { triggerTurn: true });
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await cleanup();
    }
  },
);

test(
  "broker delivers every unique replace-mode thread beyond the former sender cap",
  { concurrency: false },
  async () => {
    const { planner, orchestrator, cleanup } = await setupClients();
    const received: ReadonlyInput<Message>[] = [];
    orchestrator.on(
      "message",
      (_from: ReadonlyInput<SessionInfo>, message: ReadonlyInput<Message>) => {
        received.push(message);
      },
    );
    try {
      assertDefined(orchestrator.sessionId);
      orchestrator.updatePresence({ status: "idle", acceptsAsks: true });
      await waitForSessionStatus(planner, "orchestrator", "idle");
      for (let index = 0; index < 101; index++) {
        // Preserve the replace-window admission order independently for every thread.
        // oxlint-disable-next-line no-await-in-loop
        const result = await planner.send(orchestrator.sessionId, {
          messageId: `replace-backlog-${index}`,
          text: `update ${index}`,
          delivery: "queue",
          queueMode: "replace",
          threadId: `unique-thread-${index}`,
        });
        assert.equal(result.accepted, true);
      }
      await sleep(1800);
      assert.deepEqual(
        received.map((message) => message.id),
        Array.from({ length: 101 }, (_, index) => `replace-backlog-${index}`),
      );
    } finally {
      await cleanup();
    }
  },
);

test(
  "broker-staged replace delivery survives sender disconnect",
  { concurrency: false },
  async () => {
    const { planner, orchestrator, cleanup } = await setupClients();
    const received: ReadonlyInput<Message>[] = [];
    orchestrator.on(
      "message",
      (_from: ReadonlyInput<SessionInfo>, message: ReadonlyInput<Message>) => {
        received.push(message);
      },
    );

    try {
      assertDefined(orchestrator.sessionId);
      orchestrator.updatePresence({ status: "idle", acceptsAsks: true });
      await waitForSessionStatus(planner, "orchestrator", "idle");
      const result = await planner.send(orchestrator.sessionId, {
        messageId: "replace-disconnect",
        text: "Deliver after sender disconnects.",
        delivery: "queue",
        queueMode: "replace",
        threadId: "disconnect-window",
      });
      assert.deepEqual(result, {
        id: "replace-disconnect",
        accepted: true,
        delivered: false,
        queued: true,
        reason: "Queued for replace-mode delivery",
      });

      await planner.disconnect();
      await sleep(1800);

      assert.equal(received.length, 1);
      assert.equal(received[0]?.id, "replace-disconnect");
      assert.match(received[0]?.content.text ?? "", /sender disconnects/);
    } finally {
      await cleanup();
    }
  },
);

test(
  "broker-staged replace asks are dropped when sender disconnects",
  { concurrency: false },
  async () => {
    const { planner, orchestrator, cleanup } = await setupClients();
    const received: ReadonlyInput<Message>[] = [];
    orchestrator.on(
      "message",
      (_from: ReadonlyInput<SessionInfo>, message: ReadonlyInput<Message>) => {
        received.push(message);
      },
    );

    try {
      assertDefined(orchestrator.sessionId);
      const result = await planner.send(orchestrator.sessionId, {
        messageId: "replace-ask-disconnect",
        text: "Question after sender disconnects?",
        expectsReply: true,
        delivery: "queue",
        queueMode: "replace",
        threadId: "disconnect-ask-window",
      });
      assert.deepEqual(result, {
        id: "replace-ask-disconnect",
        accepted: true,
        delivered: false,
        queued: true,
        reason: "Queued for replace-mode delivery",
      });

      await planner.disconnect();
      await sleep(1800);

      assert.equal(received.length, 0);
    } finally {
      await cleanup();
    }
  },
);

test(
  "recipient-staged replace delivery survives sender disconnect before idle",
  { concurrency: false },
  async () => {
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const { planner, cleanup } = await setupClients();
    let idle = false;
    const harness = await createExtensionHarness("recipient-staged-disconnect-worker", {
      hasUI: true,
      isIdle: () => idle,
    });

    try {
      piIntercomExtension(harness.pi);
      await harness.emitLifecycle("session_start");
      const target = await waitForSessionByName(planner, "recipient-staged-disconnect-worker");

      assert.equal(
        (
          await planner.send(target.id, {
            messageId: "recipient-staged-disconnect",
            text: "Deliver after sender disconnects while recipient is busy.",
            delivery: "queue",
            queueMode: "replace",
            threadId: "recipient-disconnect-window",
          })
        ).delivered,
        true,
      );

      await sleep(1800);
      assert.equal(harness.sentMessages.length, 0);
      await planner.disconnect();

      idle = true;
      await harness.emitLifecycle("agent_end");
      await harness.emitLifecycle("agent_settled");
      await sleep(20);

      assert.equal(harness.sentMessages.length, 1);
      assert.match(harness.sentMessages[0]?.message.content ?? "", /recipient is busy/);
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await cleanup();
    }
  },
);

test(
  "replace queue mode respects lifecycle busy state even when context idle lags",
  { concurrency: false },
  async () => {
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const { planner, cleanup } = await setupClients();
    const harness = await createExtensionHarness("lifecycle-busy-replace-worker", {
      hasUI: true,
      isIdle: () => true,
    });

    try {
      piIntercomExtension(harness.pi);
      await harness.emitLifecycle("session_start");
      const target = await waitForSessionByName(planner, "lifecycle-busy-replace-worker");
      await harness.emitLifecycle("agent_start");
      await harness.emitLifecycle("tool_execution_start", {
        toolCallId: "sleep",
        toolName: "bash",
      });
      await waitForSessionStatus(planner, "lifecycle-busy-replace-worker", "tool:bash");

      assert.equal(
        (
          await planner.send(target.id, {
            messageId: "lifecycle-old",
            text: "OLD lifecycle message.",
            delivery: "queue",
            queueMode: "replace",
            threadId: "lifecycle-race",
          })
        ).delivered,
        true,
      );
      assert.equal(
        (
          await planner.send(target.id, {
            messageId: "lifecycle-final",
            text: "FINAL lifecycle message.",
            delivery: "queue",
            queueMode: "replace",
            threadId: "lifecycle-race",
          })
        ).delivered,
        true,
      );

      await sleep(1800);
      assert.equal(harness.sentMessages.length, 0);

      await harness.emitLifecycle("tool_execution_end", { toolCallId: "sleep", toolName: "bash" });
      await harness.emitLifecycle("agent_end");
      await harness.emitLifecycle("agent_settled");
      await sleep(20);

      assert.equal(harness.sentMessages.length, 1);
      assert.doesNotMatch(harness.sentMessages[0]?.message.content ?? "", /OLD lifecycle/);
      assert.match(harness.sentMessages[0]?.message.content ?? "", /FINAL lifecycle/);
      assert.deepEqual(harness.sentMessages[0]?.options, { triggerTurn: true });
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await cleanup();
    }
  },
);

test(
  "replace queue mode also removes older undelivered asks from pending state",
  { concurrency: false },
  async () => {
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const { planner, cleanup } = await setupClients();
    let idle = false;
    const harness = await createExtensionHarness("replace-ask-worker", {
      hasUI: true,
      isIdle: () => idle,
    });

    try {
      piIntercomExtension(harness.pi);
      await harness.emitLifecycle("session_start");
      const target = await waitForSessionByName(planner, "replace-ask-worker");

      assert.deepEqual(
        await planner.send(target.id, {
          messageId: "replace-ask-old",
          text: "Old question?",
          expectsReply: true,
          delivery: "queue",
          queueMode: "replace",
          threadId: "decision",
        }),
        {
          id: "replace-ask-old",
          accepted: true,
          delivered: false,
          queued: true,
          reason: "Queued for replace-mode delivery",
        },
      );
      assert.deepEqual(
        await planner.send(target.id, {
          messageId: "replace-ask-new",
          text: "New question?",
          expectsReply: true,
          delivery: "queue",
          queueMode: "replace",
          threadId: "decision",
        }),
        {
          id: "replace-ask-new",
          accepted: true,
          delivered: false,
          queued: true,
          reason: "Queued for replace-mode delivery",
        },
      );

      await sleep(1800);
      assert.equal(harness.sentMessages.length, 0);

      const intercomTool = harness.tool("intercom");
      const pending = await intercomTool.execute(
        "pending-after-replace",
        {
          action: "pending",
        },
        new AbortController().signal,
        undefined,
        harness.ctx,
      );
      assert.equal(pending.isError, false);
      assert.doesNotMatch(textAt(pending.content), /Old question/);
      assert.match(textAt(pending.content), /New question/);
      await sleep(20);
      const updatedPresence = (await planner.listSessions()).find(
        (session) => session.id === target.id,
      );
      assert.equal(updatedPresence?.pendingAsks, 1);

      idle = true;
      await harness.emitLifecycle("agent_end");
      await harness.emitLifecycle("agent_settled");
      await sleep(20);

      assert.equal(harness.sentMessages.length, 1);
      assert.doesNotMatch(harness.sentMessages[0]?.message.content ?? "", /Old question/);
      assert.match(harness.sentMessages[0]?.message.content ?? "", /New question/);
      assert.deepEqual(harness.sentMessages[0]?.options, { triggerTurn: true });
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await cleanup();
    }
  },
);

test(
  "busy passive delivery waits for idle without waking the model",
  { concurrency: false },
  async () => {
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const { planner, cleanup } = await setupClients();
    let idle = false;
    const harness = await createExtensionHarness("busy-passive-worker", {
      hasUI: true,
      isIdle: () => idle,
    });

    try {
      piIntercomExtension(harness.pi);
      await harness.emitLifecycle("session_start");
      const target = await waitForSessionByName(planner, "busy-passive-worker");

      assert.equal(
        (
          await planner.send(target.id, {
            messageId: "passive-busy",
            text: "Transcript breadcrumb.",
            delivery: "passive",
          })
        ).delivered,
        true,
      );

      await sleep(250);
      assert.equal(harness.sentMessages.length, 0);

      idle = true;
      await harness.emitLifecycle("agent_end");
      await harness.emitLifecycle("agent_settled");
      await sleep(20);

      assert.equal(harness.sentMessages.length, 1);
      assert.match(harness.sentMessages[0]?.message.content ?? "", /Transcript breadcrumb/);
      assert.deepEqual(harness.sentMessages[0]?.options, { triggerTurn: false });
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await cleanup();
    }
  },
);

test(
  "latest supervisor milestone survives two minutes busy, supersedes older progress, and remains visible until consumed",
  { concurrency: false },
  async () => {
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const { planner, cleanup } = await setupClients();
    let idle = false;
    const harness = await createExtensionHarness("stale-progress-supervisor", {
      hasUI: true,
      isIdle: () => idle,
    });
    const realNow = Date.now;

    try {
      piIntercomExtension(harness.pi);
      await harness.emitLifecycle("session_start");
      const target = await waitForSessionByName(planner, "stale-progress-supervisor");
      const intercom = harness.tool("intercom");
      const status = () =>
        intercom.execute(
          "pending-progress",
          { action: "status" },
          new AbortController().signal,
          undefined,
          harness.ctx,
        );

      Date.now = () => realNow() - 120_000;
      for (const text of [
        "Starting read-only scout.",
        "Found the root cause in the shared runner.",
      ]) {
        assert.equal(
          // Every progress revision supersedes the previous accepted revision.
          // oxlint-disable-next-line no-await-in-loop
          (
            await planner.send(target.id, {
              text: `Subagent progress update.\nRun: old-run\nAgent: scout\nChild index: 0\n\nUPDATE: ${text}`,
              delivery: "queue",
              queueMode: "replace",
              threadId: "subagent-progress:old-run:scout:0",
            })
          ).accepted,
          true,
        );
      }
      Date.now = realNow;

      await sleep(250);
      assert.equal(harness.sentMessages.length, 0);
      const queued = (await status()).content[0]?.text ?? "";
      assert.match(queued, /queued; not yet delivered to model/);
      assert.match(queued, /Found the root cause/);
      assert.doesNotMatch(queued, /Starting read-only scout/);
      // The child may exit before its supervisor becomes idle.
      await planner.disconnect();

      idle = true;
      await harness.emitLifecycle("agent_end");
      await harness.emitLifecycle("agent_settled");
      await waitForSentMessages(harness, 1);
      assert.equal(harness.sentMessages.length, 1);
      assert.match(harness.sentMessages[0]?.message.content ?? "", /Found the root cause/);
      assert.doesNotMatch(
        harness.sentMessages[0]?.message.content ?? "",
        /Starting read-only scout/,
      );
      assert.match(
        (await status()).content[0]?.text ?? "",
        /delivered to model queue; not yet consumed/,
      );

      // An aborted turn must not age out the still-unconsumed milestone either.
      await harness.emitLifecycle("agent_settled");
      assert.equal(harness.sentMessages.length, 2);
      persistSentIntercom(harness);
      await harness.emitLifecycle("agent_settled");
      assert.equal(harness.sentMessages.length, 2);
      assert.match((await status()).content[0]?.text ?? "", /Pending inbound messages: 0/);
    } finally {
      Date.now = realNow;
      await harness.emitLifecycle("session_shutdown");
      await cleanup();
    }
  },
);

test(
  "intercom tool validates passive and replace delivery options",
  { concurrency: false },
  async () => {
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const { cleanup } = await setupClients();
    const harness = await createExtensionHarness("planner", { hasUI: true });

    try {
      piIntercomExtension(harness.pi);
      await harness.emitLifecycle("session_start");
      const intercomTool = harness.tool("intercom");

      const passiveAsk = await intercomTool.execute(
        "delivery-passive-ask",
        {
          action: "ask",
          to: "nobody",
          message: "Can I ask passively?",
          delivery: "passive",
        },
        new AbortController().signal,
        undefined,
        harness.ctx,
      );
      assert.equal(passiveAsk.isError, true);
      const passiveAskText = textAt(passiveAsk.content);
      assert.match(passiveAskText, /delivery='passive' is only valid/);
      assert.match(passiveAskText, /normal send defaults to steer/);
      assert.match(
        passiveAskText,
        /ask with delivery='steer' only when the sender must stay alive and cannot safely continue without the reply/,
      );

      const replaceWithoutThread = await intercomTool.execute(
        "delivery-replace-no-thread",
        {
          action: "send",
          to: "nobody",
          message: "replace me",
          delivery: "queue",
          queueMode: "replace",
        },
        new AbortController().signal,
        undefined,
        harness.ctx,
      );
      assert.equal(replaceWithoutThread.isError, true);
      assert.match(textAt(replaceWithoutThread.content), /requires a non-empty threadId/);
      assert.equal(replaceWithoutThread.details?.reasonCode, "invalid_queue_arguments");
      const nextActions = records(replaceWithoutThread.details?.nextActions);
      assert.equal(record(nextActions[0]).action, "send");

      const queueModeWithoutQueue = await intercomTool.execute(
        "queue-mode-without-delivery",
        {
          action: "send",
          to: "nobody",
          message: "bad mode",
          queueMode: "stack",
        },
        new AbortController().signal,
        undefined,
        harness.ctx,
      );
      assert.equal(queueModeWithoutQueue.isError, true);
      assert.match(textAt(queueModeWithoutQueue.content), /only valid with delivery='queue'/);
      assert.equal(queueModeWithoutQueue.details?.reasonCode, "invalid_queue_arguments");

      const deliveryOnPending = await intercomTool.execute(
        "delivery-on-pending",
        {
          action: "pending",
          delivery: "queue",
        },
        new AbortController().signal,
        undefined,
        harness.ctx,
      );
      assert.equal(deliveryOnPending.isError, true);
      assert.match(
        textAt(deliveryOnPending.content),
        /only valid for action='send' or action='ask'/,
      );
      assert.equal(deliveryOnPending.details?.reasonCode, "invalid_queue_arguments");

      const deliveryFailure = await intercomTool.execute(
        "delivery-failure",
        {
          action: "send",
          to: "missing-fit7-recipient",
          message: "will fail",
        },
        new AbortController().signal,
        undefined,
        harness.ctx,
      );
      assert.equal(deliveryFailure.isError, true);
      assert.equal(record(deliveryFailure.details).reasonCode, "delivery_failed");
      assert.equal(typeof record(deliveryFailure.details).messageId, "string");
      assert.deepEqual(
        records(record(deliveryFailure.details).nextActions).map((next) => next.action),
        ["list", "send"],
      );

      const ambiguousTarget = await intercomTool.execute(
        "ambiguous-target",
        {
          action: "send",
          to: "planner",
          message: "target check",
        },
        new AbortController().signal,
        undefined,
        harness.ctx,
      );
      assert.equal(ambiguousTarget.isError, true);
      assert.match(textAt(ambiguousTarget.content), /matches multiple sessions/);
      assert.equal(record(ambiguousTarget.details).reasonCode, "ambiguous_target");
      assert.deepEqual(
        records(record(ambiguousTarget.details).nextActions).map((next) => next.action),
        ["list", "send"],
      );

      const noPendingReply = await intercomTool.execute(
        "reply-without-context",
        {
          action: "reply",
          message: "orphan reply",
        },
        new AbortController().signal,
        undefined,
        harness.ctx,
      );
      assert.equal(noPendingReply.isError, true);
      assert.match(textAt(noPendingReply.content), /No active intercom context/);
      assert.equal(record(noPendingReply.details).reasonCode, "no_pending_reply");
      assert.deepEqual(
        records(record(noPendingReply.details).nextActions).map((next) => next.action),
        ["pending", "send"],
      );
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await cleanup();
    }
  },
);

test(
  "intercom ask timeout exposes the original message id and recovery actions",
  { concurrency: false },
  async () => {
    const configPath = path.join(sharedAgentDir, "intercom", "config.json");
    const previousConfig = existsSync(configPath) ? readFileSync(configPath) : undefined;
    let cleanup: (() => Promise<void>) | undefined;
    let harness: Awaited<ReturnType<typeof createExtensionHarness>> | undefined;

    try {
      mkdirSync(path.dirname(configPath), { recursive: true });
      writeFileSync(configPath, JSON.stringify({ askTimeoutMs: 1000 }));
      const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
      const setup = await setupClients();
      cleanup = setup.cleanup;
      harness = await createExtensionHarness("timeout-reasons", { hasUI: true });
      piIntercomExtension(harness.pi);
      await harness.emitLifecycle("session_start");
      const intercomTool = harness.tool("intercom");
      const result = await intercomTool.execute(
        "timeout-ask",
        {
          action: "ask",
          to: requireText(setup.planner.sessionId),
          message: "Will time out",
        },
        new AbortController().signal,
        undefined,
        harness.ctx,
      );

      assert.equal(result.isError, true);
      assert.match(textAt(result.content), /No reply .* within 1 minute/);
      assert.equal(record(result.details).reasonCode, "reply_timeout");
      assert.equal(typeof record(result.details).messageId, "string");
      assert.deepEqual(
        records(record(result.details).nextActions).map((next) => next.action),
        ["status", "list", "send"],
      );
    } finally {
      if (harness) {
        await harness.emitLifecycle("session_shutdown");
      }
      await cleanup?.();
      if (previousConfig) {
        writeFileSync(configPath, previousConfig);
      } else {
        rmSync(configPath, { force: true });
      }
    }
  },
);

test(
  "busy interactive sessions request subagent detach before idle-gating supervisor asks",
  { concurrency: false },
  async () => {
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const { planner, cleanup } = await setupClients();
    let abortCount = 0;
    let idle = false;
    const detachRequests: string[] = [];
    const harness = await createExtensionHarness("interactive-supervisor", {
      abort: () => {
        abortCount += 1;
      },
      hasUI: true,
      isIdle: () => idle,
    });

    try {
      piIntercomExtension(harness.pi);
      harness.pi.events.on("pi-intercom:detach-request", (payload: unknown) => {
        const requestId = record(payload).requestId;
        if (typeof requestId !== "string") {
          return;
        }
        detachRequests.push(requestId);
        harness.pi.events.emit("pi-intercom:detach-response", { requestId, accepted: true });
      });
      await harness.emitLifecycle("session_start");

      const target = await waitForSessionByName(planner, "interactive-supervisor");
      const delivered = await planner.send(target.id, {
        messageId: "supervisor-busy-ask",
        text: [
          "Subagent needs a supervisor decision.",
          "Run: run-123",
          "Agent: scout",
          "Child index: 0",
          "Child intercom target: subagent-scout-run-123-1",
          "",
          "please reply with approve",
        ].join("\n"),
        expectsReply: true,
      });
      assert.equal(delivered.delivered, true);
      await sleep(250);
      assert.equal(abortCount, 0);
      assert.equal(detachRequests.length, 1);
      assert.equal(harness.sentMessages.length, 0);

      idle = true;
      await harness.emitLifecycle("agent_end");
      await harness.emitLifecycle("agent_settled");
      await sleep(20);

      assert.equal(abortCount, 0);
      assert.equal(harness.sentMessages.length, 1);
      assert.equal(harness.sentMessages[0]?.message.customType, "intercom_message");
      assert.equal(harness.sentMessages[0]?.options?.triggerTurn, true);
      assert.match(
        harness.sentMessages[0]?.message.content ?? "",
        /Subagent needs a supervisor decision/,
      );
      assert.match(harness.sentMessages[0]?.message.content ?? "", /please reply with approve/);
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await cleanup();
    }
  },
);

for (const hasUI of [true, false]) {
  test(
    `steered supervisor decisions and interviews detach before reaching a busy ${hasUI ? "interactive" : "headless"} parent`,
    { concurrency: false },
    async () => {
      const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
      const { planner, cleanup } = await setupClients();
      const detachRequests: string[] = [];
      const messagesSentBeforeDetach: number[] = [];
      const harness = await createExtensionHarness("supervisor-steer", {
        hasUI,
        isIdle: () => false,
      });

      try {
        piIntercomExtension(harness.pi);
        harness.pi.events.on("pi-intercom:detach-request", (payload: unknown) => {
          const requestId = record(payload).requestId;
          if (typeof requestId !== "string") {
            return;
          }
          detachRequests.push(requestId);
          messagesSentBeforeDetach.push(harness.sentMessages.length);
          harness.pi.events.emit("pi-intercom:detach-response", { requestId, accepted: true });
        });
        await harness.emitLifecycle("session_start");

        const target = await waitForSessionByName(planner, "supervisor-steer");
        const requests = [
          {
            messageId: "supervisor-steered-decision",
            heading: "Subagent needs a supervisor decision.",
            question: "Should I preserve the current API shape?",
          },
          {
            messageId: "supervisor-steered-interview",
            heading: "Subagent requests a structured supervisor interview.",
            question: "Which API and rollout policy should I use?",
          },
        ];
        for (const [index, request] of requests.entries()) {
          // Detach the preceding ask before admitting the next supervisor request.
          // oxlint-disable-next-line no-await-in-loop
          const delivered = await planner.send(target.id, {
            messageId: request.messageId,
            text: [
              request.heading,
              "Run: run-steer",
              "Agent: worker",
              "Child index: 0",
              "Child intercom target: subagent-worker-run-steer-1",
              "",
              request.question,
            ].join("\n"),
            expectsReply: true,
            delivery: "steer",
          });
          assert.equal(delivered.delivered, true);
          // Recipient publication, not a broker ack, establishes the next detach precondition.
          // oxlint-disable-next-line no-await-in-loop
          await waitForSentMessages(harness, index + 1);
        }

        assert.equal(detachRequests.length, 2);
        assert.deepEqual(messagesSentBeforeDetach, [0, 1]);
        assert.equal(harness.sentMessages.length, 2);
        assert.equal(harness.sentMessages[0]?.message.customType, "intercom_message");
        assert.equal(harness.sentMessages[0]?.options?.deliverAs, "steer");
        assert.equal(harness.sentMessages[1]?.options?.deliverAs, "steer");
        assert.match(
          harness.sentMessages[0]?.message.content ?? "",
          /Subagent needs a supervisor decision/,
        );
        assert.match(
          harness.sentMessages[1]?.message.content ?? "",
          /structured supervisor interview/,
        );
      } finally {
        await harness.emitLifecycle("session_shutdown");
        await cleanup();
      }
    },
  );
}

test(
  "shutdown cancels deferred startup and joins an already in-flight connection",
  { concurrency: false, timeout: 20_000 },
  async (t) => {
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const { planner, cleanup } = await setupClients();
    const harness = await createExtensionHarness("shutdown-before-start", { hasUI: true });
    const entered: PromiseWithResolvers<void> = Promise.withResolvers();
    const release: PromiseWithResolvers<void> = Promise.withResolvers();
    let connectSettled = false;
    let settledAtShutdown: boolean | undefined;
    let shutdown: Promise<unknown> | undefined;

    try {
      piIntercomExtension(harness.pi);
      await harness.emitLifecycle("session_start");
      await harness.emitLifecycle("session_shutdown");
      await sleep(50);

      const sessions = await planner.listSessions();
      assert.equal(
        sessions.some((session) => session.name === "shutdown-before-start"),
        false,
      );

      const originalConnect = captureClientMethod("connect");
      t.mock.method(
        IntercomClient.prototype,
        "connect",
        async function (
          this: InstanceType<typeof IntercomClient>,
          ...args: ReadonlyInput<Parameters<InstanceType<typeof IntercomClient>["connect"]>>
        ): Promise<void> {
          if (args[0].name === "shutdown-before-start") {
            entered.resolve();
            await release.promise;
          }
          await originalConnect(this, args);
          if (args[0].name === "shutdown-before-start") {
            connectSettled = true;
          }
        },
      );
      await harness.emitLifecycle("session_start");
      await entered.promise;
      shutdown = (async () => {
        await harness.emitLifecycle("session_shutdown");
        settledAtShutdown = connectSettled;
      })();
      release.resolve();
      await shutdown;
      assert.equal(
        settledAtShutdown,
        true,
        "The real connection must settle before the shutdown hook returns",
      );
      assert.equal(
        planner.isConnected(),
        true,
        "Shutdown must not stop a broker used by another client",
      );
      assert.equal(
        (await planner.listSessions()).some((session) => session.name === "shutdown-before-start"),
        false,
      );
    } finally {
      release.resolve();
      await shutdown;
      await harness.emitLifecycle("session_shutdown");
      await cleanup();
    }
  },
);

test("stale overlay work stops after same-session restart", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const { planner, cleanup } = await setupClients();
  let customCalls = 0;
  let resolveFirstCustom: (() => void) | undefined;
  const overlayTui = new TuiAltScreen(createTestTerminal());
  const custom: ExtensionContext["ui"]["custom"] = (factory) =>
    new Promise((resolve, reject) => {
      customCalls += 1;
      const mount = (component: Component) => {
        assert.ok(component.handleInput);
        const input = (data: string) => component.handleInput?.(data);
        if (customCalls > 1) {
          input("\x1b");
        } else {
          resolveFirstCustom = () => {
            input("\r");
          };
        }
      };
      const component = factory(overlayTui, renderTheme, new KeybindingsManager(), resolve);
      if (component instanceof Promise) {
        component.then(mount).catch(reject);
      } else {
        mount(component);
      }
    });
  const ui = {
    notify: () => {
      /* Notifications are not the stale-overlay contract. */
    },
    custom,
  };
  const harness = await createExtensionHarness("overlay-worker", { hasUI: true, ui });

  try {
    piIntercomExtension(harness.pi);
    await harness.emitLifecycle("session_start");
    await waitForSessionByName(planner, "overlay-worker");

    const overlayPromise = Promise.resolve(harness.command("intercom")("", harness.ctx));
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (resolveFirstCustom !== undefined) {
        break;
      }
      // Wait for the actual session picker factory to mount.
      // oxlint-disable-next-line no-await-in-loop
      await sleep(25);
    }
    assert.ok(resolveFirstCustom, "overlay should reach the session picker");

    await waitForSessionByName(planner, "planner");
    await harness.emitLifecycle("session_shutdown");
    await harness.emitLifecycle("session_start");
    resolveFirstCustom();
    await overlayPromise;

    assert.equal(customCalls, 1);
  } finally {
    await harness.emitLifecycle("session_shutdown");
    await cleanup();
  }
});

test(
  "resolved supervisor questions do not wake again from saved pending delivery",
  { concurrency: false },
  async () => {
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const { planner, cleanup } = await setupClients();
    let idle = false;
    const harness = await createExtensionHarness("resolved-question-worker", {
      hasUI: true,
      isIdle: () => idle,
    });
    try {
      piIntercomExtension(harness.pi);
      await harness.emitLifecycle("session_start");
      const target = await waitForSessionByName(planner, "resolved-question-worker");
      await planner.send(target.id, {
        messageId: "resolved-question",
        expectsReply: true,
        text: "Question ID: resolved-question\nChoose the native path?",
      });
      const intercom = harness.tool("intercom");
      const status = () =>
        intercom.execute(
          "resolved-status",
          { action: "status" },
          new AbortController().signal,
          undefined,
          harness.ctx,
        );
      assert.match((await status()).content[0]?.text ?? "", /Pending inbound messages: 1/);
      harness.pi.events.emit("subagent:supervisor-question-resolved", {
        questionId: "resolved-question",
      });
      assert.match((await status()).content[0]?.text ?? "", /Pending inbound messages: 0/);
      await harness.emitLifecycle("session_shutdown");
      idle = true;
      await harness.emitLifecycle("session_start");
      await sleep(250);
      assert.equal(harness.sentMessages.length, 0);
      assert.equal(
        (await planner.listSessions()).find((session) => session.id === target.id)?.pendingAsks,
        0,
      );
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await cleanup();
    }
  },
);

test("queued inbound callbacks do not run after shutdown", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const { planner, cleanup } = await setupClients();
  let idle = false;
  const harness = await createExtensionHarness("disposed-worker", {
    hasUI: true,
    isIdle: () => idle,
  });

  try {
    piIntercomExtension(harness.pi);
    await harness.emitLifecycle("session_start");
    const target = await waitForSessionByName(planner, "disposed-worker");

    const delivered = await planner.send(target.id, {
      messageId: "disposed-ask",
      text: "This should not deliver after shutdown.",
      expectsReply: true,
    });
    assert.equal(delivered.delivered, true);
    await sleep(50);
    assert.equal(harness.sentMessages.length, 0);

    await harness.emitLifecycle("session_shutdown");
    idle = true;
    await harness.emitLifecycle("agent_end");
    await harness.emitLifecycle("agent_settled");
    await sleep(250);

    assert.equal(harness.sentMessages.length, 0);
  } finally {
    await cleanup();
  }
});

test(
  "busy non-interactive sessions auto-reply to top-level asks without aborting",
  { concurrency: false },
  async () => {
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const { planner, cleanup } = await setupClients();
    let abortCount = 0;
    const harness = await createExtensionHarness("pipe-worker", {
      abort: () => {
        abortCount += 1;
      },
      hasUI: false,
      isIdle: () => false,
    });

    try {
      piIntercomExtension(harness.pi);
      await harness.emitLifecycle("session_start");

      const target = await waitForSessionByName(planner, "pipe-worker");
      await harness.emitLifecycle("agent_start");
      await harness.emitLifecycle("tool_execution_start", {
        toolCallId: "pipe-tool",
        toolName: "bash",
      });

      let unexpectedReply = false;
      const plainSendHandler = () => {
        unexpectedReply = true;
      };
      planner.on("message", plainSendHandler);
      const plainSend = await planner.send(target.id, {
        messageId: "pipe-mode-send",
        text: "FYI while busy.",
      });
      assert.equal(plainSend.delivered, true);
      await sleep(100);
      planner.off("message", plainSendHandler);
      assert.equal(unexpectedReply, false);
      assert.equal(harness.sentMessages.length, 1);
      assert.match(harness.sentMessages[0]?.message.content ?? "", /FYI while busy/);
      assert.equal(harness.sentMessages[0]?.options?.deliverAs, "steer");

      const oldReplaceSend = await planner.send(target.id, {
        messageId: "pipe-mode-replace-old",
        text: "Old replace while busy.",
        delivery: "queue",
        queueMode: "replace",
        threadId: "pipe-mode-thread",
      });
      assert.equal(oldReplaceSend.delivered, true);
      await sleep(1800);
      const replaceSend = await planner.send(target.id, {
        messageId: "pipe-mode-replace-new",
        text: "Latest replace while busy.",
        delivery: "queue",
        queueMode: "replace",
        threadId: "pipe-mode-thread",
      });
      assert.equal(replaceSend.delivered, true);
      await sleep(1800);
      assert.equal(harness.sentMessages.length, 1);
      await harness.emitLifecycle("tool_execution_end", {
        toolCallId: "pipe-tool",
        toolName: "bash",
      });
      await sleep(100);
      assert.equal(harness.sentMessages.length, 2);
      assert.match(harness.sentMessages[1]?.message.content ?? "", /Latest replace while busy/);
      assert.doesNotMatch(harness.sentMessages[1]?.message.content ?? "", /Old replace/);
      assert.equal(
        harness.sentMessages[1]?.options?.deliverAs,
        "steer",
        "the busy tool boundary queues the latest replacement without requesting a new turn",
      );

      const askId = "pipe-mode-ask";
      const replyPromise = waitForReply(planner, askId, 1000);
      const delivered = await planner.send(target.id, {
        messageId: askId,
        text: "Can you respond while busy?",
        expectsReply: true,
      });
      assert.equal(delivered.delivered, true);

      const reply = await replyPromise;
      assert.equal(reply.message.replyTo, askId);
      assert.match(reply.message.content.text, /non-interactive|cannot respond/i);
      assert.equal(abortCount, 0);
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await cleanup();
    }
  },
);

test("intercom tool advertises the steer-first coordination cutover", async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");

  await withChildOrchestratorEnv({}, async () => {
    const harness = await createExtensionHarness();
    piIntercomExtension(harness.pi);
    const intercomTool = harness.tool("intercom");
    const guidance = [
      intercomTool.description,
      intercomTool.promptSnippet,
      ...(intercomTool.promptGuidelines ?? []),
    ].join("\n");

    assert.match(guidance, /send defaults to (?:delivery=)?['"]?steer/i);
    assert.match(guidance, /queue only when delay is intentional/i);
    assert.match(guidance, /supplemental coordination within the active task/i);
    assert.match(guidance, /replace the task only when the message explicitly says so/i);
    assert.match(guidance, /blocking ask only when this process must stay alive/i);
    assert.doesNotMatch(guidance, /steer (?:is )?only for urgent/i);
  });
});

test("supervisor tool registers only when child metadata is present", async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");

  await withChildOrchestratorEnv({}, async () => {
    const harness = await createExtensionHarness();
    piIntercomExtension(harness.pi);
    assert.deepEqual(
      harness.tools.map((tool) => tool.name),
      ["load_intercom", "intercom"],
    );
  });

  await withChildOrchestratorEnv(
    {
      orchestratorTarget: "orchestrator",
      runId: "78f659a3",
      agent: "worker",
      index: "0",
      sessionName: "subagent-worker-78f659a3-1",
    },
    async () => {
      const harness = await createExtensionHarness();
      piIntercomExtension(harness.pi);
      assert.deepEqual(
        harness.tools.map((tool) => tool.name),
        ["contact_supervisor", "load_intercom", "intercom"],
      );
      const supervisorTool = harness.tools.find((tool) => tool.name === "contact_supervisor");
      assert.match(JSON.stringify(supervisorTool?.parameters), /interview_request/);
      assert.match(JSON.stringify(supervisorTool?.parameters), /questions/);
      const guidance = [
        supervisorTool?.description,
        supervisorTool?.promptSnippet,
        ...(supervisorTool?.promptGuidelines ?? []),
      ].join("\n");
      assert.match(guidance, /cannot safely continue/i);
      assert.match(guidance, /interview_request.*multiple structured answers/i);
      assert.match(guidance, /progress_update.*steers at the next tool boundary/is);
    },
  );
});

test(
  "subagent intercom session name env controls registered presence target",
  { concurrency: false },
  async () => {
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const { planner, cleanup } = await setupClients();

    try {
      await withChildOrchestratorEnv(
        {
          sessionName: "subagent-worker-78f659a3-1",
        },
        async () => {
          const harness = await createExtensionHarness("fallback-visible-name");
          piIntercomExtension(harness.pi);
          assert.deepEqual(
            harness.tools.map((tool) => tool.name),
            ["load_intercom", "intercom"],
          );
          await harness.emitLifecycle("session_start");

          const registered = await waitForSessionByName(planner, "subagent-worker-78f659a3-1");
          assert.equal(registered.name, "subagent-worker-78f659a3-1");
          assert.equal(
            (await planner.listSessions()).some(
              (session) => session.name === "fallback-visible-name",
            ),
            false,
          );
          await harness.emitLifecycle("session_shutdown");
        },
      );
    } finally {
      await cleanup();
    }
  },
);

test(
  "child supervisor tool resolves target and includes run metadata",
  { concurrency: false },
  async () => {
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const { orchestrator, cleanup } = await setupClients();

    try {
      await withChildOrchestratorEnv(
        {
          orchestratorTarget: "orchestrator",
          runId: "78f659a3",
          agent: "worker",
          index: "0",
          sessionName: "subagent-worker-78f659a3-1",
        },
        async () => {
          const harness = await createExtensionHarness("subagent-worker-78f659a3-1");
          piIntercomExtension(harness.pi);
          await harness.emitLifecycle("session_start");

          const supervisorTool = harness.tool("contact_supervisor");

          const askReceived = receiveMessage(orchestrator);
          const askResultPromise = supervisorTool.execute(
            "ask-1",
            { reason: "need_decision", message: "Which API should I use?" },
            new AbortController().signal,
            undefined,
            harness.ctx,
          );
          const [askFrom, askMessage] = await askReceived;
          assert.equal(askMessage.expectsReply, true);
          assert.equal(askMessage.delivery, "steer");
          assert.match(askMessage.content.text, /Subagent needs a supervisor decision/);
          assert.match(askMessage.content.text, /Run: 78f659a3/);
          assert.match(askMessage.content.text, /Agent: worker/);
          assert.match(askMessage.content.text, /Child index: 0/);
          assert.match(askMessage.content.text, /Which API should I use\?/);

          const question = listSupervisorQuestions("supervisor-session-test", "78f659a3").find(
            (entry) => entry.questionId === askMessage.id,
          )!;
          await orchestrator.send(askFrom.id, {
            text: "Recipient turn failed: temporary provider error",
            replyTo: askMessage.id,
            attachments: [
              {
                type: "context",
                name: "pi-intercom-recipient-turn-failure",
                content: "temporary provider error",
              },
            ],
          });
          assert.equal(
            await Promise.race([askResultPromise.then(() => "settled"), sleep(50, "waiting")]),
            "waiting",
          );
          assert.equal(readQuestionState(question).state, "awaiting_input");
          assert.equal(readQuestionState(question).answer, undefined);
          const reply = await orchestrator.send(askFrom.id, {
            text: "Use the stable API.",
            replyTo: askMessage.id,
          });
          assert.equal(reply.delivered, true);
          const askResult = await askResultPromise;
          assert.equal(askResult.isError, false);
          assert.match(textAt(askResult.content), /Use the stable API/);

          const updateReceived = receiveMessage(orchestrator);
          const updateResult = await supervisorTool.execute(
            "update-1",
            { reason: "progress_update", message: "Found a schema mismatch." },
            new AbortController().signal,
            undefined,
            harness.ctx,
          );
          const [_updateFrom, updateMessage] = await updateReceived;
          assert.equal(updateMessage.expectsReply, undefined);
          assert.equal(updateMessage.delivery, "steer");
          assert.equal(updateMessage.queueMode, undefined);
          assert.equal(updateMessage.threadId, undefined);
          assert.match(updateMessage.content.text, /Subagent progress update/);
          assert.match(updateMessage.content.text, /Run: 78f659a3/);
          assert.match(updateMessage.content.text, /Agent: worker/);
          assert.match(updateMessage.content.text, /Found a schema mismatch/);
          assert.equal(updateResult.isError, false);

          const interviewReceived = receiveMessage(orchestrator);
          const interview = {
            title: "API migration choices",
            description: "Choose the implementation path before edits continue.",
            questions: [
              {
                id: "context",
                type: "info",
                question: "Migration context",
                context: "Use the existing auth boundary.",
              },
              {
                id: "api",
                type: "single",
                question: "Which API should I target?",
                options: [" Stable API ", "Experimental API"],
              },
              { id: "notes", type: "text", question: "Any constraints to preserve?" },
            ],
          };
          const interviewResultPromise = supervisorTool.execute(
            "interview-1",
            {
              reason: "interview_request",
              message: "Please answer both so I can continue safely.",
              interview,
            },
            new AbortController().signal,
            undefined,
            harness.ctx,
          );
          const [interviewFrom, interviewMessage] = await interviewReceived;
          assert.equal(interviewMessage.expectsReply, true);
          assert.equal(interviewMessage.delivery, "steer");
          assert.match(
            interviewMessage.content.text,
            /Subagent requests a structured supervisor interview/,
          );
          assert.match(interviewMessage.content.text, /Interview: API migration choices/);
          assert.match(interviewMessage.content.text, /\[context\] \(info\) Migration context/);
          assert.match(interviewMessage.content.text, /Info questions are context-only/);
          assert.match(
            interviewMessage.content.text,
            /\[api\] \(single\) Which API should I target\?/,
          );
          assert.match(interviewMessage.content.text, /   - Stable API/);
          assert.match(
            interviewMessage.content.text,
            /\[notes\] \(text\) Any constraints to preserve\?/,
          );
          assert.match(interviewMessage.content.text, /"responses"/);
          assert.doesNotMatch(interviewMessage.content.text, /"id": "context"/);

          const structuredReply = {
            responses: [
              { id: "api", value: "Stable API" },
              { id: "notes", value: "Keep the public error shape unchanged." },
            ],
          };
          const interviewReply = await orchestrator.send(interviewFrom.id, {
            text: `\`\`\`json\n${JSON.stringify(structuredReply, null, 2)}\n\`\`\``,
            replyTo: interviewMessage.id,
          });
          assert.equal(interviewReply.delivered, true);
          const interviewResult = await interviewResultPromise;
          assert.equal(interviewResult.isError, false);
          assert.match(textAt(interviewResult.content), /Stable API/);
          assert.deepEqual(interviewResult.details?.structuredReply, structuredReply);

          const invalidReplyReceived = receiveMessage(orchestrator);
          const invalidReplyResultPromise = supervisorTool.execute(
            "interview-invalid-reply",
            {
              reason: "interview_request",
              interview,
            },
            new AbortController().signal,
            undefined,
            harness.ctx,
          );
          const [invalidReplyFrom, invalidReplyMessage] = await invalidReplyReceived;
          const invalidReply = await orchestrator.send(invalidReplyFrom.id, {
            text: '{"responses":[{"id":"api","value":"Removed API"}]}',
            replyTo: invalidReplyMessage.id,
          });
          assert.equal(invalidReply.delivered, true);
          const invalidReplyResult = await invalidReplyResultPromise;
          assert.equal(invalidReplyResult.isError, false);
          assert.equal(invalidReplyResult.details?.structuredReply, undefined);
          assert.match(
            requireText(invalidReplyResult.details?.structuredReplyParseError),
            /must match one of the question options/,
          );

          await harness.emitLifecycle("session_shutdown");
        },
      );
    } finally {
      await cleanup();
    }
  },
);

async function waitForIntercomEntry(
  harness: { readonly entries: readonly { readonly type: string; readonly data: unknown }[] },
  type: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const foundEntry = harness.entries.find((candidate) => candidate.type === type);
    if (foundEntry) {
      return record(foundEntry.data);
    }
    // Observe the journal entry before backing off for the next publication poll.
    // oxlint-disable-next-line no-await-in-loop
    await sleep(20);
  }
  throw new Error(`Timed out waiting for ${type}`);
}

for (const unavailable of ["offline", "lookup-error"] as const) {
  test(
    `supervisor notification bounds retry logs and recovers after ${unavailable}`,
    { concurrency: false },
    async (t) => {
      const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
      const { planner, orchestrator, cleanup } = await setupClients();
      let failures = 0;
      let failLookup = unavailable === "lookup-error";
      const originalSend = captureClientMethod("send");
      t.mock.method(
        IntercomClient.prototype,
        "send",
        async function (
          this: InstanceType<typeof IntercomClient>,
          to: string,
          options: Parameters<InstanceType<typeof IntercomClient>["send"]>[1],
        ): ReturnType<InstanceType<typeof IntercomClient>["send"]> {
          const result = observedSendResult(await originalSend(this, [to, options]));
          if (options.expectsReply === true && !result.accepted) {
            failures += 1;
          }
          return result;
        },
      );
      try {
        if (unavailable === "offline") {
          await orchestrator.disconnect();
        }
        await withChildOrchestratorEnv(
          {
            orchestratorTarget: "orchestrator",
            runId: `retry-${unavailable}`,
            agent: "worker",
            index: "0",
          },
          async () => {
            const harness = await createExtensionHarness(`retry-${unavailable}-child`);
            piIntercomExtension(harness.pi);
            await harness.emitLifecycle("session_start");
            if (failLookup) {
              const child = await waitForSessionByName(planner, `retry-${unavailable}-child`);
              const originalList = captureClientMethod("listSessions");
              t.mock.method(
                IntercomClient.prototype,
                "listSessions",
                async function (
                  this: InstanceType<typeof IntercomClient>,
                ): ReturnType<InstanceType<typeof IntercomClient>["listSessions"]> {
                  if (failLookup && this.sessionId === child.id) {
                    failures += 1;
                    return Promise.reject(new Error("Temporary session lookup failure"));
                  }
                  return array(await originalList(this, [])).map((value) => {
                    const session = normalizeSessionInfo(value);
                    assertDefined(session);
                    return session;
                  });
                },
              );
            }
            const controller = new AbortController();
            const waiting = harness.tool("contact_supervisor").execute(
              "retry",
              {
                reason: "need_decision",
                message: "Which API?",
              },
              controller.signal,
              undefined,
              harness.ctx,
            );
            const received: ReadonlyInput<Message>[] = [];
            orchestrator.on(
              "message",
              (_from: ReadonlyInput<SessionInfo>, message: ReadonlyInput<Message>) => {
                received.push(message);
              },
            );
            try {
              const diagnosticType = failLookup
                ? "intercom_question_notification_error"
                : "intercom_sent";
              const rejected = await waitForIntercomEntry(harness, diagnosticType);
              if (!failLookup) {
                assert.equal(rejected.accepted, false);
              }
              const deadline = Date.now() + 5000;
              while (true) {
                if (failures >= 3) {
                  break;
                }
                assert.ok(
                  Date.now() < deadline,
                  "notification must keep retrying while unavailable",
                );
                // Observe actual failed attempts before checking bounded journal writes.
                // oxlint-disable-next-line no-await-in-loop
                await sleep(20);
              }
              assert.equal(
                harness.entries.filter((entry) => entry.type === diagnosticType).length,
                1,
              );
              const notification = receiveMessage(orchestrator, {
                signal: AbortSignal.timeout(5000),
              });
              if (unavailable === "offline") {
                await connectClient(orchestrator, "orchestrator");
              } else {
                failLookup = false;
              }
              const [from, message] = await notification;
              assert.equal(message.id, rejected.messageId ?? rejected.questionId);
              assert.equal(message.delivery, "steer");
              assert.equal(message.expectsReply, true);
              // Acceptance stops retrying even while the supervisor is still deciding.
              await sleep(1300);
              assert.equal(received.length, 1);
              const receipts = harness.entries.filter((entry) => entry.type === "intercom_sent");
              assert.equal(receipts.length, unavailable === "lookup-error" ? 1 : 2);
              assert.equal(record(record(receipts.at(-1)).data).accepted, true);
              await orchestrator.send(from.id, {
                text: "Use the stable API.",
                replyTo: message.id,
              });
              assert.equal((await waiting).isError, false);
            } finally {
              controller.abort();
              await waiting;
              await harness.emitLifecycle("session_shutdown");
            }
          },
        );
      } finally {
        await cleanup();
      }
    },
  );
}

for (const finish of ["abort", "saved-answer", "shutdown"] as const) {
  test(
    `rejected supervisor notification stops retrying after ${finish}`,
    { concurrency: false },
    async () => {
      const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
      const { orchestrator, cleanup } = await setupClients();
      await orchestrator.disconnect();
      try {
        await withChildOrchestratorEnv(
          {
            orchestratorTarget: "orchestrator",
            runId: `retry-stop-${finish}`,
            agent: "worker",
            index: "0",
          },
          async () => {
            const harness = await createExtensionHarness(`retry-stop-${finish}-child`);
            piIntercomExtension(harness.pi);
            await harness.emitLifecycle("session_start");
            const controller = new AbortController();
            const waiting = harness.tool("contact_supervisor").execute(
              "retry-stop",
              {
                reason: "need_decision",
                message: "Which API?",
              },
              controller.signal,
              undefined,
              harness.ctx,
            );
            const received: ReadonlyInput<Message>[] = [];
            orchestrator.on(
              "message",
              (_from: ReadonlyInput<SessionInfo>, message: ReadonlyInput<Message>) => {
                received.push(message);
              },
            );
            try {
              const rejected = await waitForIntercomEntry(harness, "intercom_sent");
              assert.equal(rejected.accepted, false);
              if (finish === "abort") {
                controller.abort();
              } else if (finish === "shutdown") {
                await harness.emitLifecycle("session_shutdown");
              } else {
                const question = listSupervisorQuestions(
                  "supervisor-session-test",
                  `retry-stop-${finish}`,
                ).find((candidate) => candidate.questionId === rejected.messageId);
                assertDefined(question);
                saveQuestionAnswer(question, "Use the stable API.");
              }
              assert.equal((await waiting).isError, finish !== "saved-answer");
              await connectClient(orchestrator, "orchestrator");
              await sleep(1300);
              assert.equal(received.length, 0);
              assert.equal(
                harness.entries.filter((entry) => entry.type === "intercom_sent").length,
                1,
              );
            } finally {
              controller.abort();
              await waiting;
              await harness.emitLifecycle("session_shutdown");
            }
          },
        );
      } finally {
        await cleanup();
      }
    },
  );
}

test(
  "supervisor notification does not replay an uncertain send",
  { concurrency: false },
  async (t) => {
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const { orchestrator, cleanup } = await setupClients();
    let attempts = 0;
    const originalSend = captureClientMethod("send");
    t.mock.method(
      IntercomClient.prototype,
      "send",
      async function (
        this: InstanceType<typeof IntercomClient>,
        to: string,
        options: Parameters<InstanceType<typeof IntercomClient>["send"]>[1],
      ): ReturnType<InstanceType<typeof IntercomClient>["send"]> {
        const result = observedSendResult(await originalSend(this, [to, options]));
        if (options.expectsReply === true) {
          attempts += 1;
          throw new Error("Delivery acknowledgement lost after dispatch");
        }
        return result;
      },
    );
    try {
      await withChildOrchestratorEnv(
        {
          orchestratorTarget: "orchestrator",
          runId: "uncertain-notification",
          agent: "worker",
          index: "0",
        },
        async () => {
          const harness = await createExtensionHarness("uncertain-notification-child");
          piIntercomExtension(harness.pi);
          await harness.emitLifecycle("session_start");
          const controller = new AbortController();
          const notification = receiveMessage(orchestrator, { signal: AbortSignal.timeout(5000) });
          const waiting = harness.tool("contact_supervisor").execute(
            "uncertain",
            {
              reason: "need_decision",
              message: "Which API?",
            },
            controller.signal,
            undefined,
            harness.ctx,
          );
          try {
            const [, message] = await notification;
            await waitForIntercomEntry(harness, "intercom_question_notification_error");
            await sleep(1300);
            assert.equal(attempts, 1);
            const question = listSupervisorQuestions(
              "supervisor-session-test",
              "uncertain-notification",
            ).find((candidate) => candidate.questionId === message.id);
            assertDefined(question);
            assert.equal(question.state, "awaiting_input");
            saveQuestionAnswer(question, "Use the stable API.");
            assert.equal((await waiting).isError, false);
          } finally {
            controller.abort();
            await waiting;
            await harness.emitLifecycle("session_shutdown");
          }
        },
      );
    } finally {
      await cleanup();
    }
  },
);

test(
  "supervisor provider failure preserves the pending question for a real reply",
  { concurrency: false },
  async () => {
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const { planner, cleanup } = await setupClients();
    const parent = await createExtensionHarness("provider-error-parent", { hasUI: true });
    piIntercomExtension(parent.pi);
    await parent.emitLifecycle("session_start");
    await waitForSessionByName(planner, "provider-error-parent");
    try {
      await withChildOrchestratorEnv(
        {
          orchestratorTarget: "provider-error-parent",
          runId: "provider-error-question",
          agent: "worker",
          index: "0",
        },
        async () => {
          const child = await createExtensionHarness("provider-error-child");
          piIntercomExtension(child.pi);
          await child.emitLifecycle("session_start");
          const controller = new AbortController();
          const waiting = child.tool("contact_supervisor").execute(
            "provider-error",
            {
              reason: "need_decision",
              message: "Which API?",
            },
            controller.signal,
            undefined,
            child.ctx,
          );
          try {
            await waitForSentMessages(parent, 1);
            const questionId = requireText(
              record(record(parent.sentMessages[0].message.details).message).id,
            );
            persistSentIntercom(parent);
            await parent.emitLifecycle("message_end", { message: parent.sentMessages[0].message });
            await parent.emitLifecycle("agent_start");
            await parent.emitLifecycle("turn_start");
            await parent.emitLifecycle("message_end", {
              message: {
                role: "assistant",
                stopReason: "error",
                errorMessage: "Temporary provider 503",
              },
            });
            await parent.emitLifecycle("turn_end");
            await parent.emitLifecycle("agent_settled");
            await waitForIntercomEntry(child, "intercom_question_notification_error");
            const question = listSupervisorQuestions(
              "supervisor-session-test",
              "provider-error-question",
            ).find((candidate) => candidate.questionId === questionId);
            assertDefined(question);
            assert.equal(question.state, "awaiting_input");
            assert.equal(question.answer, undefined);
            const tool = parent.tool("intercom");
            const pending = await tool.execute(
              "pending",
              { action: "pending" },
              controller.signal,
              undefined,
              parent.ctx,
            );
            assert.match(textAt(pending.content), new RegExp(questionId));
            const reply = await tool.execute(
              "reply",
              { action: "reply", replyTo: questionId, message: "Use the stable API." },
              controller.signal,
              undefined,
              parent.ctx,
            );
            assert.equal(reply.isError, false);
            assert.equal((await waiting).isError, false);
            assert.equal(readQuestionState(question).answer?.message, "Use the stable API.");
            const after = await tool.execute(
              "after",
              { action: "pending" },
              controller.signal,
              undefined,
              parent.ctx,
            );
            assert.doesNotMatch(textAt(after.content), new RegExp(questionId));
          } finally {
            controller.abort();
            await waiting;
            await child.emitLifecycle("session_shutdown");
          }
        },
      );
    } finally {
      await parent.emitLifecycle("session_shutdown");
      await cleanup();
    }
  },
);

test(
  "contact supervisor survives supervisor disconnect and the ordinary ask timeout",
  { concurrency: false },
  async () => {
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const { orchestrator, cleanup } = await setupClients();

    try {
      await withChildOrchestratorEnv(
        {
          orchestratorTarget: "orchestrator",
          runId: "78f659a3",
          agent: "worker",
          index: "0",
        },
        async () => {
          const configPath = path.join(sharedAgentDir, "intercom", "config.json");
          mkdirSync(path.dirname(configPath), { recursive: true });
          writeFileSync(configPath, JSON.stringify({ askTimeoutMs: 1000 }));
          const harness = await createExtensionHarness("subagent-disconnect-worker");
          piIntercomExtension(harness.pi);
          rmSync(configPath);
          await harness.emitLifecycle("session_start");
          const supervisorTool = harness.tool("contact_supervisor");
          const askReceived = receiveMessage(orchestrator);
          const resultPromise = supervisorTool.execute(
            "ask-disconnect",
            { reason: "need_decision", message: "Which path?" },
            new AbortController().signal,
            undefined,
            harness.ctx,
          );
          const [, request] = await askReceived;
          const question = listSupervisorQuestions("supervisor-session-test", "78f659a3").find(
            (item) => item.questionId === request.id,
          );
          assert.ok(question, "question must already be on disk when notification arrives");
          assert.equal(question.state, "awaiting_input");
          await orchestrator.disconnect();
          assert.equal(
            await Promise.race([resultPromise.then(() => "settled"), sleep(1150, "waiting")]),
            "waiting",
          );
          saveQuestionAnswer(question, "Keep the existing API.");
          const result = await resultPromise;
          assert.equal(result.isError, false);
          assert.match(textAt(result.content), /Keep the existing API/);
          assert.equal(readQuestionState(question).state, "answered");
          await harness.emitLifecycle("session_shutdown");
        },
      );
    } finally {
      await orchestrator.disconnect();
      await cleanup();
    }
  },
);

test("child supervisor tool throws for execution errors so Pi marks failures", async () => {
  await withChildOrchestratorEnv(
    {
      orchestratorTarget: "orchestrator",
      runId: "run-error-semantics",
      agent: "worker",
      index: "0",
    },
    async () => {
      const harness = await createExtensionHarness("child-error-semantics", {
        wrapToolErrors: false,
      });
      const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
      piIntercomExtension(harness.pi);
      const supervisorTool = harness.tool("contact_supervisor");

      await assert.rejects(
        supervisorTool.execute(
          "invalid-raw",
          { reason: "done", message: "Finished." },
          new AbortController().signal,
          undefined,
          harness.ctx,
        ),
        /Invalid reason/,
      );
    },
  );
});

test("child supervisor tool rejects invalid reasons and interview payloads", async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");

  await withChildOrchestratorEnv(
    {
      orchestratorTarget: "orchestrator",
      runId: "78f659a3",
      agent: "worker",
      index: "0",
    },
    async () => {
      const harness = await createExtensionHarness();
      piIntercomExtension(harness.pi);
      const supervisorTool = harness.tool("contact_supervisor");
      const result = await supervisorTool.execute(
        "invalid-1",
        { reason: "done", message: "Finished." },
        new AbortController().signal,
        undefined,
        harness.ctx,
      );
      assert.equal(result.isError, true);
      assert.match(textAt(result.content), /Invalid reason/);

      const missingMessageResult = await supervisorTool.execute(
        "invalid-message",
        { reason: "need_decision" },
        new AbortController().signal,
        undefined,
        harness.ctx,
      );
      assert.equal(missingMessageResult.isError, true);
      assert.match(textAt(missingMessageResult.content), /Missing 'message'/);

      const invalidInterviewResult = await supervisorTool.execute(
        "invalid-interview",
        { reason: "interview_request", interview: { title: "Bad" } },
        new AbortController().signal,
        undefined,
        harness.ctx,
      );
      assert.equal(invalidInterviewResult.isError, true);
      assert.match(
        textAt(invalidInterviewResult.content),
        /interview\.questions must be a non-empty array/,
      );

      const invalidInfoOptionsResult = await supervisorTool.execute(
        "invalid-info-options",
        {
          reason: "interview_request",
          interview: {
            questions: [
              { id: "context", type: "info", question: "Context", options: ["Not an answer"] },
            ],
          },
        },
        new AbortController().signal,
        undefined,
        harness.ctx,
      );
      assert.equal(invalidInfoOptionsResult.isError, true);
      assert.match(
        textAt(invalidInfoOptionsResult.content),
        /options is only valid for single and multi questions/,
      );
    },
  );
});

test(
  "child supervisor tool preserves delivery failure reasons",
  { concurrency: false },
  async () => {
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const { cleanup } = await setupClients();

    try {
      await withChildOrchestratorEnv(
        {
          orchestratorTarget: "missing-orchestrator",
          runId: "78f659a3",
          agent: "worker",
          index: "0",
        },
        async () => {
          const harness = await createExtensionHarness();
          piIntercomExtension(harness.pi);
          await harness.emitLifecycle("session_start");
          const supervisorTool = harness.tool("contact_supervisor");
          const updateResult = await supervisorTool.execute(
            "update-1",
            { reason: "progress_update", message: "Blocked." },
            new AbortController().signal,
            undefined,
            harness.ctx,
          );
          assert.equal(updateResult.isError, true);
          assert.match(textAt(updateResult.content), /Session not found/);
          assert.equal(updateResult.details?.reason, "Session not found");

          const controller = new AbortController();
          const askResult = supervisorTool.execute(
            "ask-1",
            { reason: "need_decision", message: "Which path?" },
            controller.signal,
            undefined,
            harness.ctx,
          );
          assert.equal(
            await Promise.race([askResult.then(() => "settled"), sleep(100, "waiting")]),
            "waiting",
          );
          const question = listSupervisorQuestions("supervisor-session-test", "78f659a3").findLast(
            (item) => item.state === "awaiting_input",
          );
          assertDefined(question);
          controller.abort();
          assert.match((await askResult).content[0]?.text ?? "", /Cancelled/);
          assert.equal(readQuestionState(question).state, "cancelled");
          await harness.emitLifecycle("session_shutdown");
        },
      );
    } finally {
      await cleanup();
    }
  },
);

test(
  "durable cancellation aborts the child agent, not only its question tool",
  { concurrency: false },
  async () => {
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const { orchestrator, cleanup } = await setupClients();
    try {
      await withChildOrchestratorEnv(
        { orchestratorTarget: "orchestrator", runId: "durable-stop", agent: "worker", index: "0" },
        async () => {
          const controller = new AbortController();
          let aborted = false;
          const harness = await createExtensionHarness("durable-stop-child", {
            abort: () => {
              aborted = true;
              controller.abort();
            },
          });
          piIntercomExtension(harness.pi);
          await harness.emitLifecycle("session_start");
          const incoming = receiveMessage(orchestrator);
          const waiting = harness
            .tool("contact_supervisor")
            .execute(
              "stop-question",
              { reason: "need_decision", message: "Continue?" },
              controller.signal,
              undefined,
              harness.ctx,
            );
          const [, message] = await incoming;
          const question = listSupervisorQuestions("supervisor-session-test", "durable-stop").find(
            (item) => item.questionId === message.id,
          );
          assertDefined(question);
          cancelSupervisorQuestion(question);
          try {
            assert.match((await waiting).content[0]?.text ?? "", /Cancelled/);
            assert.equal(aborted, true);
            assert.equal(controller.signal.aborted, true);
          } finally {
            await harness.emitLifecycle("session_shutdown");
          }
        },
      );
    } finally {
      await cleanup();
    }
  },
);

test(
  "child supervisor tool clears reply waiter when cancelled",
  { concurrency: false },
  async () => {
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const { orchestrator, cleanup } = await setupClients();

    try {
      await withChildOrchestratorEnv(
        {
          orchestratorTarget: "orchestrator",
          runId: "78f659a3",
          agent: "worker",
          index: "0",
          sessionName: "subagent-worker-78f659a3-1",
        },
        async () => {
          const harness = await createExtensionHarness("subagent-worker-78f659a3-1");
          piIntercomExtension(harness.pi);
          await harness.emitLifecycle("session_start");
          const supervisorTool = harness.tool("contact_supervisor");

          const controller = new AbortController();
          const cancelledMessage = receiveMessage(orchestrator);
          const cancelledResultPromise = supervisorTool.execute(
            "ask-cancelled",
            { reason: "need_decision", message: "Should I continue?" },
            controller.signal,
            undefined,
            harness.ctx,
          );
          await cancelledMessage;
          controller.abort();
          const cancelledResult = await cancelledResultPromise;
          assert.equal(cancelledResult.isError, true);
          assert.match(textAt(cancelledResult.content), /Cancelled/);

          const nextMessage = receiveMessage(orchestrator);
          const nextResultPromise = supervisorTool.execute(
            "ask-next",
            { reason: "need_decision", message: "Can I ask again?" },
            new AbortController().signal,
            undefined,
            harness.ctx,
          );
          const [from, message] = await nextMessage;
          assert.match(message.content.text, /Can I ask again/);
          const reply = await orchestrator.send(from.id, { text: "Yes.", replyTo: message.id });
          assert.equal(reply.delivered, true);
          const nextResult = await nextResultPromise;
          assert.equal(nextResult.isError, false);
          assert.match(textAt(nextResult.content), /Yes\./);
          await harness.emitLifecycle("session_shutdown");
        },
      );
    } finally {
      await cleanup();
    }
  },
);

test(
  "full ask/reply round-trip works with reply target resolved from current turn context",
  { concurrency: false },
  async () => {
    const { planner, orchestrator, cleanup } = await setupClients();
    const replyTracker = new ReplyTracker();

    try {
      const askId = "ask-current-turn";
      const askPromise = receiveMessage(orchestrator);
      const replyPromise = waitForReply(planner, askId);

      const delivered = await planner.send(requireText(orchestrator.sessionId), {
        messageId: askId,
        text: "What should I do next?",
        expectsReply: true,
      });
      assert.equal(delivered.delivered, true);

      const [from, message] = await askPromise;
      const context = replyTracker.recordIncomingMessage(from, message, Date.now());
      replyTracker.queueTurnContext(context);
      replyTracker.beginTurn(Date.now());

      const target = replyTracker.resolveReplyTarget({}, Date.now());
      const sent = await orchestrator.send(target.from.id, {
        text: "Ship it.",
        replyTo: target.message.id,
      });
      assert.equal(sent.delivered, true);
      replyTracker.markReplied(target.message.id);

      const reply = await replyPromise;
      assert.equal(reply.message.content.text, "Ship it.");
      assert.equal(reply.message.replyTo, askId);
      assert.equal(reply.message.delivery, "steer");
      assert.deepEqual(replyTracker.listPending(Date.now()), []);
    } finally {
      await cleanup();
    }
  },
);

test("pending output expands subagent supervisor asks", { concurrency: false }, async () => {
  const { planner, cleanup } = await setupClients();
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const harness = await createExtensionHarness("pending-worker", { hasUI: true });

  try {
    piIntercomExtension(harness.pi);
    await harness.emitLifecycle("session_start");
    const target = await waitForSessionByName(planner, "pending-worker");

    await planner.send(target.id, {
      messageId: "supervisor-pending-ask",
      text: [
        "Subagent needs a supervisor decision.",
        "Run: 78f659a3",
        "Agent: worker",
        "Child index: 0",
        "Child intercom target: subagent-worker-78f659a3-1",
        "",
        "Should I use the stable API or experimental API?",
      ].join("\n"),
      expectsReply: true,
    });
    await nextTurn();

    const intercomTool = harness.tool("intercom");
    const result = await intercomTool.execute(
      "pending-supervisor",
      {
        action: "pending",
      },
      new AbortController().signal,
      undefined,
      harness.ctx,
    );

    const text = textAt(result.content);
    assert.match(text, /replyTo: "supervisor-pending-ask"/);
    assert.match(
      text,
      /intercom\(\{ action: "reply", replyTo: "supervisor-pending-ask", message: "\.\.\." \}\)/,
    );
    assert.match(text, /supervisor decision/);
    assert.match(text, /run=78f659a3/);
    assert.match(text, /agent=worker/);
    assert.match(text, /target=subagent-worker-78f659a3-1/);
    assert.match(text, /question=Should I use the stable API or experimental API\?/);
  } finally {
    await harness.emitLifecycle("session_shutdown");
    await cleanup();
  }
});

test(
  "subagent identity event exposes only the current connected broker session id",
  { concurrency: false },
  async () => {
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const { planner, cleanup } = await setupClients();
    const harness = await createExtensionHarness("planner", { hasUI: true });
    const responses: Readonly<Record<string, unknown>>[] = [];
    harness.pi.events.on("subagent:intercom-identity-response", (payload: unknown) => {
      responses.push(record(payload));
    });

    try {
      piIntercomExtension(harness.pi);
      harness.pi.events.emit("subagent:intercom-identity-request", { requestId: "before-connect" });
      assert.equal(responses.length, 0);

      await harness.emitLifecycle("session_start");
      const intercomTool = harness.tool("intercom");
      await intercomTool.execute(
        "connect",
        { action: "status" },
        new AbortController().signal,
        undefined,
        harness.ctx,
      );
      harness.pi.events.emit("subagent:intercom-identity-request", { requestId: "connected" });

      assert.equal(responses.length, 1);
      assert.equal(responses[0]?.requestId, "connected");
      assert.equal(typeof responses[0]?.sessionId, "string");
      assert.notEqual(
        responses[0]?.sessionId,
        planner.sessionId,
        "duplicate visible names retain distinct exact identities",
      );
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await cleanup();
    }
  },
);

test("subagent control intercom events wake the current orchestrator session", async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const harness = await createExtensionHarness("orchestrator");
  const { sentMessages } = harness;

  piIntercomExtension(harness.pi);
  harness.pi.events.emit("subagent:control-intercom", {
    to: "orchestrator",
    message: "subagent needs attention\n\nworker needs attention in run 78f659a3.",
  });
  await nextTurn();

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0]?.message.customType, "intercom_message");
  assert.match(sentMessages[0]?.message.content ?? "", /From subagent-control/);
  assert.match(sentMessages[0]?.message.content ?? "", /worker needs attention in run 78f659a3/);
  assert.equal(sentMessages[0]?.options?.triggerTurn, true);

  sentMessages.length = 0;
  harness.pi.events.emit("subagent:control-intercom", {
    to: "orchestrator",
    source: "foreground",
    message: "subagent needs attention\n\nworker needs attention in run 78f659a3.",
  });
  await nextTurn();

  assert.deepEqual(sentMessages, []);

  harness.pi.events.emit("subagent:control-intercom", {
    to: "orchestrator",
    source: "async",
    message: "subagent needs attention\n\nworker needs attention in run async-1.",
  });
  await nextTurn();

  assert.deepEqual(sentMessages, []);
});

test("async subagent result intercom events wake the current orchestrator session", async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const harness = await createExtensionHarness("orchestrator");
  const { sentMessages } = harness;
  const deliveryAcks: unknown[] = [];
  harness.pi.events.on("subagent:result-intercom-delivery", (payload: unknown) => {
    deliveryAcks.push(payload);
  });

  piIntercomExtension(harness.pi);
  harness.pi.events.emit("subagent:result-intercom", {
    to: "orchestrator",
    requestId: "result-1",
    source: "async",
    message: "subagent result\n\nRun: 78f659a3\nAgent: worker\nStatus: completed",
  });
  await nextTurn();

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0]?.message.customType, "intercom_message");
  assert.match(sentMessages[0]?.message.content ?? "", /From subagent-result/);
  assert.match(sentMessages[0]?.message.content ?? "", /Status: completed/);
  assert.equal(sentMessages[0]?.options?.triggerTurn, true);
  assert.deepEqual(deliveryAcks, [{ requestId: "result-1", delivered: true }]);
});

test("foreground subagent result intercom events reach the current orchestrator before acknowledgment", async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const harness = await createExtensionHarness("orchestrator");
  const { sentMessages } = harness;
  const deliveryAcks: unknown[] = [];
  harness.pi.events.on("subagent:result-intercom-delivery", (payload: unknown) => {
    deliveryAcks.push(payload);
  });

  piIntercomExtension(harness.pi);
  harness.pi.events.emit("subagent:result-intercom", {
    to: "orchestrator",
    requestId: "result-foreground",
    source: "foreground",
    message: "subagent result\n\nRun: c0cefc68\nMode: chain\nStatus: completed",
  });
  await nextTurn();

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0]?.message.content ?? "", /Run: c0cefc68/);
  assert.equal(sentMessages[0]?.options?.triggerTurn, true);
  assert.deepEqual(deliveryAcks, [{ requestId: "result-foreground", delivered: true }]);
});

test("topic subscription acknowledgement takes effect before the next received blocker", async () => {
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(path.join(sharedHomeDir, "topic-ack-"));
  const { prepareBrokerSocketPath } = await import("../../src/pi-intercom/broker/paths.ts");
  const { createMessageReader } = await import("../../src/pi-intercom/broker/framing.ts");
  const { default: extension } = await import("../../src/pi-intercom/index.ts");
  const sockets = new Set<net.Socket>(),
    topic = "private/first-ack-blocker";
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
    let session: SessionInfo;
    socket.on(
      "data",
      createMessageReader(
        (input) => {
          const request = record(input);
          if (request.type === "register") {
            const registered = normalizeSessionInfo({
              ...record(request.session),
              id: "ack-receiver",
            });
            assertDefined(registered);
            session = registered;
            writeMessage(socket, {
              type: "registered",
              sessionId: session.id,
              topicsSupported: true,
              topicFrames: true,
            });
          } else if (request.type === "list") {
            const packets: unknown[] = [
              { type: "sessions", requestId: request.requestId, sessions: [session] },
            ];
            if (request.change !== undefined && record(request.change).action === "subscribe") {
              packets.push({
                type: "message",
                from: { id: "ack-publisher", name: "Topic owner", cwd: repoDir, model: "fixture" },
                message: {
                  id: "first-live-topic-blocker",
                  timestamp: Date.now(),
                  delivery: "steer",
                  content: { text: "First live blocker after subscription" },
                  topic: {
                    topic,
                    text: "First live blocker after subscription",
                    event: "blocker",
                    revision: 1,
                    updatedAt: Date.now(),
                  },
                },
              });
            }
            // One socket write fixes the acknowledgement / following-message interleaving.
            socket.write(
              Buffer.concat(
                packets.map((packet) => {
                  const body = Buffer.from(JSON.stringify(packet));
                  const header = Buffer.alloc(4);
                  header.writeUInt32BE(body.length);
                  return Buffer.concat([header, body]);
                }),
              ),
            );
          } else if (request.type === "unregister") {
            socket.end();
          }
        },
        (error) => {
          socket.destroy(error);
        },
      ),
    );
  });
  const harness = await createExtensionHarness("topic-ack-parent");
  try {
    await new Promise<void>((resolve) => {
      server.listen(prepareBrokerSocketPath(), resolve);
    });
    extension(harness.pi);
    await harness.emitLifecycle("session_start");
    const tool = harness.tool("intercom");
    const result = await tool.execute(
      "subscribe",
      { action: "subscribe", topic },
      new AbortController().signal,
      undefined,
      harness.ctx,
    );
    assert.ok(!result.isError, textAt(result.content));
    await nextTurn();
    assert.equal(
      harness.sentMessages.filter((entry) =>
        entry.message.content.includes("First live blocker after subscription"),
      ).length,
      1,
      "the first live blocker must not be dropped between broker confirmation and local subscription commit",
    );
  } finally {
    await harness.emitLifecycle("session_shutdown");
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    process.env.PI_CODING_AGENT_DIR = previousDir;
  }
});

test(
  "topic support is explicit and an older broker leaves direct messaging untouched",
  { concurrency: false },
  async () => {
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const broker = await setupBroker(),
      peer = new IntercomClient(),
      harness = await createExtensionHarness("topic-capability-parent", { hasUI: true });
    const legacy = Boolean(process.env.PI_INTERCOM_TEST_BROKER);
    try {
      await connectClient(peer, "topic-capability-peer");
      piIntercomExtension(harness.pi);
      await harness.emitLifecycle("session_start");
      const parent = await waitForSessionByName(peer, "topic-capability-parent");
      const tool = harness.tool("intercom");
      for (const params of [
        { action: "subscribe", topic: "capability/test" },
        { action: "publish", topic: "capability/test", message: "Current state" },
      ]) {
        // Publication depends on the preceding subscription capability result.
        // oxlint-disable-next-line no-await-in-loop
        const result = await tool.execute(
          "capability",
          params,
          new AbortController().signal,
          undefined,
          harness.ctx,
        );
        if (legacy) {
          assert.equal(result.isError, true);
          assert.match(textAt(result.content), /older broker/);
          assert.match(textAt(result.content), /close normally/);
        } else {
          assert.ok(!result.isError, textAt(result.content));
        }
      }
      assert.equal(peer.supportsTopics, !legacy);
      const message = receiveMessage(peer);
      const sent = await tool.execute(
        "direct",
        {
          action: "send",
          to: peer.sessionId,
          message: "Direct messages still work",
          delivery: "steer",
        },
        new AbortController().signal,
        undefined,
        harness.ctx,
      );
      assert.ok(!sent.isError);
      assert.equal((await message)[1].content.text, "Direct messages still work");
      assert.equal(
        (await waitForSessionByName(peer, "topic-capability-parent")).id,
        parent.id,
        "no disconnect, re-registration, or replacement runtime",
      );
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await peer.disconnect();
      await stopBroker(broker);
    }
  },
);

test("subagent live intercom events steer a registered child", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const broker = await setupBroker();
  const child = new IntercomClient();
  const harness = await createExtensionHarness("supervisor");
  const deliveryAcks: unknown[] = [];
  harness.pi.events.on("subagent:live-intercom-delivery", (payload: unknown) => {
    deliveryAcks.push(payload);
  });
  try {
    await connectClient(child, "subagent-worker-run-live-1");
    piIntercomExtension(harness.pi);
    await harness.emitLifecycle("session_start");
    await waitForSessionByName(child, "supervisor");
    const messagePromise = receiveMessage(child);

    harness.pi.events.emit("subagent:live-intercom", {
      requestId: "live-1",
      to: "subagent-worker-run-live-1",
      message: "please report status",
      delivery: "steer",
    });

    const [, message] = await messagePromise;
    assert.equal(message.content.text, "please report status");
    const deadline = Date.now() + 2000;
    while (deliveryAcks.length === 0 && Date.now() < deadline) {
      // Observe the actual live-delivery acknowledgement before asserting its payload.
      // oxlint-disable-next-line no-await-in-loop
      await sleep(25);
    }
    assert.deepEqual(deliveryAcks, [
      {
        requestId: "live-1",
        delivered: true,
        accepted: true,
        messageId: message.id,
        queued: undefined,
      },
    ]);
    assert.equal(message.delivery, "steer");
  } finally {
    await harness.emitLifecycle("session_shutdown");
    await child.disconnect();
    await stopBroker(broker);
  }
});

test(
  "subagent intercom health queries report registered and missing targets",
  { concurrency: false },
  async () => {
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const broker = await setupBroker();
    const child = new IntercomClient();
    const harness = await createExtensionHarness("supervisor-health");
    const responses: unknown[] = [];
    harness.pi.events.on("subagent:intercom-health-response", (payload: unknown) => {
      responses.push(payload);
    });
    try {
      await connectClient(child, "subagent-worker-health-1");
      piIntercomExtension(harness.pi);
      await harness.emitLifecycle("session_start");
      await waitForSessionByName(child, "supervisor-health");

      harness.pi.events.emit("subagent:intercom-health-request", {
        requestId: "health-1",
        targets: ["subagent-worker-health-1", "missing-child"],
      });
      const deadline = Date.now() + 2000;
      while (responses.length === 0 && Date.now() < deadline) {
        // Observe the actual broker health response before asserting its payload.
        // oxlint-disable-next-line no-await-in-loop
        await sleep(25);
      }

      assert.equal(responses.length, 1);
      const response = record(responses[0]);
      const health = records(response.health);
      assert.equal(response.requestId, "health-1");
      const registered = health.find((item) => item.target === "subagent-worker-health-1");
      const missing = health.find((item) => item.target === "missing-child");
      assert.equal(registered?.status, "registered");
      assert.equal(registered.sessionName, "subagent-worker-health-1");
      assert.equal(missing?.status, "none");
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await child.disconnect();
      await stopBroker(broker);
    }
  },
);

test(
  "local health distinguishes startup, registered, disconnected and unavailable without reconnecting",
  { concurrency: false },
  async () => {
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const broker = await setupBroker();
    const observer = new IntercomClient();
    const harness = await createExtensionHarness("local-health");
    let sequence = 0;
    const query = (targets: readonly string[] = []) =>
      new Promise<Readonly<Record<string, unknown>> | undefined>((resolve) => {
        const requestId = `local-health-${sequence++}`;
        const timer = setTimeout(() => {
          unsubscribe();
          resolve();
        }, 500);
        const unsubscribe = harness.pi.events.on("subagent:intercom-health-response", (payload) => {
          const response = record(payload);
          if (response.requestId !== requestId) {
            return;
          }
          clearTimeout(timer);
          unsubscribe();
          resolve(response.connection === undefined ? undefined : record(response.connection));
        });
        harness.pi.events.emit("subagent:intercom-health-request", { requestId, targets });
      });
    try {
      await connectClient(observer, "health-observer");
      piIntercomExtension(harness.pi);
      assert.equal(
        (await query())?.status,
        "unknown",
        "a loaded but unstarted bridge must answer honestly",
      );
      await harness.emitLifecycle("session_start");
      assert.equal((await query())?.status, "connecting");
      const registered = await waitForSessionByName(observer, "local-health");
      assert.deepEqual(await query(), { status: "connected", sessionId: registered.id });
      assert.equal(
        (await query(["missing-peer"]))?.status,
        "connected",
        "a missing target is not a disconnected local client",
      );
      const disconnected = once(observer, "disconnected");
      await stopBroker(broker);
      await disconnected;
      await nextTurn();
      assert.equal(
        (await query())?.status,
        "disconnected",
        "a diagnostic read must not reconnect or restart the broker",
      );
      await harness.emitLifecycle("session_shutdown");
      assert.equal(await query(), undefined, "an unloaded bridge has no live answer");
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await observer.disconnect();
      await stopBroker(broker);
    }
  },
);

test(
  "async ask can be replied to later from the single pending ask fallback",
  { concurrency: false },
  async () => {
    const { planner, orchestrator, cleanup } = await setupClients();
    const replyTracker = new ReplyTracker();

    try {
      const askId = "ask-later";
      const askPromise = receiveMessage(orchestrator);
      const replyPromise = waitForReply(planner, askId);

      const delivered = await planner.send(requireText(orchestrator.sessionId), {
        messageId: askId,
        text: "Need an answer later.",
        expectsReply: true,
      });
      assert.equal(delivered.delivered, true);

      const [from, message] = await askPromise;
      replyTracker.recordIncomingMessage(from, message, Date.now());

      const target = replyTracker.resolveReplyTarget({}, Date.now());
      const sent = await orchestrator.send(target.from.id, {
        text: "Answering later worked.",
        replyTo: target.message.id,
      });
      assert.equal(sent.delivered, true);
      replyTracker.markReplied(target.message.id);

      const reply = await replyPromise;
      assert.equal(reply.message.content.text, "Answering later worked.");
      assert.equal(reply.message.replyTo, askId);
    } finally {
      await cleanup();
    }
  },
);

test(
  "subagent live/control event bridges survive an in-process session restart",
  { concurrency: false },
  async () => {
    const { planner, cleanup } = await setupClients();
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const harness = await createExtensionHarness("restart-bridge-worker", { hasUI: true });
    const sessionName = "restart-bridge-worker";

    try {
      piIntercomExtension(harness.pi);
      await harness.emitLifecycle("session_start");
      await waitForSessionByName(planner, sessionName);

      // Control bridge: a self-targeted control event delivers locally (no broker send).
      harness.pi.events.emit("subagent:control-intercom", {
        to: sessionName,
        message: "control before restart",
      });
      await nextTurn();
      assert.match(harness.sentMessages[0]?.message.content ?? "", /control before restart/);

      // Restart the session in the same extension instance. session_shutdown tears the
      // bridges down; session_start must re-register them or they stay dead.
      await harness.emitLifecycle("session_shutdown");
      await harness.emitLifecycle("session_start");
      await waitForSessionByName(planner, sessionName);

      // Control bridge is still handled after the restart.
      harness.pi.events.emit("subagent:control-intercom", {
        to: sessionName,
        message: "control after restart",
      });
      await nextTurn();
      assert.match(harness.sentMessages[1]?.message.content ?? "", /control after restart/);

      // Live bridge is still handled after the restart: a self-targeted live send resolves
      // to "cannot message the current session" and emits a delivery response, proving the
      // handler registered by registerSubagentLiveEventHandlers actually ran.
      const liveDelivery = new Promise<Readonly<Record<string, unknown>>>((resolve) => {
        harness.pi.events.on("subagent:live-intercom-delivery", (payload) => {
          resolve(record(payload));
        });
      });
      harness.pi.events.emit("subagent:live-intercom", {
        requestId: "live-after-restart",
        to: sessionName,
        message: "live after restart",
        delivery: "steer",
      });
      const liveResult = await Promise.race([liveDelivery, sleep(2000, null)]);
      assert.ok(liveResult, "live bridge delivery response should fire after restart");
      assert.equal(liveResult.delivered, false);
      assert.match(requireText(liveResult.reason), /Cannot message the current session/);
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await cleanup();
    }
  },
);
