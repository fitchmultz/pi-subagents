import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { discoverAgents, discoverAgentsAll } from "../../src/agents/agents.ts";
import { handleManagementAction } from "../../src/agents/agent-management.ts";
import { applyIntercomBridgeToAgent, resolveIntercomBridge } from "../../src/intercom/intercom-bridge.ts";

let tempHome = "";
let tempProject = "";
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function writeProjectAgent(cwd: string, name: string, body: string): void {
	const filePath = path.join(cwd, ".pi", "agents", `${name}.md`);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, body, "utf-8");
}

describe("builtin agent overrides", () => {
	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-home-"));
		tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-project-"));
		process.env.HOME = tempHome;
		process.env.USERPROFILE = tempHome;
	});

	afterEach(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("bundles the Fitch role profiles while delegate inherits the default model", () => {
		const builtins = discoverAgentsAll(tempProject).builtin;
		assert.deepEqual(
			builtins.map((agent) => agent.name).sort(),
			[
				"context-builder", "debugger", "delegate", "fixer", "oracle", "planner", "researcher",
				"reviewer", "reviewer-claude", "reviewer-gpt", "reviewer-ponytail", "reviewer-security", "scout", "ui-designer", "watcher", "worker", "writer",
			],
		);
		const expectedRoutes = {
			"context-builder": { model: "cloudflare-ai-gateway/claude-fable-5", fallbackModels: ["anthropic/claude-opus-5", "cloudflare-ai-gateway/claude-fable-5", "openai/gpt-5.6-sol"], thinking: "medium" },
			debugger: { model: "cloudflare-ai-gateway/claude-fable-5", fallbackModels: ["anthropic/claude-opus-5", "openai/gpt-5.6-sol", "openai-codex/gpt-5.6-sol"], thinking: "high" },
			fixer: { model: "cloudflare-ai-gateway/claude-fable-5", fallbackModels: ["anthropic/claude-opus-5", "openai/gpt-5.6-sol", "openai-codex/gpt-5.6-sol"], thinking: "high" },
			oracle: { model: "openai/gpt-5.6-sol", fallbackModels: ["openai-codex/gpt-5.6-sol"], thinking: "xhigh" },
			planner: { model: "cloudflare-ai-gateway/claude-fable-5", fallbackModels: ["anthropic/claude-opus-5", "cloudflare-ai-gateway/claude-fable-5", "openai/gpt-5.6-sol"], thinking: "high" },
			researcher: { model: "openai/gpt-5.6-sol", fallbackModels: ["openai-codex/gpt-5.6-sol"], thinking: "xhigh" },
			reviewer: { model: "cloudflare-ai-gateway/claude-fable-5", fallbackModels: ["anthropic/claude-opus-5", "openai/gpt-5.6-sol", "cloudflare-ai-gateway/claude-fable-5"], thinking: "high" },
			"reviewer-claude": { model: "cloudflare-ai-gateway/claude-fable-5", fallbackModels: ["anthropic/claude-opus-5", "cloudflare-ai-gateway/claude-fable-5"], thinking: "high" },
			"reviewer-gpt": { model: "openai/gpt-5.6-sol", fallbackModels: ["openai-codex/gpt-5.6-sol"], thinking: "xhigh" },
			"reviewer-ponytail": { model: "fireworks/accounts/fireworks/routers/kimi-k3-fast", fallbackModels: ["anthropic/claude-fable-5"], thinking: "max" },
			"reviewer-security": { model: "fireworks/accounts/fireworks/routers/kimi-k3-fast", fallbackModels: ["openai/gpt-5.6-sol", "openai-codex/gpt-5.6-sol"], thinking: "max" },
			scout: { model: "openai/gpt-5.6-sol", fallbackModels: ["openai-codex/gpt-5.6-sol"], thinking: "high" },
			"ui-designer": { model: "cloudflare-ai-gateway/claude-fable-5", fallbackModels: ["anthropic/claude-opus-5", "cloudflare-ai-gateway/claude-fable-5", "openai-codex/gpt-5.6-sol"], thinking: "high" },
			watcher: { model: "openai/gpt-5.6-sol", fallbackModels: ["fireworks/accounts/fireworks/routers/kimi-k3-fast"], thinking: "high" },
			worker: { model: "openai/gpt-5.6-sol", fallbackModels: ["cloudflare-ai-gateway/claude-opus-5", "openai-codex/gpt-5.6-sol"], thinking: "xhigh" },
			writer: { model: "cloudflare-ai-gateway/claude-fable-5", fallbackModels: ["anthropic/claude-fable-5", "cloudflare-ai-gateway/claude-opus-5"], thinking: "high" },
		};
		for (const [name, expected] of Object.entries(expectedRoutes)) {
			const agent = builtins.find((candidate) => candidate.name === name);
			assert.deepEqual(
				{ model: agent?.model, fallbackModels: agent?.fallbackModels, thinking: agent?.thinking },
				expected,
				`${name} route drift`,
			);
		}
		const watcher = builtins.find((agent) => agent.name === "watcher");
		assert.equal(watcher?.maxSubagentDepth, 0);
		assert.equal(watcher?.completionGuard, false);
		assert.match(watcher?.systemPrompt ?? "", /Do not modify the watched target/);
		assert.match(watcher?.systemPrompt ?? "", /never use a tight loop/);
		assert.match(watcher?.systemPrompt ?? "", /suppress unchanged heartbeats/);
		assert.match(watcher?.systemPrompt ?? "", /reason: "progress_update"/);
		assert.match(watcher?.systemPrompt ?? "", /deferred and coalesced/);
		assert.match(watcher?.systemPrompt ?? "", /do not send a duplicate completion update/);
		const effectiveWatcher = applyIntercomBridgeToAgent(watcher!, resolveIntercomBridge("main"));
		assert.match(effectiveWatcher.systemPrompt, /concise material update/);
		for (const agent of builtins) {
			const effectivePrompt = applyIntercomBridgeToAgent(agent, resolveIntercomBridge("main")).systemPrompt;
			assert.doesNotMatch(effectivePrompt, /plan[- ]changing|changes? the plan/i, `${agent.name} progress guidance drift`);
		}
		const delegate = builtins.find((agent) => agent.name === "delegate");
		assert.equal(delegate?.model, undefined);
		assert.equal(delegate?.fallbackModels, undefined);
	});

	it("never uses openai-codex routes as primaries", () => {
		for (const agent of discoverAgentsAll(tempProject).builtin) {
			assert.doesNotMatch(agent.model ?? "", /^openai-codex\//, `${agent.name} must not use the Codex billing pool as primary`);
		}
	});

	it("applies user settings overrides to builtin agents", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				agentOverrides: {
					reviewer: {
						model: "openai/gpt-5.4",
						thinking: "xhigh",
						systemPromptMode: "replace",
						inheritProjectContext: true,
						inheritSkills: true,
						completionGuard: false,
					},
				},
			},
		});

		const reviewer = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "reviewer");
		assert.ok(reviewer);
		assert.equal(reviewer.source, "builtin");
		assert.equal(reviewer.model, "openai/gpt-5.4");
		assert.equal(reviewer.thinking, "xhigh");
		assert.equal(reviewer.systemPromptMode, "replace");
		assert.equal(reviewer.inheritProjectContext, true);
		assert.equal(reviewer.inheritSkills, true);
		assert.equal(reviewer.completionGuard, false);
	});

	it("prefers project settings overrides over user settings overrides", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { agentOverrides: { reviewer: { model: "openai/gpt-5.4" } } },
		});
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { agentOverrides: { reviewer: { model: "openai-codex/gpt-5.4-mini", thinking: "high" } } },
		});

		const reviewer = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "reviewer");
		assert.ok(reviewer);
		assert.equal(reviewer.model, "openai-codex/gpt-5.4-mini");
		assert.equal(reviewer.thinking, "high");
	});

	it("lets a project-specific override re-enable a user-disabled builtin", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { disableBuiltins: true },
		});
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { agentOverrides: { reviewer: { model: "openai-codex/gpt-5.4-mini" } } },
		});

		const reviewer = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "reviewer");
		assert.ok(reviewer);
		assert.equal(reviewer.disabled, false);
		assert.equal(reviewer.model, "openai-codex/gpt-5.4-mini");
	});

	it("does not apply project settings overrides when scope is user", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { agentOverrides: { reviewer: { model: "openai/gpt-5.4" } } },
		});
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { agentOverrides: { reviewer: { model: "openai-codex/gpt-5.4-mini" } } },
		});

		const reviewer = discoverAgents(tempProject, "user").agents.find((agent) => agent.name === "reviewer");
		assert.ok(reviewer);
		assert.equal(reviewer.model, "openai/gpt-5.4");
	});

	it("management list applies only settings from the requested scope", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { agentOverrides: { reviewer: { disabled: true } } },
		});
		const result = handleManagementAction("list", { agentScope: "user" }, {
			cwd: tempProject,
			modelRegistry: { getAvailable: () => [] },
			isProjectTrusted: () => true,
		});
		assert.equal(result.isError, false);
		assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /^- reviewer \(/m);
	});

	it("management user scope does not parse malformed project settings", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(tempProject, ".pi", "settings.json"), '{"subagents":', "utf-8");

		const result = handleManagementAction("list", { agentScope: "user" }, {
			cwd: tempProject,
			modelRegistry: { getAvailable: () => [] },
			isProjectTrusted: () => true,
		});
		assert.equal(result.isError, false);
		assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /^- reviewer \(/m);
	});

	it("management list surfaces current invalid agent diagnostics", () => {
		const agentPath = path.join(tempHome, ".pi", "agent", "agents", "broken.md");
		fs.mkdirSync(path.dirname(agentPath), { recursive: true });
		fs.writeFileSync(agentPath, "---\nname: broken\ndescription: Broken\nallowSubagents: maybe\n---\nBody", "utf-8");
		const originalError = console.error;
		const loggedErrors: string[] = [];
		console.error = (...args: unknown[]) => loggedErrors.push(args.map(String).join(" "));
		try {
			const invalid = handleManagementAction("list", { agentScope: "user" }, {
				cwd: tempProject,
				modelRegistry: { getAvailable: () => [] },
				isProjectTrusted: () => true,
			});
			const invalidText = invalid.content[0]?.type === "text" ? invalid.content[0].text : "";
			assert.match(invalidText, /Discovery diagnostics:/);
			assert.match(invalidText, /allowSubagents must be true or false/);
			handleManagementAction("list", { agentScope: "user" }, {
				cwd: tempProject,
				modelRegistry: { getAvailable: () => [] },
				isProjectTrusted: () => true,
			});
			assert.equal(loggedErrors.filter((message) => message.includes(agentPath)).length, 1);

			fs.writeFileSync(agentPath, "---\nname: broken\ndescription: Fixed\n---\nBody", "utf-8");
			const fixed = handleManagementAction("list", { agentScope: "user" }, {
				cwd: tempProject,
				modelRegistry: { getAvailable: () => [] },
				isProjectTrusted: () => true,
			});
			const fixedText = fixed.content[0]?.type === "text" ? fixed.content[0].text : "";
			assert.doesNotMatch(fixedText, /Discovery diagnostics:/);
			assert.match(fixedText, /^- broken \(/m);
		} finally {
			console.error = originalError;
		}
	});

	it("does not apply user settings overrides when scope is project", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { agentOverrides: { reviewer: { model: "openai/gpt-5.4" } } },
		});

		const reviewer = discoverAgents(tempProject, "project").agents.find((agent) => agent.name === "reviewer");
		assert.ok(reviewer);
		assert.notEqual(reviewer.model, "openai/gpt-5.4");
	});

	it("does not read malformed out-of-scope settings files", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		fs.mkdirSync(path.join(tempHome, ".pi", "agent"), { recursive: true });
		fs.writeFileSync(path.join(tempHome, ".pi", "agent", "settings.json"), '{"subagents":', "utf-8");
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { agentOverrides: { reviewer: { model: "openai-codex/gpt-5.4-mini" } } },
		});

		const reviewer = discoverAgents(tempProject, "project").agents.find((agent) => agent.name === "reviewer");
		assert.ok(reviewer);
		assert.equal(reviewer.model, "openai-codex/gpt-5.4-mini");
	});

	it("does not apply builtin settings overrides when a full project agent overrides the builtin", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { agentOverrides: { reviewer: { model: "openai/gpt-5.4" } } },
		});
		writeProjectAgent(tempProject, "reviewer", `---\nname: reviewer\ndescription: Project reviewer\nmodel: google/gemini-3-pro\n---\n\nUse the project reviewer.\n`);

		const reviewer = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "reviewer");
		assert.ok(reviewer);
		assert.equal(reviewer.source, "project");
		assert.equal(reviewer.model, "google/gemini-3-pro");
	});


	it("surfaces malformed settings files instead of silently ignoring them", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
		fs.writeFileSync(settingsPath, '{"subagents":', "utf-8");

		assert.throws(
			() => discoverAgents(tempProject, "both"),
			(error: unknown) => error instanceof Error
				&& error.message.includes(settingsPath)
				&& error.message.includes("Failed to parse settings file"),
		);
	});

	it("surfaces settings read failures without mislabeling them as parse errors", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		fs.mkdirSync(settingsPath, { recursive: true });

		assert.throws(
			() => discoverAgents(tempProject, "both"),
			(error: unknown) => error instanceof Error
				&& error.message.includes(settingsPath)
				&& error.message.includes("Failed to read settings file"),
		);
	});

	it("surfaces malformed builtin override entries instead of silently ignoring them", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		writeJson(settingsPath, {
			subagents: {
				agentOverrides: {
					reviewer: {
						inheritProjectContext: "true",
					},
				},
			},
		});

		assert.throws(
			() => discoverAgents(tempProject, "both"),
			(error: unknown) => error instanceof Error
				&& error.message.includes(settingsPath)
				&& error.message.includes("reviewer")
				&& error.message.includes("inheritProjectContext"),
		);
	});

	it("surfaces malformed completion guard override values", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		writeJson(settingsPath, {
			subagents: {
				agentOverrides: {
					reviewer: {
						completionGuard: "false",
					},
				},
			},
		});

		assert.throws(
			() => discoverAgents(tempProject, "both"),
			(error: unknown) => error instanceof Error
				&& error.message.includes(settingsPath)
				&& error.message.includes("reviewer")
				&& error.message.includes("completionGuard"),
		);
	});

});
