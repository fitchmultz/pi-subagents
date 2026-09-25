import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findPackageJSON } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { getModel } from "@earendil-works/pi-ai/compat";

// Keep the canonical storage root fixed across SDK sessions: both native and Jiti
// modules retain storage paths from their first import.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-child-surface-"));
const savedEnv = { ...process.env };
for (const key of Object.keys(process.env)) if (key.startsWith("PI_SUBAGENT_")) delete process.env[key];
Object.assign(process.env, { HOME: root, PI_CODING_AGENT_DIR: root, PI_SUBAGENT_TEMP_ROOT: root, PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_FANOUT_CHILD: "1" });
const sdkRoot = process.env.PI_COMPACT_TEST_HOST ?? path.dirname(findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url)!);
process.env.PI_PACKAGE_DIR = sdkRoot;
const sdk = await import(pathToFileURL(path.join(sdkRoot, "dist/index.js")).href);
const extensionPath = fileURLToPath(new URL("../../src/extension/fanout-child.ts", import.meta.url));
const configPath = path.join(root, "extensions/subagent/config.json");
fs.mkdirSync(path.dirname(configPath), { recursive: true });
after(() => { process.env = savedEnv; fs.rmSync(root, { recursive: true, force: true }); });

async function open(compactChildTools: boolean, tools?: string[]) {
	fs.writeFileSync(configPath, JSON.stringify({ compactChildTools }));
	const settingsManager = sdk.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
	const resourceLoader = new sdk.DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager,
		noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
		additionalExtensionPaths: [extensionPath] });
	await resourceLoader.reload();
	assert.deepEqual(resourceLoader.getExtensions().errors, []);
	const { session } = await sdk.createAgentSession({ cwd: root, agentDir: root, settingsManager, resourceLoader,
		sessionManager: sdk.SessionManager.inMemory(root), model: getModel("openai", "gpt-4o-mini"), tools });
	await session.bindExtensions({ mode: "print" });
	return session;
}
async function close(session: InstanceType<typeof sdk.AgentSession>) {
	await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	session.dispose();
}

const activeTool = (session: InstanceType<typeof sdk.AgentSession>, name: string) => session.agent.state.tools.find((tool: any) => tool.name === name)!;
test("native child startup reduces serialized definitions and preserves lazy, legacy and filtered capabilities", async () => {
	const measurements: Record<string, number> = {};
	for (const compact of [false, true]) {
		const session = await open(compact);
		try {
			const active = session.getActiveToolNames();
			assert.equal(active.includes("subagent"), !compact);
			for (const name of ["delegate", "agent_runs", "load_subagent"]) assert.equal(active.includes(name), compact);
			const definitions = session.getAllTools().filter((tool: any) => active.includes(tool.name))
				.map(({ name, description, parameters, promptSnippet, promptGuidelines }: any) => ({ name, description, parameters, promptSnippet, promptGuidelines }));
			measurements[compact ? "compactChars" : "legacyChars"] = JSON.stringify(definitions).length;
			if (compact) {
				const list = await activeTool(session, "agent_runs").execute("child-list", { action: "list" }, new AbortController().signal);
				assert.equal(list.details.runList.total, 0);
				await activeTool(session, "load_subagent").execute("load", {}, new AbortController().signal);
				assert.ok(activeTool(session, "subagent"));
			}
			const blocked = await activeTool(session, "subagent").execute("blocked", { action: "create", config: { name: "forbidden" } }, new AbortController().signal);
			assert.match(JSON.stringify(blocked.content), /not available from child-safe/);
		} finally { await close(session); }
	}
	assert.ok(measurements.compactChars < measurements.legacyChars);
	console.log(JSON.stringify({ measurement: "native SDK serialized ALL active startup definitions (name, description, parameters, promptSnippet, promptGuidelines); characters, not tokens", ...measurements }));
	const explicit = await open(true, ["subagent"]);
	try { assert.deepEqual(explicit.getActiveToolNames(), ["subagent"]); } finally { await close(explicit); }
	const denied = await open(true, ["load_subagent"]);
	try {
		await assert.rejects(activeTool(denied, "load_subagent").execute("excluded", {}, new AbortController().signal), /full tool is excluded/);
	} finally { await close(denied); }
});
