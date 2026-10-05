import { createSubagentState } from "../support/background-fixtures.ts";
import { textAt, assertDefined, text as stringValue } from "../support/assertions.ts";
import { readChildCall } from "../support/child-process-receipts.ts";
import { readRunResult, readRunStatus, readChildMetadata } from "../support/run-publications.ts";
import "../support/isolated-home.ts";
import { fauxProvider } from "@earendil-works/pi-ai";
import { customInteraction } from "../support/custom-interaction.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, beforeEach, afterEach, describe, it } from "node:test";
import { getRunMetadataDir } from "../../src/runs/shared/supervisor-questions.ts";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import {
  executeAsyncChain,
  executeAsyncSingle,
} from "../../src/runs/background/async-execution.ts";
import { ASYNC_DIR, RESULTS_DIR } from "../../src/shared/types.ts";
import { resolveSubagentIntercomTarget } from "../../src/intercom/intercom-bridge.ts";
import {
  createMockPi,
  createNativeSessionFixture,
  createTempDir,
  createEventBus,
  events,
  makeAgent,
  makeMinimalCtx,
  removeTempDir,
} from "../support/helpers.ts";

const report = (satisfied = true) =>
  "```acceptance-report\n" +
  JSON.stringify({
    criteriaSatisfied: [
      {
        id: "criterion-1",
        status: satisfied ? "satisfied" : "not-satisfied",
        evidence: satisfied ? "Verified final state" : "Still blocked",
      },
    ],
  }) +
  "\n```";
const acceptance = { criteria: ["Deliver the final result"], maxFinalizationTurns: 1 };

