#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json");

if (process.argv.includes("--help") || process.argv.includes("-h")) {
	console.log(`Usage: node scripts/package-smoke.mjs\n\nVerifies the local pi-subagents package shape without publishing.\n\nChecks:\n  - npm pack --dry-run includes subagent and intercom runtime resources\n  - package.json pi manifest points at both extensions and skills without registering example prompts\n  - both extension entrypoints load through native Node TypeScript stripping\n  - a packed production install with dev dependencies omitted can load the detached runner and native broker\n\nExit codes:\n  0  smoke passed\n  1  package shape or runtime load check failed`);
	process.exit(0);
}

function fail(message) {
	console.error(`[package-smoke] ${message}`);
	process.exit(1);
}

function commandName(base) {
	return process.platform === "win32" ? `${base}.cmd` : base;
}

function run(command, args, cwd = process.cwd()) {
	const result = spawnSync(commandName(command), args, {
		cwd,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.error) throw new Error(`failed to start ${command}: ${result.error.message}`);
	if (result.status !== 0) {
		process.stderr.write(result.stderr);
		process.stdout.write(result.stdout);
		throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
	}
	return result.stdout;
}

function runOrFail(command, args, cwd = process.cwd()) {
	try {
		return run(command, args, cwd);
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}
}

function assertPackedFile(files, path) {
	if (!files.some((file) => file.path === path)) fail(`npm pack output is missing ${path}`);
}

function assertNotPackedFile(files, path) {
	if (files.some((file) => file.path === path)) fail(`npm pack output should not include ${path}`);
}

const packOutput = runOrFail("npm", ["pack", "--dry-run", "--json"]);
let packs;
try {
	packs = JSON.parse(packOutput);
} catch (error) {
	fail(`npm pack --json returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
}
const pack = Array.isArray(packs) ? packs[0] : undefined;
if (!pack || !Array.isArray(pack.files)) fail("npm pack --json did not report a file list");

for (const path of [
	"package.json",
	"LICENSE",
	"README.md",
	"dist/extension/index.js",
	"dist/pi-intercom/index.js",
	"dist/pi-intercom/broker/broker.js",
	"dist/runs/background/subagent-runner-launcher.js",
	"src/extension/index.ts",
	"src/extension/schemas.ts",
	"src/pi-intercom/index.ts",
	"src/pi-intercom/broker/broker.ts",
	"src/pi-intercom/ui/session-list.ts",
	"src/shared/types.ts",
	"src/runs/background/subagent-runner-launcher.ts",
	"agents/reviewer.md",
	"agents/reviewer-gpt.md",
	"agents/watcher.md",
	"skills/pi-subagents/SKILL.md",
	"skills/pi-intercom/SKILL.md",
	"docs/intercom.md",
	"prompts/review-loop.md",
	"scripts/real-pi-smoke.mjs",
]) {
	assertPackedFile(pack.files, path);
}

assertNotPackedFile(pack.files, "install.mjs");

if (packageJson.private !== true) fail("package.json must stay private for this GitHub/local fork");
if (packageJson.bin !== undefined) fail("package.json must not expose an npx/bin installer for this GitHub/local fork");
if (!packageJson.pi?.extensions?.includes("./dist/extension/index.js")) fail("package.json pi.extensions must include ./dist/extension/index.js");
if (!packageJson.pi?.extensions?.includes("./dist/pi-intercom/index.js")) fail("package.json pi.extensions must include ./dist/pi-intercom/index.js");
if (!packageJson.pi?.skills?.includes("./skills")) fail("package.json pi.skills must include ./skills");
if (packageJson.pi?.prompts !== undefined) fail("package.json pi.prompts must stay unset so example prompts are not registered as slash commands");

for (const entrypoint of ["../dist/extension/index.js", "../dist/pi-intercom/index.js"]) {
	const extensionModule = await import(new URL(entrypoint, import.meta.url));
	if (typeof extensionModule.default !== "function") fail(`${entrypoint} did not load a default registration function`);
}

const productionRoot = mkdtempSync(join(tmpdir(), "pi-subagents-package-smoke-"));
let productionImportError;
try {
	const packDir = join(productionRoot, "pack");
	const installDir = join(productionRoot, "install");
	mkdirSync(packDir);
	mkdirSync(installDir);
	writeFileSync(join(installDir, "package.json"), JSON.stringify({ private: true, type: "module" }));
	const productionPackOutput = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", packDir]));
	const filename = productionPackOutput?.[0]?.filename;
	if (typeof filename !== "string") throw new Error("npm pack did not report a tarball filename");
	run("npm", ["install", "--ignore-scripts", "--omit=dev", join(packDir, filename)], installDir);
	const installedRoot = join(installDir, "node_modules", packageJson.name);
	if (!existsSync(installedRoot)) throw new Error(`production install is missing ${packageJson.name}`);
	const gitPackageRoot = join(productionRoot, "git-package");
	cpSync(installedRoot, gitPackageRoot, { recursive: true });
	run("npm", ["install", "--ignore-scripts", "--omit=dev"], gitPackageRoot);
	await import(pathToFileURL(join(gitPackageRoot, "dist", "runs", "shared", "acceptance-contract.js")).href);
	const brokerSpawn = await import(pathToFileURL(join(gitPackageRoot, "dist", "pi-intercom", "broker", "spawn.js")).href);
	const brokerCwd = brokerSpawn.getBrokerSpawnOptions().cwd;
	if (realpathSync(brokerCwd) !== realpathSync(gitPackageRoot)) throw new Error(`packed broker resolved ${brokerCwd} instead of ${gitPackageRoot}`);
	run(process.execPath, ["--check", join(gitPackageRoot, "dist", "pi-intercom", "broker", "broker.js")], gitPackageRoot);
} catch (error) {
	productionImportError = error;
} finally {
	rmSync(productionRoot, { recursive: true, force: true });
}
if (productionImportError) {
	fail(`packed production install could not load runtime paths: ${productionImportError instanceof Error ? productionImportError.message : String(productionImportError)}`);
}

console.log(`[package-smoke] ${pack.name}@${pack.version}: ${pack.files.length} files packed; subagent, intercom, runner, and broker paths loaded`);
