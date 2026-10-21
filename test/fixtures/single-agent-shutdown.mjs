import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { findPackageJSON } from "node:module";
import { setImmediate as nextTurn } from "node:timers/promises";

const [root, repo, sdkRoot] = process.argv.slice(2);
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
const sdk = await import(pathToFileURL(path.join(sdkRoot, "dist/index.js")).href);
const aiRoot = path.dirname(
  findPackageJSON("@earendil-works/pi-ai", pathToFileURL(path.join(sdkRoot, "dist/index.js"))),
);
const { fauxProvider, InMemoryCredentialStore } = await import(
  pathToFileURL(path.join(aiRoot, "dist/index.js")).href
);
const { default: agents } = await import(
  pathToFileURL(path.join(repo, "dist/agent/index.js")).href
);
const faux = fauxProvider();
const models = await sdk.ModelRuntime.create({
  credentials: new InMemoryCredentialStore(),
  modelsPath: null,
  refreshOnCreate: false,
});
models.registerNativeProvider(faux.provider);
const manager = sdk.SessionManager.inMemory(root);
const paused = Promise.withResolvers(),
  release = Promise.withResolvers(),
  shutdownEntered = Promise.withResolvers();
const artifactRoot = path.join(root, "agent/sessions/agent-runs", manager.getSessionId());
const createRuntime = async ({ sessionManager }) => {
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
        (pi) => {
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
fs.promises.mkdir = async (file, ...args) => {
  if (file === artifactRoot) {
    paused.resolve();
    await release.promise;
  }
  return originalMkdir(file, ...args);
};
const errors = [];
const reset = runtime.session.bindExtensions({
  mode: "print",
  onError: (error) => errors.push(error),
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
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(artifactRoot, "attachment.json"), "utf8")).attached,
    false,
    "the actual resumed filesystem operation is joined and its owner attachment is retired",
  );
  assert.deepEqual(errors, []);
} finally {
  release.resolve();
  await reset;
  await (dispose ?? runtime.dispose());
  fs.promises.mkdir = originalMkdir;
}
