import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { findPackageJSON } from "node:module";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const [mode, directory, sourceSession] = process.argv.slice(2);
assert.ok(mode && directory && process.send, "Run this fixture through the native intercom test");
const repo = fileURLToPath(new URL("../../", import.meta.url));
const sdkRoot = process.env.PI_INTERCOM_TEST_SDK ?? path.dirname(findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url));
const sdkEntry = pathToFileURL(path.join(sdkRoot, "dist/index.js"));
const aiRoot = path.dirname(findPackageJSON("@earendil-works/pi-ai", sdkEntry));
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(sdkEntry.href);
const { fauxProvider, fauxAssistantMessage, InMemoryCredentialStore } = await import(pathToFileURL(path.join(aiRoot, "dist/index.js")).href);
mkdirSync(directory, { recursive: true });
const faux = fauxProvider({ provider: "fixture-restart" });
const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
modelRuntime.registerNativeProvider(faux.provider);
const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
let context;
const errors = [];
const loader = new DefaultResourceLoader({
  cwd: directory, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager,
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  systemPrompt: "Native restart regression fixture.",
  additionalExtensionPaths: [process.env.PI_INTERCOM_TEST_EXTENSION ?? path.join(repo, "src/pi-intercom/index.ts")],
  extensionFactories: [(pi) => pi.on("session_start", (_event, ctx) => {
    context = ctx;
    pi.setSessionName("restart-parent");
  })],
});
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const sessionManager = mode === "fork"
  ? SessionManager.forkFrom(sourceSession, directory, path.join(directory, "sessions"))
  : mode === "resume"
    ? SessionManager.open(sourceSession)
    : SessionManager.create(directory, path.join(directory, "sessions"));
const { session } = await createAgentSession({
  cwd: directory, agentDir: process.env.PI_CODING_AGENT_DIR,
  modelRuntime, model: faux.getModel(), settingsManager, resourceLoader: loader, sessionManager, noTools: "builtin",
});
const summary = async () => {
  const intercom = session.agent.state.tools.find((tool) => tool.name === "intercom");
  const status = await intercom.execute("fixture-status", { action: "status" }, new AbortController().signal);
  const entries = sessionManager.getEntries();
  return {
    sessionId: sessionManager.getSessionId(),
    sessionFile: sessionManager.getSessionFile(),
    modelCalls: faux.state.callCount,
    nativeQueued: session.agent.hasQueuedMessages(),
    publicPending: context.hasPendingMessages(),
    status: JSON.stringify(status),
    visibleIds: entries.filter((entry) => entry.type === "custom_message" && entry.customType === "intercom_message").map((entry) => entry.details.message.id),
    checkpointOwners: [...new Set(entries.filter((entry) => entry.type === "custom" && entry.customType === "intercom_delivery").map((entry) => entry.data.sessionId))],
    errors,
  };
};

if (mode === "seed") {
  faux.setResponses([
    fauxAssistantMessage("Saved conversation ready"),
    async (_context, options) => {
      process.send({ type: "ready", ...(await summary()) });
      await new Promise((resolve) => options.signal.addEventListener("abort", resolve, { once: true }));
      return fauxAssistantMessage("Aborted");
    },
  ]);
} else {
  faux.setResponses([fauxAssistantMessage("Recovered pending messages")]);
}
await session.bindExtensions({ mode: "rpc", uiContext: { ...session.extensionRunner.getUIContext() }, onError: (error) => errors.push(error) });

if (mode === "seed") {
  process.on("message", async (message) => {
    if (message?.action === "snapshot") process.send({ type: "snapshot", ...(await summary()) });
  });
  await session.prompt("Seed this saved session");
  // The test kills this process while native queues and intercom staging are pending.
  await session.prompt("Hold an unfinished provider request");
} else {
  // Let the restored delivery timer and its native run finish; zero calls is expected for fork/new and a second resume.
  await sleep(350);
  await session.waitForIdle();
  const result = await summary();
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  await session.abort();
  session.dispose();
  process.send({ type: "result", ...result });
  process.disconnect();
}
