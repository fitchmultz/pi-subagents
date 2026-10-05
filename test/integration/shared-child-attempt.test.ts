import { readRunResult, readRunStatus } from "../support/run-publications.ts";
import { readNativeAttemptReceipt } from "../support/child-process-receipts.ts";
import { assertDefined, array } from "../support/assertions.ts";
import "../support/isolated-home.ts";
import { isRecord } from "../../src/shared/unknown.ts";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { findPackageJSON } from "node:module";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { resolveEffectiveAcceptance } from "../../src/runs/shared/acceptance.ts";
import { getRunMetadataDir } from "../../src/runs/shared/supervisor-questions.ts";
import { writeAsyncControlRequest } from "../../src/runs/background/async-control.ts";
import { createMockPi, createTempDir, events, removeTempDir } from "../support/helpers.ts";
import { runChildAttempt } from "../../src/runs/shared/child-attempt.ts";
import { createNativeFinalization } from "../../src/runs/shared/native-finalization.ts";

const defined888_0 = findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url);
assertDefined(defined888_0);
const sdkRoot = process.env.PI_INTERCOM_TEST_SDK ?? path.dirname(defined888_0);
const repo = path.resolve(".");
const runtimeDir = path.join(
  repo,
  (process.env.PI_DRIVER_TEST_DIST ?? "").length > 0 ? "dist" : "src",
  "runs/background",
);
const runtimeExtension = (process.env.PI_DRIVER_TEST_DIST ?? "").length > 0 ? "js" : "ts";
const report = {
  criteriaSatisfied: [{ id: "deliver", status: "satisfied", evidence: "Native fixture completed" }],
  residualRisks: [],
  diffSummary: "Implemented fixture",
};

type DriverOptions = Readonly<{
  turns?: number;
  timeoutMs?: number;
  extendMs?: number;
  verify?: string;
  maxTokens?: number;
  maxExecutionTimeMs?: number;
  omitSessionFile?: boolean;
  staged?: boolean;
  withoutAcceptance?: boolean;
  fallback?: boolean;
  legacy?: boolean;
  startupExit?: Readonly<{ code: number; once?: boolean; stderr?: string; model?: string }>;
}>;

function driverAcceptance(options: DriverOptions) {
  return resolveEffectiveAcceptance({
    explicit:
      options.withoutAcceptance === true
        ? undefined
        : {
            criteria: [{ id: "deliver", must: "Deliver fixture" }],
            maxFinalizationTurns: options.turns ?? 1,
            ...(options.staged === true ? { evidence: ["no-staged-files"] } : {}),
            ...(options.verify !== undefined && options.verify.length > 0
              ? { verify: [{ id: "check", command: options.verify }] }
              : {}),
          },
  });
}

function prepareNativeRun(scenario: string, options: DriverOptions) {
  const root = createTempDir("driver-native-");
  const id = path.basename(root);
  const asyncDir = getRunMetadataDir(id);
  const input = path.join(root, "fixture.json"),
    receiptPath = path.join(root, "receipt.json");
  const resultPath = path.join(root, "result.json");
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(root, "agent"));
  fs.writeFileSync(
    path.join(root, "agent/settings.json"),
    JSON.stringify({
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
      compaction: { enabled: false },
    }),
  );
  fs.writeFileSync(
    path.join(bin, "pi"),
    `#!/bin/sh\necho $$ >> '${root}/pids'\nexec '${process.execPath}' '${path.join(sdkRoot, "dist/cli.js")}' "$@"\n`,
    { mode: 0o755 },
  );
  if (options.staged === true) {
    execFileSync("git", ["init", "-q"], { cwd: root });
    fs.writeFileSync(path.join(root, "staged.txt"), "staged fixture\n");
    execFileSync("git", ["add", "staged.txt"], { cwd: root });
  }
  fs.writeFileSync(
    input,
    JSON.stringify({
      scenario,
      receiptPath,
      report: { ...report, ...(options.staged === true ? { noStagedFiles: true } : {}) },
      startupExit: options.startupExit,
    }),
  );
  fs.mkdirSync(asyncDir, { recursive: true });
  const acceptance = driverAcceptance(options);
  const configPath = path.join(asyncDir, "launch.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      id,
      runtimeVersion: options.legacy === true ? undefined : 2,
      timeoutMs: options.timeoutMs,
      cwd: root,
      asyncDir,
      resultPath,
      placeholder: "{previous}",
      resultMode: "single",
      steps: [
        {
          agent: "worker",
          task: "Complete synthetic fixture",
          model: "driver-fixture/faux-1",
          modelCandidates:
            options.fallback === true
              ? ["driver-fixture/faux-1", "driver-fixture/faux-2"]
              : undefined,
          inheritProjectContext: false,
          inheritSkills: false,
          tools: options.staged === true ? ["read", "bash"] : ["read"],
          extensions: [path.join(repo, "test/fixtures/native-child-attempt.mjs")],
          sessionFile:
            options.omitSessionFile === true ? undefined : path.join(root, "session.jsonl"),
          outputPath: path.join(root, "output.md"),
          effectiveAcceptance: acceptance,
          maxTokens: options.maxTokens,
          maxExecutionTimeMs: options.maxExecutionTimeMs,
          ...(scenario === "public-output"
            ? {
                structuredOutputSchema: {
                  type: "object",
                  properties: { items: { type: "array", items: { type: "string" } } },
                  required: ["items"],
                },
              }
            : {}),
        },
      ],
    }),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PI_INTERCOM_TEST_SDK: sdkRoot,
    PI_PACKAGE_DIR: sdkRoot,
    PI_CODING_AGENT_DIR: path.join(root, "agent"),
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    PI_DRIVER_FIXTURE: input,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  for (const key of Object.keys(env)) {
    if (key.startsWith("PI_SUBAGENT_") && key !== "PI_SUBAGENT_TEMP_ROOT") {
      delete env[key];
    }
  }
  return { root, id, asyncDir, receiptPath, resultPath, configPath, env };
}

