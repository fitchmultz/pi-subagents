import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentTools,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import {
  AgentSessionRuntime,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const root = mkdtempSync(path.join(tmpdir(), "lazy-coordination-"));
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
process.env.PI_OFFLINE = "1";
const { IntercomClient } = await import("../../src/pi-intercom/broker/client.ts");
const { OWNED_RUN_ENTRY, saveForegroundRun } = await import("../../src/runs/shared/run-records.ts");
const { createSupervisorQuestion, saveQuestionOwner, saveQuestionAnswer } =
  await import("../../src/runs/shared/supervisor-questions.ts");
const broker = spawn(process.execPath, [path.join(repo, "src/pi-intercom/broker/broker.ts")], {
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});
let brokerLog = "";
broker.stdout.setEncoding("utf8");
broker.stderr.setEncoding("utf8");
broker.stdout.on("data", (data: unknown) => {
  assert.ok(typeof data === "string");
  brokerLog += data;
});
broker.stderr.on("data", (data: unknown) => {
  assert.ok(typeof data === "string");
  brokerLog += data;
});
const peer = new IntercomClient();
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  // Observe each broker/session transition before retrying; overlapping probes hide readiness failures.
  // oxlint-disable-next-line no-await-in-loop
  while (!(await check())) {
    assert.ok(Date.now() < deadline, "timed out waiting for broker/session delivery");
    // The next readiness probe must wait for this polling interval.
    // oxlint-disable-next-line no-await-in-loop
    await sleep(10);
  }
}
before(async () => {
  await until(() => brokerLog.includes("Intercom broker started"));
  await peer.connect({ name: "peer", cwd: repo, model: "fixture" });
});
after(async () => {
  await peer.disconnect();
  if (broker.exitCode === null) {
    const done = once(broker, "exit");
    broker.kill("SIGTERM");
    await done;
  }
  rmSync(root, { recursive: true, force: true });
});

async function fixture(
  t: TestContext,
  options: {
    readonly tools?: readonly string[];
    readonly excludeTools?: readonly string[];
    readonly seed?: (manager: SessionManager) => void;
    readonly child?: boolean;
  } = {},
) {
  const agentDir = mkdtempSync(path.join(root, "session-"));
  const name = path.basename(agentDir);
  const manager = SessionManager.create(repo, path.join(agentDir, "sessions"));
  options.seed?.(manager);
  const faux = fauxProvider({ provider: name });
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
  let api: ExtensionAPI | undefined;
  const errors: unknown[] = [];
  const loader = new DefaultResourceLoader({
    cwd: repo,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "Offline coordination selection fixture.",
    additionalExtensionPaths: [
      path.join(repo, "src/extension/index.ts"),
      path.join(repo, "src/pi-intercom/index.ts"),
    ],
    extensionFactories: [
      (pi) => {
        api = pi;
        pi.registerTool({
          name: "unrelated",
          label: "Unrelated",
          description: "Unrelated tool",
          parameters: Type.Object({}),
          async execute() {
            return { content: [], details: {} };
          },
        });
        pi.on("session_start", () => pi.setSessionName(name));
        pi.on("session_before_compact", ({ preparation }) => ({
          compaction: {
            summary: "Earlier fixture turns.",
            firstKeptEntryId: preparation.firstKeptEntryId,
            tokensBefore: preparation.tokensBefore,
          },
        }));
      },
    ],
  });
  const childEnv = {
    PI_SUBAGENT_CHILD: "1",
    PI_SUBAGENT_ORCHESTRATOR_TARGET: "peer",
    PI_SUBAGENT_RUN_ID: name,
    PI_SUBAGENT_CHILD_AGENT: "worker",
    PI_SUBAGENT_CHILD_INDEX: "0",
  };
  if (options.child === true) {
    Object.assign(process.env, childEnv);
  }
  try {
    await loader.reload();
  } finally {
    if (options.child === true) {
      for (const key of Object.keys(childEnv)) {
        delete process.env[key];
      }
    }
  }
  assert.deepEqual(loader.getExtensions().errors, []);
  const sessionOptions = {
    cwd: repo,
    agentDir,
    resourceLoader: loader,
    modelRuntime,
    settingsManager,
    model: faux.getModel(),
    noTools: "builtin" as const,
    tools: options.tools === undefined ? undefined : [...options.tools],
    excludeTools: options.excludeTools === undefined ? undefined : [...options.excludeTools],
  };
  let { session } = await createAgentSession({ ...sessionOptions, sessionManager: manager });
  t.after(async () => {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    await session.abort();
    session.dispose();
    assert.deepEqual(errors, []);
  });
  await session.bindExtensions({
    mode: "print",
    onError: (error) => {
      errors.push(error);
    },
  });
  await until(async () => (await peer.listSessions()).some((item) => item.name === name));
  const active = () => session.getActiveToolNames();
  const call = async (toolName: string, args = {}) => {
    const tool = session.agent.state.tools.find((candidate) => candidate.name === toolName);
    assert.ok(tool, `${toolName} must be executable`);
    return await tool.execute(`fixture-${toolName}`, args, new AbortController().signal);
  };
  const prompt = async (check?: (names: readonly string[]) => void) => {
    faux.setResponses([
      (context) => {
        check?.(getCurrentTools(context.messages).map((tool) => tool.name));
        return fauxAssistantMessage("done");
      },
    ]);
    await session.prompt("Check available tools.");
  };
  const newSession = async () => {
    const services = {
      cwd: repo,
      agentDir,
      resourceLoader: loader,
      modelRuntime,
      settingsManager,
      diagnostics: [],
    };
    const runtime = new AgentSessionRuntime(
      session,
      services,
      async ({ sessionManager, sessionStartEvent }) => {
        await loader.reload();
        return {
          ...(await createAgentSession({ ...sessionOptions, sessionManager, sessionStartEvent })),
          services,
          diagnostics: [],
        };
      },
    );
    runtime.setRebindSession(async (next) => {
      session = next;
      await next.bindExtensions({
        mode: "print",
        onError: (error) => {
          errors.push(error);
        },
      });
    });
    await runtime.newSession();
    return session.sessionManager.getSessionId();
  };
  return {
    session,
    manager,
    faux,
    name,
    active,
    call,
    prompt,
    newSession,
    api: () => {
      assert.ok(api, "extension factory must have loaded");
      return api;
    },
  };
}

