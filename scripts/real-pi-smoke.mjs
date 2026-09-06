#!/usr/bin/env node
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { attachChildProcessLifecycle, isChildTreeAlive, trySignalChildTree } from "../src/shared/post-exit-stdio-guard.ts";
import { getBrokerSocketPath } from "../src/pi-intercom/broker/paths.ts";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 120_000;
const authAgentDir = process.env.PI_REAL_SMOKE_AUTH_AGENT_DIR
	?? (process.env.HOME ? join(process.env.HOME, ".pi", "agent") : undefined);

function usage() {
	console.log(`Usage: node scripts/real-pi-smoke.mjs [--llm] [--llm-full] [--keep-temp] [--timeout-ms <ms>]\n\nRuns an opt-in real Pi package smoke for this checkout. It uses an isolated\ntemporary Pi home, installs the single pi-subagents package with bundled intercom, verifies pi list,\nand loads both extension entries. It does not install pi-fitch-kit, publish anything,\nor create GitHub Actions.\n\nOptions:\n  --llm             Also run live model-backed list, foreground, and async-completion smoke prompts\n  --llm-full        Also run broader live parallel, chain, output, and acceptance prompts\n  --keep-temp       Keep the isolated temporary home for debugging\n  --timeout-ms <ms> Per-command timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})\n  -h, --help        Show this help\n\nEnvironment:\n  PI_REAL_SMOKE_AUTH_AGENT_DIR     Source Pi agent dir for auth.json/models.json during --llm (default: ~/.pi/agent)\n  PI_REAL_SMOKE_MODEL              Model passed to live --llm smoke prompts, e.g. openai/gpt-6-astra\n  PI_REAL_SMOKE_PROVIDER           Provider passed to live --llm smoke prompts\n\nExit codes:\n  0  real Pi smoke passed\n  1  install/list/live smoke failed\n  2  invalid arguments`);
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
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_CACHE_HOME: join(home, ".cache"),
		PI_CODING_AGENT_DIR: agentDir,
		PI_SUBAGENT_TEMP_ROOT: join(root, "pi-subagents-runtime"),
		PI_OFFLINE: "1",
		PATH: process.env.PATH ?? "",
	};
}

function run(label, command, args, options) {
	const { cwd, env, timeoutMs, input, signal, processes } = options;
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		let discovery;
		let discoveryError;
		const finish = async (error, output) => {
			clearTimeout(timer);
			clearInterval(watcher);
			signal.removeEventListener("abort", cancel);
			await discovery;
			if (error) reject(error);
			else resolve(output);
		};
		const child = execFile(command, args, { cwd, env, encoding: "utf8", detached: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
			const output = `${stdout ?? ""}${stderr ?? ""}`;
			void finish(error ? new Error(`${label} failed with ${error.code ?? "spawn error"}\nCommand: ${command} ${args.join(" ")}\n${output}`) : undefined, output);
		});
		attachChildProcessLifecycle(child);
		if (child.pid) {
			const entry = { child };
			processes.set(child.pid, entry);
			child.once("close", () => { entry.exited = !isChildTreeAlive(child); });
		}
		// Remember detached startup children while their parent is still alive, even if startup fails.
		const watcher = setInterval(() => {
			discovery ??= collectOwnedProcesses(options).catch((error) => {
				if (error.message !== discoveryError) console.error(`[real-pi-smoke] process discovery: ${error.message}`);
				discoveryError = error.message;
			}).finally(() => { discovery = undefined; });
		}, 100);
		// Reject without killing the parent first: finally owns cleanup of it AND its detached workers.
		const timer = setTimeout(() => { void finish(new Error(`${label} timed out after ${timeoutMs}ms\nCommand: ${command} ${args.join(" ")}`)); }, timeoutMs);
		const cancel = () => { void finish(signal.reason); };
		signal.addEventListener("abort", cancel, { once: true });
		child.stdin.on("error", () => {}); // A command may exit without reading its RPC input.
		child.stdin.end(input);
	});
}

