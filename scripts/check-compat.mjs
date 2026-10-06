#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { CI_TIMEOUT_MS, run } from "./compat-process.mjs";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(
    "Usage: node scripts/check-compat.mjs\n\nRun selected-host full CI and native package checks with actual editor receipts.\nAn owned temporary editor checkout is removed after checks; supplied sources stay read-only.\nEnvironment: PI_EDITOR_RECEIPT_TEST_ROOT optionally supplies a clean frozen Git checkout.\nExamples:\n  npm run check:compat\n  PI_EDITOR_RECEIPT_TEST_ROOT=/path/to/pi-apply-edits npm run check:compat\nExit codes: 0 passed; 1 invalid input, unavailable source or failed checks.",
  );
  process.exit(0);
}
assert.equal(process.argv.length, 2, "Expected no arguments; use --help");
await import("./compat-host.mjs");
const git = async (cwd, args) =>
  (await run("git", args, { cwd, quiet: true, timeout: 10_000 })).trim();
function cleanupEditor(root, cleanupSafe, qualificationFailed) {
  if (!cleanupSafe) {
    console.error(`Retained editor root until owned processes quiesce: ${root}`);
    return;
  }
  try {
    rmSync(root, { recursive: true, force: true });
  } catch (error) {
    if (!qualificationFailed) {
      throw error;
    }
    console.error(`Editor cleanup failed for ${root}; original failure retained:`, error);
  }
}
const root = mkdtempSync(join(tmpdir(), "ps-editor-"));
const editor = join(root, "source");
let cleanupSafe = true;
let qualificationFailed = false;
try {
  const supplied = process.env.PI_EDITOR_RECEIPT_TEST_ROOT;
  let expectedRef;
  if (supplied) {
    const source = resolve(supplied);
    expectedRef = await git(source, ["rev-parse", "HEAD"]);
    assert.equal(
      await git(source, ["status", "--porcelain", "--untracked-files=all"]),
      "",
      "Supplied editor source must be clean",
    );
    await run("git", ["clone", "--no-hardlinks", "--quiet", source, editor]);
    await git(editor, ["checkout", "--quiet", "--detach", expectedRef]);
  } else {
    await run("git", [
      "clone",
      "--depth",
      "1",
      "--branch",
      "main",
      "--single-branch",
      "--quiet",
      "https://github.com/fitchmultz/pi-apply-edits.git",
      editor,
    ]);
  }
  const ref = await git(editor, ["rev-parse", "HEAD"]);
  assert.match(ref, /^[a-f0-9]{40}$/);
  if (expectedRef) {
    assert.equal(ref, expectedRef);
  }
  assert.ok(
    existsSync(join(editor, "extensions", "apply-edits.ts")),
    "Editor source lacks its native extension",
  );
  // Only the editor's real third-party runtime dependencies; Pi supplies its own peers through the loader.
  await run(
    "npm",
    ["ci", "--omit=dev", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund"],
    { cwd: editor },
  );
  await git(editor, ["diff", "--exit-code"]);
  console.log(
    JSON.stringify({
      nativeEditor: { ref, source: editor, supplied: supplied ? resolve(supplied) : null },
    }),
  );
  const env = { ...process.env, PI_EDITOR_RECEIPT_TEST_ROOT: editor };
  await run("npm", ["run", "ci"], { env, timeout: CI_TIMEOUT_MS, stdio: "inherit" });
  await run(process.execPath, ["scripts/native-package-smoke.mjs"], { env, stdio: "inherit" });
} catch (error) {
  qualificationFailed = true;
  cleanupSafe = error.cleanupFailed !== true;
  throw error;
} finally {
  cleanupEditor(root, cleanupSafe, qualificationFailed);
}
