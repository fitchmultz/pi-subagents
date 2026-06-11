#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_TIMEOUT_MS = 300_000;

function usage() {
  console.log(`Usage: node scripts/run-tests.mjs [unit|integration|all] [--timeout-ms <ms>]\n\nRuns the local TypeScript test suites through Node's test runner.\n\nModes:\n  unit         Run test/unit/*.test.ts\n  integration  Run test/integration/*.test.ts\n  all          Run unit, then integration\n\nOptions:\n  --timeout-ms <ms>  Per-suite watchdog timeout in milliseconds\n  -h, --help         Show this help\n\nEnvironment:\n  PI_TEST_TIMEOUT_MS  Default per-suite timeout when --timeout-ms is omitted\n\nExit codes:\n  0  selected suite(s) passed\n  1  tests failed, timed out, or could not start\n  2  invalid arguments`);
}

function parsePositiveInteger(value, source) {
  if (!/^\d+$/.test(value)) {
    console.error(`${source} must be a positive integer number of milliseconds, got: ${value}`);
    process.exit(2);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    console.error(`${source} must be a positive safe integer number of milliseconds, got: ${value}`);
    process.exit(2);
  }
  return parsed;
}

function parseArgs(argv) {
  let mode = "unit";
  let timeoutMs = process.env.PI_TEST_TIMEOUT_MS
    ? parsePositiveInteger(process.env.PI_TEST_TIMEOUT_MS, "PI_TEST_TIMEOUT_MS")
    : DEFAULT_TIMEOUT_MS;

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
    if (key.startsWith("PI_SUBAGENT_")) delete env[key];
  }
  return env;
}

function runNodeTest(label, imports, files, timeoutMs) {
  const args = [
    ...imports.flatMap((specifier) => ["--import", specifier]),
    "--test",
    ...files,
  ];
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, args, {
    stdio: "inherit",
    env: sanitizedEnv(),
    timeout: timeoutMs,
    killSignal: "SIGTERM",
  });
  const elapsedMs = Date.now() - startedAt;
  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      console.error(`${label} timed out after ${timeoutMs}ms (elapsed ${elapsedMs}ms).`);
      console.error(`Command: ${process.execPath} ${args.join(" ")}`);
      console.error("Set PI_TEST_TIMEOUT_MS or pass --timeout-ms <ms> to adjust the local watchdog.");
      return 1;
    }
    console.error(`Failed to start ${label}: ${result.error.message}`);
    return 1;
  }
  if (result.signal) {
    console.error(`${label} exited due to signal ${result.signal} after ${elapsedMs}ms.`);
    console.error(`Command: ${process.execPath} ${args.join(" ")}`);
    return 1;
  }
  return result.status ?? 1;
}

const { mode, timeoutMs } = parseArgs(process.argv.slice(2));
const unit = () => runNodeTest("unit tests", ["jiti/register"], testFiles("test/unit"), timeoutMs);
const integration = () => runNodeTest(
  "integration tests",
  ["jiti/register", "./test/support/register-loader.mjs"],
  testFiles("test/integration"),
  timeoutMs,
);

let status;
switch (mode) {
  case "unit":
    status = unit();
    break;
  case "integration":
    status = integration();
    break;
  case "all":
    status = unit();
    if (status === 0) status = integration();
    break;
}

process.exit(status);
