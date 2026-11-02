import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { findPackageJSON } from "node:module";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const [modeArgument, directoryArgument, sourceSession] = process.argv.slice(2);
const send = process.send?.bind(process);
if (send === undefined) {
  throw new Error("Run this fixture through the native intercom test");
}
assert.ok(
  // oxlint-disable-next-line typescript/strict-boolean-expressions -- fixture assert; also narrows for tsc
  modeArgument && directoryArgument,
  "Run this fixture through the native intercom test",
);
const mode = modeArgument;
const directory = directoryArgument;
const agentDir = process.env.PI_CODING_AGENT_DIR;
if (agentDir === undefined) {
  throw new Error("PI_CODING_AGENT_DIR is required");
}
const repo = fileURLToPath(new URL("../../", import.meta.url));
const sdkPackageJson = findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url);
if (sdkPackageJson === undefined) {
  throw new Error("Could not locate the installed pi-coding-agent package");
}
const sdkRoot = process.env.PI_INTERCOM_TEST_SDK ?? path.dirname(sdkPackageJson);
const sdkEntry = pathToFileURL(path.join(sdkRoot, "dist/index.js"));
const aiPackageJson = findPackageJSON("@earendil-works/pi-ai", sdkEntry);
if (aiPackageJson === undefined) {
  throw new Error("Could not locate the installed pi-ai package");
}
const aiRoot = path.dirname(aiPackageJson);
/** @type {typeof import("@earendil-works/pi-coding-agent")} */
// oxlint-disable-next-line typescript/no-unsafe-assignment
const sdk = await import(sdkEntry.href);
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } =
  sdk;
/** @type {typeof import("@earendil-works/pi-ai")} */
// oxlint-disable-next-line typescript/no-unsafe-assignment
const ai = await import(pathToFileURL(path.join(aiRoot, "dist/index.js")).href);
const { fauxProvider, fauxAssistantMessage, InMemoryCredentialStore } = ai;
mkdirSync(directory, { recursive: true });
const faux = fauxProvider({ provider: "fixture-restart" });
const modelRuntime = await ModelRuntime.create({
  credentials: new InMemoryCredentialStore(),
  modelsPath: null,
  refreshOnCreate: false,
});
modelRuntime.registerNativeProvider(faux.provider);
const settingsManager = SettingsManager.inMemory({
  compaction: { enabled: false },
  retry: { enabled: false },
});
/** @type {import("@earendil-works/pi-coding-agent").ExtensionContext | undefined} */ let context;
/** @type {import("@earendil-works/pi-coding-agent").EventBus | undefined} */ let intercomEvents;
/** @type {unknown[]} */ const errors = [];
const loader = new DefaultResourceLoader({
  cwd: directory,
  agentDir,
  settingsManager,
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
  systemPrompt: "Native restart regression fixture.",
  additionalExtensionPaths: [
    process.env.PI_INTERCOM_TEST_EXTENSION ?? path.join(repo, "src/pi-intercom/index.ts"),
  ],
  extensionFactories: [
    (/** @type {import("@earendil-works/pi-coding-agent").ExtensionAPI} */ pi) => {
      intercomEvents = pi.events;
      pi.on("session_start", (_event, ctx) => {
        context = ctx;
        pi.setSessionName("restart-parent");
      });
    },
  ],
});
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
function openSession() {
  if (mode === "fork") {
    assert.ok(sourceSession !== undefined, "fork mode requires a source session");
    return SessionManager.forkFrom(sourceSession, directory, path.join(directory, "sessions"));
  }
  if (mode === "resume") {
    assert.ok(sourceSession !== undefined, "resume mode requires a source session");
    return SessionManager.open(sourceSession);
  }
  return SessionManager.create(directory, path.join(directory, "sessions"));
}
const sessionManager = openSession();
const { session } = await createAgentSession({
  cwd: directory,
  agentDir,
  modelRuntime,
  model: faux.getModel(),
  settingsManager,
  resourceLoader: loader,
  sessionManager,
  noTools: "builtin",
});
const summary = async () => {
  assert.ok(context !== undefined, "expected the session_start context");
  assert.ok(intercomEvents !== undefined, "expected the intercom extension events");
  const events = intercomEvents;
  const intercom = session.agent.state.tools.find((tool) => tool.name === "intercom");
  assert.ok(intercom !== undefined, "expected the intercom tool");
  const status = await intercom.execute(
    "fixture-status",
    { action: "status" },
    new AbortController().signal,
  );
  const entries = sessionManager.getEntries();
  return {
    sessionId: sessionManager.getSessionId(),
    sessionFile: sessionManager.getSessionFile(),
    modelCalls: faux.state.callCount,
    nativeQueued: session.agent.hasQueuedMessages(),
    publicPending: context.hasPendingMessages(),
    status: JSON.stringify(status),
    // oxlint-disable typescript/no-unsafe-type-assertion, typescript/no-unsafe-assignment, typescript/strict-boolean-expressions -- journal entry payloads are dynamically shaped
    visibleIds: entries
      .filter((entry) => entry.type === "custom_message" && entry.customType === "intercom_message")
      .map(
        (entry) =>
          /** @type {{ details?: { message?: { id?: string } } }} */ (entry).details?.message?.id,
      ),
    provenance: Object.fromEntries(
      entries
        .filter(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === "intercom_delivery" &&
            /** @type {{ entry?: unknown }} */ (entry.data).entry,
        )
        .map((entry) => {
          const delivery =
            /** @type {{ entry?: { message?: { id?: string } }, sessionId?: string }} */ (
              /** @type {{ data?: unknown }} */ (entry).data
            );
          const messageId = delivery.entry?.message?.id;
          const query = (/** @type {string} */ rootSessionId) => {
            /** @type {unknown} */ let response;
            events.emit("pi-intercom:provenance-query", {
              version: 1,
              rootSessionId,
              messageId,
              respond: (/** @type {unknown} */ value) => {
                response = value;
              },
            });
            return response;
          };
          return [
            messageId,
            {
              current: query(sessionManager.getSessionId()),
              original: query(delivery.sessionId ?? ""),
            },
          ];
        }),
    ),
    checkpointOwners: [
      ...new Set(
        entries
          .filter((entry) => entry.type === "custom" && entry.customType === "intercom_delivery")
          .map((entry) => /** @type {{ data?: { sessionId?: string } }} */ (entry).data?.sessionId),
      ),
    ],
    // oxlint-enable typescript/no-unsafe-type-assertion, typescript/no-unsafe-assignment, typescript/strict-boolean-expressions
    errors,
  };
};