const heavy = ["agent_runs", "subagent", "intercom"];
test("fresh native requests stay lean despite presence; discovery enables complete schemas on the very next request", async (t) => {
  const f = await fixture(t);
  assert.equal(
    f.manager.buildSessionProjection().messages.some((message) => message.role === "system"),
    false,
    "fresh registration has no saved native declaration",
  );
  for (const name of heavy) {
    assert.ok(!f.active().includes(name));
  }
  for (const name of ["delegate", "load_subagent", "load_intercom", "unrelated"]) {
    assert.ok(f.active().includes(name));
  }
  await f.prompt((names) => {
    for (const name of heavy) {
      assert.ok(!names.includes(name));
    }
  });
  const leanLeaf = f.manager.getLeafId();
  assert.ok(leanLeaf !== null, "lean prompt must create a persisted native leaf");
  f.faux.setResponses([
    () =>
      fauxAssistantMessage(
        [fauxToolCall("load_subagent", { advanced: false }), fauxToolCall("load_intercom", {})],
        { stopReason: "toolUse" },
      ),
    (context) => {
      const tools = getCurrentTools(context.messages);
      for (const name of ["agent_runs", "intercom", "unrelated"]) {
        assert.ok(tools.some((tool) => tool.name === name));
      }
      assert.ok(!tools.some((tool) => tool.name === "subagent"));
      const runTool = tools.find((tool) => tool.name === "agent_runs");
      const intercomTool = tools.find((tool) => tool.name === "intercom");
      assert.ok(runTool);
      assert.ok(intercomTool);
      assert.ok("properties" in runTool.parameters);
      assert.ok("properties" in intercomTool.parameters);
      const runProperties: unknown = runTool.parameters.properties;
      const intercomProperties: unknown = intercomTool.parameters.properties;
      assert.ok(typeof runProperties === "object" && runProperties !== null);
      assert.ok(typeof intercomProperties === "object" && intercomProperties !== null);
      assert.ok(Object.keys(runProperties).includes("questionId"));
      assert.ok(Object.keys(intercomProperties).includes("attachments"));
      return fauxAssistantMessage("enabled");
    },
  ]);
  await f.session.prompt("Load controls and peer coordination.");
  const loadedLeaf = f.manager.getLeafId();
  assert.ok(loadedLeaf !== null, "loaded prompt must create a persisted native leaf");
  await f.session.reload();
  assert.ok(f.active().includes("agent_runs"));
  assert.ok(f.active().includes("intercom"));
  await f.session.navigateTree(leanLeaf);
  for (const name of heavy) {
    assert.ok(!f.active().includes(name), `lean branch must not inherit ${name}`);
  }
  await f.session.navigateTree(loadedLeaf);
  assert.ok(f.active().includes("agent_runs"));
  assert.ok(f.active().includes("intercom"));
  f.session.setActiveToolsByName(f.active().filter((name) => name !== "intercom"));
  await f.prompt((names) => assert.ok(!names.includes("intercom")));
  await f.session.reload();
  assert.ok(!f.active().includes("intercom"), "native manual deselection survives reload");
  await f.session.compact();
  assert.ok(f.active().includes("agent_runs"));
  assert.ok(!f.active().includes("intercom"));
});

