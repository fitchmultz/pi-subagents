import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { TEMP_ROOT_DIR } from "../../src/shared/types.ts";
import {
	cleanupWorktrees,
	createWorktrees,
	diffWorktrees,
	findWorktreeTaskCwdConflict,
	appendWorktreeSummary,
	formatWorktreeDiffSummary,
	resolveExpectedWorktreeAgentCwd,
	type WorktreeSetup,
} from "../../src/runs/shared/worktree.ts";

function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
	if (result.status !== 0) {
		const message = result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`;
		throw new Error(message);
	}
	return result.stdout.trim();
}

function createRepo(prefix: string): string {
	const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	git(repoDir, ["init"]);
	git(repoDir, ["config", "user.email", "tests@example.com"]);
	git(repoDir, ["config", "user.name", "Worktree Tests"]);
	fs.writeFileSync(path.join(repoDir, ".gitignore"), "node_modules/\n", "utf-8");
	fs.writeFileSync(path.join(repoDir, "tracked.txt"), "initial\n", "utf-8");
	git(repoDir, ["add", "-A"]);
	git(repoDir, ["commit", "-m", "initial commit"]);
	return repoDir;
}

function cleanupRepo(repoDir: string): void {
	try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
}

function createHookScript(_repoDir: string, fileName: string, source: string): string {
	const hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worktree-hook-script-"));
	const hookPath = path.join(hooksDir, fileName);
	fs.writeFileSync(hookPath, `#!/usr/bin/env node\n${source}\n`, "utf-8");
	fs.chmodSync(hookPath, 0o755);
	return hookPath;
}

