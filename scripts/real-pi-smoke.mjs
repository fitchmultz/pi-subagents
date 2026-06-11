#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

const DEFAULT_TIMEOUT_MS = 120_000;
const fitchKitRoot = process.env.PI_FITCH_KIT_DIR ?? "/Users/mitchfultz/Projects/AI/pi-fitch-kit";

function usage() {
	console.log(`Usage: node scripts/real-pi-smoke.mjs [--llm] [--keep-temp] [--timeout-ms <ms>]\n\nRuns an opt-in real Pi package smoke for this local file-path fork. By default it\nuses an isolated temporary Pi home, installs this checkout plus pi-fitch-kit by\nlocal path, syncs pi-fitch-kit agent overrides into that temporary ~/.pi/agent,\nand verifies pi list plus override symlinks. It does not publish anything and it\ndoes not create GitHub Actions.\n\nOptions:\n  --llm             Also run live model-backed foreground/async/nested smoke prompts\n  --keep-temp       Keep the isolated temporary home for debugging\n  --timeout-ms <ms> Per-command timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})\n  -h, --help        Show this help\n\nEnvironment:\n  PI_FITCH_KIT_DIR       Override pi-fitch-kit repo path (default: ${fitchKitRoot})\n  PI_REAL_SMOKE_MODEL    Model passed to live --llm smoke prompts, e.g. openai/gpt-4o-mini\n  PI_REAL_SMOKE_PROVIDER Provider passed to live --llm smoke prompts\n\nExit codes:\n  0  real Pi smoke passed\n  1  install/list/override/live smoke failed\n  2  invalid arguments`);
}

function parsePositiveInteger(value, source) {
	if (!/^\d+$/.test(value)) throw new Error(`${source} must be a positive integer, got ${value}`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${source} must be a positive safe integer, got ${value}`);
	return parsed;
}

function parseArgs(argv) {
	const options = { llm: false, keepTemp: false, timeoutMs: DEFAULT_TIMEOUT_MS };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") {
			usage();
			process.exit(0);
		}
		if (arg === "--llm") {
			options.llm = true;
			continue;
		}
		if (arg === "--keep-temp") {
			options.keepTemp = true;
			continue;
		}
		if (arg === "--timeout-ms") {
			const value = argv[index + 1];
			if (!value) throw new Error("--timeout-ms requires a value");
			options.timeoutMs = parsePositiveInteger(value, "--timeout-ms");
			index += 1;
			continue;
		}
		if (arg.startsWith("--timeout-ms=")) {
			options.timeoutMs = parsePositiveInteger(arg.slice("--timeout-ms=".length), "--timeout-ms");
			continue;
		}
		throw new Error(`Unknown option: ${arg}`);
	}
	return options;
}

function commandName(base) {
	return process.platform === "win32" ? `${base}.cmd` : base;
}

function isolatedEnv(root, agentDir) {
	const home = join(root, "home");
	return {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		APPDATA: join(home, "AppData", "Roaming"),
		LOCALAPPDATA: join(home, "AppData", "Local"),
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_CACHE_HOME: join(home, ".cache"),
		PI_CODING_AGENT_DIR: agentDir,
		PI_OFFLINE: "1",
		PATH: process.env.PATH ?? "",
		Path: process.env.Path ?? process.env.PATH ?? "",
	};
}

function run(label, command, args, { cwd, env, timeoutMs }) {
	const result = spawnSync(command, args, {
		cwd,
		env,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: timeoutMs,
		killSignal: "SIGTERM",
	});
	const output = result.error ? result.error.message : `${result.stdout ?? ""}${result.stderr ?? ""}`;
	if (result.error?.code === "ETIMEDOUT") {
		throw new Error(`${label} timed out after ${timeoutMs}ms\nCommand: ${command} ${args.join(" ")}\n${output}`);
	}
	if (result.error || result.status !== 0) {
		throw new Error(`${label} failed with ${result.status ?? "spawn error"}\nCommand: ${command} ${args.join(" ")}\n${output}`);
	}
	return output;
}

function runPi(label, args, options) {
	return run(label, commandName("pi"), args, options);
}

function runLivePrompt(label, prompt, options) {
	const args = ["--print", "--mode", "text", "--session-dir", join(options.root, "sessions"), "--approve"];
	if (process.env.PI_REAL_SMOKE_PROVIDER) args.push("--provider", process.env.PI_REAL_SMOKE_PROVIDER);
	if (process.env.PI_REAL_SMOKE_MODEL) args.push("--model", process.env.PI_REAL_SMOKE_MODEL);
	args.push(prompt);
	return runPi(label, args, options);
}

async function main() {
	let options;
	try {
		options = parseArgs(process.argv.slice(2));
	} catch (error) {
		console.error(`[real-pi-smoke] ${error instanceof Error ? error.message : String(error)}`);
		usage();
		process.exit(2);
	}

	const repoRoot = resolve(process.cwd());
	if (!existsSync(fitchKitRoot)) throw new Error(`pi-fitch-kit repo not found: ${fitchKitRoot}`);

	const root = mkdtempSync(join(tmpdir(), "pi-subagents-real-pi-smoke-"));
	const agentDir = join(root, "pi-agent");
	const env = isolatedEnv(root, agentDir);
	const runOptions = { cwd: repoRoot, env, timeoutMs: options.timeoutMs, root };

	try {
		runPi("pi install pi-subagents", ["install", repoRoot, "--approve"], runOptions);
		runPi("pi install pi-fitch-kit", ["install", fitchKitRoot, "--approve"], runOptions);
		run("sync pi-fitch-kit agents", "bash", [join(fitchKitRoot, "scripts", "sync-agents.sh")], { ...runOptions, cwd: fitchKitRoot });
		const list = runPi("pi list", ["list", "--approve"], runOptions);
		if (!list.includes(repoRoot)) throw new Error(`pi list did not include ${repoRoot}:\n${list}`);
		if (!list.includes(fitchKitRoot)) throw new Error(`pi list did not include ${fitchKitRoot}:\n${list}`);
		const overrideJson = run("verify agent overrides", process.execPath, [join(repoRoot, "scripts", "verify-agent-overrides.mjs"), "--json"], runOptions);
		const overrideResult = JSON.parse(overrideJson);
		if (!overrideResult.valid) throw new Error(`override verification failed:\n${overrideJson}`);

		if (options.llm) {
			const listPrompt = "Use the subagent tool with action list. Reply exactly with 'real-pi-smoke list ok' if reviewer, scout, and oracle are available.";
			const foregroundPrompt = "Use the subagent tool to run scout with task 'Reply exactly: real-pi-smoke foreground ok', output false, and progress false. Then report the child result.";
			const asyncPrompt = "Use the subagent tool with async true to run reviewer with task 'Reply exactly: real-pi-smoke async ok', output false, and progress false. Then report the async run id.";
			runLivePrompt("real Pi subagent list prompt", listPrompt, runOptions);
			runLivePrompt("real Pi foreground subagent prompt", foregroundPrompt, runOptions);
			runLivePrompt("real Pi async subagent prompt", asyncPrompt, runOptions);
		}

		console.log(`[real-pi-smoke] installed local packages, verified pi list, and verified ${overrideResult.verifiedOverrides}/${overrideResult.bundledAgents} override symlink(s) in ${agentDir}`);
		if (!options.llm) console.log("[real-pi-smoke] live model subagent prompts skipped; pass --llm to exercise foreground/async paths.");
	} finally {
		if (options.keepTemp) console.log(`[real-pi-smoke] kept temp root ${root}`);
		else rmSync(root, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(`[real-pi-smoke] ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
