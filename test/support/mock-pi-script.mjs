import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const queueDir = process.env.MOCK_PI_QUEUE_DIR;

function fail(message, exitCode = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(exitCode);
}

async function waitForFile(file) {
  if (!file) {
    return;
  }
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) {
      fail("Timed out waiting for mock response release.");
    }
    // Poll the parent's release/call publication between event-loop turns.
    // oxlint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function listPendingFiles(dir) {
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith("pending-") && name.endsWith(".json"))
    .sort();
}

function expandedArg(arg) {
  if (!arg.startsWith("@")) {
    return arg;
  }
  try {
    return `${arg}\n${fs.readFileSync(arg.slice(1), "utf-8")}`;
  } catch (err) {
    // Real pi exits 1 on an unreadable @file; mirror it so tests can't pass on missing fixtures.
    console.error(`mock-pi: cannot read ${arg}: ${err.message}`);
    process.exit(1);
  }
}

function responseMatchesArgs(response, args) {
  const match = response?.matchArgsIncludes;
  if (match === undefined) {
    return true;
  }
  const needles = Array.isArray(match) ? match : [match];
  const haystack = args.map(expandedArg).join("\n");
  return needles.every((needle) => typeof needle === "string" && haystack.includes(needle));
}

function isQueueRace(error, codes) {
  return error && typeof error === "object" && "code" in error && codes.includes(error.code);
}

function claimNextResponse(dir, args) {
  for (const fileName of listPendingFiles(dir)) {
    const sourcePath = path.join(dir, fileName);
    let response;
    try {
      response = JSON.parse(fs.readFileSync(sourcePath, "utf-8"));
    } catch (error) {
      if (isQueueRace(error, ["ENOENT"])) {
        continue;
      }
      throw error;
    }
    if (!responseMatchesArgs(response, args)) {
      continue;
    }
    const targetPath = path.join(dir, fileName.replace(/^pending-/, "consumed-"));
    try {
      fs.renameSync(sourcePath, targetPath);
      return response;
    } catch (error) {
      if (isQueueRace(error, ["ENOENT", "EEXIST"])) {
        continue;
      }
      throw error;
    }
  }

  const defaultPath = path.join(dir, "default-response.json");
  if (!fs.existsSync(defaultPath)) {
    return;
  }
  const fallback = JSON.parse(fs.readFileSync(defaultPath, "utf-8"));
  return responseMatchesArgs(fallback, args) ? fallback : undefined;
}

function defaultAssistantMessage(output) {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: output }],
      provider: "mock",
      model: "test-model",
      stopReason: "stop",
      usage: {
        input: 100,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 150,
        cost: { input: 0.001, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
      },
    },
  };
}

function taskRequestsAcceptance(args) {
  return args.some((arg) => expandedArg(arg).includes("## Acceptance Contract"));
}

function defaultAcceptanceReport() {
  return [
    "```acceptance-report",
    JSON.stringify({
      criteriaSatisfied: [
        { id: "criterion-1", status: "satisfied", evidence: "mock acceptance evidence" },
        { id: "criterion-2", status: "satisfied", evidence: "mock acceptance evidence" },
      ],
      changedFiles: ["mock-file.ts"],
      testsAddedOrUpdated: ["mock-file.test.ts"],
      commandsRun: [{ command: "mock validation", result: "passed", summary: "passed" }],
      validationOutput: ["mock validation passed"],
      residualRisks: [],
      noStagedFiles: true,
      reviewFindings: [],
      manualNotes: "mock run completed",
      notes: "mock run completed",
    }),
    "```",
  ].join("\n");
}

function withAcceptanceReport(output, args) {
  if (!taskRequestsAcceptance(args) || output.includes("```acceptance-report")) {
    return output;
  }
  return `${output}\n${defaultAcceptanceReport()}`;
}

function defaultResponse() {
  return { output: "ok", exitCode: 0 };
}

function isJsonMode(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--mode") {
      return args[i + 1] === "json";
    }
  }
  return false;
}

function writeSessionFile(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--session") {
      continue;
    }
    const sessionFile = args[i + 1];
    if (!sessionFile) {
      return;
    }
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "", { flag: "a" });
    return;
  }
}

async function writeStdout(text) {
  if (process.stdout.write(text)) {
    return;
  }
  await new Promise((resolve) => process.stdout.once("drain", resolve));
}

async function writeJsonlLine(entry) {
  const line = typeof entry === "string" ? entry : JSON.stringify(entry);
  await writeStdout(`${line}\n`);
}

function extractPlainText(entry) {
  if (!entry || typeof entry !== "object") {
    return "";
  }
  if (entry.type === "message_end") {
    const text = entry.message?.content?.find?.((part) => part?.type === "text")?.text;
    return typeof text === "string" ? text : "";
  }
  return "";
}

