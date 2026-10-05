import { createSubagentState } from "../support/background-fixtures.ts";
import { readChildCall } from "../support/child-process-receipts.ts";
import { assertDefined, parseJson, textAt, record as objectRecord } from "../support/assertions.ts";
import "../support/isolated-home.ts";
import { describe, it, before, after, beforeEach, afterEach, mock } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxProvider } from "@earendil-works/pi-ai";
import { customInteraction } from "../support/custom-interaction.ts";
import {
  type SubagentExecutionResult,
  type ReadonlyInput,
  INTERCOM_DETACH_REQUEST_EVENT,
} from "../../src/shared/types.ts";

const nativeOpen = SessionManager.open.bind(SessionManager);
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { discoverAgents } from "../../src/agents/agents.ts";
import type { ExecutorDeps } from "../../src/runs/foreground/subagent-params.ts";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { readAsyncResultFile } from "../../src/runs/background/async-result-file.ts";
import { getRunMetadataDir } from "../../src/runs/shared/supervisor-questions.ts";
import {
  type MockPi,
  createEventBus,
  createNativeSessionFixture,
  makeMinimalCtx,
  makeAgent,
  createMockPi,
  createTempDir,
  events,
  removeTempDir,
} from "../support/helpers.ts";

type ProgressUpdate = ReadonlyInput<SubagentExecutionResult>;

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;

interface SessionStubOptions {
  sessionFile?: string;
  leafId?: string | null;
}

function makeSessionManagerRecorder(options: Readonly<SessionStubOptions> = {}) {
  const manager = SessionManager.inMemory(process.cwd(), { id: "session-123" });
  manager.getSessionFile = () => options.sessionFile;
  manager.getLeafId = () => (options.leafId === undefined ? "leaf-current" : options.leafId);
  manager.getSessionDir = () =>
    options.sessionFile === undefined ? process.cwd() : path.dirname(options.sessionFile);
  return { manager };
}

function makeState(cwd: string) {
  return createSubagentState(cwd);
}

const nativeRoot = createTempDir("fork-sdk-");
const native = await createNativeSessionFixture({ cwd: nativeRoot, agentDir: nativeRoot });
after(async () => {
  await native.dispose();
  removeTempDir(nativeRoot);
});

