import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { findPackageJSON } from "node:module";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const [root, repo, sdkRoot, phase, variant] = process.argv.slice(2);
const cwd = path.join(root, "project"),
  agentDir = path.join(root, "agent");
const portableChild = phase.startsWith("portable-child");
const advanced = variant === "advanced-receipt" || variant === "advanced-child-restart";
const childSafe = portableChild || variant.includes("child-restart");
for (const dir of [cwd, agentDir, path.join(cwd, ".pi/agents"), path.join(root, "bin")]) {
  fs.mkdirSync(dir, { recursive: true });
}
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PI_SUBAGENT_")) {
    delete process.env[key];
  }
}
Object.assign(process.env, {
  HOME: root,
  PI_CODING_AGENT_DIR: agentDir,
  PI_PACKAGE_DIR: sdkRoot,
  PI_SUBAGENT_TEMP_ROOT: path.join(root, "pi-subagents-runtime"),
  PI_OFFLINE: "1",
  NATIVE_ASYNC_ROOT: root,
  NATIVE_ASYNC_SDK: sdkRoot,
  PATH: `${path.join(root, "bin")}${path.delimiter}${process.env.PATH}`,
});
fs.writeFileSync(
  path.join(root, "bin/pi"),
  `#!/bin/sh\nexec "${process.execPath}" "${path.join(repo, "test/fixtures/native-async-child.mjs")}" "$@"\n`,
  { mode: 0o755 },
);
fs.writeFileSync(
  path.join(cwd, ".pi/agents/fixture.md"),
  "---\nname: fixture\ndescription: Controlled fixture\nmodel: child-fixture/actual-model\ninheritProjectContext: false\ninheritSkills: false\ncompletionGuard: false\n---\nReturn the controlled fixture result.\n",
);
const sdkEntry = pathToFileURL(path.join(sdkRoot, "dist/index.js"));
const sdk = await import(sdkEntry.href);
const aiRoot = path.dirname(findPackageJSON("@earendil-works/pi-ai", sdkEntry));
const { fauxProvider, fauxAssistantMessage, InMemoryCredentialStore } = await import(
  pathToFileURL(path.join(aiRoot, "dist/index.js")).href
);
const { default: subagents } = await import(
  pathToFileURL(path.join(repo, "dist/extension/index.js")).href
);
const { default: fanoutChild } = await import(
  pathToFileURL(path.join(repo, "dist/extension/fanout-child.js")).href
);
const nativeSession = await import(
  pathToFileURL(path.join(repo, "dist/shared/native-session.js")).href
);
assert.equal(
  nativeSession.SessionManager,
  sdk.SessionManager,
  "ordinary ESM native readers must use the selected SDK",
);
if (childSafe) {
  Object.assign(process.env, {
    PI_SUBAGENT_CHILD: "1",
    PI_SUBAGENT_FANOUT_CHILD: "1",
    PI_SUBAGENT_DEPTH: "1",
    PI_SUBAGENT_MAX_DEPTH: "2",
  });
}
const evidence = { phase, variant, sdkRoot, networkRequests: 0, errors: [], checks: [] };
globalThis.fetch = async () => {
  evidence.networkRequests++;
  throw new Error("Network is forbidden in delegation fixtures");
};
const seed =
  phase === "receipt" || phase === "receipt-seed" || portableChild
    ? undefined
    : JSON.parse(fs.readFileSync(path.join(root, "seed.json"), "utf8"));
const modelRuntime = await sdk.ModelRuntime.create({
  credentials: new InMemoryCredentialStore(),
  modelsPath: null,
  refreshOnCreate: false,
  allowModelNetwork: false,
});
const faux = fauxProvider({ provider: "native-parent-fixture" });
modelRuntime.registerNativeProvider(faux.provider);
faux.setResponses([fauxAssistantMessage("Saved completion received")]);
const settingsManager = sdk.SettingsManager.inMemory({
  compaction: { enabled: false },
  retry: { enabled: false },
});
settingsManager.setProjectTrusted(true);
const loader = new sdk.DefaultResourceLoader({
  cwd,
  agentDir,
  settingsManager,
  noExtensions: true,
  noSkills: true,
  noContextFiles: true,
  noThemes: true,
  noPromptTemplates: true,
  extensionFactories: [subagents, ...(childSafe ? [fanoutChild] : [])],
});
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const manager = seed
  ? sdk.SessionManager.open(seed.sessionFile)
  : sdk.SessionManager.create(cwd, path.join(root, "sessions"));