async function writeResponseEntries(entries, jsonMode, args) {
  const reportFinalization =
    process.env.PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE &&
    args.some((arg) => expandedArg(arg).includes("## Acceptance Finalization"));
  let sawProviderError = false;
  for (const entry of entries) {
    sawProviderError = prepareAcceptanceEntry(entry, args, sawProviderError);
    // Emit each JSONL record in order, including any structured-output tool-result records.
    // oxlint-disable-next-line no-await-in-loop
    if (await writeFinalizationEntry(entry, jsonMode && reportFinalization)) {
      continue;
    }
    if (jsonMode) {
      // Wire order and stdout backpressure are part of the mock transport contract.
      // oxlint-disable-next-line no-await-in-loop
      await writeJsonlLine(entry);
      continue;
    }
    const text = extractPlainText(entry);
    if (text) {
      // Preserve assistant text order and wait for stdout drain before the next record.
      // oxlint-disable-next-line no-await-in-loop
      await writeStdout(`${text}\n`);
    }
  }
}

function prepareAcceptanceEntry(entry, args, sawProviderError) {
  if (entry?.type !== "message_end") {
    return sawProviderError;
  }
  const textPart = entry.message?.content?.find?.((part) => part?.type === "text");
  const isProviderError = Boolean(
    entry.message?.errorMessage || entry.message?.stopReason === "error",
  );
  const providerFailed = sawProviderError || isProviderError;
  if (
    !isProviderError &&
    textPart &&
    typeof textPart.text === "string" &&
    (!providerFailed || textPart.text.trim())
  ) {
    textPart.text = withAcceptanceReport(textPart.text, args);
  }
  return providerFailed;
}

