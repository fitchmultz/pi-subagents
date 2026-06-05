#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

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

function runNodeTest(label, imports, files) {
  const args = [
    ...imports.flatMap((specifier) => ["--import", specifier]),
    "--test",
    ...files,
  ];
  const result = spawnSync(process.execPath, args, {
    stdio: "inherit",
    env: sanitizedEnv(),
  });
  if (result.error) {
    console.error(`Failed to start ${label}: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

const mode = process.argv[2] ?? "unit";
const unit = () => runNodeTest("unit tests", ["jiti/register"], testFiles("test/unit"));
const integration = () => runNodeTest(
  "integration tests",
  ["jiti/register", "./test/support/register-loader.mjs"],
  testFiles("test/integration"),
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
  default:
    console.error("Usage: node scripts/run-tests.mjs [unit|integration|all]");
    status = 2;
}

process.exit(status);
