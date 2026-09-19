import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Captured from the adapter's computeServerHash, independently of this consumer.
const hashes = {
	"fitch-fixture": "43f0e396219a77e81b9f5d9602f5554eb2e84d89dca63b9a05490dfc7e6ebd8c",
	"upstream-fixture": "2616c9b62539368b80d6a8c4e4e095ef422b19e77c35acb5b0c3c16f7b38c34b",
};
const resolver = new URL("../../src/runs/shared/mcp-direct-tool-allowlist.ts", import.meta.url).href;

function fixture(run: (root: string, agentDir: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), "subagent-mcp-names-"));
	const agentDir = join(root, "agent");
	mkdirSync(join(agentDir, "fitch-mcp-adapter"), { recursive: true });
	try { run(root, agentDir); } finally { rmSync(root, { recursive: true, force: true }); }
}

function writeConfig(directory: string, command: keyof typeof hashes): void {
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "mcp.json"), JSON.stringify({
		mcpServers: { demo: { command } },
	}));
}

function writeCache(directory: string, command: keyof typeof hashes, tool: string): void {
	writeFileSync(join(directory, "mcp-cache.json"), JSON.stringify({
		version: 1,
		servers: { demo: {
			configHash: hashes[command], cachedAt: Date.now(), tools: [{ name: tool }],
			resources: [{ name: "Notes", uri: "fixture://notes" }],
		} },
	}));
}

function resolveNames(root: string, agentDir: string): string[] {
	return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
		const { resolveMcpDirectToolNames } = await import(${JSON.stringify(resolver)});
		console.log(JSON.stringify(resolveMcpDirectToolNames(["demo"], process.cwd())));
	`], {
		cwd: root, encoding: "utf8",
		env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agentDir },
	}));
}

test("reads independently named Fitch config and native metadata without changing upstream selection", () => {
	fixture((root, agentDir) => {
		const fitch = join(agentDir, "fitch-mcp-adapter");
		writeConfig(fitch, "fitch-fixture");
		writeCache(fitch, "fitch-fixture", "fitch_echo");
		assert.deepEqual(resolveNames(root, agentDir), ["demo_fitch_echo", "demo_read_notes"]);
		writeConfig(agentDir, "upstream-fixture");
		writeCache(agentDir, "upstream-fixture", "upstream_echo");
		assert.deepEqual(resolveNames(root, agentDir), [
			"demo_upstream_echo", "demo_get_notes", "demo_fitch_echo", "demo_read_notes",
		]);
	});
});

test("does not pair one adapter's private config with the other's metadata", () => {
	fixture((root, agentDir) => {
		const fitch = join(agentDir, "fitch-mcp-adapter");
		writeConfig(agentDir, "fitch-fixture");
		writeCache(fitch, "fitch-fixture", "echo");
		assert.deepEqual(resolveNames(root, agentDir), []);
	});
});

test("resolves Fitch project config from the requested child cwd", () => {
	fixture((root, agentDir) => {
		writeConfig(join(root, ".pi", "fitch-mcp-adapter"), "fitch-fixture");
		writeCache(join(agentDir, "fitch-mcp-adapter"), "fitch-fixture", "echo");
		assert.deepEqual(resolveNames(root, agentDir), ["demo_echo", "demo_read_notes"]);
	});
});
