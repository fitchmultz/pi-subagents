import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { findPackageJSON } from "node:module";
import { pathToFileURL } from "node:url";

const [root, repo, host, owner] = process.argv.slice(2);
const dirs = Object.fromEntries(["A", "B", "C", "D"].map((name) => [name, path.join(root, name)]));
const agentDir = path.join(root, "agent");
for (const dir of [...Object.values(dirs), agentDir, path.join(root, "bin")]) fs.mkdirSync(dir, { recursive: true });
for (const [name, dir] of Object.entries(dirs)) fs.writeFileSync(path.join(dir, "sentinel.txt"), name);
for (const key of Object.keys(process.env)) if (key.startsWith("PI_SUBAGENT_")) delete process.env[key];
Object.assign(process.env, { HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: agentDir, PI_SUBAGENT_TEMP_ROOT: path.join(root, "pi-subagents-runs"), PI_PACKAGE_DIR: host, PI_OFFLINE: "1", PI_TELEMETRY: "0" });
const cli = path.join(host, JSON.parse(fs.readFileSync(path.join(host, "package.json"), "utf8")).bin.pi);
fs.writeFileSync(path.join(root, "bin/pi"), `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`, { mode: 0o755 });
process.env.PATH = `${path.join(root, "bin")}${path.delimiter}${process.env.PATH}`;
const sdkUrl = pathToFileURL(path.join(host, "dist/index.js"));
const sdk = await import(sdkUrl.href);
const ai = await import(pathToFileURL(path.join(path.dirname(findPackageJSON("@earendil-works/pi-ai", sdkUrl)), "dist/index.js")).href);
const { createSubagentExecutor } = await import(pathToFileURL(path.join(repo, "dist/runs/foreground/subagent-executor.js")).href);
const { discoverAgents } = await import(pathToFileURL(path.join(repo, "dist/agents/agents.js")).href);
const { getRunMetadataDir } = await import(pathToFileURL(path.join(repo, "dist/runs/shared/supervisor-questions.js")).href);
const provider = path.join(repo, "test/fixtures/native-execution-cwd-provider.ts");
for (const dir of [dirs.B, dirs.C, dirs.A]) {
	fs.mkdirSync(path.join(dir, ".pi/agents"), { recursive: true });
	fs.writeFileSync(path.join(dir, ".pi/agents/cwd-probe.md"), `---\nname: cwd-probe\ndescription: Directory fixture\nmodel: faux/faux-1\noutput: false\ntools: read, change_dir\nextensions: ${provider}, ${owner}\ninheritProjectContext: false\ninheritSkills: false\n---\nComplete the fixture task.\n`);
}
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: { enabled: false } }));
const bus = sdk.createEventBus();
bus.on("subagent:result-intercom", ({ requestId }) => bus.emit("subagent:result-intercom-delivery", { requestId, delivered: false }));
const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: { enabled: false } });
settings.setProjectTrusted(true);
const parentProvider = ai.fauxProvider();
const modelRuntime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
modelRuntime.registerNativeProvider(parentProvider.provider);
let pi, ctx;
const loader = new sdk.DefaultResourceLoader({ cwd: dirs.A, agentDir, settingsManager: settings, eventBus: bus, noExtensions: true,
	noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true, additionalExtensionPaths: [owner],
	extensionFactories: [(api) => { pi = api; api.on("session_start", (_event, context) => { ctx = context; }); }] });
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const sm = sdk.SessionManager.create(dirs.A, path.join(root, "sessions"));
sm.appendMessage(ai.fauxAssistantMessage("Persisted parent"));
const { session } = await sdk.createAgentSession({ cwd: dirs.A, agentDir, settingsManager: settings, resourceLoader: loader, sessionManager: sm, modelRuntime, model: parentProvider.getModel() });
await session.bindExtensions({ mode: "json" });
const state = { baseCwd: dirs.A, currentSessionId: null, asyncJobs: new Map(), foregroundRuns: new Map(), foregroundControls: new Map(), lastForegroundControlId: null, ownedRuns: new Map() };
const discoveries = [];
const executor = createSubagentExecutor({ pi, state, config: { projectTrust: { childRuns: "no-approve" } }, asyncByDefault: false,
	tempArtifactsDir: path.join(root, "artifacts"), getSubagentSessionRoot: () => path.join(root, "children"), expandTilde: (value) => value,
	discoverAgents: (...args) => { discoveries.push(args[0]); return discoverAgents(...args); } });
