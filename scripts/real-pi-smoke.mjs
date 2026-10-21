#!/usr/bin/env node
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { isChildTreeAlive } from "../src/shared/post-exit-stdio-guard.ts";
import { SmokeProcesses, filesIn, processRef } from "./real-pi-processes.mjs";

const DEFAULT_TIMEOUT_MS = 120_000;
const authAgentDir =
  process.env.PI_REAL_SMOKE_AUTH_AGENT_DIR ??
  (process.env.HOME ? join(process.env.HOME, ".pi", "agent") : undefined);

function usage() {
  console.log(
    `Usage: node scripts/real-pi-smoke.mjs [--llm] [--llm-full] [--keep-temp] [--timeout-ms <ms>]\n\nRuns an opt-in real Pi package smoke for this checkout. It uses an isolated\ntemporary Pi home, installs the single pi-subagents package with bundled intercom, verifies pi list,\nand loads the single compiled entry. It does not install pi-fitch-kit, publish anything,\nor create GitHub Actions.\n\nOptions:\n  --llm             Also run live model-backed list, foreground, and async-completion smoke prompts\n  --llm-full        Also verify forked tool-result context and saved-conversation continuation\n  --keep-temp       Keep the isolated temporary home for debugging\n  --timeout-ms <ms> Per-command timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})\n  -h, --help        Show this help\n\nEnvironment:\n  PI_REAL_SMOKE_AUTH_AGENT_DIR     Source Pi agent dir for auth.json/models.json during --llm (default: ~/.pi/agent)\n  PI_REAL_SMOKE_MODEL              Model passed to live --llm smoke prompts, e.g. openai/gpt-6-astra\n  PI_REAL_SMOKE_PROVIDER           Provider passed to live --llm smoke prompts\n\nExit codes:\n  0  real Pi smoke passed\n  1  install/list/live smoke failed\n  2  invalid arguments`,
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

function copyLiveAuth(agentDir) {
  if (!authAgentDir || !existsSync(authAgentDir)) {
    return [];
  }
  mkdirSync(agentDir, { recursive: true });
  const copied = [];
  for (const filename of ["auth.json", "models.json"]) {
    const source = join(authAgentDir, filename);
    if (!existsSync(source)) {
      continue;
    }
    copyFileSync(source, join(agentDir, filename));
    copied.push(filename);
  }
  return copied;
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

async function runLivePrompt(label, prompt, options, expectedTool) {
  const args = [
    "--print",
    "--mode",
    "json",
    "--session-dir",
    join(options.root, "sessions"),
    "--approve",
  ];
  if (process.env.PI_REAL_SMOKE_PROVIDER) {
    args.push("--provider", process.env.PI_REAL_SMOKE_PROVIDER);
  }
  if (process.env.PI_REAL_SMOKE_MODEL) {
    args.push(
      "--model",
      process.env.PI_REAL_SMOKE_MODEL,
      "--models",
      process.env.PI_REAL_SMOKE_MODEL,
    );
  }
  args.push(prompt);
  const output = await runPi(label, args, options);
  writeFileSync(join(options.root, `${label.replace(/ /g, "-")}.jsonl`), output);
  const events = output.split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  if (
    !events.some(
      (event) => event.type === "tool_execution_start" && event.toolName === expectedTool,
    )
  ) {
    throw new Error(
      `${label} never invoked ${expectedTool}; a matching final sentence is not execution evidence.`,
    );
  }
  const errors = events.filter((event) => event.type === "tool_execution_end" && event.isError);
  if (errors.length) {
    throw new Error(
      `${label} had ${errors.length} failed tool call(s); inspect its saved wire log.`,
    );
  }
  if (!events.some((event) => event.type === "agent_settled")) {
    throw new Error(`${label} did not reach agent_settled.`);
  }
  return {
    events,
    text: events
      .filter((event) => event.type === "message_end" && event.message?.role === "assistant")
      .flatMap((event) =>
        event.message.content.filter((part) => part.type === "text").map((part) => part.text),
      )
      .join("\n"),
  };
}

function* savedAssistantModels(file) {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const entry = JSON.parse(line);
    if (entry.type === "message" && entry.message?.role === "assistant") {
      yield `${entry.message.provider}/${entry.message.model}`;
    }
  }
}

function auditSavedModels(directories, expectedModel) {
  const models = new Set();
  let responses = 0;
  for (const file of directories.flatMap((dir) => [...filesIn(dir)])) {
    if (!file.endsWith(".jsonl")) {
      continue;
    }
    for (const model of savedAssistantModels(file)) {
      responses++;
      models.add(model);
    }
  }
  if (!responses) {
    throw new Error("No saved assistant messages found for model audit.");
  }
  if (expectedModel?.includes("/") && [...models].some((model) => model !== expectedModel)) {
    throw new Error(`Unexpected model in saved parent/child sessions: ${[...models].join(", ")}`);
  }
  console.log(
    `[real-pi-smoke] audited ${responses} saved parent/child responses: ${[...models].join(", ")}`,
  );
}

function requireOutput(label, output, pattern) {
  if (!pattern.test(output)) {
    throw new Error(`${label} did not include expected evidence ${pattern}.\nOutput:\n${output}`);
  }
  const compact = output.trim().split(/\r?\n/).slice(-8).join("\n");
  console.log(`[real-pi-smoke] ${label} output evidence:\n${compact}`);
}

function asyncCompletion(dir, runId) {
  const resultPath = join(dir, "result.json");
  if (!existsSync(resultPath)) {
    return { status: "missing" };
  }
  const result = JSON.parse(readFileSync(resultPath, "utf8"));
  if (result.id !== runId) {
    throw new Error("Async completion belongs to another saved run");
  }
  if (result.status !== "completed") {
    throw new Error(`async run ${runId} ended ${result.status}: ${result.error ?? ""}`);
  }
  const processPath = join(dir, "actor.lock", "process.json");
  if (!existsSync(processPath)) {
    return { status: "completed; actor exit unconfirmed" };
  }
  const actor = JSON.parse(readFileSync(processPath, "utf8"));
  return {
    status: result.status,
    output: isChildTreeAlive(processRef(actor.pid))
      ? undefined
      : readFileSync(join(dir, "output.txt"), "utf8"),
  };
}

async function waitForAsyncCompletion(run, pattern, { env, timeoutMs, signal }) {
  const dir = dirname(run.sessionFile);
  const within = relative(join(env.PI_CODING_AGENT_DIR, "sessions", "agent-runs"), dir);
  if (isAbsolute(within) || within.startsWith("..") || !/^[a-zA-Z0-9_-]{1,128}$/.test(run.id)) {
    throw new Error("Async receipt did not identify this smoke's private saved run");
  }
  const deadline = Date.now() + timeoutMs;
  let lastState = "missing";
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const completion = asyncCompletion(dir, run.id);
    lastState = completion.status;
    if (completion.output !== undefined) {
      requireOutput(`async run ${run.id} completed and actor exited`, completion.output, pattern);
      return;
    }
    // Result publication is not process exit; retain resources until final actor writes finish.
    // oxlint-disable-next-line no-await-in-loop
    await delay(100, undefined, { signal });
  }
  throw new Error(
    `async run ${run.id} did not complete and exit after ${timeoutMs}ms (last state: ${lastState}).`,
  );
}

async function runLiveSmoke(options, runOptions, agentDir) {
  const copiedAuthFiles = copyLiveAuth(agentDir);
  if (copiedAuthFiles.length > 0) {
    console.log(
      `[real-pi-smoke] copied ${copiedAuthFiles.join(" and ")} into isolated Pi agent dir for live provider auth`,
    );
  }
  const childModelInstruction = process.env.PI_REAL_SMOKE_MODEL
    ? ` Pass model '${process.env.PI_REAL_SMOKE_MODEL}' to every delegate call.`
    : "";
  await runBasicLiveSmoke(runOptions, childModelInstruction);
  if (options.llmFull) {
    await runFullLiveSmoke(runOptions, childModelInstruction);
  }
  auditSavedModels(
    [join(runOptions.root, "sessions"), join(agentDir, "sessions", "agent-runs")],
    process.env.PI_REAL_SMOKE_MODEL,
  );
}

function toolDetails(events, name) {
  return events
    .filter((event) => event.type === "tool_execution_end" && event.toolName === name)
    .map((event) => event.result?.details);
}

function requireCompleted(run, expected) {
  if (run?.status !== "completed" || run.output?.text !== expected) {
    throw new Error(`Native child did not complete with expected output: ${expected}`);
  }
}

async function runBasicLiveSmoke(runOptions, childModelInstruction) {
  const prompts = [
    [
      "intercom",
      "Call the intercom tool with action status. Reply exactly 'real-pi-smoke intercom ok' only if it reports 'Connected: Yes'.",
      "intercom",
    ],
    [
      "list",
      "Call agent_runs with action list. Reply exactly 'real-pi-smoke list ok' only if it successfully returns a saved-run list. There are no profiles to discover.",
      "agent_runs",
    ],
    [
      "foreground",
      `Call delegate with prompt 'Reply exactly: real-pi-smoke foreground ok', name 'smoke-foreground', and async false.${childModelInstruction} Reply exactly 'real-pi-smoke foreground ok' only if the actual child result contains it.`,
      "delegate",
    ],
  ];
  for (const [kind, prompt, tool] of prompts) {
    // Keep separate native parent sessions so each smoke owns its saved runs.
    // oxlint-disable-next-line no-await-in-loop
    const result = await runLivePrompt(`real Pi ${kind} prompt`, prompt, runOptions, tool);
    if (kind === "foreground") {
      requireCompleted(toolDetails(result.events, "delegate")[0], "real-pi-smoke foreground ok");
    }
    requireOutput(`real Pi ${kind} prompt`, result.text, new RegExp(`real-pi-smoke ${kind} ok`));
  }
  const result = await runLivePrompt(
    "real Pi async prompt",
    `Call delegate with prompt 'Reply exactly: real-pi-smoke async ok', name 'smoke-async', and async true.${childModelInstruction} Do not wait or call agent_runs. Reply exactly 'real-pi-smoke async launched ok' after receiving a launch receipt, not claiming completion.`,
    runOptions,
    "delegate",
  );
  requireOutput("real Pi async prompt", result.text, /real-pi-smoke async launched ok/);
  const receipt = toolDetails(result.events, "delegate")[0];
  if (receipt?.receipt !== "launch" || !receipt.id || !receipt.sessionFile) {
    throw new Error("Native delegate did not return a saved asynchronous launch receipt");
  }
  await waitForAsyncCompletion(receipt, /^real-pi-smoke async ok$/m, runOptions);
}

async function runFullLiveSmoke(runOptions, childModelInstruction) {
  const prompt = `First call delegate with prompt 'Reply exactly CALIBRATION_FACT=packed-otter-7319', name 'fact', context fresh and async false.${childModelInstruction} Then call delegate with context fork, async false, and prompt 'Read the preceding delegate tool result in inherited conversation. Without tools, filesystem reads, or guessing, return the CALIBRATION_FACT line exactly; return FACT_NOT_VISIBLE if absent.' Finally call agent_runs with action continue, the first saved run id, async false, and prompt 'Without tools, repeat the CALIBRATION_FACT line from your own saved conversation exactly.' Reply exactly 'real-pi-smoke fork ok' only if both the forked child and continued child actually return CALIBRATION_FACT=packed-otter-7319. There are no profiles, task prefixes, output settings, or canned role instructions.`;
  const result = await runLivePrompt("real Pi fork prompt", prompt, runOptions, "delegate");
  const delegates = toolDetails(result.events, "delegate");
  const continuation = toolDetails(result.events, "agent_runs")[0];
  for (const run of [...delegates, continuation]) {
    requireCompleted(run, "CALIBRATION_FACT=packed-otter-7319");
  }
  if (
    delegates.length !== 2 ||
    delegates[0].context !== "fresh" ||
    delegates[1].context !== "fork" ||
    continuation.predecessor !== delegates[0].id ||
    continuation.sessionFile !== delegates[0].sessionFile
  ) {
    throw new Error(
      "Fork/continuation smoke did not execute the two contexts and reuse the first saved conversation",
    );
  }
  requireOutput("real Pi fork prompt", result.text, /real-pi-smoke fork ok/);
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
        "[real-pi-smoke] live model subagent prompts skipped; pass --llm to exercise foreground/async paths.",
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
