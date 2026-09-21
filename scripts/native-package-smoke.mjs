// Full runtime-only package: native SDK + bundled CLI, one private Intercom broker, no model calls.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { hostCli, hostIndex, hostRoot } from "./compat-host.mjs";

const packageRoot = resolve(process.argv[2] ?? ".");
const root = mkdtempSync(join(tmpdir(), "ps-native-"));
const agentDir = join(root, "agent");
mkdirSync(agentDir);
Object.assign(process.env, { HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: agentDir, PI_SUBAGENT_TEMP_ROOT: join(root, "pi-subagents-runs"), PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_PACKAGE_DIR: hostRoot });
// A pruned extension cannot discover the embedding SDK via its own node_modules or PATH.
// PI_PACKAGE_DIR is the existing detached-runtime host contract, not a loader workaround.
const sdk = await import(pathToFileURL(hostIndex).href);
const broker = spawn(process.execPath, [join(packageRoot, "dist/pi-intercom/broker/broker.js")], { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
let brokerLog = "";
broker.stdout.on("data", data => { brokerLog += data; });
broker.stderr.on("data", data => { brokerLog += data; });
let session;
try {
  for (let i = 0; !brokerLog.includes("Intercom broker started"); i++) {
    assert.ok(i < 100 && broker.exitCode === null, brokerLog || "Private broker did not start");
    await delay(50);
  }
  const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true, additionalExtensionPaths: [packageRoot] });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.equal(loader.getExtensions().extensions.length, 2);
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models-store.json"), allowModelNetwork: false });
  ({ session } = await sdk.createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader: loader, modelRuntime, sessionManager: sdk.SessionManager.create(root, join(root, "sessions")), noTools: "builtin" }));
  const errors = [];
  await session.bindExtensions({ mode: "print", onError: error => errors.push(error) });
  for (const name of ["delegate", "agent_runs", "load_subagent", "intercom"]) assert.ok(session.getActiveToolNames().includes(name), name);
  const status = await session.agent.state.tools.find(tool => tool.name === "intercom").execute("status", { action: "status" }, new AbortController().signal);
  assert.match(JSON.stringify(status.content), /Connected: Yes/);
  assert.deepEqual(errors, []);
  if (process.env.PI_COMPAT_HOST === "fork") {
    assert.equal(typeof session.acquireCheckpoint, "function", "fork checkpoint hook is required");
    const hold = await session.acquireCheckpoint({ quiesce: () => () => {}, signal: AbortSignal.timeout(10_000) });
    try { assert.equal(hold.sleepReady, true, JSON.stringify(hold.sleepBlockers)); }
    finally { hold.release(); }
  }
  const marker = join(root, "cli.json");
  const observer = join(root, "observer.ts");
  writeFileSync(observer, `import { writeFileSync } from "node:fs";
export default function(pi) { pi.on("session_start", (_event, ctx) => {
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ tools: pi.getActiveTools(), commands: pi.getCommands().map(c => c.name) }));
ctx.shutdown();
}); }`);
  const cliEnv = { ...process.env };
  delete cliEnv.PI_PACKAGE_DIR; // Ordinary CLI consumers locate their host through argv, unlike detached SDK embeddings.
  const child = spawnSync(process.execPath, [hostCli, "--mode", "rpc", "--no-session", "-ne", "-ns", "-np", "-nc", "--no-themes", "--approve", "-e", packageRoot, "-e", observer], { cwd: root, env: cliEnv, input: "", encoding: "utf8", timeout: 30_000 });
  assert.equal(child.status, 0, `${child.error ?? ""}\n${child.stderr}`);
  assert.doesNotMatch(child.stderr, /Failed to load extension|ERR_INTERNAL_ASSERTION|Extension error/);
  const observed = JSON.parse(readFileSync(marker, "utf8"));
  for (const name of ["delegate", "agent_runs", "load_subagent", "intercom"]) assert.ok(observed.tools.includes(name), name);
  assert.ok(observed.commands.includes("subagents-doctor"));
  console.log("[native-package-smoke] both compiled entries, broker registration/status, bundled RPC startup, and shutdown passed");
} finally {
  try {
    if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
  } finally {
    if (broker.exitCode === null) { const exited = once(broker, "exit"); broker.kill("SIGTERM"); await exited; }
    rmSync(root, { recursive: true, force: true });
  }
}
