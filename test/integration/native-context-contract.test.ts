import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { discoverAgentsAll } from "../../src/agents/agents.ts";
import { buildPiArgs, cleanupTempDir } from "../../src/runs/shared/pi-args.ts";

const packageRoot = process.env.PI_CONTEXT_TEST_PACKAGE_ROOT ?? path.dirname(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));

it("native Pi suppresses inherited project files without dropping selected context", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-native-context-contract-"));
	try {
		fs.writeFileSync(path.join(root, "AGENTS.md"), "NATIVE_PROJECT_SENTINEL");
		const observer = path.join(root, "observe.ts");
		// Observe the real resource loader and prompt builder, then stop before any model request.
		fs.writeFileSync(observer, `import { writeFileSync } from "node:fs";
export default function(pi) {
	pi.on("session_start", (_event, ctx) => {
		writeFileSync(process.env.CONTEXT_PROBE_OUTPUT, ctx.getSystemPrompt());
		ctx.shutdown();
	});
}`);
		for (const inheritProjectContext of [false, true]) {
			const output = path.join(root, `prompt-${inheritProjectContext}.txt`);
			const built = buildPiArgs({ baseArgs: ["--mode", "rpc", "--no-prompt-templates", "--no-themes"], task: "Do not invoke a model",
				sessionEnabled: false, inheritProjectContext, inheritSkills: false, systemPrompt: "EXPLICIT_SELECTED_CONTEXT", extensions: [observer], projectTrust: "approve" });
			const env = { ...process.env, ...built.env, PI_CODING_AGENT_DIR: path.join(root, "agent"), PI_OFFLINE: "1", CONTEXT_PROBE_OUTPUT: output };
			try {
				const child = spawnSync(process.execPath, [path.join(packageRoot, "dist/cli.js"), ...built.args], { cwd: root, env, input: "", encoding: "utf8", timeout: 15_000 });
				assert.equal(child.status, 0, child.stderr);
				const prompt = fs.readFileSync(output, "utf8");
				assert.equal(prompt.includes("NATIVE_PROJECT_SENTINEL"), inheritProjectContext);
				assert.ok(prompt.includes("EXPLICIT_SELECTED_CONTEXT"));
			} finally {
				cleanupTempDir(built.tempDir);
			}
		}
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

it("native Pi preserves configured builtins and custom tools for the bundled delegate", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-native-delegate-tools-"));
	try {
		const agentDir = path.join(root, "agent");
		fs.mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultTools: ["read", "bash"] }));
		const output = path.join(root, "tools.json");
		const shutdown = path.join(root, "shutdown.json");
		fs.writeFileSync(path.join(agentDir, "extensions", "observe.ts"), `import { writeFileSync } from "node:fs";
import { Type } from "typebox";
import { fauxProvider } from "@earendil-works/pi-ai";
export default function(pi) {
	const faux = fauxProvider();
	pi.registerProvider("faux", { api: faux.api, baseUrl: faux.getModel().baseUrl, apiKey: "fixture-key", models: faux.models, streamSimple: faux.provider.streamSimple });
	pi.registerTool({ name: "fixture_custom_tool", label: "Fixture", description: "Local startup probe", parameters: Type.Object({}),
		execute: async () => { throw new Error("No tool calls expected"); } });
	pi.on("session_start", (_event, ctx) => {
		writeFileSync(process.env.TOOL_PROBE_OUTPUT, JSON.stringify(pi.getActiveTools()));
		ctx.shutdown();
	});
	pi.on("session_shutdown", () => writeFileSync(process.env.TOOL_PROBE_SHUTDOWN, JSON.stringify({ providerCalls: faux.state.callCount })));
}`);
		const delegate = discoverAgentsAll(root).builtin.find((agent) => agent.name === "delegate");
		assert.ok(delegate);
		const built = buildPiArgs({ baseArgs: ["--offline", "--mode", "rpc", "--no-prompt-templates", "--no-themes"],
			task: "Do not invoke a model", sessionEnabled: false, model: "faux/faux-1", inheritProjectContext: false, inheritSkills: false,
			tools: delegate.tools, extensions: delegate.extensions, mcpDirectTools: delegate.mcpDirectTools, allowSubagents: delegate.allowSubagents,
			projectTrust: "no-approve" });
		const child = spawnSync(process.execPath, [path.join(packageRoot, "dist/bundle/cli.js"), ...built.args], {
			cwd: root, input: "", encoding: "utf8", timeout: 15_000,
			env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: root, USERPROFILE: root,
				PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", ...built.env,
				TOOL_PROBE_OUTPUT: output, TOOL_PROBE_SHUTDOWN: shutdown },
		});
		assert.equal(child.status, 0, child.stderr || child.error?.message);
		assert.deepEqual(JSON.parse(fs.readFileSync(shutdown, "utf8")), { providerCalls: 0 });
		assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")).sort(), ["bash", "fixture_custom_tool", "read"]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

