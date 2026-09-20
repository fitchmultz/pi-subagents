import assert from "node:assert/strict";
import { findPackageJSON } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const [root, repo, sdkRoot] = process.argv.slice(2);
const sdkEntry = pathToFileURL(path.join(sdkRoot, "dist/index.js"));
const sdk = await import(sdkEntry.href);
const aiRoot = path.dirname(findPackageJSON("@earendil-works/pi-ai", sdkEntry));
const { InMemoryCredentialStore } = await import(pathToFileURL(path.join(aiRoot, "dist/index.js")).href);
const checkpoint = sdk.readSessionCheckpoint(path.join(root, "cold-checkpoint.json"));
const cwd = checkpoint.selection.cwd, agentDir = path.join(root, "agent");
const settingsManager = sdk.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [path.join(repo, "src/extension/index.ts"), path.join(repo, "src/pi-intercom/index.ts")] });
await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
const modelRuntime = await sdk.ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
const { session } = await sdk.createAgentSession({ cwd, agentDir, checkpoint, settingsManager, resourceLoader: loader, modelRuntime });
try {
  await session.bindExtensions({ mode: "print" });
  assert.equal(session.sessionId, checkpoint.selection.sessionId);
  assert.deepEqual(session.getCheckpointQueues(), checkpoint.queues);
  const tool = session.agent.state.tools.find(t => t.name === "intercom");
  const result = await tool.execute("cold-topics", { action: "topics", topic: "checkpoint-resource" }, new AbortController().signal);
  assert.match(JSON.stringify(result), /retained owner/);
  assert.match(JSON.stringify(result), /held/);
  assert.deepEqual(session.getCheckpointQueues(), checkpoint.queues, "inspection/startup must not replay queues");
  const { runId } = JSON.parse(readFileSync(path.join(root, "cold-expected.json"), "utf8"));
  const runs = session.agent.state.tools.find(t => t.name === "agent_runs");
  const inspected = await runs.execute("cold-run", { action: "inspect", id: runId }, new AbortController().signal);
  assert.equal(inspected.details.run.runId, runId);
  assert.equal(inspected.details.run.state, "completed");
  assert.equal(inspected.details.run.children[0].result.finalOutput, "FIRST_SESSION_TOKEN");
  writeFileSync(path.join(root, "cold-restored.json"), JSON.stringify({ pid: process.pid, sessionId: session.sessionId, queues: session.getCheckpointQueues(), topics: result, run: inspected.details.run }, null, 2));
} finally {
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  await session.abort(); session.dispose();
}
