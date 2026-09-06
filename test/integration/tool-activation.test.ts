import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	type AgentSession,
	type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import { createTempDir, removeTempDir } from "../support/helpers.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const extensionPath = path.join(projectRoot, "src/extension/index.ts");

async function withSdkSession(
	options: Pick<CreateAgentSessionOptions, "tools" | "excludeTools">,
	check: (session: AgentSession) => Promise<void> | void,
): Promise<void> {
	const agentDir = createTempDir("pi-subagent-sdk-tools-");
	const resourceLoader = new DefaultResourceLoader({
		cwd: projectRoot,
		agentDir,
		additionalExtensionPaths: [extensionPath],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: projectRoot,
		agentDir,
		resourceLoader,
		sessionManager: SessionManager.inMemory(projectRoot),
		model: getModel("openai", "gpt-4o-mini"),
		...options,
	});
	try {
		await session.bindExtensions({ mode: "print" });
		await check(session);
	} finally {
		session.dispose();
		removeTempDir(agentDir);
	}
}

function activeTool(session: AgentSession, name: string) {
	return session.agent.state.tools.find((tool) => tool.name === name);
}

describe("subagent lazy activation with SDK tool filters", () => {
	it("keeps subagent active when an allowlist filters out its loader", async () => {
		await withSdkSession({ tools: ["subagent"] }, (session) => {
			assert.deepEqual(session.getAllTools().map((tool) => tool.name), ["subagent"]);
			assert.deepEqual(session.getActiveToolNames(), ["subagent"]);
		});
	});

	it("fails clearly when an allowlist or denylist filters out subagent", async () => {
		for (const options of [{ tools: ["load_subagent"] }, { excludeTools: ["subagent"] }]) {
			await withSdkSession(options, async (session) => {
				const loader = activeTool(session, "load_subagent");
				assert.ok(loader);
				await assert.rejects(
					loader.execute("load", {}, new AbortController().signal),
					/full tool is excluded from this session/,
				);
				assert.equal(session.getActiveToolNames().includes("subagent"), false);
			});
		}
	});

	it("exposes compact delegation and run control without loading the advanced schema", async () => {
		await withSdkSession({}, async (session) => {
			assert.ok(activeTool(session, "delegate"));
			const runs = activeTool(session, "agent_runs");
			assert.ok(runs);
			const profiles = await runs.execute("profiles", { action: "profiles" }, new AbortController().signal);
			assert.match(JSON.stringify(profiles.content), /Executable agents/);
			assert.equal(session.getActiveToolNames().includes("subagent"), false);
		});
	});

	it("adds the available full tool through Pi's deferred-loading wrapper", async () => {
		await withSdkSession({}, async (session) => {
			assert.equal(session.getActiveToolNames().includes("subagent"), false);
			const loader = activeTool(session, "load_subagent");
			assert.ok(loader);
			const result = await loader.execute("load", {}, new AbortController().signal);
			assert.deepEqual(result.addedToolNames, ["subagent"]);
			assert.equal(session.getActiveToolNames().includes("subagent"), true);
		});
	});
});
