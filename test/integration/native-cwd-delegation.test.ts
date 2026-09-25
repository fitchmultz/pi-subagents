import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { findPackageJSON } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const host = process.env.PI_CONTEXT_TEST_PACKAGE_ROOT ?? path.dirname(findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url)!);
const owner = process.env.PI_CWD_TEST_OWNER ?? path.join(repo, "test/fixtures/native-execution-cwd-owner.ts");
test("real executor and native CLI carry owner cwd through launch, fork and explicit continuation", (t) => {
	const evidence = process.env.PI_CWD_TEST_EVIDENCE_DIR;
	if (evidence) fs.mkdirSync(evidence, { recursive: true });
	const root = fs.realpathSync(fs.mkdtempSync(path.join(evidence ?? os.tmpdir(), "pi-cwd-delegation-")));
	t.after(() => { if (!evidence) fs.rmSync(root, { recursive: true, force: true }); });
	const result = spawnSync(process.execPath, [path.join(repo, "test/fixtures/native-cwd-delegation.mjs"), root, repo, host, owner], {
		encoding: "utf8", timeout: 90_000, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: root, USERPROFILE: root, PI_PACKAGE_DIR: host, PI_OFFLINE: "1" },
	});
	fs.writeFileSync(path.join(root, "process.log"), `${result.stdout}\n${result.stderr}`);
	assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout);
	t.diagnostic(`Full delegation evidence: ${root}`);
});
