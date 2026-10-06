#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { root } from "./quality-scope.mjs";

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 1_800_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error !== undefined || result.signal !== null) {
    throw new Error(
      `Acceptance process could not complete: ${result.error?.message ?? result.signal}`,
    );
  }
  return result;
}

function sabotage(directory, label, content, expected) {
  const path = join(directory, "src/quality-sabotage.ts");
  writeFileSync(path, content);
  try {
    const result = run("npm", ["run", "ci"], directory);
    const output = result.stdout + result.stderr;
    const log = join(tmpdir(), `pi-quality-sabotage-${label}.log`);
    writeFileSync(log, output);
    if (result.status === 0 || !expected.test(output)) {
      throw new Error(`${label}: real CI did not fail for the intended reason; evidence ${log}`);
    }
    console.log(`${label}: real npm run ci rejected injected violation (${log})`);
  } finally {
    rmSync(path, { force: true });
  }
}

function verifyAcceptanceFailures() {
  if (run("git", ["status", "--porcelain"], root).stdout.trim() !== "") {
    throw new Error("Commit the exact integrated revision before acceptance sabotage verification");
  }
  const directory = mkdtempSync(join(tmpdir(), "pi-quality-acceptance-"));
  rmSync(directory, { recursive: true });
  const added = run("git", ["worktree", "add", "--detach", directory, "HEAD"], root);
  if (added.status !== 0) {
    throw new Error(added.stderr);
  }
  try {
    const install = run("npm", ["ci", "--ignore-scripts"], directory);
    const installLog = join(tmpdir(), "pi-quality-sabotage-install.log");
    writeFileSync(installLog, install.stdout + install.stderr);
    if (install.status !== 0) {
      throw new Error(`Disposable acceptance clean install failed: ${installLog}`);
    }
    const baseline = run("npm", ["run", "ci"], directory);
    const log = join(tmpdir(), "pi-quality-sabotage-baseline.log");
    writeFileSync(log, baseline.stdout + baseline.stderr);
    if (baseline.status !== 0) {
      throw new Error(`Clean integrated acceptance must pass before sabotage verification: ${log}`);
    }
    sabotage(directory, "syntactic", "debugger;\n", /no-debugger/);
    sabotage(
      directory,
      "semantic",
      "export function unsafe(value: unknown): string {\n  return value as string;\n}\n",
      /no-unsafe-type-assertion/,
    );
    sabotage(
      directory,
      "compiler",
      "export const qualityValue: string = 1;\n",
      /TS2322|not assignable to type 'string'/,
    );
    sabotage(
      directory,
      "format",
      "export const qualityValue= 1;\n",
      /quality-sabotage.ts|Formatting issues/,
    );
    const configPath = join(directory, ".oxlintrc.json");
    const original = readFileSync(configPath, "utf8");
    try {
      const config = JSON.parse(original);
      config.rules["typescript/no-floating-promises"][1].allowForKnownSafeCalls[0].path =
        "./src/extension/index.ts";
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
      const result = run("npm", ["run", "ci"], directory);
      const output = result.stdout + result.stderr;
      writeFileSync(join(tmpdir(), "pi-quality-sabotage-isolation.log"), output);
      if (
        result.status === 0 ||
        !output.includes("Effective safe-call policy must select the native declaration only")
      ) {
        throw new Error(
          "Allowance sabotage was not rejected by the native declaration-isolation probe",
        );
      }
      console.log("isolation: real npm run ci rejected wrong existing declaration path");
    } finally {
      writeFileSync(configPath, original);
    }
  } finally {
    const removed = spawnSync("git", ["worktree", "remove", directory], {
      cwd: root,
      encoding: "utf8",
    });
    if (removed.status !== 0) {
      console.error(
        `Disposable acceptance worktree retained for inspection: ${directory}: ${removed.stderr}`,
      );
      process.exitCode = 1;
    }
  }
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(
    "Usage: node scripts/quality-sabotage.mjs\nVerify the actual npm run ci workflow rejects five independent violations.\nRequires a committed, clean, integrated revision, npm, Git and Go.\nRuns a clean install, baseline CI then each sabotage in a disposable detached worktree; logs under TMPDIR.\nExit 1 if baseline fails or an injected violation escapes. Example: npm run quality:sabotage",
  );
} else if (process.argv.length > 2) {
  throw new Error("Unknown acceptance-probe option; use --help");
} else {
  verifyAcceptanceFailures();
}