const checks = [];
const read = { name: "read", input: { path: "sentinel.txt" } };
let index = 0;
async function run(params, script, expected) {
	const output = path.join(root, `child-${++index}.json`);
	process.env.PI_CWD_FIXTURE_SCRIPT = JSON.stringify(script);
	process.env.PI_CWD_FIXTURE_OUTPUT = output;
	const result = await executor.execute(randomUUID(), { async: params.action === "resume", artifacts: false, output: false, ...params }, AbortSignal.timeout(30_000), undefined, ctx);
	assert.ok(!result.isError, JSON.stringify(result));
	if (result.details.asyncId) {
		const resultPath = path.join(getRunMetadataDir(result.details.asyncId), "result.json");
		const deadline = Date.now() + 30_000;
		while (!fs.existsSync(resultPath)) {
			assert.ok(Date.now() < deadline, `No durable continuation result: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		const final = JSON.parse(fs.readFileSync(resultPath, "utf8"));
		assert.equal(final.success, true, JSON.stringify(final));
	}
	const observed = JSON.parse(fs.readFileSync(output, "utf8"));
	const letters = observed.results.filter(({ name }) => name === "read").map(({ content, isError }) => {
		assert.equal(isError, false);
		return content.map(({ text }) => text).join("\n");
	});
	assert.deepEqual(letters, expected);
	checks.push({ params, runId: result.details.runId ?? result.details.asyncId, sessionFile: observed.file, nativeCwd: observed.cwd, calls: observed.calls, letters });
	return { result, observed };
}
try {
	await session.agent.state.tools.find(({ name }) => name === "change_dir").execute(randomUUID(), { path: dirs.B }, new AbortController().signal);
	const parentBytes = fs.readFileSync(sm.getSessionFile(), "utf8");
	await run({ agent: "cwd-probe", task: "new selected root" }, [read], ["B"]);
	assert.equal(discoveries[0], dirs.B, "new launch discovers profiles at captured execution cwd");
	const fork = await run({ agent: "cwd-probe", task: "fork selected root", context: "fork", cwd: "../C" }, [read, { name: "change_dir", input: { path: dirs.D } }, read], ["C", "D"]);
	const originalId = fork.result.details.runId;
	const beforeResume = discoveries.length;
	await run({ action: "resume", id: originalId, message: "preserve selected D" }, [read], ["D"]);
	assert.equal(discoveries.length, beforeResume, "ordinary resume keeps the saved launch instead of rediscovering at parent B");
	const failedOverride = await executor.execute("bad-cwd", { action: "resume", id: originalId, message: "rejected override", cwd: path.join(root, "missing") }, undefined, undefined, ctx);
	assert.equal(failedOverride.isError, true);
	assert.match(JSON.stringify(failedOverride.content), /cwd does not exist/);
	assert.equal(fs.existsSync(`${fork.observed.file}.subagent-cwd-init`), false, "a rejected launch must not leave an override for an ordinary resume");
	await run({ action: "resume", id: originalId, message: "continue after rejected override" }, [read], ["D"]);
	const reset = await run({ action: "resume", id: originalId, message: "explicit reset", cwd: "../A" }, [read], ["A"]);
	assert.equal(fs.readFileSync(sm.getSessionFile(), "utf8"), parentBytes, "delegation does not modify parent history or selection");
	const resolution = { sessionManager: ctx.sessionManager };
	bus.emit("pi-change-working-dir:resolve-execution-cwd", resolution);
	assert.equal(resolution.result.cwd, dirs.B);
	let errorQueries = 0;
	const unsubscribe = bus.on("pi-change-working-dir:resolve-execution-cwd", (request) => { errorQueries++; request.result = { cwd: dirs.B, error: "Directory fixture unavailable" }; });
	const beforeFailure = fs.readdirSync(root).filter((name) => /^child-/.test(name)).length;
	await assert.rejects(executor.execute("fail", { agent: "cwd-probe", task: "must not launch" }, undefined, undefined, ctx), /Directory fixture unavailable/);
	assert.equal(fs.readdirSync(root).filter((name) => /^child-/.test(name)).length, beforeFailure);
	assert.equal(errorQueries, 1);
	await executor.execute("status", { action: "status", id: originalId }, undefined, undefined, ctx);
	await executor.execute("review", { action: "review", id: originalId, decision: "accepted" }, undefined, undefined, ctx);
	await executor.execute("questions", { action: "questions", id: originalId }, undefined, undefined, ctx);
	await run({ action: "resume", id: reset.result.details.runId ?? reset.result.details.asyncId, message: "saved root survives unavailable parent directory" }, [read], ["A"]);
	assert.equal(errorQueries, 1, "status, review, questions and omitted-cwd resume bypass unavailable parent cwd");
	unsubscribe();
	assert.equal(parentProvider.state.callCount, 0);
	fs.writeFileSync(path.join(root, "delegation-evidence.json"), JSON.stringify({ host, cli, owner, parentFile: sm.getSessionFile(), parentNativeCwd: dirs.A, parentSelectedCwd: dirs.B, parentCalls: parentProvider.state.callCount, discoveries, checks }, null, 2));
} finally {
	for (const run of state.ownedRuns.values()) {
		const status = path.join(getRunMetadataDir(run.runId), "status.json");
		if (!fs.existsSync(status)) continue;
		const { pid, state: outcome } = JSON.parse(fs.readFileSync(status, "utf8"));
		if (pid && outcome === "running") { try { process.kill(pid, "SIGTERM"); } catch {} }
	}
	await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	session.dispose();
}
console.log(`Delegation evidence: ${root}`);
