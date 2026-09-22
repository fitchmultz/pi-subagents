import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { findPackageJSON } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { requestChildExecutionCwd } from "../../src/runs/shared/child-execution-cwd.ts";
import { createForkContextResolver } from "../../src/shared/fork-context.ts";

for (const key of Object.keys(process.env)) if (key.startsWith("PI_SUBAGENT_")) delete process.env[key];
const { buildPiArgs } = await import(process.env.PI_ARGS_TEST_MODULE
	? pathToFileURL(path.resolve(process.env.PI_ARGS_TEST_MODULE)).href
	: "../../src/runs/shared/pi-args.ts");
const repo = fileURLToPath(new URL("../../", import.meta.url));
const host = process.env.PI_CONTEXT_TEST_PACKAGE_ROOT ?? path.dirname(findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url)!);
const sdkUrl = pathToFileURL(path.join(host, "dist/index.js"));
const sdk = await import(sdkUrl.href);
const { SessionManager } = sdk;
const aiRoot = path.dirname(findPackageJSON("@earendil-works/pi-ai", sdkUrl)!);
const ai = await import(pathToFileURL(path.join(aiRoot, "dist/index.js")).href);
const provider = path.join(repo, "test/fixtures/native-execution-cwd-provider.ts");
const sourceOwner = process.env.PI_CWD_TEST_OWNER ?? path.join(repo, "test/fixtures/native-execution-cwd-owner.ts");