async function run(scenario: string, options: DriverOptions = {}) {
  const { root, id, asyncDir, receiptPath, resultPath, configPath, env } = prepareNativeRun(
    scenario,
    options,
  );
  const proc = spawn(
    process.execPath,
    [
      path.join(runtimeDir, `subagent-runner-launcher.${runtimeExtension}`),
      path.join(runtimeDir, `subagent-runner.${runtimeExtension}`),
      configPath,
    ],
    { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let log = "";
  proc.stdout.on("data", (chunk: Buffer) => {
    log += chunk.toString();
  });
  proc.stderr.on("data", (chunk: Buffer) => {
    log += chunk.toString();
  });
  const watchdog = setTimeout(() => {
    proc.kill("SIGTERM");
  }, 20_000);
  try {
    if ((options.extendMs ?? 0) !== 0 && !Number.isNaN(options.extendMs)) {
      const deadline = Date.now() + 15_000;
      while (!fs.existsSync(receiptPath)) {
        assert.ok(Date.now() < deadline, log);
        // Observe the owner publication before advancing this lifecycle transition.
        // oxlint-disable-next-line no-await-in-loop
        await delay(10);
      }
      writeAsyncControlRequest(asyncDir, id, "extend", { extendMs: options.extendMs });
    }
    const closed: unknown = await once(proc, "close");
    const code = array(closed)[0];
    assert.equal(code, 0, log);
    assert.ok(fs.existsSync(resultPath), log);
    const result = readRunResult(resultPath);
    const receipt = fs.existsSync(receiptPath) ? readNativeAttemptReceipt(receiptPath) : undefined;
    const status = readRunStatus(path.join(asyncDir, "status.json"));
    if (!(options.legacy === true)) {
      assert.ok(fs.existsSync(configPath), "v2 owner retains frozen launch");
    }
    assert.equal(receipt?.networkRequests ?? 0, 0);
    const pids = fs.readFileSync(path.join(root, "pids"), "utf8").trim().split("\n").map(Number);
    return {
      result,
      receipt,
      status,
      pids,
      output: fs.existsSync(path.join(root, "output.md"))
        ? fs.readFileSync(path.join(root, "output.md"), "utf8")
        : undefined,
    };
  } finally {
    clearTimeout(watchdog);
    if (proc.exitCode === null) {
      proc.kill("SIGTERM");
    }
    if ((process.env.PI_DRIVER_EVIDENCE_DIR ?? "").length > 0) {
      assertDefined(process.env.PI_DRIVER_EVIDENCE_DIR);
      fs.mkdirSync(process.env.PI_DRIVER_EVIDENCE_DIR, { recursive: true });
      assertDefined(process.env.PI_DRIVER_EVIDENCE_DIR);
      fs.cpSync(root, path.join(process.env.PI_DRIVER_EVIDENCE_DIR, id), { recursive: true });
      assertDefined(process.env.PI_DRIVER_EVIDENCE_DIR);
      fs.cpSync(asyncDir, path.join(process.env.PI_DRIVER_EVIDENCE_DIR, `${id}-owner`), {
        recursive: true,
      });
      assertDefined(process.env.PI_DRIVER_EVIDENCE_DIR);
      fs.writeFileSync(path.join(process.env.PI_DRIVER_EVIDENCE_DIR, `${id}.log`), log);
    }
    removeTempDir(root);
    removeTempDir(asyncDir);
  }
}

for (const withoutAcceptance of [true, false]) {
  test(`native pre-boundary exit 143 retries with acceptance ${!withoutAcceptance}`, async () => {
    const { result, receipt, pids } = await run("success", {
      withoutAcceptance,
      startupExit: { code: 143, once: true },
    });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(pids.length, 2);
    assert.equal(new Set(pids).size, 2);
    assertDefined(receipt);
    assert.equal(receipt.pid, pids[1]);
    assertDefined(result.results[0].modelAttempts);
    assertDefined(result.results[0].modelAttempts[0].exitCode);
    assert.equal(result.results[0].modelAttempts[0].exitCode, 143);
    assertDefined(result.results[0].modelAttempts);
    assertDefined(result.results[0].modelAttempts[0].error);
    assertDefined(result.results[0].modelAttempts[0].error);
    assertDefined(result.results[0].modelAttempts);
    assert.match(result.results[0].modelAttempts[0].error, /143/);
    assertDefined(result.results[0].modelAttempts);
    assert.ok(
      result.results[0].modelAttempts.every((attempt) => attempt.model === "driver-fixture/faux-1"),
    );
  });
}

test("native pre-boundary transport failure retains its exit after the retry budget", async () => {
  const { result, pids } = await run("success", { startupExit: { code: 143 } });
  assert.equal(result.success, false);
  assert.equal(pids.length, 2);
  assertDefined(result.results[0].modelAttempts);
  assert.deepEqual(
    result.results[0].modelAttempts.map((attempt) => attempt.exitCode),
    [143, 143],
  );
  assert.equal(result.results[0].exitCode, 143);
  assertDefined(result.results[0].error);
  assert.doesNotMatch(result.results[0].error, /boundary did not return/);
});

test("native pre-boundary transport failure reaches the configured fallback after one retry", async () => {
  const { result, receipt, pids } = await run("success", {
    fallback: true,
    startupExit: { code: 143, model: "faux-1" },
  });
  const child = result.results[0];
  assert.equal(result.success, true, JSON.stringify(child));
  assert.equal(pids.length, 3);
  assert.equal(new Set(pids).size, 3);
  assertDefined(receipt);
  assert.equal(receipt.pid, pids[2]);
  assert.equal(child.model, "driver-fixture/faux-2");
  assert.deepEqual(child.attemptedModels, [
    "driver-fixture/faux-1",
    "driver-fixture/faux-1",
    "driver-fixture/faux-2",
  ]);
  assertDefined(child.modelAttempts);
  assert.deepEqual(
    child.modelAttempts.map((attempt) => attempt.exitCode),
    [143, 143, 0, 0],
  );
  assertDefined(child.acceptance);
  assertDefined(child.acceptance.finalization);
  assert.equal(child.acceptance.finalization.turns.length, 1);
});

test("native pre-boundary ordinary failure preserves diagnostics without a retry", async () => {
  const { result, pids } = await run("success", {
    fallback: true,
    startupExit: { code: 7, stderr: "Fixture startup failed" },
  });
  assert.equal(result.success, false);
  assert.equal(pids.length, 1);
  assert.equal(result.results[0].exitCode, 7);
  assertDefined(result.results[0].error);
  assert.match(result.results[0].error, /Fixture startup failed/);
});

test("native apparent success without a required self-review boundary is rejected", async () => {
  const { result, pids } = await run("success", { fallback: true, startupExit: { code: 0 } });
  assert.equal(result.success, false);
  assert.equal(pids.length, 1);
  assert.equal(result.results[0].exitCode, 1);
  assertDefined(result.results[0].error);
  assert.match(result.results[0].error, /Native self-review boundary did not return a result/);
});

test("native no-staged-files rejection repairs in one process and retains both review outcomes", async () => {
  const { result, receipt, pids, output } = await run("staged-repair", {
    staged: true,
    turns: 2,
    verify:
      'test -z "$PI_SUBAGENT_FINALIZATION_CONFIG" && test -z "$(git diff --cached --name-only)" && echo owner-check',
  });
  const child = result.results[0];
  assert.equal(pids.length, 1, JSON.stringify({ pids, child }));
  assert.equal(result.success, true, JSON.stringify(child));
  assertDefined(receipt);
  assert.equal(receipt.pid, pids[0]);
  assertDefined(receipt);
  assert.equal(receipt.calls, 4);
  assertDefined(receipt);
  assert.equal(receipt.sawStagedFailure, true);
  assert.equal(output, "Repaired answer");
  assert.equal(child.finalOutput, "Repaired answer");
  assertDefined(child.acceptance);
  assertDefined(child.acceptance.finalization);
  assert.deepEqual(
    child.acceptance.finalization.turns.map((turn) => turn.status),
    ["rejected", "checked"],
  );
  assertDefined(child.acceptance);
  assertDefined(child.acceptance.finalization);
  assertDefined(child.acceptance.finalization.turns[0].failureMessage);
  assert.match(
    child.acceptance.finalization.turns[0].failureMessage,
    /Staged files present:.*staged\.txt/,
  );
  assertDefined(child.acceptance);
  assert.equal(
    child.acceptance.runtimeChecks.find((check) => check.id === "no-staged-files")?.status,
    "passed",
  );
  assertDefined(child.acceptance);
  assert.equal(child.acceptance.verifyRuns.length, 1);
  assertDefined(child.acceptance);
  assert.equal(child.acceptance.verifyRuns[0].stdout, "owner-check");
});

test("native no-staged-files rejection exhausts its review cap without another process", async () => {
  const { result, receipt, pids } = await run("success", { staged: true, turns: 2 });
  assert.equal(pids.length, 1);
  assert.equal(result.success, false);
  assertDefined(receipt);
  assert.equal(receipt.calls, 3);
  assertDefined(result.results[0].acceptance);
  assertDefined(result.results[0].acceptance.finalization);
  assert.deepEqual(
    result.results[0].acceptance.finalization.turns.map((turn) => turn.status),
    ["rejected", "rejected"],
  );
  assertDefined(result.results[0].error);
  assert.match(result.results[0].error, /Staged files present:.*staged\.txt/);
});

test("owner rechecks the index after native no-staged-files repair and shutdown", async () => {
  const { result, receipt, pids } = await run("staged-repair-restage", { staged: true, turns: 2 });
  assert.equal(pids.length, 1);
  assertDefined(receipt);
  assert.equal(receipt.calls, 4);
  assert.equal(result.success, false);
  assertDefined(result.results[0].acceptance);
  assertDefined(result.results[0].acceptance.finalization);
  assert.deepEqual(
    result.results[0].acceptance.finalization.turns.map((turn) => turn.status),
    ["rejected", "checked"],
  );
  assertDefined(result.results[0].error);
  assert.match(result.results[0].error, /Staged files present:.*staged\.txt/);
});

for (const scenario of ["success", "public-output", "repair", "passive"] as const) {
  test(`native child performs ${scenario} and mandatory review in one process`, async () => {
    const { result, receipt, output } = await run(scenario, {
      turns: scenario === "repair" ? 2 : 1,
      maxTokens: 30,
    });
    const child = result.results[0];
    assert.equal(result.success, true, JSON.stringify(child));
    assertDefined(receipt);
    assert.equal(receipt.calls, scenario === "repair" ? 3 : 2);
    assertDefined(receipt);
    assertDefined(child.acceptance);
    assertDefined(child.acceptance.finalization);
    assert.equal(child.acceptance.finalization.turns.length, receipt.calls - 1);
    assert.equal(
      output,
      scenario === "public-output" ? '{"items":["reviewed payload"]}' : "Reviewed answer",
    );
    assertDefined(receipt);
    assertDefined(child.modelAttempts);
    assert.equal(child.modelAttempts.length, receipt.calls);
    assertDefined(receipt);
    assert.deepEqual(receipt.sampling[1], { type: "json_schema", strict: "prefer" });
    assertDefined(receipt);
    assertDefined(child.modelAttempts);
    assert.deepEqual(
      child.modelAttempts.map((attempt) => {
        assertDefined(attempt.usage);
        return attempt.usage.input;
      }),
      Array(receipt.calls).fill(11),
    );
    assertDefined(child.modelAttempts);
    const contributions = child.modelAttempts.flatMap((attempt) => {
      assertDefined(attempt.usage);
      assertDefined(attempt.usage.contributions);
      return attempt.usage.contributions;
    });
    assertDefined(receipt);
    assert.equal(new Set(contributions.map((item) => item.id)).size, receipt.calls);
    assert.ok(
      contributions.every(
        (item) =>
          item.provider === "driver-fixture" &&
          item.usage.reasoning === 4 &&
          item.usage.cacheWrite1h === 2,
      ),
    );
    if (scenario === "public-output") {
      assert.deepEqual(child.structuredOutput, { items: ["reviewed payload"] });
      assertDefined(receipt);
      assert.deepEqual(receipt.sampling[0], { type: "json_schema", strict: "prefer" });
    }
  });
}

test("legacy Pi review publishes its current schema-validated payload across process continuation", async () => {
  const { result, pids, output } = await run("public-output", { legacy: true });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(pids.length, 2);
  assert.deepEqual(result.results[0].structuredOutput, { items: ["reviewed payload"] });
  assert.equal(output, '{"items":["reviewed payload"]}');
});

for (const scenario of ["retry", "linger", "resubmit", "missing-then-repair"]) {
  test(`native owner preserves ${scenario} through same-process review`, async () => {
    const { result, receipt } = await run(scenario, {
      turns: scenario === "missing-then-repair" ? 2 : 1,
    });
    const child = result.results[0];
    assert.equal(result.success, true, JSON.stringify(child));
    assertDefined(receipt);
    assertDefined(child.agentProcessExit);
    assert.equal(child.agentProcessExit.pid, receipt.pid);
    assertDefined(child.acceptance);
    assert.equal(child.acceptance.status, "checked");
    assert.equal(child.finalOutput, "Reviewed answer");
    assertDefined(child.acceptance);
    assertDefined(child.acceptance.finalization);
    assert.equal(
      child.acceptance.finalization.turns.length,
      scenario === "missing-then-repair" ? 2 : 1,
    );
    assertDefined(receipt);
    assert.equal(receipt.calls, scenario === "linger" ? 2 : 3);
    assertDefined(receipt);
    assert.equal(receipt.shutdownStarted, true);
    assertDefined(receipt);
    assert.equal(receipt.shutdownFinished, scenario !== "linger");
    if (scenario === "retry") {
      assertDefined(receipt);
      assert.deepEqual(receipt.errors, ["503 overloaded; native fixture"]);
      assertDefined(child.modelAttempts);
      assert.equal(
        child.modelAttempts.length,
        2,
        "native transport retry remains inside the same review attempt",
      );
      assertDefined(child.modelAttempts);
      assertDefined(child.modelAttempts[1].usage);
      assert.equal(child.modelAttempts[1].usage.turns, 2);
    }
    if (scenario === "missing-then-repair") {
      assertDefined(child.acceptance);
      assertDefined(child.acceptance.finalization);
      assert.deepEqual(
        child.acceptance.finalization.turns.map((turn) => turn.status),
        ["rejected", "checked"],
      );
    }
  });
}

test("native post-submission provider failure remains authoritative", async () => {
  const { result, receipt } = await run("final-error");
  assert.equal(result.success, false);
  assertDefined(receipt);
  assert.equal(receipt.calls, 3);
  assertDefined(result.results[0].error);
  assert.match(result.results[0].error, /Fixture final provider failure/);
  assertDefined(result.results[0].acceptance);
  assertDefined(result.results[0].acceptance.childReport);
  assert.equal(result.results[0].acceptance.childReport, undefined);
  assertDefined(result.results[0].acceptance);
  assertDefined(result.results[0].acceptance.unconfirmedOutput);
  assertDefined(result.results[0].acceptance.unconfirmedOutput);
  assertDefined(result.results[0].acceptance);
  assert.match(result.results[0].acceptance.unconfirmedOutput, /Reviewed answer/);
});

test("per-attempt time allowance resets between initial work and review in one native process", async () => {
  // Two 4.5s attempts exceed 8s together, while each leaves room for cold native startup.
  const { result, receipt } = await run("per-attempt-time", { maxExecutionTimeMs: 8000 });
  assert.equal(result.success, true, JSON.stringify(result));
  assertDefined(receipt);
  assert.equal(receipt.calls, 2);
  assertDefined(receipt);
  assertDefined(result.results[0].agentProcessExit);
  assertDefined(result.results[0].agentProcessExit.pid);
  assert.equal(result.results[0].agentProcessExit.pid, receipt.pid);
  assertDefined(result.results[0].progressSummary);
  assert.ok(result.results[0].progressSummary.durationMs > 8000);
  assert.equal(result.results[0].resourceLimitExceeded, undefined);
});

test("nested tool usage is accounted without tightening the assistant-only token limit", async (t) => {
  const mock = createMockPi();
  mock.install();
  t.after(() => mock.uninstall());
  mock.onCall({
    jsonl: [
      {
        type: "message_end",
        message: {
          role: "toolResult",
          toolName: "nested",
          toolCallId: "nested-call",
          isError: false,
          content: [{ type: "text", text: "Nested work finished" }],
          usage: {
            input: 1000,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 1000,
            cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
          },
        },
      },
      events.assistantMessage("Finished"),
    ],
  });
  const result = await runChildAttempt({
    args: ["--mode", "json", "-p", "Task: nested fixture"],
    cwd: repo,
    agent: "fixture",
    maxTokens: 200,
  });
  assert.equal(result.exitCode, 0, result.error);
  assert.equal(result.resourceLimitExceeded, undefined);
  assert.equal(result.usage.input, 1100);
  assert.equal(result.usage.output, 50);
  assert.equal(result.usage.contributions?.length, 2);
});

test("a missing child message fails closed and retains its wire audit instead of reusing the prior observation", async (t) => {
  const root = createTempDir("child-invalid-message-"),
    mock = createMockPi();
  t.after(() => removeTempDir(root));
  mock.install();
  t.after(() => mock.uninstall());
  mock.onCall({ jsonl: [events.assistantMessage("Observed answer"), { type: "message_end" }] });
  const result = await runChildAttempt({
    args: ["--mode", "json", "-p", "Task: invalid event"],
    cwd: repo,
    agent: "fixture",
    auditPath: path.join(root, "observations.log"),
  });
  assert.equal(result.terminalFailure, true);
  assert.equal(result.exitCode, 1);
  assertDefined(result.error);
  assert.match(result.error, /missing its message/);
  assert.equal(result.auditRecords?.[0].kind, "receiver_failure");
  const defined19290_0 = result.auditPath;
  assertDefined(defined19290_0);
  assert.match(fs.readFileSync(defined19290_0, "utf8"), /"type":"message_end"}/);
});

test("native message references and finalization scans scale with new messages rather than baseline and prior observations", async (t) => {
  const root = createTempDir("child-reference-index-"),
    bin = path.join(root, "bin");
  t.after(() => removeTempDir(root));
  fs.mkdirSync(bin);
  const script = path.join(root, "child.mjs");
  const finalization = createNativeFinalization(
    resolveEffectiveAcceptance({
      explicit: { criteria: [{ id: "deliver", must: "Deliver fixture" }] },
    }),
  );
  t.after(() => removeTempDir(path.dirname(finalization.reportRuntime.schemaPath)));
  fs.writeFileSync(path.join(bin, "pi"), `#!/bin/sh\nexec '${process.execPath}' '${script}'\n`, {
    mode: 0o755,
  });
  const message = (timestamp: number) => ({
    ...(events.assistantMessage("Finished") as { message: object }).message,
    timestamp,
  });
  fs.writeFileSync(
    script,
    `import fs from 'node:fs';
		process.stdout.write(JSON.stringify({type:'message_end',message:{role:'custom',customType:'fixture',content:'Context only',timestamp:0}})+'\\n');
		for(let index=0;index<1000;index++) {
			const message={...${JSON.stringify(message(0))},timestamp:10000+index};
			const entry={id:'new-'+index,type:'message',parentId:index?'new-'+(index-1):null,message};
			fs.appendFileSync(process.env.JOURNAL,JSON.stringify(entry)+'\\n');
			process.stdout.write(JSON.stringify({type:'message_end',message})+'\\n');
			process.stdout.write(JSON.stringify({type:'subagent.native',sessionId:'fixture',leafId:entry.id,persisted:true,configuration:{model:'mock/test-model'},entries:[entry]})+'\\n');
		}
		fs.appendFileSync(process.env.BOUNDARIES,JSON.stringify({type:'subagent.finalization',nonce:${JSON.stringify(finalization.nonce)},turn:0,lastEntryId:'new-999',
			messageCount:1000,at:Date.now(),submission:{output:'Finished'},resolvedOutput:{fullOutput:'Finished'}})+'\\n');`,
  );
  for (const baselineCount of [0, 4000]) {
    const file = path.join(root, "session.jsonl");
    fs.writeFileSync(
      file,
      JSON.stringify({ type: "session", version: 3, id: "fixture" }) +
        "\n" +
        Array.from(
          { length: baselineCount },
          (_, index) =>
            JSON.stringify({
              type: "message",
              id: `old-${index}`,
              parentId: null,
              message: message(index),
            }) + "\n",
        ).join(""),
    );
    const boundaries = path.join(
      path.dirname(finalization.reportRuntime.schemaPath),
      "boundaries.jsonl",
    );
    fs.rmSync(boundaries, { force: true });
    let comparisons = 0,
      filtered = 0;
    const prototype: Pick<unknown[], "find" | "filter"> = Array.prototype;
    const find = prototype.find;
    const findMock = t.mock.method(
      prototype,
      "find",
      function (
        this: readonly unknown[],
        predicate: (value: unknown, index: number, array: readonly unknown[]) => unknown,
        thisArg?: unknown,
      ) {
        const observation = this[0];
        const matching =
          isRecord(observation) &&
          typeof observation.start === "number" &&
          observation.kind === "message_end";
        const result: unknown = Reflect.apply(find, this, [
          (item: unknown, index: number, array: readonly unknown[]) => {
            if (matching) {
              comparisons++;
            }
            return predicate.call(thisArg, item, index, array);
          },
        ]);
        return result;
      },
    );
    const filter = prototype.filter;
    const filterMock = t.mock.method(
      prototype,
      "filter",
      function (
        this: readonly unknown[],
        predicate: (value: unknown, index: number, array: readonly unknown[]) => unknown,
        thisArg?: unknown,
      ) {
        const messages = this[0];
        const result: unknown = Reflect.apply(filter, this, [
          (item: unknown, index: number, array: readonly unknown[]) => {
            if (isRecord(messages) && typeof messages.role === "string") {
              filtered++;
            }
            return predicate.call(thisArg, item, index, array);
          },
        ]);
        return result;
      },
    );
    let result: Awaited<ReturnType<typeof runChildAttempt>>;
    try {
      // Each scenario owns shared fixture state; complete it before starting the next one.
      // oxlint-disable-next-line no-await-in-loop
      result = await runChildAttempt({
        args: [],
        cwd: root,
        env: {
          PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          JOURNAL: file,
          BOUNDARIES: boundaries,
        },
        agent: "fixture",
        sessionFile: file,
        nativeFinalization: finalization,
        auditPath: path.join(root, "audit"),
      });
    } finally {
      findMock.mock.restore();
      filterMock.mock.restore();
    }
    assert.equal(result.exitCode, 0, result.error);
    assert.equal(result.accounting?.state, "complete", result.accounting?.error);
    assert.equal(result.usage.input, 100_000);
    assert.equal(result.usage.turns, 1000);
    assert.deepEqual(
      result.auditRecords?.map(({ kind }) => kind),
      ["message_end"],
      "the custom context observation remains audited",
    );
    assert.equal(result.finalization?.length, 1);
    assert.ok(Boolean(result.finalization[0]));
    assert.equal(
      result.finalization[0].messages.length,
      1000,
      "custom messages are excluded from native boundary message counts",
    );
    assert.equal(result.messageCount, 1000);
    assert.deepEqual(
      result.nativeReferences,
      Array.from({ length: 1000 }, (_, index) => ({
        messageNumber: index + 1,
        entryId: `new-${index}`,
      })),
    );
    t.diagnostic(
      `${baselineCount} inherited + 1000 new messages: ${comparisons} matching comparisons, ${filtered} message-filter visits`,
    );
    assert.ok(
      comparisons < 4000,
      `matching must not revisit baseline/prior observations: ${comparisons} comparisons with ${baselineCount} inherited entries`,
    );
    assert.ok(
      filtered < 6000,
      `pending finalization scans must not filter history on every event: ${filtered} predicate visits`,
    );
  }
});

test("native fallback never assigns baseline IDs to new messages with identical identities", async (t) => {
  const root = createTempDir("child-reference-baseline-"),
    bin = path.join(root, "bin");
  t.after(() => removeTempDir(root));
  fs.mkdirSync(bin);
  const script = path.join(root, "child.mjs"),
    file = path.join(root, "session.jsonl");
  fs.writeFileSync(path.join(bin, "pi"), `#!/bin/sh\nexec '${process.execPath}' '${script}'\n`, {
    mode: 0o755,
  });
  const message = {
    ...(events.assistantMessage("Finished") as { message: object }).message,
    timestamp: 7,
  };
  fs.writeFileSync(
    file,
    JSON.stringify({ type: "session", version: 3, id: "fixture" }) +
      "\n" +
      JSON.stringify({ type: "message", id: "baseline", parentId: null, message }) +
      "\n",
  );
  fs.writeFileSync(
    script,
    `import fs from 'node:fs';const message=${JSON.stringify(message)};
		for(const id of ['first','second']) { fs.appendFileSync(process.env.JOURNAL,JSON.stringify({type:'message',id,parentId:null,message})+'\\n');
			process.stdout.write(JSON.stringify({type:'message_end',message})+'\\n'); }`,
  );
  const result = await runChildAttempt({
    args: [],
    cwd: root,
    env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, JOURNAL: file },
    agent: "fixture",
    sessionFile: file,
    auditPath: path.join(root, "audit"),
  });
  assert.equal(result.accounting?.state, "complete", result.accounting?.error);
  assert.equal(result.usage.turns, 2);
  assert.equal(result.usage.input, 200);
  assert.deepEqual(result.nativeReferences, [
    { messageNumber: 1, entryId: "first" },
    { messageNumber: 2, entryId: "second" },
  ]);
  assert.equal(result.auditPath, undefined);
});