describe("worktree", () => {
	for (const diffDriver of ["default", "textconv", "external"]) it(`binary patches reconstruct the complete edited tree after cleanup (${diffDriver})`, async () => {
		const repoDir = createRepo("pi-worktree-binary-");
		let setup: WorktreeSetup | undefined;
		try {
			fs.writeFileSync(path.join(repoDir, "modify.bin"), Buffer.from([0, 1, 2, 3]));
			fs.writeFileSync(path.join(repoDir, "delete.bin"), Buffer.from([0, 4, 5, 6]));
			if (diffDriver === "textconv") {
				fs.writeFileSync(path.join(repoDir, ".gitattributes"), "*.bin diff=hex\n");
				git(repoDir, ["config", "diff.hex.textconv", "od -An -tx1"]);
			}
			if (diffDriver === "external") git(repoDir, ["config", "diff.external", "echo external diff viewer"]);
			git(repoDir, ["add", "-A"]);
			git(repoDir, ["commit", "-m", "binary baseline"]);
			setup = await createWorktrees(repoDir, "binary-roundtrip", 1);
			const worktree = setup.worktrees[0]!;
			fs.writeFileSync(path.join(worktree.path, "modify.bin"), Buffer.from([0, 7, 8, 9]));
			fs.writeFileSync(path.join(worktree.path, "add.bin"), Buffer.from([0, 10, 11, 12]));
			fs.unlinkSync(path.join(worktree.path, "delete.bin"));
			fs.appendFileSync(path.join(worktree.path, "tracked.txt"), "edited\n");
			fs.chmodSync(path.join(worktree.path, "tracked.txt"), 0o755);
			const [diff] = diffWorktrees(setup, ["worker"], path.join(repoDir, "patches"));
			assert.equal(diff.captureError, undefined);
			const expectedTree = git(worktree.path, ["write-tree"]);
			cleanupWorktrees(setup);
			setup = undefined;
			assert.equal(fs.existsSync(worktree.path), false);
			git(repoDir, ["apply", "--index", diff.patchPath]);
			assert.equal(git(repoDir, ["write-tree"]), expectedTree);
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("creates worktrees inside the existing private temp root", async () => {
		const repoDir = createRepo("pi-worktree-root-");
		let setup: WorktreeSetup | undefined;
		try {
			setup = await createWorktrees(repoDir, "private-root", 1);
			assert.equal(path.dirname(setup.worktrees[0]!.path), path.join(TEMP_ROOT_DIR, "worktrees"));
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("createWorktrees returns expected structure", async () => {
		const repoDir = createRepo("pi-worktree-structure-");
		let setup: WorktreeSetup | undefined;
		try {
			setup = await createWorktrees(repoDir, "structure", 2);
			assert.equal(setup.worktrees.length, 2);
			assert.equal(setup.cwd, git(repoDir, ["rev-parse", "--show-toplevel"]));
			for (let i = 0; i < setup.worktrees.length; i++) {
				const worktree = setup.worktrees[i]!;
				assert.equal(worktree.branch, `pi-parallel-structure-${i}`);
				assert.equal(worktree.index, i);
				assert.equal(worktree.agentCwd, worktree.path);
				assert.deepEqual(worktree.syntheticPaths, []);
				assert.ok(fs.existsSync(worktree.path), `worktree path missing: ${worktree.path}`);
			}
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("createWorktrees maps subdirectory cwd to each agentCwd", async () => {
		const repoDir = createRepo("pi-worktree-subdir-");
		const nestedDir = path.join(repoDir, "packages", "app");
		fs.mkdirSync(nestedDir, { recursive: true });
		fs.writeFileSync(path.join(nestedDir, "index.ts"), "export const value = 1;\n", "utf-8");
		git(repoDir, ["add", "-A"]);
		git(repoDir, ["commit", "-m", "add nested dir"]);

		let setup: WorktreeSetup | undefined;
		try {
			setup = await createWorktrees(nestedDir, "subdir", 1);
			assert.equal(setup.worktrees[0]!.agentCwd, path.join(setup.worktrees[0]!.path, "packages", "app"));
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("previews expected worktree agent cwd for repository subdirectories", () => {
		const repoDir = createRepo("pi-worktree-preview-");
		const nestedDir = path.join(repoDir, "packages", "app");
		fs.mkdirSync(nestedDir, { recursive: true });
		fs.writeFileSync(path.join(nestedDir, "index.ts"), "export const value = 1;\n", "utf-8");
		git(repoDir, ["add", "-A"]);
		git(repoDir, ["commit", "-m", "add nested dir"]);

		try {
			assert.equal(
				resolveExpectedWorktreeAgentCwd(nestedDir, "preview", 2),
				path.join(TEMP_ROOT_DIR, "worktrees", "pi-worktree-preview-2", "packages", "app"),
			);
		} finally {
			cleanupRepo(repoDir);
		}
	});

	it("failed setup does not remove an existing worktree or branch", async () => {
		const repoDir = createRepo("pi-worktree-existing-");
		let setup: WorktreeSetup | undefined;
		try {
			setup = await createWorktrees(repoDir, "existing", 1);
			const worktree = setup.worktrees[0]!;
			fs.writeFileSync(path.join(worktree.path, "valuable.txt"), "keep this edit");
			await assert.rejects(() => createWorktrees(repoDir, "existing", 1), /already exists/);
			assert.equal(fs.readFileSync(path.join(worktree.path, "valuable.txt"), "utf8"), "keep this edit");
			assert.equal(git(repoDir, ["branch", "--format=%(refname:short)", "--list", worktree.branch]).trim(), worktree.branch);
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("createWorktrees rejects dirty repositories", async () => {
		const repoDir = createRepo("pi-worktree-dirty-");
		try {
			fs.writeFileSync(path.join(repoDir, "tracked.txt"), "dirty\n", "utf-8");
			await assert.rejects(
				() => createWorktrees(repoDir, "dirty", 1),
				/worktree isolation requires a clean git working tree/i,
			);
		} finally {
			cleanupRepo(repoDir);
		}
	});

	it("findWorktreeTaskCwdConflict allows omitted or matching task cwd values", () => {
		const sharedCwd = path.join("/tmp", "repo");
		assert.equal(
			findWorktreeTaskCwdConflict(
				[
					{ agent: "worker-a" },
					{ agent: "worker-b", cwd: sharedCwd },
				],
				sharedCwd,
			),
			undefined,
		);
	});

	it("findWorktreeTaskCwdConflict treats relative task cwd values as relative to the shared cwd", () => {
		const sharedCwd = path.join("/tmp", "repo");
		assert.equal(
			findWorktreeTaskCwdConflict(
				[{ agent: "worker-a", cwd: "." }],
				sharedCwd,
			),
			undefined,
		);
	});

	it("findWorktreeTaskCwdConflict returns the first conflicting task cwd", () => {
		const sharedCwd = path.join("/tmp", "repo");
		const conflict = findWorktreeTaskCwdConflict(
			[
				{ agent: "worker-a", cwd: sharedCwd },
				{ agent: "worker-b", cwd: path.join(sharedCwd, "packages", "app") },
			],
			sharedCwd,
		);
		assert.deepEqual(conflict, {
			index: 1,
			agent: "worker-b",
			cwd: path.join(sharedCwd, "packages", "app"),
		});
	});

	it("diffWorktrees captures committed, modified, and new files", async () => {
		const repoDir = createRepo("pi-worktree-diff-");
		let setup: WorktreeSetup | undefined;
		try {
			setup = await createWorktrees(repoDir, "diff", 1);
			const worktree = setup.worktrees[0]!;
			fs.writeFileSync(path.join(worktree.path, "committed.ts"), "export const committed = true;\n", "utf-8");
			git(worktree.path, ["add", "committed.ts"]);
			git(worktree.path, ["commit", "-m", "committed change"]);
			fs.writeFileSync(path.join(worktree.path, "tracked.txt"), "modified\n", "utf-8");
			fs.writeFileSync(path.join(worktree.path, "new-file.ts"), "export const added = true;\n", "utf-8");

			const diffsDir = path.join(repoDir, "artifacts", "worktree-diffs");
			const diffs = diffWorktrees(setup, ["agent-a"], diffsDir);
			assert.equal(diffs.length, 1);
			assert.equal(diffs[0]!.agent, "agent-a");
			assert.equal(diffs[0]!.filesChanged, 3, `expected 3 files, got ${diffs[0]!.filesChanged}`);
			assert.ok(diffs[0]!.insertions > 0, "expected insertions > 0");
			assert.ok(fs.existsSync(diffs[0]!.patchPath), "expected patch file to exist");

			const patch = fs.readFileSync(diffs[0]!.patchPath, "utf-8");
			assert.match(patch, /committed\.ts/);
			assert.match(patch, /tracked\.txt/);
			assert.match(patch, /new-file\.ts/);

			const summary = formatWorktreeDiffSummary(diffs);
			assert.match(summary, /=== Worktree Changes ===/);
			assert.match(summary, /Full patches:/);
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("diffWorktrees preserves worktrees and reports artifact directory failures", async () => {
		const repoDir = createRepo("pi-worktree-diff-artifact-failure-");
		let setup: WorktreeSetup | undefined;
		try {
			setup = await createWorktrees(repoDir, "diff-artifact-failure", 1);
			fs.writeFileSync(path.join(setup.worktrees[0]!.path, "tracked.txt"), "modified\n", "utf-8");
			const diffsDir = path.join(repoDir, "artifacts-file");
			fs.writeFileSync(diffsDir, "not a directory\n", "utf-8");

			const diffs = diffWorktrees(setup, ["agent-a"], diffsDir);
			const summary = formatWorktreeDiffSummary(diffs);

			assert.equal(setup.preserveOnCleanup, true);
			assert.match(setup.preservationReason ?? "", /failed to create worktree diff artifact directory/);
			assert.match(diffs[0]!.captureError ?? "", /failed to create worktree diff artifact directory/);
			assert.match(summary, /Diff capture failed:/);
			assert.match(summary, /Preserved worktree:/);

			const worktreePath = setup.worktrees[0]!.path;
			cleanupWorktrees(setup);
			assert.equal(fs.existsSync(worktreePath), true, "cleanup should preserve worktrees after diff artifact failure");
		} finally {
			if (setup) {
				setup.preserveOnCleanup = false;
				cleanupWorktrees(setup);
			}
			cleanupRepo(repoDir);
		}
	});

	it("diffWorktrees preserves worktrees and reports per-task diff capture failures", async () => {
		const repoDir = createRepo("pi-worktree-diff-capture-failure-");
		let setup: WorktreeSetup | undefined;
		try {
			setup = await createWorktrees(repoDir, "diff-capture-failure", 1);
			fs.writeFileSync(path.join(setup.worktrees[0]!.path, "tracked.txt"), "modified\n", "utf-8");
			const diffsDir = path.join(repoDir, "artifacts", "capture-failure");
			fs.mkdirSync(path.join(diffsDir, "task-0-agent-a.patch"), { recursive: true });

			const diffs = diffWorktrees(setup, ["agent-a"], diffsDir);
			const summary = formatWorktreeDiffSummary(diffs);

			assert.equal(setup.preserveOnCleanup, true);
			assert.match(setup.preservationReason ?? "", /failed to capture worktree diff for task 1/);
			assert.match(diffs[0]!.captureError ?? "", /failed to capture worktree diff for task 1/);
			assert.match(summary, /Diff capture failed:/);
			assert.match(summary, /Preserved branch: pi-parallel-diff-capture-failure-0/);

			const worktreePath = setup.worktrees[0]!.path;
			cleanupWorktrees(setup);
			assert.equal(fs.existsSync(worktreePath), true, "cleanup should preserve worktrees after diff capture failure");
			assert.equal(fs.readFileSync(path.join(worktreePath, "tracked.txt"), "utf8"), "modified\n");
		} finally {
			if (setup) {
				setup.preserveOnCleanup = false;
				cleanupWorktrees(setup);
			}
			cleanupRepo(repoDir);
		}
	});

	it("cleanupWorktrees removes worktrees and branches", async () => {
		const repoDir = createRepo("pi-worktree-cleanup-");
		let setup: WorktreeSetup | undefined;
		try {
			setup = await createWorktrees(repoDir, "cleanup", 2);
			const worktreePaths = setup.worktrees.map((worktree) => worktree.path);
			const branches = setup.worktrees.map((worktree) => worktree.branch);
			cleanupWorktrees(setup);
			setup = undefined;

			for (const worktreePath of worktreePaths) {
				assert.equal(fs.existsSync(worktreePath), false, `worktree path still exists: ${worktreePath}`);
			}
			for (const branch of branches) {
				const branchResult = git(repoDir, ["branch", "--list", branch]);
				assert.equal(branchResult.trim(), "", `branch still exists: ${branch}`);
			}
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("workspace tests load the child's edited package instead of the original checkout", async () => {
		const repoDir = createRepo("pi-worktree-node-modules-");
		let setup: WorktreeSetup | undefined;
		const install = (cwd: string) => {
			const result = spawnSync("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false"], { cwd, encoding: "utf8" });
			assert.equal(result.status, 0, result.stderr);
		};
		try {
			fs.mkdirSync(path.join(repoDir, "packages", "lib"), { recursive: true });
			fs.writeFileSync(path.join(repoDir, "package.json"), JSON.stringify({ private: true, workspaces: ["packages/*"] }));
			fs.writeFileSync(path.join(repoDir, "packages", "lib", "package.json"), JSON.stringify({ name: "fixture-lib", version: "1.0.0", main: "index.cjs" }));
			fs.writeFileSync(path.join(repoDir, "packages", "lib", "index.cjs"), "module.exports = 2;\n");
			fs.writeFileSync(path.join(repoDir, "test.cjs"), "require('node:assert/strict').equal(require('fixture-lib'), 2);\n");
			install(repoDir);
			git(repoDir, ["add", "-A"]);
			git(repoDir, ["commit", "-m", "workspace fixture"]);
			setup = await createWorktrees(repoDir, "node-modules", 1);
			const childCwd = setup.worktrees[0]!.path;
			fs.writeFileSync(path.join(childCwd, "packages", "lib", "index.cjs"), "module.exports = 999;\n");
			const beforeInstall = spawnSync(process.execPath, ["test.cjs"], { cwd: childCwd, encoding: "utf8" });
			assert.notEqual(beforeInstall.status, 0, "missing local dependencies must not silently test the original package");
			install(childCwd);
			const childTest = spawnSync(process.execPath, ["test.cjs"], { cwd: childCwd, encoding: "utf8" });
			assert.equal(childTest.status, 1);
			assert.match(childTest.stderr, /999 !== 2/);
			assert.equal(spawnSync(process.execPath, ["test.cjs"], { cwd: repoDir }).status, 0, "the original package must stay unchanged");
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("diffWorktrees preserves a tracked node_modules symlink", async () => {
		const repoDir = createRepo("pi-worktree-tracked-node-modules-");
		const vendorDir = path.join(repoDir, "vendor-modules");
		fs.mkdirSync(vendorDir, { recursive: true });
		fs.writeFileSync(path.join(vendorDir, "fixture.txt"), "fixture\n", "utf-8");
		fs.symlinkSync("vendor-modules", path.join(repoDir, "node_modules"));
		git(repoDir, ["add", "vendor-modules", "-f", "node_modules"]);
		git(repoDir, ["commit", "-m", "track node_modules symlink"]);

		let setup: WorktreeSetup | undefined;
		try {
			setup = await createWorktrees(repoDir, "tracked-node-modules", 1);
			assert.deepEqual(setup.worktrees[0]!.syntheticPaths, []);
			fs.writeFileSync(path.join(setup.worktrees[0]!.path, "tracked.txt"), "modified\n", "utf-8");

			const diffsDir = path.join(repoDir, "artifacts", "tracked-node-modules-diffs");
			const diffs = diffWorktrees(setup, ["agent-a"], diffsDir);
			const patch = fs.readFileSync(diffs[0]!.patchPath, "utf-8");
			assert.doesNotMatch(patch, /diff --git a\/node_modules b\/node_modules/);
			assert.equal(fs.lstatSync(path.join(setup.worktrees[0]!.path, "node_modules")).isSymbolicLink(), true);
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("runs a repo-relative worktree setup hook and records synthetic paths", async () => {
		const repoDir = createRepo("pi-worktree-hook-relative-");
		const hookPath = createHookScript(repoDir, "setup-hook.mjs", `
import * as fs from "node:fs";
import * as path from "node:path";
const payload = JSON.parse(fs.readFileSync(0, "utf-8"));
fs.mkdirSync(path.join(payload.worktreePath, ".venv"), { recursive: true });
fs.writeFileSync(path.join(payload.worktreePath, ".venv", "pyvenv.cfg"), "home=/tmp\\n", "utf-8");
process.stdout.write(JSON.stringify({ syntheticPaths: [".venv"] }));
`);

		let setup: WorktreeSetup | undefined;
		try {
			setup = await createWorktrees(repoDir, "hook-relative", 1, {
				setupHook: { hookPath: path.relative(repoDir, hookPath) },
			});
			assert.ok(setup.worktrees[0]!.syntheticPaths.includes(".venv"));
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("runs an absolute worktree setup hook path", async () => {
		const repoDir = createRepo("pi-worktree-hook-absolute-");
		const hookPath = createHookScript(repoDir, "setup-hook.mjs", `
import * as fs from "node:fs";
JSON.parse(fs.readFileSync(0, "utf-8"));
process.stdout.write(JSON.stringify({ syntheticPaths: [] }));
`);

		let setup: WorktreeSetup | undefined;
		try {
			setup = await createWorktrees(repoDir, "hook-absolute", 1, {
				setupHook: { hookPath },
			});
			assert.equal(setup.worktrees.length, 1);
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("rejects bare command names for worktree setup hooks", async () => {
		const repoDir = createRepo("pi-worktree-hook-bare-");
		try {
			await assert.rejects(
				() => createWorktrees(repoDir, "hook-bare", 1, { setupHook: { hookPath: "node" } }),
				/worktree setup hook must be an absolute path or a repo-relative path/i,
			);
		} finally {
			cleanupRepo(repoDir);
		}
	});

	it("rejects tracked synthetic paths from hook output", async () => {
		const repoDir = createRepo("pi-worktree-hook-tracked-");
		const hookPath = createHookScript(repoDir, "tracked-hook.mjs", `
import * as fs from "node:fs";
JSON.parse(fs.readFileSync(0, "utf-8"));
process.stdout.write(JSON.stringify({ syntheticPaths: ["tracked.txt"] }));
`);
		const runId = `hook-tracked-${Date.now().toString(36)}`;
		try {
			await assert.rejects(
				() => createWorktrees(repoDir, runId, 1, { setupHook: { hookPath: path.relative(repoDir, hookPath) } }),
				/cannot mark tracked paths as synthetic/i,
			);
		} finally {
			cleanupRepo(repoDir);
		}
	});

	it("rejects absolute synthetic paths from hook output", async () => {
		const repoDir = createRepo("pi-worktree-hook-absolute-synthetic-");
		const hookPath = createHookScript(repoDir, "absolute-path-hook.mjs", `
import * as fs from "node:fs";
const payload = JSON.parse(fs.readFileSync(0, "utf-8"));
process.stdout.write(JSON.stringify({ syntheticPaths: [payload.worktreePath + "/.venv"] }));
`);
		const runId = `hook-absolute-synthetic-${Date.now().toString(36)}`;
		try {
			await assert.rejects(
				() => createWorktrees(repoDir, runId, 1, { setupHook: { hookPath: path.relative(repoDir, hookPath) } }),
				/synthetic path must be relative/i,
			);
		} finally {
			cleanupRepo(repoDir);
		}
	});

	it("excludes hook-created synthetic files from captured patch output", async () => {
		const repoDir = createRepo("pi-worktree-hook-diff-");
		const hookPath = createHookScript(repoDir, "setup-copy-hook.mjs", `
import * as fs from "node:fs";
import * as path from "node:path";
const payload = JSON.parse(fs.readFileSync(0, "utf-8"));
fs.writeFileSync(path.join(payload.worktreePath, ".env.local"), "TOKEN=secret\\n", "utf-8");
process.stdout.write(JSON.stringify({ syntheticPaths: [".env.local"] }));
`);

		let setup: WorktreeSetup | undefined;
		try {
			setup = await createWorktrees(repoDir, "hook-diff", 1, {
				setupHook: { hookPath: path.relative(repoDir, hookPath) },
			});
			fs.writeFileSync(path.join(setup.worktrees[0]!.path, "tracked.txt"), "modified-by-agent\n", "utf-8");
			const diffs = diffWorktrees(setup, ["agent-a"], path.join(repoDir, "artifacts", "hook-diff"));
			const patch = fs.readFileSync(diffs[0]!.patchPath, "utf-8");
			assert.match(patch, /tracked\.txt/);
			assert.doesNotMatch(patch, /\.env\.local/);
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("does not delete files outside the worktree through a synthetic path's symlinked parent", async () => {
		const repoDir = createRepo("pi-worktree-hook-symlink-");
		const nodeModulesDir = path.join(repoDir, "node_modules");
		fs.mkdirSync(nodeModulesDir);
		const victim = path.join(nodeModulesDir, "victim.txt");
		fs.writeFileSync(victim, "keep this file\n");
		const hookPath = createHookScript(repoDir, "symlink-hook.mjs", `
import * as fs from "node:fs";
import * as path from "node:path";
const payload = JSON.parse(fs.readFileSync(0, "utf-8"));
fs.symlinkSync(path.join(payload.repoRoot, "node_modules"), path.join(payload.worktreePath, "linked"));
process.stdout.write(JSON.stringify({ syntheticPaths: ["linked/victim.txt"] }));
`);

		let setup: WorktreeSetup | undefined;
		try {
			setup = await createWorktrees(repoDir, "hook-symlink", 1, { setupHook: { hookPath } });
			const [diff] = diffWorktrees(setup, ["worker"], path.join(repoDir, "patches"));
			assert.equal(fs.readFileSync(victim, "utf-8"), "keep this file\n");
			assert.match(diff.captureError ?? "", /synthetic path.*outside the worktree/);
		} finally {
			if (setup) {
				setup.preserveOnCleanup = false;
				cleanupWorktrees(setup);
			}
			cleanupRepo(repoDir);
		}
	});

	it("cleans up created worktrees when a later hook setup fails", async () => {
		const repoDir = createRepo("pi-worktree-hook-cleanup-");
		const runId = `hook-cleanup-${Date.now().toString(36)}`;
		const hookPath = createHookScript(repoDir, "flaky-hook.mjs", `
import * as fs from "node:fs";
const payload = JSON.parse(fs.readFileSync(0, "utf-8"));
if (payload.index === 1) {
	console.error("intentional failure");
	process.exit(1);
}
process.stdout.write(JSON.stringify({ syntheticPaths: [] }));
`);
		try {
			await assert.rejects(
				() => createWorktrees(repoDir, runId, 2, { setupHook: { hookPath: path.relative(repoDir, hookPath) } }),
				/worktree setup hook failed with exit code 1/i,
			);
			const branchList = git(repoDir, ["branch", "--list", `pi-parallel-${runId}-*`]);
			assert.equal(branchList.trim(), "", "temporary branches should be cleaned up after setup failure");
		} finally {
			cleanupRepo(repoDir);
		}
	});

	it("rolls back an initializing worktree when checkout is interrupted in a smudge filter", async () => {
		const repoDir = createRepo("pi-worktree-smudge-");
		const ready = path.join(repoDir, ".git", "smudge-ready");
		const runId = `smudge-${process.pid}`;
		const worktreePath = path.join(TEMP_ROOT_DIR, "worktrees", `pi-worktree-${runId}-0`);
		const hookPath = createHookScript(repoDir, "smudge.mjs", `
import * as fs from "node:fs";
fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));
setInterval(() => {}, 1000);
`);
		const controller = new AbortController();
		const poll = setInterval(() => { if (fs.existsSync(ready)) controller.abort(); }, 20);
		try {
			fs.writeFileSync(path.join(repoDir, ".gitattributes"), "tracked.txt filter=hang\n");
			git(repoDir, ["add", ".gitattributes"]);
			git(repoDir, ["commit", "-m", "filter fixture"]);
			git(repoDir, ["config", "filter.hang.smudge", `"${process.execPath}" "${hookPath}"`]);
			await assert.rejects(() => createWorktrees(repoDir, runId, 1, { signal: controller.signal }), { name: "AbortError" });
			assert.equal(fs.existsSync(worktreePath), false);
			assert.doesNotMatch(git(repoDir, ["worktree", "list", "--porcelain"]), /locked initializing/);
			assert.equal(git(repoDir, ["branch", "--list", `pi-parallel-${runId}-*`]), "");
		} finally {
			clearInterval(poll);
			spawnSync("git", ["-C", repoDir, "worktree", "remove", "--force", "--force", worktreePath]);
			fs.rmSync(path.dirname(hookPath), { recursive: true, force: true });
			cleanupRepo(repoDir);
		}
	});

	it("leaves background services from successful setup hooks running", async () => {
		const repoDir = createRepo("pi-worktree-hook-service-");
		const pidFile = path.join(repoDir, ".git", "service.pid");
		const hookPath = createHookScript(repoDir, "service-hook.mjs", `
import { spawn } from "node:child_process";
import * as fs from "node:fs";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
child.unref();
console.log("{}");
`);
		let setup: WorktreeSetup | undefined;
		try {
			setup = await createWorktrees(repoDir, "hook-service", 1, { setupHook: { hookPath } });
			assert.doesNotThrow(() => process.kill(Number(fs.readFileSync(pidFile, "utf8")), 0));
		} finally {
			if (fs.existsSync(pidFile)) {
				try { process.kill(Number(fs.readFileSync(pidFile, "utf8")), "SIGKILL"); } catch {}
			}
			if (setup) cleanupWorktrees(setup);
			fs.rmSync(path.dirname(hookPath), { recursive: true, force: true });
			cleanupRepo(repoDir);
		}
	});

	it("stops hook descendants when the configured timeout expires", async () => {
		const repoDir = createRepo("pi-worktree-hook-timeout-");
		const pidFile = path.join(repoDir, "child.pid");
		const lateWrite = path.join(repoDir, "late-write");
		const hookPath = createHookScript(repoDir, "slow-hook.mjs", `
import { spawn } from "node:child_process";
import * as fs from "node:fs";
JSON.parse(fs.readFileSync(0, "utf-8"));
spawn(process.execPath, ["-e", ${JSON.stringify(`
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(lateWrite)}, "still running"), 1500);
setTimeout(() => {}, 10000);
`)}], { stdio: "inherit" });
setTimeout(() => {}, 10000);
`);
		const runId = `hook-timeout-${Date.now().toString(36)}`;
		try {
			await assert.rejects(
				() => createWorktrees(repoDir, runId, 1, {
					setupHook: { hookPath: path.relative(repoDir, hookPath), timeoutMs: 1000 },
				}),
				/timed out/i,
			);
			assert.ok(fs.existsSync(pidFile), "the descendant must have started before the timeout");
			await delay(1000);
			assert.equal(fs.existsSync(lateWrite), false, "timed-out setup must not leave a descendant writing afterward");
			assert.equal(git(repoDir, ["branch", "--list", `pi-parallel-${runId}-*`]), "");
		} finally {
			if (fs.existsSync(pidFile)) {
				try { process.kill(Number(fs.readFileSync(pidFile, "utf8")), "SIGKILL"); } catch {}
			}
			fs.rmSync(path.dirname(hookPath), { recursive: true, force: true });
			cleanupRepo(repoDir);
		}
	});
});

describe("worktree summary helpers", () => {
	it("appends a summary only when one exists", () => {
		assert.equal(appendWorktreeSummary("output", ""), "output");
		assert.equal(appendWorktreeSummary("output", "=== Worktree Changes ==="), "output\n\n=== Worktree Changes ===");
	});

	it("extracts the worktree marker and following text", () => {
	});
});
