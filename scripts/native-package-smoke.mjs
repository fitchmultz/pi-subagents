// Runtime-only package probe: selected native SDK/CLI, real packed actor and private broker.
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
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
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { hostCli, hostIndex, hostRoot } from "./compat-host.mjs";
import { SmokeProcesses } from "./real-pi-processes.mjs";
import { assertChildJournal, assertObservations } from "./native-package-smoke-assertions.mjs";

/** @type {(file: string, args: readonly string[], options: import("node:child_process").ExecFileOptions) => Promise<{ stdout: string, stderr: string }>} */
// oxlint-disable-next-line typescript/strict-void-return
const execFile = promisify(execFileCallback);

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(
    "Usage: node scripts/native-package-smoke.mjs [package-root]\n\nLoad the single compiled entry using the selected native host. Exercise all three eager package tools and a real actor prompt/toolResult/completion with a credential-free provider, then verify bundled CLI startup and shutdown. No paid model calls.\nExit codes: 0 passed; 1 native execution or cleanup failed.",
  );
  process.exit(0);
}

const packageRoot = realpathSync(resolve(process.argv[2] ?? "."));
const consumerDir = process.argv[3];
const consumerScript = process.argv[4];
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
/** @type {typeof import("@earendil-works/pi-coding-agent")} */
// oxlint-disable-next-line typescript/no-unsafe-assignment
const sdk = await import(pathToFileURL(hostIndex).href);
/** @type {typeof import("@earendil-works/pi-ai")} */
// oxlint-disable-next-line typescript/no-unsafe-assignment
const ai = await import(import.meta.resolve("@earendil-works/pi-ai"));
/**
 * The intercom context snapshot the consumer fixture answers with.
 * @typedef {object} IntercomContextSnapshot
 * @property {boolean | undefined} connected
 * @property {string | undefined} peerId
 * @property {string | undefined} rootSessionId
 * @property {number | undefined} incarnation
 */
const selected = ai.fauxProvider({ provider: "packed-probe", models: [{ id: "native" }] });
const processes = new SmokeProcesses({
  cwd: root,
  env: process.env,
  root,
  timeoutMs: 60_000,
  signal: new AbortController().signal,
});
/** @type {import("@earendil-works/pi-coding-agent").AgentSession | undefined} */ let session;
let watchdog;
/** @type {unknown} */ let brokerError;
/** @type {import("@earendil-works/pi-coding-agent").EventBus | undefined} */ let intercomEvents;
const brokerRun = processes
  .run("private broker", process.execPath, [join(packageRoot, "dist/pi-intercom/broker/broker.js")])
  .catch((/** @type {unknown} */ error) => {
    brokerError = error;
  });