function* filesIn(dir) {
	if (!existsSync(dir)) return;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const file = join(dir, entry.name);
		if (entry.isDirectory()) yield* filesIn(file);
		else if (entry.isFile()) yield file;
	}
}

function processRef(pid) {
	if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) throw new Error("Invalid smoke-owned process ID");
	return { pid, kill: (signal) => process.kill(pid, signal) };
}

async function collectOwnedProcesses({ root, env, processes }) {
	const remember = (pid, broker = false) => {
		if (pid === undefined) return;
		if (!processes.has(pid)) processes.set(pid, { child: processRef(pid) });
		if (broker) processes.get(pid).broker = true;
	};
	// Only this attempt's private run files, never the user's shared runtime or process argv.
	for (const dir of [env.PI_SUBAGENT_TEMP_ROOT, join(env.PI_CODING_AGENT_DIR, "sessions", "subagent-runs")]) {
		for (const file of filesIn(dir)) {
			if (basename(file) === "status.json" || (basename(dirname(file)) === "contracts" && file.endsWith(".json"))) {
				remember(JSON.parse(readFileSync(file, "utf8")).pid);
			}
		}
	}
	// The parent records the detached launcher PID; status.json records its runner, not the launcher.
	for (const file of filesIn(join(root, "sessions"))) {
		if (!file.endsWith(".jsonl")) continue;
		const lines = readFileSync(file, "utf8").split("\n").slice(0, -1); // An active append may have a partial final line.
		const header = lines[0] ? JSON.parse(lines[0]) : undefined;
		for (const line of lines) {
			if (!line.trim()) continue;
			const entry = JSON.parse(line);
			if (entry.type === "custom" && entry.customType === "subagent-run" && entry.data?.ownerSessionId === header?.id) remember(entry.data.pid);
		}
	}
	const brokerPid = join(env.PI_CODING_AGENT_DIR, "intercom", "broker.pid");
	if (existsSync(brokerPid)) remember(Number(readFileSync(brokerPid, "utf8").trim()), true);
	// Startup can precede PID-file publication. Query only direct children of known owned PIDs,
	// including new Map entries (grandchildren), before signalling their parents. No argv/global scan.
	for (const entry of processes.values()) {
		if (!entry.exited) entry.exited = !isChildTreeAlive(entry.child);
		if (entry.exited) continue;
		const { child } = entry;
		try {
			const { stdout } = await execFileAsync("pgrep", ["-P", String(child.pid)], { env, encoding: "utf8", timeout: 1000 });
			for (const pid of stdout.trim().split(/\s+/).filter(Boolean)) remember(Number(pid));
		} catch (error) {
			if (error.code !== 1) throw error; // pgrep's exit 1 means no matching children.
		}
	}
}

async function stopOwnedProcesses(options) {
	let lastError;
	while (true) {
		let collected = false;
		try {
			await collectOwnedProcesses(options);
			collected = true;
		} catch (error) {
			// Keep the controller alive and credentials in place if ownership cannot yet be read.
			if (error.message !== lastError) console.error(`[real-pi-smoke] waiting for owned-process cleanup: ${error.message}`);
			lastError = error.message;
		}
		const alive = [...options.processes.values()].filter((entry) => {
			if (!entry.exited) entry.exited = !isChildTreeAlive(entry.child);
			return !entry.exited;
		});
		if (collected && alive.length === 0) return;
		const workers = alive.filter((entry) => !entry.broker);
		// Stop the broker last, so exiting workers cannot restart it during cleanup.
		for (const entry of workers.length ? workers : alive) {
			if (!entry.stoppedAt) {
				entry.stoppedAt = Date.now();
				trySignalChildTree(entry.child, "SIGTERM");
			} else if (Date.now() - entry.stoppedAt >= 3000) trySignalChildTree(entry.child, "SIGKILL");
		}
		await delay(50);
	}
}

function runPi(label, args, options) {
	return run(label, "pi", args, options);
}