async function writeFinalizationEntry(entry, enabled) {
  if (
    !enabled ||
    entry?.message?.role !== "assistant" ||
    entry.message.stopReason !== "stop" ||
    entry.message.errorMessage
  ) {
    return false;
  }
  const report = extractPlainText(entry);
  if (!report.trim()) {
    return false;
  }
  const toolCallId = `mock-report-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const block = report.match(/```acceptance-report\s*\n([\s\S]*?)```/i);
  let typedReport;
  try {
    typedReport = JSON.parse(block?.[1] ?? "");
  } catch {
    typedReport = {};
  }
  const value = {
    answer: report.replace(/\n?```acceptance-report\s*\n[\s\S]*?```\s*$/i, "").trimEnd(),
    report: typedReport,
  };
  await writeJsonlLine({
    ...entry,
    message: {
      ...entry.message,
      stopReason: "toolUse",
      content: [
        { type: "toolCall", id: toolCallId, name: "structured_output", arguments: { value } },
      ],
    },
  });
  await maybeWriteStructuredOutput({ structuredOutput: value }, true, toolCallId);
  return true;
}

async function maybeWriteStructuredOutput(response, jsonMode, toolCallId = randomUUID()) {
  if (!Object.prototype.hasOwnProperty.call(response, "structuredOutput")) {
    return;
  }
  const outputPath = process.env.PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE;
  if (!outputPath) {
    return;
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(response.structuredOutput), "utf-8");
  if (!jsonMode) {
    return;
  }
  await writeJsonlLine({
    type: "tool_execution_start",
    toolName: "structured_output",
    toolCallId,
    args: { value: response.structuredOutput },
  });
  await writeJsonlLine({
    type: "message_end",
    message: {
      role: "toolResult",
      toolName: "structured_output",
      toolCallId,
      isError: false,
      content: [{ type: "text", text: "Structured output captured." }],
    },
  });
  await writeJsonlLine({
    type: "tool_execution_end",
    toolName: "structured_output",
    toolCallId,
    isError: false,
  });
}

async function main() {
  if (!queueDir) {
    fail("MOCK_PI_QUEUE_DIR is required.");
  }
  if (!fs.existsSync(queueDir)) {
    fail(`Mock queue dir does not exist: ${queueDir}`);
  }

  const args = process.argv.slice(2);
  const jsonMode = isJsonMode(args);
  const response = claimNextResponse(queueDir, args) ?? defaultResponse();
  writeSessionFile(args);
  recordCall(args, response);
  await waitForCalls(response.waitForCalls);
  await waitForFile(response.waitForFile);
  await prepareResponse(response);
  await emitResponse(response, jsonMode, args);
  await maybeWriteStructuredOutput(response, jsonMode);
  if (jsonMode && !response.nativeReport) {
    await writeJsonlLine({ type: "agent_settled" });
  }
  await finishResponse(response);
}

function recordCall(args, response) {
  const callRecord = {
    args,
    expandedArgs: args.map(expandedArg),
    cwd: process.cwd(),
    sessionCwd: process.env.PI_SUBAGENT_SESSION_CWD
      ? JSON.parse(process.env.PI_SUBAGENT_SESSION_CWD)
      : undefined,
  };
  if (Array.isArray(response.echoEnv) && response.echoEnv.length > 0) {
    callRecord.env = Object.fromEntries(
      response.echoEnv.map((key) => [key, process.env[key] ?? null]),
    );
  }
  const callPath = path.join(
    queueDir,
    `call-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}.json`,
  );
  const tempCallPath = path.join(queueDir, `.tmp-${path.basename(callPath)}`);
  fs.writeFileSync(tempCallPath, JSON.stringify(callRecord), "utf-8");
  fs.renameSync(tempCallPath, callPath);
}

async function waitForCalls(count) {
  if (count) {
    const deadline = Date.now() + 5000;
    while (fs.readdirSync(queueDir).filter((name) => name.startsWith("call-")).length < count) {
      if (Date.now() >= deadline) {
        fail("Timed out waiting for sibling mock calls.");
      }
      // Poll the parent's release/call publication between event-loop turns.
      // oxlint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

async function prepareResponse(response) {
  if (response.ignoreSignals === true) {
    const ignoreSignal = () => {
      // Simulate a resistant child; the owning process-tree timeout must escalate to SIGKILL.
    };
    process.on("SIGINT", ignoreSignal);
    process.on("SIGTERM", ignoreSignal);
  }
  if (typeof response.delay === "number" && response.delay > 0) {
    await new Promise((resolve) => setTimeout(resolve, response.delay));
  }
}

async function emitSteps(steps, jsonMode, args) {
  for (const step of steps) {
    // Steps are an ordered stream script: release/delay precedes that step's wire records.
    // oxlint-disable-next-line no-await-in-loop
    await waitForFile(step.waitForFile);
    if (typeof step?.delay === "number" && step.delay > 0) {
      // Preserve configured wire timing, not concurrent step scheduling.
      // oxlint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, step.delay));
    }
    if (Array.isArray(step?.jsonl) && step.jsonl.length > 0) {
      // Emit one step fully, including backpressure, before starting the next.
      // oxlint-disable-next-line no-await-in-loop
      await writeResponseEntries(step.jsonl, jsonMode, args);
    }
    if (typeof step?.stderr === "string" && step.stderr.length > 0) {
      process.stderr.write(step.stderr);
    }
  }
}

async function emitResponse(response, jsonMode, args) {
  if (response.nativeReport) {
    const { runNativeReport } = await import("../fixtures/native-acceptance-report.mjs");
    await runNativeReport(args, response.nativeReport);
  } else if (Array.isArray(response.steps) && response.steps.length > 0) {
    await emitSteps(response.steps, jsonMode, args);
  } else if (Array.isArray(response.jsonl) && response.jsonl.length > 0) {
    await writeResponseEntries(response.jsonl, jsonMode, args);
  } else if (Array.isArray(response.echoEnv) && response.echoEnv.length > 0) {
    const envSnapshot = Object.fromEntries(
      response.echoEnv.map((key) => [key, process.env[key] ?? null]),
    );
    const output = withAcceptanceReport(JSON.stringify(envSnapshot), args);
    if (jsonMode) {
      await writeResponseEntries([defaultAssistantMessage(output)], true, args);
    } else {
      await writeStdout(`${output}\n`);
    }
  } else if (typeof response.output === "string") {
    const output = withAcceptanceReport(response.output, args);
    if (jsonMode) {
      await writeResponseEntries([defaultAssistantMessage(output)], true, args);
    } else {
      await writeStdout(`${output}\n`);
    }
  }
}

async function finishResponse(response) {
  if (typeof response.stderr === "string" && response.stderr.length > 0) {
    process.stderr.write(response.stderr);
  }

  if (typeof response.spawnSignalResistantDescendantPidFile === "string") {
    const descendant = spawn(
      process.execPath,
      [
        "-e",
        `const ignoreSignal = () => { /* Resist termination so the owner must escalate. */ };
process.on('SIGINT', ignoreSignal); process.on('SIGTERM', ignoreSignal);
setInterval(() => { /* Keep this controlled descendant alive until reaped. */ }, 1000);`,
      ],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    fs.writeFileSync(
      response.spawnSignalResistantDescendantPidFile,
      String(descendant.pid),
      "utf-8",
    );
  }

  if (
    typeof response.keepAliveAfterFinalMessageMs === "number" &&
    response.keepAliveAfterFinalMessageMs > 0
  ) {
    await new Promise((resolve) => setTimeout(resolve, response.keepAliveAfterFinalMessageMs));
  }

  await new Promise((resolve, reject) => {
    process.stdout.write("", (error) => (error ? reject(error) : resolve()));
  });
  process.exit(typeof response.exitCode === "number" ? response.exitCode : 0);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
