// Runtime-only package probe: selected native SDK/CLI, real packed actor and private broker.
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { hostCli, hostIndex, hostRoot } from "./compat-host.mjs";
import { SmokeProcesses } from "./real-pi-processes.mjs";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(
    "Usage: node scripts/native-package-smoke.mjs [package-root]\n\nLoad the single compiled entry using the selected native host. Exercise all three eager package tools and a real actor prompt/toolResult/completion with a credential-free provider, then verify bundled CLI startup and shutdown. No paid model calls.\nExit codes: 0 passed; 1 native execution or cleanup failed.",
  );
  process.exit(0);
}

const packageRoot = realpathSync(resolve(process.argv[2] ?? "."));
const root = mkdtempSync(join(tmpdir(), "ps-native-"));
const agentDir = join(root, "agent");
mkdirSync(join(agentDir, "extensions"), { recursive: true });
for (const key of Object.keys(process.env)) {
  if (
    key.startsWith("PI_SUBAGENT_") ||
    key.startsWith("PI_INTERCOM_") ||
    /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|API_KEY)/.test(key)
  ) {
    delete process.env[key];
  }
}
Object.assign(process.env, {
  HOME: root,
  USERPROFILE: root,
  PI_CODING_AGENT_DIR: agentDir,
  PI_INTERCOM_RUNTIME_DIR: join(root, "ic"),
  PI_OFFLINE: "1",
  PI_TELEMETRY: "0",
  PI_PACKAGE_DIR: hostRoot,
});
let networkAttempts = 0;
globalThis.fetch = async () => {
  networkAttempts++;
  throw new Error("Native package smoke forbids all network requests");
};
const expectedTools = ["agent_runs", "delegate", "intercom"];
const prompt =
  "Return exactly PACKED_NATIVE_COMPLETE after calling packed_probe once with value native-tool-input. No other tools.";
const observations = join(root, "provider.jsonl");
const hostRequire = createRequire(hostIndex);
writeFileSync(
  join(agentDir, "extensions", "provider.js"),
  `
import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, getCurrentTools } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
import { Type } from ${JSON.stringify(pathToFileURL(hostRequire.resolve("typebox")).href)};
export default function(pi) {
  const child = Boolean(process.env.PI_INTERCOM_PARENT_SESSION_ID);
  const faux = fauxProvider({ provider: "packed-probe", models: [{ id: "native" }], tokensPerSecond: 1000000 });
  const observe = (value) => appendFileSync(${JSON.stringify(observations)}, JSON.stringify({ child, pid: process.pid, ...value }) + "\\n");
  globalThis.fetch = async () => { observe({ networkAttempt: true }); throw new Error("Native package smoke forbids all network requests"); };
  pi.on("session_start", (_event, ctx) => {
    assert.equal(ctx.model?.provider, "packed-probe");
    assert.equal(ctx.model?.id, "native");
    if (child) {
      const launch = JSON.parse(readFileSync(join(dirname(ctx.sessionManager.getSessionFile()), "launch.json"), "utf8"));
      assert.equal(launch.provider, "packed-probe");
      assert.equal(launch.model, "native");
      assert.equal(launch.sdk, ${JSON.stringify(hostRoot)});
      assert.equal(launch.entry, ${JSON.stringify(join(packageRoot, "dist/index.js"))});
      observe({ modelBound: true });
    }
  });
  if (child) {
    pi.registerTool({ name: "packed_probe", label: "Packed probe", description: "Native package smoke only", parameters: Type.Object({ value: Type.String() }),
      async execute(_id, input) {
        assert.equal(input.value, "native-tool-input");
        observe({ toolExecuted: true });
        return { content: [{ type: "text", text: "PACKED_TOOL_RESULT" }], details: { native: true } };
      }
    });
  }
  faux.setResponses([
    (context, _options, _state, model) => {
      assert.equal(model.provider, "packed-probe");
      assert.equal(model.id, "native");
      const tools = getCurrentTools(context.messages).map(tool => tool.name);
      if (child) {
        assert.equal(tools.includes("delegate"), false);
        assert.equal(tools.includes("agent_runs"), false);
        assert.ok(tools.includes("intercom"));
        const user = context.messages.findLast(message => message.role === "user");
        assert.equal(typeof user.content === "string" ? user.content : user.content.map(part => part.text ?? "").join(""), ${JSON.stringify(prompt)});
      } else {
        assert.deepEqual([...tools].sort(), ${JSON.stringify(expectedTools)});
      }
      observe({ tools, requested: true });
      return fauxAssistantMessage(fauxToolCall(child ? "packed_probe" : "delegate", child ? { value: "native-tool-input" } : { prompt: ${JSON.stringify(prompt)}, name: "packed-native" }), { stopReason: "toolUse" });
    },
    (context) => {
      const result = context.messages.findLast(message => message.role === "toolResult");
      assert.equal(result?.isError ?? false, false);
      assert.equal(result?.toolName, child ? "packed_probe" : "delegate");
      // The parent gets only an honest launch receipt; the child's outcome arrives later.
      assert.ok(result.content.some(part => part.type === "text" && (child ? part.text.includes("PACKED_TOOL_RESULT") : part.text.includes("Launch accepted") && !part.text.includes("PACKED_NATIVE_COMPLETE"))));
      observe({ consumedResult: true, calls: faux.state.callCount });
      return fauxAssistantMessage(child ? "PACKED_NATIVE_COMPLETE" : "PACKED_LAUNCH_RECEIPT_SEEN");
    },
    ...(child ? [] : [(context) => {
      const notice = context.messages.at(-1);
      const text = typeof notice.content === "string" ? notice.content : notice.content.map(part => part.text ?? "").join("");
      assert.ok(text.includes(": completed. \\nPACKED_NATIVE_COMPLETE\\n"), text);
      observe({ consumedCompletion: true, calls: faux.state.callCount });
      return fauxAssistantMessage("PACKED_PARENT_COMPLETE");
    }])
  ]);
  pi.registerProvider(faux.provider);
}
`,
);
writeFileSync(
  join(agentDir, "settings.json"),
  JSON.stringify({
    packages: [packageRoot],
    compaction: { enabled: false },
    retry: { enabled: false },
  }),
);
const sdk = await import(pathToFileURL(hostIndex).href);
const ai = await import(import.meta.resolve("@earendil-works/pi-ai"));
const selected = ai.fauxProvider({ provider: "packed-probe", models: [{ id: "native" }] });
const processes = new SmokeProcesses({
  cwd: root,
  env: process.env,
  root,
  timeoutMs: 60_000,
  signal: new AbortController().signal,
});
let session;
let watchdog;
let brokerError;
const brokerRun = processes
  .run("private broker", process.execPath, [join(packageRoot, "dist/pi-intercom/broker/broker.js")])
  .catch((error) => {
    brokerError = error;
  });