test("native session replacement cannot carry another owner's actionable state", async (t) => {
  const f = await fixture(t, {
    seed(manager) {
      manager.appendCustomEntry(OWNED_RUN_ENTRY, {
        runId: `old-${manager.getSessionId()}`,
        rootRunId: "old",
        ownerSessionId: manager.getSessionId(),
        source: "foreground",
        mode: "single",
        cwd: repo,
        task: "Unconfirmed old work",
        startedAt: Date.now(),
        children: [],
      });
    },
  });
  assert.ok(f.active().includes("agent_runs"));
  assert.notEqual(await f.newSession(), f.manager.getSessionId());
  for (const name of heavy) {
    assert.ok(!f.active().includes(name), `new owner must not inherit ${name}`);
  }
  await f.prompt((names) => {
    for (const name of heavy) {
      assert.ok(!names.includes(name));
    }
  });
});

for (const tools of [
  undefined,
  [
    "delegate",
    "agent_runs",
    "subagent",
    "intercom",
    "load_subagent",
    "load_intercom",
    "late",
    "unrelated",
  ],
]) {
  test(`late registration preserves lazy policy and unrelated exact tool identities (${tools === undefined ? "default" : "explicit"} policy)`, async (t) => {
    const f = await fixture(t, { tools });
    await f.prompt();
    f.api().registerTool({
      name: "late",
      label: "Late",
      description: "Registered after startup",
      parameters: Type.Object({}),
      async execute() {
        return { content: [], details: {} };
      },
    });
    await f.prompt((names) => {
      for (const name of heavy) {
        assert.ok(!names.includes(name), `${name} should stay lazy after registration`);
      }
    });
    await f.call("load_subagent", { advanced: false });
    await f.call("load_intercom");
    // Namespace support is optional; exercise exact foreign references on the enhanced host.
    if ("getActiveToolReferences" in f.session && tools === undefined) {
      f.api().registerTool({
        name: "agent_runs",
        namespace: { name: "foreign", description: "Unrelated tool namespace" },
        label: "Foreign",
        description: "Unrelated namespaced tool",
        parameters: Type.Object({}),
        async execute() {
          return { content: [], details: {} };
        },
      });
      const foreign = f.session.getAllTools().find((tool) => tool.namespace?.name === "foreign");
      assert.ok(foreign && "id" in foreign && typeof foreign.id === "string");
      const id = foreign.id;
      assert.ok(f.active().includes(id));
      f.session.setActiveToolsByName(f.active().filter((name) => !heavy.includes(name)));
      await f.call("load_subagent", { advanced: false });
      await f.call("load_intercom");
      assert.ok(f.active().includes(id), "adding global tools must preserve exact foreign IDs");
      await f.prompt();
    } else {
      await f.prompt();
    }
    assert.ok(f.active().includes("agent_runs"));
    assert.ok(f.active().includes("intercom"));
  });
}

for (const name of heavy) {
  test(`explicit ${name} policy without loaders stays usable`, async (t) => {
    const f = await fixture(t, { tools: [name] });
    assert.deepEqual(f.active(), [name]);
  });
}