test("native child CLI applies new-fork directory intent once and rejects incompatible owners before dispatch", async (t) => {
	const evidence = process.env.PI_CWD_TEST_EVIDENCE_DIR;
	if (evidence) fs.mkdirSync(evidence, { recursive: true });
	const root = fs.realpathSync(fs.mkdtempSync(path.join(evidence ?? os.tmpdir(), "pi-child-cwd-")));
	t.after(() => { if (!evidence) fs.rmSync(root, { recursive: true, force: true }); });
	const dirs = Object.fromEntries(["A", "B", "C", "D"].map((name) => {
		const dir = path.join(root, name);
		fs.mkdirSync(dir);
		fs.writeFileSync(path.join(dir, "sentinel.txt"), name);
		return [name, dir];
	}));
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir);
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: { enabled: false } }));
	const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: root, USERPROFILE: root,
		PI_CODING_AGENT_DIR: agentDir, PI_PACKAGE_DIR: host, PI_OFFLINE: "1", PI_TELEMETRY: "0" };
	let serial = 0;
	function launch(sessionFile: string, cwd: string | undefined, owner: string | undefined, script = [{ name: "read", input: { path: "sentinel.txt" } }], extraArgs: string[] = []) {
		const output = path.join(root, `observed-${++serial}.json`);
		const built = buildPiArgs({ baseArgs: ["--offline", "--mode", "json", "--no-prompt-templates", "--no-themes", ...extraArgs],
			task: "Fixture task", sessionEnabled: true, sessionFile, cwd, model: "faux/faux-1", inheritProjectContext: false,
			inheritSkills: false, extensions: [provider, ...(owner ? [owner] : [])], projectTrust: "no-approve" });
		const child = spawnSync(process.execPath, [path.join(host, JSON.parse(fs.readFileSync(path.join(host, "package.json"), "utf8")).bin.pi), ...built.args], {
			cwd: cwd ?? dirs.B, encoding: "utf8", timeout: 25_000, env: { ...env, ...built.env, PI_CWD_FIXTURE_SCRIPT: JSON.stringify(script), PI_CWD_FIXTURE_OUTPUT: output },
		});
		fs.writeFileSync(path.join(root, `stderr-${serial}.txt`), child.stderr ?? "");
		assert.equal(child.error, undefined, child.error?.message);
		assert.ok(fs.existsSync(output), child.stderr || child.stdout);
		const observed = JSON.parse(fs.readFileSync(output, "utf8"));
		return { child, observed };
	}
	function readLetters(observed: { results: Array<{ name: string; content: Array<{ type: string; text: string }>; isError: boolean }> }) {
		const reads = observed.results.filter(({ name }) => name === "read");
		for (const result of reads) assert.equal(result.isError, false, JSON.stringify(result));
		return reads.map(({ content }) => content.filter(({ type }) => type === "text").map(({ text }) => text).join("\n"));
	}
	function successful(result: ReturnType<typeof launch>, expected: string[]) {
		assert.equal(result.child.status, 0, result.child.stderr);
		assert.deepEqual(readLetters(result.observed), expected);
	}
	const ownerDir = path.join(root, "pi-change-working-dir");
	fs.mkdirSync(ownerDir);
	const owner = path.join(ownerDir, "index.ts");
	fs.writeFileSync(owner, `export { default } from ${JSON.stringify(sourceOwner)};`);
	const parentFile = path.join(root, "parent.jsonl");
	successful(launch(parentFile, dirs.A, owner, [{ name: "change_dir", input: { path: dirs.B } }, { name: "read", input: { path: "sentinel.txt" } }]), ["B"]);
	const parentBytes = fs.readFileSync(parentFile, "utf8");
	const parent = SessionManager.open(parentFile);
	// Reproduce the root cause with an unmarked native fork: C's read still follows inherited B.
	const unmarked = SessionManager.open(parentFile).createBranchedSession(parent.getLeafId());
	successful(launch(unmarked, dirs.C, owner), ["B"]);
	let forkIndex = 0;
	const resolver = createForkContextResolver(parent, "fork", { openSession: SessionManager.open });
	const fork = () => resolver.sessionFileForIndex(forkIndex++)!;
	const childFile = fork();
	const inherited = fs.readFileSync(childFile, "utf8");
	const first = launch(childFile, dirs.C, owner, [{ name: "read", input: { path: "sentinel.txt" } },
		{ name: "change_dir", input: { path: dirs.D } }, { name: "read", input: { path: "sentinel.txt" } }]);
	successful(first, ["C", "D"]);
	assert.equal(first.observed.cwd, dirs.C, "native/project root follows the existing public cwdOverride");
	assert.equal(first.observed.file, childFile);
	assert.equal(fs.existsSync(`${childFile}.subagent-cwd-init`), false);
	assert.ok(fs.readFileSync(childFile, "utf8").startsWith(inherited), "inherited history is append-only");
	const resumed = launch(childFile, dirs.C, owner);
	successful(resumed, ["D"]);
	assert.equal(resumed.observed.id, first.observed.id);
	requestChildExecutionCwd(childFile, dirs.A);
	successful(launch(childFile, dirs.A, owner), ["A"]);
	successful(launch(childFile, dirs.A, owner), ["A"]);
	const savedA = launch(childFile, undefined, owner);
	successful(savedA, ["A"]);
	assert.equal(savedA.observed.cwd, dirs.A, "omitted launch cwd restores saved A even from process cwd B");
	successful(launch(fork(), dirs.A, owner), ["A"]);
	successful(launch(fork(), dirs.B, owner), ["B"]);
	successful(launch(fork(), dirs.C, undefined), ["C"]);
	assert.equal(fs.readFileSync(parentFile, "utf8"), parentBytes, "fork initialization never writes parent history");

	for (const failure of ["old", "missing-setter", "setter-error", "resolver-error", "wrong-selection"]) {
		const ownerDir = path.join(root, failure, "pi-change-working-dir");
		fs.mkdirSync(ownerDir, { recursive: true });
		const ownerFile = path.join(ownerDir, "index.ts");
		fs.writeFileSync(ownerFile, `export default function(pi) {
			pi.registerCommand('cwd', { handler: async () => {} });
			pi.registerTool({ name: 'change_dir', label: 'old cwd', description: 'old owner', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [] }) });
			${failure === "old" ? "" : `pi.events.on('pi-change-working-dir:resolve-execution-cwd', request => { request.result = { cwd: ${JSON.stringify(dirs.B)}, ${failure === "resolver-error" ? "error: 'resolver refused'" : ""} }; });`}
			${["setter-error", "wrong-selection"].includes(failure) ? `pi.events.on('pi-change-working-dir:set-execution-cwd', request => { request.result = { cwd: ${JSON.stringify(dirs.B)}, ${failure === "setter-error" ? "error: 'setter refused'" : ""} }; });` : ""}
		}`);
		for (const fresh of [false, true]) {
			if (fresh && !["old", "resolver-error"].includes(failure)) continue;
			const file = fresh ? path.join(root, `fresh-${failure}.jsonl`) : fork();
			const { child, observed } = launch(file, dirs.C, ownerFile, undefined, ["--exclude-tools", "change_dir"]);
			assert.equal(child.status, 1, child.stderr);
			assert.match(child.stderr, /Subagent directory initialization failed:/);
			assert.equal(observed.calls, 0, `${failure}: provider must never dispatch`);
			assert.deepEqual(observed.results, [], `${failure}: tools must never execute`);
			assert.equal(fs.existsSync(`${file}.subagent-cwd-init`), !fresh, "failed fork intent remains pending; fresh children need no marker");
			assert.ok(observed.commands.some(({ name }: { name: string }) => name === "cwd"));
			assert.equal(observed.tools.some(({ name }: { name: string }) => name === "change_dir"), false);
		}
	}
	// Bare SDK skips session_start until bindExtensions. It must fail closed, then work after binding.
	const coldFile = fork();
	const coldArgs = buildPiArgs({ baseArgs: [], task: "cold SDK", sessionEnabled: true, sessionFile: coldFile, cwd: dirs.C,
		inheritProjectContext: false, inheritSkills: false });
	const faux = ai.fauxProvider();
	faux.setResponses([ai.fauxAssistantMessage([ai.fauxToolCall("read", { path: "sentinel.txt" })], { stopReason: "toolUse" }), ai.fauxAssistantMessage("done")]);
	const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: { enabled: false } });
	const modelRuntime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	modelRuntime.registerNativeProvider(faux.provider);
	const loader = new sdk.DefaultResourceLoader({ cwd: dirs.C, agentDir, settingsManager: settings, noExtensions: true,
		noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
		additionalExtensionPaths: [coldArgs.args[coldArgs.args.indexOf("--extension") + 1], owner] });
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const { session } = await sdk.createAgentSession({ cwd: dirs.C, agentDir, modelRuntime, model: faux.getModel(), settingsManager: settings,
		resourceLoader: loader, sessionManager: SessionManager.open(coldFile, undefined, dirs.C), tools: ["read", "change_dir"] });
	const originalExitCode = process.exitCode;
	const originalError = console.error;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const admissionErrors: string[] = [];
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		console.error = (message) => { admissionErrors.push(String(message)); };
		await session.prompt("Must not dispatch before owner startup");
		assert.equal(faux.state.callCount, 0);
		assert.equal(process.exitCode, 1);
		assert.match(admissionErrors.join("\n"), /directory extension did not resolve/);
		assert.equal(fs.existsSync(`${coldFile}.subagent-cwd-init`), true);
		process.exitCode = originalExitCode;
		await session.bindExtensions({ mode: "print" });
		await session.prompt("Owner startup completed");
		assert.equal(faux.state.callCount, 2);
		const read = session.messages.findLast((message: { role: string; toolName?: string }) => message.role === "toolResult" && message.toolName === "read");
		assert.equal(read?.content[0]?.text, "C");
		assert.equal(fs.existsSync(`${coldFile}.subagent-cwd-init`), false);
	} finally {
		console.error = originalError;
		process.exitCode = originalExitCode;
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	}
	assert.equal(fs.readFileSync(parentFile, "utf8"), parentBytes);
	fs.writeFileSync(path.join(root, "sdk-admission.json"), JSON.stringify({ admissionErrors, coldCalls: 0, boundCalls: faux.state.callCount }));
	fs.writeFileSync(path.join(root, "source-receipt.json"), JSON.stringify({ host, owner: sourceOwner,
		files: [path.join(host, "package.json"), path.join(host, "dist/core/extensions/runner.js"), sourceOwner,
			...(fs.existsSync(path.join(path.dirname(sourceOwner), "cwd-context.ts")) ? [path.join(path.dirname(sourceOwner), "cwd-context.ts")] : []),
			process.env.PI_ARGS_TEST_MODULE ?? path.join(repo, "src/runs/shared/pi-args.ts"),
			coldArgs.args[coldArgs.args.indexOf("--extension") + 1], path.join(repo, "src/runs/shared/child-execution-cwd.ts")].map((file) => ({ file, sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex") })) }, null, 2));
	t.diagnostic(`Native host and source receipt: ${root}`);
});