try {
  const deadline = Date.now() + 10_000;
  while (!existsSync(join(process.env.PI_INTERCOM_RUNTIME_DIR, "broker.pid"))) {
    assert.ok(
      !brokerError && Date.now() < deadline,
      String(brokerError ?? "Private broker did not publish readiness"),
    );
    // Observe the broker's publication, not a sleep-based startup assumption.
    // oxlint-disable-next-line no-await-in-loop
    await delay(25);
  }
  const settingsManager = sdk.SettingsManager.create(root, agentDir, { projectTrusted: true });
  const loader = new sdk.DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    noSkills: true,
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.deepEqual(loader.getExtensions().warnings ?? [], []);
  assert.equal(
    loader.getExtensions().extensions.length,
    2,
    "one package entry plus credential-free provider fixture",
  );
  const modelRuntime = await sdk.ModelRuntime.create({
    credentials: new ai.InMemoryCredentialStore(),
    refreshOnCreate: false,
    modelsPath: null,
    modelsStorePath: join(agentDir, "models-store.json"),
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(selected.provider);
  ({ session } = await sdk.createAgentSession({
    cwd: root,
    agentDir,
    settingsManager,
    resourceLoader: loader,
    modelRuntime,
    model: selected.getModel(),
    thinkingLevel: "off",
    sessionManager: sdk.SessionManager.create(root, join(root, "sessions")),
    noTools: "builtin",
  }));
  const errors = [];
  await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
  assert.deepEqual(
    [...session.getActiveToolNames()].sort(),
    expectedTools,
    "exactly three eager package tools",
  );
  const execute = (name, input) =>
    session.agent.state.tools
      .find((tool) => tool.name === name)
      .execute(`probe-${name}`, input, new AbortController().signal);
  const status = await execute("intercom", { action: "status" });
  assert.match(JSON.stringify(status.content), /Connected: Yes/);
  const runs = await execute("agent_runs", { action: "list" });
  assert.equal(runs.details.total, 0);
  assert.equal(session.model?.provider, "packed-probe");
  assert.equal(session.model?.id, "native");
  const events = [];
  session.subscribe((event) => events.push(event));
  watchdog = setTimeout(() => {
    void session.abort();
  }, 30_000);
  await session.prompt("Exercise the packed native delegate.", { expandPromptTemplates: false });
  await session.waitForIdle();
  assert.equal(session.getLastAssistantText(), "PACKED_LAUNCH_RECEIPT_SEEN");
  const completionDeadline = Date.now() + 30_000;
  while (session.getLastAssistantText() !== "PACKED_PARENT_COMPLETE") {
    // Observe the native completion notification turn, not a fixed delay.
    assert.ok(
      Date.now() < completionDeadline,
      `native completion notification resumes the parent: ${JSON.stringify(session.messages.slice(-3))}`,
    );
    // oxlint-disable-next-line no-await-in-loop
    await delay(25);
  }
  await session.waitForIdle();
  clearTimeout(watchdog);
  assert.equal(
    session.getLastAssistantText(),
    "PACKED_PARENT_COMPLETE",
    JSON.stringify({
      errors,
      messages: events.filter(
        (event) =>
          (event.type === "message_end" && event.message?.role === "assistant") ||
          event.type === "tool_execution_end",
      ),
    }),
  );
  const starts = events.filter(
    (event) => event.type === "tool_execution_start" && event.toolName === "delegate",
  );
  assert.equal(starts.length, 1, "one real native delegate call, no fabricated wire events");
  const receipt = events.find(
    (event) => event.type === "tool_execution_end" && event.toolName === "delegate",
  );
  assert.ok(receipt && !receipt.isError, JSON.stringify(receipt));
  assert.equal(receipt.result.details.receipt, "launch");
  const run = (await execute("agent_runs", { action: "inspect", id: receipt.result.details.id }))
    .details;
  assert.equal(run.status, "completed");
  assert.equal(run.output.text, "PACKED_NATIVE_COMPLETE");
  const childEntries = readFileSync(run.sessionFile, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(
    childEntries.some(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        entry.message.toolName === "packed_probe" &&
        entry.message.content.some((part) => part.text === "PACKED_TOOL_RESULT"),
    ),
    "actual child journal contains its native tool result",
  );
  assert.ok(
    childEntries.some(
      (entry) =>
        entry.id === run.result.terminalEntryId &&
        entry.type === "message" &&
        entry.message.role === "assistant" &&
        entry.message.content.some((part) => part.text === "PACKED_NATIVE_COMPLETE"),
    ),
    "completion references an actually published child assistant entry",
  );
  const observed = readFileSync(observations, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(observed.filter((item) => item.child && item.modelBound).length, 1);
  assert.equal(observed.filter((item) => item.child && item.toolExecuted).length, 1);
  assert.equal(
    observed.filter((item) => item.child && item.consumedResult && item.calls === 2).length,
    1,
  );
  assert.equal(
    observed.filter((item) => !item.child && item.consumedResult && item.calls === 2).length,
    1,
  );
  assert.equal(
    observed.filter((item) => !item.child && item.consumedCompletion && item.calls === 3).length,
    1,
    "the parent is resumed exactly once by the native completion notification",
  );
  assert.equal(networkAttempts, 0);
  assert.equal(
    observed.some((item) => item.networkAttempt),
    false,
  );
  assert.deepEqual(errors, []);

  const marker = join(root, "cli.json");
  const observer = join(root, "observer.mjs");
  writeFileSync(
    observer,
    `import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { Type } from "typebox";
import { Assert } from "typebox/value";
import { Type as AgentType, Assert as AgentAssert } from ${JSON.stringify(pathToFileURL(join(packageRoot, "dist/agent/typebox.js")).href)};
export default function(pi) {
  // Native development graphs can resolve local peers before Jiti runs.
  // Production-only installs must instead reuse the bundled host's virtual modules.
  if (${!existsSync(join(packageRoot, "node_modules/typebox"))}) {
    assert.equal(AgentType, Type, "extension schemas reuse Pi's TypeBox instance");
    assert.equal(AgentAssert, Assert, "extension validation reuses Pi's TypeBox instance");
  }
  pi.on("session_start", (_event, ctx) => {
    writeFileSync(${JSON.stringify(marker)}, JSON.stringify(pi.getActiveTools()));
    ctx.shutdown();
  });
}`,
  );
  const cliEnv = { ...process.env, PATH: "/usr/bin:/bin" };
  delete cliEnv.PI_PACKAGE_DIR;
  const cliProcesses = new SmokeProcesses({
    cwd: root,
    env: cliEnv,
    root,
    timeoutMs: 30_000,
    signal: new AbortController().signal,
  });
  try {
    const output = await cliProcesses.run(
      "bundled RPC CLI",
      process.execPath,
      [
        hostCli,
        "--mode",
        "rpc",
        "--no-session",
        "-ne",
        "-ns",
        "-np",
        "-nc",
        "--no-themes",
        "--approve",
        "--tools",
        "delegate,agent_runs,intercom",
        "-e",
        packageRoot,
        "-e",
        observer,
      ],
      "",
    );
    assert.doesNotMatch(output, /Failed to load extension|ERR_INTERNAL_ASSERTION|Extension error/);
    assert.deepEqual(JSON.parse(readFileSync(marker, "utf8")).sort(), expectedTools);
  } finally {
    await cliProcesses.stop();
  }
  console.log(
    "[native-package-smoke] one compiled entry; exactly delegate/agent_runs/intercom eager; real native actor prompt, tool result and published completion; selected-host bundled CLI passed (local faux provider, zero paid/network model calls)",
  );
} finally {
  clearTimeout(watchdog);
  try {
    if (session) {
      await session.abort();
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
  } finally {
    await processes.stop();
    await brokerRun;
    rmSync(root, { recursive: true, force: true });
  }
}