if (mode === "seed") {
  faux.setResponses([
    fauxAssistantMessage("Saved conversation ready"),
    async (
      /** @type {import("@earendil-works/pi-ai").TranscriptContext} */ _context,
      /** @type {import("@earendil-works/pi-ai").SimpleStreamOptions | undefined} */ options,
    ) => {
      send({ type: "ready", ...(await summary()) });
      await new Promise((resolve) => {
        /** @type {AbortSignal} */ (
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- fixture always supplies an abort signal
          /** @type {import("@earendil-works/pi-ai").SimpleStreamOptions} */ (options).signal
        ).addEventListener("abort", resolve, { once: true });
      });
      return fauxAssistantMessage("Aborted");
    },
  ]);
} else {
  faux.setResponses([fauxAssistantMessage("Recovered pending messages")]);
}
await session.bindExtensions({
  mode: "rpc",
  uiContext: { ...session.extensionRunner.getUIContext() },
  onError: (error) => {
    errors.push(error);
  },
});

if (mode === "seed") {
  // oxlint-disable-next-line typescript/no-misused-promises, typescript/strict-void-return -- snapshot handler awaits summary before replying
  process.on("message", async (/** @type {{ action?: string }} */ message) => {
    if (message.action === "snapshot") {
      send({ type: "snapshot", ...(await summary()) });
    }
  });
  await session.prompt("Seed this saved session");
  // The test kills this process while native queues and intercom staging are pending.
  await session.prompt("Hold an unfinished provider request");
} else {
  const deadline = Date.now() + 5_000;
  // Each summary awaits a real broker response before deciding whether native delivery settled.
  // oxlint-disable-next-line no-await-in-loop
  while (!(await summary()).status.includes("Pending inbound messages: 0") || !session.isIdle) {
    assert.ok(
      Date.now() < deadline,
      "restored native delivery finishes without waking passive messages",
    );
    // Native delivery consumes its queue between polls; do not race concurrent status calls.
    // oxlint-disable-next-line no-await-in-loop
    await sleep(5);
  }
  await session.waitForIdle();
  const result = await summary();
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  await session.abort();
  session.dispose();
  send({ type: "result", ...result });
  process.disconnect();
}
