#!/usr/bin/env node
/**
 * Purpose: Produce the compiled runtime files that the Pi extension manifest loads.
 * Responsibilities: Run TypeScript emit into a staging directory, move the last-good dist/ aside,
 * and rename the complete staging tree into place. A failed emit never touches dist/; a failed
 * publication renames the last-good tree back. Replacement is two renames, not an atomic exchange:
 * a concurrent reader can briefly find no dist/, but never a partial tree.
 * Usage: `npm run build`; also invoked by scripts/prepare.mjs during install lifecycles, which may pass
 * the path of a throwaway compiler's `bin/tsc` as the first argument. Android uses native tsgo.
 * Invariants/Assumptions: deleting `dist/` is safe generated output.
 */

import { execFile as execFileCallback } from "node:child_process";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { compilerInvocation } from "./typescript.mjs";

/** @type {(file: string, args: readonly string[], options: import("node:child_process").ExecFileOptions) => Promise<{ stdout: string, stderr: string }>} */
const execFile = promisify(execFileCallback);
const RM_OPTIONS = { force: true, maxRetries: 5, recursive: true, retryDelay: 100 };

function isErrno(/** @type {unknown} */ error, /** @type {string} */ code) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
const RENAME_RETRY_LIMIT = 50;
const RENAME_RETRY_MS = 50;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(
    "Usage: node scripts/build.mjs [compiler-path]\n\nCompile into PID-owned staging, stamp the package version/content hash, then publish dist.\nA failed compiler preserves existing dist; a failed publication restores it. Concurrent publishers retain a complete winning tree.\nExample: npm run build\nExit codes: 0 published or concurrent winner retained; 1 compile/publish failed.",
  );
  process.exit(0);
}

