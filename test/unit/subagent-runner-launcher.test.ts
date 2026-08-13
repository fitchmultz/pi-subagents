import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const launcherPath = fileURLToPath(new URL("../../src/runs/background/subagent-runner-launcher.ts", import.meta.url));

test("retries a runner that loses dependencies before startup", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-launcher-test-"));
	try {
		const runnerPath = path.join(dir, "runner.mjs");
		const configPath = path.join(dir, "config.json");
		const attemptsPath = path.join(dir, "attempts");
		fs.writeFileSync(configPath, JSON.stringify({ asyncDir: dir, attemptsPath }));
		fs.writeFileSync(
			runnerPath,
			`import fs from "node:fs";
import path from "node:path";
const config = JSON.parse(fs.readFileSync(process.argv[2], "utf-8"));
const attempts = fs.existsSync(config.attemptsPath) ? Number(fs.readFileSync(config.attemptsPath, "utf-8")) + 1 : 1;
fs.writeFileSync(config.attemptsPath, String(attempts));
if (attempts === 1) {
  console.error("Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'typebox'");
  process.exit(1);
}
fs.writeFileSync(path.join(config.asyncDir, "status.json"), "{}");
`,
		);

		const result = spawnSync(process.execPath, [launcherPath, runnerPath, configPath], { encoding: "utf-8" });

		assert.equal(result.status, 0, result.stderr);
		assert.equal(fs.readFileSync(attemptsPath, "utf-8"), "2");
		assert.equal(fs.existsSync(path.join(dir, "status.json")), true);
		assert.match(result.stderr, /retrying startup/);
		assert.match(result.stderr, /Cannot find package/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
