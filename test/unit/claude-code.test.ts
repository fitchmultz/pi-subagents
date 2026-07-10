import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	buildClaudeCodeInvocation,
	parseClaudeCodeModel,
	readClaudeCodeSessionMetadata,
	writeClaudeCodeSessionMetadata,
} from "../../src/runs/shared/claude-code.ts";

describe("Claude Code backend model mapping", () => {
	it("defaults fable/opus/sonnet to a 300k compaction window", () => {
		const invocation = buildClaudeCodeInvocation({ model: "claude-code/sonnet", task: "hi" });
		assert.deepEqual(invocation.args.slice(0, 8), ["-p", "--dangerously-skip-permissions", "--model", "sonnet", "--output-format", "stream-json", "--verbose", "--session-id"]);
		assert.equal(invocation.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "300000");
		assert.equal(invocation.model.context, "300k");
	});

	it("maps 1m aliases to Claude Code's [1m] syntax where needed", () => {
		assert.equal(parseClaudeCodeModel("claude-code/opus@1m").cliModel, "opus[1m]");
		assert.equal(parseClaudeCodeModel("claude-code/sonnet@1m").cliModel, "sonnet[1m]");
		assert.equal(parseClaudeCodeModel("claude-code/fable@1m").cliModel, "fable");
		assert.throws(() => parseClaudeCodeModel("claude-code/haiku@1m"), /haiku does not support @1m/);
	});

	it("maps supported Pi thinking suffixes to Claude Code effort levels", () => {
		for (const level of ["low", "medium", "high", "xhigh", "max"]) {
			const invocation = buildClaudeCodeInvocation({ model: `claude-code/sonnet:${level}`, task: "hi" });
			assert.deepEqual(invocation.args.slice(invocation.args.indexOf("--effort"), invocation.args.indexOf("--effort") + 2), ["--effort", level]);
		}
		assert.ok(!buildClaudeCodeInvocation({ model: "claude-code/sonnet:off", task: "hi" }).args.includes("--effort"));
		assert.ok(!buildClaudeCodeInvocation({ model: "claude-code/sonnet:minimal", task: "hi" }).args.includes("--effort"));
	});

	it("fails closed on unsupported explicit tool allowlist entries", () => {
		assert.throws(
			() => buildClaudeCodeInvocation({ model: "claude-code/sonnet", task: "hi", tools: ["read", "subagent"] }),
			/does not support tool allowlist entry: subagent/,
		);
		assert.throws(
			() => buildClaudeCodeInvocation({ model: "claude-code/sonnet", task: "hi", tools: ["mcp__server__tool"] }),
			/Supported tools: bash, read, edit, write, grep, glob, web_fetch, web_search/,
		);
		assert.throws(
			() => buildClaudeCodeInvocation({ model: "claude-code/sonnet", task: "hi", mcpDirectTools: ["github.create_issue"] }),
			/MCP direct tool allowlist entries: github\.create_issue/,
		);
		assert.throws(
			() => buildClaudeCodeInvocation({ model: "claude-code/sonnet", task: "hi", allowSubagents: true }),
			/does not support nested subagent fanout/,
		);
	});

	it("maps supported explicit tools without letting Claude Code consume the prompt as a variadic tool", () => {
		const invocation = buildClaudeCodeInvocation({ model: "claude-code/sonnet", task: "hi", tools: ["read", "bash", "web_search"] });
		assert.deepEqual(invocation.args.slice(invocation.args.indexOf("--tools"), invocation.args.indexOf("--tools") + 2), ["--tools", "Read,Bash,WebSearch"]);
		assert.ok(invocation.args.indexOf("hi") < invocation.args.indexOf("--tools"));
	});

	it("resumes from stored Claude Code session metadata", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-session-"));
		try {
			const sessionFile = path.join(dir, "session.jsonl");
			writeClaudeCodeSessionMetadata(sessionFile, {
				sessionId: "11111111-1111-4111-8111-111111111111",
				model: "claude-code/opus",
				cliModel: "opus",
				family: "opus",
				context: "300k",
				updatedAt: 1,
			});
			assert.equal(readClaudeCodeSessionMetadata(sessionFile)?.sessionId, "11111111-1111-4111-8111-111111111111");
			const invocation = buildClaudeCodeInvocation({ model: "claude-code/opus", task: "continue", sessionFile });
			assert.ok(invocation.args.includes("--resume"));
			assert.ok(!invocation.args.includes("--session-id"));
			assert.equal(invocation.sessionId, "11111111-1111-4111-8111-111111111111");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
