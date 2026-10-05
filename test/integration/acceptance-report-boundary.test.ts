import { readRunResult, readRunStatus, readChildMetadata } from "../support/run-publications.ts";
import { readNativeReportReceipt } from "../support/child-process-receipts.ts";
import { assertDefined, parseJson, textAt, record, records } from "../support/assertions.ts";
import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { executeAsyncSingle } from "../../src/runs/background/async-execution.ts";
import { parseAcceptanceReport, stripAcceptanceReport } from "../../src/runs/shared/acceptance.ts";
import {
  getRunMetadataDir,
  questionProcessAlive,
  readQuestionContract,
} from "../../src/runs/shared/supervisor-questions.ts";
import { ASYNC_DIR, RESULTS_DIR, getAsyncConfigPath } from "../../src/shared/types.ts";
import {
  createEventBus,
  createNativeSessionFixture,
  createMockPi,
  createTempDir,
  makeAgent,
  removeTempDir,
} from "../support/helpers.ts";
import { completeWorkflowStep } from "../../src/runs/shared/workflow-policy.ts";
import { materializeDynamicParallelStep } from "../../src/runs/shared/dynamic-fanout.ts";

const details =
  "Result path: /fixture/deliverable.md\nIdentifier: task-42\nFinding: all requested handoff details survive coordination.\nValidation: fixture checks passed.\nRisks: none.";
const handoff = `Full final task report\n${details}`;
const report = (prose = handoff, satisfied = true) =>
  `${prose}\n\n\`\`\`acceptance-report\n${JSON.stringify({
    criteriaSatisfied: [
      {
        id: "criterion-1",
        status: satisfied ? "satisfied" : "not-satisfied",
        evidence: "Native fixture state",
      },
    ],
    changedFiles: ["fixture.ts"],
    residualRisks: satisfied ? [] : ["The new task requirement is blocked."],
    diffSummary: prose,
  })}\n\`\`\``;
const fullReport = report();
const initialReport = report(`Initial task report\n${details}`);
const blockedReport = `Waiting for the user's Touch ID.\n\n\`\`\`acceptance-report\n${JSON.stringify({ criteriaSatisfied: [{ id: "criterion-1", status: "blocked", evidence: "The native sign-in dialog requests Touch ID on this machine.", humanAction: "Complete Touch ID in the sign-in dialog." }], changedFiles: ["fixture.ts"], residualRisks: ["Human authentication is incomplete."], diffSummary: "Completed code is retained; authentication needs the user." })}\n\`\`\``;

async function waitFor(check: () => boolean, label: string) {
  const deadline = Date.now() + 20_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, label);
    // Observe the owner publication before advancing this lifecycle transition.
    // oxlint-disable-next-line no-await-in-loop
    await delay(20);
  }
}

const nativeRoot = createTempDir("report-boundary-sdk-");
const nativeSession = await createNativeSessionFixture({ cwd: nativeRoot, agentDir: nativeRoot });
after(async () => {
  await nativeSession.dispose();
  removeTempDir(nativeRoot);
});