test("owner allocates a native session when acceptance has no preassigned file", async () => {
  const { result, receipt } = await run("success", { omitSessionFile: true });
  assert.equal(result.success, true, JSON.stringify(result));
  assertDefined(receipt);
  assert.equal(receipt.calls, 2);
  assertDefined(result.results[0].sessionFile);
  assert.match(result.results[0].sessionFile, /session-0\.jsonl$/);
});

test("native child stops at explicit blocked initial report without review or verification", async () => {
  const { result, receipt, pids } = await run("blocked", { verify: "exit 7", turns: 3 });
  assert.equal(result.state, "blocked");
  assert.equal(pids.length, 1);
  assertDefined(receipt);
  assert.equal(receipt.calls, 1);
  assertDefined(result.results[0].acceptance);
  assert.deepEqual(result.results[0].acceptance.verifyRuns, []);
});

test("native child rejects missing current report at the configured cap", async () => {
  const { result, receipt } = await run("stale");
  assert.equal(result.success, false);
  assertDefined(result.results[0].acceptance);
  assertDefined(result.results[0].acceptance.finalization);
  assert.equal(result.results[0].acceptance.finalization.turns.length, 1);
  assertDefined(result.results[0].acceptance);
  assertDefined(result.results[0].acceptance.childReportParseError);
  assertDefined(result.results[0].acceptance.childReportParseError);
  assertDefined(result.results[0].acceptance);
  assert.match(
    result.results[0].acceptance.childReportParseError,
    /No current finalization report/,
  );
  assertDefined(receipt);
  assert.equal(receipt.calls, 2);
});