test("explicit policies without loaders stay usable, while discovery and inbound never revive denied controls", async (t) => {
  const f = await fixture(t, { excludeTools: heavy });
  await assert.rejects(() => f.call("load_intercom"), /excluded/);
  await assert.rejects(() => f.call("load_subagent", { advanced: false }), /excluded/);
  f.faux.setResponses([fauxAssistantMessage("handled without denied tools")]);
  await peer.send(f.name, { text: "Required coordination", delivery: "steer" });
  await until(() => f.faux.state.callCount > 0);
  await f.session.waitForIdle();
  for (const name of heavy) {
    assert.ok(!f.active().includes(name));
  }
});

for (const kind of ["unreviewed", "reviewed", "foreign", "question", "question-only"] as const) {
  test(`owned actionable restoration enables controls, not reviewed inert history or inherited ownership (${kind})`, async (t) => {
    const f = await fixture(t, {
      seed(manager) {
        const runId = `restore-${kind}-${manager.getSessionId()}`;
        const ownerSessionId = kind === "foreign" ? "foreign-owner" : manager.getSessionId();
        saveQuestionOwner(runId, ownerSessionId);
        saveForegroundRun({
          runId,
          mode: "single",
          cwd: repo,
          results: [
            {
              agent: "worker",
              task: "Completed work",
              exitCode: 0,
              finalOutput: "done",
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
            },
          ],
        });
        if (kind !== "question-only") {
          manager.appendCustomEntry(OWNED_RUN_ENTRY, {
            runId,
            rootRunId: runId,
            ownerSessionId,
            source: "foreground",
            mode: "single",
            cwd: repo,
            task: "Restored work",
            startedAt: Date.now(),
            children: [{ agent: "worker", index: 0 }],
            ...(kind === "reviewed" || kind === "question"
              ? { review: { decision: "accepted", reviewedAt: Date.now() } }
              : {}),
          });
        }
        if (kind === "question" || kind === "question-only") {
          createSupervisorQuestion({
            runId,
            ownerTarget: "peer",
            agent: "worker",
            index: 0,
            childSessionId: "child",
            childTarget: "child",
            sessionFile: path.join(root, "child.jsonl"),
            cwd: repo,
            pid: process.pid,
            reason: "need_decision",
            message: "Decision required",
          });
        }
      },
    });
    assert.equal(
      f.active().includes("agent_runs"),
      kind === "unreviewed" || kind === "question" || kind === "question-only",
      kind,
    );
    assert.ok(!f.active().includes("subagent"));
  });
}

test("broker presence/passive and synthetic notices stay lean; peer asks activate before delivery and survive consumed-message reload", async (t) => {
  const f = await fixture(t);
  await peer.send(f.name, { text: "Passive breadcrumb", delivery: "passive" });
  await until(() =>
    f.manager
      .getEntries()
      .some(
        (entry) =>
          entry.type === "custom_message" &&
          JSON.stringify(entry.content).includes("Passive breadcrumb"),
      ),
  );
  assert.ok(!f.active().includes("intercom"));
  assert.equal(f.faux.state.callCount, 0);
  f.faux.setResponses([
    (context) => {
      assert.ok(!getCurrentTools(context.messages).some((tool) => tool.name === "intercom"));
      return fauxAssistantMessage("noted completion");
    },
  ]);
  f.api().events.emit("subagent:result-intercom", {
    to: f.name,
    message: "Routine subagent completion",
  });
  await until(() => f.faux.state.callCount === 1);
  await f.session.waitForIdle();
  assert.ok(!f.active().includes("intercom"));
  f.faux.setResponses([
    (context) => {
      assert.ok(getCurrentTools(context.messages).some((tool) => tool.name === "intercom"));
      return fauxAssistantMessage("question seen, not answered yet");
    },
  ]);
  await peer.send(f.name, {
    text: "Which approach?",
    messageId: "reply-needed",
    delivery: "steer",
    expectsReply: true,
  });
  await until(() => f.faux.state.callCount === 2);
  await f.session.waitForIdle();
  assert.ok(f.active().includes("intercom"));
  // Remove the schema through a real native request: reload must now use the outstanding ask, not the old loadout.
  f.session.setActiveToolsByName(f.active().filter((name) => name !== "intercom"));
  await f.prompt();
  await f.session.reload();
  assert.ok(f.active().includes("intercom"));
  assert.match(JSON.stringify(await f.call("intercom", { action: "pending" })), /reply-needed/);
  await f.call("intercom", {
    action: "reply",
    replyTo: "reply-needed",
    message: "Use the existing approach.",
  });
  f.session.setActiveToolsByName(f.active().filter((name) => name !== "intercom"));
  await f.prompt();
  await f.session.reload();
  assert.ok(!f.active().includes("intercom"), "a saved reply retires the recovery need");
});

