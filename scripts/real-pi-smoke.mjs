#!/usr/bin/env node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { runLiveSmoke } from "./real-pi-live.mjs";
import { SmokeProcesses } from "./real-pi-processes.mjs";

const DEFAULT_TIMEOUT_MS = 120_000;

function usage() {
  console.log(
    `Usage: node scripts/real-pi-smoke.mjs [--llm] [--llm-full] [--keep-temp] [--timeout-ms <ms>]\n\nRuns an opt-in real Pi package smoke for this checkout. It uses an isolated\ntemporary Pi home, installs the single pi-subagents package with bundled intercom, verifies pi list,\nand loads the single compiled entry. It does not install pi-fitch-kit, publish anything,\nor create GitHub Actions.\n\nOptions:\n  --llm             Also run live model-backed intercom, list, and delegate prompts in a persistent RPC main\n                    that stays open until each launch receipt's completion notification resumes it\n  --llm-full        Also verify forked completion context and saved-conversation continuation\n  --keep-temp       Keep the isolated temporary home for debugging\n  --timeout-ms <ms> Per-command timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})\n  -h, --help        Show this help\n\nEnvironment:\n  PI_REAL_SMOKE_AUTH_AGENT_DIR     Source Pi agent dir for auth.json/models.json during --llm (default: ~/.pi/agent)\n  PI_REAL_SMOKE_MODEL              Model passed to live --llm smoke prompts, e.g. openai/gpt-6-astra\n  PI_REAL_SMOKE_PROVIDER           Provider passed to live --llm smoke prompts\n\nExit codes:\n  0  real Pi smoke passed\n  1  install/list/live smoke failed\n  2  invalid arguments`,
  );
}

function parsePositiveInteger(value, source) {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${source} must be a positive integer, got ${value}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${source} must be a positive safe integer, got ${value}`);
  }
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
      if (!value) {
        throw new Error("--timeout-ms requires a value");
      }
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

function isolatedEnv(root, agentDir) {
  const home = join(root, "home");
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("PI_SUBAGENT_") || key.startsWith("PI_INTERCOM_")) {
      delete env[key];
    }
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    PI_CODING_AGENT_DIR: agentDir,
    PI_INTERCOM_RUNTIME_DIR: join(root, "ic"),
    PI_SUBAGENT_TEMP_ROOT: join(root, "pi-subagents-runtime"),
    PI_OFFLINE: "1",
    PATH: process.env.PATH ?? "",
  };
}

function runPi(label, args, options) {
  return options.processes.run(label, "pi", args, options.input);
}

async function verifyBundledResources(options) {
  const marker = join(options.root, "resources.json");
  const observer = join(options.root, "observe-resources.mjs");
  writeFileSync(
    observer,
    `import { writeFileSync } from "node:fs"; export default function(pi) { pi.on("session_start", () => { writeFileSync(${JSON.stringify(marker)}, JSON.stringify(pi.getActiveTools())); }); }`,
  );
  const output = await runPi(
    "pi load bundled resources",
    ["--mode", "rpc", "--no-session", "--offline", "--approve", "-e", observer],
    { ...options, input: `${JSON.stringify({ id: "commands", type: "get_commands" })}\n` },
  );
  const commands = registeredCommands(commandResponse(output));
  for (const name of ["skill:pi-intercom", "skill:pi-subagents"]) {
    if (!commands.includes(name)) {
      throw new Error(`bundled Pi resources did not register ${name}:\n${output}`);
    }
  }
  const tools = JSON.parse(readFileSync(marker, "utf8"));
  for (const name of ["delegate", "agent_runs", "intercom"]) {
    if (!tools.includes(name)) {
      throw new Error(`${name} must be eager on the single package entry`);
    }
  }
  for (const name of [
    "subagent",
    "load_subagent",
    "load_intercom",
    "contact_supervisor",
    "structured_output",
  ]) {
    if (tools.includes(name)) {
      throw new Error(`retired package tool is still exposed: ${name}`);
    }
  }
}

function commandResponse(output) {
  let response;
  for (const line of output.split(/\r?\n/)) {
    try {
      const parsed = JSON.parse(line);
      if (parsed?.type === "response" && parsed?.id === "commands") {
        response = parsed;
      }
    } catch {
      // Ignore non-protocol stderr lines.
    }
  }
  return response;
}

function registeredCommands(response) {
  return response?.success === true && Array.isArray(response?.data?.commands)
    ? response.data.commands.map((command) => command?.name)
    : [];
}

function createProject(root) {
  const projectRoot = join(root, "project");
  mkdirSync(projectRoot, { recursive: true });
  return projectRoot;
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
  const root = mkdtempSync(join("/tmp", "pi-subagents-real-pi-smoke-"));
  const agentDir = join(root, "pi-agent");
  const projectRoot = createProject(root);
  const env = isolatedEnv(root, agentDir);
  const cancellation = new AbortController();
  const cancel = (signal) => cancellation.abort(new Error(`Cancelled by ${signal}`));
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, cancel);
  }
  const runOptions = {
    cwd: projectRoot,
    env,
    timeoutMs: options.timeoutMs,
    root,
    signal: cancellation.signal,
  };

  runOptions.processes = new SmokeProcesses(runOptions);

  try {
    await runPi("pi install pi-subagents", ["install", repoRoot, "--approve"], runOptions);
    const list = await runPi("pi list", ["list", "--approve"], runOptions);
    if (!list.includes(repoRoot)) {
      throw new Error(`pi list did not include ${repoRoot}:\n${list}`);
    }
    await verifyBundledResources(runOptions);
    console.log(
      `[real-pi-smoke] active Pi ${(await runPi("pi version", ["--version"], runOptions)).trim()}`,
    );

    if (options.llm) {
      await runLiveSmoke(options, runOptions, agentDir);
    }

    console.log(
      `[real-pi-smoke] installed the single pi-subagents package, loaded bundled intercom, and verified pi list in ${agentDir}`,
    );
    if (!options.llm) {
      console.log(
        "[real-pi-smoke] live model subagent prompts skipped; pass --llm to exercise launch receipts and completion notifications.",
      );
    }
  } finally {
    await runOptions.processes.stop();
    rmSync(env.PI_INTERCOM_RUNTIME_DIR, { recursive: true, force: true });
    for (const name of ["auth.json", "models.json"]) {
      rmSync(join(agentDir, name), { force: true });
    }
    if (options.keepTemp) {
      console.log(`[real-pi-smoke] kept temp root ${root}`);
    } else {
      rmSync(root, { recursive: true, force: true });
    }
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      process.off(signal, cancel);
    }
  }
}

main().catch((error) => {
  console.error(`[real-pi-smoke] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
