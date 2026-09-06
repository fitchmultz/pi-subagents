import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

for (const route of ["parent", "child"]) it(`native registered ${route} tools retain outcomes, aggregate errors and recovery receipts`, { timeout: 100_000 }, async (t) => {
	const evidenceDir = process.env.PI_NATIVE_TOOL_RESULT_EVIDENCE_DIR ?? os.tmpdir();
	fs.mkdirSync(evidenceDir, { recursive: true });
	const root = fs.mkdtempSync(path.join(evidenceDir, `native-tool-results-${route}-`));
	const repo = fileURLToPath(new URL("../../", import.meta.url));
	const sdkRoot = process.env.PI_OWNERSHIP_TEST_PACKAGE_ROOT ?? path.dirname(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
	// No inherited parent routes, user resources, provider credentials, or shared runtime.
	const env = {
		PATH: process.env.PATH, HOME: root, TMPDIR: root, TMP: root, TEMP: root,
		CI: "1", TERM: "dumb", PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", NODE_DISABLE_COMPILE_CACHE: "1",
		PI_CODING_AGENT_DIR: path.join(root, "agent"), PI_SUBAGENT_TEMP_ROOT: path.join(root, "pi-subagents-runtime"),
		PI_PACKAGE_DIR: sdkRoot, PI_INTERCOM_TEST_SDK: sdkRoot, PI_OWNERSHIP_TEST_PACKAGE_ROOT: sdkRoot,
		JITI_FS_CACHE: path.join(root, "jiti"),
	};
	let passed = false;
	try {
		const child = spawnSync(process.execPath, [path.join(repo, "test/fixtures/native-tool-results.mjs"), root, repo, sdkRoot, route], {
			cwd: root, env, encoding: "utf8", timeout: 90_000, maxBuffer: 1024 * 1024,
		});
		fs.writeFileSync(path.join(root, "stdout.log"), child.stdout ?? "");
		fs.writeFileSync(path.join(root, "stderr.log"), child.stderr ?? "");
		assert.equal(child.error, undefined, child.error?.message);
		const evidence = JSON.parse(fs.readFileSync(path.join(root, "evidence.json"), "utf8"));
		assert.deepEqual(evidence.failures, [], child.stderr || child.stdout);
		assert.equal(evidence.nativeProviderRequests, 0);
		assert.equal(evidence.networkRequests, 0);
		assert.deepEqual(evidence.extensionErrors, []);
		assert.equal(child.stderr, "");
		assert.equal(evidence.cases.filter((entry) => entry.mixed).length, 6);
		assert.equal(evidence.cases.filter((entry) => entry.name.endsWith("-pure")).length, 8);
		assert.equal(evidence.cases.find((entry) => entry.name === "static-chain-interrupt-pure")?.liveUpdate?.type, "tool_execution_update");
		for (const name of ["static-chain-interrupt-mixed", "static-chain-interrupt-pure"]) assert.equal(evidence.cases.find((entry) => entry.name === name)?.settlingUpdate?.type, "tool_execution_update");
		for (const name of ["static-preflight-failure", "dynamic-collect-schema-failure", "dynamic-collect-success", "normal-success", "intercom-receipt-success", "inspect-handle"]) assert.ok(evidence.cases.some((entry) => entry.name === name), name);
		for (const receipt of evidence.cases) await t.test(receipt.name, () => {
			assert.deepEqual(receipt.failures, [], receipt.failures.join("\n"));
			assert.ok(receipt.checks.length > 0);
		});
		assert.equal(child.status, 0, child.stdout);
		passed = true;
	} finally {
		if (!passed || process.env.PI_NATIVE_TOOL_RESULT_EVIDENCE_DIR) console.log(`Native registered-tool evidence: ${root}/evidence.json`);
		else fs.rmSync(root, { recursive: true, force: true });
	}
});