for (const resolution of ["disconnect", "error", "answer", "saved-answer"] as const) {
  test(`recovery does not resurrect consumed asks retired by ${resolution}`, async (t) => {
    const f = await fixture(t);
    const sender = new IntercomClient();
    t.after(() => sender.disconnect());
    await sender.connect({ name: `sender-${f.name}`, cwd: repo, model: "fixture" });
    let question;
    if (resolution.includes("answer")) {
      saveQuestionOwner(f.name, f.manager.getSessionId());
      question = createSupervisorQuestion({
        runId: f.name,
        ownerTarget: "peer",
        agent: "worker",
        index: 0,
        childSessionId: "child",
        childTarget: "child",
        sessionFile: path.join(root, "saved-child.jsonl"),
        cwd: repo,
        pid: process.pid,
        reason: "need_decision",
        message: "Decision needed",
      });
    }
    const messageId = question?.questionId ?? `ask-${resolution}`;
    f.faux.setResponses([
      fauxAssistantMessage(
        "Question received",
        resolution === "error"
          ? { stopReason: "error", errorMessage: "Fixture recipient failure" }
          : {},
      ),
    ]);
    await sender.send(f.name, {
      messageId,
      text: question ? `Question ID: ${messageId}\nDecision needed` : "Decision needed",
      delivery: "steer",
      expectsReply: true,
    });
    await until(() => f.faux.state.callCount === 1);
    await f.session.waitForIdle();
    if (resolution === "disconnect") {
      await sender.disconnect();
    }
    if (question) {
      saveQuestionAnswer(question, "Use the current API.");
      if (resolution === "answer") {
        f.api().events.emit("subagent:supervisor-question-resolved", { questionId: messageId });
      }
    }
    if (resolution !== "saved-answer") {
      await until(async () =>
        JSON.stringify(await f.call("intercom", { action: "pending" })).includes(
          "No unresolved inbound asks",
        ),
      );
    }
    f.session.setActiveToolsByName(f.active().filter((name) => name !== "intercom"));
    await f.prompt();
    await f.session.reload();
    assert.ok(
      !f.active().includes("intercom"),
      `${resolution} must retire the reply obligation across reload`,
    );
  });
}

test("owned human-origin messages reach chat without loading peer controls", async (t) => {
  const f = await fixture(t, { child: true });
  const ownerId = "human-owner";
  saveQuestionOwner(f.name, ownerId);
  const human = new IntercomClient();
  t.after(() => human.disconnect());
  await human.connect(
    { name: "human-owner", cwd: repo, model: "fixture" },
    `pi-${createHash("sha256").update(ownerId).digest("hex").slice(0, 32)}`,
  );
  f.faux.setResponses([
    (context) => {
      assert.ok(!getCurrentTools(context.messages).some((tool) => tool.name === "intercom"));
      assert.match(JSON.stringify(context), /Direct user message to this agent/);
      return fauxAssistantMessage("Answered in this conversation");
    },
  ]);
  await human.send(f.name, {
    text: "Keep the approved scope.",
    delivery: "steer",
    human: { ownerSessionId: ownerId, runId: f.name, index: 0 },
  });
  await until(() => f.faux.state.callCount === 1);
  await f.session.waitForIdle();
  assert.ok(!f.active().includes("intercom"));
});

test("managed children retain eager supervisor contact without eager peer schemas", async (t) => {
  const f = await fixture(t, { child: true });
  assert.ok(f.active().includes("contact_supervisor"));
  assert.ok(!f.active().includes("intercom"));
  await f.call("contact_supervisor", {
    reason: "progress_update",
    message: "Material fixture discovery",
  });
  assert.ok(!f.active().includes("intercom"));
});
