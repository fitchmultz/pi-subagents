import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { findPackageJSON } from "node:module";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";

const [mode, root, repo, sdkRoot] = process.argv.slice(2);
assert.ok(["queue", "reopen", "again"].includes(mode));
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PI_SUBAGENT_")) {
    delete process.env[key];
  }
}
Object.assign(process.env, {
  HOME: path.join(root, "home"),
  PI_CODING_AGENT_DIR: path.join(root, "agent"),
  PI_SUBAGENT_TEMP_ROOT: path.join(root, "pi-subagents-runtime"),
  PI_PACKAGE_DIR: sdkRoot,
  PI_OFFLINE: "1",
});
const cwd = path.join(root, "cwd");
fs.mkdirSync(cwd, { recursive: true });
const sdkEntry = pathToFileURL(path.join(sdkRoot, "dist/index.js"));
const sdk = await import(sdkEntry.href);
const ai = await import(
  pathToFileURL(
    path.join(path.dirname(findPackageJSON("@earendil-works/pi-ai", sdkEntry)), "dist/index.js"),
  ).href
);
const { default: register } = await import(
  pathToFileURL(path.join(repo, "src/extension/index.ts")).href
);
const { RESULTS_DIR } = await import(pathToFileURL(path.join(repo, "src/shared/types.ts")).href);
const { getRunMetadataDir } = await import(
  pathToFileURL(path.join(repo, "src/runs/shared/supervisor-questions.ts")).href
);
const stateFile = path.join(root, "state.json");
const saved = mode === "queue" ? undefined : JSON.parse(fs.readFileSync(stateFile, "utf8"));
const manager = saved
  ? sdk.SessionManager.open(saved.sessionFile)
  : sdk.SessionManager.create(cwd, path.join(root, "sessions"));
if (!saved) {
  manager.appendMessage(ai.fauxAssistantMessage("Preserve the legacy result"));
}
const runId = saved?.runId ?? randomUUID();
const hint = path.join(RESULTS_DIR, `${runId}.json`);
const result = saved?.result ?? {
  id: runId,
  sessionId: manager.getSessionId(),
  mode: "single",
  state: "complete",
  success: true,
  timestamp: Date.now(),
  summary: "LEGACY_COLD_RESULT",
  results: [{ agent: "legacy-worker", success: true, output: "LEGACY_COLD_RESULT" }],
};
const settingsManager = sdk.SettingsManager.inMemory({
  retry: { enabled: false },
  compaction: { enabled: false },
  cacheWarming: { enabled: false },
});
const sent = [],
  errors = [];
const loader = new sdk.DefaultResourceLoader({
  cwd,
  agentDir: process.env.PI_CODING_AGENT_DIR,
  settingsManager,
  noExtensions: true,
  noSkills: true,
  noContextFiles: true,
  noThemes: true,
  noPromptTemplates: true,
  extensionFactories: [
    (pi) => {
      const send = pi.sendMessage.bind(pi);
      // Observe actual native notification calls and forward them; pi is this factory's SDK boundary.
      pi.sendMessage = (message, options) => {
        if (message.customType === "subagent-notify") {
          sent.push(message);
        }
        send(message, options);
      };
      register(pi);
    },
  ],
});
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const faux = ai.fauxProvider({ provider: "legacy-cold-fixture", tokensPerSecond: 1000000 });
let entered = false;
faux.setResponses(
  mode === "queue"
    ? [
        async (_context, options) => {
          entered = true;
          await new Promise((resolve) =>
            options.signal.addEventListener("abort", resolve, { once: true }),
          );
          return ai.fauxAssistantMessage("Interrupted");
        },
      ]
    : [ai.fauxAssistantMessage("Legacy completion read")],
);
const modelRuntime = await sdk.ModelRuntime.create({
  credentials: new ai.InMemoryCredentialStore(),
  modelsPath: null,
  refreshOnCreate: false,
});
modelRuntime.registerNativeProvider(faux.provider);
const { session } = await sdk.createAgentSession({
  cwd,
  agentDir: process.env.PI_CODING_AGENT_DIR,
  settingsManager,
  resourceLoader: loader,
  sessionManager: manager,
  modelRuntime,
  model: faux.getModel(),
});
const until = async (predicate, reason) => {
  const deadline = performance.now() + 7000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, reason);
    // Observe native queue/publication progress before checking the next checkpoint.
    // oxlint-disable-next-line no-await-in-loop
    await delay(10);
  }
};
const notices = () =>
  fs
    .readFileSync(manager.getSessionFile(), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.type === "custom_message" && entry.customType === "subagent-notify");
const owners = () =>
  manager
    .getEntries()
    .filter((entry) => entry.type === "custom" && entry.customType === "subagent-run");
try {
  if (mode === "again") {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    fs.writeFileSync(hint, JSON.stringify(result));
  }
  await session.bindExtensions({ mode: "json", onError: (error) => errors.push(String(error)) });
  if (mode === "queue") {
    void session.prompt("Hold before the native queue is consumed");
    await until(() => entered, "held native provider request");
    fs.writeFileSync(hint, JSON.stringify(result));
    await until(
      () => sent.length === 1 && session.agent.hasQueuedMessages(),
      "legacy completion enters the real native queue",
    );
    const proof = {
      mode,
      hintExists: fs.existsSync(hint),
      canonicalExists: fs.existsSync(path.join(getRunMetadataDir(runId), "result.json")),
      queued: session.agent.hasQueuedMessages(),
      persistedNotices: notices().length,
      ownedEntries: owners().length,
      sent: sent.length,
      calls: faux.state.callCount,
      errors,
    };
    fs.writeFileSync(
      stateFile,
      JSON.stringify({ runId, result, sessionFile: manager.getSessionFile() }),
    );
    fs.writeFileSync(path.join(root, "queue-proof.json"), JSON.stringify(proof));
    process.kill(process.pid, "SIGKILL");
  }
  if (mode === "reopen") {
    await until(() => sent.length === 1, "fresh-process recovery delivers the legacy completion");
    await session.waitForIdle();
    await until(() => !fs.existsSync(hint), "only the actual durable receipt retires legacy input");
    const proof = {
      mode,
      hintExists: fs.existsSync(hint),
      sent: sent.length,
      calls: faux.state.callCount,
      persistedNotices: notices().length,
      ownedEntries: owners().length,
      errors,
    };
    fs.writeFileSync(path.join(root, "reopen-proof.json"), JSON.stringify(proof));
    assert.equal(
      proof.persistedNotices,
      1,
      "fresh-process recovery must preserve the only legacy result",
    );
    assert.equal(proof.sent, 1);
    assert.equal(proof.calls, 1);
  } else {
    await until(
      () => !fs.existsSync(hint),
      "a published native receipt consumes a recreated legacy hint",
    );
    await delay(100);
    const proof = {
      mode,
      sent: sent.length,
      calls: faux.state.callCount,
      persistedNotices: notices().length,
      ownedEntries: owners().length,
      errors,
    };
    fs.writeFileSync(path.join(root, "again-proof.json"), JSON.stringify(proof));
    assert.equal(proof.sent, 0);
    assert.equal(proof.calls, 0);
    assert.equal(proof.persistedNotices, 1);
  }
  assert.equal(owners().length, 0, "legacy recovery does not fabricate run ownership");
  assert.deepEqual(errors, []);
} finally {
  await session.abort();
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
}
