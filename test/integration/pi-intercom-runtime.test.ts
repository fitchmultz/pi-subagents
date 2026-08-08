import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter, once } from "node:events";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import net from "node:net";
import type { Readable } from "node:stream";
import { ReplyTracker } from "../../src/pi-intercom/reply-tracker.ts";
import { resolveSessionProjectId } from "../../src/pi-intercom/session-targets.ts";
import { ComposeOverlay } from "../../src/pi-intercom/ui/compose.ts";
import type { Message, SessionInfo } from "../../src/pi-intercom/types.ts";

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
const { MAX_FRAME_SIZE_BYTES, writeMessage } = await import("../../src/pi-intercom/broker/framing.ts");
const { getBrokerSocketPath } = await import("../../src/pi-intercom/broker/paths.ts");
process.on("exit", () => {
  for (const broker of activeBrokers) signalBroker(broker, "SIGKILL");
  signalSharedBroker("SIGKILL");
  process.env.HOME = previousHome;
  process.env.USERPROFILE = previousUserProfile;
  if (previousPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
  for (const key of childEnvKeys) {
    const value = previousChildEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(sharedHomeDir, { recursive: true, force: true });
});

type BrokerProcess = ChildProcessByStdio<null, Readable, Readable>;
const activeBrokers = new Set<BrokerProcess>();

function signalBroker(broker: BrokerProcess, signal: NodeJS.Signals): void {
  if (broker.pid && process.platform !== "win32") {
    try {
      process.kill(-broker.pid, signal);
      return;
    } catch {
      // Fall back to the direct child below.
    }
  }
  broker.kill(signal);
}

after(async () => {
  await Promise.all([...activeBrokers].map(stopBroker));
  await stopSharedBroker();
});

function sharedBrokerPid(): number | null {
  const pidPath = path.join(sharedAgentDir, "intercom", "broker.pid");
  if (!existsSync(pidPath)) return null;
  const pid = Number.parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
  return Number.isFinite(pid) ? pid : null;
}

function signalSharedBroker(signal: NodeJS.Signals): void {
  const pid = sharedBrokerPid();
  if (pid === null) return;
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
}

async function stopSharedBroker(): Promise<void> {
  const pid = sharedBrokerPid();
  if (pid === null) return;
  signalSharedBroker("SIGTERM");
  const start = Date.now();
  while (Date.now() - start < 2000) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  signalSharedBroker("SIGKILL");
}

function unrefStream(stream: Readable): void {
  (stream as Readable & { unref?: () => void }).unref?.();
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
    const poll = setInterval(async () => {
      if (await brokerSocketConnectable()) {
        cleanup();
        resolve();
      }
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
      reject(new Error(`Broker exited before startup (code=${code}, signal=${signal})`));
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

async function withChildOrchestratorEnv<T>(metadata: {
  orchestratorTarget?: string;
  runId?: string;
  agent?: string;
  index?: string;
  sessionName?: string;
}, fn: () => T | Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of childEnvKeys) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  if (metadata.orchestratorTarget !== undefined) process.env.PI_SUBAGENT_ORCHESTRATOR_TARGET = metadata.orchestratorTarget;
  if (metadata.runId !== undefined) process.env.PI_SUBAGENT_RUN_ID = metadata.runId;
  if (metadata.agent !== undefined) process.env.PI_SUBAGENT_CHILD_AGENT = metadata.agent;
  if (metadata.index !== undefined) process.env.PI_SUBAGENT_CHILD_INDEX = metadata.index;
  if (metadata.sessionName !== undefined) process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME = metadata.sessionName;
  try {
    return await fn();
  } finally {
    for (const key of childEnvKeys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

interface CapturedToolResult {
  content: Array<{ type: string; text: string }>;
  isError: boolean;
  details?: Record<string, unknown>;
}

interface RenderToolResult {
  content: Array<{ type: string; text: string }>;
  details?: Record<string, unknown>;
}

interface RenderedComponent {
  render(width: number): string[];
}

interface RenderTheme {
  fg(name: string, text: string): string;
  bold(text: string): string;
}

interface CapturedTool {
  name: string;
  description?: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters?: unknown;
  execute: (toolCallId: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: unknown, ctx: unknown) => Promise<CapturedToolResult>;
  renderCall?: (args: Record<string, unknown>, theme: RenderTheme, context: Record<string, unknown>) => RenderedComponent;
  renderResult?: (result: RenderToolResult, options: { expanded?: boolean; isPartial?: boolean }, theme: RenderTheme, context: Record<string, unknown>) => RenderedComponent;
}

const renderTheme: RenderTheme = {
  fg: (_name, text) => text,
  bold: (text) => text,
};

function renderToText(component: RenderedComponent): string {
  return component.render(120).map((line) => line.trimEnd()).join("\n");
}

function createExtensionHarness(sessionName = "child-worker", options: {
  abort?: () => void;
  hasUI?: boolean;
  isIdle?: () => boolean;
  ui?: unknown;
  wrapToolErrors?: boolean;
} = {}) {
  const events = new EventEmitter();
  const lifecycleHandlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
  const tools: CapturedTool[] = [];
  const entries: Array<{ type: string; data: unknown }> = [];
  const sentMessages: Array<{ message: { customType?: string; content?: string; details?: unknown }; options?: { triggerTurn?: boolean; deliverAs?: string } }> = [];
  const pi = {
    getSessionName: () => sessionName,
    events: {
      on: (channel: string, handler: (payload: unknown) => void) => {
        events.on(channel, handler);
        return () => events.off(channel, handler);
      },
      emit: (channel: string, payload: unknown) => events.emit(channel, payload),
    },
    on: (event: string, handler: (payload: unknown, ctx: unknown) => unknown) => {
      const handlers = lifecycleHandlers.get(event) ?? [];
      handlers.push(handler);
      lifecycleHandlers.set(event, handlers);
    },
    registerMessageRenderer: () => undefined,
    registerTool: (tool: CapturedTool) => {
      if (options.wrapToolErrors === false) {
        tools.push(tool);
        return;
      }
      const originalExecute = tool.execute.bind(tool);
      tools.push({
        ...tool,
        async execute(...args) {
          try {
            return await originalExecute(...args);
          } catch (error) {
            return {
              content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
              isError: true,
              details: typeof error === "object" && error !== null && "details" in error
                ? (error as { details?: Record<string, unknown> }).details
                : undefined,
            };
          }
        },
      });
    },
    registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => unknown }) => {
      commands.set(name, command.handler);
    },
    registerShortcut: () => undefined,
    sendMessage: (message: { customType?: string; content?: string; details?: unknown }, options?: { triggerTurn?: boolean; deliverAs?: string }) => {
      sentMessages.push({ message, options });
    },
    appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
  };
  const ctx = {
    cwd: repoDir,
    model: { id: "child-model" },
    sessionManager: { getSessionId: () => "session-child-test" },
    isIdle: options.isIdle ?? (() => true),
    hasUI: options.hasUI ?? false,
    abort: options.abort ?? (() => undefined),
    ui: options.ui,
  };
  return {
    pi,
    ctx,
    tools,
    commands,
    entries,
    sentMessages,
    async emitLifecycle(event: string, payload: unknown = {}, eventContext: unknown = ctx) {
      const results: unknown[] = [];
      for (const handler of lifecycleHandlers.get(event) ?? []) {
        results.push(await handler(payload, eventContext));
      }
      return results;
    },
  };
}

async function setupBroker() {
  const broker = spawn(process.execPath, [path.join(repoDir, "src", "pi-intercom", "broker", "broker.ts")], {
    cwd: repoDir,
    detached: process.platform !== "win32",
    env: { ...process.env, HOME: sharedHomeDir, USERPROFILE: sharedHomeDir, PI_CODING_AGENT_DIR: sharedAgentDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
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
  if (broker.exitCode !== null || broker.signalCode !== null) return;
  signalBroker(broker, "SIGTERM");
  await Promise.race([
    once(broker, "exit").catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(() => {
      signalBroker(broker, "SIGKILL");
      resolve();
    }, 2000)),
  ]);
}

async function connectClient(
  client: InstanceType<typeof IntercomClient>,
  name: string,
  overrides: Partial<Omit<SessionInfo, "id" | "name">> = {},
): Promise<void> {
  await client.connect({
    name,
    cwd: repoDir,
    model: "test-model",
    ...overrides,
  });
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
        await planner.disconnect().catch(() => undefined);
        await orchestrator.disconnect().catch(() => undefined);
        await stopBroker(broker);
      },
    };
  } catch (error) {
    await stopBroker(broker);
    throw error;
  }
}

async function waitForSentMessages(harness: ReturnType<typeof createExtensionHarness>, count: number, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (harness.sentMessages.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${count} sent messages; got ${harness.sentMessages.length}`);
}

function waitForReply(client: InstanceType<typeof IntercomClient>, replyTo: string, timeoutMs = 5000): Promise<{ from: SessionInfo; message: Message; }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      client.off("message", handler);
      reject(new Error(`Timed out waiting for reply to ${replyTo}`));
    }, timeoutMs);
    const handler = (from: SessionInfo, message: Message) => {
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
  matches: (session: SessionInfo) => boolean,
  timeoutMessage: (sessions: SessionInfo[]) => string,
): Promise<SessionInfo> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const session = (await client.listSessions()).find(matches);
    if (session) return session;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(timeoutMessage(await client.listSessions()));
}

function waitForSessionByName(client: InstanceType<typeof IntercomClient>, name: string): Promise<SessionInfo> {
  return waitForSession(client, (session) => session.name === name,
    (sessions) => `Timed out waiting for ${name}; saw ${JSON.stringify(sessions.map((session) => session.name))}`);
}

function waitForSessionStatus(client: InstanceType<typeof IntercomClient>, name: string, status: string): Promise<SessionInfo> {
  return waitForSession(client, (session) => session.name === name && session.status === status,
    (sessions) => `Timed out waiting for ${name} status ${status}; saw ${JSON.stringify(sessions.map((session) => ({ name: session.name, status: session.status })))}`);
}

function waitForSessionModel(client: InstanceType<typeof IntercomClient>, name: string, model: string): Promise<SessionInfo> {
  return waitForSession(client, (session) => session.name === name && session.model === model,
    (sessions) => `Timed out waiting for ${name} model ${model}; saw ${JSON.stringify(sessions.map((session) => ({ name: session.name, model: session.model })))}`);
}

test("intercom tool renders compact call and result rows", async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const harness = createExtensionHarness();

  piIntercomExtension(harness.pi as never);
  const intercomTool = harness.tools.find((tool) => tool.name === "intercom")!;

  assert.ok(intercomTool.renderCall);
  assert.ok(intercomTool.renderResult);
  assert.match(renderToText(intercomTool.renderCall({
    action: "ask",
    to: "planner",
    message: "Need a decision before I continue with this implementation.",
    attachments: [{ type: "snippet", name: "note.ts", content: "const ok = true;" }],
  }, renderTheme, {})), /intercom ask → planner \(1 attachment\)\n  Need a decision/);

  const resultText = renderToText(intercomTool.renderResult({
    content: [{ type: "text", text: "Message sent to planner" }],
    details: { delivered: true, messageId: "abcdef123456" },
  }, { isPartial: false, expanded: false }, renderTheme, { isError: false, expanded: false }));
  assert.match(resultText, /✓ Message sent to planner \(abcdef12\)/);

  const listResult = {
    content: [{ type: "text", text: "Current session: controller\nOther sessions:\n- busy-worker" }],
    details: { sessionCount: 12 },
  };
  const collapsedListText = renderToText(intercomTool.renderResult(
    listResult,
    { isPartial: false, expanded: false },
    renderTheme,
    { isError: false, expanded: false, args: { action: "list" } },
  ));
  assert.match(collapsedListText, /✓ 12 sessions .*Ctrl\+O.*to expand/);
  assert.doesNotMatch(collapsedListText, /busy-worker/);

  const expandedListText = renderToText(intercomTool.renderResult(
    listResult,
    { isPartial: false, expanded: true },
    renderTheme,
    { isError: false, expanded: true, args: { action: "list" } },
  ));
  assert.match(expandedListText, /busy-worker/);

  const errorText = renderToText(intercomTool.renderResult({
    content: [{ type: "text", text: "Missing 'to' or 'message' parameter" }],
    details: { error: true, reason: "Missing target" },
  }, { isPartial: false, expanded: true }, renderTheme, { isError: false, expanded: true }));
  assert.match(errorText, /✗ Missing 'to' or 'message' parameter/);
  assert.match(errorText, /Reason: Missing target/);
});

test("contact supervisor tool renders reason and reply state", async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");

  await withChildOrchestratorEnv({
    orchestratorTarget: "orchestrator",
    runId: "78f659a3",
    agent: "worker",
    index: "0",
  }, () => {
    const harness = createExtensionHarness();
    piIntercomExtension(harness.pi as never);
    const supervisorTool = harness.tools.find((tool) => tool.name === "contact_supervisor")!;

    assert.ok(supervisorTool.renderCall);
    assert.ok(supervisorTool.renderResult);
    assert.match(renderToText(supervisorTool.renderCall({
      reason: "interview_request",
      message: "Please answer these before I continue.",
      interview: { title: "API migration", questions: [] },
    }, renderTheme, {})), /contact_supervisor interview_request API migration\n  Please answer/);

    const warningText = renderToText(supervisorTool.renderResult({
      content: [{ type: "text", text: "Reply from supervisor:\nUse stable API" }],
      details: { structuredReplyParseError: "reply JSON must include a responses array" },
    }, { isPartial: false }, renderTheme, { isError: false }));
    assert.match(warningText, /⚠ Reply from supervisor:\nUse stable API/);
    assert.match(warningText, /Structured reply parse issue: reply JSON must include a responses array/);

    const failureText = renderToText(supervisorTool.renderResult({
      content: [{ type: "text", text: "Invalid reason" }],
      details: { error: true },
    }, { isPartial: false }, renderTheme, { isError: false }));
    assert.match(failureText, /✗ Invalid reason/);
  });
});

test("intercom tool empty list output gives local fork next steps", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const broker = await setupBroker();
  const harness = createExtensionHarness("solo", { hasUI: true });

  try {
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");
    const intercomTool = harness.tools.find((tool) => tool.name === "intercom")!;

    const result = await intercomTool.execute("tool-empty-list", {
      action: "list",
    }, new AbortController().signal, undefined, harness.ctx);

    assert.equal(result.isError, false);
    assert.deepEqual(result.details, { sessionCount: 1 });
    const text = result.content[0]?.text ?? "";
    assert.match(text, /No other sessions connected/);
    assert.match(text, /pi --name worker/);
    assert.match(text, new RegExp(`--extension '${repoDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/src/pi-intercom/index\\.ts' --skill '${repoDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/skills/pi-intercom'`));
  } finally {
    await harness.emitLifecycle("session_shutdown");
    await stopBroker(broker);
  }
});

test("before_agent_start adds a bounded hint only for same-project peers", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const broker = await setupBroker();
  const related = new IntercomClient();
  const unrelated = new IntercomClient();
  const harness = createExtensionHarness("ambient-controller");
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
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");
    await waitForSessionByName(related, "ambient-controller");

    const results = await harness.emitLifecycle("before_agent_start", { systemPrompt: "base prompt" });
    const update = results.find((result) => result && typeof result === "object" && "systemPrompt" in result) as { systemPrompt: string } | undefined;
    assert.ok(update);
    assert.match(update.systemPrompt, /^base prompt\n\n1 other Pi session is connected to this project\./);
    assert.doesNotMatch(update.systemPrompt, /same-project-peer|unrelated-peer/);
  } finally {
    await related.disconnect().catch(() => undefined);
    await unrelated.disconnect().catch(() => undefined);
    await harness.emitLifecycle("session_shutdown");
    await stopBroker(broker);
    rmSync(unrelatedDir, { recursive: true, force: true });
  }
});

test("before_agent_start fails open while project identity resolution is slow", { concurrency: false, skip: process.platform === "win32" }, async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const broker = await setupBroker();
  const harness = createExtensionHarness("slow-project-controller");
  const fakeBin = mkdtempSync(path.join(tmpdir(), "pi-intercom-slow-git-"));
  const previousPath = process.env.PATH;
  writeFileSync(path.join(fakeBin, "git"), "#!/usr/bin/env node\nsetTimeout(() => process.exit(1), 2000);\n", { mode: 0o755 });

  try {
    process.env.PATH = `${fakeBin}${path.delimiter}${previousPath ?? ""}`;
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");

    const startedAt = Date.now();
    const results = await harness.emitLifecycle("before_agent_start", { systemPrompt: "base prompt" });
    assert.ok(Date.now() - startedAt < 250, "peer awareness should fail open before slow Git resolution settles");
    assert.equal(results.some((result) => result && typeof result === "object" && "systemPrompt" in result), false);
    await new Promise((resolve) => setTimeout(resolve, 550));
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await harness.emitLifecycle("session_shutdown");
    await stopBroker(broker);
    rmSync(fakeBin, { recursive: true, force: true });
  }
});

test("intercom list and status show recipient capability and delivery guidance", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const broker = await setupBroker();
  const harness = createExtensionHarness("capability-controller", { hasUI: true });
  const busyPeer = new IntercomClient();

  try {
    await connectClient(busyPeer, "busy-peer", {
      status: "thinking",
      acceptsAsks: false,
      pendingAsks: 2,
      lastIntercomActivity: Date.now() - 65_000,
    });
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");
    const intercomTool = harness.tools.find((tool) => tool.name === "intercom")!;

    const listResult = await intercomTool.execute("tool-capability-list", {
      action: "list",
    }, new AbortController().signal, undefined, harness.ctx);
    const listText = listResult.content[0]?.text ?? "";
    assert.equal(listResult.isError, false);
    assert.match(listText, /capability-controller/);
    assert.match(listText, /self target unavailable; choose a peer from Other sessions; use pending\/reply for inbound asks/);
    assert.match(listText, /busy-peer/);
    assert.match(listText, /state:busy/);
    assert.match(listText, /accepts_asks:false/);
    assert.match(listText, /pending_asks:2/);
    assert.match(listText, /last_intercom_activity:1m ago/);
    assert.match(listText, /ask only if sender must stay alive for a required reply/);
    assert.match(listText, /default returns peer_idle/);
    assert.match(listText, /passive discouraged/);

    const statusResult = await intercomTool.execute("tool-capability-status", {
      action: "status",
    }, new AbortController().signal, undefined, harness.ctx);
    const statusText = statusResult.content[0]?.text ?? "";
    assert.equal(statusResult.isError, false);
    assert.match(statusText, /Intercom Status/);
    assert.match(statusText, /Current session/);
    assert.match(statusText, /Other sessions/);
    assert.match(statusText, /self target unavailable/);
    assert.match(statusText, /busy-peer/);
    assert.match(statusText, /send defaults to steer/);
    assert.match(statusText, /queue only for intentional delay/);
  } finally {
    await busyPeer.disconnect().catch(() => undefined);
    await harness.emitLifecycle("session_shutdown");
    await stopBroker(broker);
  }
});

test("plain sends wake by default, passive sends do not, and only asks show reply hints", { concurrency: false }, async () => {
  const { planner, cleanup } = await setupClients();
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const harness = createExtensionHarness("hint-worker", { hasUI: true });

  try {
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");
    const target = await waitForSessionByName(planner, "hint-worker");

    await planner.send(target.id, { messageId: "plain-send", text: "FYI only" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(harness.sentMessages[0]?.message.content ?? "", /FYI only/);
    assert.doesNotMatch(harness.sentMessages[0]?.message.content ?? "", /To reply/);
    assert.deepEqual(harness.sentMessages[0]?.options, { triggerTurn: true });

    await planner.send(target.id, { messageId: "passive-send", text: "FYI later", passive: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(harness.sentMessages[1]?.message.content ?? "", /FYI later/);
    assert.doesNotMatch(harness.sentMessages[1]?.message.content ?? "", /To reply/);
    assert.equal(harness.sentMessages[1]?.options, undefined);

    await planner.send(target.id, { messageId: "needs-reply", text: "Need answer", expectsReply: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(harness.sentMessages[2]?.message.content ?? "", /Need answer/);
    assert.match(harness.sentMessages[2]?.message.content ?? "", /To reply/);
    assert.deepEqual(harness.sentMessages[2]?.options, { triggerTurn: true });
  } finally {
    await harness.emitLifecycle("session_shutdown");
    await cleanup();
  }
});

test("broker returns a clean delivery failure when forwarding would exceed the frame cap", { concurrency: false }, async () => {
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

    const result = await sender.send(receiver.sessionId!, {
      messageId: "too-large-forward",
      text: "x".repeat(Math.max(1, MAX_FRAME_SIZE_BYTES - 350_000)),
    });

    assert.equal(result.delivered, false);
    assert.match(result.reason ?? "", /message too large/i);

    const queuedResult = await sender.send(receiver.sessionId!, {
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
    await sender.disconnect().catch(() => undefined);
    await receiver.disconnect().catch(() => undefined);
    await stopBroker(broker);
  }
});

test("intercom send passive opt-in is exposed through the public tool", { concurrency: false }, async () => {
  const { planner, cleanup } = await setupClients();
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const sender = createExtensionHarness("tool-passive-sender", { hasUI: true });
  const receiver = createExtensionHarness("tool-passive-receiver", { hasUI: true });

  try {
    piIntercomExtension(sender.pi as never);
    piIntercomExtension(receiver.pi as never);
    await sender.emitLifecycle("session_start");
    await receiver.emitLifecycle("session_start");
    await waitForSessionByName(planner, "tool-passive-receiver");

    const intercomTool = sender.tools.find((tool) => tool.name === "intercom")!;
    const result = await intercomTool.execute("tool-passive-send", {
      action: "send",
      to: "tool-passive-receiver",
      message: "FYI for transcript only",
      passive: true,
    }, new AbortController().signal, undefined, sender.ctx);

    assert.equal(result.isError, false);
    assert.match(result.content[0]?.text ?? "", /passive; recipient model was not woken/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(receiver.sentMessages[0]?.message.content ?? "", /FYI for transcript only/);
    assert.equal(receiver.sentMessages[0]?.options, undefined);

    const invalidPassiveResult = await intercomTool.execute("tool-passive-ask", {
      action: "ask",
      to: "tool-passive-receiver",
      message: "Can this be passive?",
      passive: true,
    }, new AbortController().signal, undefined, sender.ctx);
    assert.equal(invalidPassiveResult.isError, true);
    assert.match(invalidPassiveResult.content[0]?.text ?? "", /only valid for action='send'/);
  } finally {
    await sender.emitLifecycle("session_shutdown");
    await receiver.emitLifecycle("session_shutdown");
    await cleanup();
  }
});

test("pending ask is expired when sender disconnects before reply", { concurrency: false }, async () => {
  const { planner, cleanup } = await setupClients();
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const harness = createExtensionHarness("disconnect-expiry-worker", { hasUI: true });

  try {
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");
    const target = await waitForSessionByName(planner, "disconnect-expiry-worker");

    await planner.send(target.id, { messageId: "disconnecting-ask", text: "Need answer", expectsReply: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(harness.sentMessages[0]?.message.content ?? "", /Need answer/);

    await planner.disconnect();
    await new Promise((resolve) => setImmediate(resolve));

    const intercomTool = harness.tools.find((tool) => tool.name === "intercom")!;
    const result = await intercomTool.execute("reply-after-disconnect", {
      action: "reply",
      message: "normal reply",
    }, new AbortController().signal, undefined, harness.ctx);

    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /No active intercom context to reply to/);
    assert.doesNotMatch(result.content[0]?.text ?? "", /Session not found|not delivered/);
  } finally {
    await harness.emitLifecycle("session_shutdown");
    await cleanup();
  }
});

test("recipient turn failures are reported to waiting ask senders", { concurrency: false }, async () => {
  const { planner, cleanup } = await setupClients();
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const harness = createExtensionHarness("failing-worker", { hasUI: true });

  try {
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");
    const target = await waitForSessionByName(planner, "failing-worker");
    const replyPromise = waitForReply(planner, "failure-ask");

    await planner.send(target.id, { messageId: "failure-ask", text: "Need answer", expectsReply: true });
    await waitForSentMessages(harness, 1);
    await harness.emitLifecycle("turn_start");
    await harness.emitLifecycle("message_end", {
      message: { role: "assistant", stopReason: "error", errorMessage: "No API key for provider: test" },
    });

    const reply = await replyPromise;
    assert.equal(reply.message.replyTo, "failure-ask");
    assert.match(reply.message.content.text, /Recipient turn failed: No API key for provider: test/);
  } finally {
    await harness.emitLifecycle("session_shutdown");
    await cleanup();
  }
});

test("recipient turn failures after tool turns still report to waiting ask senders", { concurrency: false }, async () => {
  const { planner, cleanup } = await setupClients();
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const harness = createExtensionHarness("multi-turn-failing-worker", { hasUI: true });

  try {
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");
    const target = await waitForSessionByName(planner, "multi-turn-failing-worker");
    const replyPromise = waitForReply(planner, "multi-turn-failure-ask");

    await planner.send(target.id, { messageId: "multi-turn-failure-ask", text: "Need answer", expectsReply: true });
    await waitForSentMessages(harness, 1);
    await harness.emitLifecycle("turn_start");
    await harness.emitLifecycle("turn_end");
    await harness.emitLifecycle("turn_start");
    await harness.emitLifecycle("message_end", {
      message: { role: "assistant", stopReason: "error", errorMessage: "Tool-followup provider failure" },
    });

    const reply = await replyPromise;
    assert.equal(reply.message.replyTo, "multi-turn-failure-ask");
    assert.match(reply.message.content.text, /Recipient turn failed: Tool-followup provider failure/);
  } finally {
    await harness.emitLifecycle("session_shutdown");
    await cleanup();
  }
});

test("recipient turn failures do not report after an ask is already replied", { concurrency: false }, async () => {
  const { planner, cleanup } = await setupClients();
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const harness = createExtensionHarness("replied-worker", { hasUI: true });

  try {
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");
    const target = await waitForSessionByName(planner, "replied-worker");
    const firstReplyPromise = waitForReply(planner, "already-replied-ask");

    await planner.send(target.id, { messageId: "already-replied-ask", text: "Need answer", expectsReply: true });
    await waitForSentMessages(harness, 1);
    await harness.emitLifecycle("turn_start");
    const intercomTool = harness.tools.find((tool) => tool.name === "intercom")!;
    const replyResult = await intercomTool.execute("reply-before-error", {
      action: "reply",
      message: "normal reply",
      attachments: [{ type: "context", name: "answer.txt", content: "supporting context" }],
    }, new AbortController().signal, undefined, harness.ctx);
    assert.equal(replyResult.isError, false);
    const receivedReply = (await firstReplyPromise).message;
    assert.equal(receivedReply.content.text, "normal reply");
    assert.deepEqual(receivedReply.content.attachments, [{ type: "context", name: "answer.txt", content: "supporting context" }]);

    let unexpectedFailureReply = false;
    const handler = (_from: SessionInfo, message: Message) => {
      if (message.replyTo === "already-replied-ask") unexpectedFailureReply = true;
    };
    planner.on("message", handler);
    await harness.emitLifecycle("message_end", {
      message: { role: "assistant", stopReason: "error", errorMessage: "later failure" },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    planner.off("message", handler);
    assert.equal(unexpectedFailureReply, false);
  } finally {
    await harness.emitLifecycle("session_shutdown");
    await cleanup();
  }
});

test("recipient turn failure propagation stops after agent_settled", { concurrency: false }, async () => {
  const { planner, cleanup } = await setupClients();
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const harness = createExtensionHarness("agent-ended-worker", { hasUI: true });

  try {
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");
    const target = await waitForSessionByName(planner, "agent-ended-worker");
    await planner.send(target.id, { messageId: "agent-ended-ask", text: "Need answer", expectsReply: true });
    await waitForSentMessages(harness, 1);
    await harness.emitLifecycle("turn_start");
    await harness.emitLifecycle("turn_end");
    await harness.emitLifecycle("agent_end");
    await harness.emitLifecycle("agent_settled");

    let unexpectedFailureReply = false;
    const handler = (_from: SessionInfo, message: Message) => {
      if (message.replyTo === "agent-ended-ask") unexpectedFailureReply = true;
    };
    planner.on("message", handler);
    await harness.emitLifecycle("message_end", {
      message: { role: "assistant", stopReason: "error", errorMessage: "post-agent failure" },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    planner.off("message", handler);
    assert.equal(unexpectedFailureReply, false);
  } finally {
    await harness.emitLifecycle("session_shutdown");
    await cleanup();
  }
});

test("intercom ask returns an error result for recipient turn failure replies", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const { cleanup } = await setupClients();
  const worker = new IntercomClient();
  const harness = createExtensionHarness("ask-controller", { hasUI: true });

  try {
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");
    await connectClient(worker, "failing-peer");
    const intercomTool = harness.tools.find((tool) => tool.name === "intercom")!;
    const askReceived = once(worker, "message") as Promise<[SessionInfo, Message]>;
    const resultPromise = intercomTool.execute("ask-failure", {
      action: "ask",
      to: "failing-peer",
      message: "Can you answer?",
    }, new AbortController().signal, undefined, harness.ctx);
    const [from, message] = await askReceived;
    await worker.send(from.id, {
      text: "Recipient turn failed: No API key for provider: test",
      replyTo: message.id,
      attachments: [{ type: "context", name: "pi-intercom-recipient-turn-failure", content: "No API key for provider: test" }],
    });

    const result = await resultPromise;
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /Recipient turn failed: No API key for provider: test/);
    assert.equal(result.details?.reasonCode, "recipient_turn_failed");
    assert.equal(typeof result.details?.messageId, "string");
    assert.equal(typeof result.details?.replyTo, "string");
    assert.deepEqual(result.details?.nextActions, [
      { action: "status" },
      { action: "send", guidance: "Send recovery context after the recipient is healthy." },
    ]);
  } finally {
    await harness.emitLifecycle("session_shutdown");
    await worker.disconnect().catch(() => undefined);
    await cleanup();
  }
});

test("intercom ask treats failure-like normal reply text as a successful reply", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const { cleanup } = await setupClients();
  const worker = new IntercomClient();
  const harness = createExtensionHarness("ask-controller-normal-prefix", { hasUI: true });

  try {
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");
    await connectClient(worker, "prefix-reply-peer");
    const intercomTool = harness.tools.find((tool) => tool.name === "intercom")!;
    const askReceived = once(worker, "message") as Promise<[SessionInfo, Message]>;
    const resultPromise = intercomTool.execute("ask-normal-prefix", {
      action: "ask",
      to: "prefix-reply-peer",
      message: "Can you answer?",
    }, new AbortController().signal, undefined, harness.ctx);
    const [from, message] = await askReceived;
    await worker.send(from.id, { text: "Recipient turn failed: is just text in this normal answer", replyTo: message.id });

    const result = await resultPromise;
    assert.equal(result.isError, false);
    assert.match(result.content[0]?.text ?? "", /Recipient turn failed: is just text/);
  } finally {
    await harness.emitLifecycle("session_shutdown");
    await worker.disconnect().catch(() => undefined);
    await cleanup();
  }
});

test("intercom ask rejects promptly when the reply peer disconnects", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const { cleanup } = await setupClients();
  const worker = new IntercomClient();
  const harness = createExtensionHarness("ask-disconnect-controller", { hasUI: true });

  try {
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");
    await connectClient(worker, "disconnecting-peer");
    const intercomTool = harness.tools.find((tool) => tool.name === "intercom")!;
    const askReceived = once(worker, "message") as Promise<[SessionInfo, Message]>;
    const resultPromise = intercomTool.execute("ask-peer-disconnect", {
      action: "ask",
      to: "disconnecting-peer",
      message: "Will you vanish?",
    }, new AbortController().signal, undefined, harness.ctx);
    await askReceived;
    await worker.disconnect();

    const result = await Promise.race([
      resultPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("ask did not reject promptly")), 1000)),
    ]);
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /Reply peer disconnected before answering/);
  } finally {
    await harness.emitLifecycle("session_shutdown");
    await worker.disconnect().catch(() => undefined);
    await cleanup();
  }
});

test("non-error assistant messages do not propagate recipient failure replies", { concurrency: false }, async () => {
  const { planner, cleanup } = await setupClients();
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const harness = createExtensionHarness("non-error-worker", { hasUI: true });

  try {
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");
    const target = await waitForSessionByName(planner, "non-error-worker");
    await planner.send(target.id, { messageId: "non-error-ask", text: "Need answer", expectsReply: true });
    await new Promise((resolve) => setImmediate(resolve));
    await harness.emitLifecycle("turn_start");

    let unexpectedFailureReply = false;
    const handler = (_from: SessionInfo, message: Message) => {
      if (message.replyTo === "non-error-ask") unexpectedFailureReply = true;
    };
    planner.on("message", handler);
    await harness.emitLifecycle("message_end", {
      message: { role: "assistant", stopReason: "stop", errorMessage: "stale provider warning" },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    planner.off("message", handler);
    assert.equal(unexpectedFailureReply, false);
  } finally {
    await harness.emitLifecycle("session_shutdown");
    await cleanup();
  }
});

test("intercom tool accepts displayed short IDs when session names are duplicated", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const { planner, cleanup } = await setupClients();
  const duplicateA = new IntercomClient();
  const duplicateB = new IntercomClient();
  const nameCollision = new IntercomClient();
  const harness = createExtensionHarness("controller", { hasUI: true });

  try {
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");

    await connectClient(duplicateA, "duplicate-worker");
    await connectClient(duplicateB, "duplicate-worker");

    const duplicateSessions = (await planner.listSessions()).filter((session) => session.name === "duplicate-worker");
    assert.equal(duplicateSessions.length, 2);
    const target = duplicateSessions[0]!;
    const shortTarget = target.id.slice(0, 8);
    const receiver = duplicateA.sessionId === target.id ? duplicateA : duplicateB;
    const messagePromise = once(receiver, "message") as Promise<[SessionInfo, Message]>;

    const intercomTool = harness.tools.find((tool) => tool.name === "intercom")!;
    const result = await intercomTool.execute("tool-1", {
      action: "send",
      to: shortTarget,
      message: "short id delivery works",
    }, new AbortController().signal, undefined, harness.ctx);

    assert.equal(result.isError, false);
    assert.match(result.content[0]?.text ?? "", /defaults to steer/);
    const [, message] = await messagePromise;
    assert.equal(message.content.text, "short id delivery works");
    assert.equal(message.delivery, "steer");

    const tooShortPrefixResult = await intercomTool.execute("tool-too-short", {
      action: "send",
      to: shortTarget.slice(0, 7),
      message: "too short should not deliver",
    }, new AbortController().signal, undefined, harness.ctx);
    assert.equal(tooShortPrefixResult.isError, true);
    assert.match(tooShortPrefixResult.content[0]?.text ?? "", /too short/);
    assert.match(tooShortPrefixResult.content[0]?.text ?? "", new RegExp(shortTarget));

    const listResult = await intercomTool.execute("tool-list", {
      action: "list",
    }, new AbortController().signal, undefined, harness.ctx);
    assert.match(listResult.content[0]?.text ?? "", new RegExp(`target:${shortTarget}`));

    const askMessagePromise = once(receiver, "message") as Promise<[SessionInfo, Message]>;
    const askResultPromise = intercomTool.execute("tool-ask", {
      action: "ask",
      to: shortTarget,
      message: "short id ask works",
    }, new AbortController().signal, undefined, harness.ctx);
    const [askFrom, askMessage] = await askMessagePromise;
    assert.equal(askMessage.content.text, "short id ask works");
    assert.equal(askMessage.expectsReply, true);
    assert.equal(askMessage.delivery, undefined);
    await receiver.send(askFrom.id, { text: "short id ask reply", replyTo: askMessage.id });
    const askResult = await askResultPromise;
    assert.equal(askResult.isError, false);
    assert.match(askResult.content[0]?.text ?? "", /short id ask reply/);

    const duplicateNameResult = await intercomTool.execute("tool-2", {
      action: "send",
      to: "duplicate-worker",
      message: "ambiguous",
    }, new AbortController().signal, undefined, harness.ctx);
    assert.equal(duplicateNameResult.isError, true);
    assert.match(duplicateNameResult.content[0]?.text ?? "", /Use one of these targets/);
    assert.match(duplicateNameResult.content[0]?.text ?? "", new RegExp(shortTarget));

    await connectClient(nameCollision, shortTarget);
    const collisionResult = await intercomTool.execute("tool-collision", {
      action: "send",
      to: shortTarget,
      message: "must not silently choose name over short id",
    }, new AbortController().signal, undefined, harness.ctx);
    assert.equal(collisionResult.isError, true);
    assert.match(collisionResult.content[0]?.text ?? "", /matches multiple sessions/);

    const duplicateNameAfterCollision = await intercomTool.execute("tool-collision-options", {
      action: "send",
      to: "duplicate-worker",
      message: "ambiguous after collision",
    }, new AbortController().signal, undefined, harness.ctx);
    assert.equal(duplicateNameAfterCollision.isError, true);
    assert.match(duplicateNameAfterCollision.content[0]?.text ?? "", new RegExp(target.id.slice(0, 9)));

    const listAfterCollision = await intercomTool.execute("tool-list-after-collision", {
      action: "list",
    }, new AbortController().signal, undefined, harness.ctx);
    assert.match(listAfterCollision.content[0]?.text ?? "", new RegExp(`\\(${target.id.slice(0, 9)}\\)`));
    assert.match(listAfterCollision.content[0]?.text ?? "", new RegExp(`target:${target.id.slice(0, 9)}`));

    const collisionSafeMessagePromise = once(receiver, "message") as Promise<[SessionInfo, Message]>;
    const collisionSafeResult = await intercomTool.execute("tool-collision-safe", {
      action: "send",
      to: target.id.slice(0, 9),
      message: "longer short id delivery works",
    }, new AbortController().signal, undefined, harness.ctx);
    assert.equal(collisionSafeResult.isError, false);
    const [, collisionSafeMessage] = await collisionSafeMessagePromise;
    assert.equal(collisionSafeMessage.content.text, "longer short id delivery works");
  } finally {
    await duplicateA.disconnect().catch(() => undefined);
    await duplicateB.disconnect().catch(() => undefined);
    await nameCollision.disconnect().catch(() => undefined);
    await harness.emitLifecycle("session_shutdown");
    await cleanup();
  }
});

test("compose overlay preserves complete bracketed pastes as literal content", async () => {
  const sent: Array<{ to: string; text: string; expectsReply: boolean | undefined }> = [];
  let renderRequests = 0;
  let doneResult: unknown;
  const keybindings = {
    matches: (data: string, action: string) => {
      if (action === "tui.select.cancel") return data === "\x1b";
      if (action === "tui.select.confirm") return data === "\r";
      if (action === "tui.editor.deleteCharBackward") return data === "\x7f";
      return false;
    },
    getKeys: (action: string) => action === "tui.select.confirm" ? ["Enter"] : ["Escape"],
  };
  const overlay = new ComposeOverlay(
    { requestRender: () => { renderRequests += 1; } } as never,
    { fg: (_name: string, text: string) => text, bold: (text: string) => text } as never,
    keybindings as never,
    { id: "target-session", name: "worker", cwd: repoDir, model: "test-model" },
    "worker",
    { send: async (to: string, options: { text: string; expectsReply: boolean }) => {
      sent.push({ to, text: options.text, expectsReply: options.expectsReply });
      return { id: "message-1", accepted: true, delivered: true };
    } } as never,
    (result) => { doneResult = result; },
  );

  overlay.handleInput("\x1b[200~\tLine 1\r\n\tLine 2\r\x1b[201~");
  overlay.handleInput("\t");
  overlay.handleInput("x");
  overlay.handleInput("\x7f");
  const rendered = overlay.render(100).join("\n");
  assert.match(rendered, /Request reply to: worker/);
  assert.match(rendered, /Line 1/);
  assert.match(rendered, /Line 2/);

  overlay.handleInput("\r");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(renderRequests >= 4, true);
  assert.deepEqual(sent, [{ to: "target-session", text: "\tLine 1\n\tLine 2\n", expectsReply: true }]);
  assert.deepEqual(doneResult, { sent: true, messageId: "message-1", text: "\tLine 1\n\tLine 2\n", expectsReply: true });

  doneResult = undefined;
  const cancelOverlay = new ComposeOverlay(
    { requestRender: () => undefined } as never,
    { fg: (_name: string, text: string) => text, bold: (text: string) => text } as never,
    keybindings as never,
    { id: "target-session", name: "worker", cwd: repoDir, model: "test-model" },
    "worker",
    { send: async () => ({ id: "unused", accepted: true, delivered: true }) } as never,
    (result) => { doneResult = result; },
  );
  cancelOverlay.handleInput("\x1b");
  assert.deepEqual(doneResult, { sent: false });

  doneResult = undefined;
  const partialPasteOverlay = new ComposeOverlay(
    { requestRender: () => undefined } as never,
    { fg: (_name: string, text: string) => text, bold: (text: string) => text } as never,
    keybindings as never,
    { id: "target-session", name: "worker", cwd: repoDir, model: "test-model" },
    "worker",
    { send: async () => ({ id: "unused", accepted: true, delivered: true }) } as never,
    (result) => { doneResult = result; },
  );
  partialPasteOverlay.handleInput("\x1b[200~unterminated");
  assert.match(partialPasteOverlay.render(100).join("\n"), /unterminated/);
  partialPasteOverlay.handleInput("\x1b");
  assert.equal(doneResult, undefined, "escape bytes inside an incomplete paste are literal paste content");
  partialPasteOverlay.handleInput("\x1b[201~");
  assert.match(partialPasteOverlay.render(100).join("\n"), /unterminated/);
  partialPasteOverlay.handleInput("\x1b");
  assert.deepEqual(doneResult, { sent: false });

  doneResult = undefined;
  const splitPasteOverlay = new ComposeOverlay(
    { requestRender: () => undefined } as never,
    { fg: (_name: string, text: string) => text, bold: (text: string) => text } as never,
    keybindings as never,
    { id: "target-session", name: "worker", cwd: repoDir, model: "test-model" },
    "worker",
    { send: async () => ({ id: "unused", accepted: true, delivered: true }) } as never,
    (result) => { doneResult = result; },
  );
  splitPasteOverlay.handleInput("\x1b[20");
  splitPasteOverlay.handleInput("0~split start marker");
  splitPasteOverlay.handleInput("\x1b[201~");
  assert.match(splitPasteOverlay.render(100).join("\n"), /split start marker/);

  doneResult = undefined;
  const abandonedPasteOverlay = new ComposeOverlay(
    { requestRender: () => undefined } as never,
    { fg: (_name: string, text: string) => text, bold: (text: string) => text } as never,
    keybindings as never,
    { id: "target-session", name: "worker", cwd: repoDir, model: "test-model" },
    "worker",
    { send: async () => ({ id: "unused", accepted: true, delivered: true }) } as never,
    (result) => { doneResult = result; },
  );
  abandonedPasteOverlay.handleInput("\x1b[200~abandoned paste");
  await new Promise((resolve) => setTimeout(resolve, 250));
  abandonedPasteOverlay.handleInput("\x1b");
  assert.deepEqual(doneResult, { sent: false });

  const tailSent: string[] = [];
  const tailOverlay = new ComposeOverlay(
    { requestRender: () => undefined } as never,
    { fg: (_name: string, text: string) => text, bold: (text: string) => text } as never,
    keybindings as never,
    { id: "target-session", name: "worker", cwd: repoDir, model: "test-model" },
    "worker",
    { send: async (_to: string, options: { text: string }) => { tailSent.push(options.text); return { id: "tail", accepted: true, delivered: true }; } } as never,
    () => {},
  );
  tailOverlay.handleInput("\x1b[200~body\x1b[201~tail");
  tailOverlay.handleInput("\r");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(tailSent, ["bodytail"]);
});

test("invalid presence updates cannot poison peer session lists", { concurrency: false }, async () => {
  const broker = await setupBroker();
  const badPeer = new IntercomClient();
  const healthyPeer = new IntercomClient();
  try {
    await connectClient(badPeer, "bad-presence-peer");
    await connectClient(healthyPeer, "healthy-presence-peer");
    badPeer.updatePresence({ name: "bad\u0001name", pendingAsks: 0.5 } as never);
    const deadline = Date.now() + 2_000;
    while (badPeer.isConnected() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(badPeer.isConnected(), false);
    const sessions = await healthyPeer.listSessions();
    assert.equal(sessions.some((session) => session.name === "healthy-presence-peer"), true);
    assert.equal(sessions.some((session) => session.name?.includes("bad")), false);
  } finally {
    await badPeer.disconnect().catch(() => undefined);
    await healthyPeer.disconnect().catch(() => undefined);
    await stopBroker(broker);
  }
});

test("sessions publish automatic lifecycle status", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const { planner, cleanup } = await setupClients();
  let contextIdle = true;
  const harness = createExtensionHarness("status-worker", { hasUI: true, isIdle: () => contextIdle });

  try {
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");

    let statusSession = await waitForSessionStatus(planner, "status-worker", "idle");
    assert.equal(statusSession.acceptsAsks, true);
    assert.equal(statusSession.pendingAsks, 0);
    assert.equal(typeof statusSession.lastSeen, "number");

    const freshEventContext = {
      ...harness.ctx,
      model: { id: "fresh-model" },
      sessionManager: { getSessionId: () => "session-child-test" },
    };
    await harness.emitLifecycle("model_select", { model: { id: "fresh-model" } }, freshEventContext);
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

test("intercom ask returns delivered peer_idle when target publishes acceptsAsks false", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const { planner, cleanup } = await setupClients();
  const peer = new IntercomClient();
  const harness = createExtensionHarness("ask-controller", { hasUI: true });

  try {
    await connectClient(peer, "busy-peer-health", {
      acceptsAsks: false,
      pendingAsks: 1,
      lastIntercomActivity: 0,
    });
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");
    await waitForSessionByName(planner, "ask-controller");
    const target = await waitForSessionByName(planner, "busy-peer-health");
    assert.equal(target.acceptsAsks, false);

    const intercomTool = harness.tools.find((tool) => tool.name === "intercom");
    assert.ok(intercomTool);
    const received = once(peer, "message") as Promise<[SessionInfo, Message]>;
    const result = await intercomTool.execute("ask-peer-idle", {
      action: "ask",
      to: "busy-peer-health",
      message: "Can you answer?",
    }, new AbortController().signal, undefined, harness.ctx);
    const [, message] = await received;

    assert.equal(message.expectsReply, true);
    assert.equal(result.isError, false);
    assert.match(result.content[0]?.text ?? "", /peer_idle/);
    assert.equal(result.details?.delivered, true);
    assert.equal(result.details?.replied, false);
    assert.equal(result.details?.reason, "peer_idle");
  } finally {
    await harness.emitLifecycle("session_shutdown");
    await peer.disconnect().catch(() => undefined);
    await cleanup();
  }
});

test("explicit steer asks wait for replies even when peer health says idle", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const { planner, cleanup } = await setupClients();
  const peer = new IntercomClient();
  const harness = createExtensionHarness("ask-steer-controller", { hasUI: true });

  try {
    await connectClient(peer, "busy-peer-steer", {
      acceptsAsks: false,
      pendingAsks: 1,
      lastIntercomActivity: 0,
    });
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");
    await waitForSessionByName(planner, "ask-steer-controller");
    const target = await waitForSessionByName(planner, "busy-peer-steer");
    assert.equal(target.acceptsAsks, false);

    const intercomTool = harness.tools.find((tool) => tool.name === "intercom");
    assert.ok(intercomTool);
    const resultPromise = intercomTool.execute("ask-peer-steer", {
      action: "ask",
      to: "busy-peer-steer",
      delivery: "steer",
      message: "Can you answer now?",
    }, new AbortController().signal, undefined, harness.ctx);
    const [from, message] = await once(peer, "message") as [SessionInfo, Message];
    assert.equal(message.delivery, "steer");
    assert.equal(message.expectsReply, true);
    await peer.send(from.id, {
      text: "ACK steer",
      replyTo: message.id,
    });
    const result = await resultPromise;

    assert.equal(result.isError, false);
    assert.match(result.content[0]?.text ?? "", /ACK steer/);
    assert.notEqual(result.details?.reason, "peer_idle");
  } finally {
    await harness.emitLifecycle("session_shutdown");
    await peer.disconnect().catch(() => undefined);
    await cleanup();
  }
});

test("explicit queue asks wait for replies even when peer health says idle", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const { planner, cleanup } = await setupClients();
  const peer = new IntercomClient();
  const harness = createExtensionHarness("ask-queue-controller", { hasUI: true });

  try {
    await connectClient(peer, "busy-peer-queue", {
      acceptsAsks: false,
      pendingAsks: 1,
      lastIntercomActivity: 0,
    });
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");
    await waitForSessionByName(planner, "ask-queue-controller");
    const target = await waitForSessionByName(planner, "busy-peer-queue");
    assert.equal(target.acceptsAsks, false);

    const intercomTool = harness.tools.find((tool) => tool.name === "intercom");
    assert.ok(intercomTool);
    const resultPromise = intercomTool.execute("ask-peer-queue", {
      action: "ask",
      to: "busy-peer-queue",
      delivery: "queue",
      message: "Can you answer later?",
    }, new AbortController().signal, undefined, harness.ctx);
    const [from, message] = await once(peer, "message") as [SessionInfo, Message];
    assert.equal(message.delivery, "queue");
    assert.equal(message.expectsReply, true);
    await peer.send(from.id, {
      text: "ACK queue",
      replyTo: message.id,
    });
    const result = await resultPromise;

    assert.equal(result.isError, false);
    assert.match(result.content[0]?.text ?? "", /ACK queue/);
    assert.notEqual(result.details?.reason, "peer_idle");
  } finally {
    await harness.emitLifecycle("session_shutdown");
    await peer.disconnect().catch(() => undefined);
    await cleanup();
  }
});

test("busy interactive sessions idle-gate default asks and steer default sends without aborting", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const { planner, cleanup } = await setupClients();
  let abortCount = 0;
  let idle = false;
  const harness = createExtensionHarness("interactive-worker", {
    abort: () => { abortCount += 1; },
    hasUI: true,
    isIdle: () => idle,
  });

  try {
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");

    const target = await waitForSessionByName(planner, "interactive-worker");

    const delivered = await planner.send(target.id, {
      messageId: "interactive-busy-ask",
      text: "Can you respond after your current turn?",
      expectsReply: true,
    });
    assert.equal(delivered.delivered, true);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(abortCount, 0);
    assert.equal(harness.sentMessages.length, 0);

    idle = true;
    await harness.emitLifecycle("agent_end");
    await harness.emitLifecycle("agent_settled");
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(abortCount, 0);
    assert.equal(harness.sentMessages.length, 1);
    assert.equal(harness.sentMessages[0]?.message.customType, "intercom_message");
    assert.equal(harness.sentMessages[0]?.options?.triggerTurn, true);
    assert.match(harness.sentMessages[0]?.message.content ?? "", /Can you respond after your current turn/);

    idle = false;
    const sent = await planner.send(target.id, {
      messageId: "interactive-busy-send",
      text: "Plain send should steer current work.",
    });
    assert.equal(sent.delivered, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(abortCount, 0);
    assert.equal(harness.sentMessages.length, 2);
    assert.equal(harness.sentMessages[1]?.message.customType, "intercom_message");
    assert.deepEqual(harness.sentMessages[1]?.options, { deliverAs: "steer" });
    assert.match(harness.sentMessages[1]?.message.content ?? "", /Plain send should steer current work/);
  } finally {
    await harness.emitLifecycle("session_shutdown");
    await cleanup();
  }
});

test("busy interactive sessions reject overload instead of silently evicting queued asks", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const { planner, cleanup } = await setupClients();
  const harness = createExtensionHarness("interactive-overload-worker", {
    hasUI: true,
    isIdle: () => false,
  });

  try {
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");
    const target = await waitForSessionByName(planner, "interactive-overload-worker");
    const overloadReply = once(planner, "message") as Promise<[SessionInfo, Message]>;
    for (let index = 0; index <= 100; index += 1) {
      assert.equal((await planner.send(target.id, {
        messageId: `overload-ask-${index}`,
        text: `Queued question ${index}`,
        expectsReply: true,
      })).delivered, true);
    }

    const [, reply] = await overloadReply;
    assert.equal(reply.replyTo, "overload-ask-100");
    assert.match(reply.content.text, /Recipient queue is full/);
    assert.equal(reply.content.attachments?.some((attachment) => attachment.name === "pi-intercom-recipient-turn-failure"), true);
    assert.equal(harness.sentMessages.length, 0);
  } finally {
    await harness.emitLifecycle("session_shutdown");
    await cleanup();
  }
});

test("busy interactive sessions defer explicit queued sends and idle-gate default asks", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const { planner, cleanup } = await setupClients();
  let idle = false;
  const harness = createExtensionHarness("interactive-queue-worker", {
    hasUI: true,
    isIdle: () => idle,
  });

  try {
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");
    const target = await waitForSessionByName(planner, "interactive-queue-worker");

    assert.equal((await planner.send(target.id, {
      messageId: "queued-send-before-ask",
      text: "Context before the question.",
      delivery: "queue",
    })).delivered, true);
    assert.equal((await planner.send(target.id, {
      messageId: "queued-ask-after-send",
      text: "Question that should own reply context.",
      expectsReply: true,
    })).delivered, true);

    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(harness.sentMessages.length, 1);
    assert.deepEqual(harness.sentMessages[0]?.options, { deliverAs: "followUp" });

    idle = true;
    await harness.emitLifecycle("agent_end");
    await harness.emitLifecycle("agent_settled");
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(harness.sentMessages.length, 2);
    assert.match(harness.sentMessages[0]?.message.content ?? "", /Context before the question/);
    assert.deepEqual(harness.sentMessages[0]?.options, { deliverAs: "followUp" });
    assert.match(harness.sentMessages[1]?.message.content ?? "", /Question that should own reply context/);
    assert.deepEqual(harness.sentMessages[1]?.options, { triggerTurn: true });
  } finally {
    await harness.emitLifecycle("session_shutdown");
    await cleanup();
  }
});

test("omitted delivery defaults to steer while explicit queue stays deferred", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const { planner, cleanup } = await setupClients();
  const harness = createExtensionHarness("native-delivery-worker", {
    hasUI: true,
    isIdle: () => false,
  });

  try {
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");
    const target = await waitForSessionByName(planner, "native-delivery-worker");

    assert.equal((await planner.send(target.id, {
      messageId: "default-steer",
      text: "Default to live steer.",
    })).delivered, true);
    assert.equal((await planner.send(target.id, {
      messageId: "native-queue",
      text: "Queue this behind current work.",
      delivery: "queue",
    })).delivered, true);
    assert.equal((await planner.send(target.id, {
      messageId: "native-steer",
      text: "Steer after the current tool.",
      delivery: "steer",
    })).delivered, true);

    await new Promise((resolve) => setImmediate(resolve));
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
});

test("pre-cutover omitted delivery still steers a busy recipient", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const { planner, cleanup } = await setupClients();
  const harness = createExtensionHarness("legacy-delivery-worker", {
    hasUI: true,
    isIdle: () => false,
  });

  try {
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");
    const target = await waitForSessionByName(planner, "legacy-delivery-worker");
    const legacySocket = (planner as unknown as { socket: net.Socket | null }).socket;
    assert.ok(legacySocket);

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
    assert.match(harness.sentMessages[0]?.message.content ?? "", /Legacy sender omitted delivery/);
    assert.deepEqual(harness.sentMessages[0]?.options, { deliverAs: "steer" });
  } finally {
    await harness.emitLifecycle("session_shutdown");
    await cleanup();
  }
});

test("replace queue mode keeps only the latest undelivered message for a thread", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const { planner, cleanup } = await setupClients();
  let idle = false;
  const harness = createExtensionHarness("replace-queue-worker", {
    hasUI: true,
    isIdle: () => idle,
  });

  try {
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");
    const target = await waitForSessionByName(planner, "replace-queue-worker");

    assert.equal((await planner.send(target.id, {
      messageId: "replace-old",
      text: "Old instructions.",
      delivery: "queue",
      queueMode: "replace",
      threadId: "plan",
    })).delivered, true);
    assert.equal((await planner.send(target.id, {
      messageId: "replace-new",
      text: "New instructions.",
      delivery: "queue",
      queueMode: "replace",
      threadId: "plan",
    })).delivered, true);

    await new Promise((resolve) => setTimeout(resolve, 1800));
    assert.equal(harness.sentMessages.length, 0);

    idle = true;
    await harness.emitLifecycle("agent_end");
    await harness.emitLifecycle("agent_settled");
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(harness.sentMessages.length, 1);
    assert.doesNotMatch(harness.sentMessages[0]?.message.content ?? "", /Old instructions/);
    assert.match(harness.sentMessages[0]?.message.content ?? "", /New instructions/);
    assert.deepEqual(harness.sentMessages[0]?.options, { triggerTurn: true });
  } finally {
    await harness.emitLifecycle("session_shutdown");
    await cleanup();
  }
});

test("replace queue mode coalesces quick idle updates before waking", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const { planner, cleanup } = await setupClients();
  const harness = createExtensionHarness("idle-replace-worker", {
    hasUI: true,
    isIdle: () => true,
  });

  try {
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");
    const target = await waitForSessionByName(planner, "idle-replace-worker");

    assert.deepEqual(await planner.send(target.id, {
      messageId: "idle-old",
      text: "OLD idle replacement.",
      delivery: "queue",
      queueMode: "replace",
      threadId: "idle-race",
    }), { id: "idle-old", accepted: true, delivered: false, queued: true, reason: "Queued for replace-mode delivery" });
    assert.deepEqual(await planner.send(target.id, {
      messageId: "idle-final",
      text: "FINAL idle replacement.",
      delivery: "queue",
      queueMode: "replace",
      threadId: "idle-race",
    }), { id: "idle-final", accepted: true, delivered: false, queued: true, reason: "Queued for replace-mode delivery" });

    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(harness.sentMessages.length, 0);
    await new Promise((resolve) => setTimeout(resolve, 1600));

    assert.equal(harness.sentMessages.length, 1);
    assert.doesNotMatch(harness.sentMessages[0]?.message.content ?? "", /OLD idle/);
    assert.match(harness.sentMessages[0]?.message.content ?? "", /FINAL idle/);
    assert.deepEqual(harness.sentMessages[0]?.options, { triggerTurn: true });
  } finally {
    await harness.emitLifecycle("session_shutdown");
    await cleanup();
  }
});

test("broker bounds unique replace-mode threads per sender", { concurrency: false }, async () => {
  const { planner, orchestrator, cleanup } = await setupClients();
  try {
    assert.ok(orchestrator.sessionId);
    orchestrator.updatePresence({ status: "idle", acceptsAsks: true });
    await waitForSessionStatus(planner, "orchestrator", "idle");
    for (let index = 0; index < 100; index++) {
      const result = await planner.send(orchestrator.sessionId, {
        messageId: `replace-bound-${index}`,
        text: `update ${index}`,
        delivery: "queue",
        queueMode: "replace",
        threadId: `unique-thread-${index}`,
      });
      assert.equal(result.accepted, true);
    }
    const rejected = await planner.send(orchestrator.sessionId, {
      messageId: "replace-bound-overflow",
      text: "overflow",
      delivery: "queue",
      queueMode: "replace",
      threadId: "unique-thread-overflow",
    });
    assert.equal(rejected.accepted, false);
    assert.match(rejected.reason ?? "", /queue is full/i);
  } finally {
    await cleanup();
  }
});

test("broker-staged replace delivery survives sender disconnect", { concurrency: false }, async () => {
  const { planner, orchestrator, cleanup } = await setupClients();
  const received: Message[] = [];
  orchestrator.on("message", (_from: SessionInfo, message: Message) => {
    received.push(message);
  });

  try {
    assert.ok(orchestrator.sessionId);
    orchestrator.updatePresence({ status: "idle", acceptsAsks: true });
    await waitForSessionStatus(planner, "orchestrator", "idle");
    const result = await planner.send(orchestrator.sessionId, {
      messageId: "replace-disconnect",
      text: "Deliver after sender disconnects.",
      delivery: "queue",
      queueMode: "replace",
      threadId: "disconnect-window",
    });
    assert.deepEqual(result, { id: "replace-disconnect", accepted: true, delivered: false, queued: true, reason: "Queued for replace-mode delivery" });

    await planner.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 1800));

    assert.equal(received.length, 1);
    assert.equal(received[0]?.id, "replace-disconnect");
    assert.match(received[0]?.content.text ?? "", /sender disconnects/);
  } finally {
    await cleanup();
  }
});

test("broker-staged replace asks are dropped when sender disconnects", { concurrency: false }, async () => {
  const { planner, orchestrator, cleanup } = await setupClients();
  const received: Message[] = [];
  orchestrator.on("message", (_from: SessionInfo, message: Message) => {
    received.push(message);
  });

  try {
    assert.ok(orchestrator.sessionId);
    const result = await planner.send(orchestrator.sessionId, {
      messageId: "replace-ask-disconnect",
      text: "Question after sender disconnects?",
      expectsReply: true,
      delivery: "queue",
      queueMode: "replace",
      threadId: "disconnect-ask-window",
    });
    assert.deepEqual(result, { id: "replace-ask-disconnect", accepted: true, delivered: false, queued: true, reason: "Queued for replace-mode delivery" });

    await planner.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 1800));

    assert.equal(received.length, 0);
  } finally {
    await cleanup();
  }
});

test("recipient-staged replace delivery survives sender disconnect before idle", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const { planner, cleanup } = await setupClients();
  let idle = false;
  const harness = createExtensionHarness("recipient-staged-disconnect-worker", {
    hasUI: true,
    isIdle: () => idle,
  });

  try {
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");
    const target = await waitForSessionByName(planner, "recipient-staged-disconnect-worker");

    assert.equal((await planner.send(target.id, {
      messageId: "recipient-staged-disconnect",
      text: "Deliver after sender disconnects while recipient is busy.",
      delivery: "queue",
      queueMode: "replace",
      threadId: "recipient-disconnect-window",
    })).delivered, true);

    await new Promise((resolve) => setTimeout(resolve, 1800));
    assert.equal(harness.sentMessages.length, 0);
    await planner.disconnect();

    idle = true;
    await harness.emitLifecycle("agent_end");
    await harness.emitLifecycle("agent_settled");
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(harness.sentMessages.length, 1);
    assert.match(harness.sentMessages[0]?.message.content ?? "", /recipient is busy/);
  } finally {
    await harness.emitLifecycle("session_shutdown");
    await cleanup();
  }
});

test("replace queue mode respects lifecycle busy state even when context idle lags", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const { planner, cleanup } = await setupClients();
  const harness = createExtensionHarness("lifecycle-busy-replace-worker", {
    hasUI: true,
    isIdle: () => true,
  });

  try {
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");
    const target = await waitForSessionByName(planner, "lifecycle-busy-replace-worker");
    await harness.emitLifecycle("agent_start");
    await harness.emitLifecycle("tool_execution_start", { toolCallId: "sleep", toolName: "bash" });
    await waitForSessionStatus(planner, "lifecycle-busy-replace-worker", "tool:bash");

    assert.equal((await planner.send(target.id, {
      messageId: "lifecycle-old",
      text: "OLD lifecycle message.",
      delivery: "queue",
      queueMode: "replace",
      threadId: "lifecycle-race",
    })).delivered, true);
    assert.equal((await planner.send(target.id, {
      messageId: "lifecycle-final",
      text: "FINAL lifecycle message.",
      delivery: "queue",
      queueMode: "replace",
      threadId: "lifecycle-race",
    })).delivered, true);

    await new Promise((resolve) => setTimeout(resolve, 1800));
    assert.equal(harness.sentMessages.length, 0);

    await harness.emitLifecycle("tool_execution_end", { toolCallId: "sleep", toolName: "bash" });
    await harness.emitLifecycle("agent_end");
    await harness.emitLifecycle("agent_settled");
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(harness.sentMessages.length, 1);
    assert.doesNotMatch(harness.sentMessages[0]?.message.content ?? "", /OLD lifecycle/);
    assert.match(harness.sentMessages[0]?.message.content ?? "", /FINAL lifecycle/);
    assert.deepEqual(harness.sentMessages[0]?.options, { triggerTurn: true });
  } finally {
    await harness.emitLifecycle("session_shutdown");
    await cleanup();
  }
});

test("replace queue mode also removes older undelivered asks from pending state", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const { planner, cleanup } = await setupClients();
  let idle = false;
  const harness = createExtensionHarness("replace-ask-worker", {
    hasUI: true,
    isIdle: () => idle,
  });

  try {
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");
    const target = await waitForSessionByName(planner, "replace-ask-worker");

    assert.deepEqual(await planner.send(target.id, {
      messageId: "replace-ask-old",
      text: "Old question?",
      expectsReply: true,
      delivery: "queue",
      queueMode: "replace",
      threadId: "decision",
    }), { id: "replace-ask-old", accepted: true, delivered: false, queued: true, reason: "Queued for replace-mode delivery" });
    assert.deepEqual(await planner.send(target.id, {
      messageId: "replace-ask-new",
      text: "New question?",
      expectsReply: true,
      delivery: "queue",
      queueMode: "replace",
      threadId: "decision",
    }), { id: "replace-ask-new", accepted: true, delivered: false, queued: true, reason: "Queued for replace-mode delivery" });

    await new Promise((resolve) => setTimeout(resolve, 1800));
    assert.equal(harness.sentMessages.length, 0);

    const intercomTool = harness.tools.find((tool) => tool.name === "intercom")!;
    const pending = await intercomTool.execute("pending-after-replace", {
      action: "pending",
    }, new AbortController().signal, undefined, harness.ctx);
    assert.equal(pending.isError, false);
    assert.doesNotMatch(pending.content[0]?.text ?? "", /Old question/);
    assert.match(pending.content[0]?.text ?? "", /New question/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const updatedPresence = (await planner.listSessions()).find((session) => session.id === target.id);
    assert.equal(updatedPresence?.pendingAsks, 1);

    idle = true;
    await harness.emitLifecycle("agent_end");
    await harness.emitLifecycle("agent_settled");
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(harness.sentMessages.length, 1);
    assert.doesNotMatch(harness.sentMessages[0]?.message.content ?? "", /Old question/);
    assert.match(harness.sentMessages[0]?.message.content ?? "", /New question/);
    assert.deepEqual(harness.sentMessages[0]?.options, { triggerTurn: true });
  } finally {
    await harness.emitLifecycle("session_shutdown");
    await cleanup();
  }
});

test("busy passive delivery waits for idle without waking the model", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const { planner, cleanup } = await setupClients();
  let idle = false;
  const harness = createExtensionHarness("busy-passive-worker", {
    hasUI: true,
    isIdle: () => idle,
  });

  try {
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");
    const target = await waitForSessionByName(planner, "busy-passive-worker");

    assert.equal((await planner.send(target.id, {
      messageId: "passive-busy",
      text: "Transcript breadcrumb.",
      delivery: "passive",
    })).delivered, true);

    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(harness.sentMessages.length, 0);

    idle = true;
    await harness.emitLifecycle("agent_end");
    await harness.emitLifecycle("agent_settled");
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(harness.sentMessages.length, 1);
    assert.match(harness.sentMessages[0]?.message.content ?? "", /Transcript breadcrumb/);
    assert.equal(harness.sentMessages[0]?.options, undefined);
  } finally {
    await harness.emitLifecycle("session_shutdown");
    await cleanup();
  }
});

test("stale queued subagent progress updates are dropped", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const { planner, cleanup } = await setupClients();
  let idle = false;
  const harness = createExtensionHarness("stale-progress-supervisor", {
    hasUI: true,
    isIdle: () => idle,
  });
  const realNow = Date.now;

  try {
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");
    const target = await waitForSessionByName(planner, "stale-progress-supervisor");

    Date.now = () => realNow() - 120_000;
    assert.equal((await planner.send(target.id, {
      messageId: "stale-progress-update",
      text: [
        "Subagent progress update.",
        "Run: old-run",
        "Agent: scout",
        "Child index: 0",
        "",
        "UPDATE: Starting read-only scout.",
      ].join("\n"),
      delivery: "queue",
      queueMode: "replace",
      threadId: "subagent-progress:old-run:scout:0",
    })).delivered, true);
    Date.now = realNow;

    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(harness.sentMessages.length, 0);

    idle = true;
    await harness.emitLifecycle("agent_end");
    await harness.emitLifecycle("agent_settled");
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(harness.sentMessages.length, 0);
  } finally {
    Date.now = realNow;
    await harness.emitLifecycle("session_shutdown");
    await cleanup();
  }
});

test("intercom tool validates passive and replace delivery options", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const { cleanup } = await setupClients();
  const harness = createExtensionHarness("planner", { hasUI: true });

  try {
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");
    const intercomTool = harness.tools.find((tool) => tool.name === "intercom")!;

    const passiveAsk = await intercomTool.execute("delivery-passive-ask", {
      action: "ask",
      to: "nobody",
      message: "Can I ask passively?",
      delivery: "passive",
    }, new AbortController().signal, undefined, harness.ctx);
    assert.equal(passiveAsk.isError, true);
    const passiveAskText = passiveAsk.content[0]?.text ?? "";
    assert.match(passiveAskText, /delivery='passive' is only valid/);
    assert.match(passiveAskText, /normal send defaults to steer/);
    assert.match(passiveAskText, /ask with delivery='steer' only when the sender must stay alive and cannot safely continue without the reply/);

    const replaceWithoutThread = await intercomTool.execute("delivery-replace-no-thread", {
      action: "send",
      to: "nobody",
      message: "replace me",
      delivery: "queue",
      queueMode: "replace",
    }, new AbortController().signal, undefined, harness.ctx);
    assert.equal(replaceWithoutThread.isError, true);
    assert.match(replaceWithoutThread.content[0]?.text ?? "", /requires a non-empty threadId/);
    assert.equal(replaceWithoutThread.details?.reasonCode, "invalid_queue_arguments");
    assert.equal(replaceWithoutThread.details?.nextActions?.[0]?.action, "send");

    const queueModeWithoutQueue = await intercomTool.execute("queue-mode-without-delivery", {
      action: "send",
      to: "nobody",
      message: "bad mode",
      queueMode: "stack",
    }, new AbortController().signal, undefined, harness.ctx);
    assert.equal(queueModeWithoutQueue.isError, true);
    assert.match(queueModeWithoutQueue.content[0]?.text ?? "", /only valid with delivery='queue'/);
    assert.equal(queueModeWithoutQueue.details?.reasonCode, "invalid_queue_arguments");

    const deliveryOnPending = await intercomTool.execute("delivery-on-pending", {
      action: "pending",
      delivery: "queue",
    }, new AbortController().signal, undefined, harness.ctx);
    assert.equal(deliveryOnPending.isError, true);
    assert.match(deliveryOnPending.content[0]?.text ?? "", /only valid for action='send' or action='ask'/);
    assert.equal(deliveryOnPending.details?.reasonCode, "invalid_queue_arguments");

    const deliveryFailure = await intercomTool.execute("delivery-failure", {
      action: "send",
      to: "missing-fit7-recipient",
      message: "will fail",
    }, new AbortController().signal, undefined, harness.ctx);
    assert.equal(deliveryFailure.isError, true);
    assert.equal(deliveryFailure.details?.reasonCode, "delivery_failed");
    assert.equal(typeof deliveryFailure.details?.messageId, "string");
    assert.deepEqual((deliveryFailure.details?.nextActions as Array<{ action: string }>).map((next) => next.action), ["list", "send"]);

    const ambiguousTarget = await intercomTool.execute("ambiguous-target", {
      action: "send",
      to: "planner",
      message: "target check",
    }, new AbortController().signal, undefined, harness.ctx);
    assert.equal(ambiguousTarget.isError, true);
    assert.match(ambiguousTarget.content[0]?.text ?? "", /matches multiple sessions/);
    assert.equal(ambiguousTarget.details?.reasonCode, "ambiguous_target");
    assert.deepEqual((ambiguousTarget.details?.nextActions as Array<{ action: string }>).map((next) => next.action), ["list", "send"]);

    const noPendingReply = await intercomTool.execute("reply-without-context", {
      action: "reply",
      message: "orphan reply",
    }, new AbortController().signal, undefined, harness.ctx);
    assert.equal(noPendingReply.isError, true);
    assert.match(noPendingReply.content[0]?.text ?? "", /No active intercom context/);
    assert.equal(noPendingReply.details?.reasonCode, "no_pending_reply");
    assert.deepEqual((noPendingReply.details?.nextActions as Array<{ action: string }>).map((next) => next.action), ["pending", "send"]);
  } finally {
    await harness.emitLifecycle("session_shutdown");
    await cleanup();
  }
});

test("intercom ask timeout exposes the original message id and recovery actions", { concurrency: false }, async () => {
  const configPath = path.join(sharedAgentDir, "intercom", "config.json");
  const previousConfig = existsSync(configPath) ? readFileSync(configPath) : undefined;
  let cleanup: (() => Promise<void>) | undefined;
  let harness: ReturnType<typeof createExtensionHarness> | undefined;

  try {
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ askTimeoutMs: 1000 }));
    const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
    const setup = await setupClients();
    cleanup = setup.cleanup;
    harness = createExtensionHarness("timeout-reasons", { hasUI: true });
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");
    const intercomTool = harness.tools.find((tool) => tool.name === "intercom")!;
    const result = await intercomTool.execute("timeout-ask", {
      action: "ask",
      to: setup.planner.sessionId!,
      message: "Will time out",
    }, new AbortController().signal, undefined, harness.ctx);

    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /No reply .* within 1 minute/);
    assert.equal(result.details?.reasonCode, "reply_timeout");
    assert.equal(typeof result.details?.messageId, "string");
    assert.deepEqual((result.details?.nextActions as Array<{ action: string }>).map((next) => next.action), ["status", "list", "send"]);
  } finally {
    if (harness) await harness.emitLifecycle("session_shutdown");
    await cleanup?.();
    if (previousConfig) writeFileSync(configPath, previousConfig);
    else rmSync(configPath, { force: true });
  }
});

test("busy interactive sessions request subagent detach before idle-gating supervisor asks", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const { planner, cleanup } = await setupClients();
  let abortCount = 0;
  let idle = false;
  const detachRequests: string[] = [];
  const harness = createExtensionHarness("interactive-supervisor", {
    abort: () => { abortCount += 1; },
    hasUI: true,
    isIdle: () => idle,
  });

  try {
    piIntercomExtension(harness.pi as never);
    harness.pi.events.on("pi-intercom:detach-request", (payload: unknown) => {
      const requestId = payload && typeof payload === "object" ? (payload as { requestId?: unknown }).requestId : undefined;
      if (typeof requestId !== "string") return;
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
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(abortCount, 0);
    assert.equal(detachRequests.length, 1);
    assert.equal(harness.sentMessages.length, 0);

    idle = true;
    await harness.emitLifecycle("agent_end");
    await harness.emitLifecycle("agent_settled");
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(abortCount, 0);
    assert.equal(harness.sentMessages.length, 1);
    assert.equal(harness.sentMessages[0]?.message.customType, "intercom_message");
    assert.equal(harness.sentMessages[0]?.options?.triggerTurn, true);
    assert.match(harness.sentMessages[0]?.message.content ?? "", /Subagent needs a supervisor decision/);
    assert.match(harness.sentMessages[0]?.message.content ?? "", /please reply with approve/);
  } finally {
    await harness.emitLifecycle("session_shutdown");
    await cleanup();
  }
});

test("steered supervisor decisions and interviews detach the foreground child before reaching the busy parent", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const { planner, cleanup } = await setupClients();
  const detachRequests: string[] = [];
  const messagesSentBeforeDetach: number[] = [];
  const harness = createExtensionHarness("interactive-supervisor-steer", {
    hasUI: true,
    isIdle: () => false,
  });

  try {
    piIntercomExtension(harness.pi as never);
    harness.pi.events.on("pi-intercom:detach-request", (payload: unknown) => {
      const requestId = payload && typeof payload === "object" ? (payload as { requestId?: unknown }).requestId : undefined;
      if (typeof requestId !== "string") return;
      detachRequests.push(requestId);
      messagesSentBeforeDetach.push(harness.sentMessages.length);
      harness.pi.events.emit("pi-intercom:detach-response", { requestId, accepted: true });
    });
    await harness.emitLifecycle("session_start");

    const target = await waitForSessionByName(planner, "interactive-supervisor-steer");
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
      await waitForSentMessages(harness, index + 1);
    }

    assert.equal(detachRequests.length, 2);
    assert.deepEqual(messagesSentBeforeDetach, [0, 1]);
    assert.equal(harness.sentMessages.length, 2);
    assert.equal(harness.sentMessages[0]?.message.customType, "intercom_message");
    assert.equal(harness.sentMessages[0]?.options?.deliverAs, "steer");
    assert.equal(harness.sentMessages[1]?.options?.deliverAs, "steer");
    assert.match(harness.sentMessages[0]?.message.content ?? "", /Subagent needs a supervisor decision/);
    assert.match(harness.sentMessages[1]?.message.content ?? "", /structured supervisor interview/);
  } finally {
    await harness.emitLifecycle("session_shutdown");
    await cleanup();
  }
});

test("deferred startup connect is cancelled on shutdown", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const { planner, cleanup } = await setupClients();
  const harness = createExtensionHarness("shutdown-before-start", { hasUI: true });

  try {
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");
    await harness.emitLifecycle("session_shutdown");
    await new Promise((resolve) => setTimeout(resolve, 50));

    const sessions = await planner.listSessions();
    assert.equal(sessions.some((session) => session.name === "shutdown-before-start"), false);
  } finally {
    await cleanup();
  }
});

test("stale overlay work stops after same-session restart", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const { planner, cleanup } = await setupClients();
  let customCalls = 0;
  let resolveFirstCustom: ((value: unknown) => void) | undefined;
  const ui = {
    notify: () => undefined,
    custom: async () => {
      customCalls += 1;
      if (customCalls > 1) {
        return { sent: false };
      }
      return new Promise((resolve) => {
        resolveFirstCustom = resolve;
      });
    },
  };
  const harness = createExtensionHarness("overlay-worker", { hasUI: true, ui });

  try {
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");
    await waitForSessionByName(planner, "overlay-worker");

    const overlayPromise = Promise.resolve(harness.commands.get("intercom")!("", harness.ctx));
    const deadline = Date.now() + 2000;
    while (!resolveFirstCustom && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(resolveFirstCustom, "overlay should reach the session picker");

    const plannerSession = await waitForSessionByName(planner, "planner");
    await harness.emitLifecycle("session_shutdown");
    await harness.emitLifecycle("session_start");
    resolveFirstCustom(plannerSession);
    await overlayPromise;

    assert.equal(customCalls, 1);
  } finally {
    await harness.emitLifecycle("session_shutdown");
    await cleanup();
  }
});

test("queued inbound messages are discarded after shutdown", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const { planner, cleanup } = await setupClients();
  let idle = false;
  const harness = createExtensionHarness("disposed-worker", {
    hasUI: true,
    isIdle: () => idle,
  });

  try {
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");
    const target = await waitForSessionByName(planner, "disposed-worker");

    const delivered = await planner.send(target.id, {
      messageId: "disposed-ask",
      text: "This should not deliver after shutdown.",
      expectsReply: true,
    });
    assert.equal(delivered.delivered, true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(harness.sentMessages.length, 0);

    await harness.emitLifecycle("session_shutdown");
    idle = true;
    await harness.emitLifecycle("agent_end");
    await harness.emitLifecycle("agent_settled");
    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.equal(harness.sentMessages.length, 0);
  } finally {
    await cleanup();
  }
});

test("busy non-interactive sessions auto-reply to top-level asks without aborting", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const { planner, cleanup } = await setupClients();
  let abortCount = 0;
  const harness = createExtensionHarness("pipe-worker", {
    abort: () => { abortCount += 1; },
    hasUI: false,
    isIdle: () => false,
  });

  try {
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");

    const target = await waitForSessionByName(planner, "pipe-worker");
    await harness.emitLifecycle("agent_start");
    await harness.emitLifecycle("tool_execution_start", { toolCallId: "pipe-tool", toolName: "bash" });

    let unexpectedReply = false;
    const plainSendHandler = () => { unexpectedReply = true; };
    planner.on("message", plainSendHandler);
    const plainSend = await planner.send(target.id, {
      messageId: "pipe-mode-send",
      text: "FYI while busy.",
    });
    assert.equal(plainSend.delivered, true);
    await new Promise((resolve) => setTimeout(resolve, 100));
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
    await new Promise((resolve) => setTimeout(resolve, 1800));
    const replaceSend = await planner.send(target.id, {
      messageId: "pipe-mode-replace-new",
      text: "Latest replace while busy.",
      delivery: "queue",
      queueMode: "replace",
      threadId: "pipe-mode-thread",
    });
    assert.equal(replaceSend.delivered, true);
    await new Promise((resolve) => setTimeout(resolve, 1800));
    assert.equal(harness.sentMessages.length, 1);
    await harness.emitLifecycle("tool_execution_end", { toolCallId: "pipe-tool", toolName: "bash" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(harness.sentMessages.length, 2);
    assert.match(harness.sentMessages[1]?.message.content ?? "", /Latest replace while busy/);
    assert.doesNotMatch(harness.sentMessages[1]?.message.content ?? "", /Old replace/);
    assert.equal(harness.sentMessages[1]?.options?.triggerTurn, true);

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
});

test("intercom tool advertises the steer-first coordination cutover", async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");

  await withChildOrchestratorEnv({}, () => {
    const harness = createExtensionHarness();
    piIntercomExtension(harness.pi as never);
    const intercomTool = harness.tools.find((tool) => tool.name === "intercom")!;
    const guidance = [intercomTool.description, intercomTool.promptSnippet, ...(intercomTool.promptGuidelines ?? [])].join("\n");

    assert.match(guidance, /send defaults to (?:delivery=)?['\"]?steer/i);
    assert.match(guidance, /queue only when delay is intentional/i);
    assert.match(guidance, /supplemental coordination within the active task/i);
    assert.match(guidance, /replace the task only when the message explicitly says so/i);
    assert.match(guidance, /blocking ask only when this process must stay alive/i);
    assert.doesNotMatch(guidance, /steer (?:is )?only for urgent/i);
  });
});

test("supervisor tool registers only when child metadata is present", async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");

  await withChildOrchestratorEnv({}, () => {
    const harness = createExtensionHarness();
    piIntercomExtension(harness.pi as never);
    assert.deepEqual(harness.tools.map((tool) => tool.name), ["intercom"]);
  });

  await withChildOrchestratorEnv({
    orchestratorTarget: "orchestrator",
    runId: "78f659a3",
    agent: "worker",
    index: "0",
    sessionName: "subagent-worker-78f659a3-1",
  }, () => {
    const harness = createExtensionHarness();
    piIntercomExtension(harness.pi as never);
    assert.deepEqual(harness.tools.map((tool) => tool.name), ["contact_supervisor", "intercom"]);
    const supervisorTool = harness.tools.find((tool) => tool.name === "contact_supervisor");
    assert.match(JSON.stringify(supervisorTool?.parameters), /interview_request/);
    assert.match(JSON.stringify(supervisorTool?.parameters), /questions/);
    const guidance = [supervisorTool?.description, supervisorTool?.promptSnippet, ...(supervisorTool?.promptGuidelines ?? [])].join("\n");
    assert.match(guidance, /cannot safely continue/i);
    assert.match(guidance, /interview_request.*multiple structured answers/i);
    assert.match(guidance, /progress_update.*deferred and coalesced/is);
  });
});

test("subagent intercom session name env controls registered presence target", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const { planner, cleanup } = await setupClients();

  try {
    await withChildOrchestratorEnv({
      sessionName: "subagent-worker-78f659a3-1",
    }, async () => {
      const harness = createExtensionHarness("fallback-visible-name");
      piIntercomExtension(harness.pi as never);
      assert.deepEqual(harness.tools.map((tool) => tool.name), ["intercom"]);
      await harness.emitLifecycle("session_start");

      const registered = await waitForSessionByName(planner, "subagent-worker-78f659a3-1");
      assert.equal(registered.name, "subagent-worker-78f659a3-1");
      assert.equal((await planner.listSessions()).some((session) => session.name === "fallback-visible-name"), false);
      await harness.emitLifecycle("session_shutdown");
    });
  } finally {
    await cleanup();
  }
});

test("child supervisor tool resolves target and includes run metadata", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const { orchestrator, cleanup } = await setupClients();

  try {
    await withChildOrchestratorEnv({
      orchestratorTarget: "orchestrator",
      runId: "78f659a3",
      agent: "worker",
      index: "0",
      sessionName: "subagent-worker-78f659a3-1",
    }, async () => {
      const harness = createExtensionHarness("subagent-worker-78f659a3-1");
      piIntercomExtension(harness.pi as never);
      await harness.emitLifecycle("session_start");

      const supervisorTool = harness.tools.find((tool) => tool.name === "contact_supervisor")!;

      const askReceived = once(orchestrator, "message") as Promise<[SessionInfo, Message]>;
      const askResultPromise = supervisorTool.execute("ask-1", { reason: "need_decision", message: "Which API should I use?" }, new AbortController().signal, undefined, harness.ctx);
      const [askFrom, askMessage] = await askReceived;
      assert.equal(askMessage.expectsReply, true);
      assert.equal(askMessage.delivery, "steer");
      assert.match(askMessage.content.text, /Subagent needs a supervisor decision/);
      assert.match(askMessage.content.text, /Run: 78f659a3/);
      assert.match(askMessage.content.text, /Agent: worker/);
      assert.match(askMessage.content.text, /Child index: 0/);
      assert.match(askMessage.content.text, /Which API should I use\?/);

      const reply = await orchestrator.send(askFrom.id, { text: "Use the stable API.", replyTo: askMessage.id });
      assert.equal(reply.delivered, true);
      const askResult = await askResultPromise;
      assert.equal(askResult.isError, false);
      assert.match(askResult.content[0]?.text ?? "", /Use the stable API/);

      const updateReceived = once(orchestrator, "message") as Promise<[SessionInfo, Message]>;
      const updateResult = await supervisorTool.execute("update-1", { reason: "progress_update", message: "Found a schema mismatch." }, new AbortController().signal, undefined, harness.ctx);
      const [_updateFrom, updateMessage] = await updateReceived;
      assert.equal(updateMessage.expectsReply, undefined);
      assert.equal(updateMessage.delivery, "queue");
      assert.equal(updateMessage.queueMode, "replace");
      assert.equal(updateMessage.threadId, "subagent-progress:78f659a3:worker:0");
      assert.match(updateMessage.content.text, /Subagent progress update/);
      assert.match(updateMessage.content.text, /Run: 78f659a3/);
      assert.match(updateMessage.content.text, /Agent: worker/);
      assert.match(updateMessage.content.text, /Found a schema mismatch/);
      assert.equal(updateResult.isError, false);

      const interviewReceived = once(orchestrator, "message") as Promise<[SessionInfo, Message]>;
      const interview = {
        title: "API migration choices",
        description: "Choose the implementation path before edits continue.",
        questions: [
          { id: "context", type: "info", question: "Migration context", context: "Use the existing auth boundary." },
          { id: "api", type: "single", question: "Which API should I target?", options: [" Stable API ", "Experimental API"] },
          { id: "notes", type: "text", question: "Any constraints to preserve?" },
        ],
      };
      const interviewResultPromise = supervisorTool.execute("interview-1", {
        reason: "interview_request",
        message: "Please answer both so I can continue safely.",
        interview,
      }, new AbortController().signal, undefined, harness.ctx);
      const [interviewFrom, interviewMessage] = await interviewReceived;
      assert.equal(interviewMessage.expectsReply, true);
      assert.equal(interviewMessage.delivery, "steer");
      assert.match(interviewMessage.content.text, /Subagent requests a structured supervisor interview/);
      assert.match(interviewMessage.content.text, /Interview: API migration choices/);
      assert.match(interviewMessage.content.text, /\[context\] \(info\) Migration context/);
      assert.match(interviewMessage.content.text, /Info questions are context-only/);
      assert.match(interviewMessage.content.text, /\[api\] \(single\) Which API should I target\?/);
      assert.match(interviewMessage.content.text, /   - Stable API/);
      assert.match(interviewMessage.content.text, /\[notes\] \(text\) Any constraints to preserve\?/);
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
      assert.match(interviewResult.content[0]?.text ?? "", /Stable API/);
      assert.deepEqual(interviewResult.details?.structuredReply, structuredReply);

      const invalidReplyReceived = once(orchestrator, "message") as Promise<[SessionInfo, Message]>;
      const invalidReplyResultPromise = supervisorTool.execute("interview-invalid-reply", {
        reason: "interview_request",
        interview,
      }, new AbortController().signal, undefined, harness.ctx);
      const [invalidReplyFrom, invalidReplyMessage] = await invalidReplyReceived;
      const invalidReply = await orchestrator.send(invalidReplyFrom.id, {
        text: '{"responses":[{"id":"api","value":"Removed API"}]}',
        replyTo: invalidReplyMessage.id,
      });
      assert.equal(invalidReply.delivered, true);
      const invalidReplyResult = await invalidReplyResultPromise;
      assert.equal(invalidReplyResult.isError, false);
      assert.equal(invalidReplyResult.details?.structuredReply, undefined);
      assert.match(String(invalidReplyResult.details?.structuredReplyParseError), /must match one of the question options/);

      await harness.emitLifecycle("session_shutdown");
    });
  } finally {
    await cleanup();
  }
});

test("contact supervisor rejects promptly when the supervisor disconnects before replying", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const { orchestrator, cleanup } = await setupClients();

  try {
    await withChildOrchestratorEnv({
      orchestratorTarget: "orchestrator",
      runId: "78f659a3",
      agent: "worker",
      index: "0",
    }, async () => {
      const harness = createExtensionHarness("subagent-disconnect-worker");
      piIntercomExtension(harness.pi as never);
      await harness.emitLifecycle("session_start");
      const supervisorTool = harness.tools.find((tool) => tool.name === "contact_supervisor")!;
      const askReceived = once(orchestrator, "message") as Promise<[SessionInfo, Message]>;
      const resultPromise = supervisorTool.execute("ask-disconnect", { reason: "need_decision", message: "Which path?" }, new AbortController().signal, undefined, harness.ctx);
      await askReceived;
      await orchestrator.disconnect();

      const result = await Promise.race([
        resultPromise,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("supervisor wait did not reject promptly")), 1000)),
      ]);
      assert.equal(result.isError, true);
      assert.match(result.content[0]?.text ?? "", /Reply peer disconnected before answering/);
      await harness.emitLifecycle("session_shutdown");
    });
  } finally {
    await orchestrator.disconnect().catch(() => undefined);
    await cleanup();
  }
});

test("child supervisor tool throws for execution errors so Pi marks failures", async () => {
  await withChildOrchestratorEnv({
    orchestratorTarget: "orchestrator",
    runId: "run-error-semantics",
    agent: "worker",
    index: "0",
  }, async () => {
    const harness = createExtensionHarness("child-error-semantics", { wrapToolErrors: false });
    const { default: piIntercomExtension } = await import(`../../src/pi-intercom/index.ts?error-semantics=${Date.now()}`);
    piIntercomExtension(harness.pi as never);
    const supervisorTool = harness.tools.find((tool) => tool.name === "contact_supervisor")!;

    await assert.rejects(
      supervisorTool.execute("invalid-raw", { reason: "done", message: "Finished." }, new AbortController().signal, undefined, harness.ctx),
      /Invalid reason/,
    );
  });
});

test("child supervisor tool rejects invalid reasons and interview payloads", async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");

  await withChildOrchestratorEnv({
    orchestratorTarget: "orchestrator",
    runId: "78f659a3",
    agent: "worker",
    index: "0",
  }, async () => {
    const harness = createExtensionHarness();
    piIntercomExtension(harness.pi as never);
    const supervisorTool = harness.tools.find((tool) => tool.name === "contact_supervisor")!;
    const result = await supervisorTool.execute("invalid-1", { reason: "done", message: "Finished." }, new AbortController().signal, undefined, harness.ctx);
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /Invalid reason/);

    const missingMessageResult = await supervisorTool.execute("invalid-message", { reason: "need_decision" }, new AbortController().signal, undefined, harness.ctx);
    assert.equal(missingMessageResult.isError, true);
    assert.match(missingMessageResult.content[0]?.text ?? "", /Missing 'message'/);

    const invalidInterviewResult = await supervisorTool.execute("invalid-interview", { reason: "interview_request", interview: { title: "Bad" } }, new AbortController().signal, undefined, harness.ctx);
    assert.equal(invalidInterviewResult.isError, true);
    assert.match(invalidInterviewResult.content[0]?.text ?? "", /interview\.questions must be a non-empty array/);

    const invalidInfoOptionsResult = await supervisorTool.execute("invalid-info-options", {
      reason: "interview_request",
      interview: {
        questions: [{ id: "context", type: "info", question: "Context", options: ["Not an answer"] }],
      },
    }, new AbortController().signal, undefined, harness.ctx);
    assert.equal(invalidInfoOptionsResult.isError, true);
    assert.match(invalidInfoOptionsResult.content[0]?.text ?? "", /options is only valid for single and multi questions/);
  });
});

test("child supervisor tool preserves delivery failure reasons", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const { cleanup } = await setupClients();

  try {
    await withChildOrchestratorEnv({
      orchestratorTarget: "missing-orchestrator",
      runId: "78f659a3",
      agent: "worker",
      index: "0",
    }, async () => {
      const harness = createExtensionHarness();
      piIntercomExtension(harness.pi as never);
      await harness.emitLifecycle("session_start");
      const supervisorTool = harness.tools.find((tool) => tool.name === "contact_supervisor")!;
      const updateResult = await supervisorTool.execute("update-1", { reason: "progress_update", message: "Blocked." }, new AbortController().signal, undefined, harness.ctx);
      assert.equal(updateResult.isError, true);
      assert.match(updateResult.content[0]?.text ?? "", /Session not found/);
      assert.equal(updateResult.details?.reason, "Session not found");

      const askResult = await supervisorTool.execute("ask-1", { reason: "need_decision", message: "Which path?" }, new AbortController().signal, undefined, harness.ctx);
      assert.equal(askResult.isError, true);
      assert.match(askResult.content[0]?.text ?? "", /Session not found/);

      const secondAskResult = await supervisorTool.execute("ask-2", { reason: "need_decision", message: "Still blocked." }, new AbortController().signal, undefined, harness.ctx);
      assert.equal(secondAskResult.isError, true);
      assert.match(secondAskResult.content[0]?.text ?? "", /Session not found/);
      assert.doesNotMatch(secondAskResult.content[0]?.text ?? "", /Already waiting/);
      await harness.emitLifecycle("session_shutdown");
    });
  } finally {
    await cleanup();
  }
});

test("child supervisor tool clears reply waiter when cancelled", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const { orchestrator, cleanup } = await setupClients();

  try {
    await withChildOrchestratorEnv({
      orchestratorTarget: "orchestrator",
      runId: "78f659a3",
      agent: "worker",
      index: "0",
      sessionName: "subagent-worker-78f659a3-1",
    }, async () => {
      const harness = createExtensionHarness("subagent-worker-78f659a3-1");
      piIntercomExtension(harness.pi as never);
      await harness.emitLifecycle("session_start");
      const supervisorTool = harness.tools.find((tool) => tool.name === "contact_supervisor")!;

      const controller = new AbortController();
      const cancelledMessage = once(orchestrator, "message") as Promise<[SessionInfo, Message]>;
      const cancelledResultPromise = supervisorTool.execute("ask-cancelled", { reason: "need_decision", message: "Should I continue?" }, controller.signal, undefined, harness.ctx);
      await cancelledMessage;
      controller.abort();
      const cancelledResult = await cancelledResultPromise;
      assert.equal(cancelledResult.isError, true);
      assert.match(cancelledResult.content[0]?.text ?? "", /Cancelled/);

      const nextMessage = once(orchestrator, "message") as Promise<[SessionInfo, Message]>;
      const nextResultPromise = supervisorTool.execute("ask-next", { reason: "need_decision", message: "Can I ask again?" }, new AbortController().signal, undefined, harness.ctx);
      const [from, message] = await nextMessage;
      assert.match(message.content.text, /Can I ask again/);
      const reply = await orchestrator.send(from.id, { text: "Yes.", replyTo: message.id });
      assert.equal(reply.delivered, true);
      const nextResult = await nextResultPromise;
      assert.equal(nextResult.isError, false);
      assert.match(nextResult.content[0]?.text ?? "", /Yes\./);
      await harness.emitLifecycle("session_shutdown");
    });
  } finally {
    await cleanup();
  }
});

test("full ask/reply round-trip works with reply target resolved from current turn context", { concurrency: false }, async () => {
  const { planner, orchestrator, cleanup } = await setupClients();
  const replyTracker = new ReplyTracker();

  try {
    const askId = "ask-current-turn";
    const askPromise = once(orchestrator, "message") as Promise<[SessionInfo, Message]>;
    const replyPromise = waitForReply(planner, askId);

    const delivered = await planner.send(orchestrator.sessionId!, {
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
});

test("pending output expands subagent supervisor asks", { concurrency: false }, async () => {
  const { planner, cleanup } = await setupClients();
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const harness = createExtensionHarness("pending-worker", { hasUI: true });

  try {
    piIntercomExtension(harness.pi as never);
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
    await new Promise((resolve) => setImmediate(resolve));

    const intercomTool = harness.tools.find((tool) => tool.name === "intercom")!;
    const result = await intercomTool.execute("pending-supervisor", {
      action: "pending",
    }, new AbortController().signal, undefined, harness.ctx);

    const text = result.content[0]?.text ?? "";
    assert.match(text, /replyTo: "supervisor-pending-ask"/);
    assert.match(text, /intercom\(\{ action: "reply", replyTo: "supervisor-pending-ask", message: "\.\.\." \}\)/);
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

test("subagent identity event exposes only the current connected broker session id", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const { planner, cleanup } = await setupClients();
  const harness = createExtensionHarness("planner", { hasUI: true });
  const responses: Array<{ requestId?: string; sessionId?: string }> = [];
  harness.pi.events.on("subagent:intercom-identity-response", (payload) => responses.push(payload as { requestId?: string; sessionId?: string }));

  try {
    piIntercomExtension(harness.pi as never);
    harness.pi.events.emit("subagent:intercom-identity-request", { requestId: "before-connect" });
    assert.deepEqual(responses, []);

    await harness.emitLifecycle("session_start");
    const intercomTool = harness.tools.find((tool) => tool.name === "intercom")!;
    await intercomTool.execute("connect", { action: "status" }, new AbortController().signal, undefined, harness.ctx);
    harness.pi.events.emit("subagent:intercom-identity-request", { requestId: "connected" });

    assert.equal(responses.length, 1);
    assert.equal(responses[0]?.requestId, "connected");
    assert.equal(typeof responses[0]?.sessionId, "string");
    assert.notEqual(responses[0]?.sessionId, planner.sessionId, "duplicate visible names retain distinct exact identities");
  } finally {
    await harness.emitLifecycle("session_shutdown");
    await cleanup();
  }
});

test("subagent control intercom events wake the current orchestrator session", async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const harness = createExtensionHarness("orchestrator");
  const { sentMessages } = harness;

  piIntercomExtension(harness.pi as never);
  harness.pi.events.emit("subagent:control-intercom", {
    to: "orchestrator",
    message: "subagent needs attention\n\nworker needs attention in run 78f659a3.",
  });
  await new Promise((resolve) => setImmediate(resolve));

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
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(sentMessages, []);

  harness.pi.events.emit("subagent:control-intercom", {
    to: "orchestrator",
    source: "async",
    message: "subagent needs attention\n\nworker needs attention in run async-1.",
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(sentMessages, []);
});

test("async subagent result intercom events wake the current orchestrator session", async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const harness = createExtensionHarness("orchestrator");
  const { sentMessages } = harness;
  const deliveryAcks: unknown[] = [];
  harness.pi.events.on("subagent:result-intercom-delivery", (payload) => deliveryAcks.push(payload));

  piIntercomExtension(harness.pi as never);
  harness.pi.events.emit("subagent:result-intercom", {
    to: "orchestrator",
    requestId: "result-1",
    source: "async",
    message: "subagent result\n\nRun: 78f659a3\nAgent: worker\nStatus: completed",
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0]?.message.customType, "intercom_message");
  assert.match(sentMessages[0]?.message.content ?? "", /From subagent-result/);
  assert.match(sentMessages[0]?.message.content ?? "", /Status: completed/);
  assert.equal(sentMessages[0]?.options?.triggerTurn, true);
  assert.deepEqual(deliveryAcks, [{ requestId: "result-1", delivered: true }]);
});

test("foreground subagent result intercom events reach the current orchestrator before acknowledgment", async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const harness = createExtensionHarness("orchestrator");
  const { sentMessages } = harness;
  const deliveryAcks: unknown[] = [];
  harness.pi.events.on("subagent:result-intercom-delivery", (payload) => deliveryAcks.push(payload));

  piIntercomExtension(harness.pi as never);
  harness.pi.events.emit("subagent:result-intercom", {
    to: "orchestrator",
    requestId: "result-foreground",
    source: "foreground",
    message: "subagent result\n\nRun: c0cefc68\nMode: chain\nStatus: completed",
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0]?.message.content ?? "", /Run: c0cefc68/);
  assert.equal(sentMessages[0]?.options?.triggerTurn, true);
  assert.deepEqual(deliveryAcks, [{ requestId: "result-foreground", delivered: true }]);
});

test("subagent live intercom events steer a registered child", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const broker = await setupBroker();
  const child = new IntercomClient();
  const harness = createExtensionHarness("supervisor");
  const deliveryAcks: unknown[] = [];
  harness.pi.events.on("subagent:live-intercom-delivery", (payload) => deliveryAcks.push(payload));
  try {
    await connectClient(child, "subagent-worker-run-live-1");
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");
    await waitForSessionByName(child, "supervisor");
    const messagePromise = once(child, "message") as Promise<[SessionInfo, Message]>;

    harness.pi.events.emit("subagent:live-intercom", {
      requestId: "live-1",
      to: "subagent-worker-run-live-1",
      message: "please report status",
      delivery: "steer",
    });

    const [, message] = await messagePromise;
    assert.equal(message.content.text, "please report status");
    const deadline = Date.now() + 2000;
    while (deliveryAcks.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(deliveryAcks, [{ requestId: "live-1", delivered: true }]);
  } finally {
    await harness.emitLifecycle("session_shutdown").catch(() => undefined);
    await child.disconnect().catch(() => undefined);
    await stopBroker(broker);
  }
});

test("subagent intercom health queries report registered and missing targets", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const broker = await setupBroker();
  const child = new IntercomClient();
  const harness = createExtensionHarness("supervisor-health");
  const responses: unknown[] = [];
  harness.pi.events.on("subagent:intercom-health-response", (payload) => responses.push(payload));
  try {
    await connectClient(child, "subagent-worker-health-1");
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");
    await waitForSessionByName(child, "supervisor-health");

    harness.pi.events.emit("subagent:intercom-health-request", {
      requestId: "health-1",
      targets: ["subagent-worker-health-1", "missing-child"],
    });
    const deadline = Date.now() + 2000;
    while (responses.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));

    assert.equal(responses.length, 1);
    const response = responses[0] as { requestId?: string; health?: Array<Record<string, unknown>> };
    assert.equal(response.requestId, "health-1");
    const registered = response.health?.find((item) => item.target === "subagent-worker-health-1");
    const missing = response.health?.find((item) => item.target === "missing-child");
    assert.equal(registered?.status, "registered");
    assert.equal(registered?.sessionName, "subagent-worker-health-1");
    assert.equal(missing?.status, "none");
  } finally {
    await harness.emitLifecycle("session_shutdown").catch(() => undefined);
    await child.disconnect().catch(() => undefined);
    await stopBroker(broker);
  }
});

test("async ask can be replied to later from the single pending ask fallback", { concurrency: false }, async () => {
  const { planner, orchestrator, cleanup } = await setupClients();
  const replyTracker = new ReplyTracker();

  try {
    const askId = "ask-later";
    const askPromise = once(orchestrator, "message") as Promise<[SessionInfo, Message]>;
    const replyPromise = waitForReply(planner, askId);

    const delivered = await planner.send(orchestrator.sessionId!, {
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
});

test("subagent live/control event bridges survive an in-process session restart", { concurrency: false }, async () => {
  const { planner, cleanup } = await setupClients();
  const { default: piIntercomExtension } = await import("../../src/pi-intercom/index.ts");
  const harness = createExtensionHarness("restart-bridge-worker", { hasUI: true });
  const sessionName = "restart-bridge-worker";

  try {
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");
    await waitForSessionByName(planner, sessionName);

    // Control bridge: a self-targeted control event delivers locally (no broker send).
    harness.pi.events.emit("subagent:control-intercom", {
      to: sessionName,
      message: "control before restart",
    });
    await new Promise((resolve) => setImmediate(resolve));
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
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(harness.sentMessages[1]?.message.content ?? "", /control after restart/);

    // Live bridge is still handled after the restart: a self-targeted live send resolves
    // to "cannot message the current session" and emits a delivery response, proving the
    // handler registered by registerSubagentLiveEventHandlers actually ran.
    const liveDelivery = new Promise<{ delivered: boolean; reason?: string }>((resolve) => {
      harness.pi.events.on("subagent:live-intercom-delivery", (payload) => {
        resolve(payload as { delivered: boolean; reason?: string });
      });
    });
    harness.pi.events.emit("subagent:live-intercom", {
      requestId: "live-after-restart",
      to: sessionName,
      message: "live after restart",
      delivery: "steer",
    });
    const liveResult = await Promise.race([
      liveDelivery,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
    ]);
    assert.ok(liveResult, "live bridge delivery response should fire after restart");
    assert.equal(liveResult!.delivered, false);
    assert.match(liveResult!.reason ?? "", /Cannot message the current session/);
  } finally {
    await harness.emitLifecycle("session_shutdown");
    await cleanup();
  }
});
