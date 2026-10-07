import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import { fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ParentSubagentRuntime } from "../../src/extension/parent-runtime.ts";
import { TEMP_ARTIFACTS_DIR } from "../../src/shared/types.ts";

// No existing keeper interrupts session_start's artifact I/O with actual runtime disposal.
// Pause the filesystem, not the lifecycle dispatcher or a private runtime operation.
test(
  "native runtime shutdown joins an admitted parent reset without reviving filesystem resources",
  { timeout: 15000 },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parent-reset-shutdown-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const paused: PromiseWithResolvers<void> = Promise.withResolvers();
    const release: PromiseWithResolvers<void> = Promise.withResolvers();
    const shutdownEntered: PromiseWithResolvers<void> = Promise.withResolvers();
    const watchers = new Set<fs.FSWatcher>();
    const closed: Promise<void>[] = [];
    const watch = fs.watch;
    t.mock.method(fs, "watch", (file: fs.PathLike, listener: fs.WatchListener<string>) => {
      const watcher = watch(file, listener);
      watchers.add(watcher);
      closed.push(
        new Promise<void>((resolve) => {
          watcher.once("close", () => {
            watchers.delete(watcher);
            resolve();
          });
        }),
      );
      return watcher;
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    const access = fs.promises.access;
    t.mock.method(fs.promises, "access", async (file: fs.PathLike, mode?: number) => {
      if (file === TEMP_ARTIFACTS_DIR) {
        paused.resolve();
        await release.promise;
      }
      await access(file, mode);
    });
    const faux = fauxProvider();
    const models = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    models.registerNativeProvider(faux.provider);
    const createRuntime: CreateAgentSessionRuntimeFactory = async ({ sessionManager }) => {
      const services = await createAgentSessionServices({
        cwd: root,
        agentDir: path.join(root, "agent"),
        modelRuntime: models,
        settingsManager: SettingsManager.inMemory({
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
              pi.on("session_shutdown", () => shutdownEntered.resolve());
              new ParentSubagentRuntime(pi, {}).register();
            },
          ],
        },
      });
      assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
      return {
        ...(await createAgentSessionFromServices({
          services,
          sessionManager,
          model: faux.getModel(),
          noTools: "builtin",
        })),
        services,
        diagnostics: services.diagnostics,
      };
    };
    const runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: root,
      agentDir: path.join(root, "agent"),
      sessionManager: SessionManager.inMemory(root),
    });
    const errors: unknown[] = [];
    const reset = runtime.session.bindExtensions({
      mode: "print",
      onError: (error) => {
        errors.push(error);
      },
    });
    let shutdown: Promise<void> | undefined;
    try {
      await paused.promise;
      let finished = false;
      shutdown = runtime.dispose().finally(() => {
        finished = true;
      });
      await shutdownEntered.promise;
      await nextTurn();
      assert.equal(
        finished,
        false,
        "shutdown cannot invalidate the native context while reset owns pending I/O",
      );
      release.resolve();
      await reset;
      await shutdown;
      assert.ok(closed.length > 0, "the resumed reset actually starts native filesystem delivery");
      await Promise.all(closed);
      assert.deepEqual(errors, []);
      assert.equal(watchers.size, 0, "shutdown closes every native watcher admitted by the reset");
    } finally {
      release.resolve();
      await reset;
      await (shutdown ?? runtime.dispose());
      for (const watcher of watchers) {
        watcher.close();
      }
    }
  },
);
