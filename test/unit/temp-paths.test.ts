import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	ASYNC_DIR,
	CHAIN_RUNS_DIR,
	RESULTS_DIR,
	TEMP_ARTIFACTS_DIR,
	TEMP_ROOT_DIR,
	getAsyncConfigPath,
	resolveTempRootDir,
	resolveTempScopeId,
} from "../../src/shared/types.ts";

describe("resolveTempScopeId", () => {
	it("prefers uid when available", () => {
		const scope = resolveTempScopeId({
			getuid: () => 501,
			env: { USER: "alice" },
			userInfo: () => ({ username: "alice" }),
		});
		assert.equal(scope, "uid-501");
	});

	it("falls back to environment usernames when uid is unavailable", () => {
		const scope = resolveTempScopeId({
			getuid: undefined,
			env: { USERNAME: "Alice Example" },
			userInfo: () => ({ username: "ignored" }),
		});
		assert.equal(scope, "user-Alice-Example");
	});

	it("falls back to os.userInfo when environment is missing", () => {
		const scope = resolveTempScopeId({
			getuid: undefined,
			env: {},
			userInfo: () => ({ username: "svc_account" }),
		});
		assert.equal(scope, "user-svc_account");
	});

	it("falls back to home path when os.userInfo throws", () => {
		const scope = resolveTempScopeId({
			getuid: undefined,
			env: {},
			userInfo: () => {
				throw new Error("uv_os_get_passwd returned ENOENT");
			},
			homedir: () => "/home/12345/app user",
		});
		assert.equal(scope, "home-home-12345-app-user");
	});
});

describe("resolveTempRootDir", () => {
	it("accepts only dedicated pi-subagents directories", () => {
		assert.equal(resolveTempRootDir("/tmp/pi-subagents-isolated"), path.resolve("/tmp/pi-subagents-isolated"));
		assert.throws(() => resolveTempRootDir("/tmp"), /dedicated 'pi-subagents-\*' directory/);
		assert.throws(() => resolveTempRootDir("/"), /dedicated 'pi-subagents-\*' directory/);
	});
});

describe("temp-root write boundaries", () => {
	it("refuses foreground artifact writes through a symlinked configured root", { skip: process.platform === "win32" }, () => {
		const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-temp-root-boundary-"));
		const target = path.join(scratch, "target");
		const configuredRoot = path.join(scratch, "pi-subagents-unsafe");
		fs.mkdirSync(target);
		fs.symlinkSync(target, configuredRoot, "dir");
		try {
			const artifactsModule = new URL("../../src/shared/artifacts.ts", import.meta.url).href;
			const script = `import { ensureArtifactsDir } from ${JSON.stringify(artifactsModule)}; ensureArtifactsDir(${JSON.stringify(path.join(configuredRoot, "artifacts"))});`;
			const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
				encoding: "utf-8",
				env: { ...process.env, PI_SUBAGENT_TEMP_ROOT: configuredRoot },
			});
			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /Unsafe pi-subagents temp root/);
			assert.equal(fs.existsSync(path.join(target, "artifacts")), false);
		} finally {
			fs.rmSync(scratch, { recursive: true, force: true });
		}
	});
});

describe("shared temp paths", () => {
	it("anchors shared temp directories under one scoped root", () => {
		assert.equal(path.dirname(RESULTS_DIR), TEMP_ROOT_DIR);
		assert.equal(path.dirname(ASYNC_DIR), TEMP_ROOT_DIR);
		assert.equal(path.dirname(CHAIN_RUNS_DIR), TEMP_ROOT_DIR);
		assert.equal(path.dirname(TEMP_ARTIFACTS_DIR), TEMP_ROOT_DIR);
		assert.match(path.basename(TEMP_ROOT_DIR), /^pi-subagents-/);
		assert.equal(path.basename(RESULTS_DIR), "async-subagent-results");
		assert.equal(path.basename(ASYNC_DIR), "async-subagent-runs");
		assert.equal(path.basename(CHAIN_RUNS_DIR), "chain-runs");
		assert.equal(path.basename(TEMP_ARTIFACTS_DIR), "artifacts");
	});

	it("writes async config files under the same scoped temp root", () => {
		assert.equal(path.dirname(getAsyncConfigPath("abc123")), TEMP_ROOT_DIR);
		assert.equal(path.basename(getAsyncConfigPath("abc123")), "async-cfg-abc123.json");
	});
});
