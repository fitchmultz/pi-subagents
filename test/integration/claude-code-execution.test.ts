import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { executeAsyncSingle } from "../../src/runs/background/async-execution.ts";
import { ASYNC_DIR, RESULTS_DIR, getAsyncConfigPath } from "../../src/shared/types.ts";
import { getRunMetadataDir, questionProcessAlive } from "../../src/runs/shared/supervisor-questions.ts";
import { readClaudeCodeSessionMetadata } from "../../src/runs/shared/claude-code.ts";
import { createStructuredOutputRuntime } from "../../src/runs/shared/structured-output.ts";
import { makeAgent, createTempDir, removeTempDir, createEventBus } from "../support/helpers.ts";

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
const fence = String.fromCharCode(96).repeat(3);
const report = args.at(-1).includes("## Acceptance Contract") ? "\\n" + [fence + "acceptance-report", JSON.stringify({ criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "Claude fixture proof" }] }), fence].join("\\n") : "";
fs.writeFileSync(path.join(callsDir, \`call-\${Date.now()}-\${process.pid}.json\`), JSON.stringify({ args, env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW ?? null } }), "utf-8");
process.stdout.write(JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: (args.includes("--resume") ? "MOCK_RESUMED" : "MOCK_STARTED") + report,
  stop_reason: "end_turn",
  session_id: sessionId,
  total_cost_usd: 0.01,
  usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 3, cache_creation_input_tokens: 5 },
  modelUsage: { "claude-sonnet-5": { contextWindow: 1000000, maxOutputTokens: 64000 } },
  ...(args.includes("--json-schema") ? { structured_output: { ok: true } } : {})
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

describe("Claude Code child backend", () => {
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
		const first = await runSync(tempDir, [agent], "echo", "start", { cwd: tempDir, sessionFile });
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

		const second = await runSync(tempDir, [agent], "echo", "continue", { cwd: tempDir, sessionFile });
		assert.equal(second.exitCode, 0);
		assert.equal(second.finalOutput, "MOCK_RESUMED");
		const secondCall = readCalls(mock.callsDir)[1]!;
		assert.ok(secondCall.args.includes("--resume"));
		assert.equal(secondCall.args[secondCall.args.indexOf("--resume") + 1], metadata.sessionId);
		assert.ok(!secondCall.args.includes("--session-id"));
	});

	it("uses Claude Code native structured output", async () => {
		const schema = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };
		const result = await runSync(tempDir, [makeAgent("echo", { model: "claude-code/sonnet" })], "echo", "return JSON", {
			cwd: tempDir,
			structuredOutput: createStructuredOutputRuntime(schema, path.join(tempDir, "structured")),
		});
		assert.equal(result.exitCode, 0);
		assert.deepEqual(result.structuredOutput, { ok: true });
		const args = readCalls(mock.callsDir)[0]!.args;
		assert.deepEqual(args.slice(args.indexOf("--json-schema"), args.indexOf("--json-schema") + 2), ["--json-schema", JSON.stringify(schema)]);
	});

	for (const background of [false, true]) it(`${background ? "background" : "foreground"} Claude Code finalization retains its text contract and initial JSON schema`, async () => {
		const id = path.basename(tempDir);
		const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
		const agent = makeAgent("echo", { model: "claude-code/sonnet" });
		const acceptance = { criteria: ["Deliver the final result"], maxFinalizationTurns: 1 };
		let result;
		try {
			if (background) {
				executeAsyncSingle(id, { agent: "echo", task: "Return the result", agentConfig: agent,
					ctx: { pi: { events: createEventBus() }, cwd: tempDir, currentSessionId: id }, acceptance, outputSchema: schema,
					sessionFile: path.join(tempDir, "session.jsonl"), shareEnabled: false, maxSubagentDepth: 2 });
				const resultPath = path.join(RESULTS_DIR, `${id}.json`);
				const deadline = Date.now() + 15_000;
				while (!fs.existsSync(resultPath)) {
					assert.ok(Date.now() < deadline, "Claude fixture background result must arrive");
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
				result = JSON.parse(fs.readFileSync(resultPath, "utf8")).results[0];
				const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf8"));
				while (questionProcessAlive({ pid: status.pid })) {
					assert.ok(Date.now() < deadline, "owned Claude fixture runner must exit");
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
			} else {
				result = await runSync(tempDir, [agent], "echo", "Return the result", { runId: id, acceptance,
					sessionFile: path.join(tempDir, "session.jsonl"), structuredOutput: createStructuredOutputRuntime(schema, tempDir) });
			}
			assert.equal(result.exitCode, 0, result.error);
			assert.equal(result.finalOutput ?? result.output, "MOCK_RESUMED");
			assert.equal(result.acceptance.status, "checked");
			assert.equal(result.acceptance.finalization.turns.length, 1);
			assert.deepEqual(result.structuredOutput, { ok: true });
			assert.deepEqual(JSON.parse(fs.readFileSync(result.structuredOutputPath, "utf8")), { ok: true });
			const calls = readCalls(mock.callsDir);
			assert.equal(calls.length, 2);
			assert.equal(calls[0].args[calls[0].args.indexOf("--json-schema") + 1], JSON.stringify(schema));
			assert.ok(!calls[1].args.includes("--json-schema"));
			assert.doesNotMatch(calls[1].args.at(-1)!, /sole `structured_output`/);
		} finally {
			removeTempDir(getRunMetadataDir(id));
			removeTempDir(path.join(ASYNC_DIR, id));
			fs.rmSync(path.join(RESULTS_DIR, `${id}.json`), { force: true });
			fs.rmSync(getAsyncConfigPath(id), { force: true });
		}
	});

	it("fails closed for Claude Code agents with MCP direct tool allowlists", async () => {
		const agent = makeAgent("echo", { model: "claude-code/sonnet", tools: ["read"], mcpDirectTools: ["github.create_issue"] });
		const result = await runSync(tempDir, [agent], "echo", "start", { cwd: tempDir });
		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? result.finalOutput ?? "", /MCP direct tool allowlist entries: github\.create_issue/);
		assert.deepEqual(readCalls(mock.callsDir), []);
	});

	it("fails closed for Claude Code agents with nested subagent fanout enabled", async () => {
		const agent = makeAgent("echo", { model: "claude-code/sonnet", allowSubagents: true });
		const result = await runSync(tempDir, [agent], "echo", "start", { cwd: tempDir });
		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? result.finalOutput ?? "", /does not support nested subagent fanout/);
		assert.deepEqual(readCalls(mock.callsDir), []);
	});
});
