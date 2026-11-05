import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadNativeAI } from "../support/native-host.ts";
import { loadSDK } from "../../src/agent/host.ts";
import { setImmediate as nextTurn } from "node:timers/promises";
import { mock } from "node:test";
import { record } from "../support/assertions.ts";

const [root, repo, sdkRoot] = process.argv.slice(2);
assert.ok(
  root !== undefined &&
    root !== "" &&
    repo !== undefined &&
    repo !== "" &&
    sdkRoot !== undefined &&
    sdkRoot !== "",
  "Run this fixture with root, repo and sdk arguments",
);
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PI_")) {
    delete process.env[key];
  }
}
Object.assign(process.env, {
  HOME: root,
  PI_CODING_AGENT_DIR: path.join(root, "agent"),
  PI_PACKAGE_DIR: sdkRoot,
  PI_INTERCOM_RUNTIME_DIR: path.join(root, "ic"),
});
const sdk = await loadSDK(sdkRoot);
const ai = await loadNativeAI(sdkRoot);
const { fauxProvider, InMemoryCredentialStore } = ai;
/** @type {typeof import("../../src/agent/index.ts")} */
// oxlint-disable-next-line typescript/no-unsafe-assignment -- QX-004: load the selected runtime artifact with its authoritative source contract.
const agentModule = await import(pathToFileURL(path.join(repo, "dist/agent/index.js")).href);
const { default: agents } = agentModule;
const faux = fauxProvider();
const models = await sdk.ModelRuntime.create({
  credentials: new InMemoryCredentialStore(),
  modelsPath: null,
  refreshOnCreate: false,
});
models.registerNativeProvider(faux.provider);
const manager = sdk.SessionManager.inMemory(root);
/** @type {PromiseWithResolvers<void>} */
const paused = Promise.withResolvers();
/** @type {PromiseWithResolvers<void>} */
const release = Promise.withResolvers();
/** @type {PromiseWithResolvers<void>} */
const shutdownEntered = Promise.withResolvers();
const artifactRoot = path.join(root, "agent/sessions/agent-runs", manager.getSessionId());
const createRuntime = async (
  /** @type {{ sessionManager: import("@earendil-works/pi-coding-agent").SessionManager }} */ {
    sessionManager,
  },
) => {
  const services = await sdk.createAgentSessionServices({
    cwd: root,
    agentDir: path.join(root, "agent"),
    modelRuntime: models,
    settingsManager: sdk.SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noThemes: true,
      noPromptTemplates: true,
      noContextFiles: true,
      extensionFactories: [
        (/** @type {import("@earendil-works/pi-coding-agent").ExtensionAPI} */ pi) => {
          pi.on("session_shutdown", () => {
            shutdownEntered.resolve();
          });
        },
        agents,
      ],
    },
  });
  return {
    ...(await sdk.createAgentSessionFromServices({
      services,
      sessionManager,
      model: faux.getModel(),
      noTools: "builtin",
    })),
    services,
    diagnostics: services.diagnostics,
  };
};
const runtime = await sdk.createAgentSessionRuntime(createRuntime, {
  cwd: root,
  agentDir: path.join(root, "agent"),
  sessionManager: manager,
});
const originalMkdir = fs.promises.mkdir;
/** @param {Parameters<typeof fs.promises.mkdir>} args */
const tracedMkdir = async (...args) => {
  const [file] = args;
  if (file === artifactRoot) {
    paused.resolve();
    await release.promise;
  }
  return originalMkdir(...args);
};
const mkdir = mock.method(fs.promises, "mkdir", tracedMkdir);
/** @type {unknown[]} */ const errors = [];
const reset = runtime.session.bindExtensions({
  mode: "print",
  onError: (error) => {
    errors.push(error);
  },
});
let dispose;
try {
  await paused.promise;
  let finished = false;
  dispose = runtime.dispose().finally(() => {
    finished = true;
  });
  await shutdownEntered.promise;
  await nextTurn();
  assert.equal(
    finished,
    false,
    "real runtime disposal must join admitted filesystem initialization before invalidating context",
  );
  release.resolve();
  await reset;
  await dispose;
  /** @type {unknown} */
  const attachment = JSON.parse(
    fs.readFileSync(path.join(artifactRoot, "attachment.json"), "utf8"),
  );
  assert.equal(
    record(attachment).attached,
    false,
    "the actual resumed filesystem operation is joined and its owner attachment is retired",
  );
  assert.deepEqual(errors, []);
} finally {
  release.resolve();
  await reset;
  await (dispose ?? runtime.dispose());
  mkdir.mock.restore();
}