if (phase.startsWith("receipt-crash-")) {
  const append = manager.appendCustomMessageEntry.bind(manager);
  manager.appendCustomMessageEntry = (customType, ...args) => {
    if (customType !== "subagent-notify") {
      return append(customType, ...args);
    }
    if (phase === "receipt-crash-after") {
      append(customType, ...args);
    }
    fs.writeFileSync(
      path.join(root, "crash-evidence.json"),
      JSON.stringify({ ...evidence, entries: manager.getEntries() }),
    );
    process.exit(86);
  };
}
const { session } = await sdk.createAgentSession({
  cwd,
  agentDir,
  settingsManager,
  modelRuntime,
  model: faux.getModel(),
  resourceLoader: loader,
  sessionManager: manager,
});
await session.bindExtensions({ mode: "json", onError: (error) => evidence.errors.push(error) });
for (const name of ["delegate", "load_subagent"]) {
  assert.ok(session.getActiveToolNames().includes(name));
}
const originalCallId = "delegate_original";
const resultEntries = () =>
  manager
    .getEntries()
    .filter(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        entry.message.toolCallId === originalCallId,
    );
const childStarts = () =>
  fs.existsSync(path.join(root, "child-starts.jsonl"))
    ? fs
        .readFileSync(path.join(root, "child-starts.jsonl"), "utf8")
        .split("\n")
        .slice(0, -1)
        .map(JSON.parse)
    : [];
