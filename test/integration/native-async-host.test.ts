import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findPackageJSON } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const sdkRoot = process.env.PI_NATIVE_ASYNC_TEST_SDK ?? path.dirname(findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url)!);
const suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-native-suite-"));
Object.assign(process.env, { HOME: suiteRoot, PI_CODING_AGENT_DIR: path.join(suiteRoot, "agent"), PI_PACKAGE_DIR: sdkRoot,
	PI_SUBAGENT_TEMP_ROOT: path.join(suiteRoot, "pi-subagents-runtime"), PI_OFFLINE: "1" });
const { AgentSession } = await import(pathToFileURL(path.join(sdkRoot, "dist/index.js")).href);
for (const [phase, title] of [["portable-child", "persists nested usage once"], ["portable-child-control", "keeps its wait attached during interruption"]]) test(`child-safe delegation ${title} through the native host`, { timeout: 40_000 }, () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-native-child-"));
	try {
		const result = spawnSync(process.execPath, [path.join(repo, "test/fixtures/native-async-parent.mjs"), root, repo, sdkRoot, phase, "nested"],
			{ cwd: repo, encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
		assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
		const evidence = JSON.parse(fs.readFileSync(path.join(root, `${phase}-evidence.json`), "utf8"));
		assert.equal(evidence.networkRequests, 0);
		assert.deepEqual(evidence.errors, []);
	} finally {
		fs.writeFileSync(path.join(root, "release-child"), "release");
		console.log(`Native nested usage evidence: ${root}`);
	}
});
for (const variant of ["restart", "child-restart", "advanced-child-restart", "advanced-parent-restart", "continue-restart", "answer-restart", "canonical-result", "question-restart", "compaction", "branch", "fork", "steering", "steering-disconnect"]) test(`native delegation survives ${variant} with the original call and one charge per launch`, { timeout: 90_000 }, (t) => {
	if (typeof AgentSession.prototype.getPendingToolCalls !== "function") {
		assert.notEqual(process.env.PI_NATIVE_ASYNC_REQUIRE_HOST, "1", "native async host required by this invocation");
		t.skip("host lacks public native async lifecycle; application and portable contracts run separately"); return;
	}
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `subagent-native-${variant}-`));
	try {
		for (const phase of variant === "fork" ? ["seed", "fork", "resume"] : ["seed", "resume"]) {
			const result = spawnSync(process.execPath, [path.join(repo, "test/fixtures/native-async-parent.mjs"), root, repo, sdkRoot, phase, variant],
				{ cwd: repo, encoding: "utf8", timeout: 25_000, maxBuffer: 2 * 1024 * 1024 });
			assert.equal(result.status, 0, `${phase}: ${result.stderr || result.stdout || result.error?.message}`);
			const evidence = JSON.parse(fs.readFileSync(path.join(root, `${phase}-evidence.json`), "utf8"));
			assert.equal(evidence.networkRequests, 0);
			assert.deepEqual(evidence.errors, []);
		}
	} finally {
		// Release even a failed fixture so its detached child can exit without losing its journal.
		fs.writeFileSync(path.join(root, "release-child"), "release");
		console.log(`Native async evidence: ${root}`);
	}
});