test("native review rejects an older valid report after later assistant activity", async () => {
  const { result, receipt } = await run("stale-after-report");
  assert.equal(result.success, false);
  assertDefined(result.results[0].acceptance);
  assertDefined(result.results[0].acceptance.finalization);
  assert.equal(result.results[0].acceptance.finalization.turns.length, 1);
  assertDefined(result.results[0].acceptance);
  assertDefined(result.results[0].acceptance.childReport);
  assert.equal(result.results[0].acceptance.childReport, undefined);
  assertDefined(result.results[0].acceptance);
  assertDefined(result.results[0].acceptance.unconfirmedOutput);
  assertDefined(result.results[0].acceptance.unconfirmedOutput);
  assertDefined(result.results[0].acceptance);
  assert.match(result.results[0].acceptance.unconfirmedOutput, /Reviewed answer/);
  assertDefined(receipt);
  assert.equal(receipt.calls, 3, "queued work stays inside one review attempt");
});

test("owner verification failure and process failure override a valid native report", async () => {
  const verified = await run("success", { verify: "exit 7" });
  assert.equal(verified.result.success, false);
  assertDefined(verified.result.results[0].acceptance);
  assertDefined(verified.result.results[0].acceptance.verifyRuns[0].exitCode);
  assert.equal(verified.result.results[0].acceptance.verifyRuns[0].exitCode, 7);
  const exited = await run("process-error");
  assert.equal(exited.result.success, false);
  assertDefined(exited.result.results[0].agentProcessExit);
  assertDefined(exited.result.results[0].agentProcessExit.code);
  assert.equal(exited.result.results[0].agentProcessExit.code, 7);
});

test("owner deadline stops native verification and publishes timeout", async () => {
  const { result, status } = await run("success", { timeoutMs: 3000, verify: "sleep 10" });
  assert.equal(result.success, false);
  assert.equal(result.exitCode, 124);
  assert.equal(result.timedOut, true);
  assert.equal(status.timedOut, true);
  assert.equal(result.results[0].exitCode, 124);
});

test("durable extend control moves the owner's deadline", async () => {
  const { result, status, receipt } = await run("slow", { timeoutMs: 2500, extendMs: 4000 });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(status.timedOut, undefined);
  assertDefined(receipt);
  assert.equal(receipt.calls, 2);
  assertDefined(status.timeoutAt);
  assert.ok(status.timeoutAt - status.startedAt >= 6500);
});
