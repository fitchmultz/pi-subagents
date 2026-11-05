import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { findPackageJSON } from "node:module";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { loadNativeAI } from "../support/native-host.ts";
import { loadSDK } from "../../src/agent/host.ts";
import { record } from "../support/assertions.ts";
import { isInboundCheckpoint, isInboundEntry } from "../../src/pi-intercom/inbound-record.ts";

const [modeArgument, directoryArgument, sourceSession] = process.argv.slice(2);
const send = process.send?.bind(process);
if (send === undefined) {
  throw new Error("Run this fixture through the native intercom test");
}
assert.ok(
  modeArgument !== undefined &&
    modeArgument !== "" &&
    directoryArgument !== undefined &&
    directoryArgument !== "",
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
const sdk = await loadSDK(sdkRoot);
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } =
  sdk;
const ai = await loadNativeAI(sdkRoot);
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
  const checkpoints = entries
    .filter((entry) => entry.type === "custom")
    .filter((entry) => entry.customType === "intercom_delivery")
    .map((entry) => {
      /** @type {unknown} */
      const data = entry.data;
      assert.ok(isInboundCheckpoint(data), "expected a native inbound checkpoint");
      return data;
    });
  return {
    sessionId: sessionManager.getSessionId(),
    sessionFile: sessionManager.getSessionFile(),
    modelCalls: faux.state.callCount,
    nativeQueued: session.agent.hasQueuedMessages(),
    publicPending: context.hasPendingMessages(),
    status: JSON.stringify(status),
    visibleIds: entries
      .filter((entry) => entry.type === "custom_message")
      .filter((entry) => entry.customType === "intercom_message")
      .map((entry) => {
        /** @type {unknown} */
        const details = entry.details;
        assert.ok(isInboundEntry(details), "expected a visible native inbound entry");
        return details.message.id;
      }),
    provenance: Object.fromEntries(
      checkpoints
        .filter((checkpoint) => "entry" in checkpoint)
        .map((delivery) => {
          const messageId = delivery.entry.message.id;
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
              original: query(delivery.sessionId),
            },
          ];
        }),
    ),
    checkpointOwners: [...new Set(checkpoints.map((checkpoint) => checkpoint.sessionId))],
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
      const signal = options?.signal;
      assert.ok(signal !== undefined, "native provider request supplies its abort signal");
      await new Promise((resolve) => {
        signal.addEventListener("abort", resolve, { once: true });
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
  process.on("message", (/** @type {unknown} */ message) => {
    if (record(message).action === "snapshot") {
      summary()
        .then((snapshot) => {
          send({ type: "snapshot", ...snapshot });
        })
        .catch((/** @type {unknown} */ error) => {
          console.error(error);
          process.exit(1);
        });
    }
  });
  await session.prompt("Seed this saved session");
  // The test kills this process while native queues and intercom staging are pending.
  await session.prompt("Hold an unfinished provider request");
} else {
  const deadline = Date.now() + 5_000;
  // Each summary awaits a real broker response before deciding whether native delivery settled.
  while (!(await summary()).status.includes("Pending inbound messages: 0") || !session.isIdle) {
    assert.ok(
      Date.now() < deadline,
      "restored native delivery finishes without waking passive messages",
    );
    // Native delivery consumes its queue between polls; do not race concurrent status calls.
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
