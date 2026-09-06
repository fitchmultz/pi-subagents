#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json");

if (process.argv.includes("--help") || process.argv.includes("-h")) {
	console.log(`Usage: node scripts/package-smoke.mjs\n\nVerifies the local pi-subagents package shape without publishing.\n\nChecks:\n  - npm pack --dry-run includes subagent and intercom runtime resources\n  - package.json pi manifest points at both extensions and skills without registering example prompts\n  - both compiled dist extension entrypoints load as native ES modules\n  - a packed production install with dev dependencies omitted can load the detached runner and native broker\n\nExit codes:\n  0  smoke passed\n  1  package shape or runtime load check failed`);
	process.exit(0);
}

function fail(message) {
	console.error(`[package-smoke] ${message}`);
	process.exit(1);
}

function run(command, args, cwd = process.cwd(), env = process.env) {
	const result = spawnSync(command, args, {
		cwd,
		env,
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
	await import(pathToFileURL(join(gitPackageRoot, "dist", "runs", "shared", "supervisor-questions.js")).href);
	const brokerSpawn = await import(pathToFileURL(join(gitPackageRoot, "dist", "pi-intercom", "broker", "spawn.js")).href);
	const brokerCwd = brokerSpawn.getBrokerSpawnOptions().cwd;
	if (realpathSync(brokerCwd) !== realpathSync(gitPackageRoot)) throw new Error(`packed broker resolved ${brokerCwd} instead of ${gitPackageRoot}`);
	run(process.execPath, ["--check", join(gitPackageRoot, "dist", "pi-intercom", "broker", "broker.js")], gitPackageRoot);
	const distPiArgs = await import(pathToFileURL(join(gitPackageRoot, "dist", "runs", "shared", "pi-args.js")).href);
	const childArgs = distPiArgs.buildPiArgs({
		baseArgs: [],
		task: "package-smoke",
		sessionEnabled: false,
		inheritProjectContext: false,
		inheritSkills: false,
		allowSubagents: true,
	}).args ?? [];
	const childExtensionPaths = childArgs.flatMap((arg, index) => (arg === "--extension" ? [childArgs[index + 1]] : []));
	if (childExtensionPaths.length === 0) throw new Error("dist buildPiArgs emitted no --extension paths");
	for (const extensionPath of childExtensionPaths) {
		if (!existsSync(extensionPath)) throw new Error(`dist buildPiArgs emitted a missing --extension path: ${extensionPath}`);
	}

	const home = join(productionRoot, "native-home");
	const asyncDir = join(home, "run");
	mkdirSync(asyncDir, { recursive: true });
	const sessionFile = join(home, "child.jsonl");
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "packed-native-probe", cwd: home, timestamp: new Date().toISOString() })}\n`);
	const marker = join(home, "native-started.json");
	const observer = join(home, "observe.ts");
	writeFileSync(observer, `import { writeFileSync, writeSync } from "node:fs";
export default function (pi) {
	pi.on("session_start", (_event, ctx) => {
		pi.appendEntry("package-probe", { nativeSession: true });
		writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ sessionFile: ctx.sessionManager.getSessionFile() }));
		const message = { role: "assistant", provider: "openai", model: "gpt-6-astra", stopReason: "stop", content: [{ type: "text", text: "PACKED_NATIVE_COMPLETE" }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } };
		// Pi redirects extension stdout to stderr; this fixture emits controlled wire records.
		writeSync(1, JSON.stringify({ type: "message_end", message }) + "\\n" + JSON.stringify({ type: "agent_settled" }) + "\\n");
		process.exit(0);
	});
}`);
	const nativeEnv = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: join(home, "agent"), PI_OFFLINE: "1" };
	for (const key of Object.keys(nativeEnv)) if (key.startsWith("PI_SUBAGENT_") || /(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN)$/.test(key)) delete nativeEnv[key];
	nativeEnv.PI_SUBAGENT_TEMP_ROOT = join(home, "pi-subagents-runtime");
	const nativePi = await import(new URL("../dist/runs/shared/pi-spawn.js", import.meta.url));
	const piPackageRoot = nativePi.resolvePiPackageRoot() ?? nativePi.resolveInstalledPiPackageRoot();
	if (!piPackageRoot) throw new Error("Native Pi is required for the packed detached-run check");
	const bin = join(home, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "pi"), `#!/bin/sh\nexec "${process.execPath}" "${join(piPackageRoot, "dist/cli.js")}" "$@"\n`, { mode: 0o755 });
	// A wrapper-only PATH also covers managed installs whose shim is not a symlink.
	nativeEnv.PATH = `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`;
	delete nativeEnv.PI_PACKAGE_DIR;
	const configPath = join(home, "config.json");
	const resultPath = join(home, "result.json");
	writeFileSync(configPath, JSON.stringify({ id: "packed-native", cwd: home, asyncDir, resultPath, piPackageRoot, placeholder: "{previous}", resultMode: "single", sessionDir: home, steps: [{ agent: "probe", task: "Controlled package startup check; no model call", sessionFile, extensions: [observer], inheritProjectContext: false, inheritSkills: false }] }));
	run(process.execPath, [join(gitPackageRoot, "dist/runs/background/subagent-runner-launcher.js"), join(gitPackageRoot, "dist/runs/background/subagent-runner.js"), configPath], home, nativeEnv);
	const result = JSON.parse(readFileSync(resultPath, "utf8"));
	if (result.success !== true || result.results?.[0]?.output !== "PACKED_NATIVE_COMPLETE") throw new Error(`Packed detached runner did not complete its controlled native Pi child: ${JSON.stringify({ nativeStarted: existsSync(marker), children: result.results?.map(({ exitCode, error, output }) => ({ exitCode, error, output })) })}`);
	if (JSON.parse(readFileSync(marker, "utf8")).sessionFile !== sessionFile) throw new Error("Packed child did not bind the requested native Pi session");
	console.log("[package-smoke] packed detached Node runner completed a controlled native Pi startup (no model call)");
} catch (error) {
	productionImportError = error;
} finally {
	if (productionImportError) console.error(`[package-smoke] failure evidence: ${productionRoot}`);
	else rmSync(productionRoot, { recursive: true, force: true });
}
if (productionImportError) {
	fail(`packed production install could not load runtime paths: ${productionImportError instanceof Error ? productionImportError.message : String(productionImportError)}`);
}

console.log(`[package-smoke] ${pack.name}@${pack.version}: ${pack.files.length} files packed; subagent, intercom, runner, and broker paths loaded`);
