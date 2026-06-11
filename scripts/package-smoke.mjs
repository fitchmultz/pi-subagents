#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json");

if (process.argv.includes("--help") || process.argv.includes("-h")) {
	console.log(`Usage: node scripts/package-smoke.mjs\n\nVerifies the local pi-subagents package shape without publishing or installing it.\n\nChecks:\n  - npm pack --dry-run includes runtime Pi resources\n  - package.json pi manifest points at extension, skills, and prompts\n  - src/extension/index.ts loads through jiti and exports a registration function\n\nExit codes:\n  0  smoke passed\n  1  package shape or extension load check failed`);
	process.exit(0);
}

function fail(message) {
	console.error(`[package-smoke] ${message}`);
	process.exit(1);
}

function commandName(base) {
	return process.platform === "win32" ? `${base}.cmd` : base;
}

function run(command, args) {
	const result = spawnSync(commandName(command), args, {
		cwd: process.cwd(),
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.error) fail(`failed to start ${command}: ${result.error.message}`);
	if (result.status !== 0) {
		process.stderr.write(result.stderr);
		process.stdout.write(result.stdout);
		fail(`${command} ${args.join(" ")} exited with ${result.status}`);
	}
	return result.stdout;
}

function assertPackedFile(files, path) {
	if (!files.some((file) => file.path === path)) fail(`npm pack output is missing ${path}`);
}

function assertNotPackedFile(files, path) {
	if (files.some((file) => file.path === path)) fail(`npm pack output should not include ${path}`);
}

const packOutput = run("npm", ["pack", "--dry-run", "--json"]);
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
	"README.md",
	"src/extension/index.ts",
	"src/extension/schemas.ts",
	"src/shared/types.ts",
	"agents/reviewer.md",
	"skills/pi-subagents/SKILL.md",
	"prompts/review-loop.md",
	"scripts/verify-agent-overrides.mjs",
]) {
	assertPackedFile(pack.files, path);
}

assertNotPackedFile(pack.files, "install.mjs");

if (packageJson.private !== true) fail("package.json must stay private for this file-path-only fork");
if (packageJson.bin !== undefined) fail("package.json must not expose an npx/bin installer for this file-path-only fork");
if (!packageJson.pi?.extensions?.includes("./src/extension/index.ts")) fail("package.json pi.extensions must include ./src/extension/index.ts");
if (!packageJson.pi?.skills?.includes("./skills")) fail("package.json pi.skills must include ./skills");
if (!packageJson.pi?.prompts?.includes("./prompts")) fail("package.json pi.prompts must include ./prompts");

const jiti = createJiti(import.meta.url, { interopDefault: true });
const extensionModule = await jiti.import(fileURLToPath(new URL("../src/extension/index.ts", import.meta.url)));
const register = extensionModule.default ?? extensionModule;
if (typeof register !== "function") fail("extension entrypoint did not load a default registration function");

console.log(`[package-smoke] ${pack.name}@${pack.version}: ${pack.files.length} files packed; extension entrypoint loaded`);