const brokerReadinessMessage = () => {
  if (brokerError === undefined) {
    return "Private broker did not publish readiness";
  }
  return brokerError instanceof Error ? brokerError.message : JSON.stringify(brokerError);
};
const runtimeDir = process.env.PI_INTERCOM_RUNTIME_DIR;
if (runtimeDir === undefined) {
  throw new Error("PI_INTERCOM_RUNTIME_DIR is required");
}
try {
  const deadline = Date.now() + 10_000;
  while (!existsSync(join(runtimeDir, "broker.pid"))) {
    assert.ok(brokerError === undefined && Date.now() < deadline, brokerReadinessMessage());
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
    extensionFactories:
      consumerScript !== undefined
        ? [
            (/** @type {import("@earendil-works/pi-coding-agent").ExtensionAPI} */ pi) => {
              intercomEvents = pi.events;
            },
          ]
        : [],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.deepEqual(loader.getExtensions().warnings ?? [], []);
  assert.equal(
    loader.getExtensions().extensions.length,
    consumerScript !== undefined ? 3 : 2,
    "one package entry plus credential-free provider and optional client observer fixtures",
  );
  const modelRuntime = await sdk.ModelRuntime.create({
    credentials: new ai.InMemoryCredentialStore(),
    refreshOnCreate: false,
    modelsPath: null,
    modelsStorePath: join(agentDir, "models-store.json"),
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(selected.provider);
  session = (
    await sdk.createAgentSession({
      cwd: root,
      agentDir,
      settingsManager,
      resourceLoader: loader,
      modelRuntime,
      model: selected.getModel(),
      thinkingLevel: "off",
      sessionManager: sdk.SessionManager.create(root, join(root, "sessions")),
      noTools: "builtin",
    })
  ).session;
  /** @type {unknown[]} */ const errors = [];
  await session.bindExtensions({
    mode: "print",
    onError: (error) => {
      errors.push(error);
    },
  });
  assert.deepEqual(
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- assert generic inference already matches
    [...session.getActiveToolNames()].sort(),
    expectedTools,
    "exactly three eager package tools",
  );
  const execute = (/** @type {string} */ name, /** @type {Record<string, unknown>} */ input) => {
    assert.ok(session !== undefined, "expected a created agent session");
    const tool = session.agent.state.tools.find((candidate) => candidate.name === name);
    assert.ok(tool !== undefined, `expected the ${name} package tool`);
    return tool.execute(`probe-${name}`, input, new AbortController().signal);
  };
  const status = await execute("intercom", { action: "status" });
  assert.match(JSON.stringify(status.content), /Connected: Yes/);
  const runs = await execute("agent_runs", { action: "list" });
  /** @type {{ total: number, runs: unknown[] }} */
  // oxlint-disable-next-line typescript/no-unsafe-assignment
  const listDetails = runs.details;
  assert.equal(listDetails.total, 0);
  assert.equal(session.model?.provider, "packed-probe");
  assert.equal(session.model.id, "native");
  /** @type {import("@earendil-works/pi-coding-agent").AgentSessionEvent[]} */ const events = [];
  session.subscribe((event) => {
    events.push(event);
  });
  watchdog = setTimeout(() => {
    // Fire-and-forget by design: the watchdog only interrupts a stuck turn.
    // oxlint-disable-next-line typescript/no-floating-promises
    void session?.abort();
  }, 30_000);
  await session.prompt("Exercise the packed native delegate.", { expandPromptTemplates: false });
  const relevantEvents = () =>
    events.filter(
      (event) =>
        (event.type === "message_end" && event.message.role === "assistant") ||
        event.type === "tool_execution_end",
    );

  await session.waitForIdle();
  assert.equal(
    session.getLastAssistantText(),
    "PACKED_LAUNCH_RECEIPT_SEEN",
    JSON.stringify({ errors, messages: relevantEvents() }),
  );
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
    JSON.stringify({ errors, messages: relevantEvents() }),
  );
  const starts = events.filter(
    (event) => event.type === "tool_execution_start" && event.toolName === "delegate",
  );
  assert.equal(starts.length, 1, "one real native delegate call, no fabricated wire events");
  const receipt =
    /** @type {{ isError?: boolean, result?: { details?: { receipt?: string, id?: string } } } | undefined} */ (
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the packed event shape is not exported by the SDK
      events.find((event) => event.type === "tool_execution_end" && event.toolName === "delegate")
    );
  assert.ok(receipt !== undefined && receipt.isError !== true, JSON.stringify(receipt));
  assert.equal(receipt.result?.details?.receipt, "launch");
  /** @type {{ status: string, output: { text: string }, sessionFile: string, result?: { terminalEntryId?: string } }} */
  // oxlint-disable-next-line typescript/no-unnecessary-condition, typescript/no-unsafe-assignment -- cast-type optionality is not modelled by the checker
  const run = (await execute("agent_runs", { action: "inspect", id: receipt.result?.details?.id }))
    .details;
  assert.equal(run.status, "completed");
  assert.equal(run.output.text, "PACKED_NATIVE_COMPLETE");
  assertChildJournal(run.sessionFile, run.result?.terminalEntryId, "PACKED_NATIVE_COMPLETE");
  assertObservations(observations);
  assert.equal(networkAttempts, 0);
  assert.deepEqual(errors, []);

  if (consumerScript !== undefined) {
    assert.ok(intercomEvents !== undefined, "expected the consumer observer extension");
    assert.ok(consumerDir !== undefined, "expected the consumer script directory argument");
    /** @type {IntercomContextSnapshot | undefined} */ let target;
    intercomEvents.emit("pi-intercom:context-query", {
      version: 1,
      respond: (/** @type {IntercomContextSnapshot} */ snapshot) => {
        target = snapshot;
      },
    });
    assert.ok(
      target?.connected === true &&
        target.peerId !== undefined &&
        target.rootSessionId !== undefined &&
        target.incarnation !== undefined,
    );
    const guard = {
      rootSessionId: target.rootSessionId,
      peerId: target.peerId,
      incarnation: target.incarnation,
      applicationGuard: "package-consent-1",
    };
    /** @type {{ applicationGuard?: string } | undefined} */ let consent;
    intercomEvents.emit("pi-intercom:application-guard", {
      version: 1,
      target: guard,
      revision: guard.applicationGuard,
      respond: (/** @type {{ applicationGuard?: string }} */ result) => {
        consent = result;
      },
    });
    assert.ok(consent !== undefined, "the consumer answered the guard query");
    assert.equal(consent.applicationGuard, guard.applicationGuard);
    const consumerHome = join(root, "consumer-home");
    mkdirSync(consumerHome);
    const brokerPid = Number(readFileSync(join(runtimeDir, "broker.pid"), "utf8").split("\n")[0]);
    const consumerOptions = {
      cwd: consumerDir,
      env: {
        HOME: consumerHome,
        PATH: process.env.PATH,
        PI_CODING_AGENT_DIR: join(consumerHome, "agent"),
        PI_INTERCOM_RUNTIME_DIR: runtimeDir,
        S3_ROOT: guard.rootSessionId,
        S3_PEER: guard.peerId,
        S3_INCARNATION: String(guard.incarnation),
        S3_GUARD: guard.applicationGuard,
        S3_BROKER_PID: String(brokerPid),
      },
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    };
    const turns = events.filter((event) => event.type === "turn_start").length;
    try {
      const { stdout, stderr } = await execFile(
        process.execPath,
        [
          "--permission",
          "--allow-fs-read=*",
          "--allow-fs-write=*",
          "--input-type=module",
          "-e",
          readFileSync(consumerScript, "utf8"),
        ],
        consumerOptions,
      );
      process.stdout.write(stdout);
      process.stderr.write(stderr);
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- assert generic inference already matches
      assert.equal(events.filter((event) => event.type === "turn_start").length, turns);
    } finally {
      // The consumer's failure/timeout must never leave this fixture's broker stopped.
      process.kill(brokerPid, "SIGCONT");
    }
  }

  const marker = join(root, "cli.json");
  const observer = join(root, "observer.mjs");
  writeFileSync(
    observer,
    `import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { Type } from "typebox";
import { Assert } from "typebox/value";
import * as PiSDK from "@earendil-works/pi-coding-agent";
import { Type as AgentType, Assert as AgentAssert } from ${JSON.stringify(pathToFileURL(join(packageRoot, "dist/agent/typebox.js")).href)};
import { loadSDK, packageRoot as selectedRoot } from ${JSON.stringify(pathToFileURL(join(packageRoot, "dist/agent/host.js")).href)};
export default function(pi) {
  // Native development graphs can resolve local peers before Jiti runs.
  // Production-only installs must instead reuse the bundled host's virtual modules.
  if (${!existsSync(join(packageRoot, "node_modules/typebox"))}) {
    assert.equal(AgentType, Type, "extension schemas reuse Pi's TypeBox instance");
    assert.equal(AgentAssert, Assert, "extension validation reuses Pi's TypeBox instance");
  }
  pi.on("session_start", async (_event, ctx) => {
    // Delegation, /agents and parked history load the SDK through this adapter. Jiti wraps
    // each importer's namespace, so compare the session class delegation constructs.
    const sdkReused = (await loadSDK(selectedRoot())).SessionManager === PiSDK.SessionManager;
    writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ tools: pi.getActiveTools(), sdkReused }));
    ctx.shutdown();
  });
}`,
  );
  /** @type {typeof process.env} */ const cliEnv = {
    ...process.env,
    PATH:
      process.platform === "android" ? `${dirname(process.execPath)}:/system/bin` : "/usr/bin:/bin",
  };
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
    /** @type {{ tools: string[], sdkReused: boolean }} */
    // oxlint-disable-next-line typescript/no-unsafe-assignment
    const cli = JSON.parse(readFileSync(marker, "utf8"));
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- assert generic inference already matches
    assert.deepEqual(cli.tools.sort(), expectedTools);
    if (!existsSync(join(packageRoot, "node_modules/@earendil-works/pi-coding-agent"))) {
      assert.equal(cli.sdkReused, true, "production-only installs reuse Pi's loaded SDK");
    }
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
