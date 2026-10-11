import { type SubagentState, RESULTS_DIR, type ChainStep } from "../../src/shared/types.ts";
import { createSubagentState } from "../support/background-fixtures.ts";
import { textAt, assertDefined } from "../support/assertions.ts";
import { readChildCall } from "../support/child-process-receipts.ts";
import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { getRunMetadataDir } from "../../src/runs/shared/supervisor-questions.ts";
import {
  createEventBus,
  createNativeSessionFixture,
  createMockPi,
  createTempDir,
  makeAgent,
  makeMinimalCtx,
  removeTempDir,
} from "../support/helpers.ts";

const nativeRoot = createTempDir("chain-sdk-");
const native = await createNativeSessionFixture({ cwd: nativeRoot, agentDir: nativeRoot });
after(async () => {
  await native.dispose();
  removeTempDir(nativeRoot);
});

describe("chain contracts through the detached owner", () => {
  const mock = createMockPi();
  let cwd: string;
  let state: SubagentState;
  before(() => mock.install());
  after(() => mock.uninstall());
  beforeEach(() => {
    cwd = createTempDir("chain-owner-");
    mock.reset();
    state = {
      ...createSubagentState(cwd),
      baseCwd: cwd,
      currentSessionId: null,
      asyncJobs: new Map(),
      ownedRuns: new Map(),
    };
  });
  afterEach(() => {
    assertDefined(state.ownedRuns);
    for (const run of state.ownedRuns.values()) {
      removeTempDir(getRunMetadataDir(run.runId));
      fs.rmSync(path.join(RESULTS_DIR, `${run.runId}.json`), { force: true });
    }
    removeTempDir(cwd);
  });
  function executor(agents = [makeAgent("worker")]) {
    return createSubagentExecutor({
      pi: {
        ...native.pi,
        events: createEventBus(),
        getSessionName: () => {
          /* The fixture does not need getSessionName side effects. */
        },
      },
      state,
      config: {},
      asyncByDefault: false,
      tempArtifactsDir: cwd,
      getSubagentSessionRoot: () => cwd,
      expandTilde: (value) => value,
      discoverAgents: () => ({ agents }),
    });
  }
  function calls() {
    return fs
      .readdirSync(mock.dir)
      .filter((file) => /^call-.*\.json$/.test(file))
      .sort()
      .map((file) => readChildCall(path.join(mock.dir, file)));
  }

  it("does not open preview merely because a UI is available", async () => {
    mock.onCall({ output: "Done" });
    const ctx = {
      ...makeMinimalCtx(cwd),
      hasUI: true,
      ui: {
        ...native.context.ui,
        custom: async () => {
          assert.fail("No preview requested");
        },
      },
    };
    const result = await executor().execute({
      toolCallId: "preview",
      params: { chain: [{ agent: "worker", task: "Inspect" }] },
      ctx: ctx,
    });
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    assert.equal(result.details.results[0].finalOutput, "Done");
  });

  it("rejects an omitted first task when clarification cannot actually supply it", async () => {
    const first = { agent: "worker", as: "targets", outputSchema: { type: "object" } };
    const cases = [
      {
        mode: "tui",
        chain: [
          first,
          {
            expand: { from: { output: "targets", path: "/items" }, maxItems: 2 },
            parallel: { agent: "worker", task: "Review {item}" },
            collect: { as: "reviews" },
          },
        ],
      },
      { mode: "print", chain: [first] },
    ] as const;
    for (const scenario of cases) {
      const ctx = makeMinimalCtx(cwd, {
        mode: scenario.mode,
        hasUI: true,
        ui: {
          ...native.context.ui,
          custom: async () => {
            assert.fail("This invocation has no usable task clarification");
          },
        },
      });
      // Both cases share one child recorder; each rejection must finish before the next invocation.
      // oxlint-disable-next-line no-await-in-loop
      const result = await executor().execute({
        toolCallId: "missing-first-task",
        params: { chain: scenario.chain, clarify: true },
        ctx,
      });
      assert.equal(result.isError, true, scenario.mode);
      assert.match(textAt(result.content), /First step in chain must have a task/);
      assert.equal(mock.callCount(), 0, "invalid plans must not launch a child");
      assertDefined(state.ownedRuns);
      assert.equal(state.ownedRuns.size, 0, "invalid plans must not register phantom work");
    }
  });

  for (const parallel of [false, true]) {
    it(`passes file references and named outputs downstream (${parallel ? "parallel" : "sequential"})`, async () => {
      mock.onCall({ output: "full chain output\nwith details" });
      mock.onCall({ output: "Consumed references" });
      const producer: ChainStep = {
        agent: "worker",
        task: "Produce",
        as: "report",
        output: "report.md",
        outputMode: "file-only",
      };
      const chain = [
        parallel ? { parallel: [producer] } : producer,
        { agent: "worker", task: "Previous {previous}; Named {outputs.report}" },
      ];
      const result = await executor().execute({
        toolCallId: "files",
        params: { chain, chainDir: cwd },
        ctx: makeMinimalCtx(cwd),
      });
      assert.equal(result.isError, undefined, JSON.stringify(result.content));
      const child = result.details.results[0];
      assertDefined(child.finalOutput);
      assert.match(child.finalOutput, /Output saved to:/);
      assertDefined(child.savedOutputPath);
      assert.equal(
        fs.readFileSync(child.savedOutputPath, "utf8"),
        "full chain output\nwith details",
      );
      const task = calls()[1].expandedArgs.at(-1);
      assertDefined(task);
      assert.match(task, /Previous[\s\S]*Output saved to:[\s\S]*Named[\s\S]*Output saved to:/);
      assertDefined(task);
      assert.match(task, /2 lines/);
      assertDefined(task);
      assert.doesNotMatch(task, /full chain output/);
    });
  }

  it("passes successful static named outputs to downstream consumers", async () => {
    mock.onCall({ matchArgsIncludes: "First", output: "FIRST_EVIDENCE" });
    mock.onCall({ matchArgsIncludes: "Second", output: "SECOND_EVIDENCE" });
    mock.onCall({ matchArgsIncludes: "Consume", output: "Done" });
    const chain = [
      {
        parallel: [
          { agent: "worker", task: "First", as: "first" },
          { agent: "worker", task: "Second", as: "second" },
        ],
      },
      { agent: "worker", task: "Consume {outputs.first} and {outputs.second}" },
    ];
    const result = await executor().execute({
      toolCallId: "names",
      params: { chain },
      ctx: makeMinimalCtx(cwd),
    });
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    assertDefined(result.details.outputs);
    assert.equal(result.details.outputs.first.text, "FIRST_EVIDENCE");
    assertDefined(result.details.outputs);
    assert.equal(result.details.outputs.second.text, "SECOND_EVIDENCE");
    const task = calls()[2].expandedArgs.at(-1);
    assertDefined(task);
    assert.match(task, /Consume FIRST_EVIDENCE and SECOND_EVIDENCE/);
  });

  it("preflights static file-only groups before starting any sibling", async () => {
    const result = await executor().execute({
      toolCallId: "invalid-group",
      params: {
        chain: [
          {
            parallel: [
              { agent: "worker", task: "Valid sibling" },
              { agent: "worker", task: "Invalid sibling", outputMode: "file-only" },
            ],
          },
        ],
      },
      ctx: makeMinimalCtx(cwd),
    });
    assert.equal(result.isError, true);
    assert.match(textAt(result.content), /outputMode: "file-only"/);
    assert.equal(mock.callCount(), 0);
    assertDefined(state.ownedRuns);
    assert.equal(state.ownedRuns.size, 0, "rejected plans must not leave phantom owned children");
  });

  it("rejects duplicate, unknown and malformed output references before spawning", async () => {
    for (const [chain, expected] of [
      [
        [
          { agent: "worker", task: "One", as: "same" },
          { agent: "worker", task: "Two", as: "same" },
        ],
        /Duplicate chain output name 'same'/,
      ],
      [[{ agent: "worker", task: "Use {outputs.missing}" }], /Unknown chain output reference/],
      [[{ agent: "worker", task: "Use {outputs.bad-name}" }], /Invalid chain output reference/],
    ] as const) {
      // Each scenario owns shared fixture state; complete it before starting the next one.
      // oxlint-disable-next-line no-await-in-loop
      const result = await executor().execute({
        toolCallId: "invalid-name",
        params: { chain },
        ctx: makeMinimalCtx(cwd),
      });
      assert.equal(result.isError, true);
      assert.match(textAt(result.content), expected);
      assert.equal(mock.callCount(), 0);
      assertDefined(state.ownedRuns);
      assert.equal(state.ownedRuns.size, 0, "invalid output bindings must not register a run");
    }
  });

  it("requires valid structured output and leaves downstream work pending on failure", async () => {
    const outputSchema = {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
    };
    for (const [structuredOutput, expected] of [
      [undefined, /Missing structured_output call/],
      [{ ok: "yes" }, /Structured output validation failed/],
    ] as const) {
      mock.reset();
      mock.onCall({ output: "prose", structuredOutput });
      // Each scenario owns shared fixture state; complete it before starting the next one.
      // oxlint-disable-next-line no-await-in-loop
      const result = await executor().execute({
        toolCallId: "schema",
        params: {
          chain: [
            { agent: "worker", task: "Return structured", outputSchema, as: "payload" },
            { agent: "worker", task: "Must not run" },
          ],
        },
        ctx: makeMinimalCtx(cwd),
      });
      assert.equal(result.isError, true);
      assertDefined(result.details.results[0].error);
      assert.match(result.details.results[0].error, expected);
      assertDefined(result.details.workflowGraph);
      assert.equal(result.details.workflowGraph.nodes[0].status, "failed");
      assertDefined(result.details.workflowGraph);
      assert.equal(result.details.workflowGraph.nodes[1].status, "pending");
      assert.equal(mock.callCount(), 1);
    }
  });

  it("rejects dynamic file-only children without launching them", async () => {
    mock.onCall({ output: "Targets", structuredOutput: { items: ["a"] } });
    const result = await executor().execute({
      toolCallId: "dynamic-file",
      params: {
        chain: [
          { agent: "worker", task: "List", as: "targets", outputSchema: { type: "object" } },
          {
            expand: { from: { output: "targets", path: "/items" }, maxItems: 2 },
            parallel: { agent: "worker", task: "Review {item}", outputMode: "file-only" },
            collect: { as: "reviews" },
          },
        ],
      },
      ctx: makeMinimalCtx(cwd),
    });
    assert.equal(result.isError, true);
    assert.match(textAt(result.content), /outputMode: "file-only"/);
    assert.equal(
      mock.callCount(),
      0,
      "the router rejects invalid file-only templates before launching the source",
    );
  });

  it("tightens recursion per agent without relaxing an inherited maximum", async () => {
    const saved = process.env.PI_SUBAGENT_MAX_DEPTH;
    process.env.PI_SUBAGENT_MAX_DEPTH = "2";
    try {
      for (const [maxSubagentDepth, expected] of [
        [1, "1"],
        [9, "2"],
      ] as const) {
        mock.onCall({ echoEnv: ["PI_SUBAGENT_DEPTH", "PI_SUBAGENT_MAX_DEPTH"] });
        // Each scenario owns shared fixture state; complete it before starting the next one.
        // oxlint-disable-next-line no-await-in-loop
        const result = await executor([makeAgent("worker", { maxSubagentDepth })]).execute({
          toolCallId: "depth",
          params: { chain: [{ agent: "worker", task: "Inspect depth" }] },
          ctx: makeMinimalCtx(cwd),
        });
        assert.equal(result.isError, undefined, JSON.stringify(result.content));
        const call = calls().at(-1);
        assertDefined(call);
        assert.deepEqual(call.env, {
          PI_SUBAGENT_DEPTH: "1",
          PI_SUBAGENT_MAX_DEPTH: expected,
        });
      }
    } finally {
      if (saved === undefined) {
        delete process.env.PI_SUBAGENT_MAX_DEPTH;
      } else {
        process.env.PI_SUBAGENT_MAX_DEPTH = saved;
      }
    }
  });
});
