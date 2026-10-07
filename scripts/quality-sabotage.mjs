#!/usr/bin/env node
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CI_TIMEOUT_MS, run } from "./compat-process.mjs";
import { root } from "./quality-scope.mjs";

class AcceptanceWorktree {
  #privateRoot = mkdtempSync(join(tmpdir(), "pi-quality-acceptance-"));
  #cleanupSafe = true;
  directory = join(this.#privateRoot, "worktree");

  get cleanupSafe() {
    return this.#cleanupSafe;
  }

  async command(command, args, label, cwd = this.directory) {
    const log = join(this.#privateRoot, `${label}.log`);
    const descriptor = openSync(log, "wx", 0o600);
    let status = 0;
    try {
      // Both descriptors go directly to disk, including quiet-run stderr and
      // output written by descendants before the shared owner settles them.
      await run(command, args, {
        cwd,
        stdio: ["ignore", descriptor, descriptor],
        ...(command === "npm" && args.join(" ") === "run ci" ? { timeout: CI_TIMEOUT_MS } : {}),
      });
    } catch (error) {
      if (error.cleanupFailed === true) {
        this.#cleanupSafe = false;
      }
      console.error(`Command evidence: ${log}`);
      if (!this.#cleanupSafe || typeof error.status !== "number" || error.signal !== null) {
        throw error;
      }
      status = error.status;
    } finally {
      closeSync(descriptor);
    }
    return { status, output: readFileSync(log, "utf8"), log };
  }

  async remove() {
    if (!this.#cleanupSafe) {
      console.error(
        `Owned descendants not proven quiescent; private acceptance root retained: ${this.#privateRoot}`,
      );
      process.exitCode = 1;
      return;
    }
    try {
      if (existsSync(this.directory)) {
        const removed = await this.command(
          "git",
          ["worktree", "remove", this.directory],
          "remove",
          root,
        );
        if (removed.status !== 0) {
          throw new Error(`Git worktree removal failed; evidence ${removed.log}`);
        }
      }
    } catch (error) {
      console.error(`Disposable acceptance root retained: ${this.#privateRoot}:`, error);
      process.exitCode = 1;
    }
    console.log(`Acceptance evidence retained: ${this.#privateRoot}`);
  }
}

async function sabotage(acceptance, label, content, expected) {
  const path = join(acceptance.directory, "src/quality-sabotage.ts");
  writeFileSync(path, content);
  try {
    const result = await acceptance.command("npm", ["run", "ci"], label);
    if (result.status === 0 || !expected.test(result.output)) {
      throw new Error(
        `${label}: real CI did not fail for the intended reason; evidence ${result.log}`,
      );
    }
    console.log(`${label}: real npm run ci rejected injected violation (${result.log})`);
  } finally {
    if (acceptance.cleanupSafe) {
      rmSync(path, { force: true });
    }
  }
}

async function verifyIsolationFailure(acceptance) {
  const probePath = join(acceptance.directory, "test/quality/allowances.test.mjs");
  const original = readFileSync(probePath, "utf8");
  const anchor = "const options = { ...config.rules[rule][1] };";
  if (original.split(anchor).length !== 2) {
    throw new Error(
      "Native declaration-isolation probe input changed; update the sabotage fixture",
    );
  }
  try {
    writeFileSync(
      probePath,
      original.replace(
        anchor,
        'const options = { ...config.rules[rule][1], allowForKnownSafeCalls: [{ ...allowance, path: "./foreign.ts" }] };',
      ),
    );
    const formatted = await acceptance.command(
      "npm",
      ["exec", "--no", "--", "oxfmt", "--write", "test/quality/allowances.test.mjs"],
      "isolation-format",
    );
    if (formatted.status !== 0) {
      throw new Error(`Allowance sabotage fixture formatting failed: ${formatted.log}`);
    }
    const result = await acceptance.command("npm", ["run", "ci"], "isolation");
    if (
      result.status === 0 ||
      !result.output.includes(
        "Native registration diagnostics must match declaration-isolation expectations",
      )
    ) {
      throw new Error(
        `Allowance sabotage was not rejected by the native declaration-isolation probe; evidence ${result.log}`,
      );
    }
    console.log(
      `isolation: real npm run ci rejected wrong existing declaration path (${result.log})`,
    );
  } finally {
    if (acceptance.cleanupSafe) {
      writeFileSync(probePath, original);
    }
  }
}

async function verifyAcceptanceFailures() {
  const acceptance = new AcceptanceWorktree();
  try {
    const status = await acceptance.command("git", ["status", "--porcelain"], "status", root);
    if (status.status !== 0 || status.output.trim() !== "") {
      throw new Error(
        `Commit the exact integrated revision before acceptance sabotage verification; evidence ${status.log}`,
      );
    }
    const added = await acceptance.command(
      "git",
      ["worktree", "add", "--detach", acceptance.directory, "HEAD"],
      "add",
      root,
    );
    if (added.status !== 0) {
      throw new Error(`Disposable acceptance worktree creation failed: ${added.log}`);
    }
    const install = await acceptance.command("npm", ["ci", "--ignore-scripts"], "install");
    if (install.status !== 0) {
      throw new Error(`Disposable acceptance clean install failed: ${install.log}`);
    }
    const baseline = await acceptance.command("npm", ["run", "ci"], "baseline");
    if (baseline.status !== 0) {
      throw new Error(
        `Clean integrated acceptance must pass before sabotage verification: ${baseline.log}`,
      );
    }
    await sabotage(acceptance, "syntactic", "debugger;\n", /no-debugger/);
    await sabotage(
      acceptance,
      "semantic",
      "export function unsafe(value: unknown): string {\n  return value as string;\n}\n",
      /no-unsafe-type-assertion/,
    );
    await sabotage(
      acceptance,
      "compiler",
      "export const qualityValue: string = 1;\n",
      /TS2322|not assignable to type 'string'/,
    );
    await sabotage(
      acceptance,
      "format",
      "export const qualityValue= 1;\n",
      /quality-sabotage\.ts[\s\S]*Format issues found/,
    );
    await verifyIsolationFailure(acceptance);
  } finally {
    await acceptance.remove();
  }
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(
    `Usage: node scripts/quality-sabotage.mjs\nVerify the actual npm run ci workflow rejects five independent violations.\nRequires a committed, clean, integrated revision, npm, Git and Go.\nRuns a clean install, baseline CI then each sabotage sequentially in a disposable detached worktree.\nEach CI command has the shared ${CI_TIMEOUT_MS / 60_000}-minute budget; descendants settle before fixture/worktree cleanup.\nPrivate logs remain under TMPDIR; uncertain descendant cleanup retains the private worktree too.\nExit 1 if baseline fails, an injected violation escapes, or cleanup fails. Example: npm run quality:sabotage`,
  );
} else if (process.argv.length > 2) {
  throw new Error("Unknown acceptance-probe option; use --help");
} else {
  await verifyAcceptanceFailures();
}
