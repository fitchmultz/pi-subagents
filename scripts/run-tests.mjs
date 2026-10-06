#!/usr/bin/env node
import { run } from "./compat-process.mjs";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_TIMEOUT_MS = { unit: 300_000, integration: 900_000 };

function usage() {
  console.log(
    `Usage: node scripts/run-tests.mjs [unit|integration|all] [--timeout-ms <ms>]\n\nRuns the local TypeScript test suites through Node's test runner.\n\nModes:\n  unit         Run test/unit/*.test.ts\n  integration  Run test/integration/*.test.ts\n  all          Run unit, then integration\n\nOptions:\n  --timeout-ms <ms>  Per-suite watchdog timeout in milliseconds\n  -h, --help         Show this help\n\nEnvironment:\n  PI_TEST_TIMEOUT_MS  Per-suite timeout when --timeout-ms is omitted (default: unit 300000, integration 900000)\n\nExit codes:\n  0  selected suite(s) passed\n  1  tests failed, timed out, or could not start\n  2  invalid arguments`,
  );
}

function parsePositiveInteger(value, source) {
  if (!/^\d+$/.test(value)) {
    console.error(`${source} must be a positive integer number of milliseconds, got: ${value}`);
    process.exit(2);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    console.error(
      `${source} must be a positive safe integer number of milliseconds, got: ${value}`,
    );
    process.exit(2);
  }
  return parsed;
}

function parseArgs(argv) {
  let mode = "unit";
  let timeoutMs = process.env.PI_TEST_TIMEOUT_MS
    ? parsePositiveInteger(process.env.PI_TEST_TIMEOUT_MS, "PI_TEST_TIMEOUT_MS")
    : undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--timeout-ms") {
      const value = argv[index + 1];
      if (!value) {
        console.error("--timeout-ms requires a value");
        process.exit(2);
      }
      timeoutMs = parsePositiveInteger(value, "--timeout-ms");
      index += 1;
      continue;
    }
    if (arg.startsWith("--timeout-ms=")) {
      timeoutMs = parsePositiveInteger(arg.slice("--timeout-ms=".length), "--timeout-ms");
      continue;
    }
    if (arg.startsWith("-")) {
      console.error(`Unknown option: ${arg}`);
      process.exit(2);
    }
    mode = arg;
  }

  if (!["unit", "integration", "all"].includes(mode)) {
    console.error(`Unknown mode: ${mode}`);
    usage();
    process.exit(2);
  }

  return { mode, timeoutMs };
}

function testFiles(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".test.ts"))
    .sort()
    .map((name) => join(dir, name));
}

function sanitizedEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("PI_SUBAGENT_")) {
      delete env[key];
    }
  }
  // Harness startup instrumentation changes child stderr, hiding otherwise-empty transport failures.
  // Tests must observe the selected host's normal diagnostics, not the outer Pi's debug mode.
  delete env.PI_TIMING;
  return env;
}

async function runNodeTest(label, files, timeoutMs, concurrency) {
  const args = [...(concurrency ? [`--test-concurrency=${concurrency}`] : []), "--test", ...files];
  const startedAt = Date.now();
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-subagents-test-"));
  const env = sanitizedEnv();
  env.PI_SUBAGENT_TEMP_ROOT = tempRoot;
  env.HOME = tempRoot;
  delete env.PI_CODING_AGENT_DIR;
  let failure;
  try {
    await run(process.execPath, args, {
      stdio: "inherit",
      env,
      timeout: timeoutMs,
    });
  } catch (error) {
    failure = error;
  } finally {
    // The command owner observes quiescence before its promise settles.
    try {
      if (failure?.cleanupFailed !== true) {
        rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } else {
        console.error(`Retained test root until owned processes quiesce: ${tempRoot}`);
      }
    } catch (error) {
      console.error(`Could not remove ${tempRoot}: ${error.message}`);
      failure ??= error;
    }
  }
  const elapsedMs = Date.now() - startedAt;
  if (failure) {
    if (failure.code === "ETIMEDOUT") {
      console.error(`${label} timed out after ${timeoutMs}ms (elapsed ${elapsedMs}ms).`);
      console.error(`Command: ${process.execPath} ${args.join(" ")}`);
      console.error(
        "Set PI_TEST_TIMEOUT_MS or pass --timeout-ms <ms> to adjust the local watchdog.",
      );
      return 1;
    }
    console.error(`${label} failed: ${failure.message}`);
    return failure.status ?? 1;
  }
  return 0;
}

const { mode, timeoutMs } = parseArgs(process.argv.slice(2));
const unit = () =>
  runNodeTest("unit tests", testFiles("test/unit"), timeoutMs ?? DEFAULT_TIMEOUT_MS.unit);
const integration = () =>
  runNodeTest(
    "integration tests",
    testFiles("test/integration"),
    timeoutMs ?? DEFAULT_TIMEOUT_MS.integration,
    Math.min(4, Math.max(1, availableParallelism() - 1)),
  );

let status;
switch (mode) {
  case "unit":
    status = await unit();
    break;
  case "integration":
    status = await integration();
    break;
  case "all":
    status = await unit();
    if (status === 0) {
      status = await integration();
    }
    break;
}

process.exit(status);
