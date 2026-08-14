import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const sourceImportPattern = /from\s+["'](@earendil-works\/[^"']+)["']|import\s+["'](@earendil-works\/[^"']+)["']/g;
const oldPiScopePattern = /@mariozechner\/pi-/;
const piPackageJsonSubpathPattern = /@earendil-works\/pi-[^"']+\/package\.json/;
const cjsPiPackageResolutionPattern = /require(?:\.resolve)?\(\s*["']@earendil-works\/pi-/;

function collectTsFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const entryPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			collectTsFiles(entryPath).forEach((file) => files.push(file));
		} else if (entry.name.endsWith(".ts")) {
			files.push(entryPath);
		}
	}
	return files;
}

function readPackageJson(): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf-8")) as Record<string, unknown>;
}

function rootPackageName(specifier: string): string {
	return specifier.split("/").slice(0, 2).join("/");
}

test("direct @earendil-works runtime imports are declared for local installs", () => {
	const packageJson = readPackageJson();
	const dependencies = packageJson.dependencies && typeof packageJson.dependencies === "object" ? packageJson.dependencies : {};
	const devDependencies = packageJson.devDependencies && typeof packageJson.devDependencies === "object" ? packageJson.devDependencies : {};
	const declared = new Set([
		...Object.keys(dependencies),
		...Object.keys(devDependencies),
	]);
	const imported = new Set<string>();

	for (const file of [...collectTsFiles(path.join(projectRoot, "src")), ...collectTsFiles(path.join(projectRoot, "test"))]) {
		const source = fs.readFileSync(file, "utf-8");
		for (const match of source.matchAll(sourceImportPattern)) {
			imported.add(rootPackageName(match[1] ?? match[2]!));
		}
	}

	const missing = [...imported].filter((specifier) => !declared.has(specifier)).sort();
	assert.deepEqual(missing, []);
});

test("detached runtimes install only their production dependency", () => {
	const dependencies = readPackageJson().dependencies as Record<string, unknown>;
	assert.equal(dependencies.typebox, "^1.1.39");
	assert.equal(dependencies.tsx, undefined);
});

test("Pi 0.84.0 is the exact development baseline with optional wildcard peers", () => {
	const packageJson = readPackageJson();
	const devDependencies = packageJson.devDependencies as Record<string, unknown>;
	const peerDependencies = packageJson.peerDependencies as Record<string, unknown>;
	const peerDependenciesMeta = packageJson.peerDependenciesMeta as Record<string, { optional?: boolean }>;
	for (const name of [
		"@earendil-works/pi-agent-core",
		"@earendil-works/pi-ai",
		"@earendil-works/pi-coding-agent",
		"@earendil-works/pi-tui",
	]) {
		assert.equal(devDependencies[name], "0.84.0", name);
		assert.equal(peerDependencies[name], "*", name);
		assert.equal(peerDependenciesMeta[name]?.optional, true, name);
	}
});

test("package lock uses the public npm registry", () => {
	const lockfile = JSON.parse(fs.readFileSync(path.join(projectRoot, "package-lock.json"), "utf-8")) as {
		packages?: Record<string, { resolved?: unknown }>;
	};
	for (const [name, entry] of Object.entries(lockfile.packages ?? {})) {
		if (typeof entry.resolved !== "string") continue;
		const resolved = new URL(entry.resolved);
		assert.equal(resolved.protocol, "https:", name);
		assert.equal(resolved.hostname, "registry.npmjs.org", name);
	}
});

test("one manifest bundles subagents and intercom", () => {
	const pi = readPackageJson().pi as { extensions?: unknown; skills?: unknown };
	assert.deepEqual(pi.extensions, ["./dist/extension/index.js", "./dist/pi-intercom/index.js"]);
	assert.deepEqual(pi.skills, ["./skills"]);
	assert.equal(fs.existsSync(path.join(projectRoot, "scripts", "intercom-smoke-package.mjs")), false);
});

test("package is private and exposes no legacy npx installer", () => {
	const packageJson = readPackageJson();
	assert.equal(packageJson.private, true);
	assert.equal("bin" in packageJson, false);
	const files = Array.isArray(packageJson.files) ? packageJson.files : [];
	assert.equal(files.includes("*.mjs"), false);
	assert.equal(fs.existsSync(path.join(projectRoot, "install.mjs")), false);
});

test("old pi package scope is not used by source or tests", () => {
	for (const file of [...collectTsFiles(path.join(projectRoot, "src")), ...collectTsFiles(path.join(projectRoot, "test"))]) {
		const source = fs.readFileSync(file, "utf-8");
		assert.equal(oldPiScopePattern.test(source), false, file);
	}
});

test("source uses only current Pi 0.84 entrypoints and event contracts", () => {
	for (const file of collectTsFiles(path.join(projectRoot, "src"))) {
		const source = fs.readFileSync(file, "utf-8");
		assert.equal(source.includes("@earendil-works/pi-ai/compat"), false, file);
		assert.equal(source.includes("tool_result_end"), false, file);
		assert.equal(source.includes("_rewriteFile"), false, file);
		assert.equal(source.includes("isProjectTrusted?."), false, file);
	}
});

test("Pi package resolution stays export-map safe", () => {
	for (const file of [...collectTsFiles(path.join(projectRoot, "src")), ...collectTsFiles(path.join(projectRoot, "test"))]) {
		const source = fs.readFileSync(file, "utf-8");
		assert.equal(piPackageJsonSubpathPattern.test(source), false, `${file} should not resolve unexported package.json subpaths`);
		assert.equal(cjsPiPackageResolutionPattern.test(source), false, `${file} should not use CommonJS resolution for ESM-only Pi packages`);
	}
});