it("native Pi applies the saved-session cwd before extension execution and preserves the session on repeat opens", () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-native-session-cwd-")));
	const originalCwd = path.join(root, "original");
	const replacementCwd = path.join(root, "replacement project");
	const launchCwd = path.join(root, "launch");
	try {
		for (const name of ["original", "replacement project", "launch", "home", "agent", "tmp", "jiti"]) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
		const sessionFile = path.join(root, "saved.jsonl");
		const timestamp = "2026-01-01T00:00:00.000Z";
		const header = { type: "session", version: 3, id: "01234567-89ab-4cde-8012-3456789abcde", timestamp, cwd: originalCwd };
		const entries = [
			{ type: "model_change", id: "model", parentId: null, timestamp, provider: "faux", modelId: "faux-1" },
			{ type: "thinking_level_change", id: "thinking", parentId: "model", timestamp, thinkingLevel: "off" },
			{ type: "message", id: "user", parentId: "thinking", timestamp, message: { role: "user", content: "Saved synthetic history", timestamp: 0 } },
			{ type: "custom", id: "state", parentId: "user", timestamp, customType: "fixture", data: { retained: true } },
		];
		const bytes = `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
		fs.writeFileSync(sessionFile, bytes);
		const observer = path.join(root, "observe.ts");
		fs.writeFileSync(observer, `import { writeFileSync } from "node:fs";
import { fauxProvider } from "@earendil-works/pi-ai";
export default async function(pi) {
	// No cwd option: observe the native execution context before session_start.
	const executed = await pi.exec(process.execPath, ["-p", "process.cwd()"]);
	const faux = fauxProvider();
	pi.registerProvider("faux", { api: faux.api, baseUrl: faux.getModel().baseUrl, apiKey: "fixture-key", models: faux.models, streamSimple: faux.provider.streamSimple });
	pi.on("session_start", (_event, ctx) => {
		writeFileSync(process.env.SESSION_CWD_PROBE_OUTPUT, JSON.stringify({
			executed, cwd: ctx.cwd, processCwd: process.cwd(), sessionCwd: ctx.sessionManager.getCwd(),
			sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(),
			header: ctx.sessionManager.getHeader(), entries: ctx.sessionManager.getEntries(),
			model: { provider: ctx.model?.provider, id: ctx.model?.id },
		}));
		ctx.shutdown();
	});
	pi.on("session_shutdown", () => writeFileSync(process.env.SESSION_CWD_PROBE_SHUTDOWN, JSON.stringify({ providerCalls: faux.state.callCount })));
}`);

		function probe(label: string, saved: boolean, cwd: string | undefined, expectedCwd: string) {
			const output = path.join(root, `${label}.json`);
			const shutdownPath = path.join(root, `${label}-shutdown.json`);
			const built = buildPiArgs({ baseArgs: ["--offline", "--mode", "rpc", "--no-prompt-templates", "--no-themes"],
				task: "Do not invoke a model", sessionEnabled: saved, sessionFile: saved ? sessionFile : undefined, cwd,
				model: saved ? undefined : "faux/faux-1", inheritProjectContext: false, inheritSkills: false, extensions: [observer], projectTrust: "no-approve" });
			const command = [path.join(packageRoot, "dist/bundle/cli.js"), ...built.args];
			try {
				const child = spawnSync(process.execPath, command, { cwd: launchCwd, input: "", encoding: "utf8", timeout: 15_000,
					env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"),
						PI_CODING_AGENT_DIR: path.join(root, "agent"), TMPDIR: path.join(root, "tmp"), TMP: path.join(root, "tmp"), TEMP: path.join(root, "tmp"),
						JITI_FS_CACHE: path.join(root, "jiti"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", ...built.env,
						SESSION_CWD_PROBE_OUTPUT: output, SESSION_CWD_PROBE_SHUTDOWN: shutdownPath } });
				const observation = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, "utf8")) : undefined;
				const shutdown = fs.existsSync(shutdownPath) ? JSON.parse(fs.readFileSync(shutdownPath, "utf8")) : undefined;
				const savedBytes = fs.readFileSync(sessionFile, "utf8");
				if (process.env.PI_SESSION_CWD_EVIDENCE_DIR) {
					fs.mkdirSync(process.env.PI_SESSION_CWD_EVIDENCE_DIR, { recursive: true });
					fs.writeFileSync(path.join(process.env.PI_SESSION_CWD_EVIDENCE_DIR, `${label}.json`), JSON.stringify({ command: [process.execPath, ...command],
						launchCwd, requestedCwd: cwd, expectedCwd, originalCwdExists: fs.existsSync(originalCwd), status: child.status, signal: child.signal,
						error: child.error?.message, stdout: child.stdout, stderr: child.stderr, observation, shutdown, originalBytes: bytes, savedBytes }, null, 2));
				}
				assert.equal(child.status, 0, child.stderr || child.error?.message);
				assert.equal(child.signal, null);
				assert.equal(child.stderr, "");
				assert.deepEqual(observation.executed, { stdout: `${expectedCwd}\n`, stderr: "", code: 0, killed: false });
				assert.equal(observation.cwd, expectedCwd);
				assert.equal(observation.sessionCwd, expectedCwd);
				assert.equal(observation.processCwd, launchCwd);
				assert.deepEqual(observation.model, { provider: "faux", id: "faux-1" });
				assert.deepEqual(shutdown, { providerCalls: 0 });
				assert.equal(savedBytes, bytes);
				if (saved) {
					assert.equal(observation.sessionFile, sessionFile);
					assert.equal(observation.sessionId, header.id);
					assert.deepEqual(observation.header, header);
					assert.deepEqual(observation.entries, entries);
				}
			} finally {
				cleanupTempDir(built.tempDir);
			}
		}
		probe("saved-default", true, undefined, originalCwd);
		probe("saved-explicit", true, originalCwd, originalCwd);
		probe("fresh", false, replacementCwd, launchCwd);
		fs.rmdirSync(originalCwd);
		for (let turn = 0; turn < 2; turn++) probe(`replacement-${turn}`, true, replacementCwd, replacementCwd);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