describe("fork context execution wiring", () => {
  let tempDir: string;
  let mockPi: MockPi;

  before(() => {
    mockPi = createMockPi();
    mockPi.install();
  });

  after(() => {
    mockPi.uninstall();
  });

  beforeEach(() => {
    tempDir = createTempDir("pi-subagent-fork-test-");
    mockPi.reset();
    mockPi.onCall({ output: "ok" });
  });

  afterEach(() => {
    mock.restoreAll();
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
    if (originalPiCodingAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
    }
    removeTempDir(tempDir);
  });

  function makeExecutor() {
    return makeExecutorWithConfig({});
  }

  function makeExecutorWithConfig(config: Readonly<Record<string, unknown>>) {
    return makeExecutorWithDiscoverAgents(
      () => ({
        agents: [
          {
            ...makeAgent("echo", { inheritProjectContext: true, inheritSkills: true }),
            name: "echo",
            description: "Echo test agent",
          },
          {
            ...makeAgent("second", { inheritProjectContext: true, inheritSkills: true }),
            name: "second",
            description: "Second test agent",
          },
          {
            ...makeAgent("reviewer", { inheritProjectContext: true, inheritSkills: true }),
            name: "reviewer",
            description: "Review test agent",
          },
        ],
        projectAgentsDir: null,
      }),
      config,
    );
  }

  function makeExecutorWithDiscoverAgents(
    discoverAgentsImpl: ExecutorDeps["discoverAgents"],
    config: Readonly<Record<string, unknown>> = {},
  ) {
    const eventsApi = createEventBus();
    return Object.assign(
      createSubagentExecutor({
        pi: {
          ...native.pi,
          events: eventsApi,
        },
        state: makeState(tempDir),
        config,
        asyncByDefault: false,
        tempArtifactsDir: tempDir,
        getSubagentSessionRoot: () => tempDir,
        expandTilde: (p: string) => p,
        discoverAgents: discoverAgentsImpl,
      }),
      { eventsApi },
    );
  }

  async function savedOwnerResult(runId: string) {
    const file = path.join(getRunMetadataDir(runId), "result.json"),
      deadline = Date.now() + 10_000;
    while (!fs.existsSync(file)) {
      assert.ok(Date.now() < deadline, "owner publishes its terminal result after wait detachment");
      // Observe the owner publication before advancing this lifecycle transition.
      // oxlint-disable-next-line no-await-in-loop
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    }
    return readAsyncResultFile(file);
  }

  function readCallArgs(): string[] {
    const callFile = fs
      .readdirSync(mockPi.dir)
      .filter((name) => name.startsWith("call-") && name.endsWith(".json"))
      .sort()
      .at(-1);
    assert.ok(Boolean(callFile), "expected a recorded mock pi call");
    assertDefined(callFile);
    return readRecordedArgs(callFile);
  }

  function readAllCallArgs(): string[][] {
    return readAllCallRecords().map((record) => record.args);
  }

  function readAllCallRecords(): Array<{ args: string[]; env?: Record<string, string | null> }> {
    return fs
      .readdirSync(mockPi.dir)
      .filter((name) => name.startsWith("call-") && name.endsWith(".json"))
      .sort()
      .map(readRecordedCall);
  }

  function readRecordedCall(callFile: string): {
    args: string[];
    env?: Record<string, string | null>;
  } {
    const payload = readChildCall(path.join(mockPi.dir, callFile));
    assert.equal(typeof payload, "object", "expected recorded args payload");
    assert.notEqual(payload, null, "expected recorded args payload");
    assert.ok("args" in payload, "expected recorded args payload");
    assert.ok(Array.isArray(payload.args), "expected recorded args");
    return payload;
  }

  function readRecordedArgs(callFile: string): string[] {
    return readRecordedCall(callFile).args;
  }

  function readSessionArgsFromCalls(): string[] {
    return readAllCallArgs()
      .map((args) => {
        const sessionIndex = args.indexOf("--session");
        if (sessionIndex === -1) {
          return;
        }
        const sessionFile = args[sessionIndex + 1];
        assert.ok(Boolean(sessionFile), "expected a session file after --session");
        return sessionFile;
      })
      .filter((sessionFile): sessionFile is string => Boolean(sessionFile));
  }

  function toolsArg(args: readonly string[]): string {
    const index = args.indexOf("--tools");
    return index === -1 ? "" : (args[index + 1] ?? "");
  }

  function callArgsForTaskContaining(text: string): string[] {
    const record = callRecordForTaskContaining(text);
    return record.args;
  }

  function callRecordForTaskContaining(text: string): {
    args: string[];
    env?: Record<string, string | null>;
  } {
    const record = readAllCallRecords().find((call) => (call.args.at(-1) ?? "").includes(text));
    assert.ok(record, `expected recorded call containing task text: ${text}`);
    return record;
  }

  function isNativeFork(sessionFile: string): boolean {
    if (path.dirname(sessionFile) !== tempDir || !fs.existsSync(sessionFile)) {
      return false;
    }
    const header = objectRecord(parseJson(fs.readFileSync(sessionFile, "utf8").split("\n")[0]));
    return typeof header.parentSession === "string";
  }

  function forkedSessionFile(index: number): string {
    const files = fs
      .readdirSync(tempDir)
      .filter((file) => file.endsWith(".jsonl"))
      .map((file) => path.join(tempDir, file))
      .filter(isNativeFork);
    assert.ok(Boolean(files[index - 1]), "expected an actual native fork journal");
    return files[index - 1];
  }

  function countForkedSessionFiles(sessionArgs: readonly string[]): number {
    return sessionArgs.filter(isNativeFork).length;
  }

  async function waitForTaskCalls(tasks: readonly string[], timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (
      !tasks.every((task) => readAllCallArgs().some((args) => (args.at(-1) ?? "").includes(task)))
    ) {
      if (Date.now() > deadline) {
        assert.fail(`Timed out waiting for mock pi tasks: ${tasks.join(", ")}`);
      }
      // Observe the owner publication before advancing this lifecycle transition.
      // oxlint-disable-next-line no-await-in-loop
      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });
    }
  }

  function makeForkingSessionManagerRecorder(options: {
    readonly sessionFile: string;
    readonly leafId: string;
  }) {
    const parent = SessionManager.create(tempDir, tempDir);
    parent.appendMessage({
      role: "user",
      content: `Inherited context ${options.leafId}`,
      timestamp: 1,
    });
    parent.appendMessage(events.assistantMessage("Persisted parent response").message);
    const defined8726_0 = parent.getSessionFile();
    assertDefined(defined8726_0);
    const generated = defined8726_0;
    fs.copyFileSync(generated, options.sessionFile);
    fs.unlinkSync(generated);
    const manager = nativeOpen(options.sessionFile, tempDir);
    const openedPaths: string[] = [],
      branchedLeafIds: string[] = [];
    mock.method(SessionManager, "open", (file: string, dir?: string) => {
      openedPaths.push(file);
      const branch = nativeOpen(file, dir);
      const create = branch.createBranchedSession.bind(branch);
      mock.method(branch, "createBranchedSession", (leaf: string) => {
        branchedLeafIds.push(leaf);
        return create(leaf);
      });
      return branch;
    });
    return { manager, openedPaths, branchedLeafIds };
  }

  function writeAgent(projectRoot: string, name: string, model: string): void {
    const filePath = path.join(projectRoot, ".pi", "agents", `${name}.md`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      `---\nname: ${name}\ndescription: ${name} agent\nmodel: ${model}\n---\n\nUse ${model}.\n`,
      "utf-8",
    );
  }

  function writeProjectOverride(projectRoot: string, agentName: string, model: string): void {
    const settingsPath = path.join(projectRoot, ".pi", "settings.json");
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ subagents: { agentOverrides: { [agentName]: { model } } } }, null, 2),
      "utf-8",
    );
  }

  function writePackageSkill(packageRoot: string, skillName: string): void {
    const skillDir = path.join(packageRoot, "skills", skillName);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify(
        {
          name: `${skillName}-pkg`,
          version: "1.0.0",
          pi: { skills: [`./skills/${skillName}`] },
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      `---\nname: ${skillName}\ndescription: test skill\n---\nbody\n`,
      "utf-8",
    );
  }

  function makeCtx(sessionManager: SessionManager) {
    return makeMinimalCtx(tempDir, { sessionManager });
  }

  it("runs a single agent when task is omitted", async () => {
    const { manager } = makeSessionManagerRecorder();
    const executor = makeExecutor();

    const result = await executor.execute({
      toolCallId: "id",
      params: { agent: "echo" },
      signal: new AbortController().signal,
      ctx: makeCtx(manager),
    });

    assert.equal(result.isError, undefined);
    const args = readCallArgs();
    assert.equal(args.at(-1) ?? "", "Task: ");
  });

  it("raises short foreground reviewer timeouts instead of launching with a brittle budget", async () => {
    const { manager } = makeSessionManagerRecorder();
    const executor = makeExecutor();
    mockPi.reset();
    mockPi.onCall({ delay: 250, output: "review complete" });

    const result = await executor.execute({
      toolCallId: "id",
      params: { agent: "reviewer", task: "Review this diff", timeoutMs: 180 },
      signal: new AbortController().signal,
      ctx: makeCtx(manager),
    });

    assert.equal(result.isError, undefined);
    assert.match(textAt(result.content), /review complete/);
    assert.equal(
      fs.readdirSync(mockPi.dir).some((name) => name.startsWith("call-")),
      true,
    );
  });

  it("uses local duration history before raising planner foreground budgets", async () => {
    const { recordRun } = await import("../../src/runs/shared/run-history.ts");
    const agent = `planner-history-${process.pid}`;
    for (let index = 0; index < 3; index++) {
      recordRun(agent, "old", 0, 1000);
    }
    const { manager } = makeSessionManagerRecorder();
    const executor = makeExecutorWithDiscoverAgents(() => ({
      agents: [
        {
          ...makeAgent(agent, { inheritProjectContext: true, inheritSkills: true }),
          name: agent,
          description: "Planner",
        },
      ],
      projectAgentsDir: null,
    }));
    mockPi.reset();
    mockPi.onCall({ delay: 250, output: "planner complete" });

    const result = await executor.execute({
      toolCallId: "id",
      params: { agent, task: "Plan slowly", timeoutMs: 180 },
      signal: new AbortController().signal,
      ctx: makeCtx(manager),
    });

    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.match(textAt(result.content), /planner complete/);
  });

  it("does not raise parallel timeouts because an ignored top-level agent is reviewer", async () => {
    const { manager } = makeSessionManagerRecorder();
    const executor = makeExecutor();
    mockPi.reset();
    mockPi.onCall({ delay: 250, output: "slow worker" });

    const result = await executor.execute({
      toolCallId: "id",
      params: {
        agent: "reviewer",
        tasks: [{ agent: "echo", task: "parallel task" }],
        timeoutMs: 180,
      },
      signal: new AbortController().signal,
      ctx: makeCtx(manager),
    });

    assert.equal(result.isError, true);
    assert.match(textAt(result.content), /Parallel run timed out/);
  });

  it("does not raise chain timeouts because an ignored top-level agent is reviewer", async () => {
    const { manager } = makeSessionManagerRecorder();
    const executor = makeExecutor();
    mockPi.reset();
    mockPi.onCall({ delay: 250, output: "slow chain worker" });

    const result = await executor.execute({
      toolCallId: "id",
      params: { agent: "reviewer", chain: [{ agent: "echo", task: "chain task" }], timeoutMs: 180 },
      signal: new AbortController().signal,
      ctx: makeCtx(manager),
    });

    assert.equal(result.isError, true);
    assert.match(textAt(result.content), /Chain timed out/);
  });

  it("rejects async reviewer timeout budgets before reviewer foreground normalization", async () => {
    const { manager } = makeSessionManagerRecorder();
    const executor = makeExecutor();

    const result = await executor.execute({
      toolCallId: "id",
      params: { agent: "reviewer", task: "Review this diff", async: true, timeoutMs: 180_000 },
      signal: new AbortController().signal,
      ctx: makeCtx(manager),
    });

    assert.equal(result.isError, true);
    assert.match(
      textAt(result.content),
      /timeoutMs\/maxRuntimeMs only applies to foreground subagent runs/,
    );
    assert.equal(
      fs.readdirSync(mockPi.dir).some((name) => name.startsWith("call-")),
      false,
    );
  });

  for (const name of ["echo", "previewer"]) {
    it(`honors short foreground timeouts for non-reviewer ${name}`, async () => {
      const { manager } = makeSessionManagerRecorder();
      const executor = makeExecutorWithDiscoverAgents(() => ({
        agents: [
          {
            ...makeAgent(name, { inheritProjectContext: true, inheritSkills: true }),
            name,
            description: "Non-reviewer agent",
          },
        ],
        projectAgentsDir: null,
      }));
      mockPi.reset();
      mockPi.onCall({ delay: 250, output: "preview complete" });

      const result = await executor.execute({
        toolCallId: "id",
        params: { agent: name, task: "Preview this", timeoutMs: 180 },
        signal: new AbortController().signal,
        ctx: makeCtx(manager),
      });

      assert.equal(result.isError, true);
      assert.match(textAt(result.content), /Timed out after 180ms/);
    });
  }

  it("does not treat top-level agent as single mode when tasks are present", async () => {
    const { manager } = makeSessionManagerRecorder();
    const executor = makeExecutor();

    const result = await executor.execute({
      toolCallId: "id",
      params: { agent: "echo", tasks: [{ agent: "second", task: "parallel task" }] },
      signal: new AbortController().signal,
      ctx: makeCtx(manager),
    });

    assert.equal(result.isError, undefined);
    const args = readCallArgs();
    assert.equal(args.at(-1) ?? "", "Task: parallel task");
  });

  for (const model of [undefined, "openai/gpt-5-main:high"]) {
    it(`fork launches use ${(model ?? "").length > 0 ? "explicit pins without unused Anthropic fallbacks" : "non-Anthropic profile defaults"}`, async () => {
      const parentSessionFile = path.join(tempDir, "parent.jsonl");
      const { manager, openedPaths, branchedLeafIds } = makeForkingSessionManagerRecorder({
        sessionFile: parentSessionFile,
        leafId: "leaf-current",
      });
      const executor = makeExecutorWithDiscoverAgents(() => ({
        agents: [
          {
            ...makeAgent("worker", { inheritProjectContext: true, inheritSkills: true }),
            name: "worker",
            description: "Worker",
            model: (model ?? "").length > 0 ? "anthropic/claude-opus-4-6" : "openai/gpt-5-main",
            fallbackModels: (model ?? "").length > 0 ? ["anthropic/claude-sonnet-4-6"] : [],
            defaultContext: "fork",
          },
        ],
        projectAgentsDir: null,
      }));

      const result = await executor.execute({
        toolCallId: "id",
        params: { agent: "worker", task: "test", ...((model ?? "").length > 0 ? { model } : {}) },
        signal: new AbortController().signal,
        ctx: makeCtx(manager),
      });

      assert.equal(result.isError, undefined);
      assert.equal(result.details.context, "fork");
      assert.deepEqual(openedPaths, [parentSessionFile]);
      assert.deepEqual(branchedLeafIds, [manager.getLeafId()]);
      assert.deepEqual(readSessionArgsFromCalls(), [forkedSessionFile(1)]);
      const args = readCallArgs();
      assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), [
        "--model",
        model ?? "openai/gpt-5-main",
      ]);
    });
  }

  it("rejects Anthropic models before forking, including an explicit context override", async () => {
    const parentSessionFile = path.join(tempDir, "parent.jsonl");
    for (const testCase of [
      {
        name: "agent default",
        agent: {
          ...makeAgent("worker", { inheritProjectContext: true, inheritSkills: true }),
          name: "worker",
          description: "Worker",
          model: "anthropic/claude-opus-4-6",
          defaultContext: "fork" as const,
        },
        params: { agent: "worker", task: "test" },
      },
      {
        name: "explicit override",
        agent: {
          ...makeAgent("worker", { inheritProjectContext: true, inheritSkills: true }),
          name: "worker",
          description: "Worker",
          model: "openai/gpt-5-main",
          defaultContext: "fresh" as const,
        },
        params: {
          agent: "worker",
          task: "test",
          model: "anthropic/claude-sonnet-4-6",
          context: "fork",
        },
      },
      {
        name: "bare model resolved through registry",
        agent: {
          ...makeAgent("worker", { inheritProjectContext: true, inheritSkills: true }),
          name: "worker",
          description: "Worker",
          model: "claude-sonnet-4-6",
          defaultContext: "fork" as const,
        },
        params: { agent: "worker", task: "test" },
        availableModel: { provider: "anthropic", id: "claude-sonnet-4-6" },
      },
      {
        name: "async bare fallback resolved through registry",
        agent: {
          ...makeAgent("worker", { inheritProjectContext: true, inheritSkills: true }),
          name: "worker",
          description: "Worker",
          model: "openai/gpt-5-main",
          fallbackModels: ["claude-sonnet-4-6"],
          defaultContext: "fork" as const,
        },
        params: { agent: "worker", task: "test", async: true },
        availableModel: { provider: "anthropic", id: "claude-sonnet-4-6" },
      },
    ] as const) {
      const { manager, openedPaths } = makeForkingSessionManagerRecorder({
        sessionFile: parentSessionFile,
        leafId: "leaf-current",
      });
      const executor = makeExecutorWithDiscoverAgents(() => ({
        agents: [testCase.agent],
        projectAgentsDir: null,
      }));
      const ctx = makeCtx(manager);
      if (testCase.availableModel) {
        const model = testCase.availableModel;
        ctx.modelRegistry.getAvailable = () => [
          fauxProvider({ provider: model.provider, models: [{ id: model.id }] }).getModel(),
        ];
      }
      // Each scenario owns shared fixture state; complete it before starting the next one.
      // oxlint-disable-next-line no-await-in-loop
      const result = await executor.execute({
        toolCallId: "id",
        params: testCase.params,
        signal: new AbortController().signal,
        ctx: ctx,
      });

      assert.equal(result.isError, true, testCase.name);
      assert.match(
        textAt(result.content),
        /Fork context cannot be used with anthropic\/\* models/,
        testCase.name,
      );
      assert.match(textAt(result.content), /restriction cannot be overridden/, testCase.name);
      assert.deepEqual(openedPaths, [], testCase.name);
    }
    assert.deepEqual(readAllCallArgs(), []);
  });

  it("rejects Anthropic model changes from clarify UI in every foreground mode", async () => {
    const parentSessionFile = path.join(tempDir, "parent.jsonl");
    const executor = makeExecutorWithDiscoverAgents(() => ({
      agents: [
        {
          ...makeAgent("worker", { inheritProjectContext: true, inheritSkills: true }),
          name: "worker",
          description: "Worker",
          model: "openai/gpt-5-main",
          defaultContext: "fresh",
        },
      ],
      projectAgentsDir: null,
    }));
    for (const testCase of [
      {
        name: "single",
        params: { agent: "worker", task: "test", context: "fork", clarify: true },
      },
      {
        name: "parallel",
        params: { tasks: [{ agent: "worker", task: "test" }], context: "fork", clarify: true },
      },
      {
        name: "chain",
        params: { chain: [{ agent: "worker", task: "test" }], context: "fork", clarify: true },
      },
    ] as const) {
      const { manager } = makeForkingSessionManagerRecorder({
        sessionFile: parentSessionFile,
        leafId: "leaf-current",
      });
      const ctx = makeCtx(manager);
      ctx.hasUI = true;
      ctx.mode = "tui";
      const anthropic = fauxProvider({
        provider: "anthropic",
        models: [{ id: "claude-sonnet-4-6" }],
      }).getModel();
      ctx.modelRegistry.getAvailable = () => [anthropic];
      ctx.ui.custom = customInteraction(["m", "\r", "\r"]);
      // Each scenario owns shared fixture state; complete it before starting the next one.
      // oxlint-disable-next-line no-await-in-loop
      const result = await executor.execute({
        toolCallId: "id",
        params: testCase.params,
        signal: new AbortController().signal,
        ctx: ctx,
      });

      assert.equal(result.isError, true, testCase.name);
      assert.match(
        textAt(result.content),
        /Fork context cannot be used with anthropic\/\* models/,
        testCase.name,
      );
    }
    assert.deepEqual(readAllCallArgs(), []);
  });

  it("keeps default-fork context on run-path errors", async () => {
    const parentSessionFile = path.join(tempDir, "parent.jsonl");
    const { manager } = makeForkingSessionManagerRecorder({
      sessionFile: parentSessionFile,
      leafId: "leaf-current",
    });
    const executor = makeExecutorWithDiscoverAgents(() => ({
      agents: [
        {
          ...makeAgent("worker", { inheritProjectContext: true, inheritSkills: true }),
          name: "worker",
          description: "Worker",
          defaultContext: "fork",
        },
      ],
      projectAgentsDir: null,
    }));

    const ctx = makeCtx(manager);
    ctx.modelRegistry.getAvailable = () => {
      throw new Error("model registry unavailable");
    };

    const result = await executor.execute({
      toolCallId: "id",
      params: { agent: "worker" },
      signal: new AbortController().signal,
      ctx: ctx,
    });

    assert.equal(result.isError, true);
    assert.match(textAt(result.content), /model registry unavailable/);
    assert.equal(result.details.context, "fork");
  });

  it("keeps explicit fresh context over agent defaultContext fork", async () => {
    const parentSessionFile = path.join(tempDir, "parent.jsonl");
    const { manager, openedPaths, branchedLeafIds } = makeForkingSessionManagerRecorder({
      sessionFile: parentSessionFile,
      leafId: "leaf-current",
    });
    const executor = makeExecutorWithDiscoverAgents(() => ({
      agents: [
        {
          ...makeAgent("oracle", { inheritProjectContext: true, inheritSkills: true }),
          name: "oracle",
          description: "Oracle",
          defaultContext: "fork",
        },
      ],
      projectAgentsDir: null,
    }));

    const result = await executor.execute({
      toolCallId: "id",
      params: { agent: "oracle", task: "test", context: "fresh" },
      signal: new AbortController().signal,
      ctx: makeCtx(manager),
    });

    assert.equal(result.isError, undefined);
    assert.equal(result.details.context, undefined);
    assert.deepEqual(openedPaths, []);
    assert.deepEqual(branchedLeafIds, []);
    assert.equal(countForkedSessionFiles(readSessionArgsFromCalls()), 0);
  });

  it("forks only fork-default agents in top-level parallel when launch context is omitted", async () => {
    const parentSessionFile = path.join(tempDir, "parent.jsonl");
    const { manager } = makeForkingSessionManagerRecorder({
      sessionFile: parentSessionFile,
      leafId: "leaf-current",
    });
    const executor = makeExecutorWithDiscoverAgents(() => ({
      agents: [
        {
          ...makeAgent("worker", { inheritProjectContext: true, inheritSkills: true }),
          name: "worker",
          description: "Worker",
          defaultContext: "fork",
        },
        {
          ...makeAgent("second", { inheritProjectContext: true, inheritSkills: true }),
          name: "second",
          description: "Second",
        },
        {
          ...makeAgent("scout", { inheritProjectContext: true, inheritSkills: true }),
          name: "scout",
          description: "Scout",
          defaultContext: "fresh",
        },
      ],
      projectAgentsDir: null,
    }));
    const result = await executor.execute({
      toolCallId: "id",
      params: {
        tasks: [
          { agent: "worker", task: "one" },
          { agent: "second", task: "two" },
          { agent: "scout", task: "find files" },
        ],
      },
      signal: new AbortController().signal,
      ctx: makeCtx(manager),
    });
    assert.equal(result.isError, undefined);
    assert.equal(result.details.context, "fork");
    const sessionArgs = readSessionArgsFromCalls();
    assert.equal(sessionArgs.length, 3);
    assert.equal(countForkedSessionFiles(sessionArgs), 1);
    for (const [task, fork] of [
      ["one", true],
      ["two", false],
      ["find files", false],
    ] as const) {
      const args = callArgsForTaskContaining(task);
      const file = args[args.indexOf("--session") + 1];
      assert.equal(isNativeFork(file), fork, `${task} receives its own context policy`);
    }
  });

  it("applies paired intercom wiring to fresh and fork parallel children", async () => {
    mockPi.reset();
    mockPi.onCall({
      output: "fresh child",
      echoEnv: ["PI_SUBAGENT_ORCHESTRATOR_TARGET", "PI_SUBAGENT_ROOT_SESSION_ID"],
    });
    mockPi.onCall({
      output: "fork child",
      echoEnv: ["PI_SUBAGENT_ORCHESTRATOR_TARGET", "PI_SUBAGENT_ROOT_SESSION_ID"],
    });
    const parentSessionFile = path.join(tempDir, "parent.jsonl");
    const { manager } = makeForkingSessionManagerRecorder({
      sessionFile: parentSessionFile,
      leafId: "leaf-current",
    });
    const executor = makeExecutorWithDiscoverAgents(() => ({
      agents: [
        {
          ...makeAgent("scout", { inheritProjectContext: true, inheritSkills: true }),
          name: "scout",
          description: "Custom override scout",
          defaultContext: "fresh",
          tools: ["read"],
        },
        {
          ...makeAgent("worker", { inheritProjectContext: true, inheritSkills: true }),
          name: "worker",
          description: "Custom override worker",
          defaultContext: "fork",
          tools: ["read"],
        },
      ],
      projectAgentsDir: null,
    }));

    const result = await executor.execute({
      toolCallId: "id",
      params: {
        tasks: [
          { agent: "scout", task: "find files" },
          { agent: "worker", task: "implement fix" },
        ],
      },
      signal: new AbortController().signal,
      ctx: makeCtx(manager),
    });

    assert.equal(result.isError, undefined);
    const freshCall = callRecordForTaskContaining("find files");
    const forkCall = callRecordForTaskContaining("implement fix");
    assert.equal(toolsArg(freshCall.args), "read,intercom,contact_supervisor");
    assert.equal(toolsArg(forkCall.args), "read,intercom,contact_supervisor");
    assert.equal(
      freshCall.env?.PI_SUBAGENT_ORCHESTRATOR_TARGET,
      `subagent-chat-${manager.getSessionId().slice(0, 8)}`,
    );
    assert.equal(
      forkCall.env?.PI_SUBAGENT_ORCHESTRATOR_TARGET,
      `subagent-chat-${manager.getSessionId().slice(0, 8)}`,
    );
    assert.equal(freshCall.env.PI_SUBAGENT_ROOT_SESSION_ID, manager.getSessionId());
    assert.equal(forkCall.env.PI_SUBAGENT_ROOT_SESSION_ID, manager.getSessionId());
  });

  it("keeps explicit fresh context over top-level parallel agent defaultContext fork", async () => {
    const parentSessionFile = path.join(tempDir, "parent.jsonl");
    const { manager, openedPaths } = makeForkingSessionManagerRecorder({
      sessionFile: parentSessionFile,
      leafId: "leaf-current",
    });
    const executor = makeExecutorWithDiscoverAgents(() => ({
      agents: [
        {
          ...makeAgent("worker", { inheritProjectContext: true, inheritSkills: true }),
          name: "worker",
          description: "Worker",
          defaultContext: "fork",
        },
        {
          ...makeAgent("second", { inheritProjectContext: true, inheritSkills: true }),
          name: "second",
          description: "Second",
        },
      ],
      projectAgentsDir: null,
    }));

    const result = await executor.execute({
      toolCallId: "id",
      params: {
        tasks: [
          { agent: "worker", task: "one" },
          { agent: "second", task: "two" },
        ],
        context: "fresh",
      },
      signal: new AbortController().signal,
      ctx: makeCtx(manager),
    });

    assert.equal(result.isError, undefined);
    assert.equal(result.details.context, undefined);
    assert.deepEqual(openedPaths, []);
  });

  it("forks only fork-default chain steps when launch context is omitted", async () => {
    const parentSessionFile = path.join(tempDir, "parent.jsonl");
    const { manager } = makeForkingSessionManagerRecorder({
      sessionFile: parentSessionFile,
      leafId: "leaf-current",
    });
    const executor = makeExecutorWithDiscoverAgents(() => ({
      agents: [
        {
          ...makeAgent("echo", { inheritProjectContext: true, inheritSkills: true }),
          name: "echo",
          description: "Echo",
        },
        {
          ...makeAgent("worker", { inheritProjectContext: true, inheritSkills: true }),
          name: "worker",
          description: "Worker",
          defaultContext: "fork",
        },
      ],
      projectAgentsDir: null,
    }));

    const result = await executor.execute({
      toolCallId: "id",
      params: {
        chain: [
          { agent: "echo", task: "scan" },
          { agent: "worker", task: "write" },
        ],
        clarify: false,
      },
      signal: new AbortController().signal,
      ctx: makeCtx(manager),
    });

    assert.equal(result.isError, undefined);
    assert.equal(result.details.context, "fork");
    const sessionArgs = readSessionArgsFromCalls();
    assert.equal(sessionArgs.length, 2);
    assert.equal(countForkedSessionFiles(sessionArgs), 1);
    assert.ok(sessionArgs.includes(forkedSessionFile(1)));
    const scan = callArgsForTaskContaining("scan"),
      write = callArgsForTaskContaining("write");
    assert.equal(isNativeFork(scan[scan.indexOf("--session") + 1]), false);
    assert.equal(isNativeFork(write[write.indexOf("--session") + 1]), true);
  });

  it("applies paired intercom wiring to fresh and fork chain steps", async () => {
    const parentSessionFile = path.join(tempDir, "parent.jsonl");
    const { manager } = makeForkingSessionManagerRecorder({
      sessionFile: parentSessionFile,
      leafId: "leaf-current",
    });
    const executor = makeExecutorWithDiscoverAgents(() => ({
      agents: [
        {
          ...makeAgent("scout", { inheritProjectContext: true, inheritSkills: true }),
          name: "scout",
          description: "Custom override scout",
          defaultContext: "fresh",
          tools: ["read"],
        },
        {
          ...makeAgent("worker", { inheritProjectContext: true, inheritSkills: true }),
          name: "worker",
          description: "Custom override worker",
          defaultContext: "fork",
          tools: ["read"],
        },
      ],
      projectAgentsDir: null,
    }));

    const result = await executor.execute({
      toolCallId: "id",
      params: {
        chain: [
          { agent: "scout", task: "scan" },
          { agent: "worker", task: "write" },
        ],
        clarify: false,
      },
      signal: new AbortController().signal,
      ctx: makeCtx(manager),
    });

    assert.equal(result.isError, undefined);
    assert.equal(toolsArg(callArgsForTaskContaining("scan")), "read,intercom,contact_supervisor");
    assert.equal(toolsArg(callArgsForTaskContaining("write")), "read,intercom,contact_supervisor");
  });

  it("applies paired intercom wiring to fresh and fork dynamic fanout children", async () => {
    mockPi.reset();
    mockPi.onCall({
      output: "targets",
      structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] },
    });
    mockPi.onCall({
      output: "review-a",
      structuredOutput: { ok: "a" },
      echoEnv: ["PI_SUBAGENT_ORCHESTRATOR_TARGET"],
    });
    mockPi.onCall({
      output: "review-b",
      structuredOutput: { ok: "b" },
      echoEnv: ["PI_SUBAGENT_ORCHESTRATOR_TARGET"],
    });
    mockPi.onCall({ output: "consumer", echoEnv: ["PI_SUBAGENT_ORCHESTRATOR_TARGET"] });
    const parentSessionFile = path.join(tempDir, "parent.jsonl");
    const { manager } = makeForkingSessionManagerRecorder({
      sessionFile: parentSessionFile,
      leafId: "leaf-current",
    });
    const executor = makeExecutorWithDiscoverAgents(() => ({
      agents: [
        {
          ...makeAgent("producer", { inheritProjectContext: true, inheritSkills: true }),
          name: "producer",
          description: "Custom override producer",
          defaultContext: "fresh",
          tools: ["read"],
        },
        {
          ...makeAgent("reviewer", { inheritProjectContext: true, inheritSkills: true }),
          name: "reviewer",
          description: "Custom override reviewer",
          defaultContext: "fork",
          tools: ["read"],
        },
        {
          ...makeAgent("consumer", { inheritProjectContext: true, inheritSkills: true }),
          name: "consumer",
          description: "Custom override consumer",
          defaultContext: "fresh",
          tools: ["read"],
        },
      ],
      projectAgentsDir: null,
    }));

    const result = await executor.execute({
      toolCallId: "id",
      params: {
        chain: [
          {
            agent: "producer",
            task: "Produce targets",
            as: "targets",
            outputSchema: { type: "object" },
          },
          {
            expand: {
              from: { output: "targets", path: "/items" },
              item: "target",
              key: "/path",
              maxItems: 4,
            },
            parallel: {
              agent: "reviewer",
              task: "Review {target.path}",
              outputSchema: { type: "object" },
            },
            collect: { as: "reviews" },
            concurrency: 1,
          },
          { agent: "consumer", task: "Use reviews" },
        ],
        clarify: false,
      },
      signal: new AbortController().signal,
      ctx: makeCtx(manager),
    });

    assert.equal(result.isError, undefined, textAt(result.content));
    const producerCall = callRecordForTaskContaining("Produce targets");
    const reviewACall = callRecordForTaskContaining("Review src/a.ts");
    const reviewBCall = callRecordForTaskContaining("Review src/b.ts");
    const consumerCall = callRecordForTaskContaining("Use reviews");
    assert.equal(toolsArg(producerCall.args), "read,intercom,contact_supervisor,structured_output");
    assert.equal(toolsArg(reviewACall.args), "read,intercom,contact_supervisor,structured_output");
    assert.equal(toolsArg(reviewBCall.args), "read,intercom,contact_supervisor,structured_output");
    assert.equal(toolsArg(consumerCall.args), "read,intercom,contact_supervisor");
    assert.equal(
      reviewACall.env?.PI_SUBAGENT_ORCHESTRATOR_TARGET,
      `subagent-chat-${manager.getSessionId().slice(0, 8)}`,
    );
    assert.equal(
      reviewBCall.env?.PI_SUBAGENT_ORCHESTRATOR_TARGET,
      `subagent-chat-${manager.getSessionId().slice(0, 8)}`,
    );
    assert.equal(
      consumerCall.env?.PI_SUBAGENT_ORCHESTRATOR_TARGET,
      `subagent-chat-${manager.getSessionId().slice(0, 8)}`,
    );
    assert.equal(countForkedSessionFiles(readSessionArgsFromCalls()), 2);
  });

  it("keeps fresh dynamic fanout children from inheriting later fork step sessions", async () => {
    mockPi.reset();
    mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }] } });
    mockPi.onCall({ output: "review-a", structuredOutput: { ok: "a" } });
    mockPi.onCall({ output: "write" });
    const parentSessionFile = path.join(tempDir, "parent.jsonl");
    const { manager } = makeForkingSessionManagerRecorder({
      sessionFile: parentSessionFile,
      leafId: "leaf-current",
    });
    const executor = makeExecutorWithDiscoverAgents(() => ({
      agents: [
        {
          ...makeAgent("producer", { inheritProjectContext: true, inheritSkills: true }),
          name: "producer",
          description: "Producer",
          defaultContext: "fresh",
        },
        {
          ...makeAgent("reviewer", { inheritProjectContext: true, inheritSkills: true }),
          name: "reviewer",
          description: "Reviewer",
          defaultContext: "fresh",
        },
        {
          ...makeAgent("worker", { inheritProjectContext: true, inheritSkills: true }),
          name: "worker",
          description: "Worker",
          defaultContext: "fork",
        },
      ],
      projectAgentsDir: null,
    }));

    const result = await executor.execute({
      toolCallId: "id",
      params: {
        chain: [
          {
            agent: "producer",
            task: "Produce targets",
            as: "targets",
            outputSchema: { type: "object" },
          },
          {
            expand: {
              from: { output: "targets", path: "/items" },
              item: "target",
              key: "/path",
              maxItems: 1,
            },
            parallel: {
              agent: "reviewer",
              task: "Review {target.path}",
              outputSchema: { type: "object" },
            },
            collect: { as: "reviews" },
          },
          { agent: "worker", task: "Write after reviews" },
        ],
        clarify: false,
      },
      signal: new AbortController().signal,
      ctx: makeCtx(manager),
    });

    assert.equal(result.isError, undefined, textAt(result.content));
    const reviewArgs = callArgsForTaskContaining("Review src/a.ts");
    const workerArgs = callArgsForTaskContaining("Write after reviews");
    const reviewSession = reviewArgs.at(reviewArgs.indexOf("--session") + 1);
    const workerSession = workerArgs.at(workerArgs.indexOf("--session") + 1);
    assertDefined(reviewSession);
    assert.ok(
      reviewSession.endsWith(path.join("run-1", "session.jsonl")),
      `expected fresh dynamic child session, got ${reviewSession}`,
    );
    assertDefined(workerSession);
    assert.ok(
      Boolean(workerSession) && isNativeFork(workerSession),
      "worker uses an actual native fork",
    );
    assert.equal(countForkedSessionFiles(readSessionArgsFromCalls()), 1);
  });

  it("reports unknown top-level parallel agents before default-fork preconditions", async () => {
    const { manager } = makeSessionManagerRecorder({
      sessionFile: undefined,
      leafId: "leaf-current",
    });
    const executor = makeExecutorWithDiscoverAgents(() => ({
      agents: [
        {
          ...makeAgent("worker", { inheritProjectContext: true, inheritSkills: true }),
          name: "worker",
          description: "Worker",
          defaultContext: "fork",
        },
      ],
      projectAgentsDir: null,
    }));

    const result = await executor.execute({
      toolCallId: "id",
      params: {
        tasks: [
          { agent: "worker", task: "one" },
          { agent: "missing", task: "two" },
        ],
      },
      signal: new AbortController().signal,
      ctx: makeCtx(manager),
    });

    assert.equal(result.isError, true);
    assert.match(textAt(result.content), /Unknown agent: missing/);
    assert.doesNotMatch(textAt(result.content), /persisted parent session/);
  });

  it("fails fast when context=fork and parent session is missing", async () => {
    const { manager } = makeSessionManagerRecorder({
      sessionFile: undefined,
      leafId: "leaf-current",
    });
    const executor = makeExecutor();

    const result = await executor.execute({
      toolCallId: "id",
      params: { agent: "echo", task: "test", context: "fork" },
      signal: new AbortController().signal,
      ctx: makeCtx(manager),
    });

    assert.equal(result.isError, true);
    assert.match(textAt(result.content), /persisted parent session/);
  });

  it("fails fast when context=fork and leaf is missing", async () => {
    const { manager } = makeSessionManagerRecorder({
      sessionFile: "/tmp/parent.jsonl",
      leafId: null,
    });
    const executor = makeExecutor();

    const result = await executor.execute({
      toolCallId: "id",
      params: { agent: "echo", task: "test", context: "fork" },
      signal: new AbortController().signal,
      ctx: makeCtx(manager),
    });

    assert.equal(result.isError, true);
    assert.match(textAt(result.content), /current leaf/);
  });

  it("returns a tool error (instead of throwing) when branch creation fails", async () => {
    const executor = makeExecutor();
    const parentSessionFile = path.join(tempDir, "parent.jsonl");
    fs.writeFileSync(
      parentSessionFile,
      '{"type":"session","version":1,"id":"parent","timestamp":"2026-04-16T00:00:00.000Z","cwd":"/tmp"}\n',
      "utf-8",
    );
    const { manager } = makeSessionManagerRecorder({
      sessionFile: parentSessionFile,
      leafId: "leaf-fail",
    });
    mock.method(SessionManager, "open", () => {
      throw new Error("branch write failed");
    });

    const result = await executor.execute({
      toolCallId: "id",
      params: { agent: "echo", task: "test", context: "fork" },
      signal: new AbortController().signal,
      ctx: makeCtx(manager),
    });

    assert.equal(result.isError, true);
    assert.match(textAt(result.content), /Failed to create forked subagent session/);
    assert.match(textAt(result.content), /branch write failed/);
  });

  it("creates one forked session for single mode", async () => {
    const { manager, openedPaths, branchedLeafIds } = makeForkingSessionManagerRecorder({
      sessionFile: path.join(tempDir, "parent.jsonl"),
      leafId: "leaf-123",
    });
    const executor = makeExecutor();

    const result = await executor.execute({
      toolCallId: "id",
      params: { agent: "echo", task: "single task", context: "fork" },
      signal: new AbortController().signal,
      ctx: makeCtx(manager),
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(openedPaths, [path.join(tempDir, "parent.jsonl")]);
    assert.deepEqual(branchedLeafIds, [manager.getLeafId()]);
    const args = readCallArgs();
    const sessionIndex = args.indexOf("--session");
    assert.notEqual(sessionIndex, -1);
    assert.notEqual(args[sessionIndex + 1], path.join(tempDir, "parent.jsonl"));
    assert.ok(Boolean(args[sessionIndex + 1]));
    assert.equal(fs.existsSync(args[sessionIndex + 1]), true);
  });

  it("creates isolated forked sessions per parallel task", async () => {
    const { manager, openedPaths, branchedLeafIds } = makeForkingSessionManagerRecorder({
      sessionFile: path.join(tempDir, "parent-parallel.jsonl"),
      leafId: "leaf-777",
    });
    const executor = makeExecutor();

    const result = await executor.execute({
      toolCallId: "id",
      params: {
        tasks: [
          { agent: "echo", task: "task one" },
          { agent: "second", task: "task two" },
        ],
        context: "fork",
      },
      signal: new AbortController().signal,
      ctx: makeCtx(manager),
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(openedPaths, [
      path.join(tempDir, "parent-parallel.jsonl"),
      path.join(tempDir, "parent-parallel.jsonl"),
    ]);
    assert.deepEqual(branchedLeafIds, Array(2).fill(manager.getLeafId()));
    const sessionArgs = readSessionArgsFromCalls();
    assert.equal(sessionArgs.length, 2);
    assert.equal(new Set(sessionArgs).size, 2);
    for (const childSessionFile of sessionArgs) {
      assert.notEqual(childSessionFile, path.join(tempDir, "parent-parallel.jsonl"));
      assert.equal(fs.existsSync(childSessionFile), true);
    }
  });

  it("expands top-level parallel task counts before fork session allocation", async () => {
    const { manager, openedPaths, branchedLeafIds } = makeForkingSessionManagerRecorder({
      sessionFile: path.join(tempDir, "parent-count.jsonl"),
      leafId: "leaf-count",
    });
    const executor = makeExecutor();

    const result = await executor.execute({
      toolCallId: "id",
      params: {
        tasks: [{ agent: "echo", task: "task one", count: 3 }],
        context: "fork",
      },
      signal: new AbortController().signal,
      ctx: makeCtx(manager),
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(openedPaths, [
      path.join(tempDir, "parent-count.jsonl"),
      path.join(tempDir, "parent-count.jsonl"),
      path.join(tempDir, "parent-count.jsonl"),
    ]);
    assert.deepEqual(branchedLeafIds, Array(3).fill(manager.getLeafId()));
    const sessionArgs = readSessionArgsFromCalls();
    assert.equal(sessionArgs.length, 3);
    assert.equal(new Set(sessionArgs).size, 3);
  });

  it("rejects top-level parallel worktree runs with a conflicting task cwd", async () => {
    const { manager } = makeSessionManagerRecorder({
      sessionFile: "/tmp/parent.jsonl",
      leafId: "leaf-777",
    });
    const executor = makeExecutor();

    const result = await executor.execute({
      toolCallId: "id",
      params: {
        tasks: [
          { agent: "echo", task: "task one" },
          { agent: "second", task: "task two", cwd: `${tempDir}/other` },
        ],
        worktree: true,
      },
      signal: new AbortController().signal,
      ctx: makeCtx(manager),
    });

    assert.equal(result.isError, true);
    assert.match(textAt(result.content), /worktree isolation uses the shared cwd/i);
    assert.match(textAt(result.content), /task 2 \(second\) sets cwd/i);
  });

  it("rejects top-level parallel counts that expand past MAX_PARALLEL", async () => {
    const { manager } = makeSessionManagerRecorder({
      sessionFile: "/tmp/parent.jsonl",
      leafId: "leaf-max",
    });
    const executor = makeExecutor();

    const result = await executor.execute({
      toolCallId: "id",
      params: {
        tasks: [{ agent: "echo", task: "task one", count: 9 }],
      },
      signal: new AbortController().signal,
      ctx: makeCtx(manager),
    });

    assert.equal(result.isError, true);
    assert.match(textAt(result.content), /Max 8 tasks/);
    assert.match(textAt(result.content), /parallel\.maxTasks/);
  });

  it("uses top-level parallel config overrides for maxTasks and concurrency", async () => {
    const { manager } = makeSessionManagerRecorder({
      sessionFile: "/tmp/parent.jsonl",
      leafId: "leaf-max-config",
    });
    const maxTasksExecutor = makeExecutorWithConfig({ parallel: { maxTasks: 9 } });

    const maxTasksResult = await maxTasksExecutor.execute({
      toolCallId: "id",
      params: {
        tasks: [{ agent: "echo", task: "task one", count: 9 }],
      },
      signal: new AbortController().signal,
      ctx: makeCtx(manager),
    });

    assert.equal(maxTasksResult.isError, undefined);
    assert.equal(mockPi.callCount(), 9);

    for (const testCase of [
      {
        name: "config",
        configConcurrency: 2,
        paramsConcurrency: undefined,
        expectedMaxRunning: 2,
      },
      {
        name: "per-call",
        configConcurrency: 3,
        paramsConcurrency: 1,
        expectedMaxRunning: 1,
      },
    ] as const) {
      mockPi.reset();
      const release = path.join(tempDir, `release-${testCase.name}`);
      for (let i = 0; i < 3; i++) {
        mockPi.onCall({
          steps: [
            { jsonl: [events.toolStart("bash", { command: `${testCase.name}-${i}` })] },
            { waitForFile: release },
            { jsonl: [events.toolEnd("bash"), events.assistantMessage(`done-${i}`)] },
          ],
        });
      }

      const executor = makeExecutorWithConfig({
        parallel: { concurrency: testCase.configConcurrency },
      });
      let maxRunning = 0;

      // Each scenario owns shared fixture state; complete it before starting the next one.
      // oxlint-disable-next-line no-await-in-loop
      const result = await executor.execute({
        toolCallId: "id",
        params: {
          tasks: [
            { agent: "echo", task: "task one" },
            { agent: "second", task: "task two" },
            { agent: "echo", task: "task three" },
          ],
          ...((testCase.paramsConcurrency ?? 0) !== 0 && !Number.isNaN(testCase.paramsConcurrency)
            ? { concurrency: testCase.paramsConcurrency }
            : {}),
        },
        signal: new AbortController().signal,
        onUpdate: (update: ProgressUpdate) => {
          const progress = update.details.progress ?? [];
          const running = progress.filter((entry) => entry.status === "running").length;
          maxRunning = Math.max(maxRunning, running);
          if (running === testCase.expectedMaxRunning) {
            fs.writeFileSync(release, "");
          }
        },
        ctx: makeCtx(makeSessionManagerRecorder().manager),
      });

      assert.equal(result.isError, undefined, testCase.name);
      assert.equal(maxRunning, testCase.expectedMaxRunning, testCase.name);
    }
  });

  it("releases the parallel wait on intercom handoff while its owner finishes both children", async () => {
    mockPi.reset();
    const release = path.join(tempDir, "release-child");
    mockPi.onCall({
      matchArgsIncludes: "send handoff",
      steps: [
        { jsonl: [events.toolStart("intercom", { action: "ask", to: "orchestrator" })] },
        { waitForFile: release, jsonl: [events.assistantMessage("after handoff")] },
      ],
    });
    mockPi.onCall({ matchArgsIncludes: "continue", output: "other done" });
    const executor = makeExecutorWithDiscoverAgents(() => ({
      agents: [
        {
          ...makeAgent("echo", { inheritProjectContext: true, inheritSkills: true }),
          name: "echo",
          description: "Echo",
          systemPrompt: "Intercom orchestration channel:",
        },
        {
          ...makeAgent("second", { inheritProjectContext: true, inheritSkills: true }),
          name: "second",
          description: "Second",
          systemPrompt: "Intercom orchestration channel:",
        },
      ],
      projectAgentsDir: null,
    }));
    let detachEmitted = false;
    const result = await executor.execute({
      toolCallId: "intercom-parallel",
      params: {
        tasks: [
          { agent: "echo", task: "send handoff" },
          { agent: "second", task: "continue" },
        ],
      },
      signal: new AbortController().signal,
      onUpdate: (update: ProgressUpdate) => {
        if (detachEmitted) {
          return;
        }
        if (
          !(update.details.progress?.some((entry) => entry.currentTool === "intercom") === true)
        ) {
          return;
        }
        detachEmitted = true;
        executor.eventsApi.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "parallel-detach" });
      },
      ctx: makeCtx(makeSessionManagerRecorder().manager),
    });

    assert.equal(result.isError, undefined);
    assert.match(textAt(result.content), /Released the wait/);
    assert.equal(result.details.wait?.status, "yielded");
    assert.equal(detachEmitted, true);
    fs.writeFileSync(release, "");
    const saved = await savedOwnerResult(result.details.wait.runId);
    assert.equal(saved.terminalState, "complete");
    assertDefined(saved.results);
    assert.deepEqual(
      saved.results.map((child) => child.output),
      ["after handoff", "other done"],
    );
    assertDefined(saved.results);
    assert.ok(
      saved.results.every((child) => objectRecord(child).detached !== true && child.exitCode === 0),
    );
  });

  it("keeps a sibling failure in the owner result after the parallel wait is released", async () => {
    mockPi.reset();
    const release = path.join(tempDir, "release-child");
    mockPi.onCall({
      matchArgsIncludes: "send handoff",
      steps: [
        { jsonl: [events.toolStart("intercom", { action: "ask", to: "orchestrator" })] },
        { waitForFile: release, jsonl: [events.assistantMessage("after handoff")] },
      ],
    });
    mockPi.onCall({ matchArgsIncludes: "fail", stderr: "sibling exploded", exitCode: 1 });
    const executor = makeExecutorWithDiscoverAgents(() => ({
      agents: [
        {
          ...makeAgent("echo", { inheritProjectContext: true, inheritSkills: true }),
          name: "echo",
          description: "Echo",
          systemPrompt: "Intercom orchestration channel:",
        },
        {
          ...makeAgent("second", { inheritProjectContext: true, inheritSkills: true }),
          name: "second",
          description: "Second",
          systemPrompt: "Intercom orchestration channel:",
        },
      ],
      projectAgentsDir: null,
    }));
    let detachEmitted = false;
    const result = await executor.execute({
      toolCallId: "intercom-parallel-mixed",
      params: {
        tasks: [
          { agent: "echo", task: "send handoff" },
          { agent: "second", task: "fail" },
        ],
      },
      signal: new AbortController().signal,
      onUpdate: (update: ProgressUpdate) => {
        if (
          detachEmitted ||
          !(update.details.progress?.some((entry) => entry.currentTool === "intercom") === true)
        ) {
          return;
        }
        detachEmitted = true;
        executor.eventsApi.emit(INTERCOM_DETACH_REQUEST_EVENT, {
          requestId: "parallel-detach-mixed",
        });
      },
      ctx: makeCtx(makeSessionManagerRecorder().manager),
    });

    assert.equal(result.isError, undefined, "releasing a wait is not a terminal result");
    assert.equal(result.details.wait?.status, "yielded");
    assert.match(textAt(result.content), /Released the wait/);
    fs.writeFileSync(release, "");
    const saved = await savedOwnerResult(result.details.wait.runId);
    assert.equal(saved.terminalState, "failed");
    assertDefined(saved.results);
    assert.equal(saved.results.length, 2);
    assertDefined(saved.results);
    assert.equal(
      saved.results.some((child) => child.exitCode === 0 && child.output === "after handoff"),
      true,
    );
    assertDefined(saved.results);
    assert.equal(
      saved.results.some(
        (child) => child.exitCode === 1 && child.error?.includes("sibling exploded") === true,
      ),
      true,
    );
    const inspection = await executor.execute({
      toolCallId: "inspect-after-handoff",
      params: { action: "status", id: result.details.wait.runId },
      ctx: makeCtx(makeSessionManagerRecorder().manager),
    });
    assert.equal(inspection.details.run?.state, "failed");
    assert.match(textAt(inspection.content), /second[\s\S]*sibling exploded/);
  });

  it("runs top-level parallel async requests in the background", async () => {
    const executor = makeExecutor();

    const result = await executor.execute({
      toolCallId: "id",
      params: {
        tasks: [
          { agent: "echo", task: "async parallel task one" },
          { agent: "second", task: "async parallel task two" },
        ],
        async: true,
        clarify: false,
      },
      signal: new AbortController().signal,
      ctx: makeCtx(makeSessionManagerRecorder().manager),
    });

    assert.equal(result.isError, undefined);
    assert.equal(result.details.mode, "parallel");
    assert.ok(
      Boolean(result.details.asyncId),
      "expected an asyncId for background top-level parallel runs",
    );
    assert.match(textAt(result.content), /Async parallel:/);
    await waitForTaskCalls(["async parallel task one", "async parallel task two"]);
  });

  it("forks only fork-default agents in top-level parallel async when launch context is omitted", async () => {
    const parentSessionFile = path.join(tempDir, "parent.jsonl");
    const { manager } = makeForkingSessionManagerRecorder({
      sessionFile: parentSessionFile,
      leafId: "leaf-current",
    });
    const executor = makeExecutorWithDiscoverAgents(() => ({
      agents: [
        {
          ...makeAgent("scout", { inheritProjectContext: true, inheritSkills: true }),
          name: "scout",
          description: "Scout",
          defaultContext: "fresh",
        },
        {
          ...makeAgent("worker", { inheritProjectContext: true, inheritSkills: true }),
          name: "worker",
          description: "Worker",
          defaultContext: "fork",
        },
      ],
      projectAgentsDir: null,
    }));

    const result = await executor.execute({
      toolCallId: "id",
      params: {
        tasks: [
          { agent: "scout", task: "async mixed scout task" },
          { agent: "worker", task: "async mixed worker task" },
        ],
        async: true,
        clarify: false,
      },
      signal: new AbortController().signal,
      ctx: makeCtx(manager),
    });

    assert.equal(result.isError, undefined);
    assert.equal(result.details.mode, "parallel");
    assert.equal(result.details.context, "fork");
    assert.ok(
      Boolean(result.details.asyncId),
      "expected an asyncId for background top-level parallel runs",
    );

    await waitForTaskCalls(["async mixed scout task", "async mixed worker task"]);
    const freshArgs = callArgsForTaskContaining("async mixed scout task");
    const forkArgs = callArgsForTaskContaining("async mixed worker task");
    const freshSessionIndex = freshArgs.indexOf("--session");
    const forkSessionIndex = forkArgs.indexOf("--session");
    assert.notEqual(freshSessionIndex, -1);
    assert.notEqual(forkSessionIndex, -1);
    assert.equal(countForkedSessionFiles([freshArgs[freshSessionIndex + 1]]), 0);
    assert.equal(forkArgs[forkSessionIndex + 1], forkedSessionFile(1));
  });

  it("applies paired intercom wiring to fresh and fork async children", async () => {
    mockPi.reset();
    mockPi.onCall({
      output: "async fresh child",
      echoEnv: ["PI_SUBAGENT_ORCHESTRATOR_TARGET", "PI_SUBAGENT_ROOT_SESSION_ID"],
    });
    mockPi.onCall({
      output: "async fork child",
      echoEnv: ["PI_SUBAGENT_ORCHESTRATOR_TARGET", "PI_SUBAGENT_ROOT_SESSION_ID"],
    });
    const parentSessionFile = path.join(tempDir, "parent.jsonl");
    const { manager } = makeForkingSessionManagerRecorder({
      sessionFile: parentSessionFile,
      leafId: "leaf-current",
    });
    const executor = makeExecutorWithDiscoverAgents(() => ({
      agents: [
        {
          ...makeAgent("scout", { inheritProjectContext: true, inheritSkills: true }),
          name: "scout",
          description: "Scout",
          defaultContext: "fresh",
          tools: ["read"],
        },
        {
          ...makeAgent("worker", { inheritProjectContext: true, inheritSkills: true }),
          name: "worker",
          description: "Worker",
          defaultContext: "fork",
          tools: ["read"],
        },
      ],
      projectAgentsDir: null,
    }));

    const result = await executor.execute({
      toolCallId: "id",
      params: {
        tasks: [
          { agent: "scout", task: "async find files" },
          { agent: "worker", task: "async implement fix" },
        ],
        async: true,
        clarify: false,
      },
      signal: new AbortController().signal,
      ctx: makeCtx(manager),
    });

    assert.equal(result.isError, undefined);
    assert.equal(result.details.context, "fork");
    await waitForTaskCalls(["async find files", "async implement fix"]);
    const freshCall = callRecordForTaskContaining("async find files");
    const forkCall = callRecordForTaskContaining("async implement fix");
    assert.equal(toolsArg(freshCall.args), "read,intercom,contact_supervisor");
    assert.equal(toolsArg(forkCall.args), "read,intercom,contact_supervisor");
    assert.equal(
      freshCall.env?.PI_SUBAGENT_ORCHESTRATOR_TARGET,
      `subagent-chat-${manager.getSessionId().slice(0, 8)}`,
    );
    assert.equal(
      forkCall.env?.PI_SUBAGENT_ORCHESTRATOR_TARGET,
      `subagent-chat-${manager.getSessionId().slice(0, 8)}`,
    );
    assert.equal(freshCall.env.PI_SUBAGENT_ROOT_SESSION_ID, manager.getSessionId());
    assert.equal(forkCall.env.PI_SUBAGENT_ROOT_SESSION_ID, manager.getSessionId());
  });

  it("runs async chain requests in the background when clarify is omitted", async () => {
    const executor = makeExecutor();

    const result = await executor.execute({
      toolCallId: "id",
      params: {
        chain: [
          { agent: "echo", task: "async chain task one" },
          { agent: "second", task: "async chain task two" },
        ],
        async: true,
      },
      signal: new AbortController().signal,
      ctx: makeCtx(makeSessionManagerRecorder().manager),
    });

    assert.equal(result.isError, undefined);
    assert.equal(result.details.mode, "chain");
    assert.ok(Boolean(result.details.asyncId), "expected an asyncId for background chain runs");
    assert.match(textAt(result.content), /Async chain:/);
    await waitForTaskCalls(["async chain task one", "async chain task two"]);
  });

  it("waits for explicit clarify async chain requests through the durable owner", async () => {
    const executor = makeExecutor();

    const result = await executor.execute({
      toolCallId: "id",
      params: {
        chain: [
          { agent: "echo", task: "task one" },
          { agent: "second", task: "task two" },
        ],
        async: true,
        clarify: true,
      },
      signal: new AbortController().signal,
      ctx: makeCtx(makeSessionManagerRecorder().manager),
    });

    assert.equal(result.isError, undefined);
    assert.equal(result.details.mode, "chain");
    assert.equal(result.details.wait?.status, "completed");
    assert.equal(result.details.asyncId, result.details.wait.runId);
    assert.equal(result.details.results.length, 2);
    assert.doesNotMatch(textAt(result.content), /Async chain:/);
  });

  it("rejects unsupported acceptance.review before any child launch", async () => {
    const executor = makeExecutor();
    for (const testCase of [
      {
        name: "single",
        params: {
          agent: "echo",
          task: "test",
          acceptance: { criteria: ["Patch"], review: { agent: "reviewer" } },
        },
      },
      {
        name: "parallel",
        params: {
          tasks: [
            {
              agent: "echo",
              task: "test",
              acceptance: { criteria: ["Patch"], review: { agent: "reviewer" } },
            },
          ],
          async: true,
        },
      },
      {
        name: "chain",
        params: {
          chain: [
            {
              agent: "echo",
              task: "test",
              acceptance: { criteria: ["Patch"], review: { agent: "reviewer" } },
            },
          ],
        },
      },
    ] as const) {
      // Each scenario owns shared fixture state; complete it before starting the next one.
      // oxlint-disable-next-line no-await-in-loop
      const result = await executor.execute({
        toolCallId: "id",
        params: testCase.params,
        signal: new AbortController().signal,
        ctx: makeCtx(makeSessionManagerRecorder().manager),
      });

      assert.equal(result.isError, true, testCase.name);
      assert.match(textAt(result.content), /acceptance\.review is not supported/, testCase.name);
      assert.match(textAt(result.content), /separate parent-controlled reviewer/, testCase.name);
    }
    assert.deepEqual(readAllCallArgs(), []);
  });

  it("rejects group-level chain acceptance during executor preflight", async () => {
    const executor = makeExecutor();

    for (const testCase of [
      {
        name: "static parallel group",
        params: {
          chain: [
            {
              parallel: [{ agent: "echo", task: "review" }],
              acceptance: { criteria: ["Group done"] },
            },
          ],
        },
        pattern: /static parallel groups/,
      },
      {
        name: "dynamic fanout group",
        params: {
          chain: [
            {
              expand: { from: { output: "targets", path: "/items" }, maxItems: 2 },
              parallel: { agent: "echo", task: "review" },
              collect: { as: "reviews" },
              acceptance: { criteria: ["Group done"] },
            },
          ],
        },
        pattern: /dynamic fanout groups/,
      },
    ] as const) {
      // Each scenario owns shared fixture state; complete it before starting the next one.
      // oxlint-disable-next-line no-await-in-loop
      const result = await executor.execute({
        toolCallId: "id",
        params: testCase.params,
        signal: new AbortController().signal,
        ctx: makeCtx(makeSessionManagerRecorder().manager),
      });

      assert.equal(result.isError, true, testCase.name);
      assert.match(textAt(result.content), testCase.pattern, testCase.name);
    }
  });

  it("rejects invalid background top-level parallel requests during executor preflight", async () => {
    const executor = makeExecutor();
    for (const testCase of [
      {
        name: "max tasks",
        params: {
          tasks: [{ agent: "echo", task: "task one", count: 9 }],
          async: true,
          clarify: false,
        },
        patterns: [/Max 8 tasks/, /parallel\.maxTasks/],
      },
      {
        name: "worktree cwd conflict",
        params: {
          tasks: [
            { agent: "echo", task: "task one" },
            { agent: "second", task: "task two", cwd: `${tempDir}/other` },
          ],
          worktree: true,
          async: true,
          clarify: false,
        },
        patterns: [/worktree isolation uses the shared cwd/i, /task 2 \(second\) sets cwd/i],
      },
    ] as const) {
      // Each scenario owns shared fixture state; complete it before starting the next one.
      // oxlint-disable-next-line no-await-in-loop
      const result = await executor.execute({
        toolCallId: "id",
        params: testCase.params,
        signal: new AbortController().signal,
        ctx: makeCtx(makeSessionManagerRecorder().manager),
      });

      assert.equal(result.isError, true, testCase.name);
      for (const pattern of testCase.patterns) {
        assert.match(textAt(result.content), pattern, testCase.name);
      }
    }
  });

  it("rejects async chain worktree runs with a conflicting task cwd", async () => {
    const { manager } = makeSessionManagerRecorder({
      sessionFile: "/tmp/parent.jsonl",
      leafId: "leaf-chain",
    });
    const executor = makeExecutor();

    const result = await executor.execute({
      toolCallId: "id",
      params: {
        chain: [
          {
            parallel: [
              { agent: "echo", task: "p1" },
              { agent: "second", task: "p2", cwd: `${tempDir}/other` },
            ],
            worktree: true,
          },
        ],
        async: true,
        clarify: false,
      },
      signal: new AbortController().signal,
      ctx: makeCtx(manager),
    });

    assert.equal(result.isError, true);
    assert.match(textAt(result.content), /parallel chain step 1/i);
    assert.match(textAt(result.content), /task 2 \(second\) sets cwd/i);
  });

  it("creates isolated forked sessions per chain step (including counted parallel steps)", async () => {
    const { manager, openedPaths, branchedLeafIds } = makeForkingSessionManagerRecorder({
      sessionFile: path.join(tempDir, "parent-chain.jsonl"),
      leafId: "leaf-chain",
    });
    const executor = makeExecutor();

    const result = await executor.execute({
      toolCallId: "id",
      params: {
        chain: [
          { agent: "echo", task: "step 1" },
          {
            parallel: [
              { agent: "echo", task: "p1", count: 2 },
              { agent: "second", task: "p2", count: 2 },
            ],
          },
          { agent: "second", task: "step 3" },
        ],
        context: "fork",
        clarify: false,
      },
      signal: new AbortController().signal,
      ctx: makeCtx(manager),
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(openedPaths, Array(6).fill(path.join(tempDir, "parent-chain.jsonl")));
    assert.deepEqual(branchedLeafIds, Array(6).fill(manager.getLeafId()));
    const sessionArgs = readSessionArgsFromCalls().filter(isNativeFork);
    assert.equal(sessionArgs.length, 6, "1 sequential + 4 parallel + 1 sequential");
    assert.equal(new Set(sessionArgs).size, 6);
  });

  it("uses request cwd for management actions", async () => {
    const executor = makeExecutor();
    const worktreeDir = path.join(tempDir, "worktree");
    fs.mkdirSync(path.join(worktreeDir, ".pi"), { recursive: true });

    const result = await executor.execute({
      toolCallId: "id",
      params: {
        action: "create",
        cwd: "worktree",
        config: {
          name: "local-helper",
          description: "Local helper",
          scope: "project",
        },
      },
      signal: new AbortController().signal,
      ctx: makeCtx(makeSessionManagerRecorder().manager),
    });

    assert.equal(result.isError, false);
    assert.equal(fs.existsSync(path.join(worktreeDir, ".pi", "agents", "local-helper.md")), true);
    assert.equal(fs.existsSync(path.join(tempDir, ".pi", "agents", "local-helper.md")), false);
  });

  it("uses request cwd for execution-time agent discovery", async () => {
    const worktreeDir = path.join(tempDir, "worktree");
    writeAgent(tempDir, "echo", "openai/gpt-5-main");
    writeAgent(worktreeDir, "echo", "anthropic/claude-haiku-4-5");
    const executor = makeExecutorWithDiscoverAgents(discoverAgents);
    const task = `test ${path.basename(tempDir)}`;

    const result = await executor.execute({
      toolCallId: "id",
      params: { agent: "echo", task, cwd: "worktree" },
      signal: new AbortController().signal,
      ctx: makeCtx(makeSessionManagerRecorder().manager),
    });

    assert.equal(result.isError, undefined);
    const args = readAllCallArgs().find((callArgs) => (callArgs.at(-1) ?? "") === `Task: ${task}`);
    assert.ok(args, "expected a recorded mock pi call for this test task");
    const modelIndex = args.indexOf("--model");
    assert.notEqual(modelIndex, -1);
    assert.equal(args[modelIndex + 1], "anthropic/claude-haiku-4-5");
  });

  it("resolves parallel task cwd values relative to the request cwd", async () => {
    const worktreeDir = path.join(tempDir, "worktree");
    writePackageSkill(path.join(worktreeDir, "packages", "app"), "parallel-step-skill");
    const executor = makeExecutorWithDiscoverAgents(() => ({
      agents: [
        {
          ...makeAgent("echo", { inheritProjectContext: true, inheritSkills: true }),
          name: "echo",
          description: "Echo test agent",
          skills: ["parallel-step-skill"],
        },
      ],
      projectAgentsDir: null,
    }));

    const result = await executor.execute({
      toolCallId: "id",
      params: {
        tasks: [{ agent: "echo", task: "test", cwd: "packages/app" }],
        cwd: worktreeDir,
      },
      signal: new AbortController().signal,
      ctx: makeCtx(makeSessionManagerRecorder().manager),
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(result.details.results[0].skills, ["parallel-step-skill"]);
  });

  it("uses request cwd for project builtin overrides during management", async () => {
    const tempHome = createTempDir("pi-subagent-home-");
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    const worktreeDir = path.join(tempDir, "worktree");
    fs.mkdirSync(worktreeDir, { recursive: true });
    writeProjectOverride(tempDir, "reviewer", "openai/gpt-5-main");
    writeProjectOverride(worktreeDir, "reviewer", "openai/gpt-5-worktree");
    const executor = makeExecutor();

    try {
      const result = await executor.execute({
        toolCallId: "id",
        params: { action: "get", agent: "reviewer", cwd: "worktree" },
        signal: new AbortController().signal,
        ctx: makeCtx(makeSessionManagerRecorder().manager),
      });

      assert.equal(result.isError, false);
      assert.match(textAt(result.content), /Model: openai\/gpt-5-worktree/);
      assert.doesNotMatch(textAt(result.content), /Model: openai\/gpt-5-main/);
    } finally {
      removeTempDir(tempHome);
    }
  });
});
