import "../support/isolated-home.ts";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createSubagentExecutor,
  type SubagentParamsLike,
} from "../../src/runs/foreground/subagent-executor.ts";
import {
  createSupervisorQuestion,
  getRunMetadataDir,
  questionProcessAlive,
  readQuestionContract,
} from "../../src/runs/shared/supervisor-questions.ts";
import {
  ASYNC_DIR,
  RESULTS_DIR,
  getAsyncConfigPath,
  type SubagentExecutionResult,
} from "../../src/shared/types.ts";
import { readStatus } from "../../src/shared/utils.ts";
import { parseForegroundResumeRun } from "../../src/runs/background/run-schemas.ts";
import { createSubagentState, readResult, toolText } from "../support/background-fixtures.ts";
import {
  assertDefined,
  json,
  record,
  readJson,
  text,
  strings,
  numberValue,
} from "../support/assertions.ts";
import { fauxProvider } from "@earendil-works/pi-ai";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { TuiMainScreen } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { createTestTerminal } from "../support/terminal.ts";
import type { ReadonlyDeep } from "type-fest";
initTheme("dark", false);
import {
  createEventBus,
  createMockPi,
  createTempDir,
  makeAgent,
  makeMinimalCtx,
  removeTempDir,
  type MockPi,
} from "../support/helpers.ts";

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, message);
    // Poll the actual filesystem publication before advancing to revival.
    // oxlint-disable-next-line no-await-in-loop
    await delay(20);
  }
}

function savedLaunch(runId: string, index = 0, readConfiguration = true) {
  const launch = readQuestionContract(
    runId,
    index,
    undefined,
    readConfiguration ? {} : { readConfiguration: false },
  )?.launch;
  assert.ok(launch, `missing saved launch for ${runId}:${index}`);
  return launch;
}

function contractBytes(runId: string, index = 0): Buffer {
  return fs.readFileSync(path.join(getRunMetadataDir(runId), "contracts", `${index}.json`));
}

const writer = { agent: "writer", task: "Write the report", outputMode: "file-only" as const };
const producer = { agent: "producer", task: "Prepare inputs" };
function launchRoutes(
  model?: string,
): Array<{ name: string; params: SubagentParamsLike; indices: number[]; structured?: boolean }> {
  const task = { ...writer, ...(model !== undefined ? { model } : {}) };
  return [
    { name: "single", params: task, indices: [0] },
    { name: "parallel", params: { tasks: [task, task] }, indices: [0, 1] },
    { name: "sequential chain", params: { chain: [producer, task] }, indices: [1] },
    { name: "parallel chain", params: { chain: [{ parallel: [task, task] }] }, indices: [0, 1] },
    {
      name: "dynamic fanout",
      params: {
        chain: [
          { ...producer, as: "inputs", outputSchema: { type: "object" } },
          {
            expand: { from: { output: "inputs", path: "/items" }, maxItems: 2 },
            parallel: task,
            collect: { as: "reports" },
          },
        ],
      },
      indices: [1, 2],
      structured: true,
    },
  ];
}
const routes = launchRoutes();
function executionLabel(background: boolean): string {
  return background ? "async" : "foreground";
}
function modelPolicyLabel(model: string | undefined): string {
  return model === undefined ? "inherited" : "pinned";
}
function profileLabel(current: boolean): string {
  return current ? "current profile" : "saved launch";
}

