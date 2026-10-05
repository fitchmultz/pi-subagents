#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("Usage: node scripts/check-compat.mjs\n\nRun selected-host full CI and native package checks with actual editor receipts.\nAn owned temporary editor checkout is removed after checks; supplied sources stay read-only.\nEnvironment: PI_EDITOR_RECEIPT_TEST_ROOT optionally supplies a clean frozen Git checkout.\nExamples:\n  npm run check:compat\n  PI_EDITOR_RECEIPT_TEST_ROOT=/path/to/pi-apply-edits npm run check:compat\nExit codes: 0 passed; 1 invalid input, unavailable source or failed checks.");
  process.exit(0);
}
assert.equal(process.argv.length, 2, "Expected no arguments; use --help");
await import("./compat-host.mjs");
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { stdio: "inherit", timeout: 1_200_000, ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed (${result.status ?? result.signal})`);
  return result.stdout?.trim();
};
const git = (cwd, args) => run("git", args, { cwd, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
const root = mkdtempSync(join(tmpdir(), "ps-editor-"));
const editor = join(root, "source");
try {
  const supplied = process.env.PI_EDITOR_RECEIPT_TEST_ROOT;
  let expectedRef;
  if (supplied) {
    const source = resolve(supplied);
    expectedRef = git(source, ["rev-parse", "HEAD"]);
    assert.equal(git(source, ["status", "--porcelain", "--untracked-files=all"]), "", "Supplied editor source must be clean");
    run("git", ["clone", "--no-hardlinks", "--quiet", source, editor]);
    git(editor, ["checkout", "--quiet", "--detach", expectedRef]);
  } else {
    run("git", ["clone", "--depth", "1", "--branch", "main", "--single-branch", "--quiet", "https://github.com/fitchmultz/pi-apply-edits.git", editor]);
  }
  const ref = git(editor, ["rev-parse", "HEAD"]);
  assert.match(ref, /^[a-f0-9]{40}$/);
  if (expectedRef) assert.equal(ref, expectedRef);
  assert.ok(existsSync(join(editor, "extensions", "apply-edits.ts")), "Editor source lacks its native extension");
  // Only the editor's real third-party runtime dependencies; Pi supplies its own peers through the loader.
  run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund"], { cwd: editor });
  git(editor, ["diff", "--exit-code"]);
  console.log(JSON.stringify({ nativeEditor: { ref, source: editor, supplied: supplied ? resolve(supplied) : null } }));
  const env = { ...process.env, PI_EDITOR_RECEIPT_TEST_ROOT: editor };
  run("npm", ["run", "ci"], { env });
  run(process.execPath, ["scripts/native-package-smoke.mjs"], { env });
} finally {
  rmSync(root, { recursive: true, force: true });
}
