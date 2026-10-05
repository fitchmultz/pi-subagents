import { parseSubagentExecutionResult } from "../../src/runs/background/run-schemas.ts";
import { record, assertDefined } from "../support/assertions.ts";
import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findPackageJSON } from "node:module";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

// Keep the canonical storage root fixed across SDK sessions: both native and Jiti
// modules retain storage paths from their first import.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-child-surface-"));
const savedEnv = { ...process.env };
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PI_SUBAGENT_")) {
    delete process.env[key];
  }
}
Object.assign(process.env, {
  HOME: root,
  PI_CODING_AGENT_DIR: root,
  PI_SUBAGENT_TEMP_ROOT: root,
  PI_SUBAGENT_CHILD: "1",
  PI_SUBAGENT_FANOUT_CHILD: "1",
});
const defined927_0 = findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url);
assertDefined(defined927_0);
const sdkRoot = process.env.PI_COMPACT_TEST_HOST ?? path.dirname(defined927_0);
process.env.PI_PACKAGE_DIR = sdkRoot;
const installedPackage = findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url);
assertDefined(installedPackage);
assert.equal(
  fs.realpathSync(sdkRoot),
  fs.realpathSync(path.dirname(installedPackage)),
  "selected host must match the installed SDK graph",
);
const sdk = await import("@earendil-works/pi-coding-agent");
const extensionPath = fileURLToPath(
  new URL("../../src/extension/fanout-child.ts", import.meta.url),
);
const configPath = path.join(root, "extensions/subagent/config.json");
fs.mkdirSync(path.dirname(configPath), { recursive: true });
after(() => {
  process.env = savedEnv;
  fs.rmSync(root, { recursive: true, force: true });
});

async function open(compactChildTools: boolean, tools?: readonly string[]) {
  fs.writeFileSync(configPath, JSON.stringify({ compactChildTools }));
  const settingsManager = sdk.SettingsManager.inMemory({
    retry: { enabled: false },
    compaction: { enabled: false },
  });
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    noThemes: true,
    noPromptTemplates: true,
    additionalExtensionPaths: [extensionPath],
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const { session } = await sdk.createAgentSession({
    cwd: root,
    agentDir: root,
    settingsManager,
    resourceLoader,
    sessionManager: sdk.SessionManager.inMemory(root),
    tools: tools?.slice(),
  });
  await session.bindExtensions({ mode: "print" });
  return session;
}
async function close(session: InstanceType<typeof sdk.AgentSession>) {
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
}

const activeTool = (session: InstanceType<typeof sdk.AgentSession>, name: string) => {
  const tool = session.agent.state.tools.find((entry) => entry.name === name);
  assertDefined(tool);
  return tool;
};
test("native child startup reduces serialized definitions and preserves lazy, legacy and filtered capabilities", async () => {
  const measurements: Record<string, number> = {};
  for (const compact of [false, true]) {
    // Each scenario owns shared fixture state; complete it before starting the next one.
    // oxlint-disable-next-line no-await-in-loop
    const session = await open(compact);
    try {
      const active = session.getActiveToolNames();
      assert.equal(active.includes("subagent"), !compact);
      for (const name of ["delegate", "load_subagent"]) {
        assert.equal(active.includes(name), compact);
      }
      assert.equal(active.includes("agent_runs"), false);
      const definitions = session
        .getAllTools()
        .filter((tool) => active.includes(tool.name))
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          promptSnippet: record(tool).promptSnippet,
          promptGuidelines: tool.promptGuidelines,
        }));
      measurements[compact ? "compactChars" : "legacyChars"] = JSON.stringify(definitions).length;
      if (compact) {
        // Each scenario owns shared fixture state; complete it before starting the next one.
        // oxlint-disable-next-line no-await-in-loop
        await activeTool(session, "load_subagent").execute(
          "load-controls",
          { advanced: false },
          new AbortController().signal,
        );
        assert.equal(session.getActiveToolNames().includes("subagent"), false);
        // Each scenario owns shared fixture state; complete it before starting the next one.
        // oxlint-disable-next-line no-await-in-loop
        const list = parseSubagentExecutionResult(
          await activeTool(session, "agent_runs").execute(
            "child-list",
            { action: "list" },
            new AbortController().signal,
          ),
        );
        assertDefined(list.details.runList);
        assert.equal(list.details.runList.total, 0);
        // Each scenario owns shared fixture state; complete it before starting the next one.
        // oxlint-disable-next-line no-await-in-loop
        await activeTool(session, "load_subagent").execute(
          "load",
          {},
          new AbortController().signal,
        );
        assert.ok(Boolean(activeTool(session, "subagent")));
      }
      // Each scenario owns shared fixture state; complete it before starting the next one.
      // oxlint-disable-next-line no-await-in-loop
      const blocked = parseSubagentExecutionResult(
        await activeTool(session, "subagent").execute(
          "blocked",
          { action: "create", config: { name: "forbidden" } },
          new AbortController().signal,
        ),
      );
      assert.match(JSON.stringify(blocked.content), /not available from child-safe/);
    } finally {
      // Each scenario owns shared fixture state; complete it before starting the next one.
      // oxlint-disable-next-line no-await-in-loop
      await close(session);
    }
  }
  assert.ok(measurements.compactChars < measurements.legacyChars);
  console.log(
    JSON.stringify({
      measurement:
        "native SDK serialized ALL active startup definitions (name, description, parameters, promptSnippet, promptGuidelines); characters, not tokens",
      ...measurements,
    }),
  );
  const explicit = await open(true, ["subagent"]);
  try {
    assert.deepEqual(explicit.getActiveToolNames(), ["subagent"]);
  } finally {
    await close(explicit);
  }
  const denied = await open(true, ["load_subagent"]);
  try {
    await assert.rejects(
      activeTool(denied, "load_subagent").execute("excluded", {}, new AbortController().signal),
      /full tool is excluded/,
    );
  } finally {
    await close(denied);
  }
});
