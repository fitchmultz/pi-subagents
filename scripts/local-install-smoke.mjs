#!/usr/bin/env node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { prepareIntercomSmokePackage } from "./intercom-smoke-package.mjs";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
	console.log(`Usage: node scripts/local-install-smoke.mjs\n\nInstalls this repository and a pi-intercom companion into an isolated temporary\nhome, then verifies pi list can resolve both packages. Set PI_INTERCOM_PATH to test\na specific pi-intercom checkout. User-level Pi settings are not modified.\n\nExit codes:\n  0  paired local path install/list smoke passed\n  1  pi install or pi list failed, or an installed package was not listed`);
	process.exit(0);
}

function commandName(base) {
	return process.platform === "win32" ? `${base}.cmd` : base;
}

function isolatedEnv(home) {
	return {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		APPDATA: join(home, "AppData", "Roaming"),
		LOCALAPPDATA: join(home, "AppData", "Local"),
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_CACHE_HOME: join(home, ".cache"),
		PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
		PI_OFFLINE: "1",
		PATH: process.env.PATH ?? "",
		Path: process.env.Path ?? process.env.PATH ?? "",
	};
}

function runPi(args, env) {
	const result = spawnSync(commandName("pi"), args, {
		cwd: process.cwd(),
		env,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return {
		ok: !result.error && result.status === 0,
		output: result.error ? result.error.message : `${result.stdout ?? ""}${result.stderr ?? ""}`,
		status: result.status,
	};
}

function requireSuccess(label, result) {
	if (result.ok) return;
	throw new Error(`${label} failed with ${result.status ?? "spawn error"}:\n${result.output}`);
}

const repoRoot = resolve(process.cwd());
const home = mkdtempSync(join(tmpdir(), "pi-subagents-install-smoke-"));

try {
	const env = isolatedEnv(home);
	const intercom = prepareIntercomSmokePackage(home, repoRoot);
	requireSuccess("pi install pi-intercom", runPi(["install", intercom.packageRoot, "--approve"], env));
	requireSuccess("pi install pi-subagents", runPi(["install", repoRoot, "--approve"], env));

	const list = runPi(["list", "--approve"], env);
	requireSuccess("pi list", list);
	for (const packageRoot of [intercom.packageRoot, repoRoot]) {
		if (!list.output.includes(packageRoot)) {
			throw new Error(`pi list did not include installed local path ${packageRoot}:\n${list.output}`);
		}
	}

	console.log(`[local-install-smoke] installed and listed pi-subagents with pi-intercom from ${intercom.source}`);
} catch (error) {
	console.error(`[local-install-smoke] ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
} finally {
	rmSync(home, { recursive: true, force: true });
}
