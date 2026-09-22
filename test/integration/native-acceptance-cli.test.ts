import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { after, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createEventBus, createTempDir, makeAgent, makeMinimalCtx, removeTempDir } from "../support/helpers.ts";

const originalEnv = { ...process.env };
const sdkRoot = process.env.PI_INTERCOM_TEST_SDK ?? path.dirname(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const cli = fs.realpathSync(path.join(sdkRoot, "dist/bundle/cli.js"));
const cliWorker = path.join(sdkRoot, "dist/bundle/cli-worker.js");
const nativeEntry = fs.existsSync(cliWorker) ? fs.realpathSync(cliWorker) : cli;
const root = fs.realpathSync(createTempDir("native-report-cli-"));
for (const name of ["h", "a", "t", "j", "c", "d", "x", "bin", "pi-subagents-r"]) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
fs.symlinkSync(cli, path.join(root, "bin/pi"));
fs.writeFileSync(path.join(root, "a/settings.json"), JSON.stringify({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 }, compaction: { enabled: false } }));
// Each test file has its own Node process; never inherit user resources, credentials, or parent routes.
process.env = {
	PATH: [path.join(root, "bin"), path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
	HOME: path.join(root, "h"), USERPROFILE: path.join(root, "h"),
	TMPDIR: path.join(root, "t"), TMP: path.join(root, "t"), TEMP: path.join(root, "t"),
	XDG_CONFIG_HOME: path.join(root, "c"), XDG_DATA_HOME: path.join(root, "d"), XDG_CACHE_HOME: path.join(root, "x"),
	PI_CODING_AGENT_DIR: path.join(root, "a"), PI_SUBAGENT_TEMP_ROOT: path.join(root, "pi-subagents-r"), JITI_FS_CACHE: path.join(root, "j"),
	PI_PACKAGE_DIR: sdkRoot, PI_INTERCOM_TEST_SDK: sdkRoot, PI_OWNERSHIP_TEST_PACKAGE_ROOT: sdkRoot, PI_CONTEXT_TEST_PACKAGE_ROOT: sdkRoot,
	CI: "1", TERM: "dumb", PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", NODE_DISABLE_COMPILE_CACHE: "1", NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT,
};
after(() => {
	process.env = originalEnv;
	if (originalEnv.PI_FINAL_REPORT_EVIDENCE_DIR) {
		fs.mkdirSync(originalEnv.PI_FINAL_REPORT_EVIDENCE_DIR, { recursive: true });
		fs.cpSync(root, path.join(originalEnv.PI_FINAL_REPORT_EVIDENCE_DIR, path.basename(root)), { recursive: true, filter: (source) => path.basename(source) !== "auth.json" });
	}
	removeTempDir(root);
});
const { createSubagentExecutor } = await import("../../src/runs/foreground/subagent-executor.ts");
const { questionProcessAlive } = await import("../../src/runs/shared/supervisor-questions.ts");
const extension = fileURLToPath(new URL("../fixtures/native-acceptance-cli-extension.mjs", import.meta.url));


async function waitFor(check: () => boolean, label: string) {
	const deadline = Date.now() + 20_000;
	while (!check()) { assert.ok(Date.now() < deadline, label); await delay(20); }
}

it("native stop records the agent process exit separately from real bash/descendant cleanup", { timeout: 30_000 }, async () => {
	const cwd = path.join(root, "native-bash-stop");
	fs.mkdirSync(cwd);
	process.env.PI_FINAL_REPORT_CLI_INPUT = path.join(cwd, "input.json");
	fs.writeFileSync(process.env.PI_FINAL_REPORT_CLI_INPUT, JSON.stringify({ pidDir: cwd }));
	const agent = makeAgent("worker", { model: "report-cli-fixture/faux-1", extensions: [extension], output: false });
	const state = { baseCwd: cwd, currentSessionId: null, asyncJobs: new Map(), ownedRuns: new Map() };
	const executor = createSubagentExecutor({ pi: { events: createEventBus(), getSessionName: () => undefined }, state,
		config: {}, asyncByDefault: false, tempArtifactsDir: cwd, getSubagentSessionRoot: () => cwd,
		expandTilde: (value) => value, discoverAgents: () => ({ agents: [agent] }) });
	const pending = executor.execute("native-stop", { agent: "worker", task: "Run the controlled native bash command" }, undefined, undefined, makeMinimalCtx(cwd));
	await waitFor(() => fs.existsSync(path.join(cwd, "ready")), "real native bash must publish its ready file");
	const shellPid = Number(fs.readFileSync(path.join(cwd, "shell.pid"), "utf8")), descendantPid = Number(fs.readFileSync(path.join(cwd, "descendant.pid"), "utf8"));
	assert.equal(questionProcessAlive({ pid: shellPid }), true);
	assert.equal(questionProcessAlive({ pid: descendantPid }), true);
	const id = [...state.ownedRuns.keys()][0];
	const stopped = await executor.execute("stop", { action: "interrupt", id }, undefined, undefined, makeMinimalCtx(cwd));
	assert.equal(stopped.isError, undefined, JSON.stringify(stopped.content));
	const completed = await pending;
	const result = completed.details.results[0];
	const receipts = fs.readdirSync(cwd).filter((file) => /^initial-\d+\.json$/.test(file)).map((file) => JSON.parse(fs.readFileSync(path.join(cwd, file), "utf8")));
	assert.equal(receipts.length, 1);
	assert.equal(receipts[0].cli, nativeEntry);
	assert.equal(receipts[0].networkRequests, 0);
	assert.equal(questionProcessAlive({ pid: receipts[0].pid }), false);
	assert.equal(result.exitCode, 0, "workflow pause keeps its existing normalized outcome");
	assert.equal(result.interrupted, true);
	assert.ok(result.agentProcessExit, "real process exit evidence must be retained");
	assert.ok(result.agentProcessExit.code !== 0 || result.agentProcessExit.signal, "the stopped process outcome is not manufactured exit zero");
	await waitFor(() => !questionProcessAlive({ pid: shellPid }) && !questionProcessAlive({ pid: descendantPid }), "the known test shell and descendant must exit");
	const { NativeAgentHistory } = await import("../../src/tui/agent-history.ts");
	const history = new NativeAgentHistory().read(result.sessionFile);
	const command = history.items.find((item) => item.kind === "tool" && item.title.startsWith("bash"));
	assert.ok(command);
	if (command.title.includes("result not recorded")) assert.match(command.details!, /exit is unconfirmed/);
	fs.writeFileSync(path.join(cwd, "stop-evidence.json"), JSON.stringify({ result, shellPid, descendantPid, knownPidsGone: true, history }, null, 2));
});
