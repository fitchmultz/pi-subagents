import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { makeAgent, createTempDir, removeTempDir, tryImport } from "../support/helpers.ts";
import { readClaudeCodeSessionMetadata } from "../../src/runs/shared/claude-code.ts";

interface RunSyncResult {
	exitCode: number;
	finalOutput?: string;
	model?: string;
	sessionFile?: string;
	usage: { turns: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
}

interface ExecutionModule {
	runSync(runtimeCwd: string, agents: ReturnType<typeof makeAgent>[], agentName: string, task: string, options: Record<string, unknown>): Promise<RunSyncResult>;
}

const execution = await tryImport<ExecutionModule>("./src/runs/foreground/execution.ts");
const available = !!execution;

function installMockClaude(root: string): { callsDir: string; restore: () => void } {
	const binDir = path.join(root, "bin");
	const callsDir = path.join(root, "calls");
	fs.mkdirSync(binDir, { recursive: true });
	fs.mkdirSync(callsDir, { recursive: true });
	const scriptPath = path.join(root, "mock-claude.mjs");
	fs.writeFileSync(scriptPath, `
import fs from "node:fs";
import path from "node:path";
const callsDir = process.env.MOCK_CLAUDE_CALLS_DIR;
const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};
const sessionId = valueAfter("--resume") || valueAfter("--session-id") || "00000000-0000-4000-8000-000000000000";
fs.writeFileSync(path.join(callsDir, \`call-\${Date.now()}-\${process.pid}.json\`), JSON.stringify({ args, env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW ?? null } }), "utf-8");
process.stdout.write(JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: args.includes("--resume") ? "MOCK_RESUMED" : "MOCK_STARTED",
  stop_reason: "end_turn",
  session_id: sessionId,
  total_cost_usd: 0.01,
  usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 3, cache_creation_input_tokens: 5 },
  modelUsage: { "claude-sonnet-5": { contextWindow: 1000000, maxOutputTokens: 64000 } }
}) + "\\n");
`, "utf-8");
	const launcher = path.join(binDir, "claude");
	fs.writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, "utf-8");
	fs.chmodSync(launcher, 0o755);
	const oldPath = process.env.PATH;
	const oldCallsDir = process.env.MOCK_CLAUDE_CALLS_DIR;
	process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
	process.env.MOCK_CLAUDE_CALLS_DIR = callsDir;
	return {
		callsDir,
		restore: () => {
			if (oldPath === undefined) delete process.env.PATH;
			else process.env.PATH = oldPath;
			if (oldCallsDir === undefined) delete process.env.MOCK_CLAUDE_CALLS_DIR;
			else process.env.MOCK_CLAUDE_CALLS_DIR = oldCallsDir;
		},
	};
}

function readCalls(callsDir: string): Array<{ args: string[]; env: Record<string, string | null> }> {
	return fs.readdirSync(callsDir)
		.filter((name) => name.startsWith("call-"))
		.sort()
		.map((name) => JSON.parse(fs.readFileSync(path.join(callsDir, name), "utf-8")) as { args: string[]; env: Record<string, string | null> });
}

describe("Claude Code child backend", { skip: !available ? "execution module unavailable" : undefined }, () => {
	let tempDir: string;
	let mock: { callsDir: string; restore: () => void };

	beforeEach(() => {
		tempDir = createTempDir("claude-code-exec-");
		mock = installMockClaude(tempDir);
	});

	afterEach(() => {
		mock.restore();
		removeTempDir(tempDir);
	});

	it("runs and resumes claude-code/* models through claude -p", async () => {
		const sessionFile = path.join(tempDir, "session.jsonl");
		const agent = makeAgent("echo", { model: "claude-code/sonnet", thinking: "high", tools: ["bash", "read"] });
		const first = await execution!.runSync(tempDir, [agent], "echo", "start", { cwd: tempDir, sessionFile });
		assert.equal(first.exitCode, 0);
		assert.equal(first.finalOutput, "MOCK_STARTED");
		assert.equal(first.model, "claude-code/sonnet:high");
		assert.equal(first.sessionFile, sessionFile);
		const metadata = readClaudeCodeSessionMetadata(sessionFile);
		assert.ok(metadata?.sessionId);

		const firstCall = readCalls(mock.callsDir)[0]!;
		assert.ok(firstCall.args.includes("--dangerously-skip-permissions"));
		assert.ok(!firstCall.args.includes("--safe-mode"));
		assert.deepEqual(firstCall.args.slice(firstCall.args.indexOf("--model"), firstCall.args.indexOf("--model") + 2), ["--model", "sonnet"]);
		assert.deepEqual(firstCall.args.slice(firstCall.args.indexOf("--effort"), firstCall.args.indexOf("--effort") + 2), ["--effort", "high"]);
		assert.ok(firstCall.args.includes("--session-id"));
		assert.equal(firstCall.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "300000");

		const second = await execution!.runSync(tempDir, [agent], "echo", "continue", { cwd: tempDir, sessionFile });
		assert.equal(second.exitCode, 0);
		assert.equal(second.finalOutput, "MOCK_RESUMED");
		const secondCall = readCalls(mock.callsDir)[1]!;
		assert.ok(secondCall.args.includes("--resume"));
		assert.equal(secondCall.args[secondCall.args.indexOf("--resume") + 1], metadata.sessionId);
		assert.ok(!secondCall.args.includes("--session-id"));
	});

	it("fails closed for Claude Code agents with MCP direct tool allowlists", async () => {
		const agent = makeAgent("echo", { model: "claude-code/sonnet", tools: ["read"], mcpDirectTools: ["github.create_issue"] });
		const result = await execution!.runSync(tempDir, [agent], "echo", "start", { cwd: tempDir });
		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? result.finalOutput ?? "", /MCP direct tool allowlist entries: github\.create_issue/);
		assert.deepEqual(readCalls(mock.callsDir), []);
	});

	it("fails closed for Claude Code agents with nested subagent fanout enabled", async () => {
		const agent = makeAgent("echo", { model: "claude-code/sonnet", allowSubagents: true });
		const result = await execution!.runSync(tempDir, [agent], "echo", "start", { cwd: tempDir });
		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? result.finalOutput ?? "", /does not support nested subagent fanout/);
		assert.deepEqual(readCalls(mock.callsDir), []);
	});
});
