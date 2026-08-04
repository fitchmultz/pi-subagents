#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

const DEFAULT_TIMEOUT_MS = 120_000;
const authAgentDir = process.env.PI_REAL_SMOKE_AUTH_AGENT_DIR
	?? (process.env.HOME ? join(process.env.HOME, ".pi", "agent") : undefined);

function usage() {
	console.log(`Usage: node scripts/real-pi-smoke.mjs [--llm] [--llm-full] [--keep-temp] [--timeout-ms <ms>]\n\nRuns an opt-in real Pi package smoke for this checkout. It uses an isolated\ntemporary Pi home, installs the single pi-subagents package with bundled intercom, verifies pi list,\nand loads both extension entries. It does not install pi-fitch-kit, publish anything,\nor create GitHub Actions.\n\nOptions:\n  --llm             Also run live model-backed list, foreground, and async-completion smoke prompts\n  --llm-full        Also run broader live parallel, chain, output, and acceptance prompts\n  --keep-temp       Keep the isolated temporary home for debugging\n  --timeout-ms <ms> Per-command timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})\n  -h, --help        Show this help\n\nEnvironment:\n  PI_REAL_SMOKE_AUTH_AGENT_DIR     Source Pi agent dir for auth.json/models.json during --llm (default: ~/.pi/agent)\n  PI_REAL_SMOKE_MODEL              Model passed to live --llm smoke prompts, e.g. openai/gpt-4o-mini\n  PI_REAL_SMOKE_PROVIDER           Provider passed to live --llm smoke prompts\n\nExit codes:\n  0  real Pi smoke passed\n  1  install/list/live smoke failed\n  2  invalid arguments`);
}

