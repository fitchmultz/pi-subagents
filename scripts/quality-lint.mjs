#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { checkPolicy } from "./quality-policy.mjs";
import { root } from "./quality-scope.mjs";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(
    "Usage: node scripts/quality-lint.mjs [--fix|--agent]\nLint the entire maintained repository with identical scope and the corrected engine.\n--fix applies safe fixes; --agent changes diagnostic output only.\nExit 1 on policy/lint/compiler errors. Example: npm run lint:fix",
  );
} else {
  if (args.some((arg) => !["--fix", "--agent"].includes(arg))) {
    throw new Error("Unknown lint option; use --help");
  }
  checkPolicy();
  const setup = spawnSync(process.execPath, [resolve(root, "scripts/setup-quality-engine.mjs")], {
    cwd: root,
    stdio: "inherit",
  });
  if (setup.status !== 0) {
    process.exit(setup.status ?? 1);
  }
  const result = spawnSync(
    resolve(root, "node_modules/.bin/oxlint"),
    [
      "--deny-warnings",
      ...args.filter((arg) => arg === "--fix"),
      ...(args.includes("--agent") ? ["--format=agent"] : []),
      ".",
    ],
    {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        OXLINT_TSGOLINT_PATH: resolve(root, "node_modules/.cache/pi-quality-engine/tsgolint"),
      },
    },
  );
  process.exit(result.status ?? 1);
}