async function verifyBundledResources(options) {
	const output = await runPi("pi load bundled resources", ["--mode", "rpc", "--no-session", "--offline", "--approve"], {
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

async function runLivePrompt(label, prompt, options, expectedTool) {
	const args = ["--print", "--mode", "json", "--session-dir", join(options.root, "sessions"), "--approve"];
	if (process.env.PI_REAL_SMOKE_PROVIDER) args.push("--provider", process.env.PI_REAL_SMOKE_PROVIDER);
	if (process.env.PI_REAL_SMOKE_MODEL) args.push("--model", process.env.PI_REAL_SMOKE_MODEL, "--models", process.env.PI_REAL_SMOKE_MODEL);
	args.push(prompt);
	const output = await runPi(label, args, options);
	writeFileSync(join(options.root, `${label.replace(/ /g, "-")}.jsonl`), output);
	const events = output.split("\n").flatMap((line) => {
		try { return [JSON.parse(line)]; } catch { return []; }
	});
	if (!events.some((event) => event.type === "tool_execution_start" && event.toolName === expectedTool)) {
		throw new Error(`${label} never invoked ${expectedTool}; a matching final sentence is not execution evidence.`);
	}
	const errors = events.filter((event) => event.type === "tool_execution_end" && event.isError);
	if (errors.length) throw new Error(`${label} had ${errors.length} failed tool call(s); inspect its saved wire log.`);
	if (!events.some((event) => event.type === "agent_settled")) throw new Error(`${label} did not reach agent_settled.`);
	return events.filter((event) => event.type === "message_end" && event.message?.role === "assistant")
		.flatMap((event) => event.message.content.filter((part) => part.type === "text").map((part) => part.text)).join("\n");
}

function auditSavedModels(dir, expectedModel) {
	const models = new Set();
	let responses = 0;
	const visit = (directory) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const file = join(directory, entry.name);
			if (entry.isDirectory()) visit(file);
			else if (entry.name.endsWith(".jsonl")) {
				for (const line of readFileSync(file, "utf8").split("\n")) {
					if (!line.trim()) continue;
					const entry = JSON.parse(line);
					if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
					responses++;
					models.add(`${entry.message.provider}/${entry.message.model}`);
				}
			}
		}
	};
	visit(dir);
	if (!responses) throw new Error("No saved assistant messages found for model audit.");
	if (expectedModel?.includes("/") && [...models].some((model) => model !== expectedModel)) {
		throw new Error(`Unexpected model in saved parent/child sessions: ${[...models].join(", ")}`);
	}
	console.log(`[real-pi-smoke] audited ${responses} saved parent/child responses: ${[...models].join(", ")}`);
}

function requireOutput(label, output, pattern) {
	if (!pattern.test(output)) {
		throw new Error(`${label} did not include expected evidence ${pattern}.\nOutput:\n${output}`);
	}
	const compact = output.trim().split(/\r?\n/).slice(-8).join("\n");
	console.log(`[real-pi-smoke] ${label} output evidence:\n${compact}`);
}

async function waitForAsyncCompletion(runId, pattern, { env, timeoutMs, signal }) {
	const dir = join(env.PI_SUBAGENT_TEMP_ROOT, "async-subagent-runs", runId);
	const deadline = Date.now() + timeoutMs;
	let lastState = "missing";
	let lastOutput = "";
	while (Date.now() < deadline) {
		signal.throwIfAborted();
		const statusPath = join(dir, "status.json");
		const outputPath = join(dir, "output-0.log");
		if (existsSync(outputPath)) lastOutput = readFileSync(outputPath, "utf8");
		if (existsSync(statusPath)) {
			const status = JSON.parse(readFileSync(statusPath, "utf8"));
			lastState = String(status.state ?? "unknown");
			if (lastState === "complete" && status.pid && !isChildTreeAlive(processRef(status.pid))) {
				if (!pattern.test(lastOutput)) throw new Error(`async run ${runId} completed without ${pattern}.\nOutput:\n${lastOutput}`);
				const compact = lastOutput.trim().split(/\r?\n/).slice(-8).join("\n");
				console.log(`[real-pi-smoke] async run ${runId} completed:\n${compact}`);
				return;
			}
			if (lastState === "failed" || lastState === "paused") throw new Error(`async run ${runId} ended ${lastState}.\nOutput:\n${lastOutput}`);
		}
		await delay(500, undefined, { signal });
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
	const projectRoot = join(root, "project");
	const projectAgentsDir = join(projectRoot, ".pi", "agents");
	mkdirSync(projectAgentsDir, { recursive: true });
	writeFileSync(join(projectAgentsDir, "real-smoke.md"), `---
name: real-smoke
description: Isolated live smoke agent
systemPromptMode: replace
inheritProjectContext: false
inheritSkills: false
tools: read
extensions:
---

Follow the task exactly and return its requested text without using tools.
`, "utf-8");
	const env = isolatedEnv(root, agentDir);
	const cancellation = new AbortController();
	const cancel = (signal) => cancellation.abort(new Error(`Cancelled by ${signal}`));
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, cancel);
	const runOptions = { cwd: projectRoot, env, timeoutMs: options.timeoutMs, root, signal: cancellation.signal, processes: new Map() };

	try {
		await runPi("pi install pi-subagents", ["install", repoRoot, "--approve"], runOptions);
		const list = await runPi("pi list", ["list", "--approve"], runOptions);
		if (!list.includes(repoRoot)) throw new Error(`pi list did not include ${repoRoot}:\n${list}`);
		await verifyBundledResources(runOptions);
		console.log(`[real-pi-smoke] active Pi ${(await runPi("pi version", ["--version"], runOptions)).trim()}`);

		if (options.llm) {
			const copiedAuthFiles = copyLiveAuth(agentDir);
			if (copiedAuthFiles.length > 0) console.log(`[real-pi-smoke] copied ${copiedAuthFiles.join(" and ")} into isolated Pi agent dir for live provider auth`);
			const childModelInstruction = process.env.PI_REAL_SMOKE_MODEL ? ` Pass model override '${process.env.PI_REAL_SMOKE_MODEL}' to every subagent run.` : "";
			const intercomPrompt = "Call the intercom tool with action status. Reply exactly with 'real-pi-smoke intercom ok' if the tool output includes 'Connected: Yes'.";
			const listPrompt = "Use the agent_runs tool with action profiles. Reply exactly with 'real-pi-smoke list ok' if reviewer, scout, oracle, and watcher are available.";
			const foregroundPrompt = `Use the delegate tool to run real-smoke with task 'Reply exactly: real-pi-smoke foreground ok', async false and output false.${childModelInstruction} If the tool returns an output artifact path instead of inline output, read that file. Then reply exactly 'real-pi-smoke foreground ok' only if the child result contains it.`;
			const asyncPrompt = `Use the delegate tool to run real-smoke with task 'Reply exactly: real-pi-smoke async ok', output false.${childModelInstruction} Set async true so it launches in the background. Do not call status and do not wait for completion. Reply with 'real-pi-smoke async launched ok' and quote the exact tool result line beginning 'Async:' including the run id.`;
			requireOutput("real Pi intercom prompt", await runLivePrompt("real Pi intercom prompt", intercomPrompt, runOptions, "intercom"), /real-pi-smoke intercom ok/);
			requireOutput("real Pi subagent list prompt", await runLivePrompt("real Pi subagent list prompt", listPrompt, runOptions, "agent_runs"), /real-pi-smoke list ok/);
			requireOutput("real Pi foreground subagent prompt", await runLivePrompt("real Pi foreground subagent prompt", foregroundPrompt, runOptions, "delegate"), /real-pi-smoke foreground ok/);
			const asyncOutput = await runLivePrompt("real Pi async subagent prompt", asyncPrompt, runOptions, "delegate");
			requireOutput("real Pi async subagent prompt", asyncOutput, /real-pi-smoke async (?:launched )?ok/i);
			const asyncRunId = asyncOutput.match(/Async(?: parallel)?:\s+(?:\S+|\[[^\]]+\])\s+\[([0-9a-f-]{36})\]/i)?.[1]
				?? asyncOutput.match(/\[([0-9a-f-]{36})\]/i)?.[1]
				?? asyncOutput.match(/\b([0-9a-f]{8}-[0-9a-f-]{27})\b/i)?.[1];
			if (!asyncRunId) throw new Error(`Could not parse async run id from output:\n${asyncOutput}`);
			await waitForAsyncCompletion(asyncRunId, /^real-pi-smoke async ok$/m, runOptions);

			if (options.llmFull) {
				const outputPath = join(root, "live-output-smoke.txt");
				const parallelPrompt = `Use the subagent tool in parallel mode with two delegate tasks and async false. Task 1 replies exactly 'real-pi-smoke parallel A ok'. Task 2 replies exactly 'real-pi-smoke parallel B ok'. Set output false and progress false for both.${childModelInstruction} Reply exactly 'real-pi-smoke parallel ok' only if both child outputs are present.`;
				const chainPrompt = `Use the subagent tool chain mode with two delegate steps and async false.${childModelInstruction} Step 1 task: 'Reply exactly: real-pi-smoke chain step1 ok'. Step 2 task: 'Previous output is {previous}. Reply exactly: real-pi-smoke chain step2 ok'. Reply exactly 'real-pi-smoke chain ok' only if step 2 ran after step 1.`;
				const outputPrompt = `Use the subagent tool to run delegate with task 'Write exactly real-pi-smoke output ok plus newline to the requested output path, then reply exactly wrote output smoke'. Set async false, output to ${JSON.stringify(outputPath)}, and outputMode to file-only.${childModelInstruction} Reply exactly 'real-pi-smoke output ok' only after the tool returns.`;
				const acceptancePrompt = `Use the subagent tool to run delegate with task 'Final answer exactly: real-pi-smoke acceptance ok evidence=manual-notes'. Set async false. Include acceptance criteria requiring the final answer to contain real-pi-smoke acceptance ok and evidence manual-notes, with maxFinalizationTurns 2.${childModelInstruction} Reply exactly 'real-pi-smoke acceptance ok' only if the child completed.`;
				requireOutput("real Pi parallel subagent prompt", await runLivePrompt("real Pi parallel subagent prompt", parallelPrompt, runOptions, "subagent"), /real-pi-smoke parallel ok/);
				requireOutput("real Pi chain subagent prompt", await runLivePrompt("real Pi chain subagent prompt", chainPrompt, runOptions, "subagent"), /real-pi-smoke chain ok/);
				requireOutput("real Pi output subagent prompt", await runLivePrompt("real Pi output subagent prompt", outputPrompt, runOptions, "subagent"), /real-pi-smoke output ok/);
				if (!existsSync(outputPath) || !/real-pi-smoke output ok/.test(readFileSync(outputPath, "utf8"))) throw new Error(`output smoke file missing expected content: ${outputPath}`);
				requireOutput("real Pi acceptance subagent prompt", await runLivePrompt("real Pi acceptance subagent prompt", acceptancePrompt, runOptions, "subagent"), /real-pi-smoke acceptance ok/);
			}
			auditSavedModels(join(root, "sessions"), process.env.PI_REAL_SMOKE_MODEL);
		}

		console.log(`[real-pi-smoke] installed the single pi-subagents package, loaded bundled intercom, and verified pi list in ${agentDir}`);
		if (!options.llm) console.log("[real-pi-smoke] live model subagent prompts skipped; pass --llm to exercise foreground/async paths.");
	} finally {
		await stopOwnedProcesses(runOptions);
		rmSync(dirname(getBrokerSocketPath(agentDir)), { recursive: true, force: true });
		for (const name of ["auth.json", "models.json"]) rmSync(join(agentDir, name), { force: true });
		if (options.keepTemp) console.log(`[real-pi-smoke] kept temp root ${root}`);
		else rmSync(root, { recursive: true, force: true });
		for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.off(signal, cancel);
	}
}

main().catch((error) => {
	console.error(`[real-pi-smoke] ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
