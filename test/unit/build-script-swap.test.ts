import assert from "node:assert/strict";
import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const buildScript = join(projectRoot, "scripts", "build.mjs");

// Stub tsc: build.mjs runs node_modules/typescript/bin/tsc through process.execPath,
// so a plain CJS file suffices. It honors --outDir and fails on demand, which lets
// these tests drive the swap logic without a real TypeScript compile.
const TSC_STUB = `
if (process.env.TSC_STUB_FAIL === "1") {
	console.error("stub-tsc: induced failure");
	process.exit(1);
}
const fs = require("node:fs");
const path = require("node:path");
const outDir = process.argv[process.argv.indexOf("--outDir") + 1];
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "index.js"), "export const built = true;\\n");
if (process.env.TSC_STUB_SABOTAGE_STAGING === "1") {
	fs.rmSync(outDir, { recursive: true, force: true });
}
`;

// Fail the first rename, then publish a simulated winner after 2.2 seconds.
// The old bounded poll discarded its own staging tree and exited 1 before this
// timer fired; retry-rename keeps its emit and publishes it immediately.
const LATE_WINNER_PRELOAD = `
import { createRequire, syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const originalRename = fsPromises.rename;
let firstRename = true;
fsPromises.rename = async (...args) => {
	if (!firstRename) return originalRename(...args);
	firstRename = false;
	setTimeout(() => {
		fs.mkdirSync(join(process.cwd(), "dist"), { recursive: true });
		fs.writeFileSync(join(process.cwd(), "dist", "late-winner.txt"), "published");
	}, 2_200);
	throw new Error("synthetic late-winner race");
};
syncBuiltinESMExports();
`;

function makeFixture(): string {
	const dir = mkdtempSync(join(tmpdir(), "build-swap-"));
	mkdirSync(join(dir, "node_modules", "typescript", "bin"), { recursive: true });
	writeFileSync(join(dir, "node_modules", "typescript", "bin", "tsc"), TSC_STUB);
	writeFileSync(join(dir, "late-winner-preload.mjs"), LATE_WINNER_PRELOAD);
	return dir;
}

// Returns stderr alongside the exit code so a storm failure in CI reports the
// build's own diagnostic instead of a bare exit-code mismatch.
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

test("build.mjs: failed compile preserves the previous dist and cleans staging", async () => {
	const dir = makeFixture();
	try {
		mkdirSync(join(dir, "dist"));
		writeFileSync(join(dir, "dist", "sentinel.txt"), "previous build");

		const { code: exitCode } = await runBuild(dir, { TSC_STUB_FAIL: "1" });

		assert.notEqual(exitCode, 0);
		assert.ok(existsSync(join(dir, "dist", "sentinel.txt")));
		assert.deepEqual(stagingDirs(dir), []);
	} finally {
		rmSync(dir, { force: true, recursive: true });
	}
});

test("build.mjs: successful build replaces dist atomically, purging stale files", async () => {
	const dir = makeFixture();
	try {
		mkdirSync(join(dir, "dist"));
		writeFileSync(join(dir, "dist", "stale.txt"), "old output");

		assert.equal((await runBuild(dir)).code, 0);

		assert.ok(existsSync(join(dir, "dist", "index.js")));
		assert.ok(!existsSync(join(dir, "dist", "stale.txt")));
		assert.deepEqual(stagingDirs(dir), []);
	} finally {
		rmSync(dir, { force: true, recursive: true });
	}
});

test("build.mjs: reaps staging dirs owned by dead pids and keeps live ones", async () => {
	const dir = makeFixture();
	try {
		const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
		assert.equal(typeof deadPid, "number");
		mkdirSync(join(dir, `dist.staging.${deadPid}`, "partial"), { recursive: true });
		const livePid = process.pid; // this test runner is alive for the whole build
		mkdirSync(join(dir, `dist.staging.${livePid}`, "inflight"), { recursive: true });

		assert.equal((await runBuild(dir)).code, 0);

		assert.ok(!existsSync(join(dir, `dist.staging.${deadPid}`)));
		assert.ok(existsSync(join(dir, `dist.staging.${livePid}`)));
	} finally {
		rmSync(dir, { force: true, recursive: true });
	}
});

test("build.mjs: concurrent build storms all succeed and leave a valid dist", { timeout: 30_000 }, async () => {
	const dir = makeFixture();
	try {
		// 12-wide x 3 rounds: wide enough that the publish race fires on most runs.
		for (let round = 0; round < 3; round++) {
			const results = await Promise.all(Array.from({ length: 12 }, () => runBuild(dir)));

			// Asserted first so a failure shows the build's own stderr, not just a code.
			assert.deepEqual(
				results.flatMap((result) => (result.code === 0 ? [] : [result.stderr])),
				[],
			);
			assert.deepEqual(
				results.map((result) => result.code),
				Array.from({ length: 12 }, () => 0),
			);
			assert.ok(existsSync(join(dir, "dist", "index.js")));
			assert.deepEqual(stagingDirs(dir), []);
		}
	} finally {
		rmSync(dir, { force: true, recursive: true });
	}
});

test("build.mjs: publishes its retained staging tree instead of timing out on a slow winner", { timeout: 10_000 }, async () => {
	const dir = makeFixture();
	try {
		const result = await runBuild(dir, {}, ["--import", pathToFileURL(join(dir, "late-winner-preload.mjs")).href]);

		assert.deepEqual(result, { code: 0, stderr: "" });
		assert.ok(existsSync(join(dir, "dist", "index.js")));
		assert.ok(existsSync(join(dir, "dist", "late-winner.txt")));
		assert.deepEqual(stagingDirs(dir), []);
	} finally {
		rmSync(dir, { force: true, recursive: true });
	}
});

test("build.mjs: rethrows the rename failure when no concurrent winner exists", { timeout: 10_000 }, async () => {
	const dir = makeFixture();
	try {
		// The sabotage stub deletes its own emit after compiling. The rename then
		// fails with dist/ absent and no staging tree left to retry, which is the
		// genuine-failure path: it must rethrow, never report a phantom race win.
		const { code: exitCode } = await runBuild(dir, { TSC_STUB_SABOTAGE_STAGING: "1" });

		assert.notEqual(exitCode, 0);
		assert.ok(!existsSync(join(dir, "dist")));
	} finally {
		rmSync(dir, { force: true, recursive: true });
	}
});
