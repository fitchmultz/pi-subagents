import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { findPackageJSON } from "node:module";
import { setImmediate as nextTurn } from "node:timers/promises";

const [root, repo, sdkRoot] = process.argv.slice(2);
assert.ok(
  // oxlint-disable-next-line typescript/strict-boolean-expressions -- fixture assert; also narrows for tsc
  root && repo && sdkRoot,
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
/** @type {typeof import("@earendil-works/pi-coding-agent")} */
// oxlint-disable-next-line typescript/no-unsafe-assignment
const sdk = await import(pathToFileURL(path.join(sdkRoot, "dist/index.js")).href);
const aiPackageJson = findPackageJSON(
  "@earendil-works/pi-ai",
  pathToFileURL(path.join(sdkRoot, "dist/index.js")),
);
if (aiPackageJson === undefined) {
  throw new Error("Could not locate the installed pi-ai package");
}
const aiRoot = path.dirname(aiPackageJson);
/** @type {typeof import("@earendil-works/pi-ai")} */
// oxlint-disable-next-line typescript/no-unsafe-assignment
const ai = await import(pathToFileURL(path.join(aiRoot, "dist/index.js")).href);
const { fauxProvider, InMemoryCredentialStore } = ai;
/** @type {typeof import("../../src/agent/index.ts")} */
// oxlint-disable-next-line typescript/no-unsafe-assignment
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
// oxlint-disable typescript/no-unsafe-type-assertion -- withResolvers cannot express its generic in JSDoc
const paused = /** @type {{ promise: Promise<void>, resolve: () => void }} */ (
  Promise.withResolvers()
);
const release = /** @type {{ promise: Promise<void>, resolve: () => void }} */ (
  Promise.withResolvers()
);
const shutdownEntered = /** @type {{ promise: Promise<void>, resolve: () => void }} */ (
  Promise.withResolvers()
);
// oxlint-enable typescript/no-unsafe-type-assertion
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
/**
 * @param {import("node:fs").PathLike} file
 * @param {unknown[]} args
 */
// oxlint-disable typescript/no-unsafe-type-assertion -- narrowing the fs overloads for spread calls
const tracedMkdir = async (file, ...args) => {
  if (file === artifactRoot) {
    paused.resolve();
    await release.promise;
  }
  return /** @type {(f: import("node:fs").PathLike, ...a: unknown[]) => Promise<unknown>} */ (
    originalMkdir
  )(file, ...args);
};
fs.promises.mkdir = /** @type {typeof fs.promises.mkdir} */ (tracedMkdir);
// oxlint-enable typescript/no-unsafe-type-assertion
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
  /** @type {{ attached: boolean }} */
  // oxlint-disable-next-line typescript/no-unsafe-assignment
  const attachment = JSON.parse(
    fs.readFileSync(path.join(artifactRoot, "attachment.json"), "utf8"),
  );
  assert.equal(
    attachment.attached,
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
