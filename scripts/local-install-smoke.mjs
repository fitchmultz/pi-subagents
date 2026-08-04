#!/usr/bin/env node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
	console.log(`Usage: node scripts/local-install-smoke.mjs\n\nInstalls this repository into an isolated temporary Pi home, then verifies pi list\ncan resolve the single package. User-level Pi settings are not modified.\n\nExit codes:\n  0  local path install/list smoke passed\n  1  pi install or pi list failed, or the installed package was not listed`);
	process.exit(0);
}

function commandName(base) {
	return process.platform === "win32" ? `${base}.cmd` : base;
}

function isolatedEnv(home) {
	const env = { ...process.env };
	for (const key of Object.keys(env)) if (key.startsWith("PI_SUBAGENT_")) delete env[key];
	return {
		...env,
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
	requireSuccess("pi install pi-subagents", runPi(["install", repoRoot, "--approve"], env));

	const list = runPi(["list", "--approve"], env);
	requireSuccess("pi list", list);
	if (!list.output.includes(repoRoot)) {
		throw new Error(`pi list did not include installed local path ${repoRoot}:\n${list.output}`);
	}

	console.log("[local-install-smoke] installed and listed the single pi-subagents package with bundled intercom");
} catch (error) {
	console.error(`[local-install-smoke] ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
} finally {
	rmSync(home, { recursive: true, force: true });
}