function parsePositiveInteger(value, source) {
	if (!/^\d+$/.test(value)) throw new Error(`${source} must be a positive integer, got ${value}`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${source} must be a positive safe integer, got ${value}`);
	return parsed;
}

function parseArgs(argv) {
	const options = { llm: false, llmFull: false, keepTemp: false, timeoutMs: DEFAULT_TIMEOUT_MS };
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
		if (arg === "--llm-full") {
			options.llm = true;
			options.llmFull = true;
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

function copyLiveAuth(agentDir) {
	if (!authAgentDir || !existsSync(authAgentDir)) return [];
	mkdirSync(agentDir, { recursive: true });
	const copied = [];
	for (const filename of ["auth.json", "models.json"]) {
		const source = join(authAgentDir, filename);
		if (!existsSync(source)) continue;
		copyFileSync(source, join(agentDir, filename));
		copied.push(filename);
	}
	return copied;
}

function isolatedEnv(root, agentDir) {
	const home = join(root, "home");
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
		PI_CODING_AGENT_DIR: agentDir,
		PI_OFFLINE: "1",
		PATH: process.env.PATH ?? "",
		Path: process.env.Path ?? process.env.PATH ?? "",
	};
}

function run(label, command, args, { cwd, env, timeoutMs, input }) {
	const result = spawnSync(command, args, {
		cwd,
		env,
		encoding: "utf-8",
		input,
		stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
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

function verifyBundledResources(options) {
	const output = runPi("pi load bundled resources", ["--mode", "rpc", "--no-session", "--offline", "--approve"], {
		...options,
		input: `${JSON.stringify({ id: "commands", type: "get_commands" })}\n`,
	});
	let response;
	for (const line of output.split(/\r?\n/)) {
		try {
			const parsed = JSON.parse(line);
			if (parsed?.type === "response" && parsed?.id === "commands") response = parsed;
		} catch {
			// Ignore non-protocol stderr lines.
		}
	}
	const commands = response?.success === true && Array.isArray(response?.data?.commands)
		? response.data.commands.map((command) => command?.name)
		: [];
	for (const name of ["intercom", "subagents-doctor", "skill:pi-intercom", "skill:pi-subagents"]) {
		if (!commands.includes(name)) throw new Error(`bundled Pi resources did not register ${name}:\n${output}`);
	}
}

function runLivePrompt(label, prompt, options) {
	const args = ["--print", "--mode", "text", "--session-dir", join(options.root, "sessions"), "--approve"];
	if (process.env.PI_REAL_SMOKE_PROVIDER) args.push("--provider", process.env.PI_REAL_SMOKE_PROVIDER);
	if (process.env.PI_REAL_SMOKE_MODEL) args.push("--model", process.env.PI_REAL_SMOKE_MODEL);
	args.push(prompt);
	return runPi(label, args, options);
}

function requireOutput(label, output, pattern) {
	if (!pattern.test(output)) {
		throw new Error(`${label} did not include expected evidence ${pattern}.\nOutput:\n${output}`);
	}
	const compact = output.trim().split(/\r?\n/).slice(-8).join("\n");
	console.log(`[real-pi-smoke] ${label} output evidence:\n${compact}`);
}

function asyncRunDir(runId) {
	const scope = typeof process.getuid === "function" ? `uid-${process.getuid()}` : `user-${process.env.USERNAME || process.env.USER || process.env.LOGNAME || "unknown"}`;
	return join(tmpdir(), `pi-subagents-${scope}`, "async-subagent-runs", runId);
}

async function waitForAsyncCompletion(runId, pattern, timeoutMs, keepArtifacts = false) {
	const dir = asyncRunDir(runId);
	const deadline = Date.now() + timeoutMs;
	let lastState = "missing";
	let lastOutput = "";
	while (Date.now() < deadline) {
		const statusPath = join(dir, "status.json");
		const outputPath = join(dir, "output-0.log");
		if (existsSync(outputPath)) lastOutput = readFileSync(outputPath, "utf8");
		if (existsSync(statusPath)) {
			const status = JSON.parse(readFileSync(statusPath, "utf8"));
			lastState = String(status.state ?? "unknown");
			if (lastState === "complete") {
				if (!pattern.test(lastOutput)) throw new Error(`async run ${runId} completed without ${pattern}.\nOutput:\n${lastOutput}`);
				const compact = lastOutput.trim().split(/\r?\n/).slice(-8).join("\n");
				console.log(`[real-pi-smoke] async run ${runId} completed:\n${compact}`);
				if (!keepArtifacts) rmSync(dir, { recursive: true, force: true });
				return;
			}
			if (lastState === "failed" || lastState === "paused") throw new Error(`async run ${runId} ended ${lastState}.\nOutput:\n${lastOutput}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error(`async run ${runId} did not complete after ${timeoutMs}ms (last state: ${lastState}).\nOutput:\n${lastOutput}`);
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
	const root = mkdtempSync(join(tmpdir(), "pi-subagents-real-pi-smoke-"));
	const agentDir = join(root, "pi-agent");
	const env = isolatedEnv(root, agentDir);
	const runOptions = { cwd: repoRoot, env, timeoutMs: options.timeoutMs, root };

	try {
		runPi("pi install pi-subagents", ["install", repoRoot, "--approve"], runOptions);
		const list = runPi("pi list", ["list", "--approve"], runOptions);
		if (!list.includes(repoRoot)) throw new Error(`pi list did not include ${repoRoot}:\n${list}`);
		verifyBundledResources(runOptions);

		if (options.llm) {
			const copiedAuthFiles = copyLiveAuth(agentDir);
			if (copiedAuthFiles.length > 0) console.log(`[real-pi-smoke] copied ${copiedAuthFiles.join(" and ")} into isolated Pi agent dir for live provider auth`);
			const childModelInstruction = process.env.PI_REAL_SMOKE_MODEL ? ` Pass model override '${process.env.PI_REAL_SMOKE_MODEL}' to every subagent run.` : "";
			const intercomPrompt = "Call the intercom tool with action status. Reply exactly with 'real-pi-smoke intercom ok' if the tool output includes 'Connected: Yes'.";
			const listPrompt = "Use the subagent tool with action list. Reply exactly with 'real-pi-smoke list ok' if reviewer, scout, and oracle are available.";
			const foregroundPrompt = `Use the subagent tool to run scout with task 'Reply exactly: real-pi-smoke foreground ok', output false, and progress false.${childModelInstruction} Then report the child result.`;
			const asyncPrompt = `Use the subagent tool with async true to run reviewer with task 'Reply exactly: real-pi-smoke async ok', output false, and progress false.${childModelInstruction} Do not call status and do not wait for completion. Reply with 'real-pi-smoke async launched ok' and quote the exact tool result line beginning 'Async:' including the run id.`;
			requireOutput("real Pi intercom prompt", runLivePrompt("real Pi intercom prompt", intercomPrompt, runOptions), /real-pi-smoke intercom ok/);
			requireOutput("real Pi subagent list prompt", runLivePrompt("real Pi subagent list prompt", listPrompt, runOptions), /real-pi-smoke list ok/);
			requireOutput("real Pi foreground subagent prompt", runLivePrompt("real Pi foreground subagent prompt", foregroundPrompt, runOptions), /real-pi-smoke foreground ok/);
			const asyncOutput = runLivePrompt("real Pi async subagent prompt", asyncPrompt, runOptions);
			requireOutput("real Pi async subagent prompt", asyncOutput, /real-pi-smoke async launched ok/i);
			const asyncRunId = asyncOutput.match(/Async(?: parallel)?:\s+(?:\S+|\[[^\]]+\])\s+\[([0-9a-f-]{36})\]/i)?.[1];
			if (!asyncRunId) throw new Error(`Could not parse async run id from output:\n${asyncOutput}`);
			await waitForAsyncCompletion(asyncRunId, /^real-pi-smoke async ok$/m, options.timeoutMs, options.keepTemp);

			if (options.llmFull) {
				const outputPath = join(root, "live-output-smoke.txt");
				const parallelPrompt = `Use the subagent tool in parallel mode with two delegate tasks. Task 1 replies exactly 'real-pi-smoke parallel A ok'. Task 2 replies exactly 'real-pi-smoke parallel B ok'. Set output false and progress false for both.${childModelInstruction} Reply exactly 'real-pi-smoke parallel ok' only if both child outputs are present.`;
				const chainPrompt = `Use the subagent tool chain mode with two delegate steps.${childModelInstruction} Step 1 task: 'Reply exactly: real-pi-smoke chain step1 ok'. Step 2 task: 'Previous output is {previous}. Reply exactly: real-pi-smoke chain step2 ok'. Reply exactly 'real-pi-smoke chain ok' only if step 2 ran after step 1.`;
				const outputPrompt = `Use the subagent tool to run delegate with task 'Write exactly real-pi-smoke output ok plus newline to the requested output path, then reply exactly wrote output smoke'. Set output to ${JSON.stringify(outputPath)} and outputMode to file-only.${childModelInstruction} Reply exactly 'real-pi-smoke output ok' only after the tool returns.`;
				const acceptancePrompt = `Use the subagent tool to run delegate with task 'Final answer exactly: real-pi-smoke acceptance ok evidence=manual-notes'. Include acceptance criteria requiring the final answer to contain real-pi-smoke acceptance ok and evidence manual-notes, with maxFinalizationTurns 2.${childModelInstruction} Reply exactly 'real-pi-smoke acceptance ok' only if the child completed.`;
				requireOutput("real Pi parallel subagent prompt", runLivePrompt("real Pi parallel subagent prompt", parallelPrompt, runOptions), /real-pi-smoke parallel ok/);
				requireOutput("real Pi chain subagent prompt", runLivePrompt("real Pi chain subagent prompt", chainPrompt, runOptions), /real-pi-smoke chain ok/);
				requireOutput("real Pi output subagent prompt", runLivePrompt("real Pi output subagent prompt", outputPrompt, runOptions), /real-pi-smoke output ok/);
				if (!existsSync(outputPath) || !/real-pi-smoke output ok/.test(readFileSync(outputPath, "utf8"))) throw new Error(`output smoke file missing expected content: ${outputPath}`);
				requireOutput("real Pi acceptance subagent prompt", runLivePrompt("real Pi acceptance subagent prompt", acceptancePrompt, runOptions), /real-pi-smoke acceptance ok/);
			}
		}

		console.log(`[real-pi-smoke] installed the single pi-subagents package, loaded bundled intercom, and verified pi list in ${agentDir}`);
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
