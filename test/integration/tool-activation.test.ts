import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
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
import { createMockPi, createTempDir, removeTempDir } from "../support/helpers.ts";

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

	it("delegates through the same executor and isolates a single writer on request", async () => {
		const repo = createTempDir("pi-compact-delegate-");
		const mock = createMockPi();
		mock.install();
		try {
			fs.mkdirSync(path.join(repo, ".pi/agents"), { recursive: true });
			fs.writeFileSync(path.join(repo, ".pi/agents/compact-probe.md"), "---\nname: compact-probe\ndescription: Compact tool test\nmodel: openai/gpt-6-astra\n---\nReturn the requested answer.\n");
			execFileSync("git", ["init", "-q", repo]);
			execFileSync("git", ["-C", repo, "add", "."]);
			execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture"]);
			await withSdkSession({}, async (session) => {
				const delegate = activeTool(session, "delegate");
				assert.ok(delegate);
				for (const worktree of [false, true]) {
					mock.reset();
					mock.onCall({ output: "COMPACT_DONE" });
					const result = await delegate.execute(`delegate-${worktree}`, {
						agent: "compact-probe", task: "Report completion", cwd: repo,
						async: false, worktree, output: false,
					}, new AbortController().signal);
					assert.match(JSON.stringify(result), /COMPACT_DONE/);
					const callFile = fs.readdirSync(mock.dir).find((name) => name.startsWith("call-"));
					assert.ok(callFile);
					const call = JSON.parse(fs.readFileSync(path.join(mock.dir, callFile), "utf8"));
					assert.equal(call.cwd === fs.realpathSync(repo), !worktree);
					assert.equal(mock.callCount(), 1);
				}
			});
		} finally {
			mock.uninstall();
			removeTempDir(repo);
		}
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