describe("background native acceptance report boundary", () => {
  const mock = createMockPi();
  let cwd: string, id: string;
  const receipts: string[] = [];
  before(() => mock.install());
  after(() => mock.uninstall());
  beforeEach(() => {
    cwd = createTempDir("report-boundary-");
    id = path.basename(cwd);
    receipts.length = 0;
    mock.reset();
  });
  afterEach(() => {
    removeTempDir(cwd);
    removeTempDir(getRunMetadataDir(id));
    removeTempDir(path.join(ASYNC_DIR, id));
    fs.rmSync(path.join(RESULTS_DIR, `${id}.json`), { force: true });
    fs.rmSync(getAsyncConfigPath(id), { force: true });
  });

  type ReportFixtureOptions = Readonly<{
    maxTurns?: number;
    retry?: string;
    laterReport?: string;
    outputMode?: "inline" | "file-only";
    generated?: boolean;
    publicSchema?: boolean;
    publicOutput?: unknown;
    finalAnswer?: unknown;
    verify?: boolean;
    handoff?: string;
    initialHandoff?: string;
    initialReport?: string;
    finalReport?: string;
  }>;

  function prepareReportFixture(scenario: string, options: ReportFixtureOptions) {
    const outputPath =
      options.outputMode !== undefined ? path.join(cwd, "requested.md") : undefined;
    const schema = {
      type: "object",
      properties: { items: { type: "array", items: { type: "string" } } },
      required: ["items"],
    };
    const receiptPath = path.join(cwd, `native-${receipts.length}.json`);
    receipts.push(receiptPath);
    mock.onCall({
      nativeReport: {
        scenario,
        initialReport: options.initialReport ?? initialReport,
        initialDelay: (options.initialHandoff ?? "").length > 0 ? 300 : undefined,
        retry: options.retry,
        report: options.finalReport ?? fullReport,
        laterReport: options.laterReport,
        receiptPath,
        handoffPath: outputPath,
        handoff: options.handoff,
        publicOutput: options.publicOutput,
        finalAnswer: options.finalAnswer,
      },
    });
    const agent = makeAgent("worker", {
      model: "report-fixture/faux-1",
      tools: ["fixture_work"],
      extensions: [],
      ...(options.generated === true ? { output: "requested.md" } : {}),
    });
    const acceptance = {
      criteria: ["Deliver the current full task report"],
      maxFinalizationTurns: options.maxTurns ?? 1,
      ...(options.verify === true
        ? { verify: [{ id: "owned-check", command: 'node -e "process.exit(7)"' }] }
        : {}),
    };
    return { outputPath, schema, agent, acceptance };
  }

  async function run(scenario: string, options: ReportFixtureOptions = {}) {
    const { outputPath, schema, agent, acceptance } = prepareReportFixture(scenario, options);
    let pending;
    {
      const started = executeAsyncSingle(id, {
        agent: "worker",
        task: "Produce the complete handoff",
        agentConfig: agent,
        ctx: { pi: { ...nativeSession.pi, events: createEventBus() }, cwd, currentSessionId: id },
        acceptance,
        artifactsDir: path.join(cwd, "artifacts"),
        sessionFile: path.join(cwd, "session.jsonl"),
        shareEnabled: false,
        maxSubagentDepth: 2,
        output: options.generated === true ? undefined : outputPath,
        outputMode: options.outputMode,
        outputSchema: options.publicSchema === true ? schema : undefined,
      });
      assert.ok(!(started.isError === true), textAt(started.content));
      pending = (async () => {
        const resultPath = path.join(RESULTS_DIR, `${id}.json`);
        await waitFor(() => fs.existsSync(resultPath), "background final result must arrive");
        const result = readRunResult(resultPath).results[0];
        assertDefined(result);
        const status = readRunStatus(path.join(getRunMetadataDir(id), "status.json"));
        const pid = status.pid;
        assertDefined(pid);
        await waitFor(() => !questionProcessAlive({ pid }), "owned background runner must exit");
        assertDefined(status.steps);
        assert.deepEqual(status.steps[0].acceptance, result.acceptance);
        return result;
      })();
    }
    if ((options.initialHandoff ?? "").length > 0) {
      await waitFor(
        () => mock.callCount() > 0,
        "initial child must start before its handoff is written",
      );
      const defined6407_0 = outputPath;
      assertDefined(defined6407_0);
      assertDefined(options.initialHandoff);
      fs.writeFileSync(defined6407_0, options.initialHandoff);
    }
    if (scenario === "cancel") {
      await waitFor(
        () => fs.existsSync(receipts[0]) && readNativeReportReceipt(receipts[0]).waiting === true,
        "native queued response must be running before cancellation",
      );
      const status = readRunStatus(path.join(getRunMetadataDir(id), "status.json"));
      assertDefined(status.pid);
      process.kill(status.pid, "SIGTERM");
    }
    const result = await pending;
    const native = receipts
      .filter((file) => fs.existsSync(file))
      .map((file) => readNativeReportReceipt(file));
    for (const receipt of native) {
      assert.deepEqual(receipt.extensionErrors, []);
      assert.equal(receipt.networkRequests, 0);
    }
    assertDefined(result.artifactPaths);
    assertDefined(result.artifactPaths.metadataPath);
    const metadata = readChildMetadata(result.artifactPaths.metadataPath);
    assert.deepEqual(metadata.acceptance, parseJson(JSON.stringify(result.acceptance)));
    assert.equal(metadata.exitCode, result.exitCode);
    if ((process.env.PI_FINAL_REPORT_EVIDENCE_DIR ?? "").length > 0) {
      assertDefined(process.env.PI_FINAL_REPORT_EVIDENCE_DIR);
      fs.mkdirSync(process.env.PI_FINAL_REPORT_EVIDENCE_DIR, { recursive: true });
      assertDefined(process.env.PI_FINAL_REPORT_EVIDENCE_DIR);
      fs.writeFileSync(
        path.join(process.env.PI_FINAL_REPORT_EVIDENCE_DIR, `bg-${id}.json`),
        JSON.stringify({ scenario, options, result, native, metadata }, null, 2),
      );
    }
    const savedOutput = readQuestionContract(id, 0)?.launch?.output;
    assertDefined(result.artifactPaths.outputPath);
    return {
      result,
      native,
      outputPath: typeof savedOutput === "string" ? savedOutput : outputPath,
      artifact: fs.readFileSync(result.artifactPaths.outputPath, "utf8"),
    };
  }

  it("an initial explicit human blocker stops before repair turns or verification", async () => {
    const { result, native } = await run("single", {
      initialReport: blockedReport,
      maxTurns: 3,
      verify: true,
    });
    assert.equal(result.exitCode, 0, result.error);
    assertDefined(result.acceptance);
    assert.equal(result.acceptance.status, "blocked");
    assertDefined(result.acceptance);
    assert.equal(result.acceptance.finalization, undefined);
    assertDefined(result.acceptance);
    assert.deepEqual(result.acceptance.verifyRuns, []);
    assertDefined(result.acceptance);
    assertDefined(result.acceptance.childReport);
    assert.deepEqual(result.acceptance.childReport.changedFiles, ["fixture.ts"]);
    assertDefined(result.acceptance);
    assertDefined(result.acceptance.childReport);
    assertDefined(result.acceptance.childReport.criteriaSatisfied);
    assertDefined(result.acceptance.childReport.criteriaSatisfied[0].humanAction);
    assert.match(result.acceptance.childReport.criteriaSatisfied[0].humanAction, /Touch ID/);
    assert.equal(native.length, 1);
    assert.equal(native[0].providerCalls, 1);
    assert.equal(mock.callCount(), 1);
    {
      const data = readRunResult(path.join(getRunMetadataDir(id), "result.json"));
      assert.equal(data.state, "blocked");
      assert.equal(data.success, false);
      assert.equal(
        readRunStatus(path.join(getRunMetadataDir(id), "status.json")).steps?.[0]?.status,
        "blocked",
      );
      const events = fs
        .readFileSync(path.join(getRunMetadataDir(id), "events.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => record(parseJson(line)));
      assert.ok(events.some((event) => event.type === "subagent.step.blocked"));
      assert.equal(
        events.some((event) => event.type === "subagent.step.completed"),
        false,
      );
    }
  });

  it("a current native blocked submission stops remaining finalization and verification", async () => {
    const { result } = await run("not-satisfied", {
      laterReport: blockedReport,
      maxTurns: 3,
      verify: true,
      retry: "single",
    });
    assertDefined(result.acceptance);
    assert.equal(result.acceptance.status, "blocked");
    assertDefined(result.acceptance);
    assertDefined(result.acceptance.finalization);
    assert.equal(result.acceptance.finalization.status, "blocked");
    assertDefined(result.acceptance);
    assertDefined(result.acceptance.finalization);
    assert.equal(result.acceptance.finalization.turns.length, 1);
    assertDefined(result.acceptance);
    assert.deepEqual(result.acceptance.verifyRuns, []);
    assert.equal(mock.callCount(), 1);
  });

  it("an obsolete native blocked submission is audit evidence, not the current outcome", async () => {
    const { result } = await run("plain", { finalReport: blockedReport });
    assertDefined(result.acceptance);
    assert.equal(result.acceptance.status, "rejected");
    assertDefined(result.acceptance);
    assert.equal(result.acceptance.childReport, undefined);
    assertDefined(result.acceptance);
    assert.equal(result.acceptance.unconfirmedOutput, blockedReport);
  });

  it("uses the current explicit resubmission after queued coordination without an extra pass", async () => {
    const { result, native, artifact } = await run("resubmit");
    assert.equal(result.exitCode, 0, result.error);
    assertDefined(result.acceptance);
    assert.equal(result.acceptance.status, "checked");
    assertDefined(result.acceptance);
    assert.deepEqual(result.acceptance.childReport, parseAcceptanceReport(fullReport).report);
    assertDefined(result.acceptance);
    assertDefined(result.acceptance.finalization);
    assert.equal(result.acceptance.finalization.turns[0].rawOutput, handoff);
    assertDefined(result.acceptance);
    assertDefined(result.acceptance.finalization);
    assert.equal(result.acceptance.finalization.turns.length, 1);
    assert.equal(result.finalOutput ?? result.output, handoff);
    assert.equal(artifact, handoff);
    assert.equal(native[0].providerCalls, 3);
    const latest = native[0].messages.findLast((message) => message.role === "assistant");
    assertDefined(latest);
    const submission = records(latest.content)[0];
    assertDefined(submission);
    assert.deepEqual(record(submission.arguments).value, {
      answer: handoff,
      report: parseAcceptanceReport(fullReport).report,
    });
    assert.ok(
      native[0].messages.some(
        (message) =>
          message.role === "toolResult" &&
          message.toolCallId === submission.id &&
          message.isError === false,
      ),
    );
    assert.equal(mock.callCount(), 1);
  });

  for (const outputMode of ["inline", "file-only"] as const) {
    it(`saves the current complete report with ${outputMode} output`, async () => {
      const { result, artifact, outputPath } = await run("resubmit", { outputMode });
      assert.equal(result.exitCode, 0, result.error);
      assert.equal(artifact, handoff);
      const defined11997_0 = outputPath;
      assertDefined(defined11997_0);
      assert.equal(fs.readFileSync(defined11997_0, "utf8"), handoff);
      if (outputMode === "file-only") {
        assertDefined(result.finalOutput);
        assert.match(result.finalOutput ?? result.output, /Output saved to:/);
        assertDefined(result.finalOutput);
        assert.doesNotMatch(result.finalOutput ?? result.output, /Finding:/);
      }
    });
  }

  it("preserves child-written handoff precedence", async () => {
    const childHandoff = "Child-written detailed handoff with independent findings.\n";
    const { result, artifact, outputPath } = await run("child-file", {
      outputMode: "file-only",
      handoff: childHandoff,
    });
    assert.equal(result.exitCode, 0, result.error);
    assertDefined(result.acceptance);
    assertDefined(result.acceptance.finalization);
    assert.equal(result.acceptance.finalization.turns[0].rawOutput, handoff);
    assert.equal(artifact, childHandoff.trimEnd());
    const defined12754_0 = outputPath;
    assertDefined(defined12754_0);
    assert.equal(fs.readFileSync(defined12754_0, "utf8"), childHandoff);
  });

  it("preserves an existing child-written handoff as unconfirmed when delivery fails", async () => {
    const initialHandoff =
      "Detailed child-written handoff that must not be replaced by coordination.\n";
    const { result, artifact, outputPath } = await run("plain", {
      outputMode: "file-only",
      initialHandoff,
    });
    assert.equal(result.exitCode, 1);
    assert.match(artifact, /^UNCONFIRMED task report/);
    assert.ok(artifact.includes(initialHandoff.trimEnd()));
    assertDefined(result.acceptance);
    assert.equal(result.acceptance.unconfirmedOutput, fullReport);
    const defined13392_0 = outputPath;
    assertDefined(defined13392_0);
    assert.equal(fs.readFileSync(defined13392_0, "utf8"), initialHandoff);
  });

  it("still consumes generated inline output after capturing the final report", async () => {
    const { result, artifact, outputPath } = await run("resubmit", {
      outputMode: "inline",
      generated: true,
    });
    assert.equal(result.exitCode, 0, result.error);
    assert.equal(artifact, handoff);
    assertDefined(result.outputCleanup);
    assert.equal(result.outputCleanup.action, "deleted");
    const defined13840_0 = outputPath;
    assertDefined(defined13840_0);
    assert.equal(fs.existsSync(defined13840_0), false);
  });

  for (const scenario of [
    "plain",
    "follow-up",
    "failed-work",
    "user-failed-work",
    "different-work",
    "malformed-work",
    "malformed-submission",
    "invalid-submission",
    "invalid-tool-submission",
    "mixed",
    "unsubmitted",
    "missing-result",
    "missing-capture",
    "wrong-result-id",
    "invalid-capture",
    "capture-mismatch",
  ]) {
    it(`rejects ${scenario} at the existing cap and retains unconfirmed audit evidence`, async () => {
      const processFailure = [
        "different-work",
        "mixed",
        "missing-result",
        "missing-capture",
        "wrong-result-id",
        "invalid-capture",
        "capture-mismatch",
      ].includes(scenario);
      const { result, artifact } = await run(scenario, {
        laterReport:
          scenario === "capture-mismatch" ? report(`${handoff}\nUnmatched capture`) : undefined,
      });
      assert.equal(result.exitCode, 1);
      assertDefined(result.acceptance);
      assert.equal(result.acceptance.status, "rejected");
      assertDefined(result.acceptance);
      assert.equal(result.acceptance.childReport, undefined);
      assertDefined(result.acceptance);
      assertDefined(result.acceptance.finalization);
      assert.equal(result.acceptance.finalization.status, "failed");
      assertDefined(result.acceptance);
      assertDefined(result.acceptance.finalization);
      assert.equal(result.acceptance.finalization.turns.length, 1);
      assertDefined(result.acceptance);
      assert.equal(
        result.acceptance.runtimeChecks.find(
          (check) => check.id === (processFailure ? "finalization-process" : "finalization-report"),
        )?.status,
        "failed",
      );
      assertDefined(result.acceptance);
      assertDefined(result.acceptance.unconfirmedOutput);
      assert.match(result.acceptance.unconfirmedOutput, /Identifier: task-42/);
      if (
        [
          "plain",
          "follow-up",
          "failed-work",
          "user-failed-work",
          "different-work",
          "malformed-work",
          "malformed-submission",
          "invalid-submission",
          "invalid-tool-submission",
          "mixed",
          "missing-result",
        ].includes(scenario)
      ) {
        assertDefined(result.acceptance);
        assert.equal(result.acceptance.unconfirmedOutput, fullReport);
      }
      assert.match(artifact, /^UNCONFIRMED task report/);
      assert.match(artifact, /Identifier: task-42/);
      assert.doesNotMatch(artifact, /Coordination acknowledged/);
      assertDefined(result.modelAttempts);
      assert.equal(
        result.modelAttempts[1].error,
        processFailure ? "Native self-review boundary did not return a result." : undefined,
      );
      assert.equal(mock.callCount(), 1, "no hidden report-refresh pass at the cap");
    });
  }

  it("uses remaining finalization budget to recover missing report delivery", async () => {
    const { result, native, artifact } = await run("plain", { maxTurns: 2, retry: "single" });
    assert.equal(result.exitCode, 0, result.error);
    assertDefined(result.acceptance);
    assert.equal(result.acceptance.status, "checked");
    assertDefined(result.acceptance);
    assertDefined(result.acceptance.finalization);
    assert.deepEqual(
      result.acceptance.finalization.turns.map((turn) => turn.status),
      ["rejected", "checked"],
    );
    assertDefined(result.acceptance);
    assertDefined(result.acceptance.finalization);
    assert.equal(result.acceptance.finalization.turns[0].unconfirmedOutput, fullReport);
    assertDefined(result.acceptance);
    assert.equal(result.acceptance.unconfirmedOutput, undefined);
    assert.equal(artifact, handoff);
    assert.deepEqual(
      native.map((receipt) => receipt.providerCalls),
      [4],
    );
    assertDefined(result.modelAttempts);
    assert.equal(
      result.modelAttempts.reduce((sum, attempt) => {
        assertDefined(attempt.usage);
        return sum + attempt.usage.turns;
      }, 0),
      4,
    );
    assert.equal(mock.callCount(), 1);
  });

  it("can repair a failed tool and explicitly submit a new current report", async () => {
    const { result, native, artifact } = await run("repair");
    assert.equal(result.exitCode, 0, result.error);
    assertDefined(result.acceptance);
    assert.equal(result.acceptance.status, "checked");
    assertDefined(result.acceptance);
    assertDefined(result.acceptance.finalization);
    assert.equal(result.acceptance.finalization.turns[0].rawOutput, handoff);
    assert.equal(native[0].providerCalls, 5);
    assert.equal(
      native[0].events.filter(
        (event) => event.type === "tool_execution_end" && event.isError === true,
      ).length,
      1,
    );
    assert.equal(artifact, handoff);
  });

  it("uses a fresh not-satisfied report instead of earlier success", async () => {
    const current = report(`Current task blocked\n${details}`, false);
    const { result, artifact } = await run("not-satisfied", { laterReport: current });
    assert.equal(result.exitCode, 1);
    assertDefined(result.acceptance);
    assertDefined(result.acceptance.childReport);
    assertDefined(result.acceptance.childReport.criteriaSatisfied);
    assert.equal(result.acceptance.childReport.criteriaSatisfied[0].status, "not-satisfied");
    assertDefined(result.acceptance);
    assertDefined(result.acceptance.finalization);
    assert.equal(result.acceptance.finalization.turns[0].rawOutput, stripAcceptanceReport(current));
    assert.equal(artifact, `Current task blocked\n${details}`);
    assertDefined(result.acceptance);
    assert.equal(result.acceptance.unconfirmedOutput, undefined);
  });

  it("does not invalidate a submission for passive context without a new model turn", async () => {
    const { result, native, artifact } = await run("passive");
    assert.equal(result.exitCode, 0, result.error);
    assert.equal(artifact, handoff);
    assert.equal(native[0].providerCalls, 2);
    assert.equal(native[0].messages.at(-1)?.role, "custom");
    assertDefined(result.acceptance);
    assertDefined(result.acceptance.finalization);
    assert.equal(result.acceptance.finalization.turns[0].rawOutput, handoff);
  });

  for (const scenario of ["error", "native-abort", "cancel"]) {
    it(`keeps ${scenario} authoritative after a submitted report`, async () => {
      const { result, artifact } = await run(scenario, { maxTurns: 2, retry: "single" });
      assert.notEqual(result.exitCode, 0);
      assertDefined(result.acceptance);
      assert.equal(result.acceptance.status, "rejected");
      assertDefined(result.acceptance);
      assert.equal(result.acceptance.childReport, undefined);
      assertDefined(result.acceptance);
      assert.equal(result.acceptance.unconfirmedOutput, fullReport);
      assertDefined(result.acceptance);
      assertDefined(result.acceptance.finalization);
      assert.equal(result.acceptance.finalization.turns.length, 1);
      assert.match(artifact, /^UNCONFIRMED task report/);
      assert.equal(mock.callCount(), 1);
    });
  }

  it("keeps configured verification failure authoritative", async () => {
    const { result, artifact } = await run("resubmit", {
      maxTurns: 2,
      verify: true,
      retry: "single",
    });
    assert.equal(result.exitCode, 1);
    assertDefined(result.acceptance);
    assert.equal(result.acceptance.status, "rejected");
    assertDefined(result.acceptance);
    assert.equal(result.acceptance.verifyRuns[0].exitCode, 7);
    assertDefined(result.acceptance);
    assertDefined(result.acceptance.finalization);
    assert.equal(result.acceptance.finalization.turns.length, 1);
    assert.equal(artifact, handoff);
    assert.equal(mock.callCount(), 1);
  });

  it("publishes the repaired public payload to named outputs and fanout separately from the private report", async () => {
    const repaired = { items: ["A", "B"] };
    const { result, native } = await run("resubmit", {
      publicSchema: true,
      publicOutput: { items: ["A"] },
      finalAnswer: repaired,
      initialReport: report('{"items":["A"]}', false),
    });
    assert.equal(result.exitCode, 0, result.error);
    assert.deepEqual(result.structuredOutput, repaired);
    assertDefined(result.structuredOutputPath);
    assert.deepEqual(
      parseJson(fs.readFileSync(result.structuredOutputPath, "utf8")),
      result.structuredOutput,
    );
    assertDefined(result.structuredOutputSchemaPath);
    assert.ok(
      record(
        record(parseJson(fs.readFileSync(result.structuredOutputSchemaPath, "utf8"))).properties,
      ).items,
    );
    assert.deepEqual(native[0].capture, {
      answer: repaired,
      report: parseAcceptanceReport(fullReport).report,
    });
    assertDefined(native[0].schema);
    assertDefined(native[0].schema.required);
    assert.deepEqual(native[0].schema.required, ["answer", "report"]);
    assertDefined(result.agent);
    assertDefined(result.exitCode);
    assertDefined(result.output);
    const workflow = completeWorkflowStep({
      stepIndex: 0,
      stepCount: 2,
      results: [
        {
          agent: result.agent,
          exitCode: result.exitCode,
          output: result.output,
          structuredOutput: result.structuredOutput,
        },
      ],
      outputNames: ["plan"],
      previousOutput: "",
    });
    assert.deepEqual(workflow.outputs.plan.structured, repaired);
    const fanout = materializeDynamicParallelStep(
      {
        expand: { from: { output: "plan", path: "/items" }, maxItems: 10 },
        parallel: { agent: "worker", task: "Process {item}" },
        collect: { as: "results" },
      },
      workflow.outputs,
      1,
    );
    assert.deepEqual(
      fanout.items.map((item) => item.item),
      repaired.items,
    );
  });

  for (const scenario of ["single", "plain"]) {
    it(`rejects ${scenario === "single" ? "schema-invalid" : "obsolete"} repaired public output`, async () => {
      const initial = { items: ["A"] };
      const { result } = await run(scenario, {
        publicSchema: true,
        publicOutput: initial,
        finalAnswer: { items: scenario === "single" ? [42] : ["A", "B"] },
      });
      assert.equal(result.exitCode, 1);
      assertDefined(result.acceptance);
      assert.equal(result.acceptance.status, "rejected");
      assert.deepEqual(
        result.structuredOutput,
        initial,
        "an invalid or obsolete submission cannot replace the last validated payload",
      );
      assertDefined(result.structuredOutputPath);
      assert.deepEqual(parseJson(fs.readFileSync(result.structuredOutputPath, "utf8")), initial);
    });
  }

  it("updates the public payload without replacing a child-written output file", async () => {
    const repaired = { items: ["A", "B"] };
    const handoff = "Child-authored handoff remains authoritative.\n";
    const { result, artifact, outputPath } = await run("child-file", {
      publicSchema: true,
      publicOutput: { items: ["A"] },
      finalAnswer: repaired,
      outputMode: "file-only",
      handoff,
    });
    assert.equal(result.exitCode, 0, result.error);
    assert.deepEqual(result.structuredOutput, repaired);
    const defined22800_0 = outputPath;
    assertDefined(defined22800_0);
    assert.equal(fs.readFileSync(defined22800_0, "utf8"), handoff);
    assert.equal(artifact, handoff.trimEnd());
  });
});