async function discardStaging(/** @type {string} */ path) {
  try {
    await rm(path, RM_OPTIONS);
  } catch (error) {
    // Cleanup is always best-effort: it must not turn a successful race loss
    // into failure or replace the compiler/publish error that matters.
    console.warn(
      `could not remove staging ${path}: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
    );
  }
}

function isOwnerGone(/** @type {number} */ pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return isErrno(error, "ESRCH");
  }
}

async function hasPublishedDist(/** @type {string} */ path) {
  try {
    return (await readdir(path)).length > 0;
  } catch {
    return false;
  }
}

/**
 * @param {string} cwd
 * @param {import("node:fs").Dirent} entry
 * @returns {{ path: string, kind: "staging" | "previous" } | undefined}
 */
function strandedBuild(cwd, entry) {
  // Signal 0 proves only that the owner was gone at probe time. Pid reuse
  // between this probe and removal is inherent to pid-based reaping.
  const match = /^dist\.staging\.(\d+)(\.previous)?$/.exec(entry.name);
  if (!match || !entry.isDirectory()) {
    return;
  }
  const ownerPid = Number(match[1]);
  if (ownerPid === process.pid || !isOwnerGone(ownerPid)) {
    return;
  }
  return { path: join(cwd, entry.name), kind: match[2] === undefined ? "staging" : "previous" };
}

async function reapStrandedBuilds(/** @type {string} */ cwd) {
  const stranded = (await readdir(cwd, { withFileTypes: true })).flatMap((entry) => {
    const build = strandedBuild(cwd, entry);
    return build ? [build] : [];
  });
  for (const entry of stranded) {
    if (entry.kind === "staging") {
      await discardStaging(entry.path);
    }
  }
  // Never promote rollback material into another live publisher's retirement gap.
  return stranded.filter((entry) => entry.kind === "previous").map((entry) => entry.path);
}

async function compileProject(
  /** @type {string} */ cwd,
  /** @type {string} */ stagingDir,
  /** @type {{ command: string, args: string[] }} */ compiler,
  /** @type {string} */ project,
) {
  const { stderr, stdout } = await execFile(
    compiler.command,
    [...compiler.args, "-p", project, "--outDir", stagingDir],
    { cwd, maxBuffer: 10 * 1024 * 1024 },
  );
  if (stdout !== "") {
    process.stdout.write(stdout);
  }
  if (stderr !== "") {
    process.stderr.write(stderr);
  }
}

async function compileToStaging(
  /** @type {string} */ cwd,
  /** @type {string} */ stagingDir,
  /** @type {{ command: string, args: string[] }} */ compiler,
) {
  try {
    await compileProject(cwd, stagingDir, compiler, "tsconfig.build.json");
    await compileProject(cwd, stagingDir, compiler, "tsconfig.client.json");
    await stampBuild(cwd, stagingDir);
  } catch (error) {
    if (typeof error === "object" && error !== null) {
      if ("stdout" in error && typeof error.stdout === "string") {
        process.stdout.write(error.stdout);
      }
      if ("stderr" in error && typeof error.stderr === "string") {
        process.stderr.write(error.stderr);
      }
    }
    await discardStaging(stagingDir);
    throw error;
  }
}

async function stampBuild(/** @type {string} */ cwd, /** @type {string} */ stagingDir) {
  const stamp = "build-info.js";
  const hash = createHash("sha256");
  const files = (await readdir(stagingDir, { recursive: true }))
    .filter((entry) => entry.endsWith(".js") && entry !== stamp)
    .sort();
  for (const file of files) {
    // Hash sorted path/content pairs in order without buffering the whole emitted tree.
    const content = await readFile(join(stagingDir, file));
    hash.update(file).update("\0").update(content).update("\0");
  }
  /** @type {unknown} */
  const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
  assert.ok(typeof pkg === "object" && pkg !== null && "version" in pkg);
  assert.ok(typeof pkg.version === "string");
  const { version } = pkg;
  await writeFile(
    join(stagingDir, stamp),
    `export const EXTENSION_BUILD = Object.freeze(${JSON.stringify({ version, sha256: hash.digest("hex") })});\n`,
  );
}

async function tryPublish(
  /** @type {string} */ stagingDir,
  /** @type {string} */ distDir,
  /** @type {number} */ retry,
) {
  try {
    await rename(stagingDir, distDir);
    return true;
  } catch (error) {
    // A bare directory is not proof that a concurrent publisher finished.
    if (await hasPublishedDist(distDir)) {
      console.warn(
        "dist/ was published by a concurrent build; discarding this build's staging tree.",
      );
      return true;
    }
    if (!existsSync(stagingDir) || retry >= RENAME_RETRY_LIMIT) {
      throw error;
    }
    await delay(RENAME_RETRY_MS);
    return false;
  }
}

async function publishStaging(/** @type {string} */ stagingDir, /** @type {string} */ distDir) {
  const previousDir = `${stagingDir}.previous`;
  try {
    // Retire dist exactly once, outside the retry loop, so retries never retire a concurrent winner.
    await rename(distDir, previousDir).catch((/** @type {unknown} */ error) => {
      if (!isErrno(error, "ENOENT")) {
        throw error;
      }
    });
    for (let retry = 0; ; retry++) {
      // Each retry must observe publication before another rename can race it.
      if (await tryPublish(stagingDir, distDir, retry)) {
        break;
      }
    }
    await discardStaging(previousDir);
  } catch (error) {
    // ENOENT: nothing was retired. Otherwise a concurrent winner may already own dist.
    await rename(previousDir, distDir).catch((/** @type {unknown} */ restoreError) => {
      if (isErrno(restoreError, "ENOENT")) {
        return;
      }
      const message =
        restoreError instanceof Error ? restoreError.message : JSON.stringify(restoreError);
      console.warn(`could not restore ${previousDir} to dist: ${message}`);
    });
    throw error;
  } finally {
    // Safe after success too: rename moved stagingDir, so force makes this a no-op.
    await discardStaging(stagingDir);
  }
}

async function main() {
  const cwd = process.cwd();
  const compiler = compilerInvocation(process.argv[2]);
  const previous = await reapStrandedBuilds(cwd);
  // Pid-scoped staging isolates concurrent emits; only a complete tree publishes.
  const stagingDir = join(cwd, `dist.staging.${process.pid}`);
  await rm(stagingDir, RM_OPTIONS);
  await rm(`${stagingDir}.previous`, RM_OPTIONS);
  try {
    await compileToStaging(cwd, stagingDir, compiler);
    await publishStaging(stagingDir, join(cwd, "dist"));
  } catch (error) {
    for (const retained of previous.filter(existsSync)) {
      console.warn(`Previous build retained for recovery: ${retained}`);
    }
    throw error;
  }
  // A complete published winner now replaces these older rollback candidates.
  for (const retired of previous) {
    await discardStaging(retired);
  }
}

main().catch((/** @type {unknown} */ error) => {
  console.error(error instanceof Error ? error.message : JSON.stringify(error));
  process.exitCode = 1;
});