async function waitForResult(id: string) {
  const file = path.join(RESULTS_DIR, `${id}.json`);
  const deadline = Date.now() + 15_000;
  while (!fs.existsSync(file)) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${file}`);
    // Observe the owner publication before advancing this lifecycle transition.
    // oxlint-disable-next-line no-await-in-loop
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  return readRunResult(file);
}

const nativeRoot = createTempDir("result-contract-sdk-");
const native = await createNativeSessionFixture({ cwd: nativeRoot, agentDir: nativeRoot });
after(async () => {
  await native.dispose();
  removeTempDir(nativeRoot);
});

describe("result contracts", () => {
  const mock = createMockPi();
  let cwd: string;
  let id: string;
  before(() => mock.install());
  after(() => mock.uninstall());
  beforeEach(() => {
    cwd = createTempDir("result-contract-");
    id = `result-contract-${path.basename(cwd)}`;
    mock.reset();
  });
  afterEach(() => {
    if ((process.env.PI_INTERCOM_TEST_EVIDENCE_DIR ?? "").length > 0) {
      fs.writeFileSync(path.join(cwd, "mock-calls.json"), JSON.stringify(calls(), null, 2));
      return; // Keep synthetic journals and run history for native-host qualification.
    }
    removeTempDir(cwd);
    removeTempDir(path.join(ASYNC_DIR, id));
    fs.rmSync(path.join(RESULTS_DIR, `${id}.json`), { force: true });
  });

  function calls() {
    return fs
      .readdirSync(mock.dir)
      .filter((file) => /^call-.*\.json$/.test(file))
      .sort()
      .map((file) => readChildCall(path.join(mock.dir, file)));
  }

  it(`background falls back after exhausted short-lived transport recovery`, async () => {
    mock.onCall({ exitCode: 143 });
    mock.onCall({ exitCode: 143 });
    mock.onCall({ output: "Recovered on the configured fallback" });
    const agent = makeAgent("worker", {
      model: "mock/primary",
      fallbackModels: ["mock/fallback"],
    });
    let result;
    {
      executeAsyncSingle(id, {
        agent: "worker",
        task: "Deliver the result",
        agentConfig: agent,
        ctx: { pi: { ...native.pi, events: createEventBus() }, cwd, currentSessionId: id },
        shareEnabled: false,
        maxSubagentDepth: 2,
      });
      result = (await waitForResult(id)).results[0];
    }
    assert.equal(result.exitCode, 0, result.error);
    assert.deepEqual(result.attemptedModels, ["mock/primary", "mock/primary", "mock/fallback"]);
    assert.equal(mock.callCount(), 3);
    assertDefined(result.finalOutput);
    assert.match(result.finalOutput ?? result.output, /Recovered on the configured fallback/);
  });

  it(`background passes configured thinking on the first child attempt`, async () => {
    mock.onCall({ output: "Done" });
    const agent = makeAgent("worker", { model: "mock/primary", thinking: "high" });
    {
      executeAsyncSingle(id, {
        agent: "worker",
        task: "Deliver the result",
        agentConfig: agent,
        ctx: { pi: { ...native.pi, events: createEventBus() }, cwd, currentSessionId: id },
        shareEnabled: false,
        maxSubagentDepth: 2,
      });
      assert.equal((await waitForResult(id)).success, true);
    }
    const args = calls()[0].args;
    assert.equal(args[args.indexOf("--model") + 1], "mock/primary:high");
  });

  it(`background interruption during verification pauses before publishing terminal metadata`, async () => {
    mock.onCall({
      nativeReport: {
        scenario: "single",
        initialReport: `Initial report\n${report()}`,
        report: `Reviewed report\n${report()}`,
        receiptPath: path.join(cwd, "native.json"),
      },
    });
    const marker = path.join(cwd, "verification-started");
    const contract = {
      ...acceptance,
      verify: [{ id: "wait", command: `touch '${marker}'; sleep 20`, timeoutMs: 30_000 }],
    };
    let completion;
    {
      executeAsyncSingle(id, {
        agent: "worker",
        task: "Deliver the result",
        agentConfig: makeAgent("worker"),
        ctx: { pi: { ...native.pi, events: createEventBus() }, cwd, currentSessionId: id },
        acceptance: contract,
        artifactsDir: cwd,
        sessionFile: path.join(cwd, "child.jsonl"),
        shareEnabled: false,
        maxSubagentDepth: 2,
      });
      completion = waitForResult(id).then((payload) => {
        assert.equal(payload.state, "paused");
        return payload.results[0];
      });
    }
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(marker)) {
      assert.ok(Date.now() < deadline, "verification must start");
      // Observe the owner publication before advancing this lifecycle transition.
      // oxlint-disable-next-line no-await-in-loop
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    }
    {
      const status = readRunStatus(path.join(getRunMetadataDir(id), "status.json"));
      assertDefined(status.pid);
      assert.ok(Number.isSafeInteger(status.pid) && status.pid > 0);
      assertDefined(status.pid);
      process.kill(status.pid, "SIGUSR2");
    }
    const result = await completion;
    assert.equal(result.exitCode, 0, result.error);
    assert.equal(result.interrupted, true);
    assertDefined(result.artifactPaths);
    assertDefined(result.artifactPaths.metadataPath);
    const metadata = readChildMetadata(result.artifactPaths.metadataPath);
    assert.equal(metadata.exitCode, result.exitCode);
    assert.equal(metadata.interrupted, true);
    assert.equal(mock.callCount(), 1, "initial work and review use one native process");
  });

  for (const satisfied of [true, false]) {
    it(`background finalization publishes authoritative output, acceptance and usage (${satisfied ? "accepted" : "rejected"})`, async () => {
      mock.onCall({
        nativeReport: {
          scenario: "single",
          initialReport: `Initial incomplete answer\n${report(false)}`,
          report: `Final ${satisfied ? "repaired" : "blocked"} answer\n${report(satisfied)}`,
          receiptPath: path.join(cwd, "native.json"),
        },
      });
      const expectedOutput = `Final ${satisfied ? "repaired" : "blocked"} answer`;
      const childCwd = path.join(cwd, "child");
      fs.mkdirSync(childCwd);
      let result;
      {
        const started = executeAsyncSingle(id, {
          agent: "worker",
          task: "Deliver the result",
          agentConfig: makeAgent("worker"),
          ctx: { pi: { ...native.pi, events: createEventBus() }, cwd, currentSessionId: id },
          cwd: childCwd,
          acceptance,
          artifactsDir: cwd,
          sessionFile: path.join(cwd, "child.jsonl"),
          shareEnabled: false,
          maxSubagentDepth: 2,
        });
        assert.ok(!(started.isError === true), textAt(started.content));
        const payload = await waitForResult(id);
        result = payload.results[0];
        const status = readRunStatus(path.join(getRunMetadataDir(id), "status.json"));
        assertDefined(status.steps);
        assertDefined(status.steps[0].acceptance);
        assert.equal(status.steps[0].acceptance.status, satisfied ? "checked" : "rejected");
        assert.equal(payload.exitCode, satisfied ? 0 : 1);
      }
      assertDefined(result.artifactPaths);
      assertDefined(result.artifactPaths.metadataPath);
      const metadata = readChildMetadata(result.artifactPaths.metadataPath);
      assert.equal(result.exitCode, satisfied ? 0 : 1);
      assert.equal(metadata.exitCode, result.exitCode);
      assert.deepEqual(metadata.acceptance, result.acceptance);
      assertDefined(metadata.usage);
      assert.equal(metadata.usage.turns, 2);
      assertDefined(result.modelAttempts);
      assert.equal(
        result.modelAttempts.reduce((turns, attempt) => {
          assertDefined(attempt.usage);
          return turns + attempt.usage.turns;
        }, 0),
        2,
      );
      assertDefined(result.finalOutput);
      assert.match(result.finalOutput ?? result.output, new RegExp(expectedOutput));
      assertDefined(result.artifactPaths);
      assertDefined(result.artifactPaths.outputPath);
      assert.equal(fs.readFileSync(result.artifactPaths.outputPath, "utf8"), expectedOutput);
      assert.equal(metadata.initialOutput, "Initial incomplete answer");
      const attempts = calls();
      assert.equal(attempts.length, 1);
      for (const call of attempts) {
        assert.equal(call.cwd, fs.realpathSync(childCwd));
        assert.equal(call.args[call.args.indexOf("--session") + 1], path.join(cwd, "child.jsonl"));
        assert.equal(call.args.includes("--session-cwd"), false);
        assert.equal(call.sessionCwd?.cwd, undefined);
      }
    });
  }

  it(`background report-only native review is rejected while retaining the initial answer for audit`, async () => {
    mock.onCall({
      nativeReport: {
        scenario: "single",
        initialReport: `Useful answer\n${report()}`,
        report: report(),
        receiptPath: path.join(cwd, "native.json"),
      },
    });
    {
      executeAsyncSingle(id, {
        agent: "worker",
        task: "Deliver the result",
        agentConfig: makeAgent("worker"),
        ctx: { pi: { ...native.pi, events: createEventBus() }, cwd, currentSessionId: id },
        acceptance,
        sessionFile: path.join(cwd, "child.jsonl"),
        shareEnabled: false,
        maxSubagentDepth: 2,
      });
      const result = (await waitForResult(id)).results[0];
      assertDefined(result.acceptance);
      assert.equal(result.acceptance.status, "rejected");
      assertDefined(result.output);
      assert.match(result.output, /^UNCONFIRMED task report[\s\S]*Useful answer/);
    }
  });

  it(`background report-only native repair summary cannot replace a complete current answer`, async () => {
    mock.onCall({
      nativeReport: {
        scenario: "single",
        initialReport: `Still incomplete\n${report(false)}`,
        report:
          "```acceptance-report\n" +
          JSON.stringify({
            criteriaSatisfied: [
              { id: "criterion-1", status: "satisfied", evidence: "Repaired and verified" },
            ],
            diffSummary: "Repaired the missing work and verified the final result.",
          }) +
          "\n```",
        receiptPath: path.join(cwd, "native.json"),
      },
    });
    let result;
    {
      executeAsyncSingle(id, {
        agent: "worker",
        task: "Deliver the result",
        agentConfig: makeAgent("worker"),
        ctx: { pi: { ...native.pi, events: createEventBus() }, cwd, currentSessionId: id },
        acceptance,
        artifactsDir: cwd,
        sessionFile: path.join(cwd, "child.jsonl"),
        shareEnabled: false,
        maxSubagentDepth: 2,
      });
      result = (await waitForResult(id)).results[0];
    }
    assertDefined(result.acceptance);
    assert.equal(result.acceptance.status, "rejected");
    assertDefined(result.finalOutput);
    assert.match(
      result.finalOutput ?? result.output,
      /^UNCONFIRMED task report[\s\S]*Still incomplete/,
    );
    assertDefined(result.artifactPaths);
    assertDefined(result.artifactPaths.metadataPath);
    const metadata = readChildMetadata(result.artifactPaths.metadataPath);
    assert.equal(metadata.initialOutput, "Still incomplete");
    assertDefined(metadata.acceptance);
    assertDefined(metadata.acceptance.finalization);
    assert.equal(metadata.acceptance.finalization.turns[0].report, undefined);
  });

  it(`background finalization preserves an unchanged detailed handoff instead of overwriting it with review prose`, async () => {
    const release = path.join(cwd, "release-report-child");
    mock.onCall({
      waitForFile: release,
      nativeReport: {
        scenario: "single",
        initialReport: `Wrote the report\n${report()}`,
        report: `Report is complete; no changes needed.\n${report()}`,
        receiptPath: path.join(cwd, "native.json"),
      },
    });
    const outputPath = path.join(cwd, "report.md");
    const contract = {
      ...acceptance,
      verify: [{ id: "contents", command: `grep -q 'CRITICAL DETAIL' '${outputPath}'` }],
    };
    let completion;
    {
      executeAsyncSingle(id, {
        agent: "worker",
        task: "Write the report",
        agentConfig: makeAgent("worker"),
        ctx: { pi: { ...native.pi, events: createEventBus() }, cwd, currentSessionId: id },
        acceptance: contract,
        output: outputPath,
        outputMode: "file-only",
        artifactsDir: cwd,
        sessionFile: path.join(cwd, "child.jsonl"),
        shareEnabled: false,
        maxSubagentDepth: 2,
      });
      completion = waitForResult(id).then((payload) => payload.results[0]);
    }
    try {
      const deadline = Date.now() + 10_000;
      while (!(mock.callCount() !== 0 && !Number.isNaN(mock.callCount()))) {
        assert.ok(Date.now() < deadline, "initial child must start");
        // Observe the owner publication before advancing this lifecycle transition.
        // oxlint-disable-next-line no-await-in-loop
        await new Promise((resolve) => {
          setTimeout(resolve, 10);
        });
      }
      fs.writeFileSync(outputPath, "Detailed report\nCRITICAL DETAIL: preserve this artifact.\n");
    } finally {
      fs.writeFileSync(release, "");
      await completion;
    }
    const result = await completion;
    assert.equal(result.exitCode, 0, result.error);
    assertDefined(result.acceptance);
    assert.equal(result.acceptance.status, "verified");
    assertDefined(result.artifactPaths);
    assertDefined(result.artifactPaths.outputPath);
    assert.equal(
      fs.readFileSync(result.artifactPaths.outputPath, "utf8"),
      "Detailed report\nCRITICAL DETAIL: preserve this artifact.",
    );
    assert.equal(
      fs.readFileSync(outputPath, "utf8"),
      "Detailed report\nCRITICAL DETAIL: preserve this artifact.\n",
    );
  });

  it(`background finalization recaptures repaired output files before verification and file-only publication`, async () => {
    const outputPath = path.join(cwd, "repaired.md");
    mock.onCall({
      nativeReport: {
        scenario: "child-file",
        initialReport: `Old content\n${report()}`,
        report: `Repaired file content\n${report()}`,
        handoffPath: outputPath,
        handoff: "Repaired file content",
        receiptPath: path.join(cwd, "native.json"),
      },
    });
    const contract = {
      ...acceptance,
      verify: [{ id: "repaired", command: `grep -q 'Repaired file content' '${outputPath}'` }],
    };
    let completion;
    {
      executeAsyncSingle(id, {
        agent: "worker",
        task: "Deliver the result",
        agentConfig: makeAgent("worker"),
        ctx: { pi: { ...native.pi, events: createEventBus() }, cwd, currentSessionId: id },
        acceptance: contract,
        output: outputPath,
        outputMode: "file-only",
        artifactsDir: cwd,
        sessionFile: path.join(cwd, "child.jsonl"),
        shareEnabled: false,
        maxSubagentDepth: 2,
      });
      completion = waitForResult(id).then((payload) => payload.results[0]);
    }
    const result = await completion;
    assert.equal(result.exitCode, 0, result.error);
    assertDefined(result.acceptance);
    assert.equal(result.acceptance.status, "verified");
    assertDefined(result.finalOutput);
    assert.match(result.finalOutput ?? result.output, /Output saved to:/);
    assertDefined(result.finalOutput);
    assert.doesNotMatch(result.finalOutput ?? result.output, /Repaired file content/);
    assert.equal(fs.readFileSync(outputPath, "utf8"), "Repaired file content");
    assertDefined(result.artifactPaths);
    assertDefined(result.artifactPaths.outputPath);
    assert.equal(fs.readFileSync(result.artifactPaths.outputPath, "utf8"), "Repaired file content");
  });

  it(`background omitted first tasks use the supplied task and later tasks receive previous output`, async () => {
    mock.onCall({ output: "First answer" });
    mock.onCall({ output: "Second answer" });
    const chain = [
      { agent: "worker" },
      { agent: "worker", task: "Continue without a placeholder" },
    ];
    {
      executeAsyncChain(id, {
        chain,
        task: "Owner supplied task",
        agents: [makeAgent("worker")],
        ctx: { pi: { ...native.pi, events: createEventBus() }, cwd, currentSessionId: id },
        shareEnabled: false,
        maxSubagentDepth: 2,
      });
      assert.equal((await waitForResult(id)).success, true);
    }
    assert.match(stringValue(calls()[0].expandedArgs.at(-1)), /Owner supplied task/);
    assert.match(
      stringValue(calls()[1].expandedArgs.at(-1)),
      /Continue without a placeholder[\s\S]*Previous step output:\nFirst answer/,
    );
  });

  it(`background task, previous and named-output substitutions remain literal`, async () => {
    const text = "$& $` $' {task} {previous} {chain_dir} {outputs.data}";
    const task = "Owner $& {previous} {outputs.data}";
    mock.onCall({ output: text });
    mock.onCall({ output: "Done" });
    const chain = [
      { agent: "worker", task: "Produce data", as: "data" },
      { agent: "worker", task: "BEGIN {previous} MID {outputs.data} END {task}" },
    ];
    {
      executeAsyncChain(id, {
        chain,
        task,
        agents: [makeAgent("worker")],
        ctx: { pi: { ...native.pi, events: createEventBus() }, cwd, currentSessionId: id },
        shareEnabled: false,
        maxSubagentDepth: 2,
      });
      assert.equal((await waitForResult(id)).success, true);
    }
    assert.equal(
      stringValue(calls()[1].expandedArgs.at(-1))
        .replace(/^@[^\n]+\n/, "")
        .replace(/^Task: /, ""),
      `BEGIN ${text} MID ${text} END ${task}`,
    );
  });

  it(`background dynamic item text is not reinterpreted as workflow template syntax`, async () => {
    const item = "$& {previous} {outputs.items} {task}";
    const source = "Source $& {previous}";
    const task = "Owner $& {previous}";
    mock.onCall({ output: source, structuredOutput: { items: [item] } });
    mock.onCall({ output: "Done" });
    const chain = [
      { agent: "worker", task: "Produce", as: "items", outputSchema: { type: "object" } },
      {
        expand: { from: { output: "items", path: "/items" }, maxItems: 1 },
        parallel: {
          agent: "worker",
          task: "Review {item} / Named {outputs.items} / Previous {previous} / Original {task}",
        },
        collect: { as: "answers" },
      },
    ];
    {
      executeAsyncChain(id, {
        chain,
        task,
        agents: [makeAgent("worker")],
        ctx: { pi: { ...native.pi, events: createEventBus() }, cwd, currentSessionId: id },
        shareEnabled: false,
        maxSubagentDepth: 2,
      });
      assert.equal((await waitForResult(id)).success, true);
    }
    assert.equal(
      stringValue(calls()[1].expandedArgs.at(-1))
        .replace(/^@[^\n]+\n/, "")
        .replace(/^Task: /, ""),
      `Review ${item} / Named ${JSON.stringify({ items: [item] })} / Previous ${source} / Original ${task}`,
    );
  });

  it(`background empty and multiple fanouts keep executed indices separate from reserved fork sessions`, async () => {
    const echoEnv = ["PI_SUBAGENT_CHILD_INDEX", "PI_SUBAGENT_INTERCOM_SESSION_NAME"];
    mock.onCall({
      output: "Items",
      structuredOutput: { empty: [], a: ["one", "two"], b: ["three"] },
      echoEnv,
    });
    for (const item of ["A one", "A two", "B three"]) {
      mock.onCall({ matchArgsIncludes: `Review ${item}`, output: item, echoEnv });
    }
    mock.onCall({
      matchArgsIncludes: "Fail consumer",
      exitCode: 1,
      stderr: "Expected consumer failure",
      echoEnv,
    });
    const chain = [
      { agent: "worker", task: "List items", as: "items", outputSchema: { type: "object" } },
      {
        expand: { from: { output: "items", path: "/empty" }, maxItems: 2 },
        parallel: { agent: "worker", task: "Empty {item}" },
        collect: { as: "empty" },
      },
      {
        expand: { from: { output: "items", path: "/a" }, maxItems: 3 },
        parallel: { agent: "worker", task: "Review A {item}" },
        collect: { as: "a" },
        concurrency: 1,
      },
      {
        expand: { from: { output: "items", path: "/b" }, maxItems: 2 },
        parallel: { agent: "worker", task: "Review B {item}" },
        collect: { as: "b" },
        concurrency: 1,
      },
      { agent: "worker", task: "Fail consumer" },
    ];
    const sessions = Array.from({ length: 9 }, (_, index) => path.join(cwd, `fork-${index}.jsonl`));
    for (const session of sessions) {
      fs.writeFileSync(session, "");
    }
    const childIntercomTarget = (agent: string, index: number) =>
      resolveSubagentIntercomTarget(id, agent, index);
    let results, outputs, graph;
    {
      executeAsyncChain(id, {
        chain,
        agents: [makeAgent("worker")],
        artifactsDir: cwd,
        sessionFilesByFlatIndex: sessions,
        childIntercomTarget,
        ctx: { pi: { ...native.pi, events: createEventBus() }, cwd, currentSessionId: id },
        shareEnabled: false,
        maxSubagentDepth: 2,
      });
      const payload = await waitForResult(id);
      ({ results, outputs, workflowGraph: graph } = payload);
      assert.equal(payload.state, "failed");
      const status = readRunStatus(path.join(getRunMetadataDir(id), "status.json"));
      assertDefined(status.steps);
      assert.equal(status.steps.length, 5);
      assertDefined(status.steps);
      assert.equal(status.steps[4].status, "failed");
      assert.equal(status.currentStep, 4);
      assert.deepEqual(status.parallelGroups, [
        { start: 1, count: 0, stepIndex: 1 },
        { start: 1, count: 2, stepIndex: 2 },
        { start: 3, count: 1, stepIndex: 3 },
      ]);
    }
    assert.equal(results.length, 5);
    assertDefined(outputs);
    assert.deepEqual(outputs.empty.structured, []);
    assertDefined(graph);
    assert.equal(graph.nodes[1].status, "completed");
    assertDefined(graph);
    assertDefined(graph.nodes[1].children);
    assert.deepEqual(graph.nodes[1].children, []);
    assertDefined(graph);
    assertDefined(graph.nodes[2].children);
    assert.deepEqual(
      graph.nodes[2].children.map((child) => child.flatIndex),
      [1, 2],
    );
    assertDefined(graph);
    assertDefined(graph.nodes[3].children);
    assert.deepEqual(
      graph.nodes[3].children.map((child) => child.flatIndex),
      [3],
    );
    assertDefined(graph);
    assertDefined(graph.nodes[4].flatIndex);
    assert.equal(graph.nodes[4].flatIndex, 4);
    assertDefined(graph);
    assert.equal(graph.nodes[4].status, "failed");
    assert.deepEqual(
      calls().map((call) => call.args[call.args.indexOf("--session") + 1]),
      [0, 3, 4, 6, 8].map((index) => sessions[index]),
    );
    assert.deepEqual(
      calls().map((call) => {
        assertDefined(call.env);
        return call.env.PI_SUBAGENT_CHILD_INDEX;
      }),
      ["0", "1", "2", "3", "4"],
    );
    assert.deepEqual(
      calls().map((call) => {
        assertDefined(call.env);
        return call.env.PI_SUBAGENT_INTERCOM_SESSION_NAME;
      }),
      [0, 1, 2, 3, 4].map((index) => childIntercomTarget("worker", index)),
    );
  });

  it(`background live dynamic graphs keep out-of-order child outcomes at their own indices`, async () => {
    const release = path.join(cwd, "release-first-child");
    mock.onCall({ output: "Items", structuredOutput: { items: ["Slow first", "Fail second"] } });
    mock.onCall({
      matchArgsIncludes: "Review Slow first",
      steps: [
        { jsonl: [events.toolStart("read", { path: "still-running" })] },
        { waitForFile: release, jsonl: [events.assistantMessage("Finished first")] },
      ],
    });
    mock.onCall({
      matchArgsIncludes: "Review Fail second",
      waitForCalls: 3,
      exitCode: 1,
      stderr: "Second child failed",
    });
    const chain = [
      { agent: "worker", task: "Produce", as: "items", outputSchema: { type: "object" } },
      {
        expand: { from: { output: "items", path: "/items" }, maxItems: 2 },
        parallel: { agent: "worker", task: "Review {item}" },
        collect: { as: "answers" },
        concurrency: 2,
      },
    ];
    let children;
    {
      executeAsyncChain(id, {
        chain,
        agents: [makeAgent("worker")],
        ctx: { pi: { ...native.pi, events: createEventBus() }, cwd, currentSessionId: id },
        shareEnabled: false,
        maxSubagentDepth: 2,
      });
      const statusPath = path.join(getRunMetadataDir(id), "status.json");
      const deadline = Date.now() + 10_000;
      try {
        while (Date.now() < deadline) {
          if (fs.existsSync(statusPath)) {
            const status = readRunStatus(statusPath);
            assertDefined(status.steps);
            if (status.steps[1]?.status === "running" && status.steps[2]?.status === "failed") {
              assertDefined(status.workflowGraph);
              children = status.workflowGraph.nodes[1].children;
              break;
            }
          }
          // Observe the owner publication before advancing this lifecycle transition.
          // oxlint-disable-next-line no-await-in-loop
          await new Promise((resolve) => {
            setTimeout(resolve, 10);
          });
        }
      } finally {
        fs.writeFileSync(release, "");
        await waitForResult(id);
      }
    }
    assert.ok(children, "must observe the second child failing while the first is still running");
    assert.deepEqual(
      children.map((child) => [child.flatIndex, child.status]),
      [
        [1, "running"],
        [2, "failed"],
      ],
    );
  });

  it(`background failed groups retain successful sibling outputs without advancing`, async () => {
    mock.onCall({ matchArgsIncludes: "Keep evidence", output: "Preserved sibling evidence" });
    mock.onCall({
      matchArgsIncludes: "Fail sibling",
      exitCode: 1,
      stderr: "Expected sibling failure",
    });
    const chain = [
      {
        parallel: [
          { agent: "worker", task: "Keep evidence", as: "evidence" },
          { agent: "worker", task: "Fail sibling", as: "failed" },
        ],
        concurrency: 1,
      },
      { agent: "worker", task: "Downstream must not run: {outputs.evidence}" },
    ];
    let results, outputs, graph;
    {
      executeAsyncChain(id, {
        chain,
        agents: [makeAgent("worker")],
        artifactsDir: cwd,
        ctx: { pi: { ...native.pi, events: createEventBus() }, cwd, currentSessionId: id },
        shareEnabled: false,
        maxSubagentDepth: 2,
      });
      const payload = await waitForResult(id);
      ({ results, outputs, workflowGraph: graph } = payload);
      assert.equal(payload.state, "failed");
    }
    assert.equal(outputs?.evidence?.text, "Preserved sibling evidence");
    assert.equal(outputs?.failed, undefined);
    assert.equal(results.length, 2);
    assertDefined(results[0].artifactPaths);
    assertDefined(results[0].artifactPaths.outputPath);
    assert.equal(
      fs.readFileSync(results[0].artifactPaths.outputPath, "utf8"),
      "Preserved sibling evidence",
    );
    assertDefined(graph);
    assert.equal(graph.nodes[0].status, "failed");
    assertDefined(graph);
    assert.equal(graph.nodes[1].status, "pending");
    assert.equal(mock.callCount(), 2);
  });

  it(`background paused groups retain completed evidence and never start queued or downstream work`, async () => {
    mock.onCall({ matchArgsIncludes: "Keep evidence", output: "Completed evidence" });
    mock.onCall({
      matchArgsIncludes: "Pause sibling",
      steps: [
        { jsonl: [events.toolStart("read", { path: "waiting" })] },
        { delay: 5_000, jsonl: [events.assistantMessage("Should not finish")] },
      ],
    });
    const chain = [
      {
        parallel: [
          { agent: "worker", task: "Keep evidence", as: "evidence" },
          { agent: "worker", task: "Pause sibling", as: "unfinished" },
          { agent: "worker", task: "Queued must not run" },
        ],
        concurrency: 1,
      },
      { agent: "worker", task: "Downstream must not run" },
    ];
    let results, outputs;
    {
      executeAsyncChain(id, {
        chain,
        agents: [makeAgent("worker")],
        artifactsDir: cwd,
        ctx: { pi: { ...native.pi, events: createEventBus() }, cwd, currentSessionId: id },
        shareEnabled: false,
        maxSubagentDepth: 2,
      });
      const deadline = Date.now() + 10_000;
      while (mock.callCount() < 2) {
        assert.ok(Date.now() < deadline, "second child must start");
        // Observe the owner publication before advancing this lifecycle transition.
        // oxlint-disable-next-line no-await-in-loop
        await new Promise((resolve) => {
          setTimeout(resolve, 10);
        });
      }
      fs.writeFileSync(
        path.join(getRunMetadataDir(id), "control-request.json"),
        JSON.stringify({ requestId: id, runId: id, action: "interrupt" }),
      );
      const payload = await waitForResult(id);
      ({ results, outputs } = payload);
      assert.equal(payload.state, "paused");
    }
    assertDefined(outputs);
    assert.equal(outputs.evidence.text, "Completed evidence");
    assertDefined(outputs);
    assert.equal(outputs.unfinished, undefined);
    assert.equal(results[1].interrupted, true);
    assert.equal(results[2].interrupted, true);
    assert.equal(mock.callCount(), 2);
    assertDefined(results[0].artifactPaths);
    assertDefined(results[0].artifactPaths.outputPath);
    assert.equal(
      fs.readFileSync(results[0].artifactPaths.outputPath, "utf8"),
      "Completed evidence",
    );
  });

  it(`background fail-fast during sibling verification stops the verifier without publishing a pause`, async () => {
    for (const model of ["mock/fail", "mock/slow"]) {
      mock.onCall({
        matchArgsIncludes: model,
        nativeReport: {
          scenario: "single",
          initialReport: `Initial\n${report()}`,
          report: `Reviewed\n${report()}`,
          receiptPath: path.join(cwd, `${model.split("/")[1]}.json`),
        },
      });
    }
    const verifying = path.join(cwd, "verifying");
    const survived = path.join(cwd, "verifier-survived");
    const chain = [
      {
        parallel: [
          {
            agent: "fail",
            task: "Verify failure",
            acceptance: {
              ...acceptance,
              verify: [
                {
                  id: "failure",
                  command: `while [ ! -f ${JSON.stringify(verifying)} ]; do sleep 0.01; done; exit 1`,
                  timeoutMs: 5_000,
                },
              ],
            },
          },
          {
            agent: "slow",
            task: "Verify slowly",
            acceptance: {
              ...acceptance,
              verify: [
                {
                  id: "slow",
                  command: `touch ${JSON.stringify(verifying)}; sleep 5; touch ${JSON.stringify(survived)}`,
                  timeoutMs: 10_000,
                },
              ],
            },
          },
          { agent: "fail", task: "Queued must not run" },
        ],
        concurrency: 2,
        failFast: true,
      },
    ];
    const agents = [
      makeAgent("fail", { model: "mock/fail" }),
      makeAgent("slow", { model: "mock/slow" }),
    ];
    const sessions = [0, 1, 2].map((index) => path.join(cwd, `verify-${index}.jsonl`));
    let results;
    {
      executeAsyncChain(id, {
        chain,
        agents,
        artifactsDir: cwd,
        sessionFilesByFlatIndex: sessions,
        ctx: { pi: { ...native.pi, events: createEventBus() }, cwd, currentSessionId: id },
        shareEnabled: false,
        maxSubagentDepth: 2,
      });
      const payload = await waitForResult(id);
      results = payload.results;
      assert.equal(payload.state, "failed");
    }
    assert.equal(fs.existsSync(verifying), true);
    assert.equal(fs.existsSync(survived), false);
    assert.equal(mock.callCount(), 2);
    assert.equal(results[1].exitCode, -1);
    assert.ok(!results[1].interrupted);
    assertDefined(results[1].error);
    assert.match(results[1].error, /Interrupted due to fail-fast/);
    assertDefined(results[1].artifactPaths);
    assertDefined(results[1].artifactPaths.metadataPath);
    const metadata = readChildMetadata(results[1].artifactPaths.metadataPath);
    assert.equal(metadata.exitCode, -1);
    assert.ok(!(metadata.interrupted === true));
    assert.equal(metadata.error, results[1].error);
  });

  for (const dynamic of [false, true]) {
    it(`background ${dynamic ? "dynamic" : "static"} fail-fast stops running and queued siblings without publishing pause metadata`, async () => {
      if (dynamic) {
        mock.onCall({
          output: "Items",
          structuredOutput: { items: ["Fail now", "Wait slowly", "Queued must not run"] },
        });
      }
      mock.onCall({
        matchArgsIncludes: "Fail now",
        waitForCalls: dynamic ? 3 : 2,
        delay: 100,
        exitCode: 1,
        stderr: "Expected task failure",
      });
      mock.onCall({ matchArgsIncludes: "Wait slowly", delay: 5_000, output: "Must be stopped" });
      const group = dynamic
        ? {
            expand: { from: { output: "items", path: "/items" }, maxItems: 3 },
            parallel: { agent: "worker", task: "{item}" },
            collect: { as: "answers" },
            concurrency: 2,
            failFast: true,
          }
        : {
            parallel: ["Fail now", "Wait slowly", "Queued must not run"].map((task) => ({
              agent: "worker",
              task,
            })),
            concurrency: 2,
            failFast: true,
          };
      const chain = [
        ...(dynamic
          ? [
              {
                agent: "worker",
                task: "List items",
                as: "items",
                outputSchema: { type: "object" },
              },
            ]
          : []),
        group,
        { agent: "worker", task: "Downstream must not run" },
      ];
      let results, outputs;
      {
        executeAsyncChain(id, {
          chain,
          agents: [makeAgent("worker")],
          artifactsDir: cwd,
          ctx: { pi: { ...native.pi, events: createEventBus() }, cwd, currentSessionId: id },
          shareEnabled: false,
          maxSubagentDepth: 2,
        });
        const payload = await waitForResult(id);
        ({ results, outputs } = payload);
        assert.equal(payload.state, "failed");
      }
      const offset = dynamic ? 1 : 0;
      assert.equal(mock.callCount(), offset + 2);
      assert.equal(results[offset + 1].exitCode, -1);
      assert.ok(!results[offset + 1].interrupted, "fail-fast is not a user pause");
      assertDefined(results[offset + 1].error);
      assert.match(stringValue(results[offset + 1].error), /Interrupted due to fail-fast/);
      assert.equal(results[offset + 2].exitCode, -1);
      assert.equal(outputs?.answers, undefined);
      const failed = results[offset + 1];
      assertDefined(failed.artifactPaths);
      const metadata = readChildMetadata(stringValue(failed.artifactPaths.metadataPath));
      assert.equal(metadata.exitCode, -1);
      assert.ok(
        !(metadata.interrupted === true),
        "terminal metadata must not publish a user pause",
      );
      assert.equal(metadata.error, results[offset + 1].error);
    });
  }

  for (const limit of ["maxExecutionTimeMs", "maxTokens"]) {
    it(`background dynamic children enforce ${limit} without publishing a collection`, async () => {
      mock.onCall({ output: "Items", structuredOutput: { items: ["a"] } });
      mock.onCall({
        output: "Over budget",
        ...(limit === "maxExecutionTimeMs" ? { delay: 2_000 } : {}),
      });
      const chain = [
        { agent: "producer", task: "List items", as: "items", outputSchema: { type: "object" } },
        {
          expand: { from: { output: "items", path: "/items" }, maxItems: 1 },
          parallel: { agent: "worker", task: "Review {item}" },
          collect: { as: "answers" },
        },
        { agent: "producer", task: "Downstream must not run" },
      ];
      const agents = [makeAgent("producer"), makeAgent("worker", { [limit]: 100 })];
      let results, outputs, graph;
      {
        const started = executeAsyncChain(id, {
          chain,
          agents,
          ctx: { pi: { ...native.pi, events: createEventBus() }, cwd, currentSessionId: id },
          artifactsDir: cwd,
          shareEnabled: false,
          maxSubagentDepth: 2,
        });
        assert.ok(!(started.isError === true), textAt(started.content));
        const payload = await waitForResult(id);
        ({ results, outputs, workflowGraph: graph } = payload);
        assert.equal(payload.state, "failed");
      }
      assert.match(results[1]?.error ?? "", /Resource limit exceeded/);
      assert.equal(results[1]?.resourceLimitExceeded?.kind, limit);
      assert.equal(results[1]?.resourceLimitExceeded?.limit, 100);
      assert.equal(outputs?.answers, undefined);
      assertDefined(graph);
      assert.equal(graph.nodes[1].status, "failed");
      assertDefined(graph);
      assert.equal(graph.nodes[2].status, "pending");
      assert.equal(results.length, 2, "must not execute the downstream step");
      // The execution deadline includes startup: the spawned child can be killed
      // before the mock script records its call. Token limits require a response.
      const recordedCalls = calls();
      if (limit === "maxExecutionTimeMs") {
        assert.ok(recordedCalls.length === 1 || recordedCalls.length === 2);
      } else {
        assert.equal(recordedCalls.length, 2);
      }
      assert.match(stringValue(recordedCalls[0].expandedArgs.at(-1)), /^Task: List items$/);
      if (recordedCalls[1]) {
        assert.match(stringValue(recordedCalls[1].expandedArgs.at(-1)), /^Task: Review a(?:\n|$)/);
      }
      for (const call of recordedCalls) {
        assert.doesNotMatch(call.expandedArgs.join("\n"), /Downstream must not run/);
      }
      assertDefined(results[1].artifactPaths);
      assertDefined(results[1].artifactPaths.metadataPath);
      const metadata = readChildMetadata(results[1].artifactPaths.metadataPath);
      assert.equal(metadata.agent, "worker");
      assertDefined(metadata.task);
      assert.match(metadata.task, /^Review a(?:\n|$)/);
      assertDefined(metadata.agentProcessExit);
      assertDefined(metadata.agentProcessExit.pid);
      assert.ok(
        Number.isSafeInteger(metadata.agentProcessExit.pid) && metadata.agentProcessExit.pid > 0,
        "must record the actual child process exit",
      );
      assert.equal(metadata.exitCode, 1);
      assert.equal(metadata.error, results[1].error);
      assertDefined(metadata.resourceLimitExceeded);
      assert.equal(metadata.resourceLimitExceeded.kind, limit);
      assertDefined(metadata.resourceLimitExceeded);
      assert.equal(metadata.resourceLimitExceeded.limit, 100);
      assert.deepEqual(metadata.modelAttempts, results[1].modelAttempts);
      assertDefined(metadata.modelAttempts);
      assert.equal(metadata.modelAttempts.length, 1);
      assertDefined(metadata.modelAttempts);
      assert.equal(metadata.modelAttempts[0].success, false);
      assertDefined(metadata.modelAttempts);
      assert.equal(metadata.modelAttempts[0].exitCode, 1);
      assertDefined(metadata.modelAttempts);
      assert.equal(metadata.modelAttempts[0].error, metadata.error);
    });
  }

  it(`background dynamic group-level acceptance is rejected before any child starts`, async () => {
    mock.onCall({ output: "Items", structuredOutput: { items: ["a"] } });
    const chain = [
      { agent: "worker", task: "Produce", as: "items", outputSchema: { type: "object" } },
      {
        expand: { from: { output: "items", path: "/items" }, maxItems: 1 },
        parallel: { agent: "worker", task: "Review {item}" },
        collect: { as: "answers" },
        acceptance,
      },
    ];
    const result = executeAsyncChain(id, {
      chain,
      agents: [makeAgent("worker")],
      ctx: { pi: { ...native.pi, events: createEventBus() }, cwd, currentSessionId: id },
      shareEnabled: false,
      maxSubagentDepth: 2,
    });
    if (!(result.isError === true)) {
      await waitForResult(id);
    }
    assert.equal(result.isError, true);
    assert.match(textAt(result.content), /does not support group-level acceptance/);
    assert.equal(mock.callCount(), 0);
  });

  it(`background dynamic groups namespace explicit relative outputs`, async () => {
    mock.onCall({ output: "Items", structuredOutput: { items: ["a", "b"] } });
    mock.onCall({ output: "One" });
    mock.onCall({ output: "Two" });
    const chainDir = path.join(cwd, "dynamic-output");
    const chain = [
      { agent: "worker", task: "List items", as: "items", outputSchema: { type: "object" } },
      {
        expand: { from: { output: "items", path: "/items" }, maxItems: 2 },
        parallel: { agent: "worker", task: "Review {item}", output: "answer.md" },
        collect: { as: "answers" },
        concurrency: 1,
      },
    ];
    {
      const started = executeAsyncChain(id, {
        chain,
        chainDir,
        agents: [makeAgent("worker")],
        ctx: { pi: { ...native.pi, events: createEventBus() }, cwd, currentSessionId: id },
        shareEnabled: false,
        maxSubagentDepth: 2,
      });
      assert.ok(!(started.isError === true), textAt(started.content));
      assert.equal((await waitForResult(id)).success, true);
    }
    for (const [index, output] of ["One", "Two"].entries()) {
      assert.equal(
        fs.readFileSync(
          path.join(chainDir, id, "parallel-1", `${index}-worker`, "answer.md"),
          "utf8",
        ),
        output,
      );
    }
  });

  it(`background chain groups reject duplicate absolute agent-default outputs before spawning`, async () => {
    const output = path.join(cwd, "shared.md");
    const chain = [
      {
        parallel: [
          { agent: "worker", task: "First" },
          { agent: "worker", task: "Second" },
        ],
      },
    ];
    const agents = [makeAgent("worker", { output })];
    const result = executeAsyncChain(id, {
      chain,
      agents,
      ctx: { pi: { ...native.pi, events: createEventBus() }, cwd, currentSessionId: id },
      shareEnabled: false,
      maxSubagentDepth: 2,
    });
    assert.equal(result.isError, true);
    assert.ok(textAt(result.content).includes(`same path: ${output}`));
    assert.equal(mock.callCount(), 0);
  });

  it(`background chain parallel groups inherit group cwd and namespace explicit relative outputs`, async () => {
    fs.mkdirSync(path.join(cwd, "group", "child"), { recursive: true });
    mock.onCall({ output: "One" });
    mock.onCall({ output: "Two" });
    const chainDir = path.join(cwd, "chain-output");
    const chain = [
      {
        cwd: "group",
        concurrency: 1,
        parallel: [
          { agent: "worker", task: "First", output: "answer.md" },
          { agent: "worker", task: "Second", cwd: "child", output: "answer.md" },
        ],
      },
    ];
    {
      const started = executeAsyncChain(id, {
        chain,
        chainDir,
        agents: [makeAgent("worker")],
        ctx: { pi: { ...native.pi, events: createEventBus() }, cwd, currentSessionId: id },
        shareEnabled: false,
        maxSubagentDepth: 2,
      });
      assert.ok(!(started.isError === true), textAt(started.content));
      assert.equal((await waitForResult(id)).success, true);
    }
    assert.deepEqual(
      calls().map((call) => fs.realpathSync(call.cwd)),
      ["group", "group/child"].map((dir) => fs.realpathSync(path.join(cwd, dir))),
    );
    for (const [index, output] of ["One", "Two"].entries()) {
      assert.equal(
        fs.readFileSync(
          path.join(chainDir, id, "parallel-0", `${index}-worker`, "answer.md"),
          "utf8",
        ),
        output,
      );
    }
  });

  it("background cancellation after a successful prefix never reports the pending workflow complete", async () => {
    mock.onCall({ output: "Completed first step" });
    const preloadPath = path.join(cwd, "cancel-prefix.cjs");
    const statusPath = path.join(getRunMetadataDir(id), "status.json");
    // Stop at the published successful prefix, before the next child can start.
    fs.writeFileSync(
      preloadPath,
      `
if (process.argv[1]?.endsWith("subagent-runner.ts")) {
  const fs = require("node:fs");
  const rename = fs.renameSync;
  let cancelled = false;
  fs.renameSync = (...args) => {
    const result = rename(...args);
    if (!cancelled && args[1] === ${JSON.stringify(statusPath)}) {
      const status = JSON.parse(fs.readFileSync(args[1], "utf8"));
      if (status.steps[0]?.status === "complete" && status.steps[1]?.status === "pending") {
        cancelled = true;
        process.emit("SIGTERM");
      }
    }
    return result;
  };
  require("node:module").syncBuiltinESMExports();
}
`,
    );
    const nodeOptions = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = [nodeOptions, `--require ${JSON.stringify(preloadPath)}`]
      .filter(Boolean)
      .join(" ");
    try {
      executeAsyncChain(id, {
        chain: [
          { agent: "worker", task: "First" },
          { agent: "worker", task: "Downstream must not run" },
        ],
        agents: [makeAgent("worker")],
        ctx: { pi: { ...native.pi, events: createEventBus() }, cwd, currentSessionId: id },
        shareEnabled: false,
        maxSubagentDepth: 2,
      });
      const payload = await waitForResult(id);
      assert.equal(payload.state, "failed");
      assert.equal(payload.success, false);
      assert.equal(payload.results.length, 1);
      assert.equal(payload.results[0].success, true);
      assertDefined(payload.workflowGraph);
      assert.equal(payload.workflowGraph.nodes[1].status, "pending");
      assert.equal(mock.callCount(), 1);
    } finally {
      if (nodeOptions === undefined) {
        delete process.env.NODE_OPTIONS;
      } else {
        process.env.NODE_OPTIONS = nodeOptions;
      }
    }
  });

  function executor() {
    return createSubagentExecutor({
      pi: {
        ...native.pi,
        events: createEventBus(),
        getSessionName: () => {
          /* The fixture does not need getSessionName side effects. */
        },
      },
      state: {
        ...createSubagentState(cwd),
        baseCwd: cwd,
        currentSessionId: null,
        asyncJobs: new Map(),
      },
      config: {},
      asyncByDefault: false,
      tempArtifactsDir: cwd,
      getSubagentSessionRoot: () => cwd,
      expandTilde: (value) => value,
      discoverAgents: () => ({ agents: [makeAgent("worker")] }),
    });
  }

  for (const background of [false, true]) {
    it(`${background ? "background" : "foreground"} fresh children inherit the exact parent model and suppress native context loading`, async () => {
      mock.onCall({ output: "Done" });
      const ctx = {
        ...makeMinimalCtx(cwd),
        model: fauxProvider({
          provider: "parent-provider",
          models: [{ id: "specific-model" }],
        }).getModel(),
      };
      const result = await executor().execute({
        toolCallId: "test",
        params: { agent: "worker", task: "Say done", async: background },
        ctx: ctx,
      });
      if (background) {
        assertDefined(result.details.asyncId);
        id = result.details.asyncId;
        await waitForResult(id);
      }
      const args = calls()[0].args;
      if (background) {
        assert.equal(
          path.basename(path.dirname(path.dirname(args[args.indexOf("--session") + 1]))),
          result.details.asyncId,
        );
      }
      assert.equal(args[args.indexOf("--model") + 1], "parent-provider/specific-model");
      assert.ok(args.includes("--no-context-files"));
    });
  }

  it("clarify switching single to background preserves the acceptance contract", async () => {
    mock.onCall({
      nativeReport: {
        scenario: "single",
        initialReport: `Initial\n${report()}`,
        report: `Reviewed\n${report()}`,
        receiptPath: path.join(cwd, "native.json"),
      },
    });
    const ctx = {
      ...makeMinimalCtx(cwd),
      hasUI: true,
      mode: "tui" as const,
      ui: { ...native.context.ui, custom: customInteraction(["b", "\r"]) },
    };
    const result = await executor().execute({
      toolCallId: "test",
      params: { agent: "worker", task: "Deliver the result", clarify: true, acceptance },
      ctx: ctx,
    });
    assert.ok(!(result.isError === true), textAt(result.content));
    assertDefined(result.details.asyncId);
    id = result.details.asyncId;
    const completed = await waitForResult(id);
    assertDefined(completed.results[0].sessionFile);
    assert.equal(path.basename(path.dirname(path.dirname(completed.results[0].sessionFile))), id);
    assertDefined(completed.results[0].acceptance);
    assert.equal(completed.results[0].acceptance.status, "checked");
    assertDefined(completed.results[0].acceptance);
    assertDefined(completed.results[0].acceptance.finalization);
    assert.equal(completed.results[0].acceptance.finalization.turns.length, 1);
    assert.equal(mock.callCount(), 1);
  });
});
