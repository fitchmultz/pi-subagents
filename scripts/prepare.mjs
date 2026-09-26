#!/usr/bin/env node
/**
 * Purpose: Build generated dist output for GitHub/source installs even when Pi invokes npm install --omit=dev.
 * Responsibilities: Build with the local compiler when present; otherwise install only the pinned
 * `typescript` into a throwaway prefix, build with it, and delete the prefix. Emit needs no type
 * information (tsconfig.build.json sets noCheck), so the Pi host graph is never installed here.
 * Scope: Package install lifecycle only; runtime behavior remains owned by scripts/build.mjs.
 * Usage: package.json prepare script.
 */

import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const cwd = process.cwd();
const buildScript = join(cwd, "scripts", "build.mjs");
const tscBin = (root) => join(root, "node_modules", "typescript", "bin", "tsc");

// No shell: process.execPath runs scripts and npm's cli.js directly, which is safe for
// paths containing spaces on every platform (shell:true concatenates args unescaped).
async function runNode(args) {
	const { stderr, stdout } = await execFile(process.execPath, args, { cwd, maxBuffer: 20 * 1024 * 1024 });
	// Forward output on success too: install-time diagnostics such as the
	// concurrent-swap race-loss warning are otherwise swallowed.
	if (stdout) process.stdout.write(stdout);
	if (stderr) process.stderr.write(stderr);
}

async function main() {
	if (existsSync(tscBin(cwd))) {
		await runNode([buildScript]);
		return;
	}
	const npmExecPath = process.env.npm_execpath;
	if (!npmExecPath) throw new Error(`npm_execpath is not set; run "npm install" manually in ${cwd} and retry.`);
	const { devDependencies } = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
	const prefix = await mkdtemp(join(tmpdir(), "pi-subagents-tsc-"));
	try {
		await runNode([
			npmExecPath,
			"install",
			`typescript@${devDependencies.typescript}`,
			"--prefix",
			prefix,
			"--no-save",
			"--no-package-lock",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
		]);
		await runNode([buildScript, tscBin(prefix)]);
	} finally {
		await rm(prefix, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 });
	}
}

main().catch((error) => {
	if (error?.stdout) process.stdout.write(error.stdout);
	if (error?.stderr) process.stderr.write(error.stderr);
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