describe("saved output choices", () => {
  let mockPi: MockPi;
  let tempDir: string;
  let profile: ReturnType<typeof makeAgent>;
  let ctx: ReturnType<typeof makeMinimalCtx>;
  let executor: ReturnType<typeof createSubagentExecutor>;
  let discoveries: number;
  let runIds: Set<string>;

  before(() => {
    mockPi = createMockPi();
    mockPi.install();
  });
  after(() => mockPi.uninstall());

  beforeEach(() => {
    tempDir = createTempDir("pi-output-revival-");
    profile = makeAgent("writer", { output: "reports/frozen.md" });
    ctx = makeMinimalCtx(tempDir);
    discoveries = 0;
    runIds = new Set();
    mockPi.reset();
    executor = createExecutor();
  });

  function acceptBackgroundPreview(): void {
    ctx.ui.custom = async (factory) =>
      new Promise((resolve, reject) => {
        const component = factory(
          new TuiMainScreen(createTestTerminal()),
          ctx.ui.theme,
          new KeybindingsManager(),
          resolve,
        );
        Promise.resolve(component)
          .then((view) => {
            assert.equal(typeof view.handleInput, "function");
            view.handleInput?.("b");
            view.handleInput?.("\r");
          })
          .catch(reject);
      });
  }

  function createExecutor() {
    return createSubagentExecutor({
      pi: { events: createEventBus(), getSessionName: () => "output-parent" },
      state: createSubagentState(tempDir),
      config: {},
      asyncByDefault: false,
      tempArtifactsDir: path.join(tempDir, "artifacts"),
      getSubagentSessionRoot: () => path.join(tempDir, "sessions"),
      expandTilde: (value: string) => value,
      discoverAgents: () => {
        discoveries++;
        return { agents: [profile, makeAgent("producer")] };
      },
    });
  }

  afterEach(() => {
    for (const runId of runIds) {
      removeTempDir(getRunMetadataDir(runId));
      removeTempDir(path.join(ASYNC_DIR, runId));
      fs.rmSync(path.join(RESULTS_DIR, `${runId}.json`), { force: true });
      fs.rmSync(getAsyncConfigPath(runId), { force: true });
    }
    removeTempDir(tempDir);
  });

  async function run(params: ReadonlyDeep<SubagentParamsLike>): Promise<SubagentExecutionResult> {
    const result = await executor.execute({ toolCallId: "output-revival", params, ctx });
    assert.notEqual(result.isError, true, toolText(result.content));
    const id = result.details.runId ?? result.details.asyncId;
    assertDefined(id);
    runIds.add(id);
    if (result.details.asyncId !== undefined) {
      const resultPath = path.join(RESULTS_DIR, `${id}.json`);
      await waitFor(() => fs.existsSync(resultPath), `missing async result for ${id}`);
      const payload = readResult(resultPath);
      assert.equal(payload.success, true, JSON.stringify(payload));
      const pid = readStatus(text(result.details.asyncDir))?.pid;
      assertDefined(pid);
      await waitFor(() => !questionProcessAlive({ pid }), `async runner ${pid} did not exit`);
    }
    return result;
  }

  async function continueWithOwnOutput(
    runId: string,
    index = 0,
    overrides: ReadonlyDeep<SubagentParamsLike> = {},
  ) {
    const previous = savedLaunch(runId, index);
    assert.ok(typeof previous.output === "string");
    const bytes = fs.existsSync(previous.output) ? fs.readFileSync(previous.output) : undefined;
    const receipt = contractBytes(runId, index);
    const resultPath = ["result.json", "foreground.json"]
      .map((name) => path.join(getRunMetadataDir(runId), name))
      .find((file) => fs.existsSync(file));
    assertDefined(resultPath);
    const resultBytes = fs.readFileSync(resultPath);
    const savedResult =
      path.basename(resultPath) === "foreground.json"
        ? parseForegroundResumeRun(readJson(resultPath))
        : readResult(resultPath);
    assertDefined(savedResult);
    const artifactPath =
      "children" in savedResult
        ? savedResult.children.find((child) => child.index === index)?.artifactPath
        : savedResult.results[index]?.artifactPaths?.outputPath;
    if (previous.artifacts) {
      assertDefined(artifactPath);
    }
    const artifactBytes = artifactPath !== undefined ? fs.readFileSync(artifactPath) : undefined;
    const discoveryCount = discoveries;
    profile = { ...profile, output: "changed-current-profile.md" };
    mockPi.onCall({ output: "Successor report — new bytes" });
    const continued = await run({
      action: "resume",
      id: runId,
      index,
      message: "Write a follow-up report",
      ...overrides,
    });
    const successorId = text(continued.details.asyncId);
    const successor = savedLaunch(successorId);
    assert.ok(typeof successor.output === "string");
    assert.notEqual(
      successor.output,
      previous.output,
      "continuation must not reuse the predecessor output path",
    );
    assert.ok(path.basename(successor.output).startsWith(`${successorId}_writer_0_`));
    assert.ok(
      successor.output.endsWith("_frozen.md"),
      "use the frozen saved filename, not the current profile",
    );
    if (bytes) {
      assert.deepEqual(
        fs.readFileSync(previous.output),
        bytes,
        "predecessor bytes must stay intact",
      );
    } else {
      assert.equal(
        fs.existsSync(previous.output),
        false,
        "do not recreate a consumed predecessor file",
      );
    }
    assert.deepEqual(
      contractBytes(runId, index),
      receipt,
      "continuation must not rewrite its predecessor receipt",
    );
    assert.deepEqual(
      fs.readFileSync(resultPath),
      resultBytes,
      "predecessor result must stay intact",
    );
    if (artifactPath !== undefined) {
      assert.deepEqual(
        fs.readFileSync(artifactPath),
        artifactBytes,
        "predecessor artifact must stay intact",
      );
    }
    assert.equal(discoveries, discoveryCount, "saved continuation must not rediscover the profile");
    assert.equal(previous.generatedOutputFilename, "frozen.md");
    assert.equal(successor.generatedOutputFilename, "frozen.md");
    assert.equal(successor.agent.output, "reports/frozen.md");
    assert.equal(successor.outputMode, overrides.outputMode ?? previous.outputMode);
    assertSuccessorOutput(successorId);
    return successorId;
  }

  function assertSuccessorOutput(successorId: string): void {
    const successor = savedLaunch(successorId);
    const output = text(successor.output);
    const payload = readResult(path.join(RESULTS_DIR, `${successorId}.json`));
    if (successor.outputMode === "file-only") {
      assert.equal(fs.readFileSync(output, "utf8"), "Successor report — new bytes");
      assert.match(text(payload.results[0]?.output), /Output saved to:/);
      assert.doesNotMatch(text(payload.results[0]?.output), /Successor report/);
    } else {
      assert.equal(
        fs.existsSync(output),
        false,
        "inline generated output is consumed after capture",
      );
      assert.match(text(payload.results[0]?.output), /Successor report/);
      assert.match(text(payload.results[0]?.output), /Output file consumed:/);
    }
  }

  it("reuses a live continuation when resuming the original async directory again", async () => {
    mockPi.onCall({ output: "Original report" });
    const original = await run({ ...writer, async: true });
    mockPi.onCall({ output: "Continued report", delay: 2_000 });
    const continuations: SubagentExecutionResult[] = [];
    try {
      const first = await executor.execute({
        toolCallId: "resume-dir",
        params: {
          action: "resume",
          dir: original.details.asyncDir,
          message: "First follow-up",
          async: true,
        },
        ctx,
      });
      assert.notEqual(first.isError, true);
      continuations.push(first);
      runIds.add(text(first.details.asyncId));
      await waitFor(() => mockPi.callCount() === 2, "the continuation must start");
      await waitFor(
        () => Boolean(readQuestionContract(text(first.details.asyncId), 0)?.pid),
        "the continuation must publish its process contract",
      );
      const liveContract = contractBytes(text(first.details.asyncId));
      const second = await executor.execute({
        toolCallId: "resume-dir-again",
        params: {
          action: "resume",
          dir: original.details.asyncDir,
          message: "Second follow-up",
          model: "mock/not-a-live-mutation:high",
          async: true,
        },
        ctx,
      });
      assert.deepEqual(
        contractBytes(text(first.details.asyncId)),
        liveContract,
        "live guidance must not mutate launch policy",
      );
      if (second.details.asyncId !== undefined) {
        continuations.push(second);
        runIds.add(second.details.asyncId);
      }
      assert.equal(
        second.details.asyncId,
        undefined,
        "resume by dir must steer the same live continuation, not start another child",
      );
      assert.match(
        toolText(second.content),
        /Nudge was not delivered/,
        "the fixture has no intercom endpoint",
      );
      assert.equal(mockPi.callCount(), 2);
    } finally {
      for (const continuation of continuations) {
        // Teardown joins each published successor before deleting its files.
        // oxlint-disable-next-line no-await-in-loop
        await waitFor(
          () => fs.existsSync(path.join(RESULTS_DIR, `${text(continuation.details.asyncId)}.json`)),
          "continuation cleanup",
        );
        // Do not remove runner resources while the native process is still alive.
        // oxlint-disable-next-line no-await-in-loop
        await waitFor(
          () =>
            !questionProcessAlive({
              pid: numberValue(readStatus(text(continuation.details.asyncDir))?.pid),
            }),
          "continuation runner must exit",
        );
      }
    }
  });

  function registerGeneratedOutputRoutes(): void {
    for (const async of [true, false]) {
      for (const route of routes) {
        it(`${executionLabel(async)} ${route.name} regenerates default outputs from saved launches`, async () => {
          if (route.structured === true) {
            mockPi.onCall({ output: "Inputs", structuredOutput: { items: ["a", "b"] } });
          }
          mockPi.onCall({ output: "Predecessor report — preserved bytes\n" });
          const original = await run({ ...route.params, async });
          const id = text(original.details.runId);
          for (const index of route.indices) {
            // Each successor must finish before reviving the next saved child.
            // oxlint-disable-next-line no-await-in-loop
            await continueWithOwnOutput(id, index);
          }
        });
      }
    }
  }
  registerGeneratedOutputRoutes();

  function registerModelPolicyRoutes(): void {
    for (const async of [true, false]) {
      for (const override of [undefined, "mock/chosen:high"]) {
        for (const route of launchRoutes(override)) {
          it(`${executionLabel(async)} ${route.name} preserves ${modelPolicyLabel(override)} model policy through revival`, async () => {
            profile = {
              ...profile,
              model: undefined,
              thinking: "medium",
              fallbackModels: ["mock/backup:low"],
            };
            const parentModel = { ...fauxProvider().getModel(), provider: "mock", id: "inherited" };
            ctx.model = parentModel;
            if (route.structured === true) {
              mockPi.onCall({ output: "Inputs", structuredOutput: { items: ["a", "b"] } });
            }
            mockPi.onCall({ output: "Report" });
            const original = await run({ ...route.params, async });
            const id = text(original.details.runId);
            const expectedModel = override ?? "mock/inherited:medium";
            const expectedCandidates =
              override !== undefined ? [override] : [expectedModel, "mock/backup:low"];
            profile = {
              ...profile,
              model: "mock/updated",
              thinking: "low",
              fallbackModels: ["mock/updated-backup"],
            };
            for (const index of route.indices) {
              const launch = savedLaunch(id, index);
              assert.equal(launch.model, expectedModel);
              assert.equal(launch.thinking, override !== undefined ? "high" : "medium");
              assert.deepEqual(launch.modelCandidates, expectedCandidates);
              // Revivals share their saved run and must settle in order.
              // oxlint-disable-next-line no-await-in-loop
              const continued = await run({ action: "resume", id, index, message: "Continue" });
              const successor = savedLaunch(text(continued.details.asyncId));
              assert.equal(successor.model, expectedModel);
              assert.equal(successor.thinking, launch.thinking);
              assert.deepEqual(successor.modelCandidates, expectedCandidates);
            }
          });
        }
      }
    }
  }
  registerModelPolicyRoutes();

  for (const route of routes.filter((entry) =>
    ["single", "parallel", "sequential chain"].includes(entry.name),
  )) {
    it(`clarify-to-background ${route.name} preserves generated output origin`, async () => {
      ctx.hasUI = true;
      acceptBackgroundPreview();
      mockPi.onCall({ output: "Predecessor report" });
      const original = await run({ ...route.params, async: true, clarify: true });
      assertDefined(original.details.asyncId);
      for (const index of route.indices) {
        // Each child continuation must finish before starting the next one.
        // oxlint-disable-next-line no-await-in-loop
        await continueWithOwnOutput(original.details.asyncId, index);
      }
    });
  }

  for (const output of [true, "true"] as const) {
    it(`explicit output:${JSON.stringify(output)} keeps the generated default over repeated continuations`, async () => {
      mockPi.onCall({ output: "Predecessor report" });
      const original = await run({ ...writer, async: true, output });
      const successorId = await continueWithOwnOutput(text(original.details.asyncId));
      await continueWithOwnOutput(successorId);
    });
  }

  for (const reviverRoot of ["root-A", "root-B"]) {
    it(`saved revival belongs to ${reviverRoot} after root-A's executor exits`, async () => {
      ctx.sessionManager.getSessionId = () => "root-A";
      mockPi.onCall({ echoEnv: ["PI_SUBAGENT_ROOT_SESSION_ID"] });
      const original = await run({ ...writer, async: true, output: false, outputMode: "inline" });
      const id = text(original.details.asyncId);
      const originalPayload = readResult(path.join(RESULTS_DIR, `${id}.json`));
      assert.equal(
        json(text(originalPayload.results[0]?.output)).PI_SUBAGENT_ROOT_SESSION_ID,
        "root-A",
      );
      // Older persisted contracts may still carry the original root.
      const contractPath = path.join(getRunMetadataDir(id), "contracts", "0.json");
      const contract = record(readJson(contractPath));
      record(contract.launch).rootSessionId = "root-A";
      fs.writeFileSync(contractPath, JSON.stringify(contract));
      const receipt = contractBytes(id);

      ctx = makeMinimalCtx(tempDir);
      ctx.sessionManager.getSessionId = () => reviverRoot;
      executor = createExecutor();
      mockPi.onCall({ echoEnv: ["PI_SUBAGENT_ROOT_SESSION_ID"] });
      const continued = await run({
        action: "resume",
        id,
        message: "Continue",
        output: false,
        outputMode: "inline",
      });
      const successorId = text(continued.details.asyncId);
      const payload = readResult(path.join(RESULTS_DIR, `${successorId}.json`));
      assert.equal(json(text(payload.results[0]?.output)).PI_SUBAGENT_ROOT_SESSION_ID, reviverRoot);
      assert.deepEqual(contractBytes(id), receipt, "revival must not rewrite the old contract");
    });
  }

  it("an inline continuation consumes only its new generated file", async () => {
    mockPi.onCall({ output: "Predecessor report" });
    const original = await run({ ...writer, async: true });
    await continueWithOwnOutput(text(original.details.asyncId), 0, { outputMode: "inline" });
  });

  it("inline launches preserve predecessor artifacts and results while consuming both temporary files", async () => {
    mockPi.onCall({ output: "Inline predecessor report" });
    const original = await run({ ...writer, async: true, outputMode: "inline" });
    const previous = savedLaunch(text(original.details.asyncId));
    assert.ok(typeof previous.output === "string");
    assert.equal(fs.existsSync(previous.output), false);
    await continueWithOwnOutput(text(original.details.asyncId));
  });

  for (const async of [true, false]) {
    for (const choice of ["explicit", "absolute-default", "disabled"] as const) {
      it(`${executionLabel(async)} ${choice} output retains its fixed or disabled contract`, async () => {
        const fixedPath = path.join(tempDir, "fixed.md");
        if (choice === "explicit") {
          profile = { ...profile, output: "fixed.md" };
        }
        if (choice === "absolute-default") {
          profile = { ...profile, output: fixedPath };
        }
        mockPi.onCall({ output: "First report" });
        const original = await run({
          ...writer,
          async,
          ...(choice === "explicit" ? { output: "fixed.md" } : {}),
          ...(choice === "disabled" ? { output: false, outputMode: "inline" } : {}),
        });
        const id = text(original.details.runId);
        const previous = savedLaunch(id);
        const receipt = contractBytes(id);
        assert.equal(previous.generatedOutputFilename, undefined);
        assert.equal(previous.output, choice === "disabled" ? false : fixedPath);
        mockPi.onCall({ output: "Replacement report" });
        const continued = await run({ action: "resume", id, message: "Replace the report" });
        const successor = savedLaunch(text(continued.details.asyncId));
        assert.equal(successor.output, previous.output);
        assert.equal(successor.generatedOutputFilename, undefined);
        assert.equal(successor.outputMode, previous.outputMode);
        assert.deepEqual(contractBytes(id), receipt);
        if (choice !== "disabled") {
          assert.equal(fs.readFileSync(fixedPath, "utf8"), "Replacement report");
        } else {
          assert.equal(fs.existsSync(fixedPath), false);
        }
      });
    }
  }

  for (const output of ["override.md", false] as const) {
    it(`explicit continuation output:${JSON.stringify(output)} replaces only the output choice`, async () => {
      mockPi.onCall({ output: "Predecessor report" });
      const original = await run({ ...writer, async: true });
      const id = text(original.details.asyncId);
      const previous = savedLaunch(id);
      assert.ok(typeof previous.output === "string");
      const bytes = fs.readFileSync(previous.output);
      mockPi.onCall({ output: "Override report" });
      const continued = await run({
        action: "resume",
        id,
        message: "Use the override",
        output,
        outputMode: output === false ? "inline" : "file-only",
      });
      const successor = savedLaunch(text(continued.details.asyncId));
      assert.equal(successor.generatedOutputFilename, undefined);
      assert.equal(successor.output, output === false ? false : path.join(tempDir, output));
      assert.deepEqual(fs.readFileSync(previous.output), bytes);
      if (typeof successor.output === "string") {
        assert.equal(fs.readFileSync(successor.output, "utf8"), "Override report");
      }
    });
  }

  it("generated output survives continuation with debug artifacts disabled", async () => {
    mockPi.onCall({ output: "Predecessor report" });
    const original = await run({ ...writer, async: true, artifacts: false });
    assert.equal(savedLaunch(text(original.details.asyncId)).artifacts, false);
    await continueWithOwnOutput(text(original.details.asyncId));
  });

  it("explicit continuation output:true selects the saved default instead of an earlier fixed override", async () => {
    mockPi.onCall({ output: "Fixed predecessor" });
    const original = await run({ ...writer, async: true, output: "fixed.md" });
    profile = { ...profile, output: "changed-current-profile.md" };
    mockPi.onCall({ output: "New default report" });
    const continued = await run({
      action: "resume",
      id: original.details.asyncId,
      message: "Use the default",
      output: true,
    });
    const successor = savedLaunch(text(continued.details.asyncId));
    assert.ok(typeof successor.output === "string");
    assert.ok(
      path.basename(successor.output).startsWith(`${text(continued.details.asyncId)}_writer_0_`),
    );
    assert.ok(successor.output.endsWith("_frozen.md"));
    assert.equal(successor.generatedOutputFilename, "frozen.md");
    assert.equal(fs.readFileSync(successor.output, "utf8"), "New default report");
    assert.equal(fs.readFileSync(path.join(tempDir, "fixed.md"), "utf8"), "Fixed predecessor");
  });

  for (const clarify of [false, true]) {
    for (const output of [undefined, true]) {
      it(`async absolute default remains fixed in inline mode (clarify:${clarify}, resume output:${String(output)})`, async () => {
        profile = { ...profile, output: path.join(tempDir, "absolute.md") };
        ctx.hasUI = clarify;
        acceptBackgroundPreview();
        mockPi.onCall({ output: "Absolute predecessor" });
        const original = await run({ ...writer, async: true, clarify, outputMode: "inline" });
        assert.equal(
          savedLaunch(text(original.details.asyncId)).generatedOutputFilename,
          undefined,
        );
        assert.equal(fs.readFileSync(text(profile.output), "utf8"), "Absolute predecessor");
        mockPi.onCall({ output: "Absolute successor" });
        const continued = await run({
          action: "resume",
          id: original.details.asyncId,
          message: "Replace fixed output",
          output,
        });
        assert.equal(savedLaunch(text(continued.details.asyncId)).output, profile.output);
        assert.equal(fs.readFileSync(text(profile.output), "utf8"), "Absolute successor");
      });
    }
  }

  it("a successor's newly written file wins over its assistant receipt without touching the predecessor", async () => {
    mockPi.onCall({ output: "Predecessor report" });
    const original = await run({ ...writer, async: true });
    const previous = savedLaunch(text(original.details.asyncId));
    assert.ok(typeof previous.output === "string");
    const bytes = fs.readFileSync(previous.output);
    const release = path.join(tempDir, "release-successor");
    mockPi.onCall({ output: "Short assistant receipt", waitForFile: release });
    const pending = run({
      action: "resume",
      id: original.details.asyncId,
      message: "Write the detailed successor report",
    });
    let successor: ReturnType<typeof savedLaunch>;
    try {
      await waitFor(
        () => mockPi.callCount() === 2,
        "successor child must start before its file is written",
      );
      successor = savedLaunch(text([...runIds].at(-1)));
      assert.ok(typeof successor.output === "string");
      fs.mkdirSync(path.dirname(successor.output), { recursive: true });
      fs.writeFileSync(successor.output, "Detailed child-written report\n");
    } finally {
      fs.writeFileSync(release, "");
      await pending;
    }
    const continued = await pending;
    const payload = readResult(path.join(RESULTS_DIR, `${text(continued.details.asyncId)}.json`));
    const artifactPath = payload.results[0]?.artifactPaths?.outputPath;
    assertDefined(artifactPath);
    assert.equal(fs.readFileSync(artifactPath, "utf8"), "Detailed child-written report");
    assert.equal(fs.readFileSync(successor.output, "utf8"), "Detailed child-written report\n");
    assert.deepEqual(fs.readFileSync(previous.output), bytes);
  });

  it("legacy snapshots without origin proof retain matching-looking generated paths", async () => {
    mockPi.onCall({ output: "Legacy report" });
    const original = await run({ ...writer, async: true });
    const id = text(original.details.asyncId);
    const legacy = { ...savedLaunch(id) };
    delete legacy.generatedOutputFilename;
    fs.writeFileSync(
      path.join(getRunMetadataDir(id), "contracts", "0.json"),
      JSON.stringify({ ...json(contractBytes(id).toString()), launch: legacy }),
    );
    const receipt = contractBytes(id);
    assert.ok(typeof legacy.output === "string");
    assert.ok(legacy.output.includes(id));
    mockPi.onCall({ output: "Legacy replacement" });
    const continued = await run({ action: "resume", id, message: "Use the saved output choice" });
    const successor = savedLaunch(text(continued.details.asyncId));
    assert.equal(successor.output, legacy.output);
    assert.equal(successor.generatedOutputFilename, undefined);
    assert.equal(fs.readFileSync(legacy.output, "utf8"), "Legacy replacement");
    assert.deepEqual(contractBytes(id), receipt, "do not migrate legacy receipts");
  });

  for (const action of ["resume", "answer"] as const) {
    for (const outputMode of ["inline", "file-only"] as const) {
      it(`explicit profile ${action} retains the original generated filename (${outputMode})`, async () => {
        mockPi.onCall({ output: "Predecessor report" });
        const original = await run({
          ...writer,
          async: true,
          outputMode,
          model: "mock/old:medium",
        });
        const id = text(original.details.asyncId);
        const previous = savedLaunch(id);
        assert.ok(typeof previous.output === "string");
        const receipt = contractBytes(id);
        const bytes = fs.existsSync(previous.output) ? fs.readFileSync(previous.output) : undefined;
        const contract = readQuestionContract(id, 0);
        assertDefined(contract);
        const question =
          action === "answer"
            ? createSupervisorQuestion({
                runId: id,
                index: 0,
                agent: "writer",
                ownerTarget: "fixture-parent",
                childTarget: "fixture-child",
                childSessionId: "fixture-session",
                sessionFile: text(contract.sessionFile),
                cwd: tempDir,
                pid: numberValue(contract.pid),
                reason: "need_decision",
                message: "May I continue?",
              })
            : undefined;
        profile = { ...profile, output: "changed-current-profile.md" };
        profile = {
          ...profile,
          model: "mock/current",
          thinking: "high",
          fallbackModels: ["mock/backup:low"],
          systemPrompt: "Use the explicitly selected current profile.",
        };
        mockPi.onCall({ output: "Current-profile successor report" });
        const continued = await run({
          action,
          id,
          agent: "writer",
          questionId: question?.questionId,
          message: "Continue with the current profile",
        });
        const successor = savedLaunch(text(continued.details.asyncId));
        assert.ok(typeof successor.output === "string");
        assert.notEqual(successor.output, previous.output);
        assert.ok(
          path
            .basename(successor.output)
            .startsWith(`${text(continued.details.asyncId)}_writer_0_`),
        );
        assert.ok(
          successor.output.endsWith("_frozen.md"),
          "profile selection does not replace the saved output choice",
        );
        assert.equal(
          successor.agent.output,
          profile.output,
          "the saved profile must remain the current selected profile",
        );
        assert.match(successor.systemPrompt, /explicitly selected current profile/);
        assert.equal(successor.model, "mock/current:high");
        assert.equal(successor.thinking, "high");
        assert.deepEqual(successor.modelCandidates, ["mock/current:high", "mock/backup:low"]);
        assert.equal(successor.outputMode, outputMode);
        if (bytes) {
          assert.deepEqual(fs.readFileSync(previous.output), bytes);
        } else {
          assert.equal(fs.existsSync(previous.output), false);
        }
        assert.deepEqual(contractBytes(id), receipt);
        if (outputMode === "file-only") {
          assert.equal(
            fs.readFileSync(successor.output, "utf8"),
            "Current-profile successor report",
          );
        } else {
          assert.equal(
            fs.existsSync(successor.output),
            false,
            "generated inline output still gets consumed",
          );
        }

        mockPi.onCall({ output: "Repeated successor report" });
        const repeated = await run({
          action: "resume",
          id: continued.details.asyncId,
          message: "Continue again without selecting a profile",
        });
        const latest = savedLaunch(text(repeated.details.asyncId));
        assert.ok(typeof latest.output === "string");
        assert.notEqual(latest.output, successor.output);
        assert.ok(
          latest.output.endsWith("_frozen.md"),
          "the preserved filename survives another saved continuation",
        );
        assert.equal(latest.agent.output, profile.output);
        assert.equal(latest.model, successor.model);
        assert.deepEqual(latest.modelCandidates, successor.modelCandidates);
        if (outputMode === "file-only") {
          assert.equal(fs.readFileSync(latest.output, "utf8"), "Repeated successor report");
        } else {
          assert.equal(fs.existsSync(latest.output), false);
        }
      });
    }
  }

  it("saved continuation preserves its pinned launch instead of mutable native display metadata", async () => {
    mockPi.onCall({ output: "Original" });
    const original = await run({ ...writer, async: true, model: "mock/chosen:high" });
    const id = text(original.details.asyncId);
    const contract = readQuestionContract(id, 0);
    assertDefined(contract);
    const timestamp = new Date().toISOString();
    fs.writeFileSync(
      text(contract.sessionFile),
      [
        { type: "session", version: 3, id: "native-session", cwd: tempDir, timestamp },
        {
          type: "model_change",
          id: "model",
          parentId: null,
          provider: "native",
          modelId: "later",
          timestamp,
        },
        {
          type: "thinking_level_change",
          id: "thinking",
          parentId: "model",
          thinkingLevel: "low",
          timestamp,
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    assert.equal(
      readQuestionContract(id, 0)?.launch?.model,
      "mock/chosen:high",
      "default reads retain the captured selection",
    );
    const continued = await run({ action: "resume", id, message: "Continue" });
    const successor = savedLaunch(text(continued.details.asyncId), 0, false);
    assert.equal(successor.model, "mock/chosen:high");
    assert.equal(successor.thinking, "high");
    assert.deepEqual(successor.modelCandidates, ["mock/chosen:high"]);
    const calls = fs
      .readdirSync(mockPi.dir)
      .filter((name) => /^call-.*\.json$/.test(name))
      .sort((left, right) => left.localeCompare(right));
    const args = strings(record(readJson(path.join(mockPi.dir, text(calls.at(-1))))).args);
    assert.equal(args[args.indexOf("--model") + 1], "mock/chosen:high");
  });

  for (const selectProfile of [false, true]) {
    it(`explicit continuation model wins over ${profileLabel(selectProfile)} policy`, async () => {
      profile = {
        ...profile,
        model: "mock/original",
        thinking: "medium",
        fallbackModels: ["mock/original-backup:low"],
      };
      mockPi.onCall({ output: "Original" });
      const original = await run({ ...writer, async: true });
      profile = {
        ...profile,
        model: "mock/current",
        thinking: "low",
        fallbackModels: ["mock/current-backup"],
      };
      const continued = await run({
        action: "resume",
        id: original.details.asyncId,
        message: "Continue",
        ...(selectProfile ? { agent: "writer" } : {}),
        model: "mock/chosen:high",
      });
      const successor = savedLaunch(text(continued.details.asyncId));
      assert.equal(successor.model, "mock/chosen:high");
      assert.equal(successor.thinking, "high");
      assert.deepEqual(successor.modelCandidates, ["mock/chosen:high"]);
      const repeated = await run({
        action: "resume",
        id: continued.details.asyncId,
        message: "Keep going",
      });
      assert.deepEqual(savedLaunch(text(repeated.details.asyncId)).modelCandidates, [
        "mock/chosen:high",
      ]);
    });
  }

  for (const choice of [
    "explicit",
    "absolute-default",
    "disabled",
    "legacy",
    "no-launch",
    "new-default",
  ] as const) {
    it(`explicit profile selection preserves ${choice} output intent`, async () => {
      if (choice === "absolute-default") {
        profile = { ...profile, output: path.join(tempDir, "absolute.md") };
      }
      mockPi.onCall({ output: "Predecessor report" });
      const original = await run({
        ...writer,
        async: true,
        ...(choice === "explicit" ? { output: "fixed.md" } : {}),
        ...(choice === "disabled" ? { output: false, outputMode: "inline" } : {}),
      });
      const id = text(original.details.asyncId);
      const previous = savedLaunch(id);
      if (choice === "legacy") {
        const legacy = { ...previous };
        delete legacy.generatedOutputFilename;
        Reflect.deleteProperty(legacy, "outputFromAgentDefault");
        fs.writeFileSync(
          path.join(getRunMetadataDir(id), "contracts", "0.json"),
          JSON.stringify({ ...json(contractBytes(id).toString()), launch: legacy }),
        );
      }
      if (choice === "no-launch") {
        fs.writeFileSync(
          path.join(getRunMetadataDir(id), "contracts", "0.json"),
          JSON.stringify({ ...json(contractBytes(id).toString()), launch: undefined }),
        );
      }
      const receipt = contractBytes(id);
      profile = { ...profile, output: "changed-current-profile.md" };
      mockPi.onCall({ output: "Current-profile report" });
      const continued = await run({
        action: "resume",
        id,
        agent: "writer",
        message: "Use the current profile",
        ...(choice === "new-default" ? { output: true } : {}),
      });
      const successor = savedLaunch(text(continued.details.asyncId));
      assert.equal(successor.agent.output, profile.output);
      assert.deepEqual(contractBytes(id), receipt);
      if (choice === "new-default") {
        assert.ok(typeof successor.output === "string");
        assert.ok(successor.output.endsWith("_changed-current-profile.md"));
        assert.notEqual(successor.output, previous.output);
      } else {
        assert.equal(
          successor.output,
          previous.output,
          "fixed, disabled and unproven choices remain unchanged",
        );
        assert.equal(successor.generatedOutputFilename, undefined);
      }
    });
  }

  for (const action of ["answer", "resume"] as const) {
    it(`${action} revives an exited question with a successor-owned default output`, async () => {
      mockPi.onCall({ output: "Predecessor report" });
      const original = await run({ ...writer, async: true });
      const id = text(original.details.asyncId);
      const contract = readQuestionContract(id, 0);
      assertDefined(contract);
      const previous = savedLaunch(id);
      assert.ok(typeof previous.output === "string");
      const bytes = fs.readFileSync(previous.output);
      assertDefined(contract.pid);
      assert.equal(questionProcessAlive({ pid: contract.pid }), false);
      const question = createSupervisorQuestion({
        runId: id,
        index: 0,
        agent: "writer",
        ownerTarget: "fixture-parent",
        childTarget: "fixture-child",
        childSessionId: "fixture-session",
        sessionFile: text(contract.sessionFile),
        cwd: tempDir,
        pid: contract.pid,
        reason: "need_decision",
        message: "May I write the follow-up?",
      });
      const receipt = contractBytes(id);
      profile = { ...profile, output: "changed-current-profile.md" };
      mockPi.onCall({ output: "Answered report" });
      const continued = await run({
        action,
        id,
        questionId: question.questionId,
        message: "Yes, write the follow-up",
      });
      const successor = savedLaunch(text(continued.details.asyncId));
      assert.ok(typeof successor.output === "string");
      assert.notEqual(successor.output, previous.output);
      assert.ok(
        path.basename(successor.output).startsWith(`${text(continued.details.asyncId)}_writer_0_`),
      );
      assert.ok(successor.output.endsWith("_frozen.md"));
      assert.equal(successor.generatedOutputFilename, "frozen.md");
      assert.equal(successor.outputMode, "file-only");
      assert.equal(fs.readFileSync(successor.output, "utf8"), "Answered report");
      assert.deepEqual(fs.readFileSync(previous.output), bytes);
      assert.deepEqual(contractBytes(id), receipt);
    });
  }

  for (const action of ["resume", "answer"] as const) {
    it(`${action} passes replacement cwd to the saved child and its finalization`, async () => {
      const originalCwd = path.join(tempDir, "original");
      const replacementCwd = path.join(tempDir, "replacement");
      fs.mkdirSync(originalCwd);
      fs.mkdirSync(replacementCwd);
      const report =
        '```acceptance-report\n{"criteriaSatisfied":[{"id":"criterion-1","status":"satisfied","evidence":"fixture"}]}\n```';
      mockPi.onCall({
        nativeReport: {
          scenario: "single",
          initialReport: `Predecessor report\n${report}`,
          report: `Predecessor report\n${report}`,
          receiptPath: path.join(tempDir, "native-before.json"),
        },
      });
      const original = await run({
        agent: "writer",
        task: "Prepare the result",
        cwd: originalCwd,
        output: false,
        acceptance: { criteria: ["Deliver the result"], maxFinalizationTurns: 1 },
      });
      const id = text(original.details.runId);
      const contract = readQuestionContract(id, 0);
      assertDefined(contract);
      assertDefined(contract.pid);
      assert.equal(questionProcessAlive({ pid: contract.pid }), false);
      const question =
        action === "answer"
          ? createSupervisorQuestion({
              runId: id,
              index: 0,
              agent: "writer",
              ownerTarget: "fixture-parent",
              childTarget: "fixture-child",
              childSessionId: "fixture-session",
              sessionFile: text(contract.sessionFile),
              cwd: originalCwd,
              pid: contract.pid,
              reason: "need_decision",
              message: "May I continue?",
            })
          : undefined;
      fs.rmdirSync(originalCwd);
      const callsBefore = mockPi.callCount();
      const nativeReceipt = path.join(tempDir, "native-after.json");
      mockPi.onCall({
        nativeReport: {
          scenario: "single",
          initialReport: `Continued report\n${report}`,
          report: `Continued report\n${report}`,
          receiptPath: nativeReceipt,
        },
      });
      const continued = await run({
        action,
        id,
        questionId: question?.questionId,
        message: "Continue in the replacement",
        cwd: "replacement",
      });
      assert.equal(savedLaunch(text(continued.details.asyncId)).cwd, replacementCwd);
      const attempts = fs
        .readdirSync(mockPi.dir)
        .filter((name) => /^call-.*\.json$/.test(name))
        .sort((left, right) => left.localeCompare(right))
        .map((name) => record(readJson(path.join(mockPi.dir, name))))
        .slice(callsBefore);
      assert.equal(attempts.length, 1, "initial work and review share one native process");
      const native = record(readJson(nativeReceipt));
      assert.equal(native.providerCalls, 2);
      assert.deepEqual(
        native.providerCwds,
        [replacementCwd, replacementCwd].map((dir) => fs.realpathSync(dir)),
      );
      for (const call of attempts) {
        assert.equal(call.cwd, fs.realpathSync(replacementCwd));
        assert.equal(
          strings(call.args)[strings(call.args).indexOf("--session") + 1],
          contract.sessionFile,
        );
        assert.equal(strings(call.args).includes("--session-cwd"), false);
        assert.equal(record(call.sessionCwd).cwd, replacementCwd);
      }
    });
  }

  it("rejects file-only with output:false before any child starts", async () => {
    const result = await executor.execute({
      toolCallId: "disabled-file-only",
      params: { ...writer, output: false, async: true },
      ctx,
    });
    assert.equal(result.isError, true);
    assert.match(toolText(result.content), /does not configure an output file/);
    assert.equal(mockPi.callCount(), 0);
  });
});
