import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";

it("native reload and a new parent process retain ownership, effective launch, questions, review, and lineage without adopting another parent", { timeout: 120_000 }, () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-native-ownership-"));
	const repo = fileURLToPath(new URL("../../", import.meta.url));
	const packageRoot = process.env.PI_OWNERSHIP_TEST_PACKAGE_ROOT ?? path.dirname(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
	const env = { ...process.env };
	for (const key of Object.keys(env)) if (key.startsWith("PI_SUBAGENT_") || /(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN)$/.test(key)) delete env[key];
	try {
		for (const phase of ["journey", "cold-parent"]) {
			const result = spawnSync(process.execPath, [path.join(repo, "test/fixtures/native-run-ownership.mjs"), root, repo, packageRoot, phase], { cwd: repo, env, encoding: "utf8", timeout: 110_000, maxBuffer: 1024 * 1024 });
			assert.equal(result.status, 0, `${phase}: ${result.stderr || result.stdout || result.error?.message}`);
			const evidence = JSON.parse(fs.readFileSync(path.join(root, phase === "journey" ? "evidence.json" : "cold-evidence.json"), "utf8"));
			assert.equal(evidence.nativeProviderRequests, 0);
			assert.deepEqual(evidence.failures, []);
			if (phase === "journey") assert.ok(evidence.ownedRunCount > 50);
			else {
				assert.notEqual(evidence.parentPid, evidence.coldParent.originalPid);
				assert.ok(evidence.coldParent.continuedId);
			}
		}
	} finally {
		if (process.env.PI_OWNERSHIP_KEEP_EVIDENCE) console.log(`Native ownership evidence: ${root}/evidence.json\nCold parent evidence: ${root}/cold-evidence.json`);
		else fs.rmSync(root, { recursive: true, force: true });
	}
});
