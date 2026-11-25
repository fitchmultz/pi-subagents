import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findPackageJSON } from "node:module";
import { describe as nodeDescribe, it as nodeIt, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { arr, compile, obj, opt, str } from "@earendil-works/pi-schema";
import { backgroundCommands } from "../../src/agent/background-work.ts";
import { childRuntime } from "../../src/agent/child-runtime.ts";
import type { Launch } from "../../src/agent/contracts.ts";
import { loadSDK, packageRoot, runtimeEntry } from "../../src/agent/host.ts";
import { assertValid } from "../../src/shared/schema.ts";
import { isRecord } from "../../src/shared/unknown.ts";

const GEMINI_APIS = ["google-generative-ai", "google-interactions"];

const capturedRequestValidator = compile(
  obj(
    {
      prompt: str(),
      declared: arr(str()),
      systemMessages: arr(
        obj(
          {
            toolsAdded: opt(arr(obj({ name: str() }, { open: true }))),
            toolsRemoved: opt(arr(obj({ name: str() }, { open: true }))),
          },
          { open: true },
        ),
      ),
    },
    { open: true },
  ),
);

function writeFixtureExtension(file: string, sdkRoot: string, logFile: string): void {
  const aiManifest = findPackageJSON(
    "@earendil-works/pi-ai",
    pathToFileURL(path.join(sdkRoot, "dist/index.js")),
  );
  assert.ok(aiManifest !== undefined, "expected companion pi-ai package");
  const aiEntry = pathToFileURL(path.join(path.dirname(aiManifest), "dist/index.js")).href;
  const source = `
import fs from "node:fs";
import { createFauxCore, createProvider, fauxAssistantMessage, fauxToolCall, getCurrentTools } from ${JSON.stringify(aiEntry)};

export default function fixture(pi) {
  const makeResponder = () => (context) => {
    const systemMessages = context.messages.filter((m) => m.role === "system");
    const user = context.messages.findLast((m) => m.role === "user");
    const prompt =
      typeof user?.content === "string"
        ? user.content
        : (user?.content ?? []).map((block) => (block.type === "text" ? block.text : "")).join("");
    fs.appendFileSync(
      ${JSON.stringify(logFile)},
      JSON.stringify({
        prompt,
        declared: getCurrentTools(context.messages).map((t) => t.name),
        systemMessages,
      }) + "\\n",
    );
    const results = context.messages.filter((m) => m.role === "toolResult");
    if (prompt === "TRY_DELEGATE_AND_RUNS" && results.length === 0) {
      return fauxAssistantMessage(
        [
          fauxToolCall("delegate", { prompt: "UNAUTHORIZED_CHILD" }, { id: "tc-delegate" }),
          fauxToolCall("agent_runs", { action: "list" }, { id: "tc-runs" }),
        ],
        { stopReason: "toolUse" },
      );
    }
    return fauxAssistantMessage("DONE");
  };

  for (const api of ${JSON.stringify(GEMINI_APIS)}) {
    const geminiCore = createFauxCore({
      api,
      provider: "fork-cache-" + api,
      models: [{ id: "gemini-4-neon", reasoning: true }],
    });
    const geminiProvider = createProvider({
      id: geminiCore.provider,
      auth: { apiKey: { name: "Faux", resolve: async () => ({ auth: {} }) } },
      // These flags would allow inline changes in the fallback if the API weren't excluded.
      models: geminiCore.models.map((m) => ({
        ...m,
        compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
      })),
      api: { stream: geminiCore.stream, streamSimple: geminiCore.streamSimple },
    });
    geminiCore.setResponses([makeResponder(), makeResponder(), makeResponder()]);
    pi.registerProvider(geminiProvider);
  }

  const claudeCore = createFauxCore({
    api: "anthropic-messages",
    provider: "fork-cache-anthropic",
    models: [{ id: "claude-mid-convo", reasoning: true }],
  });
  const claudeProvider = createProvider({
    id: claudeCore.provider,
    auth: { apiKey: { name: "Faux", resolve: async () => ({ auth: {} }) } },
    models: claudeCore.models.map((m) => ({
      ...m,
      compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
    })),
    api: { stream: claudeCore.stream, streamSimple: claudeCore.streamSimple },
  });
  claudeCore.setResponses([makeResponder(), makeResponder(), makeResponder()]);
  pi.registerProvider(claudeProvider);

  const responsesCore = createFauxCore({
    api: "openai-responses",
    provider: "fork-cache-responses-additions",
    models: [{ id: "gpt-additions-only", reasoning: true }],
  });
  const responsesProvider = createProvider({
    id: responsesCore.provider,
    auth: { apiKey: { name: "Faux", resolve: async () => ({ auth: {} }) } },
    models: responsesCore.models.map((m) => ({
      ...m,
      compat: { supportsMidConvoSystemMessages: true, supportsToolSearch: true },
    })),
    api: { stream: responsesCore.stream, streamSimple: responsesCore.streamSimple },
  });
  responsesCore.setResponses([makeResponder(), makeResponder(), makeResponder()]);
  pi.registerProvider(responsesProvider);

  const responsesChangesCore = createFauxCore({
    api: "openai-responses",
    provider: "fork-cache-responses-changes",
    models: [{ id: "gpt-6.2-changes", reasoning: true }],
  });
  const responsesChangesProvider = createProvider({
    id: responsesChangesCore.provider,
    auth: { apiKey: { name: "Faux", resolve: async () => ({ auth: {} }) } },
    models: responsesChangesCore.models.map((m) => ({
      ...m,
      compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true },
    })),
    api: { stream: responsesChangesCore.stream, streamSimple: responsesChangesCore.streamSimple },
  });
  responsesChangesCore.setResponses([makeResponder(), makeResponder(), makeResponder()]);
  pi.registerProvider(responsesChangesProvider);

  for (const name of ["exposure_probe", "hidden_probe"]) {
    pi.registerTool({
      name,
      label: name,
      description: "Probe tool for child exposure checks",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: () => Promise.resolve({ content: [{ type: "text", text: name }], details: undefined }),
    });
  }
}
`;
  fs.writeFileSync(file, source, "utf8");
}

function readCapturedRequests(logFile: string) {
  const raw = fs.readFileSync(logFile, "utf8").trim();
  if (raw === "") {
    return [];
  }
  return raw.split("\n").map((line) => {
    const parsed: unknown = JSON.parse(line);
    assertValid(capturedRequestValidator, parsed);
    return parsed;
  });
}

function readToolExposureSetting(settingsManager: object, name: string): unknown {
  const fn: unknown = Reflect.get(settingsManager, "getToolExposure");
  if (typeof fn !== "function") {
    return undefined;
  }
  return Reflect.apply(fn, settingsManager, [name]);
}

function isToolResult(value: unknown): value is ToolResultMessage {
  return isRecord(value) && value.role === "toolResult" && typeof value.toolName === "string";
}

function withChildEnv(t: TestContext, owner: string): void {
  const prevRoot = process.env.PI_INTERCOM_ROOT_SESSION_ID;
  const prevParent = process.env.PI_INTERCOM_PARENT_SESSION_ID;
  process.env.PI_INTERCOM_ROOT_SESSION_ID = owner;
  process.env.PI_INTERCOM_PARENT_SESSION_ID = owner;
  t.after(() => {
    if (prevRoot === undefined) {
      delete process.env.PI_INTERCOM_ROOT_SESSION_ID;
    } else {
      process.env.PI_INTERCOM_ROOT_SESSION_ID = prevRoot;
    }
    if (prevParent === undefined) {
      delete process.env.PI_INTERCOM_PARENT_SESSION_ID;
    } else {
      process.env.PI_INTERCOM_PARENT_SESSION_ID = prevParent;
    }
  });
}

async function runParentTurn(
  sdk: Awaited<ReturnType<typeof loadSDK>>,
  options: {
    readonly cwd: string;
    readonly agentDir: string;
    readonly parentDir: string;
    readonly provider: string;
    readonly model: string;
  },
) {
  const prevRoot = process.env.PI_INTERCOM_ROOT_SESSION_ID;
  const prevParent = process.env.PI_INTERCOM_PARENT_SESSION_ID;
  delete process.env.PI_INTERCOM_ROOT_SESSION_ID;
  delete process.env.PI_INTERCOM_PARENT_SESSION_ID;
  try {
    const settingsManager = sdk.SettingsManager.create(options.cwd, options.agentDir, {
      projectTrusted: true,
    });
    const jobs = backgroundCommands(sdk);
    const services = await sdk.createAgentSessionServices({
      cwd: options.cwd,
      agentDir: options.agentDir,
      settingsManager,
      resourceLoaderOptions: {
        additionalExtensionPaths: [runtimeEntry()],
        extensionFactories: [
          {
            name: "codemode",
            builtin: true,
            factory: sdk.createCodemodeExtension({ mode: "on" }),
          },
          { name: "tool_search", builtin: true, factory: sdk.createToolSearchExtension() },
          { name: "mcp", builtin: true, factory: sdk.createMcpExtension() },
          ...(jobs ? [{ name: "background-command", builtin: true, factory: jobs }] : []),
        ],
      },
    });
    const model = services.modelRuntime.getModel(options.provider, options.model);
    assert.ok(model !== undefined, `expected parent model ${options.provider}/${options.model}`);
    const sessionManager = sdk.SessionManager.create(options.cwd, options.parentDir);
    const { session } = await sdk.createAgentSessionFromServices({
      services,
      sessionManager,
      model,
      thinkingLevel: "off",
    });
    try {
      await session.bindExtensions({ mode: "print" });
      await session.prompt("PARENT_TURN", { expandPromptTemplates: false });
      await session.waitForIdle();
      return {
        sessionId: sessionManager.getSessionId(),
        branch: sessionManager.getBranch(),
      };
    } finally {
      await session.abort();
      session.dispose();
    }
  } finally {
    if (prevRoot !== undefined) {
      process.env.PI_INTERCOM_ROOT_SESSION_ID = prevRoot;
    }
    if (prevParent !== undefined) {
      process.env.PI_INTERCOM_PARENT_SESSION_ID = prevParent;
    }
  }
}

async function runChildScenario(
  t: TestContext,
  options: {
    readonly context: "fresh" | "fork";
    readonly provider: string;
    readonly model: string;
    readonly prompt: string;
  },
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fork-cache-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  const parentDir = path.join(root, "parent");
  const runDir = path.join(root, "run");
  for (const dir of [cwd, agentDir, parentDir, runDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const sdkRoot = packageRoot();
  const sdk = await loadSDK(sdkRoot);
  const logFile = path.join(root, "requests.jsonl");
  const fixtureExt = path.join(root, "fixture-ext.mjs");
  writeFixtureExtension(fixtureExt, sdkRoot, logFile);

  fs.writeFileSync(
    path.join(agentDir, "settings.json"),
    JSON.stringify({
      extensions: [fixtureExt],
      defaultProjectTrust: "always",
      retry: { enabled: false },
      compaction: { enabled: false },
      defaultTools: ["+tool_search"],
      subagents: {
        toolExposure: {
          exposure_probe: "deferred",
          hidden_probe: "hidden",
        },
      },
    }),
  );

  let owner = "parent-session-fork-cache";
  let inherited: readonly unknown[] = [];
  if (options.context === "fork") {
    const parent = await runParentTurn(sdk, {
      cwd,
      agentDir,
      parentDir,
      provider: options.provider,
      model: options.model,
    });
    owner = parent.sessionId;
    inherited = parent.branch;
  }

  const sessionManager = sdk.SessionManager.create(cwd, runDir);
  const sessionFile = sessionManager.getSessionFile();
  const header = sessionManager.getHeader();
  assert.ok(sessionFile !== undefined && header !== null);
  fs.writeFileSync(
    sessionFile,
    [header, ...inherited].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    "utf8",
  );

  withChildEnv(t, owner);

  const launch: Launch = {
    version: 1,
    id: "child-run-1",
    rootId: "child-run-1",
    owner,
    cwd,
    agentDir,
    sdk: sdkRoot,
    entry: runtimeEntry(),
    sessionFile,
    sessionId: sessionManager.getSessionId(),
    prompt: options.prompt,
    context: options.context,
    provider: options.provider,
    model: options.model,
    thinking: "off",
    trusted: true,
    createdAt: Date.now(),
  };

  const reopened = sdk.SessionManager.open(sessionFile);
  const runtime = await sdk.createAgentSessionRuntime(
    childRuntime(sdk, launch, {
      directory: runDir,
      token: "test-token",
      saved: undefined,
      started: () => {
        // Session readiness observed via bindExtensions below.
      },
      tool: () => {
        // Tool execution events are not under test here.
      },
    }),
    { cwd, agentDir, sessionManager: reopened },
  );
  t.after(async () => {
    await runtime.dispose();
  });
  await runtime.session.bindExtensions({ mode: "print" });
  await runtime.session.prompt(options.prompt, { expandPromptTemplates: false });
  await runtime.session.waitForIdle();

  const hostExposes =
    typeof Reflect.get(sdk.SettingsManager.prototype, "getToolExposure") === "function";
  if (process.env.PI_COMPAT_HOST === "fork") {
    assert.equal(hostExposes, true, "the qualified fork has the toolExposure setting");
  }
  const requests = readCapturedRequests(logFile);
  return {
    hostExposes,
    settingsManager: runtime.services.settingsManager,
    parentRequest: requests.find((r) => r.prompt === "PARENT_TURN"),
    childRequests: requests.filter((r) => r.prompt === options.prompt),
    toolResults: runtime.session.messages.filter(isToolResult),
  };
}

nodeDescribe("child-runtime fork prompt-cache tool preservation", () => {
  for (const api of GEMINI_APIS) {
    nodeIt(`preserves parent tools and blocks guarded calls on a ${api} fork`, async (t) => {
      const result = await runChildScenario(t, {
        context: "fork",
        provider: `fork-cache-${api}`,
        model: "gemini-4-neon",
        prompt: "TRY_DELEGATE_AND_RUNS",
      });
      const parentRequest = result.parentRequest;
      const firstRequest = result.childRequests[0];
      assert.ok(parentRequest !== undefined && firstRequest !== undefined);
      const expectedDeclared = result.hostExposes
        ? parentRequest.declared.filter((name) => name !== "hidden_probe")
        : parentRequest.declared;
      assert.deepEqual(firstRequest.declared, expectedDeclared);
      assert.equal(firstRequest.declared.includes("delegate"), true);
      assert.equal(firstRequest.declared.includes("agent_runs"), true);
      assert.equal(firstRequest.declared.includes("exposure_probe"), true);

      const laterSystems = firstRequest.systemMessages.slice(1);
      for (const sys of laterSystems) {
        assert.deepEqual(sys.toolsAdded ?? [], []);
        const removedNames = (sys.toolsRemoved ?? []).map((tool) => tool.name);
        assert.deepEqual(removedNames, result.hostExposes ? ["hidden_probe"] : []);
      }

      if (result.hostExposes) {
        assert.equal(readToolExposureSetting(result.settingsManager, "exposure_probe"), "deferred");
        assert.equal(readToolExposureSetting(result.settingsManager, "hidden_probe"), "hidden");
        assert.equal(firstRequest.declared.includes("hidden_probe"), false);
      }

      const delegateResult = result.toolResults.find((m) => m.toolName === "delegate");
      const runsResult = result.toolResults.find((m) => m.toolName === "agent_runs");
      assert.ok(delegateResult !== undefined && runsResult !== undefined);
      assert.equal(delegateResult.isError, true);
      assert.equal(runsResult.isError, true);
      assert.match(
        JSON.stringify(delegateResult.content),
        /Only (?:a main session|main sessions) may delegate/u,
      );
      assert.match(
        JSON.stringify(runsResult.content),
        /Only (?:a main session|main sessions) may delegate/u,
      );
    });
  }

  nodeIt(
    "keeps fresh children hiding delegate/agent_runs and applying subagents.toolExposure",
    async (t) => {
      const result = await runChildScenario(t, {
        context: "fresh",
        provider: "fork-cache-google-generative-ai",
        model: "gemini-4-neon",
        prompt: "FRESH_TURN",
      });
      const firstRequest = result.childRequests[0];
      assert.ok(firstRequest !== undefined, "expected Turn 1 provider request");
      assert.equal(firstRequest.declared.includes("delegate"), false);
      assert.equal(firstRequest.declared.includes("agent_runs"), false);
      if (result.hostExposes) {
        assert.equal(readToolExposureSetting(result.settingsManager, "exposure_probe"), "deferred");
        assert.equal(readToolExposureSetting(result.settingsManager, "hidden_probe"), "hidden");
        assert.equal(firstRequest.declared.includes("exposure_probe"), false);
        assert.equal(firstRequest.declared.includes("hidden_probe"), false);
      }
    },
  );

  nodeIt(
    "keeps forked children on mid-convo-tool-capable models hiding delegate/agent_runs and applying subagents.toolExposure",
    async (t) => {
      const result = await runChildScenario(t, {
        context: "fork",
        provider: "fork-cache-anthropic",
        model: "claude-mid-convo",
        prompt: "CLAUDE_FORK_TURN",
      });
      const firstRequest = result.childRequests[0];
      assert.ok(firstRequest !== undefined, "expected Turn 1 provider request");
      assert.equal(firstRequest.declared.includes("delegate"), false);
      assert.equal(firstRequest.declared.includes("agent_runs"), false);
      if (result.hostExposes) {
        assert.equal(readToolExposureSetting(result.settingsManager, "exposure_probe"), "deferred");
        assert.equal(readToolExposureSetting(result.settingsManager, "hidden_probe"), "hidden");
        assert.equal(firstRequest.declared.includes("hidden_probe"), false);
      }
    },
  );

  nodeIt(
    "preserves parent delegate/agent_runs on additions-only models whose tool removals cannot stay cached",
    async (t) => {
      const result = await runChildScenario(t, {
        context: "fork",
        provider: "fork-cache-responses-additions",
        model: "gpt-additions-only",
        prompt: "TRY_DELEGATE_AND_RUNS",
      });
      const firstRequest = result.childRequests[0];
      assert.ok(firstRequest !== undefined, "expected Turn 1 provider request");
      assert.equal(firstRequest.declared.includes("delegate"), true);
      assert.equal(firstRequest.declared.includes("agent_runs"), true);
      const delegateResult = result.toolResults.find((m) => m.toolName === "delegate");
      assert.equal(delegateResult?.isError, true);
    },
  );

  nodeIt(
    "keeps forked children on OpenAI Responses models with supportsAdditionalTools hiding delegate/agent_runs",
    async (t) => {
      const result = await runChildScenario(t, {
        context: "fork",
        provider: "fork-cache-responses-changes",
        model: "gpt-6.2-changes",
        prompt: "RESPONSES_CHANGES_TURN",
      });
      const firstRequest = result.childRequests[0];
      assert.ok(firstRequest !== undefined, "expected Turn 1 provider request");
      assert.equal(firstRequest.declared.includes("delegate"), false);
      assert.equal(firstRequest.declared.includes("agent_runs"), false);
    },
  );
});