const until = async (predicate, reason) => {
  const deadline = Date.now() + 20_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, reason);
    // Poll readiness after the native owner has had another event-loop turn.
    // oxlint-disable-next-line no-await-in-loop
    await delay(20);
  }
};
try {
  if (portableChild) {
    const { readNativeUsage, snapshotNativeUsage } = await import(
      pathToFileURL(path.join(repo, "dist/runs/shared/native-usage.js")).href
    );
    const baseline = snapshotNativeUsage(manager.getSessionFile());
    if (phase === "portable-child") {
      fs.writeFileSync(path.join(root, "release-child"), "release");
    }
    faux.setResponses([
      fauxAssistantMessage(
        [
          {
            type: "toolCall",
            id: originalCallId,
            name: "delegate",
            arguments: { agent: "fixture", task: "Controlled work", output: false },
          },
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Nested work collected"),
    ]);
    const launch = session.prompt("Delegate one bounded nested task");
    if (phase === "portable-child-control") {
      await until(() => childStarts().length === 1, "nested child starts before interruption");
      const run = manager
        .getEntries()
        .find((entry) => entry.type === "custom" && entry.customType === "subagent-run").data;
      const receipt = await session.agent.state.tools
        .find((tool) => tool.name === "agent_runs")
        .execute("stop_nested", { action: "stop", id: run.runId }, new AbortController().signal);
      assert.notEqual(receipt.isError, true, JSON.stringify(receipt));
    }
    await launch;
    await session.waitForIdle();
    assert.equal(resultEntries().length, 1);
    const result = resultEntries()[0].message;
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(
      result.details.wait.status,
      "completed",
      "same-session control cannot end the wait as a session switch",
    );
    if (phase === "portable-child-control") {
      assert.equal(result.details.run.state, "paused");
    } else {
      assert.match(result.content[0].text, /NATIVE_ORIGINAL_CALL_RESULT/);
      assert.equal(session.getSessionStats().cost, 1);
      faux.setResponses([
        fauxAssistantMessage(
          [
            {
              type: "toolCall",
              id: "inspect_result",
              name: "agent_runs",
              arguments: { action: "inspect", id: result.details.runId },
            },
          ],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("Saved result inspected"),
      ]);
      await session.prompt("Read the same completed nested work");
      const inspected = manager
        .getEntries()
        .find(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "toolResult" &&
            entry.message.toolCallId === "inspect_result",
        ).message;
      assert.equal(inspected.isError, false);
      assert.equal(inspected.usage, undefined);
      assert.equal(session.getSessionStats().cost, 1);
      assert.equal(
        readNativeUsage(manager.getSessionFile(), baseline).reduce(
          (sum, value) => sum + value.cost,
          0,
        ),
        1,
      );
    }
    evidence.checks.push(
      "child-safe final wait preserves cancellation identity and charges completed native work once; inspection never relaunches or charges",
    );
  } else if (phase.startsWith("receipt-crash-")) {
    await until(() => false, "fixture must exit at the notification journal boundary");
  } else if (phase === "receipt-resume" || phase === "receipt-reopen") {
    assert.notEqual(process.pid, seed.pid);
    const notices = () =>
      manager
        .getEntries()
        .filter(
          (entry) => entry.type === "custom_message" && entry.customType === "subagent-notify",
        );
    await until(() => notices().length >= 1, "offline completion wakes its saved owner");
    await until(
      () =>
        manager
          .getEntries()
          .some(
            (entry) =>
              entry.type === "custom" &&
              entry.customType === "subagent-run" &&
              entry.data.runId === seed.runId &&
              entry.data.delivery,
          ),
      "delivery recovers from published notification",
    );
    await delay(350);
    await session.waitForIdle();
    assert.equal(notices().length, 1);
    assert.match(notices()[0].content, /NATIVE_ORIGINAL_CALL_RESULT/);
    assert.equal(resultEntries().length, 1);
    assert.equal(resultEntries()[0].message.details.asyncId, seed.runId);
    assert.equal(
      session.getSessionStats().cost,
      0,
      "custom notifications are not finalized tool-result usage receipts",
    );
    evidence.checks.push(
      "fresh-process offline completion notifies once without replaying launch or fabricating usage",
    );
  } else {
    if (advanced) {
      await session.agent.state.tools
        .find((tool) => tool.name === "load_subagent")
        .execute("load", {}, new AbortController().signal);
    }
    faux.setResponses([
      fauxAssistantMessage(
        [
          {
            type: "toolCall",
            id: originalCallId,
            name: advanced ? "subagent" : "delegate",
            arguments: { agent: "fixture", task: "Controlled work", output: false, async: true },
          },
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Receipt received"),
    ]);
    await session.prompt("Start background work and continue independently");
    await session.waitForIdle();
    assert.equal(resultEntries().length, 1);
    const receipt = resultEntries()[0].message;
    assert.equal(receipt.isError, false, JSON.stringify(receipt));
    assert.ok(receipt.details.asyncId);
    assert.equal(receipt.details.wait, undefined);
    await until(() => childStarts().length === 1, "background child starts");
    if (phase === "receipt-seed") {
      fs.writeFileSync(
        path.join(root, "seed.json"),
        JSON.stringify({
          sessionFile: manager.getSessionFile(),
          sessionId: manager.getSessionId(),
          runId: receipt.details.asyncId,
          pid: process.pid,
        }),
      );
    } else {
      faux.setResponses([fauxAssistantMessage("Appended completion received")]);
      fs.writeFileSync(path.join(root, "release-child"), "release");
      const notices = () =>
        manager
          .getEntries()
          .filter(
            (entry) => entry.type === "custom_message" && entry.customType === "subagent-notify",
          );
      await until(() => notices().length === 1, "completion appends a notification");
      await session.waitForIdle();
      assert.match(notices()[0].content, /NATIVE_ORIGINAL_CALL_RESULT/);
      assert.equal(resultEntries().length, 1);
      assert.equal(session.getSessionStats().cost, 0);
    }
    evidence.checks.push(
      "background receipt settles before child release; later completion appends one wake-up without replacing the receipt",
    );
  }
  assert.equal(childStarts().length, 1);
  assert.equal(evidence.networkRequests, 0);
  assert.deepEqual(evidence.errors, []);
} finally {
  await session.abort();
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
  fs.writeFileSync(
    path.join(root, `${phase}-evidence.json`),
    JSON.stringify(
      { ...evidence, childStarts: childStarts(), entries: manager.getEntries() },
      null,
      2,
    ),
  );
}
