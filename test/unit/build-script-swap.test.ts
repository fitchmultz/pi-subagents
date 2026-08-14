import assert from "node:assert/strict";
import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const buildScript = join(projectRoot, "scripts", "build.mjs");

const tscStub = fileURLToPath(new URL("../fixtures/build-tsc-stub.cjs", import.meta.url));
const faultPreload = fileURLToPath(new URL("../fixtures/build-fs-fault-preload.mjs", import.meta.url));

function makeFixture(): string {
	const dir = mkdtempSync(join(tmpdir(), "build-swap-"));
	mkdirSync(join(dir, "node_modules", "typescript", "bin"), { recursive: true });
	copyFileSync(tscStub, join(dir, "node_modules", "typescript", "bin", "tsc"));
	return dir;
}

function faultArgs(): string[] {
	return ["--import", pathToFileURL(faultPreload).href];
}

async function runBuild(
	cwd: string,
	env: Record<string, string> = {},
	nodeArgs: string[] = [],
): Promise<{ code: number; stderr: string }> {
	try {
		const { stderr } = await execFile(process.execPath, [...nodeArgs, buildScript], {
			cwd,
			env: { ...process.env, ...env },
		});
		return { code: 0, stderr };
	} catch (error) {
		const failure = error as { code?: number; stderr?: string };
		return { code: failure.code ?? 1, stderr: failure.stderr ?? "" };
	}
}

function stagingDirs(cwd: string): string[] {
	return readdirSync(cwd).filter((name) => name.startsWith("dist.staging."));
}

async function withFixture(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = makeFixture();
	try {
		await run(dir);
	} finally {
		rmSync(dir, { force: true, recursive: true });
	}
}

test("build.mjs: failed compile preserves the previous dist and cleans staging", () =>
	withFixture(async (dir) => {
		mkdirSync(join(dir, "dist"));
		writeFileSync(join(dir, "dist", "sentinel.txt"), "previous build");
		const { code } = await runBuild(dir, { TSC_STUB_FAIL: "1" });
		assert.notEqual(code, 0);
		assert.ok(existsSync(join(dir, "dist", "sentinel.txt")));
		assert.deepEqual(stagingDirs(dir), []);
	}));

test("build.mjs: successful build replaces dist atomically, purging stale files", () =>
	withFixture(async (dir) => {
		mkdirSync(join(dir, "dist"));
		writeFileSync(join(dir, "dist", "stale.txt"), "old output");
		assert.equal((await runBuild(dir)).code, 0);
		assert.ok(existsSync(join(dir, "dist", "index.js")));
		assert.ok(!existsSync(join(dir, "dist", "stale.txt")));
		assert.deepEqual(stagingDirs(dir), []);
	}));

test("build.mjs: reaps dead-pid staging and keeps live-pid staging", () =>
	withFixture(async (dir) => {
		const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
		assert.equal(typeof deadPid, "number");
		mkdirSync(join(dir, `dist.staging.${deadPid}`, "partial"), { recursive: true });
		mkdirSync(join(dir, `dist.staging.${process.pid}`, "inflight"), { recursive: true });
		assert.equal((await runBuild(dir)).code, 0);
		assert.ok(!existsSync(join(dir, `dist.staging.${deadPid}`)));
		assert.ok(existsSync(join(dir, `dist.staging.${process.pid}`)));
	}));

test("build.mjs: warns and continues when stranded staging cannot be removed", () =>
	withFixture(async (dir) => {
		const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
		assert.equal(typeof deadPid, "number");
		const lockedName = `dist.staging.${deadPid}`;
		mkdirSync(join(dir, lockedName, "partial"), { recursive: true });
		const result = await runBuild(
			dir,
			{ BUILD_SWAP_FAULT: "stale-rm", LOCKED_STAGING_NAME: lockedName },
			faultArgs(),
		);
		assert.equal(result.code, 0);
		assert.match(result.stderr, /could not remove staging/);
		assert.ok(existsSync(join(dir, lockedName)));
		assert.ok(existsSync(join(dir, "dist", "index.js")));
	}));

test("build.mjs: concurrent build storms succeed with valid dist", { timeout: 30_000 }, () =>
	withFixture(async (dir) => {
		const results = await Promise.all(Array.from({ length: 4 }, () => runBuild(dir)));
		assert.deepEqual(results.flatMap((result) => (result.code === 0 ? [] : [result.stderr])), []);
		assert.ok(existsSync(join(dir, "dist", "index.js")));
		assert.deepEqual(stagingDirs(dir), []);
	}));

test("build.mjs: publishes retained staging instead of timing out on a slow winner", { timeout: 10_000 }, () =>
	withFixture(async (dir) => {
		const result = await runBuild(dir, { BUILD_SWAP_FAULT: "late-winner" }, faultArgs());
		assert.deepEqual(result, { code: 0, stderr: "" });
		assert.ok(existsSync(join(dir, "dist", "index.js")));
		assert.ok(existsSync(join(dir, "dist", "late-winner.txt")));
		assert.deepEqual(stagingDirs(dir), []);
	}));

test("build.mjs: deterministically discards staging after a concurrent winner", () =>
	withFixture(async (dir) => {
		const result = await runBuild(dir, { BUILD_SWAP_FAULT: "race-loss" }, faultArgs());
		assert.equal(result.code, 0);
		assert.match(result.stderr, /dist\/ was published by a concurrent build/);
		assert.ok(existsSync(join(dir, "dist", "winner.txt")));
		assert.deepEqual(stagingDirs(dir), []);
	}));

test("build.mjs: fails closed when a requested filesystem fault is unknown", () =>
	withFixture(async (dir) => {
		const result = await runBuild(dir, { BUILD_SWAP_FAULT: "unknown" }, faultArgs());
		assert.notEqual(result.code, 0);
		assert.match(result.stderr, /unknown build-swap fault: unknown/);
	}));

test("build.mjs: does not accept an empty dist as a published winner", () =>
	withFixture(async (dir) => {
		const result = await runBuild(dir, { BUILD_SWAP_FAULT: "empty-dist" }, faultArgs());
		assert.deepEqual(result, { code: 0, stderr: "" });
		assert.ok(existsSync(join(dir, "dist", "index.js")));
		assert.deepEqual(stagingDirs(dir), []);
	}));

test("build.mjs: caps persistent rename failures and preserves the diagnostic", { timeout: 10_000 }, () =>
	withFixture(async (dir) => {
		mkdirSync(join(dir, "dist"));
		writeFileSync(join(dir, "dist", "sentinel.txt"), "previous build");
		const result = await runBuild(dir, { BUILD_SWAP_FAULT: "rename-always" }, faultArgs());
		assert.notEqual(result.code, 0);
		assert.match(result.stderr, /synthetic permanent rename failure/);
		assert.ok(!existsSync(join(dir, "dist")));
		assert.ok(!existsSync(join(dir, "dist", "sentinel.txt")));
		assert.deepEqual(stagingDirs(dir), []);
	}));

test("build.mjs: rethrows when the staged emit disappears before publication", { timeout: 10_000 }, () =>
	withFixture(async (dir) => {
		const { code } = await runBuild(dir, { TSC_STUB_SABOTAGE_STAGING: "1" });
		assert.notEqual(code, 0);
		assert.ok(!existsSync(join(dir, "dist")));
	}));
